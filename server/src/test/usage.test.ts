import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { ApiErrorBody, ApiUsageResponse, PublishApiResponse } from '@ferrum-nexus/shared';

import { SAMPLE_SPEC_YAML, buildTestApp, type TestApp, type TestSession } from './helpers.js';

function errorCode(body: string): string {
  return (JSON.parse(body) as ApiErrorBody).error.code;
}

describe('api usage', () => {
  let harness: TestApp;
  let founder: TestSession;
  let provider: TestSession;
  let otherProvider: TestSession;
  let client: TestSession;

  /** Publish an API as `provider` and return its Nexus id and Edge proxy id. */
  async function publishApi(slug: string): Promise<{ apiId: string; proxyId: string }> {
    const response = await harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: {
        name: 'Billing API',
        slug,
        version: '2.4.0',
        spec: SAMPLE_SPEC_YAML,
        auth_plugin: 'key_auth',
        requestable: true,
        visibility: 'public',
      },
    });
    assert.equal(response.statusCode, 201);
    const body = response.json<PublishApiResponse>();
    assert.ok(body.api.ferrum_proxy_id, 'expected the publish to create a proxy');
    return { apiId: body.api.id, proxyId: body.api.ferrum_proxy_id };
  }

  async function usageFor(session: TestSession, apiId: string): Promise<ApiUsageResponse> {
    const response = await harness.authed(session, {
      method: 'GET',
      url: `/api/apis/${apiId}/usage`,
    });
    assert.equal(response.statusCode, 200);
    return response.json<ApiUsageResponse>();
  }

  beforeEach(async () => {
    harness = await buildTestApp();
    founder = await harness.registerUser({ email: 'usage-founder@example.test' });
    provider = await harness.registerUser({
      email: 'usage-provider@example.test',
      role: 'provider',
    });
    otherProvider = await harness.registerUser({
      email: 'usage-other@example.test',
      role: 'provider',
    });
    client = await harness.registerUser({ email: 'usage-client@example.test', role: 'client' });
  });

  afterEach(async () => {
    await harness.close();
  });

  describe('counters', () => {
    it('gives the owner the gateway’s counts, classes and latency', async () => {
      const { apiId, proxyId } = await publishApi('usage-counts');

      harness.edge.recordRequests(proxyId, { method: 'GET', status: 200, count: 1_200 });
      harness.edge.recordRequests(proxyId, { method: 'POST', status: 201, count: 40 });
      harness.edge.recordRequests(proxyId, { method: 'GET', status: 302, count: 1 });
      harness.edge.recordRequests(proxyId, { method: 'GET', status: 429, count: 18 });
      harness.edge.recordRequests(proxyId, { method: 'GET', status: 401, count: 5 });
      harness.edge.recordRequests(proxyId, { method: 'GET', status: 403, count: 2 });
      harness.edge.recordRequests(proxyId, { method: 'GET', status: 500, count: 7 });
      harness.edge.recordRequests(proxyId, {
        method: 'GET',
        status: 200,
        count: 0,
        durations: [2, 3, 4, 6, 7, 8, 9, 12, 15, 300],
      });
      harness.edge.setBackendState(proxyId, { breaker: 'closed' });

      const usage = await usageFor(provider, apiId);

      assert.equal(usage.available, true);
      assert.equal(usage.gateway_uptime_seconds, 3_600);
      assert.ok(Date.parse(usage.sampled_at) > 0);

      assert.equal(usage.requests.total, 1_273);
      assert.deepEqual(usage.requests.by_status_class, {
        '2xx': 1_240,
        '3xx': 1,
        '4xx': 25,
        '5xx': 7,
      });
      assert.equal(usage.requests.rate_limited, 18);
      assert.equal(usage.requests.unauthorized, 5);
      assert.equal(usage.requests.forbidden, 2);
      assert.deepEqual(usage.requests.by_method, { GET: 1_233, POST: 40 });
      assert.equal(usage.requests.by_status['200'], 1_200);

      // Interpolated inside the bucket the quantile lands in, exactly as
      // `histogram_quantile` does — see the fixed bucket ladder in the mock.
      assert.deepEqual(usage.latency_ms, { p50: 7.5, p95: 375, p99: 475 });

      assert.equal(usage.backend.status, 'healthy');
    });

    it('reports zero and no latency for an API nothing has called', async () => {
      const { apiId } = await publishApi('usage-quiet');

      const usage = await usageFor(provider, apiId);

      assert.equal(usage.available, true);
      assert.equal(usage.requests.total, 0);
      assert.equal(usage.latency_ms, null);
      assert.equal(usage.backend.status, 'unknown');
      assert.match(String(usage.backend.detail), /No traffic/i);
    });

    it('does not count another API’s traffic', async () => {
      const mine = await publishApi('usage-mine');
      const theirs = await publishApi('usage-theirs');

      harness.edge.recordRequests(theirs.proxyId, { method: 'GET', status: 200, count: 5_000 });
      harness.edge.recordRequests(mine.proxyId, { method: 'GET', status: 200, count: 3 });

      const usage = await usageFor(provider, mine.apiId);

      assert.equal(usage.requests.total, 3);
    });
  });

  describe('backend state', () => {
    it('maps an open breaker to failing', async () => {
      const { apiId, proxyId } = await publishApi('usage-open');
      harness.edge.setBackendState(proxyId, { breaker: 'open' });

      const usage = await usageFor(provider, apiId);

      assert.equal(usage.backend.status, 'failing');
      assert.match(String(usage.backend.detail), /circuit breaker is open/i);
    });

    it('maps a half-open breaker to recovering', async () => {
      const { apiId, proxyId } = await publishApi('usage-half');
      harness.edge.setBackendState(proxyId, { breaker: 'half_open' });

      const usage = await usageFor(provider, apiId);

      assert.equal(usage.backend.status, 'recovering');
    });

    it('treats an ejected target as failing even behind a closed breaker', async () => {
      const { apiId, proxyId } = await publishApi('usage-ejected');
      harness.edge.setBackendState(proxyId, {
        breaker: 'closed',
        unhealthyTarget: '10.0.5.7:8080',
      });

      const usage = await usageFor(provider, apiId);

      assert.equal(usage.backend.status, 'failing');
      assert.match(String(usage.backend.detail), /10\.0\.5\.7:8080/);
      assert.ok(usage.backend.since && Date.parse(usage.backend.since) > 0);
    });

    it('says why it is unknown when traffic exists but no breaker is configured', async () => {
      const { apiId, proxyId } = await publishApi('usage-nobreaker');
      harness.edge.recordRequests(proxyId, { method: 'GET', status: 200, count: 12 });

      const usage = await usageFor(provider, apiId);

      assert.equal(usage.backend.status, 'unknown');
      assert.match(String(usage.backend.detail), /No circuit breaker is configured/i);
    });
  });

  describe('gateway failures', () => {
    it('answers 200 with available:false when the gateway is unreachable', async () => {
      const { apiId, proxyId } = await publishApi('usage-offline');
      harness.edge.recordRequests(proxyId, { method: 'GET', status: 200, count: 9 });

      await harness.edge.stop();
      try {
        const usage = await usageFor(provider, apiId);

        assert.equal(usage.available, false);
        assert.equal(usage.requests.total, 0);
        assert.deepEqual(usage.requests.by_status, {});
        assert.equal(usage.latency_ms, null);
        assert.equal(usage.backend.status, 'unknown');
        assert.equal(usage.gateway_uptime_seconds, undefined);
      } finally {
        await harness.edge.start();
      }
    });

    it('answers 200 with available:false when the metrics endpoints error', async () => {
      const { apiId } = await publishApi('usage-erroring');
      // The two scrapes run concurrently and the mock hands a request the
      // *first* queued failure whose substring matches, and `/admin/metrics`
      // contains `/metrics` — so the narrower path is queued first to keep the
      // outcome independent of which request lands first.
      harness.edge.queueFailure(500, { error: 'boom' }, '/admin/metrics', 'GET');
      harness.edge.queueFailure(503, { error: 'metrics disabled' }, '/metrics', 'GET');

      const usage = await usageFor(provider, apiId);

      assert.equal(usage.available, false);
      assert.equal(usage.requests.total, 0);
    });
  });

  describe('authorization', () => {
    it('lets an administrator read another provider’s API', async () => {
      const { apiId, proxyId } = await publishApi('usage-admin');
      harness.edge.recordRequests(proxyId, { method: 'GET', status: 200, count: 4 });

      const usage = await usageFor(founder, apiId);

      assert.equal(usage.requests.total, 4);
    });

    it('refuses another provider', async () => {
      const { apiId } = await publishApi('usage-forbidden');

      const response = await harness.authed(otherProvider, {
        method: 'GET',
        url: `/api/apis/${apiId}/usage`,
      });

      assert.equal(response.statusCode, 403);
      assert.equal(errorCode(response.body), 'FORBIDDEN');
    });

    it('refuses a client outright — the whole plugin is provider-only', async () => {
      const { apiId } = await publishApi('usage-client');

      const response = await harness.authed(client, {
        method: 'GET',
        url: `/api/apis/${apiId}/usage`,
      });

      assert.equal(response.statusCode, 403);
    });

    it('requires a session', async () => {
      const { apiId } = await publishApi('usage-anon');

      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/apis/${apiId}/usage`,
      });

      assert.equal(response.statusCode, 401);
    });

    it('404s for an API that does not exist', async () => {
      const response = await harness.authed(provider, {
        method: 'GET',
        url: '/api/apis/00000000-0000-4000-8000-000000000000/usage',
      });

      assert.equal(response.statusCode, 404);
      assert.equal(errorCode(response.body), 'NOT_FOUND');
    });
  });
});
