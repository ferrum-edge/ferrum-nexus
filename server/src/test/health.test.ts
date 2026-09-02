import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type { AppHealth, EdgeHealth } from '@ferrum-nexus/shared';

import { OPAQUE_ERROR } from '../routes/health.js';
import { buildTestApp, type TestApp, type TestSession } from './helpers.js';

describe('health endpoints', () => {
  let harness: TestApp;
  /** The first account registered on an empty portal is the super_admin. */
  let admin: TestSession;

  before(async () => {
    harness = await buildTestApp();
    admin = await harness.registerUser();
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
    assert.equal(body.edge.ready, true);
    assert.equal(body.edge.mode, null, 'gateway mode is admin-only detail');
    assert.equal(body.edge.admin_writes_enabled, null, 'admin-only detail');
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
      assert.equal(
        body.edge.error,
        OPAQUE_ERROR,
        'an anonymous caller is told the gateway is down, not where it lives',
      );

      const edgeOnly = await harness.app.inject({ method: 'GET', url: '/api/health/edge' });
      assert.equal(edgeOnly.statusCode, 200);
      assert.equal(edgeOnly.json<EdgeHealth>().status, 'down');
    } finally {
      await harness.edge.start();
    }
  });

  it('gives an admin the real gateway diagnostic', async () => {
    await harness.edge.stop();
    try {
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/health',
        headers: { cookie: admin.cookieHeader },
      });
      const body = response.json<AppHealth>();
      assert.equal(body.edge.status, 'down');
      assert.notEqual(
        body.edge.error,
        OPAQUE_ERROR,
        'an operator still needs the underlying probe failure',
      );
      assert.ok(body.edge.error);
    } finally {
      await harness.edge.start();
    }
  });

  it('reports a gateway that answered 503 as not_ready, not down', async () => {
    // Edge serves the *whole* health payload with a 503 while it is starting,
    // draining or unavailable. That is a reachable gateway, and treating it as
    // unreachable hid a recovering gateway behind a connectivity diagnostic.
    harness.edge.setHealth({
      status: 'starting',
      ready: false,
      mode: 'database',
      admin_writes_enabled: false,
    });
    try {
      const response = await harness.app.inject({ method: 'GET', url: '/api/health' });
      assert.equal(response.statusCode, 200, 'an unready gateway must not 5xx the portal probe');

      const body = response.json<AppHealth>();
      assert.equal(body.status, 'degraded');
      assert.equal(body.edge.status, 'not_ready');
      assert.equal(body.edge.ready, false);
      assert.equal(body.edge.mode, null);
      assert.equal(body.edge.admin_writes_enabled, null);
      assert.equal(body.edge.error, null, 'a 503 health payload is not a probe failure');

      const detailed = await harness.authed(admin, { method: 'GET', url: '/api/health' });
      assert.equal(detailed.statusCode, 200);
      assert.equal(detailed.json<AppHealth>().edge.mode, 'database');
      assert.equal(detailed.json<AppHealth>().edge.admin_writes_enabled, false);

      const edgeOnly = await harness.app.inject({ method: 'GET', url: '/api/health/edge' });
      assert.equal(edgeOnly.statusCode, 200);
      assert.equal(edgeOnly.json<EdgeHealth>().status, 'not_ready');
    } finally {
      harness.edge.setHealth({
        status: 'ok',
        ready: true,
        mode: 'database',
        admin_writes_enabled: true,
        database: { status: 'connected', type: 'sqlite' },
      });
    }
  });

  it('answers 503 when the database is down, and 200 while only the gateway is', async () => {
    const original = harness.store.healthCheck.bind(harness.store);
    harness.store.healthCheck = async () => ({ ok: false, latencyMs: 3, error: 'db is gone' });
    try {
      const response = await harness.app.inject({ method: 'GET', url: '/api/health' });
      assert.equal(
        response.statusCode,
        503,
        'container and load-balancer probes key on the status code, not the body',
      );
      assert.equal(response.json<AppHealth>().status, 'down');
    } finally {
      harness.store.healthCheck = original;
    }

    // A gateway outage alone must keep the portal in rotation.
    await harness.edge.stop();
    try {
      const response = await harness.app.inject({ method: 'GET', url: '/api/health' });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json<AppHealth>().status, 'degraded');
    } finally {
      await harness.edge.start();
    }
  });

  it('never echoes the driver’s message to an anonymous caller', async () => {
    const original = harness.store.healthCheck.bind(harness.store);
    // What a real driver hands back, host and role name included.
    const leaky =
      'connect ECONNREFUSED 10.0.3.14:5432 — password authentication failed for user "nexus_app"';
    harness.store.healthCheck = async () => ({ ok: false, latencyMs: 4, error: leaky });

    try {
      const response = await harness.app.inject({ method: 'GET', url: '/api/health' });
      assert.equal(response.statusCode, 503, 'a dead database fails the probe');

      const body = response.json<AppHealth>();
      assert.equal(body.status, 'down');
      assert.equal(body.database.status, 'down');
      assert.equal(body.database.error, 'unreachable');

      for (const secret of ['10.0.3.14', '5432', 'nexus_app', 'ECONNREFUSED', 'password']) {
        assert.ok(
          !response.body.includes(secret),
          `the public probe leaked ${secret}: ${response.body}`,
        );
      }
    } finally {
      harness.store.healthCheck = original;
    }
  });

  it('reports the gateway error when Edge answers with a failure', async () => {
    harness.edge.queueFailure(503, { error: 'database unavailable' }, '/health');
    const response = await harness.app.inject({ method: 'GET', url: '/api/health/edge' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json<EdgeHealth>().status, 'down');
  });
});
