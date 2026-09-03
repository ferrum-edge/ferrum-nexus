/**
 * The provider plugin palette, end to end.
 *
 * The assertion that carries the most weight here is **not** "the config was
 * created": a proxy-scoped plugin config with the right `proxy_id` is inert
 * until the proxy's own `plugins[]` names it (issue #13). Every test that
 * attaches a plugin therefore checks `effectivePluginsForProxy`, which models
 * Edge's own `scoped_plugin_config_applies_to_proxy`.
 *
 * The second is the **exact body**. Edge's plugin config key sets are closed, so
 * an extra key is a `400` and a missing required one is a `400`; the mock
 * mirrors both, which makes "the body Nexus sends" a real assertion rather than
 * a restatement of the code.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  PROVIDER_PLUGINS,
  isFirstClassPlugin,
  type ApiErrorBody,
  type ListApiPluginsResponse,
  type PublishApiResponse,
  type SetApiPluginResponse,
} from '@ferrum-nexus/shared';

import { SAMPLE_SPEC_YAML, buildTestApp, type TestApp, type TestSession } from './helpers.js';

function errorCode(body: string): string {
  return (JSON.parse(body) as ApiErrorBody).error.code;
}

function errorMessage(body: string): string {
  return (JSON.parse(body) as ApiErrorBody).error.message;
}

/** The plugin names Edge would actually run for a proxy, sorted. */
function effectiveNames(harness: TestApp, proxyId: string): string[] {
  return harness.edge
    .effectivePluginsForProxy(proxyId)
    .map((plugin) => String(plugin.plugin_name))
    .sort();
}

/** Plugin config ids in the proxy's association list. */
function associatedIds(harness: TestApp, proxyId: string): string[] {
  const proxy = harness.edge.proxies.get(`nexus/${proxyId}`);
  const plugins = Array.isArray(proxy?.plugins) ? proxy.plugins : [];
  return plugins.map((entry) => String((entry as { plugin_config_id: unknown }).plugin_config_id));
}

/** Make the next `store.apiPlugins.upsert(...)` reject, then restore it. */
function failNextUpsert(harness: TestApp, message: string): void {
  const real = harness.store.apiPlugins.upsert.bind(harness.store.apiPlugins);
  harness.store.apiPlugins.upsert = async () => {
    harness.store.apiPlugins.upsert = real;
    throw new Error(message);
  };
}

describe('provider plugin palette', () => {
  let harness: TestApp;
  let provider: TestSession;
  let otherProvider: TestSession;
  let admin: TestSession;
  let apiId: string;
  let proxyId: string;
  let slugCounter = 0;

  /** Publish a fresh API and point the shared `apiId`/`proxyId` at it. */
  async function publishApi(): Promise<void> {
    slugCounter += 1;
    const response = await harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: {
        name: 'Palette API',
        slug: `palette-${String(slugCounter)}`,
        version: '1.0.0',
        spec: SAMPLE_SPEC_YAML,
        auth_plugin: 'key_auth',
        requestable: false,
        visibility: 'public',
      },
    });
    assert.equal(response.statusCode, 201);
    const body = response.json<PublishApiResponse>();
    apiId = body.api.id;
    proxyId = String(body.api.ferrum_proxy_id);
  }

  /** `PUT /api/apis/:id/plugins/:name` as the owning provider. */
  async function setPlugin(
    name: string,
    payload: Record<string, unknown>,
    session: TestSession = provider,
  ) {
    return harness.authed(session, {
      method: 'PUT',
      url: `/api/apis/${apiId}/plugins/${name}`,
      payload,
    });
  }

  /** The stored Edge plugin config for `name` on the current proxy. */
  function edgeConfig(name: string): Record<string, unknown> {
    const config = harness.edge.pluginForProxy(proxyId, name);
    assert.ok(config, `expected an Edge plugin config for ${name}`);
    return config;
  }

  before(async () => {
    harness = await buildTestApp();
    await harness.registerUser({ email: 'palette-founder@example.test' });
    admin = await harness.loginUser('palette-founder@example.test');
    provider = await harness.registerUser({
      email: 'palette-provider@example.test',
      role: 'provider',
    });
    otherProvider = await harness.registerUser({
      email: 'palette-other@example.test',
      role: 'provider',
    });
  });

  after(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    harness.edge.reset();
    await publishApi();
  });

  /* ── Per-plugin bodies ─────────────────────────────────────────────────── */

  describe('the exact body each plugin sends to Edge', () => {
    it('security_headers: the six curated header controls', async () => {
      const response = await setPlugin('security_headers', {
        config: {
          content_type_options: true,
          frame_options: 'DENY',
          referrer_policy: 'no-referrer',
          hsts: true,
          content_security_policy: "default-src 'none'",
          // Cleared in the form: must be omitted, not sent as an empty header.
          permissions_policy: '',
        },
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(edgeConfig('security_headers').config, {
        content_type_options: true,
        frame_options: 'DENY',
        referrer_policy: 'no-referrer',
        hsts: true,
        content_security_policy: "default-src 'none'",
      });
      assert.ok(effectiveNames(harness, proxyId).includes('security_headers'));
    });

    it('request_size_limiting and response_size_limiting: max_bytes only', async () => {
      assert.equal(
        (await setPlugin('request_size_limiting', { config: { max_bytes: 65_536 } })).statusCode,
        200,
      );
      assert.equal(
        (await setPlugin('response_size_limiting', { config: { max_bytes: 1_048_576 } }))
          .statusCode,
        200,
      );
      assert.deepEqual(edgeConfig('request_size_limiting').config, { max_bytes: 65_536 });
      assert.deepEqual(edgeConfig('response_size_limiting').config, { max_bytes: 1_048_576 });
    });

    it('ip_restriction: the allow/deny lists and the evaluation order', async () => {
      const response = await setPlugin('ip_restriction', {
        config: {
          allow: ['203.0.113.0/24', '2001:db8::/32'],
          deny: ['203.0.113.7'],
          mode: 'deny_first',
        },
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(edgeConfig('ip_restriction').config, {
        allow: ['203.0.113.0/24', '2001:db8::/32'],
        deny: ['203.0.113.7'],
        mode: 'deny_first',
      });
    });

    it('bot_detection: patterns, allow list, missing-UA policy and status', async () => {
      const response = await setPlugin('bot_detection', {
        config: {
          blocked_patterns: ['curl', 'scrapy'],
          allow_list: ['GoogleBot'],
          allow_missing_user_agent: false,
          custom_response_code: 429,
        },
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(edgeConfig('bot_detection').config, {
        blocked_patterns: ['curl', 'scrapy'],
        allow_list: ['GoogleBot'],
        allow_missing_user_agent: false,
        custom_response_code: 429,
      });
    });

    it('correlation_id: header name and echo', async () => {
      const response = await setPlugin('correlation_id', {
        config: { header_name: 'x-trace-id', echo_downstream: true },
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(edgeConfig('correlation_id').config, {
        header_name: 'x-trace-id',
        echo_downstream: true,
      });
    });

    it('compression: algorithms, threshold and content types', async () => {
      const response = await setPlugin('compression', {
        config: {
          algorithms: ['gzip', 'br'],
          min_content_length: 1_024,
          content_types: ['application/json', 'text/html'],
        },
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(edgeConfig('compression').config, {
        algorithms: ['gzip', 'br'],
        min_content_length: 1_024,
        content_types: ['application/json', 'text/html'],
      });
    });

    it('response_caching: ttl, methods, statuses, keyspace and vary', async () => {
      const response = await setPlugin('response_caching', {
        config: {
          ttl_seconds: 60,
          cacheable_methods: ['GET', 'HEAD'],
          cacheable_status_codes: [200, 404],
          cache_key_include_query: true,
          vary_by_headers: ['accept-language'],
        },
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(edgeConfig('response_caching').config, {
        ttl_seconds: 60,
        cacheable_methods: ['GET', 'HEAD'],
        cacheable_status_codes: [200, 404],
        cache_key_include_query: true,
        vary_by_headers: ['accept-language'],
      });
    });

    it('request_deduplication: idempotency header, ttl, methods and enforcement', async () => {
      const response = await setPlugin('request_deduplication', {
        config: {
          header_name: 'Idempotency-Key',
          ttl_seconds: 900,
          applicable_methods: ['POST', 'PATCH'],
          enforce_required: true,
        },
      });
      assert.equal(response.statusCode, 200);
      // No Redis keys at all in `local` mode: Edge *rejects* them outside
      // `sync_mode: 'redis'`, so sending them would be a 400.
      assert.deepEqual(edgeConfig('request_deduplication').config, {
        header_name: 'Idempotency-Key',
        ttl_seconds: 900,
        applicable_methods: ['POST', 'PATCH'],
        enforce_required: true,
      });
    });

    it('request_termination: the maintenance response', async () => {
      const response = await setPlugin('request_termination', {
        config: { status_code: 410, message: 'This endpoint was retired on 2026-01-01' },
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(edgeConfig('request_termination').config, {
        status_code: 410,
        message: 'This endpoint was retired on 2026-01-01',
      });
    });

    it('sends nothing for a field the provider left alone', async () => {
      // Every field of `compression` is optional, so an empty config means
      // "the gateway's own defaults" rather than a frozen Nexus copy of them.
      assert.equal((await setPlugin('compression', { config: {} })).statusCode, 200);
      assert.deepEqual(edgeConfig('compression').config, {});
    });
  });

  /* ── Association, replace, delete, disable ─────────────────────────────── */

  describe('the gateway lifecycle', () => {
    it('associates a new plugin so the gateway actually runs it', async () => {
      assert.equal((await setPlugin('correlation_id', { config: {} })).statusCode, 200);

      const config = edgeConfig('correlation_id');
      assert.equal(config.scope, 'proxy');
      assert.equal(config.proxy_id, proxyId);
      assert.equal(config.enabled, true);
      assert.ok(
        associatedIds(harness, proxyId).includes(String(config.id)),
        'the proxy must name the config, or Edge never runs it',
      );
      assert.deepEqual(effectiveNames(harness, proxyId), ['correlation_id', 'key_auth']);
    });

    it('keeps the config id across a replace, so the association is untouched', async () => {
      await setPlugin('response_caching', { config: { ttl_seconds: 60 } });
      const first = String(edgeConfig('response_caching').id);
      const associationsBefore = associatedIds(harness, proxyId);

      const response = await setPlugin('response_caching', { config: { ttl_seconds: 300 } });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json<SetApiPluginResponse>().plugin.config.ttl_seconds, 300);

      assert.equal(String(edgeConfig('response_caching').id), first, 'a replace reuses the id');
      assert.deepEqual(associatedIds(harness, proxyId), associationsBefore);
      assert.deepEqual(edgeConfig('response_caching').config, { ttl_seconds: 300 });
    });

    it('preserves created_at across a replace and moves updated_at', async () => {
      const first = (
        await setPlugin('correlation_id', { config: { echo_downstream: true } })
      ).json<SetApiPluginResponse>().plugin;
      const second = (
        await setPlugin('correlation_id', { config: { echo_downstream: false } })
      ).json<SetApiPluginResponse>().plugin;
      assert.equal(second.created_at, first.created_at);
      assert.ok(second.updated_at >= first.updated_at);
    });

    it('round-trips enabled: false, keeping the config and the association', async () => {
      await setPlugin('bot_detection', { config: { blocked_patterns: ['curl'] } });
      const attachedId = String(edgeConfig('bot_detection').id);

      const off = await setPlugin('bot_detection', {
        enabled: false,
        config: { blocked_patterns: ['curl'] },
      });
      assert.equal(off.statusCode, 200);
      assert.equal(off.json<SetApiPluginResponse>().plugin.enabled, false);

      const config = edgeConfig('bot_detection');
      assert.equal(config.id, attachedId, 'switching off is a replace, not a delete');
      assert.equal(config.enabled, false);
      assert.ok(
        associatedIds(harness, proxyId).includes(attachedId),
        'the association survives so the settings come back with one flag',
      );
      assert.equal(
        effectiveNames(harness, proxyId).includes('bot_detection'),
        false,
        'a disabled config is not effective',
      );

      // …and back on again, with the settings intact.
      const on = await setPlugin('bot_detection', {
        enabled: true,
        config: { blocked_patterns: ['curl'] },
      });
      assert.equal(on.statusCode, 200);
      assert.ok(effectiveNames(harness, proxyId).includes('bot_detection'));
      assert.deepEqual(edgeConfig('bot_detection').config, { blocked_patterns: ['curl'] });
    });

    it('detaches and deletes on DELETE', async () => {
      await setPlugin('compression', { config: {} });
      const attachedId = String(edgeConfig('compression').id);

      const response = await harness.authed(provider, {
        method: 'DELETE',
        url: `/api/apis/${apiId}/plugins/compression`,
      });
      assert.equal(response.statusCode, 200);

      assert.equal(harness.edge.pluginForProxy(proxyId, 'compression'), undefined);
      assert.equal(associatedIds(harness, proxyId).includes(attachedId), false);
      assert.deepEqual(effectiveNames(harness, proxyId), ['key_auth']);
      assert.equal(await harness.store.apiPlugins.find(apiId, 'compression'), null);
    });

    it('404s a DELETE for a plugin the API never had', async () => {
      const response = await harness.authed(provider, {
        method: 'DELETE',
        url: `/api/apis/${apiId}/plugins/compression`,
      });
      assert.equal(response.statusCode, 404);
    });

    it('lists what is configured, oldest first', async () => {
      await setPlugin('correlation_id', { config: {} });
      await setPlugin('request_size_limiting', { config: { max_bytes: 1_024 } });

      const response = await harness.authed(provider, {
        method: 'GET',
        url: `/api/apis/${apiId}/plugins`,
      });
      assert.equal(response.statusCode, 200);
      const { plugins } = response.json<ListApiPluginsResponse>();
      assert.deepEqual(
        plugins.map((plugin) => plugin.plugin_name),
        ['correlation_id', 'request_size_limiting'],
      );
      assert.deepEqual(plugins[1]?.config, { max_bytes: 1_024 });
      assert.equal(plugins[0]?.trigger, null);
    });
  });

  /* ── Triggers ──────────────────────────────────────────────────────────── */

  describe('execution triggers', () => {
    it('carries a method + path trigger as an `all` of two match leaves', async () => {
      const response = await setPlugin('request_termination', {
        config: { status_code: 503, message: 'Maintenance' },
        trigger: { methods: ['POST', 'PUT'], path_prefix: '/nexus/palette-1/invoices' },
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json<SetApiPluginResponse>().plugin.trigger, {
        methods: ['POST', 'PUT'],
        path_prefix: '/nexus/palette-1/invoices',
      });

      assert.deepEqual(edgeConfig('request_termination').trigger, {
        when: {
          all: [
            { match: { method: ['POST', 'PUT'] } },
            { match: { path: { prefix: ['/nexus/palette-1/invoices'] } } },
          ],
        },
      });
    });

    it('emits a bare match leaf when only one condition is set', async () => {
      await setPlugin('ip_restriction', {
        config: { allow: ['203.0.113.0/24'] },
        trigger: { methods: ['DELETE'] },
      });
      assert.deepEqual(edgeConfig('ip_restriction').trigger, {
        when: { match: { method: ['DELETE'] } },
      });
    });

    it('drops the trigger from the gateway config when it is cleared', async () => {
      await setPlugin('bot_detection', {
        config: { blocked_patterns: ['curl'] },
        trigger: { path_prefix: '/nexus/palette-1/admin' },
      });
      assert.ok(edgeConfig('bot_detection').trigger);

      await setPlugin('bot_detection', { config: { blocked_patterns: ['curl'] }, trigger: null });
      assert.equal(
        edgeConfig('bot_detection').trigger,
        undefined,
        'a whole-resource PUT removes a trigger by omitting the key',
      );
      assert.equal((await harness.store.apiPlugins.find(apiId, 'bot_detection'))?.trigger, null);
    });

    it('refuses a trigger on a plugin the gateway cannot gate', async () => {
      // `security_headers` owns the initial response-header policy, which is
      // re-asserted without a request context — Edge rejects the config
      // outright rather than half-apply it.
      const response = await setPlugin('security_headers', {
        config: { hsts: true },
        trigger: { methods: ['GET'] },
      });
      assert.equal(response.statusCode, 400);
      assert.equal(errorCode(response.body), 'VALIDATION_FAILED');
      assert.match(errorMessage(response.body), /does not accept an execution trigger/);
      assert.equal(harness.edge.pluginForProxy(proxyId, 'security_headers'), undefined);
    });

    it('rejects a path prefix the canonical path could never match', async () => {
      for (const prefix of ['invoices', '/api%2Fadmin', '/api/../admin', '/api\\admin']) {
        const response = await setPlugin('request_termination', {
          config: { status_code: 503 },
          trigger: { path_prefix: prefix },
        });
        assert.equal(response.statusCode, 400, `expected ${prefix} to be rejected`);
      }
      assert.equal(harness.edge.pluginForProxy(proxyId, 'request_termination'), undefined);
    });

    it('rejects an empty trigger', async () => {
      const response = await setPlugin('request_termination', {
        config: { status_code: 503 },
        trigger: {},
      });
      assert.equal(response.statusCode, 400);
    });
  });

  /* ── Validation ────────────────────────────────────────────────────────── */

  describe('validation', () => {
    it('rejects a key the plugin does not declare, before any gateway write', async () => {
      const response = await setPlugin('correlation_id', {
        config: { header_name: 'x-request-id', echoDownstream: true },
      });
      assert.equal(response.statusCode, 400);
      assert.equal(errorCode(response.body), 'VALIDATION_FAILED');
      assert.equal(harness.edge.pluginForProxy(proxyId, 'correlation_id'), undefined);
      assert.deepEqual(effectiveNames(harness, proxyId), ['key_auth']);
    });

    it('rejects an out-of-range integer', async () => {
      assert.equal(
        (await setPlugin('request_size_limiting', { config: { max_bytes: 0 } })).statusCode,
        400,
      );
      assert.equal(
        (await setPlugin('bot_detection', { config: { custom_response_code: 200 } })).statusCode,
        400,
      );
      assert.equal(
        (await setPlugin('response_caching', { config: { ttl_seconds: 999_999 } })).statusCode,
        400,
      );
    });

    it('rejects a required field that is missing', async () => {
      const response = await setPlugin('request_size_limiting', { config: {} });
      assert.equal(response.statusCode, 400);
      assert.equal(errorCode(response.body), 'VALIDATION_FAILED');
    });

    it('rejects an enum value outside the offered set', async () => {
      assert.equal(
        (await setPlugin('ip_restriction', { config: { allow: ['10.0.0.1'], mode: 'sideways' } }))
          .statusCode,
        400,
      );
      assert.equal(
        (await setPlugin('compression', { config: { algorithms: ['zstd'] } })).statusCode,
        400,
      );
      assert.equal(
        (await setPlugin('response_caching', { config: { cacheable_methods: ['POST'] } }))
          .statusCode,
        400,
      );
    });

    it('enforces ip_restriction’s "at least one list" rule', async () => {
      const response = await setPlugin('ip_restriction', {
        config: { allow: [], deny: [], mode: 'allow_first' },
      });
      assert.equal(response.statusCode, 400);
      assert.match(errorCode(response.body), /VALIDATION_FAILED/);
      assert.equal(harness.edge.pluginForProxy(proxyId, 'ip_restriction'), undefined);
    });

    it('enforces bot_detection’s no-op rule', async () => {
      assert.equal(
        (
          await setPlugin('bot_detection', {
            config: { blocked_patterns: [], allow_list: ['GoogleBot'] },
          })
        ).statusCode,
        400,
      );
      // The same empty list is fine once missing-UA requests are rejected.
      assert.equal(
        (
          await setPlugin('bot_detection', {
            config: { blocked_patterns: [], allow_missing_user_agent: false },
          })
        ).statusCode,
        200,
      );
    });

    it('refuses a correlation header the gateway owns', async () => {
      const response = await setPlugin('correlation_id', {
        config: { header_name: 'Authorization' },
      });
      assert.equal(response.statusCode, 400);
      assert.match(errorMessage(response.body), /Correlation ID configuration is not valid/i);
    });

    it('validates the body even when the plugin is being saved switched off', async () => {
      // Edge does not construct a disabled plugin strictly, so a bad config
      // would be stored and only fail the day it is switched back on.
      const response = await setPlugin('request_size_limiting', {
        enabled: false,
        config: { max_bytes: -1 },
      });
      assert.equal(response.statusCode, 400);
    });

    it('404s an Edge plugin that is not in the palette', async () => {
      const response = await setPlugin('kafka_logging', { config: {} });
      assert.equal(response.statusCode, 404);
      assert.equal(errorCode(response.body), 'NOT_FOUND');
    });

    it('400s a plugin Nexus manages from a first-class field, naming the field', async () => {
      for (const [name, field] of [
        ['key_auth', 'auth_plugin'],
        ['rate_limiting', 'rate_limit'],
        ['cors', 'cors'],
        ['openapi_validator', 'spec_enforcement'],
      ] as const) {
        const response = await setPlugin(name, { config: {} });
        assert.equal(response.statusCode, 400, `${name} should be a 400, not a 404`);
        assert.match(errorMessage(response.body), new RegExp(field));
      }
    });
  });

  /* ── Authorization ─────────────────────────────────────────────────────── */

  describe('authorization', () => {
    it('lets an admin configure another provider’s API', async () => {
      assert.equal((await setPlugin('correlation_id', { config: {} }, admin)).statusCode, 200);
    });

    it('refuses another provider', async () => {
      const response = await setPlugin('correlation_id', { config: {} }, otherProvider);
      assert.equal(response.statusCode, 403);
      assert.equal(errorCode(response.body), 'FORBIDDEN');
      assert.equal(harness.edge.pluginForProxy(proxyId, 'correlation_id'), undefined);
    });

    it('refuses another provider on the read and the delete too', async () => {
      await setPlugin('correlation_id', { config: {} });
      assert.equal(
        (
          await harness.authed(otherProvider, {
            method: 'GET',
            url: `/api/apis/${apiId}/plugins`,
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await harness.authed(otherProvider, {
            method: 'DELETE',
            url: `/api/apis/${apiId}/plugins/correlation_id`,
          })
        ).statusCode,
        403,
      );
      assert.ok(effectiveNames(harness, proxyId).includes('correlation_id'));
    });
  });

  /* ── Compensation and teardown ─────────────────────────────────────────── */

  describe('compensation', () => {
    it('undoes the gateway write when the store row cannot be saved', async () => {
      failNextUpsert(harness, 'database unavailable');
      const response = await setPlugin('request_termination', { config: { status_code: 503 } });
      assert.equal(response.statusCode, 500);

      assert.equal(
        harness.edge.pluginForProxy(proxyId, 'request_termination'),
        undefined,
        'a plugin the portal has no row for must not stay live — this one answers 503',
      );
      assert.deepEqual(effectiveNames(harness, proxyId), ['key_auth']);
      assert.equal(await harness.store.apiPlugins.find(apiId, 'request_termination'), null);
    });

    it('puts the previous config back when a replace cannot be saved', async () => {
      await setPlugin('response_caching', { config: { ttl_seconds: 60 } });
      const attachedId = String(edgeConfig('response_caching').id);

      failNextUpsert(harness, 'database unavailable');
      const response = await setPlugin('response_caching', { config: { ttl_seconds: 3_600 } });
      assert.equal(response.statusCode, 500);

      const config = edgeConfig('response_caching');
      assert.equal(config.id, attachedId);
      assert.deepEqual(config.config, { ttl_seconds: 60 }, 'the previous settings were restored');
      assert.ok(effectiveNames(harness, proxyId).includes('response_caching'));
    });

    it('removes every palette row when the API is deleted', async () => {
      await setPlugin('correlation_id', { config: {} });
      await setPlugin('compression', { config: {} });
      assert.equal((await harness.store.apiPlugins.listByApi(apiId)).length, 2);

      const response = await harness.authed(provider, {
        method: 'DELETE',
        url: `/api/apis/${apiId}`,
      });
      assert.equal(response.statusCode, 200);

      assert.deepEqual(await harness.store.apiPlugins.listByApi(apiId), []);
      // Deleting the proxy cascades its proxy-scoped configs on the gateway.
      assert.deepEqual(harness.edge.pluginsForProxy(proxyId), []);
    });
  });

  /* ── Audit ─────────────────────────────────────────────────────────────── */

  describe('audit', () => {
    it('records a set with the config keys but never their values', async () => {
      await setPlugin('ip_restriction', {
        config: { allow: ['203.0.113.9'] },
        trigger: { methods: ['POST'] },
      });
      const [row] = await harness.auditRows('api.plugin_set');
      assert.ok(row);
      assert.equal(row.target_id, apiId);
      const details = row.details as Record<string, unknown>;
      assert.equal(details.plugin_name, 'ip_restriction');
      assert.equal(details.enabled, true);
      assert.deepEqual(details.config_keys, ['allow']);
      assert.deepEqual(details.trigger, { methods: ['POST'] });
      assert.equal(details.replaced, false);
      assert.equal(
        JSON.stringify(details).includes('203.0.113.9'),
        false,
        'an allow-list is not audit-log material',
      );
    });

    it('records a removal', async () => {
      await setPlugin('compression', { config: {} });
      await harness.authed(provider, {
        method: 'DELETE',
        url: `/api/apis/${apiId}/plugins/compression`,
      });
      const [row] = await harness.auditRows('api.plugin_remove');
      assert.ok(row);
      assert.deepEqual(row.details, {
        plugin_name: 'compression',
        label: 'Response compression',
        was_attached: true,
      });
    });
  });

  /* ── The catalog itself ────────────────────────────────────────────────── */

  describe('the descriptor catalog', () => {
    it('every descriptor can be saved with only its defaults', async () => {
      // `ip_restriction` deliberately ships no default list: an allow/deny pair
      // that restricts nobody is a config Edge refuses, so the provider has to
      // name at least one address. Everything else is complete as it stands.
      const REQUIRED_CHOICES: Readonly<Record<string, Record<string, unknown>>> = {
        ip_restriction: { allow: ['203.0.113.0/24'] },
      };

      for (const descriptor of PROVIDER_PLUGINS) {
        const config: Record<string, unknown> = {};
        for (const field of descriptor.fields) {
          if ('default' in field && field.default !== undefined) {
            config[field.key] = field.default;
          }
        }
        Object.assign(config, REQUIRED_CHOICES[descriptor.name] ?? {});
        const response = await setPlugin(descriptor.name, { config });
        assert.equal(
          response.statusCode,
          200,
          `${descriptor.name} rejected its own defaults: ${response.body}`,
        );
      }
      assert.deepEqual(
        effectiveNames(harness, proxyId),
        ['key_auth', ...PROVIDER_PLUGINS.map((plugin) => plugin.name)].sort(),
      );
    });

    it('never names a plugin Nexus already manages from a first-class field', () => {
      // An overlap would give a provider two contradictory controls for the
      // same gateway object — the palette form and, say, the rate-limit field.
      for (const descriptor of PROVIDER_PLUGINS) {
        assert.equal(
          isFirstClassPlugin(descriptor.name),
          false,
          `${descriptor.name} is both a palette entry and a first-class field`,
        );
      }
      const names = PROVIDER_PLUGINS.map((plugin) => plugin.name);
      assert.equal(new Set(names).size, names.length, 'a plugin appears twice in the palette');
    });
  });
});
