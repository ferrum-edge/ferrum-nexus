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
      assert.equal(proxy.backend_host, 'billing.internal');
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
    });

    it('takes the upstream from the document when the provider supplies none', async () => {
      const response = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({ slug: 'from-spec', spec: SAMPLE_SPEC_JSON }),
      });
      assert.equal(response.statusCode, 201);
      const proxy = harness.edge.proxyByName('nexus-from-spec');
      assert.equal(proxy?.backend_host, 'shipping.internal');
      assert.equal(proxy?.backend_port, 443);
    });

    it('prefers an explicit upstream_url over the document', async () => {
      const response = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({
          slug: 'explicit-upstream',
          upstream_url: 'http://override.internal:8080',
        }),
      });
      assert.equal(response.statusCode, 201);
      const proxy = harness.edge.proxyByName('nexus-explicit-upstream');
      assert.equal(proxy?.backend_host, 'override.internal');
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

    it('keeps clients out of the publishing routes entirely', async () => {
      const response = await harness.authed(client, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({ slug: 'client-cannot' }),
      });
      assert.equal(response.statusCode, 403);
      assert.equal(errorCode(response.body), 'FORBIDDEN');
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

      const api = await harness.store.apis.findById(apiId);
      assert.equal(api?.auth_plugin, 'key_auth');
    });

    it('repoints the proxy backend when a new upstream_url is supplied', async () => {
      await harness.authed(provider, {
        method: 'PATCH',
        url: `/api/apis/${apiId}`,
        payload: { upstream_url: 'http://moved.internal:9100/base' },
      });
      const proxy = harness.edge.proxies.get(`nexus/${proxyId}`);
      assert.equal(proxy?.backend_host, 'moved.internal');
      assert.equal(proxy?.backend_port, 9100);
      assert.equal(proxy?.backend_path, '/base');
    });

    it('retires an API without touching the gateway, and hides it from the catalog', async () => {
      const before = harness.edge.pluginsForProxy(proxyId).length;
      const response = await harness.authed(provider, {
        method: 'PATCH',
        url: `/api/apis/${apiId}`,
        payload: { status: 'retired' },
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json<UpdateApiResponse>().api.status, 'retired');

      // The proxy and its plugins are deliberately left alone.
      assert.ok(harness.edge.proxies.get(`nexus/${proxyId}`));
      assert.equal(harness.edge.pluginsForProxy(proxyId).length, before);

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
          spec: specWithServer('https://v1.internal:8443'),
        }),
      });
      const apiId = published.json<PublishApiResponse>().api.id;
      const proxyId = String(published.json<PublishApiResponse>().api.ferrum_proxy_id);
      assert.equal(harness.edge.proxies.get(`nexus/${proxyId}`)?.backend_host, 'v1.internal');

      const response = await harness.authed(provider, {
        method: 'PUT',
        url: `/api/apis/${apiId}/spec`,
        payload: { spec: specWithServer('https://v2.internal:8443', '3.0.0') },
      });
      assert.equal(response.statusCode, 200);
      const body = response.json<UpdateApiSpecResponse>();
      assert.equal(body.spec.is_current, true);
      assert.equal(body.spec.parsed_version, '3.0.0');
      assert.equal(body.api.version, '3.0.0');

      assert.equal(harness.edge.proxies.get(`nexus/${proxyId}`)?.backend_host, 'v2.internal');

      // The previous revision is retained but is no longer current.
      const specs = await harness.store.apiSpecs.list({ api_id: apiId });
      assert.equal(specs.total, 2);
      assert.equal(specs.items.filter((spec) => spec.is_current).length, 1);

      const row = (await harness.auditRows('api.spec_update')).find((e) => e.target_id === apiId);
      assert.equal(row?.details.backend_updated, true);
    });

    it('leaves an explicitly-pinned backend alone when the document moves', async () => {
      harness.edge.reset();
      const published = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: publishPayload({
          slug: 'spec-pinned',
          spec: specWithServer('https://v1.internal:8443'),
          upstream_url: 'https://pinned.internal:8443',
        }),
      });
      const api = published.json<PublishApiResponse>().api;

      await harness.authed(provider, {
        method: 'PUT',
        url: `/api/apis/${api.id}/spec`,
        payload: { spec: specWithServer('https://v2.internal:8443') },
      });
      assert.equal(
        harness.edge.proxies.get(`nexus/${String(api.ferrum_proxy_id)}`)?.backend_host,
        'pinned.internal',
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
          spec: specWithServer('https://v1.internal:8443'),
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
        payload: { spec: specWithServer('https://v2.internal:8443', '3.0.0') },
      });
      assert.notEqual(response.statusCode, 200);

      assert.equal(
        harness.edge.proxies.get(`nexus/${proxyId}`)?.backend_host,
        'v1.internal',
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
          spec: specWithServer('https://v1.internal:8443'),
        }),
      });
      const api = published.json<PublishApiResponse>().api;
      const proxyId = String(api.ferrum_proxy_id);

      failNextTransaction(harness, 'database is gone');
      const response = await harness.authed(provider, {
        method: 'PUT',
        url: `/api/apis/${api.id}/spec`,
        payload: { spec: specWithServer('https://v2.internal:8443', '3.0.0') },
      });
      assert.notEqual(response.statusCode, 200);

      assert.equal(
        harness.edge.proxies.get(`nexus/${proxyId}`)?.backend_host,
        'v1.internal',
        'the backend that was moved for the failed revision is put back',
      );
      const specs = await harness.store.apiSpecs.list({ api_id: api.id });
      assert.equal(specs.total, 1);
      assert.equal(specs.items[0]?.parsed_version, '1.0.0');
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
  });
});
