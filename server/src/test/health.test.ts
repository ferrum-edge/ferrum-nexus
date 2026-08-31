import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type { AppHealth, EdgeHealth } from '@ferrum-nexus/shared';

import { buildTestApp, type TestApp } from './helpers.js';

describe('health endpoints', () => {
  let harness: TestApp;

  before(async () => {
    harness = await buildTestApp();
  });

  after(async () => {
    await harness.close();
  });

  it('reports ok when the database and the gateway are both up', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(response.statusCode, 200);

    const body = response.json<AppHealth>();
    assert.equal(body.status, 'ok');
    assert.equal(body.database.status, 'ok');
    assert.equal(body.database.driver, 'sqlite');
    assert.equal(body.database.error, null);
    assert.equal(body.edge.status, 'ok');
    assert.equal(body.edge.namespace, 'nexus');
    assert.equal(body.edge.edge_version, null, 'Ferrum Edge exposes no version endpoint');
    assert.ok(body.uptime_seconds >= 0);
    assert.ok(Date.parse(body.checked_at) > 0);
  });

  it('needs no authentication', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(response.statusCode, 200);
  });

  it('reports the gateway on its own endpoint', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/api/health/edge' });
    assert.equal(response.statusCode, 200);
    const body = response.json<EdgeHealth>();
    assert.equal(body.status, 'ok');
    assert.equal(body.error, null);
  });

  it('degrades — but does not fail — when the gateway is unreachable', async () => {
    await harness.edge.stop();
    try {
      const response = await harness.app.inject({ method: 'GET', url: '/api/health' });
      assert.equal(
        response.statusCode,
        200,
        'an unreachable gateway must not 5xx the portal probe',
      );

      const body = response.json<AppHealth>();
      assert.equal(body.status, 'degraded');
      assert.equal(body.database.status, 'ok');
      assert.equal(body.edge.status, 'down');
      assert.ok(body.edge.error, 'the failure detail is reported for operators');

      const edgeOnly = await harness.app.inject({ method: 'GET', url: '/api/health/edge' });
      assert.equal(edgeOnly.statusCode, 200);
      assert.equal(edgeOnly.json<EdgeHealth>().status, 'down');
    } finally {
      await harness.edge.start();
    }
  });

  it('reports the gateway error when Edge answers with a failure', async () => {
    harness.edge.queueFailure(503, { error: 'database unavailable' }, '/health');
    const response = await harness.app.inject({ method: 'GET', url: '/api/health/edge' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json<EdgeHealth>().status, 'down');
  });
});
