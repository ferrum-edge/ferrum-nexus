/**
 * Plugin-config writes whose acknowledgement never arrives.
 *
 * A `PUT /plugins/config/{id}` or a `POST /plugins/config` Ferrum Edge applied
 * and could not answer for rejects in the caller exactly like one Edge
 * refused. The compensation for it therefore has to exist **before** the
 * write is dispatched: registered afterwards, it never ran, and a security
 * plugin — an `ip_restriction` switched off, a quota raised — stayed changed on
 * the gateway while the request failed, the portal kept describing the old
 * setting and no audit row said anything had happened.
 *
 * Each case injects the lost acknowledgement with the mock's
 * `queueLostAck`, which applies the write to the stored resource and only then
 * answers with an error, and asserts three things: the gateway is back where
 * the portal says it is, the portal row did not move, and the audit trail
 * records the outcome — including when the compensation itself cannot finish.
 */

import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';

import { type PublishApiResponse } from '@ferrum-nexus/shared';

import { SAMPLE_SPEC_YAML, buildTestApp, type TestApp, type TestSession } from './helpers.js';

describe('a plugin-config write whose acknowledgement is lost', () => {
  let harness: TestApp;
  let provider: TestSession;
  let slugCounter = 0;

  before(async () => {
    harness = await buildTestApp();
    await harness.registerUser({ email: 'plugin-ack-founder@example.test' });
    provider = await harness.registerUser({
      email: 'plugin-ack-provider@example.test',
      role: 'provider',
    });
  });

  after(async () => {
    await harness.close();
  });

  // One-shot and matched: an injection a test armed but never met would fire
  // inside the next test instead.
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
        name: `Plugin ack ${String(slugCounter)}`,
        slug: `plugin-ack-${String(slugCounter)}`,
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

  /** `PUT /api/apis/:id/plugins/:name` as the owning provider. */
  async function setPlugin(apiId: string, name: string, payload: Record<string, unknown>) {
    return harness.authed(provider, {
      method: 'PUT',
      url: `/api/apis/${apiId}/plugins/${name}`,
      payload,
    });
  }

  /** The `details` of every row of `action` recorded against this API. */
  async function rowsFor(action: string, apiId: string): Promise<Record<string, unknown>[]> {
    const rows = await harness.auditRows(action);
    return rows.filter((row) => row.target_id === apiId).map((row) => row.details);
  }

  /** The stored gateway config with this id, or `undefined`. */
  function stored(id: string): Record<string, unknown> | undefined {
    return harness.edge.pluginConfigs.get(`nexus/${id}`);
  }

  /** Every config of `name` on the proxy. */
  function configsNamed(proxyId: string, name: string): Record<string, unknown>[] {
    return harness.edge.pluginsForProxy(proxyId).filter((plugin) => plugin.plugin_name === name);
  }

  /** Config ids the gateway would actually execute for the proxy. */
  function effectiveIds(proxyId: string): string[] {
    return harness.edge.effectivePluginsForProxy(proxyId).map((plugin) => String(plugin.id));
  }

  /** An API running an `ip_restriction` allow-list the provider saved. */
  async function restricted(): Promise<{ id: string; proxyId: string; configId: string }> {
    const api = await publish();
    const saved = await setPlugin(api.id, 'ip_restriction', {
      enabled: true,
      config: { allow: ['203.0.113.9'] },
    });
    assert.equal(saved.statusCode, 200, saved.body);
    const row = await harness.store.apiPlugins.find(api.id, 'ip_restriction');
    assert.ok(row?.ferrum_plugin_config_id);
    return { ...api, configId: row.ferrum_plugin_config_id };
  }

  /* ── The palette ───────────────────────────────────────────────────────── */

  it('switches a security plugin back on when its switch-off landed unacknowledged', async () => {
    const { id, proxyId, configId } = await restricted();
    const before = structuredClone(stored(configId));
    const setsBefore = (await rowsFor('api.plugin_set', id)).length;

    harness.edge.queueLostAck(503, { error: 'timeout' }, `/plugins/config/${configId}`, 'PUT');
    const failed = await setPlugin(id, 'ip_restriction', {
      enabled: false,
      config: { allow: ['203.0.113.9'] },
    });
    assert.equal(failed.statusCode, 502, failed.body);

    // The undo was registered before the `PUT`, so it ran: the gateway is
    // enforcing the restriction the portal still shows.
    assert.equal(stored(configId)?.enabled, true);
    assert.deepEqual(stored(configId)?.config, before?.config);
    assert.ok(effectiveIds(proxyId).includes(configId));
    assert.equal((await harness.store.apiPlugins.find(id, 'ip_restriction'))?.enabled, true);

    assert.equal((await rowsFor('api.plugin_set', id)).length, setsBefore);
    const rollbacks = await rowsFor('api.plugin_rollback', id);
    assert.equal(rollbacks.length, 1);
    assert.equal(rollbacks[0]?.operation, 'set');
    assert.equal(rollbacks[0]?.plugin_name, 'ip_restriction');
    assert.equal(rollbacks[0]?.plugin_config_id, configId);
    assert.equal(rollbacks[0]?.restored, true);
    assert.equal(rollbacks[0]?.step_errors, undefined);
  });

  it('puts the previous allow-list back when a tightening landed unacknowledged', async () => {
    const { id, configId } = await restricted();

    harness.edge.queueLostAck(503, { error: 'timeout' }, `/plugins/config/${configId}`, 'PUT');
    const failed = await setPlugin(id, 'ip_restriction', {
      enabled: true,
      config: { allow: ['198.51.100.1'] },
    });
    assert.equal(failed.statusCode, 502, failed.body);

    assert.deepEqual((stored(configId)?.config as { allow?: unknown }).allow, ['203.0.113.9']);
    assert.deepEqual((await harness.store.apiPlugins.find(id, 'ip_restriction'))?.config, {
      allow: ['203.0.113.9'],
    });
    const rollbacks = await rowsFor('api.plugin_rollback', id);
    assert.equal(rollbacks.at(-1)?.restored, true);
  });

  it('keeps an operator’s trigger and priority through the compensation', async () => {
    const { id, configId } = await restricted();
    const config = stored(configId);
    assert.ok(config);
    const trigger = { when: { match: { method: ['POST'] } } };
    config.trigger = trigger;
    config.priority_override = 1_234;

    harness.edge.queueLostAck(503, { error: 'timeout' }, `/plugins/config/${configId}`, 'PUT');
    const failed = await setPlugin(id, 'ip_restriction', {
      enabled: false,
      config: { allow: ['203.0.113.9'] },
    });
    assert.equal(failed.statusCode, 502, failed.body);

    assert.equal(stored(configId)?.enabled, true);
    assert.deepEqual(stored(configId)?.trigger, trigger);
    assert.equal(stored(configId)?.priority_override, 1_234);
  });

  it('removes a new plugin whose create landed unacknowledged', async () => {
    const { id, proxyId } = await publish();

    harness.edge.queueLostAck(503, { error: 'timeout' }, '/plugins/config', 'POST');
    const failed = await setPlugin(id, 'ip_restriction', {
      enabled: true,
      config: { allow: ['203.0.113.9'] },
    });
    assert.equal(failed.statusCode, 502, failed.body);

    // The id was minted before the create, so the undo could name it.
    assert.deepEqual(configsNamed(proxyId, 'ip_restriction'), []);
    assert.equal(await harness.store.apiPlugins.find(id, 'ip_restriction'), null);
    const rollbacks = await rowsFor('api.plugin_rollback', id);
    assert.equal(rollbacks.length, 1);
    assert.equal(rollbacks[0]?.restored, true);
    assert.equal(typeof rollbacks[0]?.plugin_config_id, 'string');
    assert.equal(stored(String(rollbacks[0]?.plugin_config_id)), undefined);
  });

  it('records the divergence when the compensation cannot finish', async () => {
    const { id, configId } = await restricted();

    // The switch-off lands and is not acknowledged; the `PUT` that would put
    // it back is refused.
    harness.edge.queueLostAck(503, { error: 'timeout' }, `/plugins/config/${configId}`, 'PUT');
    harness.edge.queueFailure(
      503,
      { error: 'gateway unavailable' },
      `/plugins/config/${configId}`,
      'PUT',
      1,
    );
    const failed = await setPlugin(id, 'ip_restriction', {
      enabled: false,
      config: { allow: ['203.0.113.9'] },
    });
    assert.equal(failed.statusCode, 502, failed.body);

    // The gateway could not be put back, and that is exactly what the record
    // says — naming the config an operator has to look at.
    assert.equal(stored(configId)?.enabled, false);
    const rollbacks = await rowsFor('api.plugin_rollback', id);
    assert.equal(rollbacks.length, 1);
    assert.equal(rollbacks[0]?.restored, false);
    assert.equal(rollbacks[0]?.plugin_config_id, configId);
    const stepErrors = rollbacks[0]?.step_errors;
    assert.ok(Array.isArray(stepErrors) && stepErrors.length > 0);
    // Config values never reach the audit row.
    assert.ok(!JSON.stringify(rollbacks[0]).includes('203.0.113.9'));
  });

  it('puts a removed plugin back under its own id after an unacknowledged delete', async () => {
    const { id, proxyId, configId } = await restricted();

    harness.edge.queueLostAck(503, { error: 'timeout' }, `/plugins/config/${configId}`, 'DELETE');
    const failed = await harness.authed(provider, {
      method: 'DELETE',
      url: `/api/apis/${id}/plugins/ip_restriction`,
    });
    assert.equal(failed.statusCode, 502, failed.body);

    // Recreated under the id the row records, so the portal still owns it.
    assert.equal(stored(configId)?.enabled, true);
    assert.ok(effectiveIds(proxyId).includes(configId));
    assert.equal(
      (await harness.store.apiPlugins.find(id, 'ip_restriction'))?.ferrum_plugin_config_id,
      configId,
    );
    const rollbacks = await rowsFor('api.plugin_rollback', id);
    assert.equal(rollbacks.at(-1)?.operation, 'remove');
    assert.equal(rollbacks.at(-1)?.restored, true);
  });

  /* ── The first-class settings ──────────────────────────────────────────── */

  it('puts the quota back when a rate-limit change landed unacknowledged', async () => {
    const { id, proxyId } = await publish({ rate_limit: { limit: 100, window_seconds: 60 } });
    const owned = (await harness.store.apiGatewayPlugins.listByApi(id)).find(
      (row) => row.role === 'rate_limit',
    )?.ferrum_plugin_config_id;
    assert.ok(owned);

    harness.edge.queueLostAck(503, { error: 'timeout' }, `/plugins/config/${owned}`, 'PUT');
    const failed = await harness.authed(provider, {
      method: 'PATCH',
      url: `/api/apis/${id}`,
      payload: { rate_limit: { limit: 5_000, window_seconds: 60 } },
    });
    assert.equal(failed.statusCode, 502, failed.body);

    assert.deepEqual((stored(owned)?.config as { limits?: unknown }).limits, [
      { scope: 'default', window_seconds: 60, max_requests: 100 },
    ]);
    assert.ok(effectiveIds(proxyId).includes(owned));
    assert.deepEqual((await harness.store.apis.findById(id))?.rate_limit, {
      limit: 100,
      window_seconds: 60,
    });
    assert.deepEqual(await rowsFor('api.update', id), []);
  });

  it('removes a new limiter whose create landed unacknowledged', async () => {
    const { id, proxyId } = await publish();

    harness.edge.queueLostAck(503, { error: 'timeout' }, '/plugins/config', 'POST');
    const failed = await harness.authed(provider, {
      method: 'PATCH',
      url: `/api/apis/${id}`,
      payload: { rate_limit: { limit: 5_000, window_seconds: 60 } },
    });
    assert.equal(failed.statusCode, 502, failed.body);

    assert.deepEqual(configsNamed(proxyId, 'rate_limiting'), []);
    assert.equal((await harness.store.apis.findById(id))?.rate_limit, null);
    const recorded = await harness.store.apiGatewayPlugins.listByApi(id);
    assert.equal(recorded.find((row) => row.role === 'rate_limit'), undefined);
  });
});
