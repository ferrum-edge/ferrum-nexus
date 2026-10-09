/**
 * Ferrum Edge v0.9.16 (ferrum-edge#6093) treats an admin JWT that carries an
 * `ns` claim as a tenant credential: it reaches namespace-scoped routes and a
 * short allowlist, and every fleet-global route answers `403`. Every token
 * Nexus mints carries the claim, so these tests run the whole portal against
 * a gateway that enforces that bound:
 *
 * - `/health` answers the bounded tenant tier (`mode`, `admin_writes_enabled`
 *   and the `namespace` block when the claim covers it), or only the minimal
 *   tier. Whatever it omits reads unknown, never healthy-served.
 * - The usage card reads `GET /metrics` and `GET /admin/metrics`, both
 *   fleet-global. A refusal reads as unavailable with its cause; the optional
 *   credentials make both readable again.
 *
 * Edge v0.9.15, which bounds nothing outside namespace routes, is what every
 * other suite runs against.
 */

import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';

import type { ApiUsageResponse, AppHealth, PublishApiResponse } from '@ferrum-nexus/shared';

import { reconcileGateway } from '../ferrum-admin/reconcile.js';
import {
  SAMPLE_SPEC_YAML,
  TEST_EDGE_JWT_SECRET,
  buildTestApp,
  type TestApp,
  type TestSession,
} from './helpers.js';
import { createMockFerrumEdge, type MockFerrumEdge } from './mock-ferrum-edge.js';

const METRICS_BEARER = 'nexus-test-metrics-bearer-token-0123456789';
const VIEWER_SECRET = 'nexus-test-admin-viewer-key-0123456789abcd';

/** A started gateway that bounds `ns`-claim tokens, with the given health tier. */
async function boundedEdge(tier: 'tenant' | 'minimal'): Promise<MockFerrumEdge> {
  const edge = createMockFerrumEdge({
    jwtSecret: TEST_EDGE_JWT_SECRET,
    issuer: 'ferrum-edge',
    nsClaimBound: tier,
    metricsBearerToken: METRICS_BEARER,
    viewerSecret: VIEWER_SECRET,
  });
  await edge.start();
  return edge;
}

/** A portal on `edge` with a founding admin, closed (with the gateway) after the test. */
async function portal(
  t: TestContext,
  edge: MockFerrumEdge,
  env: Record<string, string> = {},
): Promise<{ harness: TestApp; admin: TestSession }> {
  const harness = await buildTestApp({ edge, env });
  t.after(async () => {
    await harness.close();
    await edge.stop();
  });
  const admin = await harness.registerUser();
  return { harness, admin };
}

async function edgeHealth(harness: TestApp, admin: TestSession): Promise<AppHealth['edge']> {
  const response = await harness.authed(admin, { method: 'GET', url: '/api/health' });
  assert.equal(response.statusCode, 200, response.body);
  return response.json<AppHealth>().edge;
}

describe('a gateway that bounds ns-claim admin tokens', () => {
  describe('the tenant health tier', () => {
    it('still reports mode, write state and a served namespace', async (t) => {
      const edge = await boundedEdge('tenant');
      const { harness, admin } = await portal(t, edge);
      edge.setServedNamespace('nexus');

      const health = await edgeHealth(harness, admin);

      assert.equal(health.status, 'ok');
      assert.equal(health.mode, 'database');
      assert.equal(health.admin_writes_enabled, true);
      assert.equal(health.namespace_routing.active, 'nexus');
      assert.equal(health.namespace_routing.data_plane_single_namespace, true);
      assert.equal(health.namespace_routing.unserved, false);
      const [probe] = edge.callsTo('GET', '/health');
      assert.equal(probe?.claims?.ns, 'nexus', 'no fleet-privileged token is needed');
    });

    it('reads a block it withholds as unknown, not as still served', async (t) => {
      const edge = await boundedEdge('tenant');
      const { harness, admin } = await portal(t, edge);
      edge.setServedNamespace('nexus');
      assert.equal((await edgeHealth(harness, admin)).namespace_routing.active, 'nexus');

      // Restarted into a namespace the portal's claim does not cover: the
      // tenant tier drops the block rather than naming another tenant.
      edge.setServedNamespace('ferrum');
      const health = await edgeHealth(harness, admin);

      assert.equal(health.mode, 'database');
      assert.equal(health.namespace_routing.active, null);
      assert.equal(health.namespace_routing.data_plane_single_namespace, null);
    });
  });

  describe('the minimal health tier', () => {
    it('reads mode, write state and routing as unknown', async (t) => {
      const edge = await boundedEdge('minimal');
      const { harness, admin } = await portal(t, edge);
      edge.setServedNamespace('nexus');

      const health = await edgeHealth(harness, admin);

      assert.equal(health.ready, true);
      assert.equal(health.mode, null);
      assert.equal(health.admin_writes_enabled, null);
      assert.equal(health.namespace_routing.active, null);
      assert.equal(health.namespace_routing.serving_scope, null);
      assert.equal(health.namespace_routing.data_plane_single_namespace, null);
      assert.equal(health.namespace_routing.unserved, false);
    });

    it('still degrades on the per-write marker, the one signal it keeps', async (t) => {
      const edge = await boundedEdge('minimal');
      const { harness, admin } = await portal(t, edge, { NEXUS_ALLOW_PRIVATE_UPSTREAMS: 'true' });
      const provider = await harness.registerUser({ role: 'provider' });
      edge.setServedNamespace('ferrum');

      const published = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: {
          name: 'Marked API',
          slug: 'marked-under-minimal-tier',
          version: '1.0.0',
          spec: SAMPLE_SPEC_YAML,
          auth_plugin: 'key_auth',
          requestable: true,
          visibility: 'public',
        },
      });
      assert.equal(published.statusCode, 201, published.body);

      const health = await edgeHealth(harness, admin);
      assert.equal(health.namespace_routing.unserved, true);
      assert.equal(health.reason, 'namespace_unserved');
    });
  });

  describe('the usage card', () => {
    async function publishedApi(
      harness: TestApp,
      edge: MockFerrumEdge,
    ): Promise<{ apiId: string; provider: TestSession }> {
      await reconcileGateway(harness.edgeClient, harness.services.audit, harness.app.log);
      const provider = await harness.registerUser({ role: 'provider' });
      const response = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: {
          name: 'Bounded API',
          slug: 'bounded-usage',
          version: '1.0.0',
          spec: SAMPLE_SPEC_YAML,
          auth_plugin: 'key_auth',
          requestable: true,
          visibility: 'public',
        },
      });
      assert.equal(response.statusCode, 201, response.body);
      const api = response.json<PublishApiResponse>().api;
      assert.ok(api.ferrum_proxy_id);
      edge.recordRequests(api.ferrum_proxy_id, { method: 'GET', status: 200, count: 11 });
      edge.setBackendState(api.ferrum_proxy_id, { breaker: 'closed' });
      return { apiId: api.id, provider };
    }

    async function usageFor(
      harness: TestApp,
      session: TestSession,
      apiId: string,
    ): Promise<ApiUsageResponse> {
      const response = await harness.authed(session, {
        method: 'GET',
        url: `/api/apis/${apiId}/usage`,
      });
      assert.equal(response.statusCode, 200, response.body);
      return response.json<ApiUsageResponse>();
    }

    it('says both reads were refused instead of showing no traffic', async (t) => {
      const edge = await boundedEdge('tenant');
      const { harness } = await portal(t, edge);
      const { apiId, provider } = await publishedApi(harness, edge);

      const usage = await usageFor(harness, provider, apiId);

      assert.equal(usage.available, false);
      assert.equal(usage.unavailable_code, 'refused');
      assert.match(usage.unavailable_reason ?? '', /FERRUM_METRICS_BEARER_TOKEN/);
      assert.equal(usage.requests.total, 0);
      assert.equal(usage.backend.status, 'unavailable');
      assert.match(String(usage.backend.detail), /namespace-scoped admin token/);
      assert.doesNotMatch(String(usage.backend.detail), /No circuit breaker/);
    });

    it('reads both again with the metrics bearer token and the fleet-read key', async (t) => {
      const edge = await boundedEdge('tenant');
      const { harness } = await portal(t, edge, {
        FERRUM_METRICS_BEARER_TOKEN: METRICS_BEARER,
        FERRUM_ADMIN_FLEET_READ_JWT_SECRET: VIEWER_SECRET,
      });
      const { apiId, provider } = await publishedApi(harness, edge);

      const usage = await usageFor(harness, provider, apiId);

      assert.equal(usage.available, true);
      assert.equal(usage.unavailable_code, undefined);
      assert.equal(usage.requests.total, 11);
      assert.equal(usage.backend.status, 'healthy');
      const scrape = edge.requests.find((request) => request.path === '/metrics');
      assert.equal(scrape?.credential, 'metrics_bearer');
      const [backend] = edge.callsTo('GET', '/admin/metrics');
      assert.equal(backend?.credential, 'viewer_key');
      assert.equal(backend?.claims?.ns, undefined);
    });
  });
});
