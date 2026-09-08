import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AuditAction } from '../audit/service.js';
import { buildTestApp } from '../test/helpers.js';
import { reconcileGateway } from './reconcile.js';

describe('startup gateway reconciliation', () => {
  it('creates and audits the global metrics prerequisite only once', async () => {
    const harness = await buildTestApp();
    try {
      const reconcile = () =>
        reconcileGateway(harness.edgeClient, harness.services.audit, harness.app.log);
      await Promise.all([reconcile(), reconcile()]);
      const configs = [...harness.edge.pluginConfigs.values()];
      assert.equal(configs.length, 1);
      assert.equal(configs[0]?.plugin_name, 'prometheus_metrics');
      assert.equal(configs[0]?.scope, 'global');
      assert.equal(configs[0]?.namespace, 'nexus');
      assert.equal(configs[0]?.enabled, true);
      assert.equal(configs[0]?.proxy_id, undefined);
      assert.deepEqual(configs[0]?.config, {});
      const rows = await harness.auditRows(AuditAction.GATEWAY_METRICS_ENABLE);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.actor_user_id, null);
      harness.edge.recordRequests('proxy-a', {
        method: 'GET',
        status: 200,
        count: 2,
        durations: [10, 20],
      });
      const metrics = await harness.edgeClient.metrics.scrapeProxy('proxy-a');
      assert.equal(metrics.available, true);
      assert.equal(metrics.requests.total, 2);
      assert.equal(metrics.latency.sum, 30);
    } finally {
      await harness.close();
    }
  });

  it('preserves an operator config, including disabled state and custom settings', async () => {
    const harness = await buildTestApp();
    try {
      const existing = await harness.edgeClient.pluginConfigs.create({
        plugin_name: 'prometheus_metrics',
        scope: 'global',
        enabled: false,
        config: { render_cache_ttl_seconds: 12 },
      });
      await reconcileGateway(harness.edgeClient, harness.services.audit, harness.app.log);
      assert.deepEqual(await harness.edgeClient.pluginConfigs.get(existing.id), existing);
      assert.equal(harness.edge.pluginConfigs.size, 1);
      assert.equal((await harness.auditRows(AuditAction.GATEWAY_METRICS_ENABLE)).length, 0);
      assert.equal(harness.edge.callsTo('PUT', `/plugins/config/${existing.id}`).length, 0);
    } finally {
      await harness.close();
    }
  });

  it('skips creation after a failed scan and retries on the next reconciliation', async () => {
    const harness = await buildTestApp();
    try {
      harness.edge.queueFailure(503, { error: 'not ready' }, '/plugins/config', 'GET');
      await reconcileGateway(harness.edgeClient, harness.services.audit, harness.app.log);
      assert.equal(harness.edge.pluginConfigs.size, 0);
      await reconcileGateway(harness.edgeClient, harness.services.audit, harness.app.log);
      assert.equal(harness.edge.pluginConfigs.size, 1);
    } finally {
      await harness.close();
    }
  });

  it('does not let a proxy-scoped config satisfy the global prerequisite', async () => {
    const harness = await buildTestApp();
    try {
      harness.edge.pluginConfigs.set('nexus|operator-metrics', {
        id: 'operator-metrics',
        namespace: 'nexus',
        plugin_name: 'prometheus_metrics',
        scope: 'proxy',
        proxy_id: 'operator-proxy',
        enabled: true,
        config: {},
      });
      await reconcileGateway(harness.edgeClient, harness.services.audit, harness.app.log);
      assert.equal(harness.edge.pluginConfigs.size, 2);
      assert.equal((await harness.auditRows(AuditAction.GATEWAY_METRICS_ENABLE)).length, 1);
    } finally {
      await harness.close();
    }
  });
});
