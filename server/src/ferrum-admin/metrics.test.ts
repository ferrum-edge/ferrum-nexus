import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';

import type { EdgeConfig } from '../config/index.js';
import { createMockFerrumEdge, type MockFerrumEdge } from '../test/mock-ferrum-edge.js';
import {
  createFerrumAdminClient,
  METRICS_RESPONSE_MAX_BYTES,
  type FerrumAdminClient,
} from './client.js';

const SECRET = 'ferrum-admin-metrics-test-secret-0123456789';

let edge: MockFerrumEdge;
let client: FerrumAdminClient;

function configFor(url: string, overrides: Partial<EdgeConfig> = {}): EdgeConfig {
  return {
    adminUrl: url,
    jwtSecret: SECRET,
    jwtTtlSeconds: 60,
    jwtIssuer: 'ferrum-edge',
    jwtAudience: undefined,
    namespace: 'nexus',
    gatewayPublicUrl: undefined,
    rateLimit: { syncMode: 'local', redisUrl: undefined, redisTls: false },
    caFile: undefined,
    allowInsecureHttp: false,
    timeoutMs: 2_000,
    maxCredentialsPerType: 2,
    ...overrides,
  };
}

/**
 * A fresh client per test, because the metrics reads are memoised globally for
 * ten seconds and every test would otherwise inherit the previous one's cache.
 * The caching behaviour itself is asserted explicitly further down.
 */
function freshClient(): FerrumAdminClient {
  return createFerrumAdminClient(configFor(edge.url));
}

describe('ferrum admin metrics', () => {
  before(async () => {
    edge = createMockFerrumEdge({ jwtSecret: SECRET, issuer: 'ferrum-edge' });
    await edge.start();
    client = createFerrumAdminClient(configFor(edge.url));
  });

  after(async () => {
    await client.close();
    await edge.stop();
  });

  afterEach(() => {
    edge.reset();
  });

  describe('scrapeProxy', () => {
    it('sums a proxy’s counters by method and status', async () => {
      edge.recordRequests('proxy-a', { method: 'GET', status: 200, count: 1_200 });
      edge.recordRequests('proxy-a', { method: 'POST', status: 201, count: 40 });
      edge.recordRequests('proxy-a', { method: 'GET', status: 429, count: 18 });
      // Accumulates, exactly as Edge's counters do.
      edge.recordRequests('proxy-a', { method: 'GET', status: 200, count: 300 });

      const metrics = await freshClient().metrics.scrapeProxy('proxy-a');

      assert.equal(metrics.available, true);
      assert.equal(metrics.requests.total, 1_558);
      assert.deepEqual(metrics.requests.byMethod, { GET: 1_518, POST: 40 });
      assert.deepEqual(metrics.requests.byStatus, { '200': 1_500, '201': 40, '429': 18 });
    });

    it('ignores other proxies and other namespaces', async () => {
      edge.recordRequests('proxy-a', { method: 'GET', status: 200, count: 5 });
      edge.recordRequests('proxy-b', { method: 'GET', status: 200, count: 900 });
      // Same proxy id, a different tenant on the same gateway.
      edge.recordRequests('proxy-a', { method: 'GET', status: 200, count: 700 }, 'other-tenant');

      const metrics = await freshClient().metrics.scrapeProxy('proxy-a');

      assert.equal(metrics.requests.total, 5);
      assert.deepEqual(metrics.requests.byStatus, { '200': 5 });
    });

    it('reads the latency histogram as ascending cumulative buckets', async () => {
      edge.recordRequests('proxy-a', {
        method: 'GET',
        status: 200,
        count: 4,
        durations: [3, 20, 60, 4_000],
      });

      const { latency } = await freshClient().metrics.scrapeProxy('proxy-a');

      assert.equal(latency.count, 4);
      assert.equal(latency.sum, 4_083);
      assert.ok(latency.buckets.length > 1);
      // Sorted ascending, `+Inf` last, and monotonically non-decreasing.
      for (let index = 1; index < latency.buckets.length; index += 1) {
        const previous = latency.buckets[index - 1];
        const current = latency.buckets[index];
        assert.ok(current !== undefined && previous !== undefined);
        assert.ok(current.le > previous.le);
        assert.ok(current.count >= previous.count);
      }
      assert.equal(latency.buckets.at(-1)?.le, Number.POSITIVE_INFINITY);
      assert.equal(latency.buckets.at(-1)?.count, 4);
      assert.equal(latency.buckets.find((bucket) => bucket.le === 5)?.count, 1);
      assert.equal(latency.buckets.find((bucket) => bucket.le === 100)?.count, 3);
    });

    it('reports zeros for a proxy the gateway has no series for', async () => {
      edge.recordRequests('proxy-b', { method: 'GET', status: 200, count: 3 });

      const metrics = await freshClient().metrics.scrapeProxy('proxy-a');

      // The scrape worked; this proxy simply has no traffic.
      assert.equal(metrics.available, true);
      assert.equal(metrics.requests.total, 0);
      assert.deepEqual(metrics.latency.buckets, []);
    });

    it('authenticates with the admin JWT like every other route', async () => {
      await freshClient().metrics.scrapeProxy('proxy-a');

      const [call] = edge.callsTo('GET', '/metrics');
      assert.equal(call?.claims?.role, 'admin');
    });

    it('returns an unavailable result when the gateway answers non-2xx', async () => {
      edge.queueFailure(503, { error: 'metrics disabled' }, '/metrics');

      const metrics = await freshClient().metrics.scrapeProxy('proxy-a');

      assert.equal(metrics.available, false);
      assert.equal(metrics.requests.total, 0);
      assert.deepEqual(metrics.latency.buckets, []);
    });

    it('returns an unavailable result when the gateway is unreachable', async () => {
      const offline = createFerrumAdminClient(configFor('http://127.0.0.1:1', { timeoutMs: 300 }));
      try {
        const metrics = await offline.metrics.scrapeProxy('proxy-a');
        assert.equal(metrics.available, false);
        assert.equal(metrics.requests.total, 0);
      } finally {
        await offline.close();
      }
    });

    it('coalesces concurrent scrapes and reuses the global result across proxies', async () => {
      edge.recordRequests('proxy-a', { method: 'GET', status: 200, count: 1 });
      const cached = freshClient();

      const [first, second] = await Promise.all([
        cached.metrics.scrapeProxy('proxy-a'),
        cached.metrics.scrapeProxy('proxy-a'),
      ]);

      assert.deepEqual(first, second);
      assert.equal(edge.callsTo('GET', '/metrics').length, 1);

      // Edge returns all proxies in one document, so another proxy reuses it.
      await cached.metrics.scrapeProxy('proxy-b');
      assert.equal(edge.callsTo('GET', '/metrics').length, 1);
    });

    it('rejects an oversized metrics response without buffering it indefinitely', async () => {
      // Sized off the constant, so raising the ceiling keeps this exercising
      // the bound rather than quietly becoming a test of a 2 MiB body that now
      // fits.
      edge.queueFailure(200, 'x'.repeat(METRICS_RESPONSE_MAX_BYTES + 1), '/metrics');

      const metrics = await freshClient().metrics.scrapeProxy('proxy-a');

      assert.equal(metrics.available, false);
    });
  });

  describe('backendState', () => {
    it('returns the proxy’s circuit breaker and the gateway uptime', async () => {
      edge.setBackendState('proxy-a', { breaker: 'open' });
      edge.setBackendState('proxy-b', { breaker: 'closed' });

      const state = await freshClient().metrics.backendState('proxy-a');

      assert.equal(state.available, true);
      assert.equal(state.breakers.length, 1);
      assert.equal(state.breakers[0]?.state, 'open');
      assert.equal(state.breakers[0]?.proxy_id, 'proxy-a');
      assert.equal(state.uptimeSeconds, 3_600);
      assert.deepEqual(state.unhealthyTargets, []);
    });

    it('returns an unhealthy target with the time it started failing', async () => {
      edge.setBackendState('proxy-a', { breaker: 'closed', unhealthyTarget: '10.0.5.7:8080' });

      const state = await freshClient().metrics.backendState('proxy-a');

      assert.equal(state.unhealthyTargets.length, 1);
      assert.equal(state.unhealthyTargets[0]?.target, '10.0.5.7:8080');
      assert.equal(state.unhealthyTargets[0]?.type, 'passive');
      assert.equal(typeof state.unhealthyTargets[0]?.since_epoch_ms, 'number');
    });

    it('ignores another namespace’s entries for the same proxy id', async () => {
      edge.setBackendState('proxy-a', { breaker: 'open' }, 'other-tenant');

      const state = await freshClient().metrics.backendState('proxy-a');

      assert.equal(state.available, true);
      assert.deepEqual(state.breakers, []);
    });

    it('reports nothing rather than failing when the proxy has no breaker', async () => {
      const state = await freshClient().metrics.backendState('proxy-a');

      assert.equal(state.available, true);
      assert.deepEqual(state.breakers, []);
      assert.deepEqual(state.unhealthyTargets, []);
    });

    it('returns an unavailable result when the gateway errors', async () => {
      edge.queueFailure(500, { error: 'boom' }, '/admin/metrics');

      const state = await freshClient().metrics.backendState('proxy-a');

      assert.equal(state.available, false);
      assert.equal(state.uptimeSeconds, null);
    });

    it('returns an unavailable result when the gateway is unreachable', async () => {
      const offline = createFerrumAdminClient(configFor('http://127.0.0.1:1', { timeoutMs: 300 }));
      try {
        const state = await offline.metrics.backendState('proxy-a');
        assert.equal(state.available, false);
      } finally {
        await offline.close();
      }
    });

    it('coalesces concurrent reads and reuses the global result across proxies', async () => {
      edge.setBackendState('proxy-a', { breaker: 'closed' });
      const cached = freshClient();

      await Promise.all([
        cached.metrics.backendState('proxy-a'),
        cached.metrics.backendState('proxy-b'),
      ]);

      assert.equal(edge.callsTo('GET', '/admin/metrics').length, 1);
    });
  });
});
