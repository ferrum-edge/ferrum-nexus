import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

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
   * request to a path the spec never declared proxied straight through. The
   * `routes` level attaches an `openapi_validator` that closes that gap — for
   * paths and methods, and explicitly not for bodies.
   */
  describe('OpenAPI enforcement', () => {
    /** The validator config the gateway currently holds for a proxy. */
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

    it('writes no validator at all in the default docs_only mode', async () => {
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
      assert.deepEqual(effectiveNames(harness, proxyId), ['access_control', 'key_auth']);
    });

    it('attaches, associates and populates the validator when routes is asked for', async () => {
      const response = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({ slug: 'enf-routes', spec_enforcement: 'routes' }),
      });
      assert.equal(response.statusCode, 201, response.body);
      const api = response.json<PublishApiResponse>().api;
      assert.equal(api.spec_enforcement, 'routes');

      const proxyId = String(api.ferrum_proxy_id);

      // The exact body Edge receives. `validate_request`/`validate_response`
      // are the boundary of this feature, so they are asserted as values
      // rather than left to a subset match.
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

      // A config the proxy does not name is inert, so "it exists" is not the
      // claim that matters.
      assert.deepEqual(effectiveNames(harness, proxyId), [
        'access_control',
        'key_auth',
        'openapi_validator',
      ]);
      const validatorId = String(harness.edge.pluginForProxy(proxyId, 'openapi_validator')?.id);
      assert.ok(associatedIds(harness, proxyId).includes(validatorId));
      assert.deepEqual(associatedIds(harness, proxyId), writtenIds(harness, proxyId));
    });

    it('allows OPTIONS only on declared paths when the API also has a CORS policy', async () => {
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
        'OPTIONS /nexus/enf-cors/invoices',
        'OPTIONS /nexus/enf-cors/invoices/{id}',
      ]);
      assert.equal('bypass' in (validatorConfig(proxyId) ?? {}), false);
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
      // Edge refuses an empty `operations` array, so the alternatives are a row
      // claiming enforcement that is not happening or a proxy that rejects
      // everything. Refusing is the honest third option.
      assert.equal(response.statusCode, 400, response.body);
      assert.equal(errorCode(response.body), 'SPEC_INVALID');
      assert.equal(harness.edge.proxyByName('nexus-enf-empty'), undefined);
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

    it('attaches on PATCH to routes and detaches again on PATCH to docs_only', async () => {
      const published = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({ slug: 'enf-toggle' }),
      });
      assert.equal(published.statusCode, 201, published.body);
      const apiId = published.json<PublishApiResponse>().api.id;
      const proxyId = String(published.json<PublishApiResponse>().api.ferrum_proxy_id);
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
      const validatorId = String(harness.edge.pluginForProxy(proxyId, 'openapi_validator')?.id);
      assert.ok(associatedIds(harness, proxyId).includes(validatorId));
      assert.deepEqual(effectiveNames(harness, proxyId), [
        'access_control',
        'key_auth',
        'openapi_validator',
      ]);

      const off = await harness.authed(provider, {
        method: 'PATCH',
        url: `/api/apis/${apiId}`,
        payload: { spec_enforcement: 'docs_only' },
      });
      assert.equal(off.statusCode, 200, off.body);
      assert.equal(off.json<UpdateApiResponse>().api.spec_enforcement, 'docs_only');
      assert.equal(harness.edge.pluginForProxy(proxyId, 'openapi_validator'), undefined);
      assert.ok(!associatedIds(harness, proxyId).includes(validatorId));
      assert.deepEqual(associatedIds(harness, proxyId), writtenIds(harness, proxyId));
    });

    it('refreshes path-scoped OPTIONS operations when CORS arrives and leaves', async () => {
      const published = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({ slug: 'enf-cors-patch', spec_enforcement: 'routes' }),
      });
      assert.equal(published.statusCode, 201, published.body);
      const apiId = published.json<PublishApiResponse>().api.id;
      const proxyId = String(published.json<PublishApiResponse>().api.ferrum_proxy_id);
      assert.equal('bypass' in (validatorConfig(proxyId) ?? {}), false);
      const validatorId = String(harness.edge.pluginForProxy(proxyId, 'openapi_validator')?.id);

      const added = await harness.authed(provider, {
        method: 'PATCH',
        url: `/api/apis/${apiId}`,
        payload: {
          cors: { allowed_origins: ['https://app.example.com'], allow_credentials: false },
        },
      });
      assert.equal(added.statusCode, 200, added.body);
      assert.deepEqual(operationLabels(proxyId), [
        'GET /nexus/enf-cors-patch/invoices',
        'GET /nexus/enf-cors-patch/invoices/{id}',
        'OPTIONS /nexus/enf-cors-patch/invoices',
        'OPTIONS /nexus/enf-cors-patch/invoices/{id}',
      ]);
      assert.equal('bypass' in (validatorConfig(proxyId) ?? {}), false);
      // Rewritten in place, so the association list never had to change.
      assert.equal(
        String(harness.edge.pluginForProxy(proxyId, 'openapi_validator')?.id),
        validatorId,
      );

      const removed = await harness.authed(provider, {
        method: 'PATCH',
        url: `/api/apis/${apiId}`,
        payload: { cors: null },
      });
      assert.equal(removed.statusCode, 200, removed.body);
      assert.equal('bypass' in (validatorConfig(proxyId) ?? {}), false);
      assert.deepEqual(operationLabels(proxyId), [
        'GET /nexus/enf-cors-patch/invoices',
        'GET /nexus/enf-cors-patch/invoices/{id}',
      ]);
      assert.equal(
        String(harness.edge.pluginForProxy(proxyId, 'openapi_validator')?.id),
        validatorId,
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
    });

    it('undoes the attach when a later step of the PATCH fails', async () => {
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

      // Neither the config nor the association survives a PATCH that did not
      // commit; the row still says docs_only, and the two agree.
      assert.equal(harness.edge.pluginForProxy(proxyId, 'openapi_validator'), undefined);
      assert.deepEqual(associatedIds(harness, proxyId), before);
      const reread = await harness.authed(provider, { method: 'GET', url: `/api/apis/${apiId}` });
      assert.equal(reread.json<GetApiResponse>().api.spec_enforcement, 'docs_only');
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
      const validatorId = String(harness.edge.pluginForProxy(proxyId, 'openapi_validator')?.id);
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
      // Replaced in place: same id, same association, exactly one config.
      assert.equal(
        String(harness.edge.pluginForProxy(proxyId, 'openapi_validator')?.id),
        validatorId,
      );
      assert.equal(
        harness.edge
          .pluginsForProxy(proxyId)
          .filter((plugin) => plugin.plugin_name === 'openapi_validator').length,
        1,
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
    });

    it('restores the previous operation table when the revision cannot be persisted', async () => {
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
            servers: [{ url: 'https://billing.example.com:8443/v2' }],
            paths: { '/payments': { get: { responses: { '200': { description: 'OK' } } } } },
          }),
        },
      });
      assert.equal(response.statusCode, 500, response.body);

      // The gateway moved first, so the compensation has to put the table back:
      // otherwise the proxy would enforce a revision the catalog never adopted.
      assert.deepEqual(operationLabels(proxyId), [
        'GET /nexus/enf-spec-undo/invoices',
        'GET /nexus/enf-spec-undo/invoices/{id}',
      ]);
    });

    it('takes the validator down with the API', async () => {
      const published = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({ slug: 'enf-delete', spec_enforcement: 'routes' }),
      });
      const apiId = published.json<PublishApiResponse>().api.id;
      const proxyId = String(published.json<PublishApiResponse>().api.ferrum_proxy_id);
      assert.ok(harness.edge.pluginForProxy(proxyId, 'openapi_validator'));

      const removed = await harness.authed(provider, {
        method: 'DELETE',
        url: `/api/apis/${apiId}`,
      });
      assert.equal(removed.statusCode, 200, removed.body);
      assert.equal(harness.edge.pluginsForProxy(proxyId).length, 0);
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
