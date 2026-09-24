/**
 * The gateway repair's proxy flag against a deployment that came back
 * (issue #342).
 *
 * `repair()` acts on a reconciliation pass, and that pass can be older than
 * the gateway it describes: the repair may join a pass already in flight, and
 * a restore — or an operator rebuilding the proxy by hand — can land in
 * between. The flag used to re-read the row, compare the proxy id and clear it
 * without the `api-restore:<id>` key the restore holds and without asking the
 * gateway again, so it could clear the reference to a proxy that was serving:
 * the API was marked `repair_required`, the live proxy kept the listen path
 * with no row pointing at it, and the next restore answered `409`.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type {
  PublishApiResponse,
  RepairGatewayReferencesResponse,
  RestoreApiGatewayResponse,
} from '@ferrum-nexus/shared';

import { AuditAction } from '../audit/service.js';
import type { EdgeProxy } from '../ferrum-admin/types.js';
import { apiRestoreLockKey } from '../lib/keyed-serializer.js';
import { buildTestApp, SAMPLE_SPEC_YAML, type TestApp, type TestSession } from './helpers.js';

const NAMESPACE = 'nexus';

describe('gateway repair against a restored deployment', () => {
  let harness: TestApp;
  let superAdmin: TestSession;
  let provider: TestSession;
  let apiId: string;
  let proxyId: string;
  /** Undo every client patch a test installs, whether or not it passed. */
  let restorePatches: (() => void)[] = [];

  beforeEach(async () => {
    harness = await buildTestApp();
    superAdmin = await harness.registerUser({ email: 'repair-race-super@example.test' });
    provider = await harness.registerUser({
      email: 'repair-race-provider@example.test',
      role: 'provider',
    });
    const published = await harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: {
        name: 'Repair Race Billing',
        slug: 'repair-race-billing',
        spec: SAMPLE_SPEC_YAML,
        auth_plugin: 'key_auth',
        requestable: true,
        visibility: 'public',
      },
    });
    assert.equal(published.statusCode, 201, published.body);
    apiId = published.json<PublishApiResponse>().api.id;
    const row = await harness.store.apis.findById(apiId);
    assert.ok(row?.ferrum_proxy_id);
    proxyId = row.ferrum_proxy_id;
    restorePatches = [];
  });

  afterEach(async () => {
    for (const undo of restorePatches.reverse()) undo();
    await harness.close();
  });

  /** Delete only the proxy, exactly as a targeted gateway delete would. */
  function deleteProxyOnly(): Record<string, unknown> {
    const key = `${NAMESPACE}/${proxyId}`;
    const saved = harness.edge.proxies.get(key);
    assert.ok(saved, 'the mock gateway holds the published proxy');
    harness.edge.proxies.delete(key);
    return saved;
  }

  /** Wrap the Edge client's per-key serializer; `onEnter` runs inside the key. */
  function watchKeys(onEnter: (key: string) => void, onExit?: (key: string) => void): void {
    const serialize = harness.edgeClient.serializePerKey.bind(harness.edgeClient);
    harness.edgeClient.serializePerKey = (key, work) =>
      serialize(key, async () => {
        onEnter(key);
        try {
          return await work();
        } finally {
          onExit?.(key);
        }
      });
    restorePatches.push(() => {
      harness.edgeClient.serializePerKey = serialize;
    });
  }

  /** Wrap `edge.proxies.get`; `before` runs ahead of the real read. */
  function watchProxyReads(before: (id: string) => Promise<void> | void): void {
    const proxies = harness.edgeClient.proxies;
    const get = proxies.get.bind(proxies);
    proxies.get = async (id: string): Promise<EdgeProxy | null> => {
      await before(id);
      return get(id);
    };
    restorePatches.push(() => {
      proxies.get = get;
    });
  }

  async function repair(): Promise<RepairGatewayReferencesResponse> {
    const response = await harness.authed(superAdmin, {
      method: 'POST',
      url: '/api/admin/gateway/repair',
      payload: { api_ids: [apiId], reason: 'repair race' },
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json<RepairGatewayReferencesResponse>();
  }

  /** `API_GATEWAY_REPAIR_REQUIRED` rows the repair itself wrote for the API. */
  async function repairFlags(): Promise<number> {
    return (await harness.auditRows(AuditAction.API_GATEWAY_REPAIR_REQUIRED)).filter(
      (row) => row.target_id === apiId && row.actor_user_id === superAdmin.user.id,
    ).length;
  }

  it('flags an orphaned proxy only under the restore key, after asking the gateway', async () => {
    deleteProxyOnly();
    const held = new Set<string>();
    watchKeys(
      (key) => held.add(key),
      (key) => held.delete(key),
    );
    let checkedUnderKey = false;
    watchProxyReads((id) => {
      if (id === proxyId && held.has(apiRestoreLockKey(apiId))) checkedUnderKey = true;
    });

    const body = await repair();
    assert.equal(body.apis.length, 1);
    assert.equal(body.apis[0]?.flagged, true, body.apis[0]?.error ?? undefined);
    assert.ok(checkedUnderKey, 'the gateway was asked again while the restore key was held');

    const row = await harness.store.apis.findById(apiId);
    assert.equal(row?.ferrum_proxy_id, null);
    assert.equal(row?.gateway_state, 'repair_required');
    assert.equal(await repairFlags(), 1, 'the flag and its audit row committed together');
  });

  it('leaves a proxy the gateway serves again alone', async () => {
    const saved = deleteProxyOnly();
    // The pass sees the `404`; an operator puts the proxy back before the flag
    // is written. Reinstating it on entry to the restore key is the latest
    // moment that can happen, and the re-check has to see it.
    let reinstated = false;
    watchKeys((key) => {
      if (key !== apiRestoreLockKey(apiId) || reinstated) return;
      reinstated = true;
      harness.edge.proxies.set(`${NAMESPACE}/${proxyId}`, saved);
    });

    const body = await repair();
    assert.ok(reinstated, 'the repair took the restore key');
    assert.equal(body.apis[0]?.flagged, false);
    assert.match(body.apis[0]?.error ?? '', /serves this API’s proxy again/);

    const row = await harness.store.apis.findById(apiId);
    assert.equal(row?.ferrum_proxy_id, proxyId, 'the live proxy is still referenced');
    assert.equal(row?.gateway_state, 'deployed');
    assert.equal(await repairFlags(), 0, 'nothing was flagged, so nothing was audited');
  });

  it('does not clear the proxy a restore rebuilt after the pass it acts on', async () => {
    deleteProxyOnly();
    // The repair's pass reads the dead reference; before its answer is in, a
    // provider restores the deployment end to end. The repair then acts on a
    // pass that predates the restore.
    type Reply = Awaited<ReturnType<TestApp['authed']>>;
    const race: { raced: boolean; restored: Reply | null } = { raced: false, restored: null };
    watchProxyReads(async (id) => {
      if (id !== proxyId || race.raced) return;
      race.raced = true;
      race.restored = await harness.authed(provider, {
        method: 'POST',
        url: `/api/apis/${apiId}/restore-gateway`,
        payload: {},
      });
    });

    const body = await repair();
    const response = race.restored;
    assert.ok(response, 'the restore ran inside the repair’s pass');
    assert.equal(response.statusCode, 200, response.body);
    const rebuilt = response.json<RestoreApiGatewayResponse>().proxy_id;
    assert.notEqual(rebuilt, proxyId);

    assert.equal(body.apis[0]?.flagged, false, 'the stale orphan was not acted on');
    const row = await harness.store.apis.findById(apiId);
    assert.equal(row?.ferrum_proxy_id, rebuilt, 'the rebuilt proxy is still referenced');
    assert.equal(row?.gateway_state, 'deployed');
    assert.ok(harness.edge.proxies.has(`${NAMESPACE}/${rebuilt}`), 'and still on the gateway');
    assert.equal(await repairFlags(), 0);

    // The state the bug left behind was a live proxy no row pointed at, which
    // the next restore tripped over. Here there is nothing to restore at all.
    const again = await harness.authed(provider, {
      method: 'POST',
      url: `/api/apis/${apiId}/restore-gateway`,
      payload: {},
    });
    assert.equal(again.statusCode, 409, again.body);
    assert.match(again.body, /already has a gateway proxy/);
  });
});
