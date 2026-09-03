/**
 * The only module in Nexus that speaks the Ferrum Edge Admin API's HTTP shape.
 *
 * Everything above it deals in domain objects and `NexusError`s. Failures are
 * classified into exactly two codes:
 *
 * - `EDGE_UNAVAILABLE` — DNS, connect, TLS, socket or timeout. Nothing reached
 *   the gateway.
 * - `EDGE_ERROR` — the gateway answered with a non-2xx status.
 *
 * Edge's flat `{"error": "..."}` text is always logged. Whether it is *also*
 * echoed to the caller depends on who the message is about:
 *
 * - `400`, `409` and `422` are Edge validating the body Nexus just built out of
 *   the caller's own request ("FERRUM_BASIC_AUTH_HMAC_SECRET must be set…",
 *   "listen_path already exists in this namespace"). A provider cannot fix
 *   those without reading them, so the text rides along in
 *   `details.gateway_message` (trimmed to {@link MAX_GATEWAY_MESSAGE} chars).
 * - `401`, `403` and every `5xx` stay **opaque**: those describe the gateway's
 *   own configuration or the Nexus↔Edge trust relationship, not the caller's
 *   request, and can name internal hosts and settings.
 *
 * A `503` carrying `applied: false` is a special case worth knowing about: the
 * write **is durable**, it just is not live yet. It surfaces as `EDGE_ERROR`
 * with an explicit message and is never retried automatically — a blind retry
 * of a create would `409`.
 */

import { readFileSync } from 'node:fs';

import { Agent, request, type Dispatcher } from 'undici';

import type { EdgeCredentialType } from '@ferrum-nexus/shared';

import type { EdgeConfig } from '../config/index.js';
import { edgeError, edgeUnavailable, internal } from '../lib/errors.js';
import { createAdminTokenMinter, DEFAULT_ADMIN_SUBJECT, type AdminTokenMinter } from './jwt.js';
import { parsePrometheusText, type PrometheusSample } from './prometheus.js';
import type {
  EdgeBackendState,
  EdgeCircuitBreaker,
  EdgeConsumer,
  EdgeConsumerWrite,
  EdgeCredentialEntry,
  EdgeHealth,
  EdgeLatencyBucket,
  EdgeListQuery,
  EdgePage,
  EdgePluginConfig,
  EdgePluginConfigWrite,
  EdgeProbe,
  EdgeProxy,
  EdgeProxyMetrics,
  EdgeProxyReplace,
  EdgeProxyWrite,
  EdgeUnhealthyTarget,
} from './types.js';

/** Minimal logger surface, so this module does not depend on Fastify. */
export interface EdgeLogger {
  debug(obj: Record<string, unknown>, message?: string): void;
  warn(obj: Record<string, unknown>, message?: string): void;
  error(obj: Record<string, unknown>, message?: string): void;
}

/** A logger that drops everything — the default when none is supplied. */
export const silentEdgeLogger: EdgeLogger = {
  debug: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/* ── Per-key serialization ──────────────────────────────────────────────── */

/** Runs work serially per key; independent keys still run concurrently. */
export type KeyedSerializer = <T>(key: string, fn: () => Promise<T>) => Promise<T>;

/**
 * Build a per-key promise queue.
 *
 * Consumer mutations **must** go through this: `PUT /consumers/{id}` is a
 * whole-resource replace with no concurrency token, so two concurrent
 * GET→edit→PUT round trips would silently lose one ACL group change
 * (`ref-edge-admin.md` §7.2).
 *
 * **Multi-instance caveat:** this serialises within one Node process only. A
 * horizontally scaled Nexus needs either sticky routing per consumer or an
 * external lock; until then, run one writer.
 */
export function createKeyedSerializer(): KeyedSerializer {
  const queues = new Map<string, Promise<unknown>>();

  return function serializePerKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = queues.get(key) ?? Promise.resolve();
    const result = previous.then(fn, fn);
    const guard: Promise<void> = result
      .then(
        () => undefined,
        () => undefined,
      )
      .then(() => {
        if (queues.get(key) === guard) queues.delete(key);
      });
    queues.set(key, guard);
    return result;
  };
}

/* ── Client ─────────────────────────────────────────────────────────────── */

/** Options for one Admin API call. */
interface CallOptions {
  /** JSON request body. */
  body?: unknown;
  /** Query string parameters; `undefined` values are dropped. */
  query?: Record<string, string | number | boolean | undefined>;
  /** Return `null` instead of throwing when Edge answers `404`. */
  allow404?: boolean;
  /** Additional statuses to treat as success (e.g. `409` for "already exists"). */
  tolerate?: number[];
  /** Override the JWT `sub` claim so Edge's audit log names the acting user. */
  subject?: string;
}

/** Typed client for the subset of the Ferrum Edge Admin API that Nexus uses. */
export interface FerrumAdminClient {
  /** Namespace sent in `X-Ferrum-Namespace` on every namespace-scoped call. */
  readonly namespace: string;

  /**
   * Authenticated `GET /health` — reports `status`, `ready`, `mode` and
   * `admin_writes_enabled`.
   *
   * Edge answers **`503` with a complete health payload** whenever it is not
   * ready (`starting`, `draining`, `unavailable`). That is a reachable gateway
   * reporting its own state, so the body is parsed and returned rather than
   * classified as a failure; only a `503` that is *not* a health payload (or
   * any other non-2xx) throws.
   */
  health(): Promise<EdgeHealth>;
  /** Unauthenticated `GET /live`. `true` when the gateway answered `200`. */
  live(): Promise<boolean>;
  /**
   * Best-effort version probe. Edge has **no `/version` endpoint**
   * (`ref-edge-admin.md` §10.5), so this returns `null` on a 404 rather than
   * failing; take the real version from your deployment metadata.
   */
  version(): Promise<string | null>;
  /** Combined reachability probe for `GET /api/health`; never throws. */
  probe(): Promise<EdgeProbe>;

  /** `GET /namespaces` — a list of name strings. */
  listNamespaces(): Promise<string[]>;
  /**
   * Make sure the configured namespace exists. Writing any resource with a new
   * `X-Ferrum-Namespace` already isolates data, so a failure here is logged and
   * swallowed rather than blocking startup.
   */
  ensureNamespace(description?: string): Promise<void>;

  readonly consumers: {
    list(query?: EdgeListQuery): Promise<EdgePage<EdgeConsumer>>;
    get(id: string): Promise<EdgeConsumer | null>;
    /**
     * Find a consumer by `username` by scanning `GET /consumers` pages — Edge
     * has no username filter. Nexus normally reads the mapping from its own
     * `consumers` table; this is the reconciliation path.
     */
    getByUsername(username: string): Promise<EdgeConsumer | null>;
    create(body: EdgeConsumerWrite, subject?: string): Promise<EdgeConsumer>;
    /**
     * Whole-resource replace. **Always build the body from a `get()` response** —
     * omitting `keyauth`/`jwt` deletes those credentials.
     */
    replace(id: string, body: EdgeConsumerWrite, subject?: string): Promise<EdgeConsumer>;
    delete(id: string, subject?: string): Promise<void>;
    /** Append one credential entry (rotation step 1). */
    addCredential(
      id: string,
      type: EdgeCredentialType,
      entry: EdgeCredentialEntry,
      subject?: string,
    ): Promise<EdgeConsumer>;
    /** Replace every entry of a credential type. */
    replaceCredentials(
      id: string,
      type: EdgeCredentialType,
      entries: EdgeCredentialEntry[],
      subject?: string,
    ): Promise<EdgeConsumer>;
    /** Remove one entry by 0-based index (rotation step 3); the array re-indexes. */
    deleteCredentialAt(
      id: string,
      type: EdgeCredentialType,
      index: number,
      subject?: string,
    ): Promise<EdgeConsumer>;
    /** Remove a whole credential type. Idempotent for the built-in types. */
    deleteCredentialType(id: string, type: EdgeCredentialType, subject?: string): Promise<void>;
  };

  readonly proxies: {
    list(query?: EdgeListQuery): Promise<EdgePage<EdgeProxy>>;
    get(id: string): Promise<EdgeProxy | null>;
    create(body: EdgeProxyWrite, subject?: string): Promise<EdgeProxy>;
    /**
     * Whole-resource replace. The body must be a `GET` response with the
     * changed fields overwritten — see {@link EdgeProxyReplace}.
     */
    replace(id: string, body: EdgeProxyReplace, subject?: string): Promise<EdgeProxy>;
    delete(id: string, subject?: string): Promise<void>;
  };

  readonly pluginConfigs: {
    list(query?: EdgeListQuery): Promise<EdgePage<EdgePluginConfig>>;
    /**
     * Every plugin config attached to one proxy.
     *
     * `GET /plugins/config` has **no `proxy_id` filter** and clamps `limit` to
     * Edge's `MAX_PAGE_SIZE` of 1000, so this walks every page and filters
     * client-side. A single-page read silently truncated on any gateway
     * carrying more than 1000 plugin configs in the namespace.
     */
    listByProxy(proxyId: string): Promise<EdgePluginConfig[]>;
    get(id: string): Promise<EdgePluginConfig | null>;
    create(body: EdgePluginConfigWrite, subject?: string): Promise<EdgePluginConfig>;
    replace(id: string, body: EdgePluginConfigWrite, subject?: string): Promise<EdgePluginConfig>;
    delete(id: string, subject?: string): Promise<void>;
  };

  /**
   * Read-only runtime telemetry for one proxy.
   *
   * Both calls are **best-effort diagnostics and never throw**: an unreachable
   * gateway, a non-2xx answer or an unparseable body all resolve to a result
   * with `available: false` and empty counters. They are rendered on a
   * provider's overview card, and a gateway hiccup must not turn that page into
   * an error.
   *
   * Both are cached in-process per proxy for {@link METRICS_CACHE_TTL_MS}. Edge
   * caches its own rendering for 5 seconds, so polling faster than this buys
   * nothing but load.
   */
  readonly metrics: {
    /**
     * Scrape `GET /metrics` and reduce the Prometheus exposition to this
     * proxy's request counters and latency histogram.
     */
    scrapeProxy(proxyId: string): Promise<EdgeProxyMetrics>;
    /**
     * Read `GET /admin/metrics` and pick out this proxy's circuit breakers and
     * unhealthy targets.
     */
    backendState(proxyId: string): Promise<EdgeBackendState>;
  };

  /** Serialise work per consumer id — see {@link createKeyedSerializer}. */
  serializePerKey: KeyedSerializer;

  /** Release the undici dispatcher. */
  close(): Promise<void>;
}

const MAX_CONSUMER_SCAN_PAGES = 20;
const CONSUMER_SCAN_PAGE_SIZE = 500;

/**
 * Edge's `MAX_PAGE_SIZE` (`src/admin/mod.rs`). A larger `limit` is clamped to
 * this, so asking for more only costs a wasted parameter.
 */
const EDGE_MAX_PAGE_SIZE = 1000;

/** Page cap for the plugin-config scan: 50 × 1000 rows in one namespace. */
const MAX_PLUGIN_CONFIG_SCAN_PAGES = 50;

/** Longest Edge validation text echoed back to the caller. */
const MAX_GATEWAY_MESSAGE = 500;

/**
 * How long a metrics read is reused before Edge is asked again.
 *
 * Edge renders both `/metrics` and `/admin/metrics` from a 5-second cache, so a
 * shorter TTL here would only add HTTP round trips to identical bytes. Ten
 * seconds also comfortably absorbs the SPA's 30-second refetch when several
 * viewers watch the same API.
 */
export const METRICS_CACHE_TTL_MS = 10_000;

/**
 * Cap on cached proxies per metrics endpoint. Expired entries are swept on
 * write; this bound stops a very large namespace from growing the map without
 * limit between sweeps.
 */
const METRICS_CACHE_MAX_ENTRIES = 500;

/** Prometheus families Nexus reads. Everything else in the body is ignored. */
const REQUESTS_FAMILY = 'ferrum_requests_total';
const DURATION_FAMILY = 'ferrum_request_duration_ms';

/** One memoised metrics read. */
interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/** An unavailable scrape: zeroed rather than absent, so callers never branch. */
function emptyProxyMetrics(): EdgeProxyMetrics {
  return {
    available: false,
    requests: { byMethod: {}, byStatus: {}, total: 0 },
    latency: { buckets: [], count: null, sum: null },
  };
}

/** An unavailable backend read. */
function emptyBackendState(): EdgeBackendState {
  return { available: false, breakers: [], unhealthyTargets: [], uptimeSeconds: null };
}

/** A finite, non-negative sample value, or `null`. */
function counterValue(value: number): number | null {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** Parse an `le` label. `+Inf` is the histogram's open-ended top bucket. */
function parseLe(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  if (raw === '+Inf' || raw === 'Inf') return Number.POSITIVE_INFINITY;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** Read a number off an unknown JSON object, or `null`. */
function numberAt(value: unknown, key: string): number | null {
  if (typeof value !== 'object' || value === null) return null;
  const found = (value as Record<string, unknown>)[key];
  return typeof found === 'number' && Number.isFinite(found) ? found : null;
}

/**
 * Edge statuses whose `{"error": …}` text is about the caller's own request and
 * is therefore safe — and necessary — to surface. See the module doc comment.
 */
const ECHOED_EDGE_STATUSES = new Set([400, 409, 422]);

function buildDispatcher(config: EdgeConfig): Dispatcher {
  const isHttps = config.adminUrl.startsWith('https://');
  let ca: string | undefined;
  if (config.caFile) {
    try {
      ca = readFileSync(config.caFile, 'utf8');
    } catch (cause) {
      throw internal('FERRUM_ADMIN_CA_FILE could not be read', cause);
    }
  }
  return new Agent({
    connect: {
      timeout: config.timeoutMs,
      ...(isHttps && ca ? { ca } : {}),
    },
    headersTimeout: Math.max(config.timeoutMs, 30_000),
    bodyTimeout: Math.max(config.timeoutMs, 30_000),
    keepAliveTimeout: 10_000,
    keepAliveMaxTimeout: 60_000,
  });
}

function isUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return true;
  const code = (error as NodeJS.ErrnoException).code;
  if (typeof code === 'string') {
    return (
      code.startsWith('E') ||
      code === 'UND_ERR_CONNECT_TIMEOUT' ||
      code === 'UND_ERR_HEADERS_TIMEOUT' ||
      code === 'UND_ERR_BODY_TIMEOUT' ||
      code === 'UND_ERR_SOCKET'
    );
  }
  return error.message.includes('fetch failed');
}

/** Build the Ferrum Edge Admin API client. */
export function createFerrumAdminClient(
  config: EdgeConfig,
  logger: EdgeLogger = silentEdgeLogger,
  deps: { minter?: AdminTokenMinter; dispatcher?: Dispatcher } = {},
): FerrumAdminClient {
  const minter = deps.minter ?? createAdminTokenMinter(config);
  const dispatcher = deps.dispatcher ?? buildDispatcher(config);
  const serializePerKey = createKeyedSerializer();
  const namespace = config.namespace;

  function urlFor(path: string, query?: CallOptions['query']): string {
    const url = new URL(config.adminUrl + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  async function call<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    options: CallOptions = {},
  ): Promise<T | null> {
    const token = await minter.getToken(options.subject ?? DEFAULT_ADMIN_SUBJECT);
    const url = urlFor(path, options.query);
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      'x-ferrum-namespace': namespace,
      accept: 'application/json',
    };
    const hasBody = options.body !== undefined;
    if (hasBody) headers['content-type'] = 'application/json';

    let statusCode: number;
    let raw: string;
    try {
      const response = await request(url, {
        method,
        headers,
        dispatcher,
        ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
      statusCode = response.statusCode;
      raw = await response.body.text();
    } catch (cause) {
      logger.error(
        { method, path, code: (cause as NodeJS.ErrnoException).code ?? null },
        'Ferrum Edge Admin API is unreachable',
      );
      if (isUnavailable(cause)) throw edgeUnavailable(undefined, cause);
      throw edgeUnavailable('The Ferrum Edge Admin API request failed', cause);
    }

    if (statusCode === 404 && options.allow404) return null;
    if (statusCode === 204 || raw.trim() === '') {
      if (statusCode >= 400 && !(options.tolerate ?? []).includes(statusCode)) {
        throw classify(statusCode, null, method, path);
      }
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }

    if (statusCode >= 400 && !(options.tolerate ?? []).includes(statusCode)) {
      throw classify(statusCode, parsed, method, path);
    }
    return parsed as T;
  }

  function classify(status: number, parsed: unknown, method: string, path: string): Error {
    const body = (parsed ?? {}) as { error?: unknown; applied?: unknown; reason?: unknown };
    const upstream = typeof body.error === 'string' ? body.error : `HTTP ${status}`;
    logger.error(
      { method, path, status, upstream, reason: body.reason ?? null },
      'Ferrum Edge Admin API returned an error',
    );

    if (status === 503 && body.applied === false) {
      return edgeError(
        'The gateway accepted the change but has not applied it yet; do not retry — verify the gateway configuration and try again once it recovers',
        { status, reason: typeof body.reason === 'string' ? body.reason : null },
      );
    }
    if (status === 401 || status === 403) {
      return edgeError('The gateway rejected the Nexus admin credentials', { status });
    }
    // A validation refusal is about the body Nexus built from the caller's own
    // request, so the provider needs the gateway's reason to act on it.
    if (ECHOED_EDGE_STATUSES.has(status) && typeof body.error === 'string') {
      const gatewayMessage = body.error.trim().slice(0, MAX_GATEWAY_MESSAGE);
      if (gatewayMessage !== '') {
        return edgeError(`The gateway rejected the request: ${gatewayMessage}`, {
          status,
          gateway_message: gatewayMessage,
        });
      }
    }
    return edgeError('The gateway rejected the request', { status });
  }

  /** Same as `call`, for endpoints that must return a body. */
  async function callRequired<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    options: CallOptions = {},
  ): Promise<T> {
    const result = await call<T>(method, path, options);
    if (result === null || result === undefined) {
      throw edgeError('The gateway returned an empty response where one was expected');
    }
    return result;
  }

  /**
   * `GET` a non-JSON body (the Prometheus exposition) with the admin JWT.
   *
   * Returns `null` rather than throwing when nothing reached the gateway; the
   * only caller is the metrics scrape, which must never fail a page render.
   */
  async function callText(
    path: string,
    accept: string,
  ): Promise<{ statusCode: number; body: string } | null> {
    const token = await minter.getToken(DEFAULT_ADMIN_SUBJECT);
    try {
      const response = await request(urlFor(path), {
        method: 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          'x-ferrum-namespace': namespace,
          accept,
        },
        dispatcher,
        signal: AbortSignal.timeout(config.timeoutMs),
      });
      return { statusCode: response.statusCode, body: await response.body.text() };
    } catch (cause) {
      logger.warn(
        { path, code: (cause as NodeJS.ErrnoException).code ?? null },
        'Ferrum Edge metrics scrape could not reach the gateway',
      );
      return null;
    }
  }

  /* ── Metrics caches ───────────────────────────────────────────────────── */

  const scrapeCache = new Map<string, CacheEntry<EdgeProxyMetrics>>();
  const backendCache = new Map<string, CacheEntry<EdgeBackendState>>();

  function readCache<T>(cache: Map<string, CacheEntry<T>>, key: string): T | null {
    const entry = cache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      cache.delete(key);
      return null;
    }
    return entry.value;
  }

  function writeCache<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T): T {
    const now = Date.now();
    if (cache.size >= METRICS_CACHE_MAX_ENTRIES) {
      for (const [existing, entry] of cache) {
        if (entry.expiresAt <= now) cache.delete(existing);
      }
      // Still full of live entries: drop the oldest insertion to stay bounded.
      if (cache.size >= METRICS_CACHE_MAX_ENTRIES) {
        const oldest = cache.keys().next();
        if (!oldest.done) cache.delete(oldest.value);
      }
    }
    cache.set(key, { value, expiresAt: now + METRICS_CACHE_TTL_MS });
    return value;
  }

  /**
   * Whether a series belongs to the namespace this client speaks for.
   *
   * A **missing** `namespace` label counts as a match: Edge only labels series
   * when a gateway namespace is configured, so an unlabelled exposition comes
   * from a single-namespace gateway and there is no other tenant it could be
   * confused with. Requiring the label would make every such deployment report
   * zero traffic forever.
   */
  function namespaceMatches(label: unknown): boolean {
    return label === undefined || label === null || label === namespace;
  }

  /** Reduce one scrape's samples to the counters and histogram for `proxyId`. */
  function reduceProxySamples(samples: PrometheusSample[], proxyId: string): EdgeProxyMetrics {
    const byMethod: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    let total = 0;
    const buckets = new Map<number, number>();
    let count: number | null = null;
    let sum: number | null = null;

    for (const sample of samples) {
      const { labels } = sample;
      if (labels.proxy_id !== proxyId) continue;
      if (!namespaceMatches(labels.namespace)) continue;

      if (sample.name === REQUESTS_FAMILY) {
        const value = counterValue(sample.value);
        if (value === null) continue;
        // One (method, status) pair can appear several times — `error_class`
        // and `grpc_status` split it further — so these accumulate.
        if (labels.method !== undefined) {
          byMethod[labels.method] = (byMethod[labels.method] ?? 0) + value;
        }
        if (labels.status_code !== undefined) {
          byStatus[labels.status_code] = (byStatus[labels.status_code] ?? 0) + value;
        }
        total += value;
        continue;
      }

      if (sample.name === `${DURATION_FAMILY}_bucket`) {
        const le = parseLe(labels.le);
        const value = counterValue(sample.value);
        if (le === null || value === null) continue;
        // Cumulative buckets: a repeated `le` should carry the same count, so
        // keeping the larger of the two cannot understate the histogram.
        buckets.set(le, Math.max(buckets.get(le) ?? 0, value));
        continue;
      }

      if (sample.name === `${DURATION_FAMILY}_count`) {
        count = counterValue(sample.value);
        continue;
      }
      if (sample.name === `${DURATION_FAMILY}_sum`) {
        sum = counterValue(sample.value);
      }
    }

    const sorted: EdgeLatencyBucket[] = [...buckets.entries()]
      .map(([le, bucketCount]) => ({ le, count: bucketCount }))
      .sort((a, b) => a.le - b.le);

    return {
      available: true,
      requests: { byMethod, byStatus, total },
      latency: { buckets: sorted, count, sum },
    };
  }

  /**
   * Walk every page of an Edge list endpoint.
   *
   * `visit` returns `false` to stop early. The walk also stops on an empty or
   * short page, once `offset + data.length` covers `pagination.total`, or after
   * `maxPages` pages — the cap keeps a runaway `total` from turning one probe
   * into an unbounded scan.
   */
  async function scanPages<T>(
    path: string,
    pageSize: number,
    maxPages: number,
    visit: (items: T[]) => boolean,
  ): Promise<void> {
    for (let page = 0; page < maxPages; page += 1) {
      const offset = page * pageSize;
      const result = await callRequired<EdgePage<T>>('GET', path, {
        query: { limit: pageSize, offset },
      });
      const items = Array.isArray(result.data) ? result.data : [];
      if (!visit(items)) return;
      if (items.length === 0 || items.length < pageSize) return;
      const total = result.pagination?.total ?? items.length;
      if (offset + items.length >= total) return;
    }
  }

  /** Whether an Edge response body is a `HealthResponse` and not an error. */
  function isHealthBody(value: unknown): value is EdgeHealth {
    return (
      typeof value === 'object' &&
      value !== null &&
      typeof (value as { status?: unknown }).status === 'string'
    );
  }

  return {
    namespace,

    async health(): Promise<EdgeHealth> {
      // `503` + a full payload is Edge saying "reachable, not ready"; a `503`
      // carrying anything else is a real failure and still classifies.
      const parsed = await call<unknown>('GET', '/health', { tolerate: [503] });
      if (isHealthBody(parsed)) return parsed;
      logger.error(
        { path: '/health', upstream: (parsed as { error?: unknown } | null)?.error ?? null },
        'Ferrum Edge health endpoint returned an unrecognised body',
      );
      throw edgeError('The gateway health endpoint did not return a health payload');
    },

    async live(): Promise<boolean> {
      const result = await call<{ status?: string }>('GET', '/live', { allow404: true });
      return result !== null;
    },

    async version(): Promise<string | null> {
      const result = await call<{ version?: unknown }>('GET', '/version', {
        allow404: true,
        tolerate: [404, 405],
      });
      const version = (result ?? {}).version;
      return typeof version === 'string' ? version : null;
    },

    async probe(): Promise<EdgeProbe> {
      const started = Date.now();
      try {
        const health = await this.health();
        let version: string | null = null;
        try {
          version = await this.version();
        } catch {
          version = null;
        }
        return {
          reachable: true,
          latencyMs: Date.now() - started,
          status: typeof health.status === 'string' ? health.status : null,
          ready: typeof health.ready === 'boolean' ? health.ready : null,
          mode: typeof health.mode === 'string' ? health.mode : null,
          adminWritesEnabled:
            typeof health.admin_writes_enabled === 'boolean' ? health.admin_writes_enabled : null,
          version,
          error: null,
        };
      } catch (error) {
        return {
          reachable: false,
          latencyMs: Date.now() - started,
          status: null,
          ready: null,
          mode: null,
          adminWritesEnabled: null,
          version: null,
          error: error instanceof Error ? error.message : 'unknown error',
        };
      }
    },

    async listNamespaces(): Promise<string[]> {
      const page = await callRequired<EdgePage<string>>('GET', '/namespaces', {
        query: { limit: 1000 },
      });
      return Array.isArray(page.data) ? page.data : [];
    },

    async ensureNamespace(description?: string): Promise<void> {
      try {
        const existing = await call<unknown>(
          'GET',
          `/namespaces/${encodeURIComponent(namespace)}`,
          {
            allow404: true,
          },
        );
        if (existing !== null) return;
        await call('POST', '/namespaces', {
          body: { name: namespace, ...(description ? { description } : {}) },
          // 409: created concurrently. 501: MongoDB standalone refuses namespace writes.
          tolerate: [409, 501],
        });
      } catch (error) {
        // Namespaces are created implicitly by the first resource write, so a
        // failure here must not block startup.
        logger.warn(
          { namespace, error: error instanceof Error ? error.message : String(error) },
          'Could not pre-create the Ferrum namespace; it will be created implicitly',
        );
      }
    },

    consumers: {
      async list(query?: EdgeListQuery): Promise<EdgePage<EdgeConsumer>> {
        return callRequired<EdgePage<EdgeConsumer>>('GET', '/consumers', { query: { ...query } });
      },

      async get(id: string): Promise<EdgeConsumer | null> {
        return call<EdgeConsumer>('GET', `/consumers/${encodeURIComponent(id)}`, {
          allow404: true,
        });
      },

      async getByUsername(username: string): Promise<EdgeConsumer | null> {
        let found: EdgeConsumer | null = null;
        await scanPages<EdgeConsumer>(
          '/consumers',
          CONSUMER_SCAN_PAGE_SIZE,
          MAX_CONSUMER_SCAN_PAGES,
          (items) => {
            // access_control matches usernames byte-for-byte, so this does too.
            const match = items.find((consumer) => consumer.username === username);
            if (!match) return true;
            found = match;
            return false;
          },
        );
        return found;
      },

      async create(body: EdgeConsumerWrite, subject?: string): Promise<EdgeConsumer> {
        return callRequired<EdgeConsumer>('POST', '/consumers', { body, subject });
      },

      async replace(id: string, body: EdgeConsumerWrite, subject?: string): Promise<EdgeConsumer> {
        return callRequired<EdgeConsumer>('PUT', `/consumers/${encodeURIComponent(id)}`, {
          body,
          subject,
        });
      },

      async delete(id: string, subject?: string): Promise<void> {
        await call('DELETE', `/consumers/${encodeURIComponent(id)}`, { subject });
      },

      async addCredential(
        id: string,
        type: EdgeCredentialType,
        entry: EdgeCredentialEntry,
        subject?: string,
      ): Promise<EdgeConsumer> {
        return callRequired<EdgeConsumer>(
          'POST',
          `/consumers/${encodeURIComponent(id)}/credentials/${type}`,
          { body: entry, subject },
        );
      },

      async replaceCredentials(
        id: string,
        type: EdgeCredentialType,
        entries: EdgeCredentialEntry[],
        subject?: string,
      ): Promise<EdgeConsumer> {
        return callRequired<EdgeConsumer>(
          'PUT',
          `/consumers/${encodeURIComponent(id)}/credentials/${type}`,
          { body: entries, subject },
        );
      },

      async deleteCredentialAt(
        id: string,
        type: EdgeCredentialType,
        index: number,
        subject?: string,
      ): Promise<EdgeConsumer> {
        return callRequired<EdgeConsumer>(
          'DELETE',
          `/consumers/${encodeURIComponent(id)}/credentials/${type}/${index}`,
          { subject },
        );
      },

      async deleteCredentialType(
        id: string,
        type: EdgeCredentialType,
        subject?: string,
      ): Promise<void> {
        await call('DELETE', `/consumers/${encodeURIComponent(id)}/credentials/${type}`, {
          subject,
        });
      },
    },

    proxies: {
      async list(query?: EdgeListQuery): Promise<EdgePage<EdgeProxy>> {
        return callRequired<EdgePage<EdgeProxy>>('GET', '/proxies', { query: { ...query } });
      },
      async get(id: string): Promise<EdgeProxy | null> {
        return call<EdgeProxy>('GET', `/proxies/${encodeURIComponent(id)}`, { allow404: true });
      },
      async create(body: EdgeProxyWrite, subject?: string): Promise<EdgeProxy> {
        return callRequired<EdgeProxy>('POST', '/proxies', { body, subject });
      },
      async replace(id: string, body: EdgeProxyReplace, subject?: string): Promise<EdgeProxy> {
        return callRequired<EdgeProxy>('PUT', `/proxies/${encodeURIComponent(id)}`, {
          body,
          subject,
        });
      },
      async delete(id: string, subject?: string): Promise<void> {
        await call('DELETE', `/proxies/${encodeURIComponent(id)}`, { subject, allow404: true });
      },
    },

    pluginConfigs: {
      async list(query?: EdgeListQuery): Promise<EdgePage<EdgePluginConfig>> {
        return callRequired<EdgePage<EdgePluginConfig>>('GET', '/plugins/config', {
          query: { ...query },
        });
      },
      async listByProxy(proxyId: string): Promise<EdgePluginConfig[]> {
        const attached: EdgePluginConfig[] = [];
        await scanPages<EdgePluginConfig>(
          '/plugins/config',
          EDGE_MAX_PAGE_SIZE,
          MAX_PLUGIN_CONFIG_SCAN_PAGES,
          (items) => {
            for (const config of items) {
              if (config.proxy_id === proxyId) attached.push(config);
            }
            return true;
          },
        );
        return attached;
      },
      async get(id: string): Promise<EdgePluginConfig | null> {
        return call<EdgePluginConfig>('GET', `/plugins/config/${encodeURIComponent(id)}`, {
          allow404: true,
        });
      },
      async create(body: EdgePluginConfigWrite, subject?: string): Promise<EdgePluginConfig> {
        return callRequired<EdgePluginConfig>('POST', '/plugins/config', { body, subject });
      },
      async replace(
        id: string,
        body: EdgePluginConfigWrite,
        subject?: string,
      ): Promise<EdgePluginConfig> {
        return callRequired<EdgePluginConfig>('PUT', `/plugins/config/${encodeURIComponent(id)}`, {
          body,
          subject,
        });
      },
      async delete(id: string, subject?: string): Promise<void> {
        await call('DELETE', `/plugins/config/${encodeURIComponent(id)}`, {
          subject,
          allow404: true,
        });
      },
    },

    metrics: {
      async scrapeProxy(proxyId: string): Promise<EdgeProxyMetrics> {
        const cached = readCache(scrapeCache, proxyId);
        if (cached) return cached;

        // `text/plain; version=0.0.4` is the exposition content type; Edge
        // ignores the header, but asking for JSON here would be a lie.
        const response = await callText('/metrics', 'text/plain;version=0.0.4');
        if (!response) return writeCache(scrapeCache, proxyId, emptyProxyMetrics());

        if (response.statusCode < 200 || response.statusCode >= 300) {
          logger.warn(
            { path: '/metrics', status: response.statusCode },
            'Ferrum Edge metrics scrape returned a non-2xx status',
          );
          return writeCache(scrapeCache, proxyId, emptyProxyMetrics());
        }

        const samples = parsePrometheusText(response.body);
        if (samples.length === 0) {
          // A 200 that yields nothing means the body was not an exposition we
          // recognise. Report unavailable rather than "zero requests".
          logger.warn(
            { path: '/metrics', bytes: response.body.length },
            'Ferrum Edge metrics scrape produced no parseable samples',
          );
          return writeCache(scrapeCache, proxyId, emptyProxyMetrics());
        }

        return writeCache(scrapeCache, proxyId, reduceProxySamples(samples, proxyId));
      },

      async backendState(proxyId: string): Promise<EdgeBackendState> {
        const cached = readCache(backendCache, proxyId);
        if (cached) return cached;

        let payload: unknown;
        try {
          payload = await call<unknown>('GET', '/admin/metrics');
        } catch (error) {
          logger.warn(
            { path: '/admin/metrics', error: error instanceof Error ? error.message : 'unknown' },
            'Ferrum Edge runtime metrics could not be read',
          );
          return writeCache(backendCache, proxyId, emptyBackendState());
        }
        if (typeof payload !== 'object' || payload === null) {
          return writeCache(backendCache, proxyId, emptyBackendState());
        }

        const body = payload as Record<string, unknown>;
        const rawBreakers = Array.isArray(body.circuit_breakers) ? body.circuit_breakers : [];
        const breakers: EdgeCircuitBreaker[] = [];
        for (const entry of rawBreakers) {
          if (typeof entry !== 'object' || entry === null) continue;
          const breaker = entry as Record<string, unknown>;
          if (breaker.proxy_id !== proxyId) continue;
          if (!namespaceMatches(breaker.namespace)) continue;
          if (typeof breaker.state !== 'string') continue;
          breakers.push(breaker as unknown as EdgeCircuitBreaker);
        }

        const healthCheck = body.health_check;
        const rawTargets =
          typeof healthCheck === 'object' &&
          healthCheck !== null &&
          Array.isArray((healthCheck as Record<string, unknown>).unhealthy_targets)
            ? ((healthCheck as Record<string, unknown>).unhealthy_targets as unknown[])
            : [];
        const unhealthyTargets: EdgeUnhealthyTarget[] = [];
        for (const entry of rawTargets) {
          if (typeof entry !== 'object' || entry === null) continue;
          const target = entry as Record<string, unknown>;
          if (!namespaceMatches(target.namespace)) continue;
          // Only `proxy_id`-keyed entries are attributable. Nexus publishes a
          // direct backend on the proxy and never creates an Edge `upstream`,
          // so an `upstream_id`-keyed ejection belongs to a resource an
          // operator built by hand and cannot be pinned to this API.
          if (target.proxy_id !== proxyId) continue;
          unhealthyTargets.push(target as unknown as EdgeUnhealthyTarget);
        }

        return writeCache(backendCache, proxyId, {
          available: true,
          breakers,
          unhealthyTargets,
          uptimeSeconds: numberAt(body.gateway, 'uptime_seconds'),
        });
      },
    },

    serializePerKey,

    async close(): Promise<void> {
      if (deps.dispatcher) return;
      await dispatcher.close();
    },
  };
}
