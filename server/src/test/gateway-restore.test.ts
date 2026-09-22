/**
 * Restoring the gateway deployment of an API whose proxy went away.
 *
 * The scenario behind issue #284, end to end: an API is published, a client is
 * approved and holds a credential, and then **only the proxy** disappears from
 * the gateway — the shape a targeted delete or a partial rebuild leaves. The
 * consumers, their ACL groups and their credentials are all still there, so
 * nothing about the account side has to be recovered; what is missing is the
 * one resource the portal cannot re-derive.
 *
 * What these tests hold the restore to:
 *
 * - it rebuilds *this* API — same id, slug, owner, specification history,
 *   gateway URL and grants — rather than publishing a second one;
 * - the approved client's existing credential reaches the rebuilt proxy and an
 *   unapproved one still does not, because the ACL group is derived from the
 *   API id the restore preserves;
 * - a failure leaves the API visibly unrestored and nothing live on the public
 *   path, and the retry after it does not duplicate anything;
 * - a gateway that is merely *unreachable* is never mistaken for one that has
 *   deleted the proxy.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  ACCESS_CONTROL_PLUGIN,
  aclGroupForApi,
  consumerUsernameForUser,
  listenPathFor,
  type GatewayReconciliationReport,
  type PublishApiResponse,
  type RestoreApiGatewayResponse,
} from '@ferrum-nexus/shared';

import { AuditAction } from '../audit/service.js';
import type { NexusStore } from '../db/store.js';
import { buildTestApp, SAMPLE_SPEC_YAML, type TestApp, type TestSession } from './helpers.js';

const NAMESPACE = 'nexus';

describe('restoring a missing gateway deployment', () => {
  let harness: TestApp;
  let superAdmin: TestSession;
  let provider: TestSession;
  let other: TestSession;
  let client: TestSession;
  let apiId: string;
  let originalProxyId: string;

  /**
   * Publish an API owned by `provider`, approve `client` for it and issue the
   * client a credential.
   *
   * Rebuilt per test rather than shared: half of these tests deliberately
   * strand resources on the mock gateway, and a suite whose later assertions
   * depend on an earlier test's leftovers is one that cannot be read in
   * isolation.
   */
  async function publishApi(
    options: { slug: string; enforcement?: 'docs_only' | 'routes' } = { slug: 'restore-billing' },
  ): Promise<{ apiId: string; proxyId: string }> {
    const published = await harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: {
        name: `Restore ${options.slug}`,
        slug: options.slug,
        spec: SAMPLE_SPEC_YAML,
        auth_plugin: 'key_auth',
        requestable: true,
        visibility: 'public',
        ...(options.enforcement ? { spec_enforcement: options.enforcement } : {}),
      },
    });
    assert.equal(published.statusCode, 201, published.body);
    const id = published.json<PublishApiResponse>().api.id;
    const row = await harness.store.apis.findById(id);
    assert.ok(row?.ferrum_proxy_id);
    return { apiId: id, proxyId: row.ferrum_proxy_id };
  }

  async function approveClient(id: string, session: TestSession): Promise<void> {
    const requested = await harness.authed(session, {
      method: 'POST',
      url: '/api/access-requests',
      payload: { api_id: id, justification: 'Integration access' },
    });
    assert.equal(requested.statusCode, 201, requested.body);
    const requestId = requested.json<{ access_request: { id: string } }>().access_request.id;
    const approved = await harness.authed(provider, {
      method: 'POST',
      url: `/api/access-requests/${requestId}/approve`,
      payload: {},
    });
    assert.equal(approved.statusCode, 200, approved.body);
  }

  /** Delete only the proxy, exactly as a targeted gateway delete would. */
  function deleteProxyOnly(proxyId: string): void {
    harness.edge.proxies.delete(`${NAMESPACE}/${proxyId}`);
    for (const [key, spec] of harness.edge.apiSpecs) {
      if (spec.proxy_id === proxyId) harness.edge.apiSpecs.delete(key);
    }
  }

  /** Run one reconciliation pass and repair the orphan it finds. */
  async function reconcileAndRepair(): Promise<GatewayReconciliationReport> {
    await harness.services.reconciliation.scan();
    const repaired = await harness.authed(superAdmin, {
      method: 'POST',
      url: '/api/admin/gateway/repair',
      payload: { all: true, reason: 'proxy deleted' },
    });
    assert.equal(repaired.statusCode, 200, repaired.body);
    return harness.services.reconciliation.scan();
  }

  async function restore(session: TestSession, id: string): ReturnType<TestApp['authed']> {
    return harness.authed(session, {
      method: 'POST',
      url: `/api/apis/${id}/restore-gateway`,
      payload: {},
    });
  }

  beforeEach(async () => {
    // A configured gateway origin so `invoke_url` is a real address: keeping
    // it across a restore is one of the things being asserted.
    harness = await buildTestApp({
      env: { FERRUM_GATEWAY_PUBLIC_URL: 'https://gateway.example.test' },
    });
    superAdmin = await harness.registerUser({ email: 'restore-super@example.test' });
    provider = await harness.registerUser({
      email: 'restore-provider@example.test',
      role: 'provider',
    });
    other = await harness.registerUser({
      email: 'restore-other@example.test',
      role: 'provider',
    });
    client = await harness.registerUser({ email: 'restore-client@example.test', role: 'client' });

    const published = await publishApi({ slug: 'restore-billing' });
    apiId = published.apiId;
    originalProxyId = published.proxyId;
    await approveClient(apiId, client);
    const issued = await harness.authed(client, {
      method: 'POST',
      url: '/api/credentials',
      payload: { credential_type: 'keyauth' },
    });
    assert.equal(issued.statusCode, 201, issued.body);
  });

  afterEach(async () => {
    await harness.close();
  });

  it('rebuilds the existing API in place, keeping its identity and its grants', async () => {
    const before = await harness.store.apis.findById(apiId);
    assert.ok(before);
    deleteProxyOnly(originalProxyId);
    await reconcileAndRepair();

    const response = await restore(provider, apiId);
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json<RestoreApiGatewayResponse>();

    // Same catalog entry. Nothing a client already holds a link to moved.
    assert.equal(body.api.id, apiId);
    assert.equal(body.api.slug, before.slug);
    assert.equal(body.api.owner_user_id, before.owner_user_id);
    assert.equal(body.api.upstream_url, before.upstream_url);
    assert.equal(body.api.listen_path, listenPathFor(NAMESPACE, before.slug));
    assert.equal(body.api.invoke_url, `https://gateway.example.test${body.api.listen_path}`);
    assert.equal(body.api.gateway_state, 'deployed');
    assert.notEqual(body.proxy_id, originalProxyId, 'the rebuilt proxy is a new gateway resource');

    // The specification history is untouched: the restore redeploys the
    // current revision, it does not write a new one.
    const revisions = await harness.store.apiSpecs.list({ api_id: apiId });
    assert.equal(revisions.total, 1);
    assert.equal(body.spec.id, revisions.items[0]?.id);

    // The grant was never revoked, and its ACL group still names this API.
    const grants = await harness.store.grants.list({ api_id: apiId, status: 'active' });
    assert.equal(grants.total, 1);
    assert.equal(grants.items[0]?.acl_group, aclGroupForApi(apiId));

    // And it is live on the public path with its plugins associated.
    const serving = harness.edge.proxyServing(body.api.listen_path, NAMESPACE);
    assert.ok(serving, 'the rebuilt proxy answers on the API’s listen path');
    assert.equal(serving.id, body.proxy_id);
    const effective = harness.edge
      .effectivePluginsForProxy(body.proxy_id, NAMESPACE)
      .map((plugin) => plugin.plugin_name);
    assert.ok(effective.includes('key_auth'), 'the API is authenticated again');
    assert.ok(effective.includes(ACCESS_CONTROL_PLUGIN), 'the ACL gate is back');

    const acl = harness.edge.pluginForProxy(body.proxy_id, ACCESS_CONTROL_PLUGIN, NAMESPACE);
    const settings = acl?.config as { allowed_groups?: string[] } | undefined;
    assert.deepEqual(settings?.allowed_groups, [aclGroupForApi(apiId)]);

    const consumer = harness.edge.consumerByUsername(
      consumerUsernameForUser(client.user.id),
      NAMESPACE,
    );
    assert.ok(consumer?.acl_groups?.includes(aclGroupForApi(apiId)), 'the approved client matches');
    const outsider = harness.edge.consumerByUsername(
      consumerUsernameForUser(other.user.id),
      NAMESPACE,
    );
    assert.ok(
      !outsider?.acl_groups?.includes(aclGroupForApi(apiId)),
      'an unapproved account is still outside the gate',
    );
  });

  it('clears the deployment condition from the report and from health', async () => {
    deleteProxyOnly(originalProxyId);
    const flagged = await reconcileAndRepair();
    assert.equal(flagged.awaiting_restore, 1);
    assert.equal(flagged.status, 'orphaned');

    assert.equal((await restore(provider, apiId)).statusCode, 200);

    const clean = await harness.services.reconciliation.scan();
    assert.equal(clean.awaiting_restore, 0);
    assert.equal(clean.proxies.orphaned, 0);
    assert.equal(clean.status, 'ok');
    const health = await harness.app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(health.json<{ status: string }>().status, 'ok');
  });

  it('restores a `routes` API with its generated validator', async () => {
    const routed = await publishApi({ slug: 'restore-routed', enforcement: 'routes' });
    deleteProxyOnly(routed.proxyId);
    await reconcileAndRepair();

    const response = await restore(provider, routed.apiId);
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json<RestoreApiGatewayResponse>();
    assert.equal(body.api.spec_enforcement, 'routes');

    // In `routes` mode the proxy is owned by an imported spec, and the spec is
    // what carries the operation table. A restore that built a bare proxy would
    // leave the API unvalidated while looking perfectly healthy.
    const spec = harness.edge.apiSpecForProxy(body.proxy_id, NAMESPACE);
    assert.ok(spec, 'the rebuilt proxy is owned by an imported spec');
    const serving = harness.edge.proxyServing(body.api.listen_path, NAMESPACE);
    assert.equal(serving?.id, body.proxy_id);
  });

  it('replays the provider’s plugin palette onto the rebuilt proxy', async () => {
    const saved = await harness.authed(provider, {
      method: 'PUT',
      url: `/api/apis/${apiId}/plugins/compression`,
      payload: { enabled: true, config: {} },
    });
    assert.equal(saved.statusCode, 200, saved.body);
    const beforeRow = await harness.store.apiPlugins.find(apiId, 'compression');
    assert.ok(beforeRow?.ferrum_plugin_config_id);

    deleteProxyOnly(originalProxyId);
    await reconcileAndRepair();
    const response = await restore(provider, apiId);
    assert.equal(response.statusCode, 200, response.body);
    const proxyId = response.json<RestoreApiGatewayResponse>().proxy_id;

    const effective = harness.edge
      .effectivePluginsForProxy(proxyId, NAMESPACE)
      .map((plugin) => plugin.plugin_name);
    assert.ok(effective.includes('compression'), 'the palette plugin runs again');

    // The row has to follow the rebuild: ownership is a recorded config id, so
    // a row still naming the deleted config would leave the next palette save
    // unable to find anything it owns.
    const afterRow = await harness.store.apiPlugins.find(apiId, 'compression');
    assert.ok(afterRow?.ferrum_plugin_config_id);
    assert.notEqual(afterRow.ferrum_plugin_config_id, beforeRow.ferrum_plugin_config_id);
    const live = harness.edge.pluginForProxy(proxyId, 'compression', NAMESPACE);
    assert.equal(live?.id, afterRow.ferrum_plugin_config_id);
  });

  it('leaves a truthful repair state when the rebuild fails, and retries cleanly', async () => {
    deleteProxyOnly(originalProxyId);
    await reconcileAndRepair();

    // Fail the association — late enough that a proxy and its plugin configs
    // are already on the gateway, which is what the compensation is for.
    harness.edge.queueFailure(500, { error: 'boom' }, '/proxies/', 'PUT');
    const failed = await restore(provider, apiId);
    assert.equal(failed.statusCode, 502, failed.body);

    const flagged = await harness.store.apis.findById(apiId);
    assert.equal(flagged?.ferrum_proxy_id, null, 'no half-built proxy is adopted');
    assert.equal(flagged?.gateway_state, 'repair_required', 'the condition is still visible');
    assert.equal(
      harness.edge.proxyServing(listenPathFor(NAMESPACE, 'restore-billing'), NAMESPACE),
      undefined,
      'nothing was ever exposed on the public path',
    );
    const failures = await harness.auditRows(AuditAction.API_GATEWAY_RESTORE_FAILED);
    assert.ok(failures.some((row) => row.target_id === apiId));

    // The retry is the same operation from the same starting point.
    const retried = await restore(provider, apiId);
    assert.equal(retried.statusCode, 200, retried.body);
    const proxyId = retried.json<RestoreApiGatewayResponse>().proxy_id;
    const proxies = [...harness.edge.proxies.values()].filter(
      (proxy) => proxy.name === 'nexus-restore-billing',
    );
    assert.equal(proxies.length, 1, 'the failed attempt left no duplicate behind');
    assert.equal(proxies[0]?.id, proxyId);
    assert.equal((await harness.store.apis.findById(apiId))?.gateway_state, 'deployed');
  });

  it('keeps security plugins attached when a public proxy cannot be withdrawn', async () => {
    deleteProxyOnly(originalProxyId);
    await reconcileAndRepair();

    // Force the failure after public cutover, then prevent compensation from
    // withdrawing that proxy. The stranded public path must remain gated.
    const realTransaction = harness.store.transaction.bind(harness.store);
    harness.store.transaction = async <T>(_fn: (tx: NexusStore) => Promise<T>): Promise<T> => {
      throw new Error('database unavailable after cutover');
    };
    harness.edge.queueFailure(503, { error: 'gateway unavailable' }, '/proxies/', 'DELETE');
    const failed = await restore(provider, apiId);
    harness.store.transaction = realTransaction;
    assert.equal(failed.statusCode, 500, failed.body);

    const serving = harness.edge.proxyServing(
      listenPathFor(NAMESPACE, 'restore-billing'),
      NAMESPACE,
    );
    assert.ok(serving, 'the failed proxy withdrawal leaves the public proxy in place');
    assert.equal(typeof serving.id, 'string');
    const effective = harness.edge
      .effectivePluginsForProxy(serving.id as string, NAMESPACE)
      .map((plugin) => plugin.plugin_name);
    assert.ok(effective.includes('key_auth'), 'authentication remains attached');
    assert.ok(effective.includes(ACCESS_CONTROL_PLUGIN), 'access control remains attached');
  });

  it('never reads an unreachable gateway as a deleted proxy', async () => {
    // The proxy is perfectly alive; the gateway just will not answer for it.
    harness.edge.queueFailure(503, { error: 'unavailable' }, `/proxies/${originalProxyId}`, 'GET');
    const response = await restore(provider, apiId);
    assert.equal(response.statusCode, 502, response.body);

    const row = await harness.store.apis.findById(apiId);
    assert.equal(row?.ferrum_proxy_id, originalProxyId, 'the reference is untouched');
    assert.equal(row?.gateway_state, 'deployed', 'and so is the deployment state');
    assert.equal(
      [...harness.edge.proxies.values()].filter((proxy) => proxy.name === 'nexus-restore-billing')
        .length,
      1,
      'no second proxy was built beside the live one',
    );
  });

  it('refuses to rebuild on top of a proxy that is already serving', async () => {
    const response = await restore(provider, apiId);
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json<{ error: { code: string } }>().error.code, 'CONFLICT');
  });

  it('clears a stale flag without touching a gateway that has the proxy', async () => {
    // An operator rebuilt the proxy by hand after the pass flagged the API.
    await harness.store.apis.update(apiId, { gateway_state: 'repair_required' });
    const response = await restore(provider, apiId);
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json<RestoreApiGatewayResponse>();
    assert.equal(body.proxy_id, originalProxyId, 'the live proxy is kept');
    assert.equal(body.api.gateway_state, 'deployed');
    // Exactly one row, and it says what actually happened. Two rows — one per
    // code path — would make the log disagree with itself about the same event.
    const rows = (await harness.auditRows(AuditAction.API_GATEWAY_RESTORE)).filter(
      (row) => row.target_id === apiId,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.details.rebuilt, false);
    assert.equal(rows[0]?.details.proxy_id, originalProxyId);
  });

  it('is owner-or-admin, like every other write on the row', async () => {
    deleteProxyOnly(originalProxyId);
    await reconcileAndRepair();

    const stranger = await restore(other, apiId);
    assert.equal(stranger.statusCode, 403, stranger.body);
    const asClient = await restore(client, apiId);
    assert.equal(asClient.statusCode, 403, asClient.body);
    assert.equal((await harness.store.apis.findById(apiId))?.ferrum_proxy_id, null);

    const asAdmin = await restore(superAdmin, apiId);
    assert.equal(asAdmin.statusCode, 200, asAdmin.body);
  });

  it('serialises concurrent restores onto one proxy', async () => {
    deleteProxyOnly(originalProxyId);
    await reconcileAndRepair();

    const [first, second] = await Promise.all([restore(provider, apiId), restore(provider, apiId)]);
    const codes = [first.statusCode, second.statusCode].sort();
    assert.deepEqual(codes, [200, 409], `${first.body} / ${second.body}`);
    const proxies = [...harness.edge.proxies.values()].filter(
      (proxy) => proxy.name === 'nexus-restore-billing',
    );
    assert.equal(proxies.length, 1, 'only one of them built a proxy');
  });
});
