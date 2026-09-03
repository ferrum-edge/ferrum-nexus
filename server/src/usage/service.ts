/**
 * Usage and backend health for one published API.
 *
 * ## The honest scope
 *
 * This service builds **no pipeline**. It reads the two things Ferrum Edge
 * already exposes for a proxy — the Prometheus counters on `GET /metrics` and
 * the runtime state on `GET /admin/metrics` — and shapes them for the owner's
 * overview card. Everything it cannot get from those two reads is absent rather
 * than invented:
 *
 * - **No time windows.** Edge's per-proxy counters are cumulative since the
 *   gateway process started. There is no "last 24h" to compute without storing
 *   history, and storing history is the warehouse this deliberately is not.
 * - **No per-consumer breakdown.** `ferrum_requests_total` is not labelled by
 *   consumer, so "who is calling this API" has no answer here. The grants list
 *   says who *may* call it; nothing on the gateway says who did.
 * - **No unique-consumer count**, for the same reason.
 *
 * ## Failure is a value, not an exception
 *
 * A provider opening an API page while the gateway is restarting must see the
 * page, not an error. Every gateway failure — unreachable, non-2xx, garbled
 * body — resolves to `available: false` with zeroed counters and HTTP `200`.
 * The only errors this service raises are the portal's own: `404` for an API
 * that does not exist and `403` for one the caller may not administer.
 */

import type {
  ApiUsageBackend,
  ApiUsageLatency,
  ApiUsageRequests,
  ApiUsageResponse,
  ApiUsageStatusClasses,
  Uuid,
} from '@ferrum-nexus/shared';

import type { ApiRecord, NexusStore, UserRecord } from '../db/store.js';
import type {
  EdgeBackendState,
  EdgeLatencyBucket,
  EdgeProxyMetrics,
  FerrumAdminClient,
} from '../ferrum-admin/index.js';
import { notFound } from '../lib/errors.js';
import type { PublishingService } from '../publishing/service.js';

/** Read-only usage view over the gateway's own telemetry. */
export interface UsageService {
  /**
   * What the gateway reports for one API's proxy.
   *
   * Requires the caller to be the API's owner or an administrator — the same
   * rule that governs every other provider-side operation on the row.
   */
  forApi(actor: UserRecord, apiId: Uuid): Promise<ApiUsageResponse>;
}

/** Dependencies of {@link createUsageService}. */
export interface UsageServiceDeps {
  store: NexusStore;
  edge: FerrumAdminClient;
  /** Reused only for {@link PublishingService.assertCanAdminister}. */
  publishing: PublishingService;
}

/* ── Percentiles ────────────────────────────────────────────────────────── */

/** Percentiles rendered on the usage card. */
const PERCENTILES = { p50: 0.5, p95: 0.95, p99: 0.99 } as const;

/**
 * Interpolate one quantile out of cumulative histogram buckets.
 *
 * This is Prometheus' own `histogram_quantile` rule, and inherits its
 * limitations: the answer is linear *inside* the bucket the quantile lands in,
 * so it is only as precise as that bucket is narrow, and a quantile that lands
 * in the open-ended `+Inf` bucket is reported as the largest finite bound
 * rather than as infinity.
 *
 * Returns `null` when there is nothing to interpolate — no buckets, no
 * observations, or no finite bound at all.
 */
export function interpolateQuantile(buckets: EdgeLatencyBucket[], quantile: number): number | null {
  if (buckets.length === 0) return null;

  const total = buckets[buckets.length - 1]?.count ?? 0;
  if (total <= 0) return null;

  const highestFinite = [...buckets].reverse().find((bucket) => Number.isFinite(bucket.le))?.le;
  if (highestFinite === undefined) return null;

  const rank = quantile * total;
  let lowerBound = 0;
  let lowerCount = 0;

  for (const bucket of buckets) {
    if (bucket.count < rank) {
      lowerBound = Number.isFinite(bucket.le) ? bucket.le : lowerBound;
      lowerCount = bucket.count;
      continue;
    }
    // The quantile falls in this bucket. An unbounded top bucket has no upper
    // edge to interpolate towards, so the histogram cannot say more than "at
    // least the last finite bound".
    if (!Number.isFinite(bucket.le)) return round(highestFinite);
    const span = bucket.count - lowerCount;
    if (span <= 0) return round(bucket.le);
    return round(lowerBound + ((rank - lowerCount) / span) * (bucket.le - lowerBound));
  }

  return round(highestFinite);
}

/** One decimal place: sub-millisecond precision is noise from a bucketed source. */
function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Every percentile the DTO carries, or `null` when the histogram is empty. */
function latencyFrom(metrics: EdgeProxyMetrics): ApiUsageLatency | null {
  if (!metrics.available) return null;
  const p50 = interpolateQuantile(metrics.latency.buckets, PERCENTILES.p50);
  const p95 = interpolateQuantile(metrics.latency.buckets, PERCENTILES.p95);
  const p99 = interpolateQuantile(metrics.latency.buckets, PERCENTILES.p99);
  if (p50 === null || p95 === null || p99 === null) return null;
  return { p50, p95, p99 };
}

/* ── Counters ───────────────────────────────────────────────────────────── */

function emptyRequests(): ApiUsageRequests {
  return {
    total: 0,
    by_status_class: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 },
    by_status: {},
    by_method: {},
    rate_limited: 0,
    unauthorized: 0,
    forbidden: 0,
  };
}

/** Fold `status_code` labels into classes and the three codes worth naming. */
function requestsFrom(metrics: EdgeProxyMetrics): ApiUsageRequests {
  const classes: ApiUsageStatusClasses = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };

  for (const [status, count] of Object.entries(metrics.requests.byStatus)) {
    const code = Number(status);
    // A non-numeric `status_code` (a gRPC-only series, say) still belongs in
    // `by_status`, but there is no HTTP class to charge it to.
    if (!Number.isInteger(code)) continue;
    if (code >= 200 && code < 300) classes['2xx'] += count;
    else if (code >= 300 && code < 400) classes['3xx'] += count;
    else if (code >= 400 && code < 500) classes['4xx'] += count;
    else if (code >= 500 && code < 600) classes['5xx'] += count;
  }

  return {
    total: metrics.requests.total,
    by_status_class: classes,
    by_status: { ...metrics.requests.byStatus },
    by_method: { ...metrics.requests.byMethod },
    rate_limited: metrics.requests.byStatus['429'] ?? 0,
    unauthorized: metrics.requests.byStatus['401'] ?? 0,
    forbidden: metrics.requests.byStatus['403'] ?? 0,
  };
}

/* ── Backend state ──────────────────────────────────────────────────────── */

/** Name a breaker's scope so the detail sentence points at something real. */
function scopeOf(target: string | undefined): string {
  return target ? ` for target ${target}` : '';
}

/**
 * Turn Edge's breaker and health-check state into one verdict.
 *
 * The mapping is deliberately conservative about `unknown`: Edge lists a
 * circuit breaker only for a proxy that both *has* one configured and *has been
 * called*, so silence means "nothing to report", never "healthy".
 */
function backendFrom(state: EdgeBackendState, hasTraffic: boolean): ApiUsageBackend {
  if (!state.available) {
    return {
      status: 'unknown',
      detail: 'The gateway could not be reached for its backend state.',
    };
  }

  const open = state.breakers.find((breaker) => breaker.state === 'open');
  if (open) {
    return {
      status: 'failing',
      detail: `The gateway's circuit breaker is open${scopeOf(open.target)}; calls are being rejected without reaching the backend.`,
    };
  }

  const ejected = state.unhealthyTargets[0];
  if (ejected) {
    const since =
      typeof ejected.since_epoch_ms === 'number' && Number.isFinite(ejected.since_epoch_ms)
        ? new Date(ejected.since_epoch_ms).toISOString()
        : undefined;
    const kind = ejected.type === 'active' ? 'Active health checking' : 'Passive health checking';
    return {
      status: 'failing',
      detail: `${kind} has taken ${ejected.target ?? 'the backend'} out of rotation.`,
      ...(since ? { since } : {}),
    };
  }

  const halfOpen = state.breakers.find((breaker) => breaker.state === 'half_open');
  if (halfOpen) {
    return {
      status: 'recovering',
      detail: `The gateway's circuit breaker is half-open${scopeOf(halfOpen.target)}; it is letting probe traffic through to see whether the backend has recovered.`,
    };
  }

  const closed = state.breakers.find((breaker) => breaker.state === 'closed');
  if (closed) {
    return {
      status: 'healthy',
      detail: `The gateway's circuit breaker is closed${scopeOf(closed.target)}; traffic is flowing to the backend.`,
    };
  }

  return {
    status: 'unknown',
    detail: hasTraffic
      ? 'No circuit breaker is configured for this API, so the gateway reports no backend state.'
      : 'No traffic has reached this API yet, so the gateway has no backend state to report.',
  };
}

/* ── Service ────────────────────────────────────────────────────────────── */

/** Build the usage service. */
export function createUsageService(deps: UsageServiceDeps): UsageService {
  const { store, edge, publishing } = deps;

  async function loadApi(apiId: Uuid): Promise<ApiRecord> {
    const api = await store.apis.findById(apiId);
    if (!api) throw notFound('API', apiId);
    return api;
  }

  return {
    async forApi(actor: UserRecord, apiId: Uuid): Promise<ApiUsageResponse> {
      const api = await loadApi(apiId);
      publishing.assertCanAdminister(actor, api);

      const sampledAt = new Date().toISOString();
      const proxyId = api.ferrum_proxy_id;

      // An API row can outlive its proxy (a failed publish, a retired API whose
      // proxy was removed by hand). There is nothing on the gateway to read.
      if (!proxyId) {
        return {
          available: false,
          sampled_at: sampledAt,
          requests: emptyRequests(),
          latency_ms: null,
          backend: {
            status: 'unknown',
            detail: 'This API has no proxy on the gateway, so there is nothing to measure.',
          },
        };
      }

      // Independent reads of two endpoints; neither rejects.
      const [metrics, backendState] = await Promise.all([
        edge.metrics.scrapeProxy(proxyId),
        edge.metrics.backendState(proxyId),
      ]);

      const requests = metrics.available ? requestsFrom(metrics) : emptyRequests();
      const backend = backendFrom(backendState, requests.total > 0);

      return {
        // Either read succeeding is worth showing: a reachable gateway with an
        // unreadable exposition still has a truthful backend verdict, and vice
        // versa.
        available: metrics.available || backendState.available,
        sampled_at: sampledAt,
        ...(backendState.uptimeSeconds !== null
          ? { gateway_uptime_seconds: backendState.uptimeSeconds }
          : {}),
        requests,
        latency_ms: latencyFrom(metrics),
        backend,
      };
    },
  };
}
