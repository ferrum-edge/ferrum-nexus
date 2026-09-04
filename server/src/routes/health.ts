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
 *
 * ## Why the probes are cached
 *
 * Being unauthenticated, these routes are also an amplifier: one cheap public
 * request used to become a database query *and* a signed Admin API call, with
 * no cache and no deduplication. A flood turned into downstream load on exactly
 * the two dependencies the portal cannot afford to lose, and a slow gateway
 * kept every one of those probes in flight for `FERRUM_ADMIN_TIMEOUT_MS`.
 *
 * So each dependency is probed at most once per `NEXUS_HEALTH_CACHE_MS`
 * (default 5 s) and concurrent callers share the one in-flight promise — the
 * same shape the metrics scrape in `ferrum-admin/client.ts` uses. A **failing**
 * probe is cached for the same window: probes key on the status code, and
 * serving a `down` a few seconds after the dependency recovered is much cheaper
 * than letting anonymous traffic set the probe rate. `checked_at` reports when
 * the probes actually ran, not when the request arrived.
 *
 * What is cached is the *raw* probe result. Every request still renders it
 * itself, so the admin-only detail rules below apply per caller and a cached
 * result never leaks a gateway diagnostic to an anonymous one.
 *
 * `NEXUS_HEALTH_CACHE_MS=0` disables the cache and probes on every request.
 * The request rate itself is bounded by the route-scoped limiter
 * (`HEALTH_RATE_LIMIT` in `server/src/index.ts`).
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
import type { EdgeProbe, FerrumAdminClient } from '../ferrum-admin/index.js';

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

/** A probe result and the moment it was taken. */
interface Probed<T> {
  value: T;
  /** Epoch milliseconds at which the underlying call started. */
  checkedAt: number;
}

/**
 * Memoise `run` for `ttlMs`, coalescing concurrent callers onto one call.
 *
 * The two halves answer different floods: the TTL bounds a *sustained* one to
 * a single probe per window, and the shared in-flight promise bounds a
 * *simultaneous* burst — the one that actually hurts, because a slow dependency
 * would otherwise hold one socket and one pending promise per inbound request.
 *
 * A rejection is never cached: the assignment happens after the await, and
 * `pending` is cleared either way, so the next caller retries. `ttlMs <= 0`
 * removes the memo entirely rather than shrinking it to nothing, so "no cache"
 * means exactly one probe per request and no coalescing either.
 */
function memoizeProbe<T>(ttlMs: number, run: () => Promise<T>): () => Promise<Probed<T>> {
  if (ttlMs <= 0) {
    return async () => {
      const checkedAt = Date.now();
      return { value: await run(), checkedAt };
    };
  }

  let cached: (Probed<T> & { expiresAt: number }) | null = null;
  let pending: Promise<Probed<T>> | null = null;

  return async function probe(): Promise<Probed<T>> {
    if (cached && cached.expiresAt > Date.now()) {
      return { value: cached.value, checkedAt: cached.checkedAt };
    }
    pending ??= (async () => {
      const checkedAt = Date.now();
      const value = await run();
      cached = { value, checkedAt, expiresAt: Date.now() + ttlMs };
      return { value, checkedAt };
    })().finally(() => {
      pending = null;
    });
    return pending;
  };
}

/**
 * Render a gateway probe for one caller.
 *
 * `/api/health` is unauthenticated, and the probe's message can name the Admin
 * API's host and port, so the detail is reserved for admins the same way the
 * database driver's message is. Everyone else gets {@link OPAQUE_ERROR}; the
 * real text is logged when the probe runs. This rendering happens per request
 * even when the result behind it was cached, so an anonymous caller never
 * inherits the rendering an admin got.
 *
 * `ready === false` is reported as `not_ready`, never as `down`: Edge answers
 * `503` with a full health payload while it is `starting`, `draining` or
 * `unavailable`, and conflating that with an unreachable gateway hid a
 * recovering gateway behind a connectivity diagnostic. A gateway that answered
 * without a `ready` field at all is taken at its word and reads `ok`.
 */
function presentEdge(result: EdgeProbe, namespace: string, request: FastifyRequest): EdgeHealth {
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
    // Edge itself only reveals `mode` and `admin_writes_enabled` to an
    // authenticated caller; the portal keeps the same line for its anonymous
    // probe. `ready` is the readiness signal a monitor needs and stays public.
    mode: detailAllowed ? result.mode : null,
    admin_writes_enabled: detailAllowed ? result.adminWritesEnabled : null,
    edge_version: result.version,
    namespace,
  };
}

/** `/api/health` route plugin. */
export const healthRoutes: FastifyPluginAsync<HealthRoutesOptions> = async (app, options) => {
  const { config, store, edge } = options;

  // Logging lives inside the memo rather than in the handler: a cached `down`
  // is served for the whole window, and re-logging it on every hit would
  // reproduce exactly the amplification the cache exists to stop.
  const probeDatabase = memoizeProbe(config.healthCacheMs, async () => {
    const result = await store.healthCheck();
    if (!result.ok) {
      // The operator gets the driver's text; the caller gets a constant.
      app.log.error(
        { driver: config.db.driver, error: result.error },
        'Database health check failed',
      );
    }
    return result;
  });

  const probeEdge = memoizeProbe(config.healthCacheMs, async () => {
    const result = await edge.probe();
    if (!result.reachable && result.error !== null) {
      app.log.error({ error: result.error }, 'Ferrum Edge health probe failed');
    }
    if (result.reachable && result.ready === false) {
      app.log.warn(
        { edgeStatus: result.status, mode: result.mode },
        'Ferrum Edge answered but is not ready',
      );
    }
    return result;
  });

  app.get('/', async (request, reply: FastifyReply): Promise<AppHealth> => {
    const [db, gateway] = await Promise.all([probeDatabase(), probeEdge()]);
    const dbResult = db.value;

    const database: DependencyHealth & { driver: AppHealth['database']['driver'] } = {
      status: dbResult.ok ? 'ok' : 'down',
      latency_ms: dbResult.latencyMs,
      error: dbResult.ok ? null : OPAQUE_ERROR,
      driver: config.db.driver,
    };
    const edgeHealth = presentEdge(gateway.value, config.edge.namespace, request);

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
      // The older of the two probes: the payload is only as fresh as its
      // stalest half, and a monitor reading this must not be told otherwise.
      checked_at: new Date(Math.min(db.checkedAt, gateway.checkedAt)).toISOString(),
      database,
      edge: edgeHealth,
    };
  });

  app.get('/edge', async (request): Promise<EdgeHealth> => {
    const gateway = await probeEdge();
    return presentEdge(gateway.value, config.edge.namespace, request);
  });
};
