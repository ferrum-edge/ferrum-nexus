/**
 * Retargeting Ferrum Edge — detection, health degradation and repair.
 *
 * The scenario behind issue #235, reproduced end to end: a portal with an
 * account, a grant, a credential and a published API, pointed at a gateway
 * that no longer holds any of the objects it created. Wiping the mock
 * gateway's stored resources is exactly what a fresh Edge on a new
 * `FERRUM_ADMIN_URL` looks like from the portal's side — the Admin API answers
 * perfectly, and every id the database holds `404`s.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  aclGroupForApi,
  consumerUsernameForUser,
  type AppHealth,
  type EdgeHealth,
  type GatewayReconciliationReport,
  type PublishApiResponse,
  type RepairGatewayReferencesResponse,
} from '@ferrum-nexus/shared';

import { AuditAction } from '../audit/service.js';
import { buildTestApp, SAMPLE_SPEC_YAML, type TestApp, type TestSession } from './helpers.js';

describe('gateway reference reconciliation', () => {
  let harness: TestApp;
  let superAdmin: TestSession;
  let admin: TestSession;
  let provider: TestSession;
  let client: TestSession;
  let apiId: string;
  let proxyId: string;

  before(async () => {
    harness = await buildTestApp();

    superAdmin = await harness.registerUser({ email: 'recon-super@example.test' });
    assert.equal(superAdmin.user.role, 'super_admin');

    const promoted = await harness.registerUser({
      email: 'recon-admin@example.test',
      role: 'provider',
    });
    const patch = await harness.authed(superAdmin, {
      method: 'PATCH',
      url: `/api/users/${promoted.user.id}`,
      payload: { role: 'admin' },
    });
    assert.equal(patch.statusCode, 200, patch.body);
    admin = await harness.loginUser('recon-admin@example.test');
    assert.equal(admin.user.role, 'admin');

    provider = await harness.registerUser({
      email: 'recon-provider@example.test',
      role: 'provider',
    });
    client = await harness.registerUser({ email: 'recon-client@example.test', role: 'client' });

    const published = await harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: {
        name: 'Retarget Billing',
        slug: 'retarget-billing',
        spec: SAMPLE_SPEC_YAML,
        auth_plugin: 'key_auth',
        requestable: true,
        visibility: 'public',
      },
    });
    assert.equal(published.statusCode, 201, published.body);
    apiId = published.json<PublishApiResponse>().api.id;
    const storedApi = await harness.store.apis.findById(apiId);
    assert.ok(storedApi, 'the published API has a row');
    assert.ok(storedApi.ferrum_proxy_id, 'the published API has a gateway proxy');
    proxyId = storedApi.ferrum_proxy_id;

    // A grant and a credential, so the repair has both a group to replay and a
    // credential row it has to give up on.
    const requested = await harness.authed(client, {
      method: 'POST',
      url: '/api/access-requests',
      payload: { api_id: apiId, justification: 'Integration access' },
    });
    assert.equal(requested.statusCode, 201, requested.body);
    const requestId = requested.json<{ access_request: { id: string } }>().access_request.id;
    const approved = await harness.authed(provider, {
      method: 'POST',
      url: `/api/access-requests/${requestId}/approve`,
      payload: {},
    });
    assert.equal(approved.statusCode, 200, approved.body);

    const issued = await harness.authed(client, {
      method: 'POST',
      url: '/api/credentials',
      payload: { credential_type: 'keyauth' },
    });
    assert.equal(issued.statusCode, 201, issued.body);
  });

  after(async () => {
    await harness.close();
  });

  /** Throw away every gateway resource, as a fresh Edge on a new URL would. */
  function rebuildGateway(): void {
    harness.edge.consumers.clear();
    harness.edge.proxies.clear();
    harness.edge.pluginConfigs.clear();
    harness.edge.apiSpecs.clear();
  }

  it('reports every stored reference as live against the gateway it built them on', async () => {
    const report = await harness.services.reconciliation.scan();
    assert.equal(report.status, 'ok');
    assert.equal(report.error, null);
    assert.ok(report.consumers.checked >= 1, 'at least the client consumer was checked');
    assert.equal(report.consumers.orphaned, 0);
    assert.equal(report.proxies.checked, 1);
    assert.equal(report.proxies.orphaned, 0);
    assert.ok(report.consumers.complete && report.proxies.complete);

    const health = await harness.app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(health.statusCode, 200);
    const body = health.json<AppHealth>();
    assert.equal(body.status, 'ok');
    assert.equal(body.edge.reconciliation.status, 'ok');
  });

  it('classifies both reference kinds as orphaned once the gateway is rebuilt', async () => {
    rebuildGateway();
    const report = await harness.services.reconciliation.scan();
    assert.equal(report.status, 'orphaned');
    assert.equal(report.error, null);
    assert.equal(report.consumers.orphaned, report.consumers.checked);
    assert.equal(report.proxies.orphaned, 1);
    assert.deepEqual(report.orphaned_proxies, [
      { api_id: apiId, slug: 'retarget-billing', ferrum_proxy_id: proxyId },
    ]);
    const orphanedClient = report.orphaned_consumers.find(
      (orphan) => orphan.user_id === client.user.id,
    );
    assert.ok(orphanedClient, 'the client account’s consumer is reported orphaned');
    assert.equal(orphanedClient.ferrum_username, consumerUsernameForUser(client.user.id));
  });

  it('degrades health, and shows the counts only to an administrator', async () => {
    // `GET /api/health` is public, so the anonymous rendering must carry the
    // verdict — a monitor needs it — and none of the sizing.
    const anonymous = await harness.app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(anonymous.statusCode, 200, 'degraded never answers 503');
    const anonymousBody = anonymous.json<AppHealth>();
    assert.equal(anonymousBody.status, 'degraded');
    assert.equal(anonymousBody.edge.status, 'ok', 'the Admin API itself is perfectly reachable');
    assert.equal(anonymousBody.edge.reconciliation.status, 'orphaned');
    assert.equal(anonymousBody.edge.reconciliation.orphaned_consumers, null);
    assert.equal(anonymousBody.edge.reconciliation.orphaned_proxies, null);
    assert.equal(anonymousBody.edge.reconciliation.complete, null);
    assert.ok(anonymousBody.edge.reconciliation.checked_at);

    const privileged = await harness.authed(admin, { method: 'GET', url: '/api/health/edge' });
    assert.equal(privileged.statusCode, 200);
    const edgeBody = privileged.json<EdgeHealth>();
    assert.equal(edgeBody.reconciliation.status, 'orphaned');
    assert.equal(edgeBody.reconciliation.orphaned_proxies, 1);
    assert.ok((edgeBody.reconciliation.orphaned_consumers ?? 0) >= 1);
    assert.equal(edgeBody.reconciliation.complete, true);
  });

  it('refuses the reconcile and repair endpoints below super_admin', async () => {
    const scanned = await harness.authed(admin, {
      method: 'POST',
      url: '/api/admin/gateway/reconcile',
      payload: {},
    });
    assert.equal(scanned.statusCode, 403, scanned.body);

    const repaired = await harness.authed(admin, {
      method: 'POST',
      url: '/api/admin/gateway/repair',
      payload: { all: true },
    });
    assert.equal(repaired.statusCode, 403, repaired.body);

    const asProvider = await harness.authed(provider, {
      method: 'POST',
      url: '/api/admin/gateway/repair',
      payload: { all: true },
    });
    assert.equal(asProvider.statusCode, 403, asProvider.body);

    // And nothing was repaired on the way to those refusals.
    assert.equal(
      harness.edge.consumerByUsername(consumerUsernameForUser(client.user.id)),
      undefined,
    );
  });

  it('reports a gateway it cannot read as unknown rather than as orphans', async () => {
    harness.edge.queueFailure(500, { error: 'boom' }, '/consumers', 'GET');
    const report = await harness.services.reconciliation.scan();
    assert.equal(report.status, 'unknown');
    assert.ok(report.error);
    assert.deepEqual(report.orphaned_consumers, []);
    assert.deepEqual(report.orphaned_proxies, []);

    // An unreadable gateway is not a reason to rebuild every identity. The
    // repair takes its own fresh pass, so this arms a second refusal for it.
    harness.edge.queueFailure(500, { error: 'boom' }, '/consumers', 'GET');
    const refused = await harness.authed(superAdmin, {
      method: 'POST',
      url: '/api/admin/gateway/repair',
      payload: { all: true },
    });
    assert.equal(refused.statusCode, 502, refused.body);
    harness.edge.clearInjections();
  });

  it('records an on-demand pass in the audit log', async () => {
    const response = await harness.authed(superAdmin, {
      method: 'POST',
      url: '/api/admin/gateway/reconcile',
      payload: {},
    });
    assert.equal(response.statusCode, 200, response.body);
    const report = response.json<GatewayReconciliationReport>();
    assert.equal(report.status, 'orphaned');

    const rows = await harness.auditRows(AuditAction.GATEWAY_RECONCILE);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.actor_user_id, superAdmin.user.id);
    assert.equal(rows[0]?.target_id, harness.config.edge.namespace);
    assert.equal((rows[0]?.details as { orphaned_proxies: number }).orphaned_proxies, 1);
  });

  it('recreates the consumer under the same identity and replays its approved access', async () => {
    const response = await harness.authed(superAdmin, {
      method: 'POST',
      url: '/api/admin/gateway/repair',
      payload: { all: true, reason: 'Edge 0.9.4 rebuild' },
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json<RepairGatewayReferencesResponse>();

    const repaired = body.consumers.find((entry) => entry.user_id === client.user.id);
    assert.ok(repaired, 'the client account was repaired');
    assert.equal(repaired.error, null);
    assert.equal(repaired.restored_groups, 1);
    assert.equal(repaired.credentials_requiring_reissue, 1);

    // Same username, same `custom_id`, and the approval is live again.
    const username = consumerUsernameForUser(client.user.id);
    const remote = harness.edge.consumerByUsername(username);
    assert.ok(remote, 'the gateway holds the consumer again');
    assert.equal(remote.custom_id, client.user.id);
    assert.deepEqual(remote.acl_groups, [aclGroupForApi(apiId)]);

    // The portal points at what the gateway actually holds.
    const mapping = await harness.store.consumers.findByUserAndNamespace(
      client.user.id,
      harness.config.edge.namespace,
    );
    assert.equal(mapping?.ferrum_consumer_id, remote.id);

    // Nothing was minted: the credential the account held is revoked, not
    // replaced, because its plaintext was shown once and is unrecoverable.
    assert.equal(remote.credentials.keyauth?.length ?? 0, 0);
    const credentials = await harness.store.credentials.list({ user_id: client.user.id });
    assert.equal(credentials.total, 1);
    assert.equal(credentials.items[0]?.status, 'revoked');

    const audited = await harness.auditRows(AuditAction.GATEWAY_CONSUMER_REPAIR);
    const row = audited.find((entry) => entry.target_id === client.user.id);
    assert.ok(row);
    assert.equal(row.actor_user_id, superAdmin.user.id);
    const details = row.details as {
      reason: string;
      restored_groups: number;
      revoked_credentials: number;
    };
    assert.equal(details.reason, 'Edge 0.9.4 rebuild');
    assert.equal(details.restored_groups, 1);
    assert.equal(details.revoked_credentials, 1);
  });

  it('clears the dead proxy id and flags the API for republishing', async () => {
    const flagged = await harness.store.apis.findById(apiId);
    assert.equal(flagged?.ferrum_proxy_id, null, 'the dead proxy id is gone');
    assert.equal(flagged?.status, 'published', 'the catalog entry itself is untouched');

    const rows = await harness.auditRows(AuditAction.API_GATEWAY_REPAIR_REQUIRED);
    const row = rows.find((entry) => entry.target_id === apiId);
    assert.ok(row, 'the republish requirement is recorded on the existing repair action');
    const details = row.details as { phase: string; proxy_id: string };
    assert.equal(details.phase, 'orphaned_proxy');
    assert.equal(details.proxy_id, proxyId);

    // The provider is told, through the ordinary notification channel.
    const notifications = await harness.store.notifications.list({
      user_id: provider.user.id,
    });
    assert.ok(
      notifications.items.some((entry) => entry.title === 'Republish required'),
      'the API owner is asked to republish',
    );
  });

  it('reports a clean pass once every reference has been repaired', async () => {
    const report = await harness.services.reconciliation.scan();
    assert.equal(report.status, 'ok');
    assert.equal(report.consumers.orphaned, 0);
    assert.equal(report.proxies.orphaned, 0, 'a cleared proxy id is no longer a reference at all');

    const health = await harness.app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(health.json<AppHealth>().status, 'ok');
  });

  it('refuses a repair that names neither a target nor `all`', async () => {
    const response = await harness.authed(superAdmin, {
      method: 'POST',
      url: '/api/admin/gateway/repair',
      payload: { reason: 'nothing in particular' },
    });
    assert.equal(response.statusCode, 400, response.body);
  });

  it('says so plainly when a named account has no orphaned consumer', async () => {
    const response = await harness.authed(superAdmin, {
      method: 'POST',
      url: '/api/admin/gateway/repair',
      payload: { user_ids: [client.user.id] },
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json<RepairGatewayReferencesResponse>();
    assert.equal(body.consumers.length, 1);
    assert.equal(body.consumers[0]?.ferrum_consumer_id, null);
    assert.match(body.consumers[0]?.error ?? '', /no orphaned gateway consumer/);
  });
});
