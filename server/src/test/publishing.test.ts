import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import type { LightMyRequestResponse } from 'fastify';

import {
  aclGroupForApi,
  type ApiErrorBody,
  type CatalogListResponse,
  type CreateTestConsumerResponse,
  type GetApiResponse,
  type ListApisResponse,
  type PublishApiResponse,
  type UpdateApiResponse,
  type UpdateApiSpecResponse,
} from '@ferrum-nexus/shared';

import {
  SAMPLE_SPEC_JSON,
  SAMPLE_SPEC_YAML,
  buildTestApp,
  fakeUpstreamResolver,
  specWithServer,
  type TestApp,
  type TestSession,
} from './helpers.js';

function errorCode(body: string): string {
  return (JSON.parse(body) as ApiErrorBody).error.code;
}

/**
 * Make the next `store.transaction(...)` reject, then put the real one back.
 *
 * Stands in for a database outage at the one seam that matters: by the time
 * publishing persists its rows the Edge objects are already live, so this is
 * what the compensation has to cover.
 */
function failNextTransaction(harness: TestApp, message: string): void {
  const real = harness.store.transaction.bind(harness.store);
  harness.store.transaction = async <T>(): Promise<T> => {
    harness.store.transaction = real;
    throw new Error(message);
  };
}

/** Make the next `store.apis.update(...)` reject, then put the real one back. */
function failNextApiUpdate(harness: TestApp, message: string): void {
  const real = harness.store.apis.update.bind(harness.store.apis);
  harness.store.apis.update = async () => {
    harness.store.apis.update = real;
    throw new Error(message);
  };
}

/**
 * The plugin names Edge would actually run for a proxy, sorted.
 *
 * This is the assertion that matters for issue #13: a proxy-scoped config with
 * the right `proxy_id` is inert until the proxy's own `plugins[]` names it, so
 * "the config exists" and "the gateway enforces it" are different claims.
 */
function effectiveNames(harness: TestApp, proxyId: string): string[] {
  return harness.edge
    .effectivePluginsForProxy(proxyId)
    .map((plugin) => String(plugin.plugin_name))
    .sort();
}

/** Plugin config ids in the proxy's association list, sorted. */
function associatedIds(harness: TestApp, proxyId: string): string[] {
  const proxy = harness.edge.proxies.get(`nexus/${proxyId}`);
  const plugins = Array.isArray(proxy?.plugins) ? proxy.plugins : [];
  return plugins
    .map((entry) => String((entry as { plugin_config_id: unknown }).plugin_config_id))
    .sort();
}

/** The proxy document the mock currently stores. */
function storedProxy(harness: TestApp, proxyId: string): Record<string, unknown> {
  const proxy = harness.edge.proxies.get(`nexus/${proxyId}`);
  assert.ok(proxy, `expected proxy ${proxyId} to exist`);
  return proxy;
}

/** Ids of every plugin config written for the proxy, sorted. */
function writtenIds(harness: TestApp, proxyId: string): string[] {
  return harness.edge
    .pluginsForProxy(proxyId)
    .map((plugin) => String(plugin.id))
    .sort();
}

/**
 * Put the fields an operator would set by hand onto the stored proxy.
 *
 * None of them are in Nexus's write shape, so they only survive if every proxy
 * write is a read-modify-write of the whole document.
 */
function enrichProxy(harness: TestApp, proxyId: string): void {
  const proxy = harness.edge.proxies.get(`nexus/${proxyId}`);
  assert.ok(proxy, 'expected the proxy to exist before enriching it');
  proxy.hosts = ['api.example.com', '*.partner.example.com'];
  proxy.backend_read_timeout_ms = 45_000;
  proxy.backend_tls_verify_server_cert = false;
  proxy.preserve_host_header = true;
}

/** Assert `enrichProxy`'s fields are still on the stored proxy. */
function assertEnrichmentSurvived(harness: TestApp, proxyId: string): void {
  const proxy = harness.edge.proxies.get(`nexus/${proxyId}`);
  assert.ok(proxy);
  assert.deepEqual(proxy.hosts, ['api.example.com', '*.partner.example.com']);
  assert.equal(proxy.backend_read_timeout_ms, 45_000);
  assert.equal(proxy.backend_tls_verify_server_cert, false);
  assert.equal(proxy.preserve_host_header, true);
}

/** Body of `POST /api/apis` with sensible defaults. */
function publishPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Billing API',
    slug: 'billing',
    version: '2.4.0',
    spec: SAMPLE_SPEC_YAML,
    auth_plugin: 'key_auth',
    requestable: true,
    visibility: 'public',
    ...overrides,
  };
}

describe('publishing', () => {
  let harness: TestApp;
  let founder: TestSession;
  let provider: TestSession;
  let otherProvider: TestSession;
  let client: TestSession;

  before(async () => {
    harness = await buildTestApp();
    founder = await harness.registerUser({ email: 'founder@example.test' });
    provider = await harness.registerUser({ email: 'pub-provider@example.test', role: 'provider' });
    otherProvider = await harness.registerUser({
      email: 'pub-other@example.test',
      role: 'provider',
    });
    client = await harness.registerUser({ email: 'pub-client@example.test', role: 'client' });
  });

  after(async () => {
    await harness.close();
  });

  describe('publish', () => {
    beforeEach(() => {
      harness.edge.reset();
    });

    it('creates the proxy and every plugin with the exact Edge bodies', async () => {
      const response = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({
          slug: 'billing-exact',
          rate_limit: { limit: 120, window_seconds: 60 },
        }),
      });
      assert.equal(response.statusCode, 201);
      const body = response.json<PublishApiResponse>();

      assert.equal(body.api.slug, 'billing-exact');
      assert.equal(body.api.status, 'published');
      assert.equal(body.api.namespace, 'nexus');
      assert.equal(body.spec.parsed_title, 'Billing API');
      assert.equal(body.spec.parsed_version, '2.4.0');
      assert.equal(body.spec.is_current, true);

      // ── The proxy ───────────────────────────────────────────────────────
      const proxy = harness.edge.proxyByName('nexus-billing-exact');
      assert.ok(proxy, 'expected a proxy named nexus-billing-exact');
      assert.equal(proxy.listen_path, '/nexus/billing-exact');
      assert.equal(proxy.backend_scheme, 'https');
      assert.equal(proxy.backend_host, 'billing.example.com');
      assert.equal(proxy.backend_port, 8443);
      assert.equal(proxy.backend_path, '/v2');
      assert.equal(proxy.strip_listen_path, true);
      assert.equal(body.api.ferrum_proxy_id, proxy.id);

      const proxyId = String(proxy.id);
      const plugins = harness.edge.pluginsForProxy(proxyId);
      assert.equal(plugins.length, 3);

      // ── key_auth: `{}` takes Edge's documented defaults ──────────────────
      const auth = harness.edge.pluginForProxy(proxyId, 'key_auth');
      assert.ok(auth);
      assert.equal(auth.scope, 'proxy');
      assert.equal(auth.enabled, true);
      assert.deepEqual(auth.config, {});

      // ── access_control: groups, never usernames ─────────────────────────
      const acl = harness.edge.pluginForProxy(proxyId, 'access_control');
      assert.ok(acl);
      assert.deepEqual(acl.config, { allowed_groups: [aclGroupForApi(body.api.id)] });

      // ── rate_limiting: the custom window pair, per consumer ─────────────
      const limiter = harness.edge.pluginForProxy(proxyId, 'rate_limiting');
      assert.ok(limiter);
      assert.deepEqual(limiter.config, {
        limit_by: 'consumer',
        expose_headers: true,
        limits: [{ scope: 'default', window_seconds: 60, max_requests: 120 }],
      });

      // ── …and every one of them associated, or none of them would run ────
      assert.deepEqual(effectiveNames(harness, proxyId), [
        'access_control',
        'key_auth',
        'rate_limiting',
      ]);
      assert.deepEqual(associatedIds(harness, proxyId), writtenIds(harness, proxyId));

      // Every call carried the namespace header and an admin-role JWT.
      const writes = harness.edge.callsTo('POST', '/proxies');
      assert.equal(writes[0]?.namespace, 'nexus');
      assert.equal(writes[0]?.claims?.role, 'admin');
      // …and the proxy was *created* on a staging path, not this one. The
      // deterministic path is taken by the last write of the publish, once
      // every plugin above is associated — see the staged-cutover suite.
      assert.match(
        String((writes[0]?.body as Record<string, unknown>).listen_path),
        /^\/nexus\/\.staging\/[0-9a-f]{32}$/,
      );

      const audit = await harness.auditRows('api.publish');
      const row = audit.find((entry) => entry.target_id === body.api.id);
      assert.ok(row);
      assert.equal(row.details.listen_path, '/nexus/billing-exact');
      assert.equal(row.details.spec_paths, 2);
    });

    it('sends basic_auth an empty config, which is the only shape Edge accepts', async () => {
      const response = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({ slug: 'basic-api', auth_plugin: 'basic_auth' }),
      });
      assert.equal(response.statusCode, 201);
      const proxyId = String(harness.edge.proxyByName('nexus-basic-api')?.id);
      const plugin = harness.edge.pluginForProxy(proxyId, 'basic_auth');
      assert.ok(plugin);
      assert.deepEqual(plugin.config, {});
    });

    it('omits access_control entirely when the API is not requestable', async () => {
      const response = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({ slug: 'open-api', requestable: false }),
      });
      assert.equal(response.statusCode, 201);
      const proxyId = String(harness.edge.proxyByName('nexus-open-api')?.id);
      assert.equal(harness.edge.pluginForProxy(proxyId, 'access_control'), undefined);
      assert.equal(harness.edge.pluginsForProxy(proxyId).length, 1);
      assert.deepEqual(effectiveNames(harness, proxyId), ['key_auth']);
    });

    it('attaches a cors plugin carrying exactly the two keys Edge needs', async () => {
      const response = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({
          slug: 'cors-plugin',
          cors: {
            allowed_origins: ['https://app.example.com', 'https://admin.example.com'],
            allow_credentials: true,
          },
        }),
      });
      assert.equal(response.statusCode, 201, response.body);
      const proxyId = String(response.json<PublishApiResponse>().api.ferrum_proxy_id);

      const cors = harness.edge.pluginForProxy(proxyId, 'cors');
      assert.ok(cors, 'expected a cors plugin config on the proxy');
      assert.equal(cors.scope, 'proxy');
      assert.equal(cors.enabled, true);
      // Nothing beyond the two keys the portal models: every other `cors`
      // field has a native default a provider cannot change from here.
      assert.deepEqual(cors.config, {
        allowed_origins: ['https://app.example.com', 'https://admin.example.com'],
        allow_credentials: true,
      });

      assert.deepEqual(effectiveNames(harness, proxyId), ['access_control', 'cors', 'key_auth']);
      assert.deepEqual(associatedIds(harness, proxyId), writtenIds(harness, proxyId));

      const row = (await harness.auditRows('api.publish')).find(
        (entry) => entry.target_id === response.json<PublishApiResponse>().api.id,
      );
      assert.deepEqual(row?.details.cors, {
        allowed_origins: ['https://app.example.com', 'https://admin.example.com'],
        allow_credentials: true,
      });
    });

    it('writes the method allow-list, the timeouts and the circuit breaker onto the proxy', async () => {
      const response = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({
          slug: 'proxy-settings',
          allowed_methods: ['GET', 'POST', 'GET'],
          timeouts: { connect_ms: 1_500, read_ms: 20_000, write_ms: 25_000 },
          circuit_breaker: true,
        }),
      });
      assert.equal(response.statusCode, 201, response.body);
      const api = response.json<PublishApiResponse>().api;

      // The row keeps the provider's list, deduplicated by the route.
      assert.deepEqual(api.allowed_methods, ['GET', 'POST']);
      assert.deepEqual(api.timeouts, { connect_ms: 1_500, read_ms: 20_000, write_ms: 25_000 });
      assert.equal(api.circuit_breaker, true);

      const proxy = storedProxy(harness, String(api.ferrum_proxy_id));
      assert.deepEqual(proxy.allowed_methods, ['GET', 'POST']);
      assert.equal(proxy.backend_connect_timeout_ms, 1_500);
      assert.equal(proxy.backend_read_timeout_ms, 20_000);
      assert.equal(proxy.backend_write_timeout_ms, 25_000);
      assert.deepEqual(proxy.circuit_breaker, {
        failure_threshold: 5,
        success_threshold: 3,
        timeout_seconds: 30,
        failure_status_codes: [500, 502, 503, 504],
        half_open_max_requests: 1,
        trip_on_connection_errors: true,
      });
      // No CORS policy, so the WS origin check stays off.
      assert.deepEqual(proxy.allowed_ws_origins, []);

      const row = (await harness.auditRows('api.publish')).find(
        (entry) => entry.target_id === api.id,
      );
      assert.deepEqual(row?.details.allowed_methods, ['GET', 'POST']);
      assert.equal(row?.details.circuit_breaker, true);
    });

    it('leaves the proxy on the gateway defaults when no advanced settings are sent', async () => {
      const response = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({ slug: 'proxy-defaults' }),
      });
      assert.equal(response.statusCode, 201);
      const api = response.json<PublishApiResponse>().api;
      assert.equal(api.allowed_methods, null);
      assert.equal(api.timeouts, null);
      assert.equal(api.circuit_breaker, false);

      // Absent, not written: an omitted key on `POST /proxies` takes Edge's
      // serde default, and pinning a default the portal cannot express would
      // stop a gateway upgrade from changing it.
      const proxy = storedProxy(harness, String(api.ferrum_proxy_id));
      assert.equal(proxy.allowed_methods, undefined);
      assert.equal(proxy.backend_connect_timeout_ms, undefined);
      assert.equal(proxy.backend_read_timeout_ms, undefined);
      assert.equal(proxy.backend_write_timeout_ms, undefined);
      assert.equal(proxy.circuit_breaker, undefined);
    });

    it('adds OPTIONS to the gateway list when a CORS policy is set, but not to the row', async () => {
      const response = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({
          slug: 'preflight',
          allowed_methods: ['GET', 'POST'],
          cors: { allowed_origins: ['https://app.example.com'], allow_credentials: false },
        }),
      });
      assert.equal(response.statusCode, 201, response.body);
      const api = response.json<PublishApiResponse>().api;

      // Without this the browser preflight would be 405ed before the cors
      // plugin ever ran, and the policy would be dead on arrival.
      assert.deepEqual(storedProxy(harness, String(api.ferrum_proxy_id)).allowed_methods, [
        'GET',
        'POST',
        'OPTIONS',
      ]);
      assert.deepEqual(api.allowed_methods, ['GET', 'POST'], 'the row keeps the provider’s list');
    });

    it('mirrors exact CORS origins into allowed_ws_origins', async () => {
      const response = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({
          slug: 'ws-origins',
          cors: {
            allowed_origins: ['https://app.example.com', 'https://admin.example.com:8443'],
            allow_credentials: true,
          },
        }),
      });
      assert.equal(response.statusCode, 201, response.body);
      const proxyId = String(response.json<PublishApiResponse>().api.ferrum_proxy_id);
      assert.deepEqual(storedProxy(harness, proxyId).allowed_ws_origins, [
        'https://app.example.com',
        'https://admin.example.com:8443',
      ]);
    });

    it('leaves the WS origin check off for a wildcard CORS policy', async () => {
      // `*` is not an origin the upgrade check could compare against, and an
      // API open to every browser origin gains nothing from a partial list.
      const response = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({
          slug: 'ws-wildcard',
          cors: { allowed_origins: ['*'], allow_credentials: false },
        }),
      });
      assert.equal(response.statusCode, 201, response.body);
      const proxyId = String(response.json<PublishApiResponse>().api.ferrum_proxy_id);
      assert.deepEqual(storedProxy(harness, proxyId).allowed_ws_origins, []);
    });

    it('rejects a method outside Edge’s enum and an out-of-range timeout', async () => {
      const bodies = [
        { allowed_methods: ['GET', 'FETCH'] },
        { allowed_methods: [] },
        { timeouts: { connect_ms: 1, read_ms: 1_000, write_ms: 1_000 } },
        { timeouts: { connect_ms: 1_000, read_ms: 1_000 } },
        { timeouts: { connect_ms: 1_000, read_ms: 400_000, write_ms: 1_000 } },
      ];
      for (const [index, overrides] of bodies.entries()) {
        const response = await harness.authed(provider, {
          method: 'POST',
          url: '/api/apis',
          payload: publishPayload({ slug: `bad-settings-${index}`, ...overrides }),
        });
        assert.equal(response.statusCode, 400, JSON.stringify(overrides));
        assert.equal(errorCode(response.body), 'VALIDATION_FAILED');
      }
    });

    it('records a null cors policy in the audit row when none was asked for', async () => {
      const response = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({ slug: 'cors-audit-absent' }),
      });
      assert.equal(response.statusCode, 201);
      const apiId = response.json<PublishApiResponse>().api.id;
      const proxyId = String(response.json<PublishApiResponse>().api.ferrum_proxy_id);

      assert.equal(harness.edge.pluginForProxy(proxyId, 'cors'), undefined);
      const row = (await harness.auditRows('api.publish')).find(
        (entry) => entry.target_id === apiId,
      );
      assert.equal(row?.details.cors, null);
    });

    it('leaves no association behind when the publish is rolled back', async () => {
      // The association write is the last gateway call of a publish, so a store
      // failure after it is the case that would strand one.
      failNextTransaction(harness, 'database is gone');
      const response = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({
          slug: 'assoc-rollback',
          rate_limit: { limit: 5, window_seconds: 60 },
          cors: { allowed_origins: ['https://app.example.com'], allow_credentials: false },
        }),
      });
      assert.notEqual(response.statusCode, 201);

      assert.equal(harness.edge.proxyByName('nexus-assoc-rollback'), undefined);
      assert.equal(harness.edge.pluginConfigs.size, 0);
    });

    it('takes the upstream from the document when the provider supplies none', async () => {
      const response = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({ slug: 'from-spec', spec: SAMPLE_SPEC_JSON }),
      });
      assert.equal(response.statusCode, 201);
      const proxy = harness.edge.proxyByName('nexus-from-spec');
      assert.equal(proxy?.backend_host, 'shipping.example.com');
      assert.equal(proxy?.backend_port, 443);
    });

    it('prefers an explicit upstream_url over the document', async () => {
      const response = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({
          slug: 'explicit-upstream',
          upstream_url: 'http://override.example.com:8080',
        }),
      });
      assert.equal(response.statusCode, 201);
      const proxy = harness.edge.proxyByName('nexus-explicit-upstream');
      assert.equal(proxy?.backend_host, 'override.example.com');
      assert.equal(proxy?.backend_port, 8080);
      assert.equal(proxy?.backend_scheme, 'http');
    });

    it('refuses a document with no absolute server and no upstream_url', async () => {
      const response = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({ slug: 'no-upstream', spec: specWithServer('/v1') }),
      });
      assert.equal(response.statusCode, 400);
      assert.equal(errorCode(response.body), 'SPEC_INVALID');
      assert.equal(harness.edge.proxyByName('nexus-no-upstream'), undefined);
    });

    it('rolls the proxy back when a plugin config is rejected', async () => {
      // The auth plugin is created immediately after the proxy; failing it
      // leaves the proxy as the only thing to undo.
      harness.edge.queueFailure(400, { error: 'key_auth: bad config' }, '/plugins/config');
      const response = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({ slug: 'rollback-me' }),
      });
      assert.equal(response.statusCode, 502);
      assert.equal(errorCode(response.body), 'EDGE_ERROR');

      assert.equal(
        harness.edge.proxyByName('nexus-rollback-me'),
        undefined,
        'the proxy created before the failing plugin must be deleted again',
      );
      assert.ok(harness.edge.callsTo('DELETE', '/proxies/').length >= 1);

      // Nothing was written on the Nexus side either, so the slug is free.
      const retry = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({ slug: 'rollback-me' }),
      });
      assert.equal(retry.statusCode, 201);
    });

    it('deletes the Edge objects when the Nexus rows cannot be written', async () => {
      // The rollback used to end before persistence began, so a store failure
      // here left a live proxy nothing in the portal knew about.
      failNextTransaction(harness, 'database is gone');

      const response = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({
          slug: 'orphan-guard',
          rate_limit: { limit: 5, window_seconds: 60 },
        }),
      });
      assert.notEqual(response.statusCode, 201);

      assert.equal(
        harness.edge.proxyByName('nexus-orphan-guard'),
        undefined,
        'no live, untracked proxy may survive a failed publish',
      );
      assert.equal(harness.edge.pluginConfigs.size, 0, 'its plugin configs go with it');
      assert.equal(await harness.store.apis.findBySlug('orphan-guard'), null);

      // Both sides are clean, so republishing the same slug just works.
      const retry = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({ slug: 'orphan-guard' }),
      });
      assert.equal(retry.statusCode, 201);
    });

    it('rejects a slug that is already taken', async () => {
      await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({ slug: 'duplicate-slug' }),
      });
      const response = await harness.authed(otherProvider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({ name: 'Another', slug: 'duplicate-slug' }),
      });
      assert.equal(response.statusCode, 409);
      assert.equal(errorCode(response.body), 'CONFLICT');
    });

    it('derives a slug from the name when none is given', async () => {
      const response = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: { ...publishPayload(), name: 'Payments Gateway v3', slug: undefined },
      });
      assert.equal(response.statusCode, 201);
      assert.equal(response.json<PublishApiResponse>().api.slug, 'payments-gateway-v3');
    });

    it('refuses a private, loopback or internal upstream by default', async () => {
      for (const upstream_url of [
        'http://169.254.169.254/latest/meta-data',
        'http://10.20.30.40:5432',
        'http://host.docker.internal:8081',
        'http://[::1]:9000',
      ]) {
        const response = await harness.authed(provider, {
          method: 'POST',
          url: '/api/apis',
          payload: publishPayload({ slug: 'ssrf', upstream_url }),
        });
        assert.equal(response.statusCode, 400, upstream_url);
        const body = response.json<ApiErrorBody>();
        assert.equal(body.error.code, 'SPEC_INVALID');
        assert.equal(
          (body.error.details as { reason?: string }).reason,
          'private_upstream',
          upstream_url,
        );
      }
      assert.equal(harness.edge.proxies.size, 0, 'nothing reached the gateway');
      assert.equal(await harness.store.apis.findBySlug('ssrf'), null);
    });

    it('applies the same policy to the document’s servers[0]', async () => {
      const response = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({
          slug: 'ssrf-spec',
          spec: specWithServer('http://192.168.1.10:8080'),
        }),
      });
      assert.equal(response.statusCode, 400);
      assert.equal(errorCode(response.body), 'SPEC_INVALID');
      assert.equal(harness.edge.proxies.size, 0);
    });

    it('publishes to a private upstream when the deployment allows it', async () => {
      const permissive = await buildTestApp({ env: { NEXUS_ALLOW_PRIVATE_UPSTREAMS: 'true' } });
      try {
        const owner = await permissive.registerUser({ email: 'lan-provider@example.test' });
        const response = await permissive.authed(owner, {
          method: 'POST',
          url: '/api/apis',
          payload: publishPayload({
            slug: 'lan',
            upstream_url: 'http://host.docker.internal:8081',
          }),
        });
        assert.equal(response.statusCode, 201, response.body);
        assert.equal(
          permissive.edge.proxyByName('nexus-lan')?.backend_host,
          'host.docker.internal',
        );
      } finally {
        await permissive.close();
      }
    });

    it("records the normalized upstream taken from the document's servers[0]", async () => {
      const response = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({ slug: 'upstream-from-spec' }),
      });
      assert.equal(response.statusCode, 201);
      // The sample document's server is `https://billing.example.com:8443/v2`.
      assert.equal(
        response.json<PublishApiResponse>().api.upstream_url,
        'https://billing.example.com:8443/v2',
      );
    });

    it('records an explicit upstream_url in preference to the document', async () => {
      const response = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({
          slug: 'upstream-explicit',
          upstream_url: 'http://override.example.com:8080/base',
        }),
      });
      assert.equal(response.statusCode, 201);
      assert.equal(
        response.json<PublishApiResponse>().api.upstream_url,
        'http://override.example.com:8080/base',
      );
    });

    it('round-trips a CORS policy on the published API', async () => {
      const response = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({
          slug: 'cors-published',
          cors: { allowed_origins: ['https://app.example.com'], allow_credentials: true },
        }),
      });
      assert.equal(response.statusCode, 201);
      assert.deepEqual(response.json<PublishApiResponse>().api.cors, {
        allowed_origins: ['https://app.example.com'],
        allow_credentials: true,
      });
    });

    it('defaults allow_credentials to false, and omitting cors means no policy', async () => {
      const withDefault = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({
          slug: 'cors-default',
          cors: { allowed_origins: ['https://app.example.com'] },
        }),
      });
      assert.equal(withDefault.statusCode, 201);
      assert.equal(withDefault.json<PublishApiResponse>().api.cors?.allow_credentials, false);

      const without = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({ slug: 'cors-absent' }),
      });
      assert.equal(without.statusCode, 201);
      assert.equal(without.json<PublishApiResponse>().api.cors, null);
    });

    it('rejects a CORS policy that is empty, oversized or not a list of origins', async () => {
      const bodies = [
        { allowed_origins: [], allow_credentials: false },
        {
          allowed_origins: Array.from(
            { length: 65 },
            (_, index) => `https://o${index}.example.com`,
          ),
          allow_credentials: false,
        },
        { allowed_origins: ['https://app.example.com', 42], allow_credentials: false },
        { allowed_origins: ['https://a.example.com https://b.example.com'] },
      ];
      for (const [index, cors] of bodies.entries()) {
        const response = await harness.authed(provider, {
          method: 'POST',
          url: '/api/apis',
          payload: publishPayload({ slug: `cors-invalid-${index}`, cors }),
        });
        assert.equal(response.statusCode, 400, `body ${index} should not have been accepted`);
        assert.equal(errorCode(response.body), 'VALIDATION_FAILED');
      }
    });

    it("refuses a rate limit above Edge's ceiling instead of letting the gateway 400", async () => {
      const tooMany = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({
          slug: 'limit-too-high',
          rate_limit: { limit: 1_000_001, window_seconds: 60 },
        }),
      });
      assert.equal(tooMany.statusCode, 400);
      assert.equal(errorCode(tooMany.body), 'VALIDATION_FAILED');

      const atCeiling = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({
          slug: 'limit-at-ceiling',
          rate_limit: { limit: 1_000_000, window_seconds: 60 },
        }),
      });
      assert.equal(atCeiling.statusCode, 201);
      assert.equal(atCeiling.json<PublishApiResponse>().api.rate_limit?.limit, 1_000_000);
    });

    it('keeps clients out of the publishing routes entirely', async () => {
      const response = await harness.authed(client, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({ slug: 'client-cannot' }),
      });
      assert.equal(response.statusCode, 403);
      assert.equal(errorCode(response.body), 'FORBIDDEN');
    });

    it('hands the provider the gateway’s reason for a validation refusal', async () => {
      // Publishing a basic_auth API against a gateway with no
      // FERRUM_BASIC_AUTH_HMAC_SECRET is the canonical case: the provider can
      // do nothing about it until they can read why the plugin was refused.
      const gatewayText =
        'FERRUM_BASIC_AUTH_HMAC_SECRET must be set to accept basic_auth credentials';
      harness.edge.queueFailure(400, { error: gatewayText }, '/plugins/config', 'POST');

      const response = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({ slug: 'basic-auth-refused', auth_plugin: 'basic_auth' }),
      });
      assert.equal(response.statusCode, 502);

      const body = JSON.parse(response.body) as ApiErrorBody;
      assert.equal(body.error.code, 'EDGE_ERROR');
      assert.match(body.error.message, /FERRUM_BASIC_AUTH_HMAC_SECRET/);
      const details = body.error.details as { status: number; gateway_message: string };
      assert.equal(details.status, 400);
      assert.equal(details.gateway_message, gatewayText);

      // The proxy created before the failing plugin is still rolled back.
      assert.equal(harness.edge.proxyByName('nexus-basic-auth-refused'), undefined);
    });

    it('finds this API’s plugins on a gateway holding more than one page of them', async () => {
      // `GET /plugins/config` has no proxy_id filter and Edge clamps `limit` to
      // 1000, so a single-page read silently truncated on any busy gateway.
      const noiseProxyId = 'pagination-noise-proxy';
      harness.edge.proxies.set(`nexus/${noiseProxyId}`, {
        id: noiseProxyId,
        namespace: 'nexus',
        listen_path: '/nexus/pagination-noise',
        backend_host: 'noise.internal',
        backend_port: 443,
      });
      for (let index = 0; index < 1_200; index += 1) {
        const id = `noise-${index}`;
        harness.edge.pluginConfigs.set(`nexus/${id}`, {
          id,
          namespace: 'nexus',
          plugin_name: 'key_auth',
          scope: 'proxy',
          proxy_id: noiseProxyId,
          enabled: true,
          config: {},
        });
      }

      const response = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({ slug: 'paginated' }),
      });
      assert.equal(response.statusCode, 201);
      const proxyId = response.json<PublishApiResponse>().api.ferrum_proxy_id;
      assert.ok(proxyId);

      const attached = await harness.edgeClient.pluginConfigs.listByProxy(proxyId);
      assert.deepEqual(
        attached.map((config) => config.plugin_name).sort(),
        ['access_control', 'key_auth'],
        'the scan must page past the 1000-row clamp instead of truncating',
      );
      assert.equal(
        (await harness.edgeClient.pluginConfigs.listByProxy(noiseProxyId)).length,
        1_200,
        'every page of the noisy proxy’s configs is visited too',
      );
    });
  });

  describe('update', () => {
    let apiId: string;
    let proxyId: string;

    beforeEach(async () => {
      harness.edge.reset();
      const response = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({
          slug: `upd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        }),
      });
      assert.equal(response.statusCode, 201);
      const body = response.json<PublishApiResponse>();
      apiId = body.api.id;
      proxyId = String(body.api.ferrum_proxy_id);
    });

    it('removes and re-adds the access_control plugin as requestable is toggled', async () => {
      assert.ok(harness.edge.pluginForProxy(proxyId, 'access_control'));

      const off = await harness.authed(provider, {
        method: 'PATCH',
        url: `/api/apis/${apiId}`,
        payload: { requestable: false },
      });
      assert.equal(off.statusCode, 200);
      assert.equal(off.json<UpdateApiResponse>().api.requestable, false);
      assert.equal(harness.edge.pluginForProxy(proxyId, 'access_control'), undefined);

      const on = await harness.authed(provider, {
        method: 'PATCH',
        url: `/api/apis/${apiId}`,
        payload: { requestable: true },
      });
      assert.equal(on.statusCode, 200);
      const acl = harness.edge.pluginForProxy(proxyId, 'access_control');
      assert.deepEqual(acl?.config, { allowed_groups: [aclGroupForApi(apiId)] });
    });

    it('keeps the association list in step as requestable is toggled', async () => {
      assert.deepEqual(effectiveNames(harness, proxyId), ['access_control', 'key_auth']);

      await harness.authed(provider, {
        method: 'PATCH',
        url: `/api/apis/${apiId}`,
        payload: { requestable: false },
      });
      assert.deepEqual(effectiveNames(harness, proxyId), ['key_auth']);
      assert.deepEqual(associatedIds(harness, proxyId), writtenIds(harness, proxyId));

      await harness.authed(provider, {
        method: 'PATCH',
        url: `/api/apis/${apiId}`,
        payload: { requestable: true },
      });
      assert.deepEqual(effectiveNames(harness, proxyId), ['access_control', 'key_auth']);
      assert.deepEqual(associatedIds(harness, proxyId), writtenIds(harness, proxyId));
    });

    it('creates, rewrites and deletes the rate_limiting plugin', async () => {
      assert.equal(harness.edge.pluginForProxy(proxyId, 'rate_limiting'), undefined);

      await harness.authed(provider, {
        method: 'PATCH',
        url: `/api/apis/${apiId}`,
        payload: { rate_limit: { limit: 10, window_seconds: 1 } },
      });
      assert.deepEqual(harness.edge.pluginForProxy(proxyId, 'rate_limiting')?.config, {
        limit_by: 'consumer',
        expose_headers: true,
        limits: [{ scope: 'default', window_seconds: 1, max_requests: 10 }],
      });

      await harness.authed(provider, {
        method: 'PATCH',
        url: `/api/apis/${apiId}`,
        payload: { rate_limit: { limit: 500, window_seconds: 3600 } },
      });
      assert.deepEqual(harness.edge.pluginForProxy(proxyId, 'rate_limiting')?.config, {
        limit_by: 'consumer',
        expose_headers: true,
        limits: [{ scope: 'default', window_seconds: 3600, max_requests: 500 }],
      });
      // Rewritten in place rather than stacked up.
      assert.equal(
        harness.edge.pluginsForProxy(proxyId).filter((p) => p.plugin_name === 'rate_limiting')
          .length,
        1,
      );

      const cleared = await harness.authed(provider, {
        method: 'PATCH',
        url: `/api/apis/${apiId}`,
        payload: { rate_limit: null },
      });
      assert.equal(cleared.json<UpdateApiResponse>().api.rate_limit, null);
      assert.equal(harness.edge.pluginForProxy(proxyId, 'rate_limiting'), undefined);
    });

    it('associates a new rate limit, keeps the id on a rewrite, and detaches on null', async () => {
      await harness.authed(provider, {
        method: 'PATCH',
        url: `/api/apis/${apiId}`,
        payload: { rate_limit: { limit: 10, window_seconds: 1 } },
      });
      assert.deepEqual(effectiveNames(harness, proxyId), [
        'access_control',
        'key_auth',
        'rate_limiting',
      ]);
      const created = String(harness.edge.pluginForProxy(proxyId, 'rate_limiting')?.id);
      assert.ok(associatedIds(harness, proxyId).includes(created));

      // A rewrite keeps the config id, so the association must not change.
      await harness.authed(provider, {
        method: 'PATCH',
        url: `/api/apis/${apiId}`,
        payload: { rate_limit: { limit: 500, window_seconds: 3600 } },
      });
      assert.equal(String(harness.edge.pluginForProxy(proxyId, 'rate_limiting')?.id), created);
      assert.deepEqual(associatedIds(harness, proxyId), writtenIds(harness, proxyId));

      await harness.authed(provider, {
        method: 'PATCH',
        url: `/api/apis/${apiId}`,
        payload: { rate_limit: null },
      });
      assert.deepEqual(effectiveNames(harness, proxyId), ['access_control', 'key_auth']);
      assert.ok(!associatedIds(harness, proxyId).includes(created));
      assert.deepEqual(associatedIds(harness, proxyId), writtenIds(harness, proxyId));
    });

    it('creates, rewrites and removes the cors plugin exactly as rate_limit does', async () => {
      assert.equal(harness.edge.pluginForProxy(proxyId, 'cors'), undefined);

      const added = await harness.authed(provider, {
        method: 'PATCH',
        url: `/api/apis/${apiId}`,
        payload: {
          cors: { allowed_origins: ['https://app.example.com'], allow_credentials: false },
        },
      });
      assert.equal(added.statusCode, 200, added.body);
      assert.deepEqual(added.json<UpdateApiResponse>().api.cors, {
        allowed_origins: ['https://app.example.com'],
        allow_credentials: false,
      });
      assert.deepEqual(harness.edge.pluginForProxy(proxyId, 'cors')?.config, {
        allowed_origins: ['https://app.example.com'],
        allow_credentials: false,
      });
      assert.deepEqual(effectiveNames(harness, proxyId), ['access_control', 'cors', 'key_auth']);
      const corsId = String(harness.edge.pluginForProxy(proxyId, 'cors')?.id);
      assert.ok(associatedIds(harness, proxyId).includes(corsId));

      const rewritten = await harness.authed(provider, {
        method: 'PATCH',
        url: `/api/apis/${apiId}`,
        payload: {
          cors: {
            allowed_origins: ['https://app.example.com', 'https://ops.example.com'],
            allow_credentials: true,
          },
        },
      });
      assert.equal(rewritten.statusCode, 200);
      assert.deepEqual(harness.edge.pluginForProxy(proxyId, 'cors')?.config, {
        allowed_origins: ['https://app.example.com', 'https://ops.example.com'],
        allow_credentials: true,
      });
      // Rewritten in place: same id, same association, one config.
      assert.equal(String(harness.edge.pluginForProxy(proxyId, 'cors')?.id), corsId);
      assert.equal(
        harness.edge.pluginsForProxy(proxyId).filter((p) => p.plugin_name === 'cors').length,
        1,
      );

      const cleared = await harness.authed(provider, {
        method: 'PATCH',
        url: `/api/apis/${apiId}`,
        payload: { cors: null },
      });
      assert.equal(cleared.statusCode, 200);
      assert.equal(cleared.json<UpdateApiResponse>().api.cors, null);
      assert.equal(harness.edge.pluginForProxy(proxyId, 'cors'), undefined);
      assert.ok(!associatedIds(harness, proxyId).includes(corsId));
      assert.deepEqual(effectiveNames(harness, proxyId), ['access_control', 'key_auth']);
      assert.deepEqual(associatedIds(harness, proxyId), writtenIds(harness, proxyId));
    });

    it('applies the proxy settings and resets them to the gateway defaults on null', async () => {
      const applied = await harness.authed(provider, {
        method: 'PATCH',
        url: `/api/apis/${apiId}`,
        payload: {
          allowed_methods: ['GET', 'DELETE'],
          timeouts: { connect_ms: 800, read_ms: 9_000, write_ms: 11_000 },
          circuit_breaker: true,
        },
      });
      assert.equal(applied.statusCode, 200, applied.body);
      const updated = applied.json<UpdateApiResponse>().api;
      assert.deepEqual(updated.allowed_methods, ['GET', 'DELETE']);
      assert.deepEqual(updated.timeouts, { connect_ms: 800, read_ms: 9_000, write_ms: 11_000 });
      assert.equal(updated.circuit_breaker, true);

      const proxy = storedProxy(harness, proxyId);
      assert.deepEqual(proxy.allowed_methods, ['GET', 'DELETE']);
      assert.equal(proxy.backend_connect_timeout_ms, 800);
      assert.equal(proxy.backend_read_timeout_ms, 9_000);
      assert.equal(proxy.backend_write_timeout_ms, 11_000);
      assert.equal((proxy.circuit_breaker as Record<string, unknown>).failure_threshold, 5);

      const cleared = await harness.authed(provider, {
        method: 'PATCH',
        url: `/api/apis/${apiId}`,
        payload: { allowed_methods: null, timeouts: null, circuit_breaker: false },
      });
      assert.equal(cleared.statusCode, 200, cleared.body);
      assert.equal(cleared.json<UpdateApiResponse>().api.allowed_methods, null);
      assert.equal(cleared.json<UpdateApiResponse>().api.timeouts, null);

      // `PUT /proxies/{id}` echoes the document, so "back to the default" has
      // to be written as a value — omitting the key would keep 800 / 9000.
      const reset = storedProxy(harness, proxyId);
      assert.equal(reset.allowed_methods, null);
      assert.equal(reset.backend_connect_timeout_ms, 5_000);
      assert.equal(reset.backend_read_timeout_ms, 30_000);
      assert.equal(reset.backend_write_timeout_ms, 30_000);
      assert.equal(reset.circuit_breaker, null);
    });

    it('does not overwrite an operator-tuned breaker when its boolean is replayed', async () => {
      const proxy = storedProxy(harness, proxyId);
      proxy.circuit_breaker = {
        failure_threshold: 99,
        timeout_seconds: 300,
        trip_on_connection_errors: true,
      };

      const putsBeforeDisabledReplay = harness.edge.callsTo('PUT', `/proxies/${proxyId}`).length;
      const auditsBeforeDisabledReplay = (await harness.auditRows('api.update')).length;
      const disabledReplay = await harness.authed(provider, {
        method: 'PATCH',
        url: `/api/apis/${apiId}`,
        payload: { circuit_breaker: false },
      });
      assert.equal(disabledReplay.statusCode, 200, disabledReplay.body);
      assert.deepEqual(storedProxy(harness, proxyId).circuit_breaker, {
        failure_threshold: 99,
        timeout_seconds: 300,
        trip_on_connection_errors: true,
      });
      assert.equal(
        harness.edge.callsTo('PUT', `/proxies/${proxyId}`).length,
        putsBeforeDisabledReplay,
      );
      assert.equal((await harness.auditRows('api.update')).length, auditsBeforeDisabledReplay);

      const enabled = await harness.authed(provider, {
        method: 'PATCH',
        url: `/api/apis/${apiId}`,
        payload: { circuit_breaker: true },
      });
      assert.equal(enabled.statusCode, 200, enabled.body);
      const tuned = storedProxy(harness, proxyId);
      tuned.circuit_breaker = {
        failure_threshold: 77,
        timeout_seconds: 240,
        trip_on_connection_errors: false,
      };

      const putsBeforeEnabledReplay = harness.edge.callsTo('PUT', `/proxies/${proxyId}`).length;
      const auditsBeforeEnabledReplay = (await harness.auditRows('api.update')).length;
      const enabledReplay = await harness.authed(provider, {
        method: 'PATCH',
        url: `/api/apis/${apiId}`,
        payload: { circuit_breaker: true },
      });
      assert.equal(enabledReplay.statusCode, 200, enabledReplay.body);
      assert.deepEqual(storedProxy(harness, proxyId).circuit_breaker, {
        failure_threshold: 77,
        timeout_seconds: 240,
        trip_on_connection_errors: false,
      });
      assert.equal(
        harness.edge.callsTo('PUT', `/proxies/${proxyId}`).length,
        putsBeforeEnabledReplay,
      );
      assert.equal((await harness.auditRows('api.update')).length, auditsBeforeEnabledReplay);
    });

    it('re-derives OPTIONS and the WS origins when CORS arrives later and leaves', async () => {
      await harness.authed(provider, {
        method: 'PATCH',
        url: `/api/apis/${apiId}`,
        payload: { allowed_methods: ['GET'] },
      });
      assert.deepEqual(storedProxy(harness, proxyId).allowed_methods, ['GET']);
      // Publishing already wrote the (empty) WS allow-list, so the check is off.
      assert.deepEqual(storedProxy(harness, proxyId).allowed_ws_origins, []);

      // The provider adds CORS without touching the method list; the preflight
      // still has to survive the 405 check that runs before every plugin.
      const withCors = await harness.authed(provider, {
        method: 'PATCH',
        url: `/api/apis/${apiId}`,
        payload: {
          cors: { allowed_origins: ['https://app.example.com'], allow_credentials: false },
        },
      });
      assert.equal(withCors.statusCode, 200, withCors.body);
      assert.deepEqual(storedProxy(harness, proxyId).allowed_methods, ['GET', 'OPTIONS']);
      assert.deepEqual(storedProxy(harness, proxyId).allowed_ws_origins, [
        'https://app.example.com',
      ]);
      assert.deepEqual(
        withCors.json<UpdateApiResponse>().api.allowed_methods,
        ['GET'],
        'the row still carries only what the provider chose',
      );

      const withoutCors = await harness.authed(provider, {
        method: 'PATCH',
        url: `/api/apis/${apiId}`,
        payload: { cors: null },
      });
      assert.equal(withoutCors.statusCode, 200);
      assert.deepEqual(storedProxy(harness, proxyId).allowed_methods, ['GET']);
      assert.deepEqual(storedProxy(harness, proxyId).allowed_ws_origins, []);
    });

    it('rolls the proxy settings back when a later step of the PATCH fails', async () => {
      await harness.authed(provider, {
        method: 'PATCH',
        url: `/api/apis/${apiId}`,
        payload: {
          allowed_methods: ['GET'],
          timeouts: { connect_ms: 800, read_ms: 9_000, write_ms: 11_000 },
        },
      });

      // The settings write is the last gateway call of a PATCH, so the row
      // update is the step whose failure has to unwind it.
      failNextApiUpdate(harness, 'database is gone');
      const failed = await harness.authed(provider, {
        method: 'PATCH',
        url: `/api/apis/${apiId}`,
        payload: {
          allowed_methods: ['GET', 'POST', 'DELETE'],
          timeouts: { connect_ms: 250, read_ms: 500, write_ms: 750 },
          circuit_breaker: true,
        },
      });
      assert.notEqual(failed.statusCode, 200);

      const proxy = storedProxy(harness, proxyId);
      assert.deepEqual(proxy.allowed_methods, ['GET']);
      assert.equal(proxy.backend_connect_timeout_ms, 800);
      assert.equal(proxy.backend_read_timeout_ms, 9_000);
      assert.equal(proxy.backend_write_timeout_ms, 11_000);
      assert.equal(proxy.circuit_breaker, null, 'a breaker that was never there stays absent');
    });

    it('leaves operator-set proxy fields alone when the PATCH does not name them', async () => {
      enrichProxy(harness, proxyId);
      const response = await harness.authed(provider, {
        method: 'PATCH',
        url: `/api/apis/${apiId}`,
        payload: { allowed_methods: ['GET'], circuit_breaker: true },
      });
      assert.equal(response.statusCode, 200, response.body);
      // `backend_read_timeout_ms` is one of the enriched fields: a PATCH that
      // says nothing about timeouts must not reset it to Edge's default.
      assertEnrichmentSurvived(harness, proxyId);
      assert.deepEqual(storedProxy(harness, proxyId).allowed_methods, ['GET']);
    });

    it('swaps the auth plugin and records that old credentials stop working', async () => {
      const response = await harness.authed(provider, {
        method: 'PATCH',
        url: `/api/apis/${apiId}`,
        payload: { auth_plugin: 'jwt_auth' },
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json<UpdateApiResponse>().api.auth_plugin, 'jwt_auth');

      assert.equal(harness.edge.pluginForProxy(proxyId, 'key_auth'), undefined);
      assert.ok(harness.edge.pluginForProxy(proxyId, 'jwt_auth'));
      // The swap has to move the association too, or the gateway would run
      // neither the outgoing plugin nor its replacement.
      assert.deepEqual(effectiveNames(harness, proxyId), ['access_control', 'jwt_auth']);
      assert.deepEqual(associatedIds(harness, proxyId), writtenIds(harness, proxyId));

      const row = (await harness.auditRows('api.update')).find(
        (entry) => entry.target_id === apiId,
      );
      assert.ok(row);
      assert.equal(row.details.previous_auth_plugin, 'key_auth');
      assert.equal(row.details.previous_credential_type, 'keyauth');
      assert.equal(row.details.existing_credentials_invalidated, true);
    });

    it('never leaves the proxy without an auth plugin when the swap fails', async () => {
      // 1. The replacement cannot be attached. The incumbent must not have been
      //    removed in anticipation — that is the window in which the proxy
      //    fronts the upstream with no authentication at all.
      harness.edge.queueFailure(
        500,
        { error: 'edge rejected the plugin' },
        '/plugins/config',
        'POST',
      );
      const attachFails = await harness.authed(provider, {
        method: 'PATCH',
        url: `/api/apis/${apiId}`,
        payload: { auth_plugin: 'jwt_auth' },
      });
      assert.notEqual(attachFails.statusCode, 200);
      assert.ok(harness.edge.pluginForProxy(proxyId, 'key_auth'), 'the original is still live');
      assert.equal(harness.edge.pluginForProxy(proxyId, 'jwt_auth'), undefined);
      assert.deepEqual(
        effectiveNames(harness, proxyId),
        ['access_control', 'key_auth'],
        'the gateway is still enforcing the incumbent, not merely storing it',
      );

      // 2. The replacement attaches but the incumbent cannot be removed. The
      //    new plugin is rolled back, leaving exactly the original.
      harness.edge.queueFailure(500, { error: 'edge is busy' }, '/plugins/config/', 'DELETE');
      const deleteFails = await harness.authed(provider, {
        method: 'PATCH',
        url: `/api/apis/${apiId}`,
        payload: { auth_plugin: 'jwt_auth' },
      });
      assert.notEqual(deleteFails.statusCode, 200);
      assert.ok(harness.edge.pluginForProxy(proxyId, 'key_auth'), 'the original is still live');
      assert.equal(
        harness.edge.pluginForProxy(proxyId, 'jwt_auth'),
        undefined,
        'the half-attached replacement is compensated away',
      );
      assert.deepEqual(
        effectiveNames(harness, proxyId),
        ['access_control', 'key_auth'],
        'at no point does the proxy end up with no auth plugin the gateway runs',
      );
      assert.deepEqual(associatedIds(harness, proxyId), writtenIds(harness, proxyId));

      const api = await harness.store.apis.findById(apiId);
      assert.equal(api?.auth_plugin, 'key_auth', 'the portal still describes what Edge enforces');
    });

    it('restores the previous auth plugin when the Nexus row update fails', async () => {
      failNextApiUpdate(harness, 'database is gone');

      const response = await harness.authed(provider, {
        method: 'PATCH',
        url: `/api/apis/${apiId}`,
        payload: { auth_plugin: 'jwt_auth' },
      });
      assert.notEqual(response.statusCode, 200);

      assert.ok(
        harness.edge.pluginForProxy(proxyId, 'key_auth'),
        'the plugin deleted mid-swap is put back',
      );
      assert.equal(harness.edge.pluginForProxy(proxyId, 'jwt_auth'), undefined);
      const authPlugins = harness.edge
        .pluginsForProxy(proxyId)
        .filter((plugin) => plugin.plugin_name === 'key_auth' || plugin.plugin_name === 'jwt_auth');
      assert.equal(authPlugins.length, 1, 'exactly one auth plugin, the original');
      assert.deepEqual(effectiveNames(harness, proxyId), ['access_control', 'key_auth']);
      assert.deepEqual(associatedIds(harness, proxyId), writtenIds(harness, proxyId));

      const api = await harness.store.apis.findById(apiId);
      assert.equal(api?.auth_plugin, 'key_auth');
    });

    it('repoints the proxy backend when a new upstream_url is supplied', async () => {
      await harness.authed(provider, {
        method: 'PATCH',
        url: `/api/apis/${apiId}`,
        payload: { upstream_url: 'http://moved.example.com:9100/base' },
      });
      const proxy = harness.edge.proxies.get(`nexus/${proxyId}`);
      assert.equal(proxy?.backend_host, 'moved.example.com');
      assert.equal(proxy?.backend_port, 9100);
      assert.equal(proxy?.backend_path, '/base');
    });

    it('records the normalized upstream on the row and stamps it updated', async () => {
      const before = await harness.store.apis.findById(apiId);
      assert.ok(before);

      const response = await harness.authed(provider, {
        method: 'PATCH',
        url: `/api/apis/${apiId}`,
        payload: { upstream_url: 'HTTP://Moved.Example.com/base/' },
      });
      assert.equal(response.statusCode, 200, response.body);
      const api = response.json<UpdateApiResponse>().api;

      // Canonical, not however the provider typed it: lowercased host, the
      // scheme's default port made explicit, no trailing slash.
      assert.equal(api.upstream_url, 'http://moved.example.com:80/base');
      assert.ok(
        new Date(api.updated_at).getTime() > new Date(before.updated_at).getTime(),
        'the row is stamped when the gateway moves',
      );
    });

    it('clears a stale backend_path when the new upstream has none', async () => {
      await harness.authed(provider, {
        method: 'PATCH',
        url: `/api/apis/${apiId}`,
        payload: { upstream_url: 'https://first.example.com:8443/v2' },
      });
      assert.equal(harness.edge.proxies.get(`nexus/${proxyId}`)?.backend_path, '/v2');

      await harness.authed(provider, {
        method: 'PATCH',
        url: `/api/apis/${apiId}`,
        payload: { upstream_url: 'https://second.example.com:8443' },
      });
      const proxy = harness.edge.proxies.get(`nexus/${proxyId}`);
      assert.equal(proxy?.backend_host, 'second.example.com');
      assert.equal(
        proxy?.backend_path,
        null,
        'a merge must not leave the previous host’s base path behind',
      );
    });

    it('preserves operator-set proxy fields and associations across a repoint', async () => {
      enrichProxy(harness, proxyId);
      const associatedBefore = associatedIds(harness, proxyId);
      assert.equal(associatedBefore.length, 2);

      const response = await harness.authed(provider, {
        method: 'PATCH',
        url: `/api/apis/${apiId}`,
        payload: { upstream_url: 'https://moved.example.com:9443/v3' },
      });
      assert.equal(response.statusCode, 200, response.body);

      const proxy = harness.edge.proxies.get(`nexus/${proxyId}`);
      assert.equal(proxy?.backend_host, 'moved.example.com');
      assert.equal(proxy?.backend_port, 9443);
      assertEnrichmentSurvived(harness, proxyId);
      assert.deepEqual(associatedIds(harness, proxyId), associatedBefore);
      assert.deepEqual(effectiveNames(harness, proxyId), ['access_control', 'key_auth']);
    });

    it('puts the backend back without dropping a later plugin change’s undo', async () => {
      enrichProxy(harness, proxyId);
      failNextApiUpdate(harness, 'database is gone');

      const response = await harness.authed(provider, {
        method: 'PATCH',
        url: `/api/apis/${apiId}`,
        payload: {
          upstream_url: 'https://moved.example.com:9443',
          rate_limit: { limit: 7, window_seconds: 60 },
        },
      });
      assert.notEqual(response.statusCode, 200);

      const proxy = harness.edge.proxies.get(`nexus/${proxyId}`);
      assert.equal(proxy?.backend_host, 'billing.example.com', 'the backend is rewound');
      assert.equal(proxy?.backend_path, '/v2');
      assertEnrichmentSurvived(harness, proxyId);
      assert.deepEqual(effectiveNames(harness, proxyId), ['access_control', 'key_auth']);
      assert.deepEqual(associatedIds(harness, proxyId), writtenIds(harness, proxyId));
    });

    it('refuses to repoint the proxy at a private upstream', async () => {
      const proxyBefore = harness.edge.proxies.get(`nexus/${proxyId}`);
      const response = await harness.authed(provider, {
        method: 'PATCH',
        url: `/api/apis/${apiId}`,
        payload: { upstream_url: 'http://10.0.0.5:9100' },
      });
      assert.equal(response.statusCode, 400);
      assert.equal(errorCode(response.body), 'SPEC_INVALID');
      assert.deepEqual(harness.edge.proxies.get(`nexus/${proxyId}`), proxyBefore);
    });

    it('retires an API without touching the gateway, and hides it from the catalog', async () => {
      const before = harness.edge.pluginsForProxy(proxyId).length;
      const enforcedBefore = effectiveNames(harness, proxyId);
      const response = await harness.authed(provider, {
        method: 'PATCH',
        url: `/api/apis/${apiId}`,
        payload: { status: 'retired' },
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json<UpdateApiResponse>().api.status, 'retired');

      // The proxy and its plugins are deliberately left alone — both the
      // configs that exist and the ones the gateway actually runs.
      assert.ok(harness.edge.proxies.get(`nexus/${proxyId}`));
      assert.equal(harness.edge.pluginsForProxy(proxyId).length, before);
      assert.deepEqual(effectiveNames(harness, proxyId), enforcedBefore);

      const catalog = await harness.authed(client, { method: 'GET', url: '/api/catalog' });
      const slugs = catalog.json<CatalogListResponse>().items.map((api) => api.id);
      assert.ok(!slugs.includes(apiId), 'a retired API must not appear in a client catalog');

      const row = (await harness.auditRows('api.retire')).find((e) => e.target_id === apiId);
      assert.ok(row, 'retiring writes an api.retire audit row');
      assert.equal(row.details.gateway_untouched, true);
    });

    it('refuses an update from a provider who does not own the API', async () => {
      const response = await harness.authed(otherProvider, {
        method: 'PATCH',
        url: `/api/apis/${apiId}`,
        payload: { description: 'not mine' },
      });
      assert.equal(response.statusCode, 403);
      assert.equal(errorCode(response.body), 'FORBIDDEN');
    });

    it('lets an admin update somebody else’s API', async () => {
      const response = await harness.authed(founder, {
        method: 'PATCH',
        url: `/api/apis/${apiId}`,
        payload: { description: 'reviewed by the platform team' },
      });
      assert.equal(response.statusCode, 200);
      assert.equal(
        response.json<UpdateApiResponse>().api.description,
        'reviewed by the platform team',
      );
    });
  });

  describe('spec revisions', () => {
    it('stores a new current revision and follows the document’s server change', async () => {
      harness.edge.reset();
      const published = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({
          slug: 'spec-follow',
          spec: specWithServer('https://v1.example.com:8443'),
        }),
      });
      const apiId = published.json<PublishApiResponse>().api.id;
      const proxyId = String(published.json<PublishApiResponse>().api.ferrum_proxy_id);
      assert.equal(harness.edge.proxies.get(`nexus/${proxyId}`)?.backend_host, 'v1.example.com');

      const response = await harness.authed(provider, {
        method: 'PUT',
        url: `/api/apis/${apiId}/spec`,
        payload: { spec: specWithServer('https://v2.example.com:8443', '3.0.0') },
      });
      assert.equal(response.statusCode, 200);
      const body = response.json<UpdateApiSpecResponse>();
      assert.equal(body.spec.is_current, true);
      assert.equal(body.spec.parsed_version, '3.0.0');
      assert.equal(body.api.version, '3.0.0');

      assert.equal(harness.edge.proxies.get(`nexus/${proxyId}`)?.backend_host, 'v2.example.com');

      // The previous revision is retained but is no longer current.
      const specs = await harness.store.apiSpecs.list({ api_id: apiId });
      assert.equal(specs.total, 2);
      assert.equal(specs.items.filter((spec) => spec.is_current).length, 1);

      const row = (await harness.auditRows('api.spec_update')).find((e) => e.target_id === apiId);
      assert.equal(row?.details.backend_updated, true);
      assert.equal(
        body.api.upstream_url,
        'https://v2.example.com:8443',
        'the recorded upstream follows the gateway',
      );
    });

    it('preserves operator fields and plugin associations when the proxy follows a spec', async () => {
      harness.edge.reset();
      const published = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({
          slug: 'spec-follow-preserve',
          spec: specWithServer('https://v1.example.com:8443'),
          cors: { allowed_origins: ['https://app.example.com'], allow_credentials: false },
        }),
      });
      assert.equal(published.statusCode, 201, published.body);
      const api = published.json<PublishApiResponse>().api;
      const proxyId = String(api.ferrum_proxy_id);
      assert.deepEqual(effectiveNames(harness, proxyId), ['access_control', 'cors', 'key_auth']);

      enrichProxy(harness, proxyId);
      const associatedBefore = associatedIds(harness, proxyId);

      const response = await harness.authed(provider, {
        method: 'PUT',
        url: `/api/apis/${api.id}/spec`,
        payload: { spec: specWithServer('https://v2.example.com:8443', '3.0.0') },
      });
      assert.equal(response.statusCode, 200, response.body);

      assert.equal(harness.edge.proxies.get(`nexus/${proxyId}`)?.backend_host, 'v2.example.com');
      assertEnrichmentSurvived(harness, proxyId);
      assert.deepEqual(associatedIds(harness, proxyId), associatedBefore);
      assert.deepEqual(effectiveNames(harness, proxyId), ['access_control', 'cors', 'key_auth']);
      assert.equal(
        response.json<UpdateApiSpecResponse>().api.upstream_url,
        'https://v2.example.com:8443',
      );
    });

    it('leaves an explicitly-pinned backend alone when the document moves', async () => {
      harness.edge.reset();
      const published = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({
          slug: 'spec-pinned',
          spec: specWithServer('https://v1.example.com:8443'),
          upstream_url: 'https://pinned.example.com:8443',
        }),
      });
      const api = published.json<PublishApiResponse>().api;

      await harness.authed(provider, {
        method: 'PUT',
        url: `/api/apis/${api.id}/spec`,
        payload: { spec: specWithServer('https://v2.example.com:8443') },
      });
      assert.equal(
        harness.edge.proxies.get(`nexus/${String(api.ferrum_proxy_id)}`)?.backend_host,
        'pinned.example.com',
      );
      assert.equal(
        (await harness.store.apis.findById(api.id))?.upstream_url,
        'https://pinned.example.com:8443',
        'a pinned backend keeps its recorded upstream when the document moves',
      );
    });

    it('refuses a revision that would move a following proxy to a private host', async () => {
      const published = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({
          slug: 'spec-follow-private',
          spec: specWithServer('https://v1.example.com:8443'),
        }),
      });
      assert.equal(published.statusCode, 201, published.body);
      const api = published.json<PublishApiResponse>().api;
      const proxyId = String(api.ferrum_proxy_id);

      const response = await harness.authed(provider, {
        method: 'PUT',
        url: `/api/apis/${api.id}/spec`,
        payload: { spec: specWithServer('http://10.1.1.1:8443', '3.0.0') },
      });
      assert.equal(response.statusCode, 400);
      assert.equal(errorCode(response.body), 'SPEC_INVALID');
      assert.equal(harness.edge.proxies.get(`nexus/${proxyId}`)?.backend_host, 'v1.example.com');
      const specs = await harness.store.apiSpecs.list({ api_id: api.id });
      assert.equal(specs.items.length, 1, 'the rejected revision was not stored');
    });

    it('stores a revision with a private servers[0] when the backend is pinned', async () => {
      const published = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({
          slug: 'spec-pinned-private',
          spec: specWithServer('https://v1.example.com:8443'),
          upstream_url: 'https://pinned.example.com:8443',
        }),
      });
      assert.equal(published.statusCode, 201, published.body);
      const api = published.json<PublishApiResponse>().api;

      const response = await harness.authed(provider, {
        method: 'PUT',
        url: `/api/apis/${api.id}/spec`,
        payload: { spec: specWithServer('http://10.1.1.1:8443', '3.0.0') },
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(
        harness.edge.proxies.get(`nexus/${String(api.ferrum_proxy_id)}`)?.backend_host,
        'pinned.example.com',
      );
    });

    it('rejects an invalid revision and keeps the previous one current', async () => {
      harness.edge.reset();
      const published = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({ slug: 'spec-reject' }),
      });
      const apiId = published.json<PublishApiResponse>().api.id;

      const response = await harness.authed(provider, {
        method: 'PUT',
        url: `/api/apis/${apiId}/spec`,
        payload: { spec: '{"swagger":"2.0","info":{"title":"x","version":"1"}}' },
      });
      assert.equal(response.statusCode, 400);
      assert.equal(errorCode(response.body), 'SPEC_INVALID');

      const current = await harness.store.apiSpecs.findCurrentByApi(apiId);
      assert.equal(current?.parsed_version, '2.4.0');
    });

    it('keeps the previous revision current when the Edge backend move fails', async () => {
      harness.edge.reset();
      const published = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({
          slug: 'spec-edge-fails',
          spec: specWithServer('https://v1.example.com:8443'),
        }),
      });
      const api = published.json<PublishApiResponse>().api;
      const proxyId = String(api.ferrum_proxy_id);

      // The revision used to become current *before* the proxy was repointed,
      // so this left version 2 in the catalog and version 1 on the gateway.
      harness.edge.queueFailure(500, { error: 'config_rejected' }, '/proxies/', 'PUT');
      const response = await harness.authed(provider, {
        method: 'PUT',
        url: `/api/apis/${api.id}/spec`,
        payload: { spec: specWithServer('https://v2.example.com:8443', '3.0.0') },
      });
      assert.notEqual(response.statusCode, 200);

      assert.equal(
        harness.edge.proxies.get(`nexus/${proxyId}`)?.backend_host,
        'v1.example.com',
        'the gateway never moved',
      );
      const specs = await harness.store.apiSpecs.list({ api_id: api.id });
      assert.equal(specs.total, 1, 'no revision was stored');
      assert.equal(specs.items[0]?.is_current, true);
      assert.equal((await harness.store.apis.findById(api.id))?.version, '2.4.0');
    });

    it('restores the previous backend when the new revision cannot be persisted', async () => {
      harness.edge.reset();
      const published = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({
          slug: 'spec-store-fails',
          spec: specWithServer('https://v1.example.com:8443'),
        }),
      });
      const api = published.json<PublishApiResponse>().api;
      const proxyId = String(api.ferrum_proxy_id);

      failNextTransaction(harness, 'database is gone');
      const response = await harness.authed(provider, {
        method: 'PUT',
        url: `/api/apis/${api.id}/spec`,
        payload: { spec: specWithServer('https://v2.example.com:8443', '3.0.0') },
      });
      assert.notEqual(response.statusCode, 200);

      assert.equal(
        harness.edge.proxies.get(`nexus/${proxyId}`)?.backend_host,
        'v1.example.com',
        'the backend that was moved for the failed revision is put back',
      );
      const specs = await harness.store.apiSpecs.list({ api_id: api.id });
      assert.equal(specs.total, 1);
      assert.equal(specs.items[0]?.parsed_version, '1.0.0');
      assert.equal(
        (await harness.store.apis.findById(api.id))?.upstream_url,
        'https://v1.example.com:8443',
        'the recorded upstream rolls back with the revision',
      );
    });
  });

  describe('deletion', () => {
    it('takes the proxy down before its plugin configs, and leaves nothing behind', async () => {
      harness.edge.reset();
      const published = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({
          slug: 'teardown',
          rate_limit: { limit: 9, window_seconds: 60 },
          cors: { allowed_origins: ['https://app.example.com'], allow_credentials: false },
        }),
      });
      assert.equal(published.statusCode, 201, published.body);
      const api = published.json<PublishApiResponse>().api;
      const proxyId = String(api.ferrum_proxy_id);
      assert.equal(harness.edge.pluginsForProxy(proxyId).length, 4);

      const response = await harness.authed(provider, {
        method: 'DELETE',
        url: `/api/apis/${api.id}`,
      });
      assert.equal(response.statusCode, 200, response.body);

      // Deleting a plugin config first would strip its association — Edge's
      // `DELETE /plugins/config/{id}` clears the junction rows rather than
      // refusing — and leave a live, unauthenticated proxy for the rest of the
      // teardown. So the proxy goes first and cascades the rest.
      const deletes = harness.edge.callsTo('DELETE', '/');
      const proxyAt = deletes.findIndex((call) => call.path === `/proxies/${proxyId}`);
      const firstConfigAt = deletes.findIndex((call) => call.path.startsWith('/plugins/config/'));
      assert.notEqual(proxyAt, -1, 'the proxy was deleted');
      if (firstConfigAt !== -1) {
        assert.ok(proxyAt < firstConfigAt, 'the proxy is deleted before any of its plugin configs');
      }

      assert.equal(harness.edge.proxies.get(`nexus/${proxyId}`), undefined);
      assert.equal(harness.edge.pluginsForProxy(proxyId).length, 0);
      assert.deepEqual(effectiveNames(harness, proxyId), []);
      assert.equal(await harness.store.apis.findById(api.id), null);
    });
  });

  describe('test consumers', () => {
    it('creates a consumer in the API’s ACL group with a show-once credential', async () => {
      harness.edge.reset();
      const published = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({ slug: 'testcon' }),
      });
      const apiId = published.json<PublishApiResponse>().api.id;

      const response = await harness.authed(provider, {
        method: 'POST',
        url: `/api/apis/${apiId}/test-consumer`,
        payload: {},
      });
      assert.equal(response.statusCode, 201);
      const body = response.json<CreateTestConsumerResponse>();
      assert.equal(body.consumer_username, `nexus-test-${apiId}`);
      assert.equal(body.secret.type, 'keyauth');
      assert.ok(body.secret.key && body.secret.key.length > 20);
      assert.equal(body.credential.last4, body.secret.key.slice(-4));

      const stored = harness.edge.consumerByUsername(`nexus-test-${apiId}`);
      assert.ok(stored);
      assert.deepEqual(stored.acl_groups, [aclGroupForApi(apiId)]);
      assert.equal(stored.credentials.keyauth?.length, 1);
      assert.equal(stored.credentials.keyauth?.[0]?.key, body.secret.key);

      const row = (await harness.auditRows('test_consumer.create')).find(
        (entry) => entry.target_id === apiId,
      );
      assert.equal(row?.details.replaced, false);
    });

    it('replaces the previous test consumer rather than stacking credentials', async () => {
      harness.edge.reset();
      const published = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({ slug: 'testcon-replace', auth_plugin: 'basic_auth' }),
      });
      const apiId = published.json<PublishApiResponse>().api.id;

      const first = await harness.authed(provider, {
        method: 'POST',
        url: `/api/apis/${apiId}/test-consumer`,
        payload: {},
      });
      const firstBody = first.json<CreateTestConsumerResponse>();
      assert.equal(firstBody.secret.type, 'basicauth');
      // Basic auth is keyed on the *consumer* username — Edge has no
      // per-credential username field.
      assert.equal(firstBody.secret.username, `nexus-test-${apiId}`);
      assert.ok(firstBody.secret.password);

      const second = await harness.authed(provider, {
        method: 'POST',
        url: `/api/apis/${apiId}/test-consumer`,
        payload: {},
      });
      assert.equal(second.statusCode, 201);
      const secondBody = second.json<CreateTestConsumerResponse>();
      assert.notEqual(secondBody.secret.password, firstBody.secret.password);

      const stored = harness.edge.consumerByUsername(`nexus-test-${apiId}`);
      assert.equal(stored?.credentials.basicauth?.length, 1, 'the old consumer was replaced');
      assert.equal(stored?.credentials.basicauth?.[0]?.password, secondBody.secret.password);

      const row = (await harness.auditRows('test_consumer.create')).find(
        (entry) => entry.target_id === apiId && entry.details.replaced === true,
      );
      assert.ok(row, 'the replacement is recorded as such');
    });

    it('revokes the credential rows of the consumer it replaced', async () => {
      harness.edge.reset();
      const published = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({ slug: 'testcon-rows' }),
      });
      const apiId = published.json<PublishApiResponse>().api.id;
      const username = `nexus-test-${apiId}`;

      await harness.authed(provider, {
        method: 'POST',
        url: `/api/apis/${apiId}/test-consumer`,
        payload: {},
      });
      const firstConsumerId = harness.edge.consumerByUsername(username)?.id;
      assert.ok(firstConsumerId);

      const second = await harness.authed(provider, {
        method: 'POST',
        url: `/api/apis/${apiId}/test-consumer`,
        payload: {},
      });
      assert.equal(second.statusCode, 201);
      const secondBody = second.json<CreateTestConsumerResponse>();
      const secondConsumerId = harness.edge.consumerByUsername(username)?.id;
      assert.ok(secondConsumerId);
      assert.notEqual(secondConsumerId, firstConsumerId, 'the consumer really was replaced');

      // The deleted consumer's credential can never authenticate again, so its
      // row must not still read `active` on the provider's credentials page.
      const orphaned = await harness.store.credentials.listByConsumer(firstConsumerId);
      assert.equal(orphaned.length, 1);
      assert.equal(orphaned[0]?.status, 'revoked');

      const live = await harness.store.credentials.list({ status: 'active' }, { limit: 200 });
      const forThisApi = live.items.filter((row) =>
        [firstConsumerId, secondConsumerId].includes(row.ferrum_consumer_id),
      );
      assert.equal(forThisApi.length, 1, 'exactly one usable test credential exists');
      assert.equal(forThisApi[0]?.id, secondBody.credential.id);

      const row = (await harness.auditRows('test_consumer.create')).find(
        (entry) => entry.target_id === apiId && entry.details.replaced === true,
      );
      assert.equal(row?.details.revoked_credentials, 1);
    });

    it('refuses a test consumer on somebody else’s API', async () => {
      harness.edge.reset();
      const published = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({ slug: 'testcon-guard' }),
      });
      const apiId = published.json<PublishApiResponse>().api.id;
      const response = await harness.authed(otherProvider, {
        method: 'POST',
        url: `/api/apis/${apiId}/test-consumer`,
        payload: {},
      });
      assert.equal(response.statusCode, 403);
    });
  });

  describe('listing and detail', () => {
    it('scopes a provider to their own APIs and lets an admin see all of them', async () => {
      harness.edge.reset();
      await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({ slug: 'mine-a' }),
      });
      await harness.authed(otherProvider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({ name: 'Theirs', slug: 'theirs-a' }),
      });

      const own = await harness.authed(provider, { method: 'GET', url: '/api/apis' });
      const ownSlugs = own.json<ListApisResponse>().items.map((api) => api.slug);
      assert.ok(ownSlugs.includes('mine-a'));
      assert.ok(!ownSlugs.includes('theirs-a'));

      const all = await harness.authed(founder, { method: 'GET', url: '/api/apis' });
      const allSlugs = all.json<ListApisResponse>().items.map((api) => api.slug);
      assert.ok(allSlugs.includes('mine-a') && allSlugs.includes('theirs-a'));

      const adminMine = await harness.authed(founder, {
        method: 'GET',
        url: '/api/apis?mine=true',
      });
      assert.equal(adminMine.json<ListApisResponse>().total, 0);
    });

    it('reports request and grant counters on the detail endpoint', async () => {
      harness.edge.reset();
      const published = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({ slug: 'counters' }),
      });
      const apiId = published.json<PublishApiResponse>().api.id;

      await harness.authed(client, {
        method: 'POST',
        url: '/api/access-requests',
        payload: { api_id: apiId, justification: 'Integrating billing.' },
      });

      const response = await harness.authed(provider, { method: 'GET', url: `/api/apis/${apiId}` });
      assert.equal(response.statusCode, 200);
      const body = response.json<GetApiResponse>();
      assert.equal(body.stats.pending_requests, 1);
      assert.equal(body.stats.active_grants, 0);
      assert.equal(body.stats.total_requests, 1);
      assert.equal(body.spec?.parsed_title, 'Billing API');
    });
    it('returns the recorded upstream and CORS policy on the detail endpoint', async () => {
      harness.edge.reset();
      const published = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({
          slug: 'detail-cors',
          upstream_url: 'http://override.example.com:8080/base',
          cors: { allowed_origins: ['https://app.example.com'], allow_credentials: true },
        }),
      });
      const apiId = published.json<PublishApiResponse>().api.id;

      const response = await harness.authed(provider, { method: 'GET', url: `/api/apis/${apiId}` });
      assert.equal(response.statusCode, 200);
      const body = response.json<GetApiResponse>();
      assert.equal(body.api.upstream_url, 'http://override.example.com:8080/base');
      assert.deepEqual(body.api.cors, {
        allowed_origins: ['https://app.example.com'],
        allow_credentials: true,
      });
    });
  });
  /**
   * Issue #38: the uploaded document used to be catalog metadata only, so a
   * request to a path the spec never declared proxied straight through. Issue
   * #49: the fix attached a hand-built `openapi_validator`, which every real
   * gateway refuses — Edge generates that plugin from an imported document or
   * not at all. A `routes` API's proxy is therefore created by the spec
   * importer, and these tests assert the document Nexus submits rather than a
   * plugin body it composes.
   */
  describe('OpenAPI enforcement', () => {
    /** The document Nexus submitted to `POST`/`PUT /api-specs` for a proxy. */
    function submittedDocument(proxyId: string): Record<string, unknown> {
      const spec = harness.edge.apiSpecForProxy(proxyId);
      assert.ok(spec, `expected proxy ${proxyId} to be owned by an api_spec`);
      return spec.document;
    }

    /** The validator config the gateway generated for a proxy. */
    function validatorConfig(proxyId: string): Record<string, unknown> | undefined {
      return harness.edge.pluginForProxy(proxyId, 'openapi_validator')?.config as
        Record<string, unknown> | undefined;
    }

    /** `METHOD path_template` for every generated operation, sorted. */
    function operationLabels(proxyId: string): string[] {
      const operations = validatorConfig(proxyId)?.operations;
      assert.ok(Array.isArray(operations), 'expected an operations array');
      return operations
        .map((operation) => {
          const entry = operation as Record<string, unknown>;
          return `${String(entry.method)} ${String(entry.path_template)}`;
        })
        .sort();
    }

    beforeEach(() => {
      harness.edge.reset();
    });

    it('writes no validator and imports no spec in the default docs_only mode', async () => {
      const response = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({ slug: 'enf-default' }),
      });
      assert.equal(response.statusCode, 201, response.body);
      const api = response.json<PublishApiResponse>().api;
      assert.equal(api.spec_enforcement, 'docs_only');

      const proxyId = String(api.ferrum_proxy_id);
      assert.equal(harness.edge.pluginForProxy(proxyId, 'openapi_validator'), undefined);
      assert.equal(harness.edge.apiSpecForProxy(proxyId), undefined);
      assert.equal(storedProxy(harness, proxyId).api_spec_id, undefined);
      assert.deepEqual(effectiveNames(harness, proxyId), ['access_control', 'key_auth']);
      assert.equal(harness.edge.callsTo('POST', '/api-specs').length, 0);
    });

    it('creates the proxy through the spec importer when routes is asked for', async () => {
      const response = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({ slug: 'enf-routes', spec_enforcement: 'routes' }),
      });
      assert.equal(response.statusCode, 201, response.body);
      const api = response.json<PublishApiResponse>().api;
      assert.equal(api.spec_enforcement, 'routes');

      const proxyId = String(api.ferrum_proxy_id);
      // No `POST /proxies` at all: the proxy came out of the spec import, which
      // is the only way Edge will let the validator exist.
      assert.equal(harness.edge.callsTo('POST', '/proxies').length, 0);
      assert.equal(harness.edge.callsTo('POST', '/api-specs').length, 1);

      // The import lands on a staging path; the cutover `PUT /api-specs/{id}`
      // moves both `servers[0]` and `x-ferrum-proxy.listen_path` onto the real
      // one once the plugins are associated. Everything asserted below is the
      // document as it stands *after* that move.
      const imported = harness.edge.callsTo('POST', '/api-specs')[0]?.body as Record<
        string,
        unknown
      >;
      assert.match(
        String((imported['x-ferrum-proxy'] as Record<string, unknown>).listen_path),
        /^\/nexus\/\.staging\/[0-9a-f]{32}$/,
      );
      assert.deepEqual(imported.servers, [
        { url: String((imported['x-ferrum-proxy'] as Record<string, unknown>).listen_path) },
      ]);

      const document = submittedDocument(proxyId);
      // `servers` is the load-bearing rewrite. Edge builds each operation
      // matcher from the Paths key prefixed by this pathname, so leaving the
      // provider's upstream here would generate `^/invoices$` and every request
      // arriving at `/nexus/enf-routes/invoices` would be an unknown operation.
      assert.deepEqual(document.servers, [{ url: '/nexus/enf-routes' }]);
      assert.deepEqual(document['x-ferrum-validate'], {
        mode: 'block',
        request: { enabled: false },
        response: { enabled: false },
        fail_on_unknown_operation: true,
      });
      assert.deepEqual(document['x-ferrum-proxy'], {
        id: proxyId,
        name: 'nexus-enf-routes',
        listen_path: '/nexus/enf-routes',
        backend_scheme: 'https',
        backend_host: 'billing.example.com',
        backend_port: 8443,
        backend_path: '/v2',
        strip_listen_path: true,
        allowed_ws_origins: [],
      });
      // The provider's own document rides through untouched.
      assert.deepEqual(Object.keys(document.paths as object), ['/invoices', '/invoices/{id}']);

      // What the gateway generated from it, listen path and all.
      assert.deepEqual(validatorConfig(proxyId), {
        enforcement_mode: 'block',
        validate_request: false,
        validate_response: false,
        fail_on_unknown_operation: true,
        operations: [
          {
            method: 'GET',
            path_template: '/nexus/enf-routes/invoices',
            // `-` is a metacharacter in Rust's regex crate, so `regex::escape`
            // escapes it — and so does Edge's own importer.
            path_regex: '^/nexus/enf\\-routes/invoices$',
          },
          {
            method: 'GET',
            path_template: '/nexus/enf-routes/invoices/{id}',
            path_regex: '^/nexus/enf\\-routes/invoices/[^/]+$',
          },
        ],
      });

      // The proxy carries the ownership stamp, and the generated validator is
      // associated alongside the plugins Nexus attached by hand.
      assert.ok(storedProxy(harness, proxyId).api_spec_id);
      assert.deepEqual(effectiveNames(harness, proxyId), [
        'access_control',
        'key_auth',
        'openapi_validator',
      ]);
      assert.deepEqual(associatedIds(harness, proxyId), writtenIds(harness, proxyId));
    });

    it('strips Ferrum extensions the provider wrote into their own document', async () => {
      // A document is input, not configuration. One shipping its own
      // `x-ferrum-proxy` would otherwise repoint the backend, and
      // `x-ferrum-consumers` — which Edge rejects outright — would fail the
      // upload for a reason no provider could act on.
      const hostile = JSON.stringify({
        openapi: '3.1.0',
        info: { title: 'Hostile API', version: '1.0.0' },
        servers: [{ url: 'https://billing.example.com:8443/v2' }],
        'x-ferrum-proxy': { id: 'attacker-proxy', backend_host: 'evil.example.com' },
        'x-ferrum-consumers': [{ username: 'attacker' }],
        'x-ferrum-validate': { fail_on_unknown_operation: false },
        paths: { '/invoices': { get: { responses: { '200': { description: 'OK' } } } } },
      });
      const response = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({
          slug: 'enf-hostile',
          spec: hostile,
          spec_enforcement: 'routes',
        }),
      });
      assert.equal(response.statusCode, 201, response.body);
      const proxyId = String(response.json<PublishApiResponse>().api.ferrum_proxy_id);

      const document = submittedDocument(proxyId);
      assert.equal(document['x-ferrum-consumers'], undefined);
      assert.equal(
        (document['x-ferrum-proxy'] as Record<string, unknown>).backend_host,
        'billing.example.com',
      );
      assert.equal(
        (document['x-ferrum-validate'] as Record<string, unknown>).fail_on_unknown_operation,
        true,
      );
      assert.equal(storedProxy(harness, proxyId).backend_host, 'billing.example.com');
    });

    it('declares no OPTIONS operations for an API with a CORS policy', async () => {
      // `cors` runs at priority 100 and `openapi_validator` at 2960, and
      // `preflight_continue` defaults to false, so the preflight is answered
      // and short-circuited long before the unknown-operation check. Synthetic
      // `OPTIONS` operations — and a method-wide bypass, which would also have
      // opened *undeclared* paths — are both unnecessary.
      const response = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({
          slug: 'enf-cors',
          spec_enforcement: 'routes',
          cors: { allowed_origins: ['https://app.example.com'], allow_credentials: false },
        }),
      });
      assert.equal(response.statusCode, 201, response.body);
      const proxyId = String(response.json<PublishApiResponse>().api.ferrum_proxy_id);
      assert.deepEqual(operationLabels(proxyId), [
        'GET /nexus/enf-cors/invoices',
        'GET /nexus/enf-cors/invoices/{id}',
      ]);
      assert.equal('bypass' in (validatorConfig(proxyId) ?? {}), false);
      // The preflight still has to survive the method allow-list, which Edge
      // checks before any plugin runs.
      assert.ok(effectiveNames(harness, proxyId).includes('cors'));
    });

    it('refuses routes for a document that declares no operations', async () => {
      const empty = JSON.stringify({
        openapi: '3.1.0',
        info: { title: 'Empty API', version: '1.0.0' },
        servers: [{ url: 'https://empty.example.com' }],
        paths: {},
      });
      const response = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({ slug: 'enf-empty', spec: empty, spec_enforcement: 'routes' }),
      });
      // Edge would generate an empty operation table with
      // `fail_on_unknown_operation: true` — a proxy that rejects *every*
      // request. Refusing up front is the honest third option.
      assert.equal(response.statusCode, 400, response.body);
      assert.equal(errorCode(response.body), 'SPEC_INVALID');
      assert.equal(harness.edge.proxyByName('nexus-enf-empty'), undefined);
      assert.equal(harness.edge.callsTo('POST', '/api-specs').length, 0);
    });

    it('rejects an enforcement level outside the enum', async () => {
      const response = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({ slug: 'enf-bogus', spec_enforcement: 'validate_bodies' }),
      });
      assert.equal(response.statusCode, 400, response.body);
      assert.equal(errorCode(response.body), 'VALIDATION_FAILED');
    });

    it('rebuilds the proxy under the same id when the level moves either way', async () => {
      const published = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({
          slug: 'enf-toggle',
          rate_limit: { limit: 100, window_seconds: 60 },
        }),
      });
      assert.equal(published.statusCode, 201, published.body);
      const apiId = published.json<PublishApiResponse>().api.id;
      const proxyId = String(published.json<PublishApiResponse>().api.ferrum_proxy_id);
      // Operator-set fields no part of Nexus's write shape: they only survive a
      // rebuild if the recreate echoes the whole proxy document.
      enrichProxy(harness, proxyId);
      const pluginIdsBefore = writtenIds(harness, proxyId);
      assert.equal(harness.edge.pluginForProxy(proxyId, 'openapi_validator'), undefined);

      const on = await harness.authed(provider, {
        method: 'PATCH',
        url: `/api/apis/${apiId}`,
        payload: { spec_enforcement: 'routes' },
      });
      assert.equal(on.statusCode, 200, on.body);
      assert.equal(on.json<UpdateApiResponse>().api.spec_enforcement, 'routes');
      assert.deepEqual(operationLabels(proxyId), [
        'GET /nexus/enf-toggle/invoices',
        'GET /nexus/enf-toggle/invoices/{id}',
      ]);
      // Same proxy id, same hand-owned plugin config ids: everything holding
      // one of those still resolves after the rebuild.
      assert.ok(storedProxy(harness, proxyId).api_spec_id);
      assertEnrichmentSurvived(harness, proxyId);
      assert.deepEqual(
        writtenIds(harness, proxyId)
          .filter((id) => pluginIdsBefore.includes(id))
          .sort(),
        pluginIdsBefore,
      );
      assert.deepEqual(effectiveNames(harness, proxyId), [
        'access_control',
        'key_auth',
        'openapi_validator',
        'rate_limiting',
      ]);

      const off = await harness.authed(provider, {
        method: 'PATCH',
        url: `/api/apis/${apiId}`,
        payload: { spec_enforcement: 'docs_only' },
      });
      assert.equal(off.statusCode, 200, off.body);
      assert.equal(off.json<UpdateApiResponse>().api.spec_enforcement, 'docs_only');
      // The spec, its stamp and the validator all go; everything else stays.
      assert.equal(harness.edge.apiSpecForProxy(proxyId), undefined);
      assert.equal(storedProxy(harness, proxyId).api_spec_id, undefined);
      assert.equal(harness.edge.pluginForProxy(proxyId, 'openapi_validator'), undefined);
      assertEnrichmentSurvived(harness, proxyId);
      assert.deepEqual(writtenIds(harness, proxyId), pluginIdsBefore);
      assert.deepEqual(associatedIds(harness, proxyId), writtenIds(harness, proxyId));
      assert.deepEqual(effectiveNames(harness, proxyId), [
        'access_control',
        'key_auth',
        'rate_limiting',
      ]);
    });

    it('carries a palette plugin across a mode conversion', async () => {
      const published = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({ slug: 'enf-palette' }),
      });
      const apiId = published.json<PublishApiResponse>().api.id;
      const proxyId = String(published.json<PublishApiResponse>().api.ferrum_proxy_id);

      const added = await harness.authed(provider, {
        method: 'PUT',
        url: `/api/apis/${apiId}/plugins/security_headers`,
        payload: { enabled: true, config: {} },
      });
      assert.equal(added.statusCode, 200, added.body);
      const paletteId = String(harness.edge.pluginForProxy(proxyId, 'security_headers')?.id);

      const on = await harness.authed(provider, {
        method: 'PATCH',
        url: `/api/apis/${apiId}`,
        payload: { spec_enforcement: 'routes' },
      });
      assert.equal(on.statusCode, 200, on.body);

      // The palette row is the portal's record of it; the gateway has to still
      // be running the same config, under the same id the row's lookup finds.
      assert.equal(String(harness.edge.pluginForProxy(proxyId, 'security_headers')?.id), paletteId);
      assert.ok(effectiveNames(harness, proxyId).includes('security_headers'));
      const listed = await harness.authed(provider, {
        method: 'GET',
        url: `/api/apis/${apiId}/plugins`,
      });
      assert.equal(listed.statusCode, 200, listed.body);
      assert.match(listed.body, /security_headers/);
    });

    it('leaves the spec untouched when a CORS change lands on a routes API', async () => {
      const published = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({ slug: 'enf-cors-patch', spec_enforcement: 'routes' }),
      });
      assert.equal(published.statusCode, 201, published.body);
      const apiId = published.json<PublishApiResponse>().api.id;
      const proxyId = String(published.json<PublishApiResponse>().api.ferrum_proxy_id);
      const specId = harness.edge.apiSpecForProxy(proxyId)?.id;
      const validatorId = String(harness.edge.pluginForProxy(proxyId, 'openapi_validator')?.id);
      // The publish already replaced the spec once, to cut the proxy over from
      // its staging path onto `/nexus/enf-cors-patch`.
      const specWrites = harness.edge.callsTo('PUT', '/api-specs').length;

      const added = await harness.authed(provider, {
        method: 'PATCH',
        url: `/api/apis/${apiId}`,
        payload: {
          cors: { allowed_origins: ['https://app.example.com'], allow_credentials: false },
        },
      });
      assert.equal(added.statusCode, 200, added.body);

      // The operation table comes from the document alone now, so a CORS change
      // has nothing to regenerate — and re-importing the spec to discover that
      // would churn the validator for no reason.
      assert.equal(harness.edge.callsTo('PUT', '/api-specs').length, specWrites);
      assert.equal(harness.edge.apiSpecForProxy(proxyId)?.id, specId);
      assert.equal(
        String(harness.edge.pluginForProxy(proxyId, 'openapi_validator')?.id),
        validatorId,
      );
      assert.deepEqual(operationLabels(proxyId), [
        'GET /nexus/enf-cors-patch/invoices',
        'GET /nexus/enf-cors-patch/invoices/{id}',
      ]);
      // `OPTIONS` still has to reach the `cors` plugin, which Edge checks on the
      // proxy before any plugin runs.
      assert.ok(
        (storedProxy(harness, proxyId).allowed_methods as string[] | null)?.includes('OPTIONS') ??
          true,
      );
    });

    it('leaves the validator alone when a CORS change lands on a docs_only API', async () => {
      const published = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({ slug: 'enf-cors-docs' }),
      });
      const apiId = published.json<PublishApiResponse>().api.id;
      const proxyId = String(published.json<PublishApiResponse>().api.ferrum_proxy_id);

      const patched = await harness.authed(provider, {
        method: 'PATCH',
        url: `/api/apis/${apiId}`,
        payload: {
          cors: { allowed_origins: ['https://app.example.com'], allow_credentials: false },
        },
      });
      assert.equal(patched.statusCode, 200, patched.body);
      assert.equal(harness.edge.pluginForProxy(proxyId, 'openapi_validator'), undefined);
      assert.equal(harness.edge.apiSpecForProxy(proxyId), undefined);
    });

    it('undoes the conversion when a later step of the PATCH fails', async () => {
      const published = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({ slug: 'enf-undo' }),
      });
      const apiId = published.json<PublishApiResponse>().api.id;
      const proxyId = String(published.json<PublishApiResponse>().api.ferrum_proxy_id);
      const before = associatedIds(harness, proxyId);

      failNextApiUpdate(harness, 'store offline');
      const response = await harness.authed(provider, {
        method: 'PATCH',
        url: `/api/apis/${apiId}`,
        payload: { spec_enforcement: 'routes' },
      });
      assert.equal(response.statusCode, 500, response.body);

      // The rebuild has to be rolled back the same way the plugin attach used
      // to be: no spec, no validator, the same association list, and a row that
      // still says docs_only.
      assert.equal(harness.edge.apiSpecForProxy(proxyId), undefined);
      assert.equal(harness.edge.pluginForProxy(proxyId, 'openapi_validator'), undefined);
      assert.deepEqual(associatedIds(harness, proxyId), before);
      assert.deepEqual(effectiveNames(harness, proxyId), ['access_control', 'key_auth']);
      const reread = await harness.authed(provider, { method: 'GET', url: `/api/apis/${apiId}` });
      assert.equal(reread.json<GetApiResponse>().api.spec_enforcement, 'docs_only');
    });

    /**
     * Plugin config ids Nexus owns by hand, sorted.
     *
     * The spec-owned `openapi_validator` is left out because Edge regenerates
     * it — with a fresh id — every time a document is imported, so it is the
     * one config whose id is *not* expected to survive a rebuild.
     */
    function handOwnedIds(proxyId: string): string[] {
      return harness.edge
        .pluginsForProxy(proxyId)
        .filter((plugin) => plugin.plugin_name !== 'openapi_validator')
        .map((plugin) => String(plugin.id))
        .sort();
    }

    /**
     * Break one step of a `spec_enforcement` conversion and assert the API it
     * started from came back whole.
     *
     * The conversion deletes the live proxy before rebuilding it, so every one
     * of these failures used to end with no proxy at all: the portal still
     * described the API, the gateway served nothing, and retrying the same
     * PATCH answered `404` because the rebuild it wanted to undo was gone.
     *
     * @param from the mode the API is published in; the PATCH moves it to the other
     * @param inject queues the gateway failure, once the API exists
     */
    async function assertConversionRestores(
      slug: string,
      from: 'docs_only' | 'routes',
      inject: () => void,
    ): Promise<void> {
      const to = from === 'routes' ? 'docs_only' : 'routes';
      const published = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({ slug, spec_enforcement: from }),
      });
      assert.equal(published.statusCode, 201, published.body);
      const apiId = published.json<PublishApiResponse>().api.id;
      const proxyId = String(published.json<PublishApiResponse>().api.ferrum_proxy_id);
      const finalPath = `/nexus/${slug}`;
      // Operator-set fields, so the restore has to be the captured document and
      // not a body composed from the `apis` row.
      enrichProxy(harness, proxyId);
      const idsBefore = handOwnedIds(proxyId);
      const runningBefore = effectiveNames(harness, proxyId);

      inject();
      const failed = await harness.authed(provider, {
        method: 'PATCH',
        url: `/api/apis/${apiId}`,
        payload: { spec_enforcement: to },
      });
      assert.equal(failed.statusCode, 502, failed.body);

      // One proxy, under the same id, back on the real path — and nothing
      // parked on a staging path.
      assert.equal(harness.edge.proxies.size, 1, 'no staging proxy was left behind');
      assert.equal(String(harness.edge.proxyServing(finalPath)?.id), proxyId);
      assert.equal(
        harness.edge.apiSpecForProxy(proxyId) !== undefined,
        from === 'routes',
        'the original enforcement mode is what the gateway holds',
      );
      assertEnrichmentSurvived(harness, proxyId);
      assert.deepEqual(handOwnedIds(proxyId), idsBefore, 'the hand-owned configs kept their ids');
      assert.deepEqual(associatedIds(harness, proxyId), writtenIds(harness, proxyId));
      assert.deepEqual(effectiveNames(harness, proxyId), runningBefore);
      assert.ok(runningBefore.includes('key_auth'), 'the API is still authenticated');

      const reread = await harness.authed(provider, { method: 'GET', url: `/api/apis/${apiId}` });
      assert.equal(reread.json<GetApiResponse>().api.spec_enforcement, from);

      // And the same PATCH works once the gateway is healthy again.
      const retry = await harness.authed(provider, {
        method: 'PATCH',
        url: `/api/apis/${apiId}`,
        payload: { spec_enforcement: to },
      });
      assert.equal(retry.statusCode, 200, retry.body);
      assert.equal(retry.json<UpdateApiResponse>().api.spec_enforcement, to);
      assert.equal(String(harness.edge.proxyServing(finalPath)?.id), proxyId);
      assert.equal(harness.edge.proxies.size, 1);
    }

    it('restores docs_only when the routes replacement cannot be created', async () => {
      await assertConversionRestores('enf-fail-create-routes', 'docs_only', () =>
        harness.edge.queueFailure(503, { error: 'unavailable' }, '/api-specs', 'POST'),
      );
    });

    it('restores docs_only when a plugin cannot be put back', async () => {
      await assertConversionRestores('enf-fail-plugin-routes', 'docs_only', () =>
        harness.edge.queueFailure(500, { error: 'config_rejected' }, '/plugins/config', 'POST'),
      );
    });

    it('restores docs_only when the second plugin cannot be put back', async () => {
      await assertConversionRestores('enf-fail-plugin2-routes', 'docs_only', () =>
        harness.edge.queueFailure(500, { error: 'config_rejected' }, '/plugins/config', 'POST', 1),
      );
    });

    it('restores docs_only when the association write fails', async () => {
      await assertConversionRestores('enf-fail-assoc-routes', 'docs_only', () =>
        harness.edge.queueFailure(500, { error: 'config_rejected' }, '/proxies/', 'PUT'),
      );
    });

    it('restores docs_only when the routes cutover fails', async () => {
      await assertConversionRestores('enf-fail-cutover-routes', 'docs_only', () =>
        harness.edge.queueFailure(500, { error: 'spec rejected' }, '/api-specs/', 'PUT'),
      );
    });

    it('restores routes when the docs_only replacement cannot be created', async () => {
      await assertConversionRestores('enf-fail-create-docs', 'routes', () =>
        harness.edge.queueFailure(503, { error: 'unavailable' }, '/proxies', 'POST'),
      );
    });

    it('restores routes when a plugin cannot be put back', async () => {
      await assertConversionRestores('enf-fail-plugin-docs', 'routes', () =>
        harness.edge.queueFailure(500, { error: 'config_rejected' }, '/plugins/config', 'POST'),
      );
    });

    it('restores routes when the association write fails', async () => {
      await assertConversionRestores('enf-fail-assoc-docs', 'routes', () =>
        harness.edge.queueFailure(500, { error: 'config_rejected' }, '/proxies/', 'PUT'),
      );
    });

    it('restores routes when the docs_only cutover fails', async () => {
      // The association is the first `PUT /proxies/{id}` of the rebuild and the
      // cutover the second, so the failure skips one to land on the cutover.
      await assertConversionRestores('enf-fail-cutover-docs', 'routes', () =>
        harness.edge.queueFailure(500, { error: 'config_rejected' }, '/proxies/', 'PUT', 1),
      );
    });

    it('records a repair state when the restoration fails as well', async () => {
      const published = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({ slug: 'enf-unrepairable' }),
      });
      assert.equal(published.statusCode, 201, published.body);
      const apiId = published.json<PublishApiResponse>().api.id;
      const proxyId = String(published.json<PublishApiResponse>().api.ferrum_proxy_id);

      // Both rebuilds fail: the conversion into `routes` and the restore back.
      harness.edge.queueFailure(503, { error: 'unavailable' }, '/api-specs', 'POST');
      harness.edge.queueFailure(503, { error: 'unavailable' }, '/proxies', 'POST');
      const failed = await harness.authed(provider, {
        method: 'PATCH',
        url: `/api/apis/${apiId}`,
        payload: { spec_enforcement: 'routes' },
      });
      assert.equal(failed.statusCode, 502, failed.body);

      // The snapshot the gateway lost is the only copy there was, so it is
      // written where an administrator can find and act on it.
      const row = (await harness.auditRows('api.gateway_repair_required')).find(
        (entry) => entry.target_id === apiId,
      );
      assert.ok(row, 'a repair-required audit row is recorded');
      assert.equal(row?.details.spec_enforcement, 'docs_only');
      assert.equal(row?.details.attempted_spec_enforcement, 'routes');
      assert.equal((row?.details.proxy as Record<string, unknown>).id, proxyId);
      assert.equal(
        (row?.details.proxy as Record<string, unknown>).listen_path,
        '/nexus/enf-unrepairable',
      );
      assert.ok(Array.isArray(row?.details.plugin_configs));
    });

    it('regenerates the operation table when a new spec revision is published', async () => {
      const published = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({ slug: 'enf-spec', spec_enforcement: 'routes' }),
      });
      assert.equal(published.statusCode, 201, published.body);
      const apiId = published.json<PublishApiResponse>().api.id;
      const proxyId = String(published.json<PublishApiResponse>().api.ferrum_proxy_id);
      const specId = harness.edge.apiSpecForProxy(proxyId)?.id;
      const authId = String(harness.edge.pluginForProxy(proxyId, 'key_auth')?.id);
      enrichProxy(harness, proxyId);
      assert.deepEqual(operationLabels(proxyId), [
        'GET /nexus/enf-spec/invoices',
        'GET /nexus/enf-spec/invoices/{id}',
      ]);

      const revision = JSON.stringify({
        openapi: '3.1.0',
        info: { title: 'Billing API', version: '3.0.0' },
        servers: [{ url: 'https://billing.example.com:8443/v2' }],
        paths: {
          '/invoices': { get: { responses: { '200': { description: 'OK' } } } },
          '/payments': {
            get: { responses: { '200': { description: 'OK' } } },
            post: { responses: { '201': { description: 'Created' } } },
          },
        },
      });
      const updated = await harness.authed(provider, {
        method: 'PUT',
        url: `/api/apis/${apiId}/spec`,
        payload: { spec: revision },
      });
      assert.equal(updated.statusCode, 200, updated.body);

      // The removed path is gone from the enforced surface and the new ones are
      // in it — a stale table would keep allowing `/invoices/{id}`.
      assert.deepEqual(operationLabels(proxyId), [
        'GET /nexus/enf-spec/invoices',
        'GET /nexus/enf-spec/payments',
        'POST /nexus/enf-spec/payments',
      ]);
      assert.deepEqual(submittedDocument(proxyId).servers, [{ url: '/nexus/enf-spec' }]);
      // The spec keeps its id; the validator it owns is regenerated, so that one
      // does not — and there is still exactly one of it.
      assert.equal(harness.edge.apiSpecForProxy(proxyId)?.id, specId);
      assert.equal(
        harness.edge
          .pluginsForProxy(proxyId)
          .filter((plugin) => plugin.plugin_name === 'openapi_validator').length,
        1,
      );
      // A replace re-inserts the proxy from `x-ferrum-proxy`, so everything on
      // it has to have been echoed back — including what an operator set.
      assertEnrichmentSurvived(harness, proxyId);
      // Hand-owned plugins are not the spec's to touch: the API is never
      // unauthenticated across the replace.
      assert.equal(String(harness.edge.pluginForProxy(proxyId, 'key_auth')?.id), authId);
      assert.deepEqual(effectiveNames(harness, proxyId), [
        'access_control',
        'key_auth',
        'openapi_validator',
      ]);
      assert.deepEqual(associatedIds(harness, proxyId), writtenIds(harness, proxyId));
    });

    it('moves the backend in the same write that regenerates the table', async () => {
      const published = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({ slug: 'enf-move', spec_enforcement: 'routes' }),
      });
      const apiId = published.json<PublishApiResponse>().api.id;
      const proxyId = String(published.json<PublishApiResponse>().api.ferrum_proxy_id);
      // The publish already wrote the proxy once, to associate its plugins, and
      // replaced the spec once, to cut it over from its staging path.
      const proxyWrites = harness.edge.callsTo('PUT', `/proxies/${proxyId}`).length;
      const specWrites = harness.edge.callsTo('PUT', '/api-specs').length;

      const updated = await harness.authed(provider, {
        method: 'PUT',
        url: `/api/apis/${apiId}/spec`,
        payload: { spec: specWithServer('https://moved.example.com:9443/v3', '4.0.0') },
      });
      assert.equal(updated.statusCode, 200, updated.body);

      // One call, not a spec replace plus a proxy `PUT` the replace would then
      // undo — the replace re-inserts the proxy from `x-ferrum-proxy` anyway.
      assert.equal(harness.edge.callsTo('PUT', '/api-specs').length, specWrites + 1);
      assert.equal(harness.edge.callsTo('PUT', `/proxies/${proxyId}`).length, proxyWrites);
      const proxy = storedProxy(harness, proxyId);
      assert.equal(proxy.backend_host, 'moved.example.com');
      assert.equal(proxy.backend_port, 9443);
      assert.equal(proxy.backend_path, '/v3');
      assert.equal(
        (submittedDocument(proxyId)['x-ferrum-proxy'] as Record<string, unknown>).backend_host,
        'moved.example.com',
      );
    });

    it('writes no validator on a spec revision of a docs_only API', async () => {
      const published = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({ slug: 'enf-spec-docs' }),
      });
      const apiId = published.json<PublishApiResponse>().api.id;
      const proxyId = String(published.json<PublishApiResponse>().api.ferrum_proxy_id);

      const updated = await harness.authed(provider, {
        method: 'PUT',
        url: `/api/apis/${apiId}/spec`,
        payload: { spec: specWithServer('https://billing.example.com:8443/v2', '3.0.0') },
      });
      assert.equal(updated.statusCode, 200, updated.body);
      assert.equal(harness.edge.pluginForProxy(proxyId, 'openapi_validator'), undefined);
      assert.equal(harness.edge.apiSpecForProxy(proxyId), undefined);
      assert.equal(harness.edge.callsTo('PUT', '/api-specs').length, 0);
    });

    it('restores the previous document when the revision cannot be persisted', async () => {
      const published = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({ slug: 'enf-spec-undo', spec_enforcement: 'routes' }),
      });
      const apiId = published.json<PublishApiResponse>().api.id;
      const proxyId = String(published.json<PublishApiResponse>().api.ferrum_proxy_id);

      failNextTransaction(harness, 'store offline');
      const response = await harness.authed(provider, {
        method: 'PUT',
        url: `/api/apis/${apiId}/spec`,
        payload: {
          spec: JSON.stringify({
            openapi: '3.1.0',
            info: { title: 'Billing API', version: '9.9.9' },
            servers: [{ url: 'https://elsewhere.example.com:9443/v9' }],
            paths: { '/payments': { get: { responses: { '200': { description: 'OK' } } } } },
          }),
        },
      });
      assert.equal(response.statusCode, 500, response.body);

      // The gateway moved first, so the compensation has to put the document
      // back: otherwise the proxy would enforce — and forward to — a revision
      // the catalog never adopted.
      assert.deepEqual(operationLabels(proxyId), [
        'GET /nexus/enf-spec-undo/invoices',
        'GET /nexus/enf-spec-undo/invoices/{id}',
      ]);
      assert.equal(storedProxy(harness, proxyId).backend_host, 'billing.example.com');
      assert.deepEqual(effectiveNames(harness, proxyId), [
        'access_control',
        'key_auth',
        'openapi_validator',
      ]);
    });

    it('takes the spec and its validator down with the API', async () => {
      const published = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({ slug: 'enf-delete', spec_enforcement: 'routes' }),
      });
      const apiId = published.json<PublishApiResponse>().api.id;
      const proxyId = String(published.json<PublishApiResponse>().api.ferrum_proxy_id);
      assert.ok(harness.edge.pluginForProxy(proxyId, 'openapi_validator'));
      assert.ok(harness.edge.apiSpecForProxy(proxyId));

      const removed = await harness.authed(provider, {
        method: 'DELETE',
        url: `/api/apis/${apiId}`,
      });
      assert.equal(removed.statusCode, 200, removed.body);
      assert.equal(harness.edge.pluginsForProxy(proxyId).length, 0);
      assert.equal(harness.edge.apiSpecForProxy(proxyId), undefined);
      assert.equal(harness.edge.proxies.get(`nexus/${proxyId}`), undefined);
    });

    it('rolls the spec back when a later publish step fails', async () => {
      failNextTransaction(harness, 'store offline');
      const response = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({ slug: 'enf-publish-undo', spec_enforcement: 'routes' }),
      });
      assert.equal(response.statusCode, 500, response.body);

      // Deleting the proxy cascades the spec and the validator it generated, so
      // a failed `routes` publish leaves nothing at all behind.
      assert.equal(harness.edge.proxyByName('nexus-enf-publish-undo'), undefined);
      assert.equal(harness.edge.apiSpecs.size, 0);
      assert.equal(harness.edge.pluginConfigs.size, 0);
    });

    it('refuses a hand-built openapi_validator on a proxy with no attached spec', async () => {
      // The regression guard for issue #49. Nexus no longer writes one, so this
      // drives the gateway surface directly: if the mock ever accepts an inline
      // operations table again, CI would go green on a shape every real gateway
      // rejects.
      const published = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({ slug: 'enf-admission' }),
      });
      const proxyId = String(published.json<PublishApiResponse>().api.ferrum_proxy_id);

      await assert.rejects(
        () =>
          harness.edgeClient.pluginConfigs.create({
            plugin_name: 'openapi_validator',
            scope: 'proxy',
            proxy_id: proxyId,
            enabled: true,
            config: {
              enforcement_mode: 'block',
              validate_request: false,
              validate_response: false,
              fail_on_unknown_operation: true,
              operations: [
                {
                  method: 'GET',
                  path_template: '/nexus/enf-admission/invoices',
                  path_regex: '^/nexus/enf\\-admission/invoices$',
                },
              ],
            },
          }),
        (error: unknown) =>
          /openapi_validator requires a proxy with an attached api_spec/.test(
            (error as Error).message,
          ),
      );
    });
  });

  /* ── The staged listen-path cutover ───────────────────────────────────
   *
   * GHSA-gxvf-jj3q-x4fc: Edge serves a proxy the instant it exists, and the
   * plugin configs attached afterwards are inert until the association write,
   * so `/<namespace>/<slug>` used to be live, open and unlimited for the
   * round trips in between. The fix is not an ordering change — Edge refuses a
   * plugin config for a proxy that does not exist, and `allowed_methods` must
   * be non-empty, so there is no deny-all proxy to create first. Instead every
   * proxy is built on an unguessable staging path and *moved* onto the real one
   * as the last gateway write.
   *
   * These tests assert that property directly against the transcript, and the
   * failure ones assert the thing that actually matters: the deterministic path
   * is never taken by a proxy that is not finished.
   */
  describe('staged listen-path cutover', () => {
    /** `/nexus/.staging/<128 bits of hex>` — see `stagingListenPath`. */
    const STAGING_PATH = /^\/nexus\/\.staging\/[0-9a-f]{32}$/;

    /** One recorded gateway write that put a proxy on a listen path. */
    interface PathWrite {
      /** Index in `harness.edge.requests`, so writes can be ordered. */
      at: number;
      /** `METHOD /path`, for readable assertion failures. */
      call: string;
      listenPath: string;
    }

    /**
     * Every recorded write that decides where a proxy is served, in order.
     *
     * Four calls can: `POST /proxies`, `PUT /proxies/{id}` (a whole-resource
     * replace, so the association write carries a listen path too), and both
     * `/api-specs` writes, which re-insert the proxy from `x-ferrum-proxy`.
     */
    function listenPathWrites(from = 0): PathWrite[] {
      const writes: PathWrite[] = [];
      harness.edge.requests.forEach((request, at) => {
        if (at < from) return;
        if (request.method !== 'POST' && request.method !== 'PUT') return;
        const body = request.body;
        if (typeof body !== 'object' || body === null) return;
        const fields = body as Record<string, unknown>;
        const proxy = request.path.startsWith('/api-specs') ? fields['x-ferrum-proxy'] : fields;
        if (typeof proxy !== 'object' || proxy === null) return;
        const listenPath = (proxy as Record<string, unknown>).listen_path;
        if (typeof listenPath !== 'string') return;
        writes.push({ at, call: `${request.method} ${request.path}`, listenPath });
      });
      return writes;
    }

    /**
     * Assert the staged sequence: exactly one write put a proxy on `finalPath`,
     * it was the **last** of the listen-path writes, and every earlier one was
     * on a staging path.
     *
     * @returns the cutover write, so a caller can check which call it was and
     * that nothing at all followed it.
     */
    function assertStagedCutover(finalPath: string, from = 0): PathWrite {
      const writes = listenPathWrites(from);
      assert.ok(writes.length >= 2, 'expected a staged create and a cutover');
      const onFinal = writes.filter((write) => write.listenPath === finalPath);
      assert.equal(onFinal.length, 1, `expected exactly one write onto ${finalPath}`);
      const cutover = onFinal[0] as PathWrite;
      assert.equal(
        cutover.at,
        (writes[writes.length - 1] as PathWrite).at,
        'the move onto the real path must be the last listen-path write',
      );
      for (const write of writes) {
        if (write.at === cutover.at) continue;
        assert.match(write.listenPath, STAGING_PATH, `${write.call} must be on a staging path`);
      }
      return cutover;
    }

    /** Indexes of every `POST /plugins/config` in the transcript. */
    function pluginCreateIndexes(from = 0): number[] {
      return harness.edge.requests
        .map((request, at) => ({ request, at }))
        .filter(
          ({ request, at }) =>
            at >= from && request.method === 'POST' && request.path === '/plugins/config',
        )
        .map(({ at }) => at);
    }

    beforeEach(() => {
      harness.edge.reset();
    });

    it('publishes a docs_only API on a staging path and moves it last', async () => {
      const response = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({
          slug: 'stage-docs',
          rate_limit: { limit: 60, window_seconds: 60 },
          cors: { allowed_origins: ['https://app.example.com'], allow_credentials: false },
        }),
      });
      assert.equal(response.statusCode, 201, response.body);
      const proxyId = String(response.json<PublishApiResponse>().api.ferrum_proxy_id);
      const finalPath = '/nexus/stage-docs';

      const writes = listenPathWrites();
      assert.equal(writes[0]?.call, 'POST /proxies');
      assert.match(String(writes[0]?.listenPath), STAGING_PATH);

      const cutover = assertStagedCutover(finalPath);
      assert.equal(cutover.call, `PUT /proxies/${proxyId}`);
      // Nothing at all followed it — not another proxy write, not a plugin.
      assert.equal(cutover.at, harness.edge.requests.length - 1);
      // Every plugin config was created while the proxy was still staged, and
      // so was the association write that made them run.
      for (const at of pluginCreateIndexes()) assert.ok(at < cutover.at);
      const association = writes.find(
        (write) => write.call === `PUT /proxies/${proxyId}` && write.at < cutover.at,
      );
      assert.ok(association, 'expected the association write to precede the cutover');

      // End state: the real path, fully gated, and the staging path gone.
      assert.equal(String(harness.edge.proxyServing(finalPath)?.id), proxyId);
      assert.equal(harness.edge.proxyServing(String(writes[0]?.listenPath)), undefined);
      assert.deepEqual(effectiveNames(harness, proxyId), [
        'access_control',
        'cors',
        'key_auth',
        'rate_limiting',
      ]);
      assert.deepEqual(associatedIds(harness, proxyId), writtenIds(harness, proxyId));
    });

    it('publishes a routes API on a staging path and moves it with the spec', async () => {
      const response = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({ slug: 'stage-routes', spec_enforcement: 'routes' }),
      });
      assert.equal(response.statusCode, 201, response.body);
      const proxyId = String(response.json<PublishApiResponse>().api.ferrum_proxy_id);
      const finalPath = '/nexus/stage-routes';
      const specId = String(harness.edge.apiSpecForProxy(proxyId)?.id);

      const writes = listenPathWrites();
      assert.equal(writes[0]?.call, 'POST /api-specs');
      assert.match(String(writes[0]?.listenPath), STAGING_PATH);

      const cutover = assertStagedCutover(finalPath);
      assert.equal(cutover.call, `PUT /api-specs/${specId}`);
      assert.equal(cutover.at, harness.edge.requests.length - 1);
      for (const at of pluginCreateIndexes()) assert.ok(at < cutover.at);

      // The importer prefixes every generated matcher with `servers[0]`, so the
      // rewrite has to move in the same write or the validator would reject
      // every request on the new path as an unknown operation.
      const document = harness.edge.apiSpecForProxy(proxyId)?.document ?? {};
      assert.deepEqual(document.servers, [{ url: finalPath }]);
      const operations = harness.edge.pluginForProxy(proxyId, 'openapi_validator')?.config as
        { operations?: { method: string; path_template: string }[] } | undefined;
      assert.deepEqual(
        (operations?.operations ?? []).map((entry) => `${entry.method} ${entry.path_template}`),
        ['GET /nexus/stage-routes/invoices', 'GET /nexus/stage-routes/invoices/{id}'],
      );
      assert.equal(String(harness.edge.proxyServing(finalPath)?.id), proxyId);
      assert.equal(harness.edge.proxyServing(String(writes[0]?.listenPath)), undefined);
      // The spec kept its id across the move, and the hand-owned plugins kept
      // their associations alongside the regenerated validator.
      assert.equal(harness.edge.callsTo('POST', '/api-specs').length, 1);
      assert.deepEqual(effectiveNames(harness, proxyId), [
        'access_control',
        'key_auth',
        'openapi_validator',
      ]);
      assert.deepEqual(associatedIds(harness, proxyId), writtenIds(harness, proxyId));
    });

    /**
     * Every failure mode has the same acceptance criterion: whatever went
     * wrong, no proxy is left on the deterministic path, and the staging proxy
     * is gone too.
     */
    function assertNothingLeftBehind(slug: string): void {
      assert.equal(
        harness.edge.proxyServing(`/nexus/${slug}`),
        undefined,
        'the real listen path must not be served by anything',
      );
      assert.equal(harness.edge.proxyByName(`nexus-${slug}`), undefined);
      assert.equal(harness.edge.proxies.size, 0, 'the staging proxy must be deleted');
      assert.equal(harness.edge.apiSpecs.size, 0);
    }

    it('takes the real path for nothing when a plugin config is rejected', async () => {
      harness.edge.queueFailure(400, { error: 'key_auth: bad config' }, '/plugins/config', 'POST');
      const response = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({ slug: 'stage-fail-plugin' }),
      });
      assert.equal(response.statusCode, 502, response.body);
      // The transcript never even names the real path: the publish died before
      // the cutover, so nothing was ever asked to serve it.
      assert.equal(
        listenPathWrites().filter((write) => write.listenPath === '/nexus/stage-fail-plugin')
          .length,
        0,
      );
      assertNothingLeftBehind('stage-fail-plugin');
    });

    it('takes the real path for nothing when the association write fails', async () => {
      // The association is the second `PUT /proxies/{id}` — there is no earlier
      // one — so a queued `PUT` failure lands on exactly it.
      harness.edge.queueFailure(500, { error: 'config_rejected' }, '/proxies/', 'PUT');
      const response = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({ slug: 'stage-fail-assoc' }),
      });
      assert.equal(response.statusCode, 502, response.body);
      assert.equal(
        listenPathWrites().filter((write) => write.listenPath === '/nexus/stage-fail-assoc').length,
        0,
      );
      assertNothingLeftBehind('stage-fail-assoc');
    });

    it('takes the real path for nothing when the cutover itself is refused', async () => {
      // A real 409: Edge rejects a listen path another proxy already serves, and
      // the mock's uniqueness check — which excludes the proxy being written —
      // does the same. This is the one failure that happens *during* the write
      // that would have opened the path.
      harness.edge.proxies.set('nexus/squatter', {
        id: 'squatter',
        name: 'operator-owned',
        namespace: 'nexus',
        listen_path: '/nexus/stage-fail-cutover',
        backend_scheme: 'https',
        backend_host: 'elsewhere.example.com',
        backend_port: 443,
      });

      const response = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({ slug: 'stage-fail-cutover' }),
      });
      assert.equal(response.statusCode, 502, response.body);

      // The cutover was attempted and refused, so the path still belongs to the
      // proxy that already had it — and the staging proxy is gone.
      assert.equal(
        listenPathWrites().filter((write) => write.listenPath === '/nexus/stage-fail-cutover')
          .length,
        1,
      );
      assert.equal(String(harness.edge.proxyServing('/nexus/stage-fail-cutover')?.id), 'squatter');
      assert.equal(harness.edge.proxyByName('nexus-stage-fail-cutover'), undefined);
      assert.equal(harness.edge.proxies.size, 1);

      // And nothing landed on the Nexus side either, so the slug is still free.
      harness.edge.proxies.delete('nexus/squatter');
      const retry = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({ slug: 'stage-fail-cutover' }),
      });
      assert.equal(retry.statusCode, 201, retry.body);
    });

    it('takes the real path for nothing when a routes cutover fails', async () => {
      harness.edge.queueFailure(500, { error: 'spec rejected' }, '/api-specs/', 'PUT');
      const response = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({ slug: 'stage-fail-spec', spec_enforcement: 'routes' }),
      });
      assert.equal(response.statusCode, 502, response.body);
      assertNothingLeftBehind('stage-fail-spec');
    });

    it('stages the rebuild when the enforcement level moves in either direction', async () => {
      const published = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({ slug: 'stage-switch' }),
      });
      assert.equal(published.statusCode, 201, published.body);
      const apiId = published.json<PublishApiResponse>().api.id;
      const proxyId = String(published.json<PublishApiResponse>().api.ferrum_proxy_id);
      const finalPath = '/nexus/stage-switch';

      for (const level of ['routes', 'docs_only'] as const) {
        const from = harness.edge.requests.length;
        const patched = await harness.authed(provider, {
          method: 'PATCH',
          url: `/api/apis/${apiId}`,
          payload: { spec_enforcement: level },
        });
        assert.equal(patched.statusCode, 200, patched.body);

        // The conversion deletes and recreates the proxy; the recreate lands on
        // a fresh staging path, so the real one answers 404 for the whole
        // rebuild rather than answering *open*.
        const cutover = assertStagedCutover(finalPath, from);
        assert.equal(cutover.at, harness.edge.requests.length - 1);
        for (const at of pluginCreateIndexes(from)) assert.ok(at < cutover.at);
        assert.equal(String(harness.edge.proxyServing(finalPath)?.id), proxyId);
        assert.deepEqual(associatedIds(harness, proxyId), writtenIds(harness, proxyId));
      }

      assert.deepEqual(effectiveNames(harness, proxyId), ['access_control', 'key_auth']);
    });

    it('stages the undo when a later step of the conversion PATCH fails', async () => {
      const published = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({ slug: 'stage-undo' }),
      });
      const apiId = published.json<PublishApiResponse>().api.id;
      const proxyId = String(published.json<PublishApiResponse>().api.ferrum_proxy_id);
      const finalPath = '/nexus/stage-undo';
      const before = associatedIds(harness, proxyId);

      const from = harness.edge.requests.length;
      failNextApiUpdate(harness, 'store offline');
      const response = await harness.authed(provider, {
        method: 'PATCH',
        url: `/api/apis/${apiId}`,
        payload: { spec_enforcement: 'routes' },
      });
      assert.equal(response.statusCode, 500, response.body);

      // Two rebuilds — into `routes`, then back — and *both* of them staged.
      // The last write of the whole PATCH is the undo's cutover.
      const writes = listenPathWrites(from);
      const onFinal = writes.filter((write) => write.listenPath === finalPath);
      assert.equal(onFinal.length, 2, 'each rebuild ends with one move onto the real path');
      assert.equal((onFinal[1] as PathWrite).at, harness.edge.requests.length - 1);
      for (const write of writes) {
        if (onFinal.some((entry) => entry.at === write.at)) continue;
        assert.match(write.listenPath, STAGING_PATH, `${write.call} must be on a staging path`);
      }

      // Back exactly where it started: docs_only, no spec, same associations.
      assert.equal(harness.edge.apiSpecForProxy(proxyId), undefined);
      assert.equal(String(harness.edge.proxyServing(finalPath)?.id), proxyId);
      assert.deepEqual(associatedIds(harness, proxyId), before);
      assert.deepEqual(effectiveNames(harness, proxyId), ['access_control', 'key_auth']);
    });

    it('shows the provider the real path, never the staging one', async () => {
      const published = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({ slug: 'stage-invoke' }),
      });
      assert.equal(published.statusCode, 201, published.body);
      const api = published.json<PublishApiResponse>().api;
      assert.equal(api.listen_path, '/nexus/stage-invoke');
      // `invoke_url`, when the deployment has a gateway URL configured, is the
      // real path too — a staging path must never escape into the portal.
      if (api.invoke_url !== null) assert.match(api.invoke_url, /\/nexus\/stage-invoke$/);

      const detail = await harness.authed(provider, {
        method: 'GET',
        url: `/api/apis/${api.id}`,
      });
      assert.equal(detail.json<GetApiResponse>().api.listen_path, '/nexus/stage-invoke');

      const audit = await harness.auditRows('api.publish');
      const row = audit.find((entry) => entry.target_id === api.id);
      assert.equal(row?.details.listen_path, '/nexus/stage-invoke');
    });
  });
});

describe('publishing with Redis-synced rate limits', () => {
  let harness: TestApp;
  let provider: TestSession;

  before(async () => {
    harness = await buildTestApp({
      env: {
        FERRUM_RATE_LIMIT_SYNC_MODE: 'redis',
        FERRUM_RATE_LIMIT_REDIS_URL: 'redis://cache.example.com:6379/2',
        FERRUM_RATE_LIMIT_REDIS_TLS: 'true',
      },
    });
    await harness.registerUser({ email: 'sync-founder@example.test' });
    provider = await harness.registerUser({
      email: 'sync-provider@example.test',
      role: 'provider',
    });
  });

  after(async () => {
    await harness.close();
  });

  it('stamps the endpoint onto the rate_limiting config, on publish and on PATCH', async () => {
    const published = await harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: publishPayload({
        slug: 'synced',
        rate_limit: { limit: 100, window_seconds: 60 },
      }),
    });
    assert.equal(published.statusCode, 201, published.body);
    const api = published.json<PublishApiResponse>().api;
    const proxyId = String(api.ferrum_proxy_id);

    // The exact body Edge receives: without `sync_mode`/`redis_url` the
    // counters would be per gateway process, so N replicas would enforce N×
    // the provider's quota.
    assert.deepEqual(harness.edge.pluginForProxy(proxyId, 'rate_limiting')?.config, {
      limit_by: 'consumer',
      expose_headers: true,
      limits: [{ scope: 'default', window_seconds: 60, max_requests: 100 }],
      sync_mode: 'redis',
      redis_url: 'redis://cache.example.com:6379/2',
      redis_tls: true,
    });

    const patched = await harness.authed(provider, {
      method: 'PATCH',
      url: `/api/apis/${api.id}`,
      payload: { rate_limit: { limit: 5, window_seconds: 1 } },
    });
    assert.equal(patched.statusCode, 200, patched.body);
    assert.deepEqual(harness.edge.pluginForProxy(proxyId, 'rate_limiting')?.config, {
      limit_by: 'consumer',
      expose_headers: true,
      limits: [{ scope: 'default', window_seconds: 1, max_requests: 5 }],
      sync_mode: 'redis',
      redis_url: 'redis://cache.example.com:6379/2',
      redis_tls: true,
    });
  });
});

describe('publishing — an upstream name that resolves to a private address', () => {
  // GHSA-m4qx-h386-j5jp: the suffix denylist never sees `127.0.0.1.nip.io`, and
  // an attacker-controlled record can point anywhere. The policy resolves the
  // name, so all three places a backend reaches the gateway must refuse it.
  const REBIND = 'rebind.example.com';
  let harness: TestApp;
  let provider: TestSession;

  before(async () => {
    harness = await buildTestApp({
      deps: {
        upstreamResolver: fakeUpstreamResolver({
          [REBIND]: [{ address: '127.0.0.1', family: 4 }],
        }),
      },
    });
    await harness.registerUser({ email: 'dns-founder@example.test' });
    provider = await harness.registerUser({
      email: 'dns-provider@example.test',
      role: 'provider',
    });
  });

  after(async () => {
    await harness.close();
  });

  /** Assert a 400 `SPEC_INVALID` naming the resolved private address. */
  function assertRefused(response: { statusCode: number; body: string }): void {
    assert.equal(response.statusCode, 400, response.body);
    const body = JSON.parse(response.body) as ApiErrorBody;
    assert.equal(body.error.code, 'SPEC_INVALID');
    assert.deepEqual(body.error.details, {
      field: 'upstream_url',
      host: REBIND,
      reason: 'private_upstream',
      resolved: ['127.0.0.1'],
    });
  }

  it('refuses the publish and leaves the gateway untouched', async () => {
    harness.edge.reset();
    const response = await harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: publishPayload({ slug: 'dns-publish', upstream_url: `http://${REBIND}:9000` }),
    });
    assertRefused(response);
    assert.equal(harness.edge.proxies.size, 0, 'nothing reached the gateway');
    assert.equal(await harness.store.apis.findBySlug('dns-publish'), null);
  });

  it('refuses a PATCH that repoints the proxy at it', async () => {
    harness.edge.reset();
    const published = await harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: publishPayload({
        slug: 'dns-patch',
        spec: specWithServer('https://good.example.com:8443'),
      }),
    });
    assert.equal(published.statusCode, 201, published.body);
    const api = published.json<PublishApiResponse>().api;
    const proxyKey = `nexus/${String(api.ferrum_proxy_id)}`;
    const before = harness.edge.proxies.get(proxyKey);

    const response = await harness.authed(provider, {
      method: 'PATCH',
      url: `/api/apis/${api.id}`,
      payload: { upstream_url: `http://${REBIND}:9000` },
    });
    assertRefused(response);
    assert.deepEqual(harness.edge.proxies.get(proxyKey), before, 'the backend did not move');
    assert.equal(
      (await harness.store.apis.findById(api.id))?.upstream_url,
      'https://good.example.com:8443',
    );
  });

  it('refuses a spec revision whose servers[0] moves the backend to it', async () => {
    harness.edge.reset();
    const published = await harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: publishPayload({
        slug: 'dns-spec',
        spec: specWithServer('https://good.example.com:8443'),
      }),
    });
    assert.equal(published.statusCode, 201, published.body);
    const api = published.json<PublishApiResponse>().api;
    const proxyKey = `nexus/${String(api.ferrum_proxy_id)}`;
    const before = harness.edge.proxies.get(proxyKey);

    const response = await harness.authed(provider, {
      method: 'PUT',
      url: `/api/apis/${api.id}/spec`,
      payload: { spec: specWithServer(`http://${REBIND}:9000`, '3.0.0') },
    });
    assertRefused(response);
    assert.deepEqual(harness.edge.proxies.get(proxyKey), before, 'the backend did not move');
  });

  it('still publishes a name that resolves publicly', async () => {
    harness.edge.reset();
    const response = await harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: publishPayload({ slug: 'dns-ok', upstream_url: 'http://elsewhere.example.com:80' }),
    });
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(harness.edge.proxyByName('nexus-dns-ok')?.backend_host, 'elsewhere.example.com');
  });
});
/* ── Abuse controls ───────────────────────────────────────────────────────
 *
 * GHSA-g32g-g9q4-q5wr: registration may be open, and every publishing mutation
 * cost several Ferrum Edge round trips and up to `MAX_SPEC_BYTES` of storage
 * with neither a per-account ceiling nor a request limit. Two controls, tested
 * separately because they bound different things: the quota bounds the *total*
 * an account may hold, the limiter bounds the *rate* at which it may ask.
 */

describe('per-owner API quota', () => {
  let harness: TestApp;
  let provider: TestSession;
  let admin: TestSession;

  before(async () => {
    // A deliberately tiny ceiling: the boundary is the whole point, and two is
    // the smallest number that distinguishes "at the limit" from "the first
    // one".
    harness = await buildTestApp({ env: { NEXUS_MAX_APIS_PER_OWNER: '2' } });
    admin = await harness.registerUser({ email: 'quota-founder@example.test' });
    provider = await harness.registerUser({
      email: 'quota-provider@example.test',
      role: 'provider',
    });
  });

  after(async () => {
    await harness.close();
  });

  /** Publish one API for `session` and return the raw response. */
  async function publish(session: TestSession, slug: string): Promise<LightMyRequestResponse> {
    return harness.authed(session, {
      method: 'POST',
      url: '/api/apis',
      payload: {
        name: `API ${slug}`,
        slug,
        version: '1.0.0',
        spec: SAMPLE_SPEC_YAML,
        auth_plugin: 'key_auth',
        requestable: true,
        visibility: 'public',
      },
    });
  }

  it('refuses the publish that would take an account past the limit', async () => {
    assert.equal((await publish(provider, 'quota-one')).statusCode, 201);
    assert.equal((await publish(provider, 'quota-two')).statusCode, 201);

    const proxiesBefore = harness.edge.proxies.size;
    const refused = await publish(provider, 'quota-three');
    assert.equal(refused.statusCode, 429, refused.body);

    const body = JSON.parse(refused.body) as ApiErrorBody;
    assert.equal(body.error.code, 'QUOTA_EXCEEDED');
    assert.deepEqual(body.error.details, {
      limit: 2,
      current: 2,
      setting: 'NEXUS_MAX_APIS_PER_OWNER',
    });
    // A provider has to be able to act on it without reading the source.
    assert.match(body.error.message, /Delete an API|administrator/);

    // Refused before the first gateway write, so there is nothing to roll back
    // and nothing half-created — not a proxy, not a plugin, not a slug.
    assert.equal(harness.edge.proxies.size, proxiesBefore);
    assert.equal(harness.edge.proxyByName('nexus-quota-three'), undefined);
    assert.equal(harness.edge.proxyServing('/nexus/quota-three'), undefined);
    assert.equal(await harness.store.apis.findBySlug('quota-three'), null);
  });

  it('frees a slot when an API is deleted', async () => {
    const listed = await harness.authed(provider, { method: 'GET', url: '/api/apis?mine=true' });
    const mine = listed.json<ListApisResponse>().items;
    assert.equal(mine.length, 2);

    const removed = await harness.authed(provider, {
      method: 'DELETE',
      url: `/api/apis/${mine[0]?.id}`,
    });
    assert.equal(removed.statusCode, 200, removed.body);

    const retry = await publish(provider, 'quota-four');
    assert.equal(retry.statusCode, 201, retry.body);
  });

  it('counts each owner separately, and does not exempt an admin', async () => {
    // The other account starts from zero even though the portal is at its
    // per-owner ceiling twice over.
    assert.equal((await publish(admin, 'quota-admin-one')).statusCode, 201);
    assert.equal((await publish(admin, 'quota-admin-two')).statusCode, 201);
    // …and then hits the same wall. An exemption is a bypass, and the case
    // worth defending against is an admin account that has been taken over.
    const refused = await publish(admin, 'quota-admin-three');
    assert.equal(refused.statusCode, 429, refused.body);
    assert.equal(errorCode(refused.body), 'QUOTA_EXCEEDED');
  });

  it('publishes without a ceiling when the limit is zero', async () => {
    const unlimited = await buildTestApp({ env: { NEXUS_MAX_APIS_PER_OWNER: '0' } });
    try {
      await unlimited.registerUser({ email: 'unlimited-founder@example.test' });
      const session = await unlimited.registerUser({
        email: 'unlimited-provider@example.test',
        role: 'provider',
      });
      for (const slug of ['zero-one', 'zero-two', 'zero-three']) {
        const response = await unlimited.authed(session, {
          method: 'POST',
          url: '/api/apis',
          payload: {
            name: `API ${slug}`,
            slug,
            version: '1.0.0',
            spec: SAMPLE_SPEC_YAML,
            auth_plugin: 'key_auth',
            requestable: false,
            visibility: 'public',
          },
        });
        assert.equal(response.statusCode, 201, response.body);
      }
      assert.equal(await unlimited.store.apis.count({ owner_user_id: session.user.id }), 3);
    } finally {
      await unlimited.close();
    }
  });

  it('does not let a burst from one account oversubscribe the limit', async () => {
    const burst = await buildTestApp({ env: { NEXUS_MAX_APIS_PER_OWNER: '2' } });
    try {
      await burst.registerUser({ email: 'burst-founder@example.test' });
      const session = await burst.registerUser({
        email: 'burst-provider@example.test',
        role: 'provider',
      });
      // Six at once. Without the per-owner lock every one of them reads a count
      // of zero before any of them writes a row, and all six succeed.
      const responses = await Promise.all(
        ['a', 'b', 'c', 'd', 'e', 'f'].map((slug) =>
          burst.authed(session, {
            method: 'POST',
            url: '/api/apis',
            payload: {
              name: `Burst ${slug}`,
              slug: `burst-${slug}`,
              version: '1.0.0',
              spec: SAMPLE_SPEC_YAML,
              auth_plugin: 'key_auth',
              requestable: false,
              visibility: 'public',
            },
          }),
        ),
      );
      assert.equal(responses.filter((response) => response.statusCode === 201).length, 2);
      for (const response of responses.filter((entry) => entry.statusCode !== 201)) {
        assert.equal(response.statusCode, 429, response.body);
        assert.equal(errorCode(response.body), 'QUOTA_EXCEEDED');
      }
      assert.equal(await burst.store.apis.count({ owner_user_id: session.user.id }), 2);
      // And the gateway is not carrying proxies for the four that lost.
      assert.equal(burst.edge.proxies.size, 2);
    } finally {
      await burst.close();
    }
  });
});

/**
 * The API-count quota bounds proxies and slugs; on its own it bounds no
 * storage, because every `PUT /api/apis/:id/spec` used to keep another
 * `MAX_SPEC_BYTES` document for ever. One API revised in a loop was therefore
 * an unbounded write path for a semi-trusted `provider` account.
 */
describe('bounded spec revision history', () => {
  let harness: TestApp;
  let provider: TestSession;

  before(async () => {
    // Two historical revisions plus the current one: the smallest limit that
    // still distinguishes "kept because it is recent" from "kept because it is
    // current".
    harness = await buildTestApp({ env: { NEXUS_SPEC_HISTORY_LIMIT: '2' } });
    await harness.registerUser({ email: 'history-founder@example.test' });
    provider = await harness.registerUser({
      email: 'history-provider@example.test',
      role: 'provider',
    });
  });

  after(async () => {
    await harness.close();
  });

  async function publish(slug: string): Promise<string> {
    const response = await harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: publishPayload({ slug, spec: specWithServer('https://v1.example.com:8443') }),
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<PublishApiResponse>().api.id;
  }

  async function revise(apiId: string, version: string): Promise<LightMyRequestResponse> {
    return harness.authed(provider, {
      method: 'PUT',
      url: `/api/apis/${apiId}/spec`,
      payload: { spec: specWithServer('https://v1.example.com:8443', version) },
    });
  }

  /** Every stored revision for an API, newest first. */
  async function revisions(apiId: string): Promise<{ version: string; current: boolean }[]> {
    const page = await harness.store.apiSpecs.list({ api_id: apiId });
    return page.items.map((spec) => ({
      version: String(spec.parsed_version),
      current: spec.is_current,
    }));
  }

  it('keeps the newest N historical revisions and the current one', async () => {
    const apiId = await publish('history-bound');
    for (const version of ['2.0.0', '3.0.0', '4.0.0', '5.0.0']) {
      const response = await revise(apiId, version);
      assert.equal(response.statusCode, 200, response.body);
    }

    // `NEXUS_SPEC_HISTORY_LIMIT` historical revisions, plus the current one.
    assert.deepEqual(await revisions(apiId), [
      { version: '5.0.0', current: true },
      { version: '4.0.0', current: false },
      { version: '3.0.0', current: false },
    ]);
  });

  it('never prunes the current revision, however many times it is replaced', async () => {
    const apiId = await publish('history-current');
    for (let round = 0; round < 6; round += 1) {
      assert.equal((await revise(apiId, `9.${round}.0`)).statusCode, 200);
      const stored = await revisions(apiId);
      assert.equal(stored.filter((spec) => spec.current).length, 1);
      assert.ok(stored.length <= 3, `expected at most 3 rows, found ${stored.length}`);
    }
    assert.equal((await revisions(apiId))[0]?.version, '9.5.0');
  });

  it('prunes nothing when the gateway write fails', async () => {
    const apiId = await publish('history-gateway-fails');
    for (const version of ['2.0.0', '3.0.0', '4.0.0']) {
      assert.equal((await revise(apiId, version)).statusCode, 200);
    }
    const before = await revisions(apiId);
    assert.equal(before.length, 3);

    harness.edge.queueFailure(500, { error: 'config_rejected' }, '/proxies/', 'PUT');
    const failed = await harness.authed(provider, {
      method: 'PUT',
      url: `/api/apis/${apiId}/spec`,
      payload: { spec: specWithServer('https://v2.example.com:8443', '5.0.0') },
    });
    assert.notEqual(failed.statusCode, 200);
    assert.deepEqual(await revisions(apiId), before, 'a refused revision prunes nothing');
  });

  it('takes every retained revision down with the API', async () => {
    const apiId = await publish('history-delete');
    for (const version of ['2.0.0', '3.0.0']) {
      assert.equal((await revise(apiId, version)).statusCode, 200);
    }
    assert.equal((await revisions(apiId)).length, 3);

    const removed = await harness.authed(provider, {
      method: 'DELETE',
      url: `/api/apis/${apiId}`,
    });
    assert.equal(removed.statusCode, 200, removed.body);
    assert.equal((await revisions(apiId)).length, 0);
  });
});

describe('publishing rate limit', () => {
  let harness: TestApp;
  let first: TestSession;
  let second: TestSession;

  before(async () => {
    // The limiter is forced off under `NEXUS_ENV=test`, so this app runs as a
    // development one with it explicitly on.
    harness = await buildTestApp({
      env: { NEXUS_ENV: 'development', NEXUS_RATE_LIMIT_ENABLED: 'true' },
      deps: { startOutboxWorker: false },
    });
    await harness.registerUser({ email: 'limit-founder@example.test' });
    first = await harness.registerUser({ email: 'limit-one@example.test', role: 'provider' });
    second = await harness.registerUser({ email: 'limit-two@example.test', role: 'provider' });
  });

  after(async () => {
    await harness.close();
  });

  /**
   * A cheap mutating request on the limited scope.
   *
   * A `PATCH` of an API that does not exist is a `404` — it never reaches the
   * gateway or the store's write path — which is exactly what a test of the
   * *limiter* wants: the limiter runs before the handler, so the status
   * distinguishes "counted and allowed" from "counted and refused" without
   * publishing thirty APIs to get there.
   */
  async function patchMissing(session: TestSession): Promise<LightMyRequestResponse> {
    return harness.authed(session, {
      method: 'PATCH',
      url: '/api/apis/00000000-0000-4000-8000-000000000000',
      payload: { description: 'noop' },
    });
  }

  it('refuses the 31st mutation in a minute with RATE_LIMITED', async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 34; attempt += 1) {
      statuses.push((await patchMissing(first)).statusCode);
    }
    assert.equal(
      statuses.filter((status) => status === 404).length,
      30,
      `the limit is 30/minute: ${statuses.join(',')}`,
    );
    const refused = await patchMissing(first);
    assert.equal(refused.statusCode, 429);
    assert.equal(errorCode(refused.body), 'RATE_LIMITED');
  });

  it('gives each account its own bucket rather than keying on the address', async () => {
    // `first` is already over its limit from the test above, and both accounts
    // present the same 127.0.0.1 to `app.inject`. An IP-keyed limiter would
    // refuse this; a user-keyed one lets it through — which also proves the
    // session hook has run by the time the limiter reads `request.currentUser`.
    assert.equal((await patchMissing(first)).statusCode, 429);
    const other = await patchMissing(second);
    assert.equal(other.statusCode, 404, other.body);
  });

  it('leaves the reads alone', async () => {
    // The provider's own list is cheap and the SPA polls it; only the mutations
    // carry the limit.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const response = await harness.authed(first, { method: 'GET', url: '/api/apis' });
      assert.equal(response.statusCode, 200, response.body);
    }
  });
});
