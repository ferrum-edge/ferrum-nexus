/**
 * `/api/health` — public liveness/readiness for the portal itself.
 *
 * The Edge probe must never fail the endpoint: an unreachable gateway is
 * reported as `edge.status = 'down'` with the overall status `degraded`, so a
 * load balancer keeps the portal in rotation while the gateway recovers.
 */

import type { FastifyPluginAsync } from 'fastify';

import type { AppHealth, DependencyHealth, EdgeHealth, HealthStatus } from '@ferrum-nexus/shared';

import type { NexusConfig } from '../config/index.js';
import type { NexusStore } from '../db/store.js';
import type { FerrumAdminClient } from '../ferrum-admin/index.js';

/** Version reported by `GET /api/health`. */
export const NEXUS_VERSION = process.env.npm_package_version ?? '0.1.0';

/** Services this route plugin needs. */
export interface HealthRoutesOptions {
  config: NexusConfig;
  store: NexusStore;
  edge: FerrumAdminClient;
}

const startedAt = Date.now();

async function probeEdge(edge: FerrumAdminClient, namespace: string): Promise<EdgeHealth> {
  const result = await edge.probe();
  return {
    status: result.reachable ? 'ok' : 'down',
    latency_ms: result.latencyMs,
    error: result.error,
    edge_version: result.version,
    namespace,
  };
}

/** `/api/health` route plugin. */
export const healthRoutes: FastifyPluginAsync<HealthRoutesOptions> = async (app, options) => {
  const { config, store, edge } = options;

  app.get('/', async (): Promise<AppHealth> => {
    const dbResult = await store.healthCheck();
    const database: DependencyHealth & { driver: AppHealth['database']['driver'] } = {
      status: dbResult.ok ? 'ok' : 'down',
      latency_ms: dbResult.latencyMs,
      error: dbResult.error,
      driver: config.db.driver,
    };
    const edgeHealth = await probeEdge(edge, config.edge.namespace);

    // The database is load-bearing; the gateway only degrades the portal.
    const status: HealthStatus = !dbResult.ok
      ? 'down'
      : edgeHealth.status === 'ok'
        ? 'ok'
        : 'degraded';

    return {
      status,
      version: NEXUS_VERSION,
      uptime_seconds: Math.round((Date.now() - startedAt) / 1000),
      checked_at: new Date().toISOString(),
      database,
      edge: edgeHealth,
    };
  });

  app.get('/edge', async (): Promise<EdgeHealth> => probeEdge(edge, config.edge.namespace));
};
