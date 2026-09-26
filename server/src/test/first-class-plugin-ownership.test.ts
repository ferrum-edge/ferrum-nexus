/**
 * The first-class plugin configs — auth, `access_control`, `rate_limiting`,
 * `cors` — are addressed by the id the portal recorded, never by plugin name.
 *
 * Edge lets a proxy carry several configs of one plugin name, and a gateway
 * operator is entitled to put a limiter, a CORS policy or an extra gate of
 * their own on a portal proxy. Every case here seeds exactly that — a config
 * Nexus never created, of the same name, associated so the gateway runs it —
 * and asserts it comes out of each API settings change **byte for byte** as it
 * went in, whether it is listed before or after the portal's own config.
 *
 * The last block covers APIs published before the ownership record existed:
 * their configs are recognised once, conservatively, and anything ambiguous is
 * refused rather than guessed at.
 */

import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';

import {
  type ApiErrorBody,
  type PublishApiResponse,
  type UpdateApiResponse,
} from '@ferrum-nexus/shared';

import type { ApiGatewayPluginIds } from '../db/store.js';
import { SAMPLE_SPEC_YAML, buildTestApp, type TestApp, type TestSession } from './helpers.js';

/** An operator's own brake: one request a minute, per consumer. */
const OPERATOR_LIMIT = {
  limit_by: 'consumer',
  expose_headers: true,
  limits: [{ scope: 'default', window_seconds: 60, max_requests: 1 }],
};

describe('first-class plugin ownership', () => {
  let harness: TestApp;
  let provider: TestSession;
  let slugCounter = 0;

  before(async () => {
    harness = await buildTestApp();
    await harness.registerUser({ email: 'ownership-founder@example.test' });
    provider = await harness.registerUser({
      email: 'ownership-provider@example.test',
      role: 'provider',
    });
  });

  after(async () => {
    await harness.close();
  });

  afterEach(() => {
    harness.edge.clearInjections();
  });

  /** Publish a fresh API and return its id and proxy id. */
  async function publish(
    overrides: Record<string, unknown> = {},
  ): Promise<{ id: string; proxyId: string }> {
    slugCounter += 1;
    const response = await harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: {
        name: `Ownership ${String(slugCounter)}`,
        slug: `ownership-${String(slugCounter)}`,
        version: '1.0.0',
        spec: SAMPLE_SPEC_YAML,
        auth_plugin: 'key_auth',
        requestable: false,
        visibility: 'public',
        ...overrides,
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    const api = response.json<PublishApiResponse>().api;
    return { id: api.id, proxyId: String(api.ferrum_proxy_id) };
  }

  /** `PATCH /api/apis/:id` as the owning provider. */
  async function patch(apiId: string, payload: Record<string, unknown>) {
    return harness.authed(provider, { method: 'PATCH', url: `/api/apis/${apiId}`, payload });
  }

  /** The proxy's association list, as plain config ids. */
  function associatedIds(proxyId: string): string[] {
    const proxy = harness.edge.proxies.get(`nexus/${proxyId}`);
    const plugins = Array.isArray(proxy?.plugins) ? proxy.plugins : [];
    return plugins.map((entry: { plugin_config_id: unknown }) => String(entry.plugin_config_id));
  }

  /** Config ids the gateway would actually execute for the proxy. */
  function effectiveIds(proxyId: string): string[] {
    return harness.edge.effectivePluginsForProxy(proxyId).map((plugin) => String(plugin.id));
  }

  /** The stored gateway config with this id, or `undefined`. */
  function stored(id: string): Record<string, unknown> | undefined {
    return harness.edge.pluginConfigs.get(`nexus/${id}`);
  }

  /** Every config of `name` on the proxy, in the order the gateway lists them. */
  function configsNamed(proxyId: string, name: string): Record<string, unknown>[] {
    return harness.edge.pluginsForProxy(proxyId).filter((plugin) => plugin.plugin_name === name);
  }

  /** What `api_gateway_plugins` records for the API. */
  async function ownedIds(apiId: string): Promise<ApiGatewayPluginIds> {
    const rows = await harness.store.apiGatewayPlugins.listByApi(apiId);
    return Object.fromEntries(rows.map((row) => [row.role, row.ferrum_plugin_config_id]));
  }

  /**
   * A config of `name` on the proxy that an operator created by hand and
   * associated, so the gateway runs it. Returns a deep copy of it as seeded —
   * what it must still look like afterwards.
   */
  function seedOperatorConfig(
    proxyId: string,
    name: string,
    id: string,
    config: Record<string, unknown>,
  ): Record<string, unknown> {
    const seeded: Record<string, unknown> = {
      id,
      namespace: 'nexus',
      plugin_name: name,
      scope: 'proxy',
      proxy_id: proxyId,
      enabled: true,
      config,
      priority_override: 42,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    };
    harness.edge.pluginConfigs.set(`nexus/${id}`, seeded);
    const proxy = harness.edge.proxies.get(`nexus/${proxyId}`);
    assert.ok(proxy, 'expected the published proxy');
    proxy.plugins = [...associatedIds(proxyId), id].map((plugin_config_id) => ({
      plugin_config_id,
    }));
    return structuredClone(seeded);
  }

  /** Assert the operator's config is exactly as seeded and still runs. */
  function assertUntouched(proxyId: string, snapshot: Record<string, unknown>): void {
    const id = String(snapshot.id);
    assert.deepEqual(stored(id), snapshot, 'the operator’s config is byte-for-byte unchanged');
    assert.ok(effectiveIds(proxyId).includes(id), 'and the gateway still runs it');
  }

  /* ── rate_limit ────────────────────────────────────────────────────────── */

  it('sets, changes and clears the quota beside an operator limiter listed first', async () => {
    const { id, proxyId } = await publish();
    const operator = seedOperatorConfig(proxyId, 'rate_limiting', 'op-limit-first', OPERATOR_LIMIT);

    const set = await patch(id, { rate_limit: { limit: 500, window_seconds: 60 } });
    assert.equal(set.statusCode, 200, set.body);
    assertUntouched(proxyId, operator);
    const owned = (await ownedIds(id)).rate_limit;
    assert.ok(owned, 'the portal records the limiter it created');
    assert.notEqual(owned, 'op-limit-first', 'and it is not the operator’s');
    assert.equal(String(configsNamed(proxyId, 'rate_limiting')[0]?.id), 'op-limit-first');
    assert.deepEqual((stored(owned)?.config as { limits?: unknown }).limits, [
      { scope: 'default', window_seconds: 60, max_requests: 500 },
    ]);
    assert.ok(effectiveIds(proxyId).includes(owned), 'the portal’s limiter runs too');

    const changed = await patch(id, { rate_limit: { limit: 800, window_seconds: 60 } });
    assert.equal(changed.statusCode, 200, changed.body);
    assertUntouched(proxyId, operator);
    assert.equal((await ownedIds(id)).rate_limit, owned, 'a change rewrites the same config');
    assert.deepEqual((stored(owned)?.config as { limits?: unknown }).limits, [
      { scope: 'default', window_seconds: 60, max_requests: 800 },
    ]);

    const cleared = await patch(id, { rate_limit: null });
    assert.equal(cleared.statusCode, 200, cleared.body);
    assert.equal(cleared.json<UpdateApiResponse>().api.rate_limit, null);
    assertUntouched(proxyId, operator);
    assert.equal(stored(owned), undefined, 'only the portal’s limiter is deleted');
    assert.equal((await ownedIds(id)).rate_limit, undefined);
  });

  it('changes and clears its own quota beside an operator limiter listed after it', async () => {
    const { id, proxyId } = await publish({ rate_limit: { limit: 100, window_seconds: 60 } });
    const owned = (await ownedIds(id)).rate_limit;
    assert.ok(owned, 'publish records the limiter it created');
    const operator = seedOperatorConfig(proxyId, 'rate_limiting', 'op-limit-after', OPERATOR_LIMIT);
    assert.equal(String(configsNamed(proxyId, 'rate_limiting')[1]?.id), 'op-limit-after');

    const changed = await patch(id, { rate_limit: { limit: 500, window_seconds: 60 } });
    assert.equal(changed.statusCode, 200, changed.body);
    assertUntouched(proxyId, operator);
    assert.deepEqual((stored(owned)?.config as { limits?: unknown }).limits, [
      { scope: 'default', window_seconds: 60, max_requests: 500 },
    ]);

    const cleared = await patch(id, { rate_limit: null });
    assert.equal(cleared.statusCode, 200, cleared.body);
    assertUntouched(proxyId, operator);
    assert.equal(stored(owned), undefined);
    assert.deepEqual(configsNamed(proxyId, 'rate_limiting').map((plugin) => String(plugin.id)), [
      'op-limit-after',
    ]);
  });

  it('never adopts an operator limiter after its own was removed by hand', async () => {
    const { id, proxyId } = await publish({ rate_limit: { limit: 100, window_seconds: 60 } });
    const original = (await ownedIds(id)).rate_limit;
    assert.ok(original);
    // The operator deletes the portal's limiter and puts their own in.
    harness.edge.pluginConfigs.delete(`nexus/${original}`);
    const proxy = harness.edge.proxies.get(`nexus/${proxyId}`);
    assert.ok(proxy);
    proxy.plugins = associatedIds(proxyId)
      .filter((value) => value !== original)
      .map((plugin_config_id) => ({ plugin_config_id }));
    const operator = seedOperatorConfig(proxyId, 'rate_limiting', 'op-limit-alone', OPERATOR_LIMIT);

    // An unchanged replay repairs nothing it does not own.
    const replay = await patch(id, { rate_limit: { limit: 100, window_seconds: 60 } });
    assert.equal(replay.statusCode, 200, replay.body);
    assertUntouched(proxyId, operator);

    const changed = await patch(id, { rate_limit: { limit: 500, window_seconds: 60 } });
    assert.equal(changed.statusCode, 200, changed.body);
    assertUntouched(proxyId, operator);
    const fresh = (await ownedIds(id)).rate_limit;
    assert.ok(fresh);
    assert.notEqual(fresh, original);
    assert.notEqual(fresh, 'op-limit-alone');
    assert.ok(effectiveIds(proxyId).includes(fresh));
  });

  /* ── cors ─────────────────────────────────────────────────────────────── */

  it('sets and clears a CORS policy beside an operator CORS config', async () => {
    const { id, proxyId } = await publish();
    const operator = seedOperatorConfig(proxyId, 'cors', 'op-cors', {
      allowed_origins: ['https://ops.example.com'],
      allow_credentials: false,
      allowed_headers: ['Accept'],
      allowed_methods: ['GET'],
    });

    const set = await patch(id, {
      cors: { allowed_origins: ['https://app.example.com'], allow_credentials: false },
    });
    assert.equal(set.statusCode, 200, set.body);
    assertUntouched(proxyId, operator);
    const owned = (await ownedIds(id)).cors;
    assert.ok(owned);
    assert.notEqual(owned, 'op-cors');
    assert.deepEqual((stored(owned)?.config as { allowed_origins?: unknown }).allowed_origins, [
      'https://app.example.com',
    ]);

    const cleared = await patch(id, { cors: null });
    assert.equal(cleared.statusCode, 200, cleared.body);
    assertUntouched(proxyId, operator);
    assert.equal(stored(owned), undefined);
    assert.equal((await ownedIds(id)).cors, undefined);
  });

  /* ── access_control and the auth plugin ───────────────────────────────── */

  it('drops only its own ACL gate when requestable is switched off', async () => {
    const { id, proxyId } = await publish({ requestable: true });
    const owned = (await ownedIds(id)).access_control;
    assert.ok(owned);
    const operator = seedOperatorConfig(proxyId, 'access_control', 'op-acl', {
      allowed_groups: ['operators'],
    });

    const off = await patch(id, { requestable: false });
    assert.equal(off.statusCode, 200, off.body);
    assertUntouched(proxyId, operator);
    assert.equal(stored(owned), undefined);
    assert.equal((await ownedIds(id)).access_control, undefined);

    // Switched back on, the portal creates its own gate again rather than
    // treating the operator's as one.
    const on = await patch(id, { requestable: true });
    assert.equal(on.statusCode, 200, on.body);
    assertUntouched(proxyId, operator);
    const again = (await ownedIds(id)).access_control;
    assert.ok(again);
    assert.notEqual(again, 'op-acl');
    assert.ok(effectiveIds(proxyId).includes(again));
  });

  it('swaps out only its own auth plugin', async () => {
    const { id, proxyId } = await publish();
    const owned = (await ownedIds(id)).auth;
    assert.ok(owned);
    const operator = seedOperatorConfig(proxyId, 'key_auth', 'op-key-auth', {});

    const swapped = await patch(id, { auth_plugin: 'jwt_auth' });
    assert.equal(swapped.statusCode, 200, swapped.body);
    assertUntouched(proxyId, operator);
    assert.equal(stored(owned), undefined, 'the portal’s key_auth is gone');
    const replacement = (await ownedIds(id)).auth;
    assert.ok(replacement);
    assert.equal(stored(replacement)?.plugin_name, 'jwt_auth');
    assert.ok(effectiveIds(proxyId).includes(replacement));
  });

  it('forgets an API’s record when the API is deleted', async () => {
    const { id } = await publish({ rate_limit: { limit: 100, window_seconds: 60 } });
    assert.ok((await ownedIds(id)).auth);
    const deleted = await harness.authed(provider, { method: 'DELETE', url: `/api/apis/${id}` });
    assert.equal(deleted.statusCode, 200, deleted.body);
    assert.deepEqual(await harness.store.apiGatewayPlugins.listByApi(id), []);
  });

  /* ── APIs published before the record existed ─────────────────────────── */

  describe('an API with no ownership record', () => {
    /** Make `apiId` look like an API a release before the record published. */
    async function forgetRecord(apiId: string): Promise<void> {
      await harness.store.apiGatewayPlugins.replace(apiId, {});
      assert.deepEqual(await harness.store.apiGatewayPlugins.listByApi(apiId), []);
    }

    it('recognises its own limiter and leaves a differently tuned one alone', async () => {
      const { id, proxyId } = await publish({ rate_limit: { limit: 100, window_seconds: 60 } });
      const portal = String(configsNamed(proxyId, 'rate_limiting')[0]?.id);
      await forgetRecord(id);
      const operator = seedOperatorConfig(proxyId, 'rate_limiting', 'op-legacy', OPERATOR_LIMIT);

      const changed = await patch(id, { rate_limit: { limit: 500, window_seconds: 60 } });
      assert.equal(changed.statusCode, 200, changed.body);
      assertUntouched(proxyId, operator);
      assert.deepEqual((stored(portal)?.config as { limits?: unknown }).limits, [
        { scope: 'default', window_seconds: 60, max_requests: 500 },
      ]);
      // The recognised ids are recorded, so the API is governed by its record
      // from now on.
      const recorded = await ownedIds(id);
      assert.equal(recorded.rate_limit, portal);
      assert.ok(recorded.auth);
    });

    it('never adopts an operator limiter for a quota the API does not have', async () => {
      const { id, proxyId } = await publish();
      await forgetRecord(id);
      const operator = seedOperatorConfig(proxyId, 'rate_limiting', 'op-unset', OPERATOR_LIMIT);

      const set = await patch(id, { rate_limit: { limit: 500, window_seconds: 60 } });
      assert.equal(set.statusCode, 200, set.body);
      assertUntouched(proxyId, operator);
      const owned = (await ownedIds(id)).rate_limit;
      assert.ok(owned);
      assert.notEqual(owned, 'op-unset');
    });

    it('refuses to guess between two limiters that both look like its own', async () => {
      const { id, proxyId } = await publish({ rate_limit: { limit: 100, window_seconds: 60 } });
      const portal = configsNamed(proxyId, 'rate_limiting')[0];
      assert.ok(portal);
      const portalSnapshot = structuredClone(portal);
      await forgetRecord(id);
      const operator = seedOperatorConfig(proxyId, 'rate_limiting', 'op-lookalike', {
        limit_by: 'consumer',
        expose_headers: true,
        limits: [{ scope: 'default', window_seconds: 60, max_requests: 100 }],
      });
      const writesBefore = harness.edge.callsTo('PUT', '/plugins/config').length;

      const refused = await patch(id, { rate_limit: { limit: 500, window_seconds: 60 } });
      assert.equal(refused.statusCode, 409, refused.body);
      assert.equal(refused.json<ApiErrorBody>().error.code, 'CONFLICT');
      assert.equal(harness.edge.callsTo('PUT', '/plugins/config').length, writesBefore);
      assertUntouched(proxyId, operator);
      assert.deepEqual(stored(String(portalSnapshot.id)), portalSnapshot);
      assert.deepEqual(await ownedIds(id), {}, 'nothing is recorded from a guess');
      assert.deepEqual(
        (await harness.store.apis.findById(id))?.rate_limit,
        { limit: 100, window_seconds: 60 },
        'and the portal still describes what it had',
      );

      // A save that does not change the ambiguous setting still goes through —
      // including the SPA's, which replays the whole settings block.
      const renamed = await patch(id, {
        description: 'Renamed while ambiguous',
        rate_limit: { limit: 100, window_seconds: 60 },
      });
      assert.equal(renamed.statusCode, 200, renamed.body);
      assert.equal(harness.edge.callsTo('PUT', '/plugins/config').length, writesBefore);
      assertUntouched(proxyId, operator);
    });
  });
});
