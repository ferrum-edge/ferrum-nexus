/**
 * `/api/health` — public liveness/readiness for the portal itself.
 *
 * The Edge probe must never fail the endpoint. A gateway that is unreachable
 * (`edge.status = 'down'`) or reachable-but-unready (`'not_ready'`) both leave
 * the portal `degraded` on **HTTP 200**, so a load balancer keeps it in
 * rotation while the gateway recovers. Only a broken database makes the
 * overall status `down`, and that answers **HTTP 503** — container and
 * load-balancer probes key on the status code, not the body.
 *
 * **This endpoint is unauthenticated**, so no failure detail crosses it. A
 * driver message ("connect ECONNREFUSED 10.0.3.14:5432", `password
 * authentication failed for user "nexus_app"`) hands an anonymous caller
 * internal addresses and account names; the body carries the constant
 * {@link OPAQUE_ERROR} instead and the real text goes to the log.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

import {
  roleAtLeast,
  type AppHealth,
  type DependencyHealth,
  type EdgeHealth,
  type EdgeHealthStatus,
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
 *
 * `ready === false` is reported as `not_ready`, never as `down`: Edge answers
 * `503` with a full health payload while it is `starting`, `draining` or
 * `unavailable`, and conflating that with an unreachable gateway hid a
 * recovering gateway behind a connectivity diagnostic. A gateway that answered
 * without a `ready` field at all is taken at its word and reads `ok`.
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
  if (result.reachable && result.ready === false) {
    request.log.warn(
      { edgeStatus: result.status, mode: result.mode },
      'Ferrum Edge answered but is not ready',
    );
  }
  const status: EdgeHealthStatus = !result.reachable
    ? 'down'
    : result.ready === false
      ? 'not_ready'
      : 'ok';
  const detailAllowed =
    request.currentUser !== null && roleAtLeast(request.currentUser.role, 'admin');
  return {
    status,
    latency_ms: result.latencyMs,
    error: result.error === null ? null : detailAllowed ? result.error : OPAQUE_ERROR,
    ready: result.ready,
    mode: result.mode,
    admin_writes_enabled: result.adminWritesEnabled,
    edge_version: result.version,
    namespace,
  };
}

/** `/api/health` route plugin. */
export const healthRoutes: FastifyPluginAsync<HealthRoutesOptions> = async (app, options) => {
  const { config, store, edge } = options;

  app.get('/', async (request, reply: FastifyReply): Promise<AppHealth> => {
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

    // The database is load-bearing; the gateway only degrades the portal —
    // both `not_ready` and `down` on the Edge side keep the portal serving.
    const status: HealthStatus = !dbResult.ok
      ? 'down'
      : edgeHealth.status === 'ok'
        ? 'ok'
        : 'degraded';

    // Probes key on the status code: `down` must not answer 200, and
    // `degraded` must not answer 503 or a gateway restart pulls the whole
    // portal out of rotation.
    if (status === 'down') reply.status(503);

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
