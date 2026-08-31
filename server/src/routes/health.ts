/**
 * `/api/health` — public liveness/readiness for the portal itself.
 *
 * The Edge probe must never fail the endpoint: an unreachable gateway is
 * reported as `edge.status = 'down'` with the overall status `degraded`, so a
 * load balancer keeps the portal in rotation while the gateway recovers.
 *
 * **This endpoint is unauthenticated**, so no failure detail crosses it. A
 * driver message ("connect ECONNREFUSED 10.0.3.14:5432", `password
 * authentication failed for user "nexus_app"`) hands an anonymous caller
 * internal addresses and account names; the body carries the constant
 * {@link OPAQUE_ERROR} instead and the real text goes to the log.
 */

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import {
  roleAtLeast,
  type AppHealth,
  type DependencyHealth,
  type EdgeHealth,
  type HealthStatus,
} from '@ferrum-nexus/shared';

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

/** What an unauthenticated caller is told instead of the driver's message. */
export const OPAQUE_ERROR = 'unreachable';

/**
 * Probe the gateway.
 *
 * `/api/health` is unauthenticated, and the probe's message can name the Admin
 * API's host and port, so the detail is reserved for admins the same way the
 * database driver's message is. Everyone else gets {@link OPAQUE_ERROR}; the
 * real text is always logged.
 */
async function probeEdge(
  edge: FerrumAdminClient,
  namespace: string,
  request: FastifyRequest,
): Promise<EdgeHealth> {
  const result = await edge.probe();
  if (!result.reachable && result.error !== null) {
    request.log.error({ error: result.error }, 'Ferrum Edge health probe failed');
  }
  const detailAllowed =
    request.currentUser !== null && roleAtLeast(request.currentUser.role, 'admin');
  return {
    status: result.reachable ? 'ok' : 'down',
    latency_ms: result.latencyMs,
    error: result.error === null ? null : detailAllowed ? result.error : OPAQUE_ERROR,
    edge_version: result.version,
    namespace,
  };
}

/** `/api/health` route plugin. */
export const healthRoutes: FastifyPluginAsync<HealthRoutesOptions> = async (app, options) => {
  const { config, store, edge } = options;

  app.get('/', async (request): Promise<AppHealth> => {
    const dbResult = await store.healthCheck();
    if (!dbResult.ok) {
      // The operator gets the driver's text; the caller gets a constant.
      request.log.error(
        { driver: config.db.driver, error: dbResult.error },
        'Database health check failed',
      );
    }
    const database: DependencyHealth & { driver: AppHealth['database']['driver'] } = {
      status: dbResult.ok ? 'ok' : 'down',
      latency_ms: dbResult.latencyMs,
      error: dbResult.ok ? null : OPAQUE_ERROR,
      driver: config.db.driver,
    };
    const edgeHealth = await probeEdge(edge, config.edge.namespace, request);

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

  app.get('/edge', async (request): Promise<EdgeHealth> =>
    probeEdge(edge, config.edge.namespace, request),
  );
};
