/**
 * An in-process stand-in for the Ferrum Edge Admin API.
 *
 * It is a real `node:http` server, not a fetch stub, so the undici dispatcher,
 * timeouts, headers and JSON handling in `ferrum-admin/client.ts` are all
 * exercised. The implemented subset follows `ref-edge-admin.md` closely enough
 * that a test failing here would very likely fail against a real gateway:
 *
 * - HS256 admin JWT verification: required `iss`/`sub`/`iat`/`nbf`/`exp`/`jti`/
 *   `role` claims, and an `aud` claim is **rejected** unless the mock was
 *   configured with an audience (§1.3). A malformed `ns` claim is a `401`
 *   whether or not namespace enforcement is on, and with
 *   {@link MockFerrumEdgeOptions.requireNamespaceClaim} a namespace-scoped
 *   route the claim does not authorize is a `403`.
 * - `X-Ferrum-Namespace` scoping for every namespaced route, with `ferrum` as
 *   the default (§1.6).
 * - `GET /health` and `/status` answer **`503` with the full payload** whenever
 *   `ready` is false, exactly as Edge does while `starting`, `draining` or
 *   `unavailable`.
 * - Proxy `plugins[]` associations: an id must resolve inside the namespace,
 *   appear once, and be proxy- or proxy_group-scoped — never global, and never
 *   a proxy-scoped config aimed at a different proxy.
 * - Consumers: one unique keyspace across `id`/`username`/`custom_id` (§4.2),
 *   `PUT` whole-resource replace with the credential-preservation rules
 *   (§4.4), and the closed read projection — `keyauth.key` and `jwt.secret`
 *   become `[REDACTED]`, `basicauth` is omitted entirely (§4.5).
 * - Credentials: `POST` appends (capped at 2 per type), `PUT` replaces,
 *   `DELETE /{type}` removes the type, `DELETE /{type}/{index}` removes one
 *   entry (§5.3–5.4).
 * - Flat `{"error": "..."}` error bodies (§1.7).
 *
 * Every request is recorded in {@link MockFerrumEdge.requests} for assertions.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { jwtVerify } from 'jose';

/** One recorded Admin API call. */
export interface RecordedRequest {
  method: string;
  /** Path without the query string. */
  path: string;
  query: Record<string, string>;
  namespace: string;
  body: unknown;
  /** JWT claims the mock accepted, or `null` when the call was unauthenticated. */
  claims: Record<string, unknown> | null;
}

/** A consumer as the mock stores it (unredacted). */
export interface StoredConsumer {
  id: string;
  username: string;
  namespace: string;
  custom_id: string | null;
  credentials: Record<string, Record<string, unknown>[]>;
  acl_groups: string[];
  created_at: string;
  updated_at: string;
}

/** One seeded batch of requests against a proxy, for `GET /metrics`. */
export interface SeededRequests {
  /** HTTP method label, e.g. `GET`. */
  method: string;
  /** HTTP status label, e.g. `200` or `429`. */
  status: number | string;
  /** How many requests to add to the cumulative counter. */
  count: number;
  /** Observed durations in milliseconds, folded into the latency histogram. */
  durations?: number[];
}

/** Runtime backend state for a proxy, for `GET /admin/metrics`. */
export interface SeededBackendState {
  /** Circuit breaker state, or omitted for "this proxy has no breaker". */
  breaker?: 'closed' | 'open' | 'half_open';
  /** `host:port` of a target passive health checking has ejected. */
  unhealthyTarget?: string;
}

/** Options for {@link createMockFerrumEdge}. */
export interface MockFerrumEdgeOptions {
  /** Must match the client's `FERRUM_ADMIN_JWT_SECRET`. */
  jwtSecret: string;
  /** Expected `iss` claim. Defaults to `ferrum-edge`. */
  issuer?: string;
  /** When set, tokens must carry this `aud`; when unset, any `aud` is rejected. */
  audience?: string;
  /** Cap enforced by the credential append endpoint. Defaults to 2. */
  maxCredentialsPerType?: number;
  /**
   * Stand in for the gateway's `FERRUM_ADMIN_REQUIRE_NAMESPACE_CLAIM=true`.
   *
   * When set, every namespace-scoped route (`/consumers`, `/proxies`,
   * `/plugins/config`) requires the token's `ns` claim to authorize the
   * `X-Ferrum-Namespace` of the request, and `GET`/`DELETE /namespaces/{name}`
   * requires it to authorize that name. A token with no `ns` at all is refused
   * — tenancy intent must be explicit.
   */
  requireNamespaceClaim?: boolean;
}

/** A queued synthetic failure, consumed by the next matching request. */
interface QueuedFailure {
  status: number;
  body: unknown;
  /** Only fail requests whose path contains this substring. */
  pathContains?: string;
  /**
   * Only fail requests using this method. Needed whenever one code path reads
   * and writes the same collection — `/plugins/config` is listed with a `GET`
   * immediately before the `POST`/`DELETE` under test.
   */
  method?: string;
}

/** The running mock. */
export interface MockFerrumEdge {
  /** Base URL, e.g. `http://127.0.0.1:54321`. Valid after `start()`. */
  readonly url: string;
  /** Every request the mock has served since the last `reset()`. */
  readonly requests: RecordedRequest[];
  start(): Promise<string>;
  stop(): Promise<void>;
  /** Clear stored resources, recorded requests and queued failures. */
  reset(): void;
  /**
   * Replace the payload returned by `GET /health` and `GET /status`.
   *
   * A payload with `ready: false` is served with **HTTP 503**, the way Edge
   * reports `starting` / `draining` / `unavailable`; anything else is a 200.
   */
  setHealth(payload: Record<string, unknown>): void;
  /**
   * Make the next matching request fail with `status` and `body`.
   *
   * Narrow with `pathContains` and, when a path is both read and written in one
   * operation, `method`.
   */
  queueFailure(status: number, body?: unknown, pathContains?: string, method?: string): void;
  /** Direct access to stored consumers, keyed `<namespace>/<id>`. */
  readonly consumers: Map<string, StoredConsumer>;
  /** Direct access to stored proxies, keyed `<namespace>/<id>`. */
  readonly proxies: Map<string, Record<string, unknown>>;
  /** Direct access to stored plugin configs, keyed `<namespace>/<id>`. */
  readonly pluginConfigs: Map<string, Record<string, unknown>>;
  /** Seed a consumer directly, bypassing the HTTP surface. */
  seedConsumer(
    consumer: Partial<StoredConsumer> & { username: string; namespace?: string },
  ): StoredConsumer;

  /**
   * Add to the cumulative request counters `GET /metrics` renders for a proxy.
   *
   * Counters accumulate exactly as Edge's do — calling this twice with the same
   * method and status sums the counts — and are cleared by `reset()`.
   * `namespace` defaults to `nexus`, matching the assertion helpers below and
   * the namespace `buildTestApp` configures.
   */
  recordRequests(proxyId: string, entry: SeededRequests, namespace?: string): void;
  /**
   * Set (or, with an empty object, clear) the runtime backend state
   * `GET /admin/metrics` reports for a proxy. `namespace` defaults to `nexus`.
   */
  setBackendState(proxyId: string, state: SeededBackendState, namespace?: string): void;

  /* ── Assertion helpers ──────────────────────────────────────────────────
   * These read the mock's *unredacted* state, which is what a test needs to
   * check that the right thing landed on the gateway.
   */

  /** The stored consumer with this username, or `undefined`. */
  consumerByUsername(username: string, namespace?: string): StoredConsumer | undefined;
  /** The stored proxy with this `name` (`nexus-<slug>`), or `undefined`. */
  proxyByName(name: string, namespace?: string): Record<string, unknown> | undefined;
  /**
   * Every plugin config whose `proxy_id` names this proxy, in creation order.
   *
   * **This is not what the gateway runs.** Live Edge only installs a
   * proxy-scoped config once the proxy's own `plugins[]` carries an
   * association with its id (`plugin_cache.rs`
   * `scoped_plugin_config_applies_to_proxy`); a config with a matching
   * `proxy_id` and no association is inert. Use this helper to assert what was
   * *written*, and {@link MockFerrumEdge.effectivePluginsForProxy} to assert
   * what would actually *run*.
   */
  pluginsForProxy(proxyId: string, namespace?: string): Record<string, unknown>[];
  /**
   * The plugin configs Edge would actually execute for this proxy: every
   * enabled config referenced from the proxy's `plugins[]` that its scope lets
   * attach, plus the enabled global configs no such scoped config of the same
   * `plugin_name` shadows.
   */
  effectivePluginsForProxy(proxyId: string, namespace?: string): Record<string, unknown>[];
  /** The single plugin config of `pluginName` on a proxy, or `undefined`. */
  pluginForProxy(
    proxyId: string,
    pluginName: string,
    namespace?: string,
  ): Record<string, unknown> | undefined;
  /** Recorded calls filtered by method and a path substring. */
  callsTo(method: string, pathContains: string): RecordedRequest[];
}

const DEFAULT_NAMESPACE = 'ferrum';

/** Fixed `gateway.uptime_seconds`, so a test can assert an exact value. */
const MOCK_GATEWAY_UPTIME_SECONDS = 3_600;

/** Finite `le` bounds of the rendered `ferrum_request_duration_ms` histogram. */
const HISTOGRAM_BOUNDS = [1, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000] as const;

const REDACTED = '[REDACTED]';
const REDACTABLE_TYPES = new Set(['keyauth', 'jwt', 'hmac_auth']);
const KNOWN_CREDENTIAL_TYPES = new Set(['basicauth', 'keyauth', 'jwt', 'hmac_auth', 'mtls_auth']);

/**
 * Every field Edge's `Proxy` deserializer accepts, from the openapi `Proxy`
 * schema minus the `#[serde(skip)]` derived-only members (`dispatch_kind`,
 * `resolved_tls`, `dispatch_port_overrides`, `h2_upgrade_policy`,
 * `pool_http1_max_pending_requests`, `pending_limit_scope`,
 * `compiled_stream_match`). The struct carries `deny_unknown_fields`, so
 * anything outside this set is a 400.
 *
 * `namespace`, `created_at` and `updated_at` **are** accepted (they have serde
 * defaults) but are server-owned: the namespace comes from
 * `X-Ferrum-Namespace` and the timestamps from the server, so a value sent for
 * them is overwritten rather than honoured. Nexus writes only a narrow HTTP
 * subset; the rest is here so a test can represent an operator-enriched proxy.
 */
const PROXY_KEYS = new Set([
  'id',
  'name',
  'namespace',
  'hosts',
  'listen_path',
  'backend_scheme',
  'backend_host',
  'backend_port',
  'backend_path',
  'strip_listen_path',
  'preserve_host_header',
  'backend_connect_timeout_ms',
  'backend_read_timeout_ms',
  'backend_write_timeout_ms',
  'backend_tls_client_cert_path',
  'backend_tls_client_key_path',
  'backend_tls_verify_server_cert',
  'backend_tls_server_ca_cert_path',
  'dns_override',
  'dns_cache_ttl_seconds',
  'auth_mode',
  'plugins',
  'pool_idle_timeout_seconds',
  'pool_enable_http_keep_alive',
  'pool_enable_http2',
  'pool_tcp_keepalive_seconds',
  'pool_http2_keep_alive_interval_seconds',
  'pool_http2_keep_alive_timeout_seconds',
  'pool_http2_initial_stream_window_size',
  'pool_http2_initial_connection_window_size',
  'pool_http2_adaptive_window',
  'pool_http2_max_frame_size',
  'pool_http2_max_concurrent_streams',
  'pool_http3_connections_per_backend',
  'pool_max_requests_per_connection',
  'upstream_id',
  'upstream_subset',
  'api_spec_id',
  'circuit_breaker',
  'retry',
  'response_body_mode',
  'listen_port',
  'frontend_tls',
  'passthrough',
  'tcp_idle_timeout_seconds',
  'stream_proxy_protocol',
  'backend_proxy_protocol',
  'stream_match',
  'websocket_idle_timeout_seconds',
  'udp_idle_timeout_seconds',
  'udp_max_response_amplification_factor',
  'allowed_methods',
  'allowed_ws_origins',
  'created_at',
  'updated_at',
]);

/**
 * Plugin configs the mock validates strictly, mirroring Edge's closed key
 * allowlists (`ref-edge-admin.md` §8.7–8.8). Anything not listed here is stored
 * without inspection, exactly as an unknown-to-Nexus plugin would be.
 */
const PLUGIN_CONFIG_ALLOWED_KEYS: Readonly<Record<string, readonly string[]>> = {
  key_auth: ['key_location', 'hide_credentials'],
  // `basic_auth` accepts *no* fields at all — an empty list is the point.
  basic_auth: [],
  jwt_auth: [
    'token_lookup',
    'consumer_claim_field',
    'require_exp',
    'require_nbf',
    'expected_issuer',
    'expected_issuers',
    'audiences',
    'leeway_secs',
  ],
  access_control: [
    'allowed_consumers',
    'disallowed_consumers',
    'allowed_groups',
    'disallowed_groups',
    'allow_authenticated_identity',
  ],
  rate_limiting: [
    'limit_by',
    'expose_headers',
    'limits',
    'sync_mode',
    'redis_url',
    'redis_tls',
    'redis_key_prefix',
    'redis_pool_size',
    'redis_failure_policy',
  ],
  cors: [
    'allowed_origins',
    'allowed_methods',
    'allowed_headers',
    'exposed_headers',
    'allow_credentials',
    'max_age',
    'preflight_continue',
    'unmatched_preflights',
  ],
};

const RATE_LIMIT_RULE_KEYS = new Set([
  'scope',
  'consumers',
  'requests_per_second',
  'requests_per_minute',
  'requests_per_hour',
  'window_seconds',
  'max_requests',
]);

/**
 * Inclusive bounds on every numeric `rate_limiting` rule field (openapi
 * `RateLimitingRuleConfig`). Edge rejects an out-of-range quota with a 400, so
 * a "generous" limit typed with one digit too many fails here too rather than
 * being silently accepted by a permissive fake.
 */
const RATE_LIMIT_RULE_BOUNDS: Readonly<Record<string, readonly [number, number]>> = {
  requests_per_second: [1, 1_000_000],
  requests_per_minute: [1, 1_000_000],
  requests_per_hour: [1, 1_000_000],
  max_requests: [1, 1_000_000],
  // 2678400 = 31 days, so the window stays a representable Redis TTL.
  window_seconds: [1, 2_678_400],
};

/** `cors.allowed_origins` is required and bounded at 64 entries. */
const MAX_CORS_ORIGINS = 64;

/**
 * Every field Edge's `PluginConfig` deserializer accepts (openapi
 * `PluginConfig`); `deny_unknown_fields` makes anything else a 400.
 * `namespace`, `created_at` and `updated_at` are accepted but server-owned.
 */
const PLUGIN_CONFIG_KEYS = new Set([
  'id',
  'plugin_name',
  'namespace',
  'config',
  'scope',
  'proxy_id',
  'enabled',
  'priority_override',
  'trigger',
  'api_spec_id',
  'created_at',
  'updated_at',
]);

const CONSUMER_KEYS = new Set(['id', 'username', 'custom_id', 'credentials', 'acl_groups']);

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Validate a plugin `config` against the plugin's closed key allowlist, the way
 * Edge's hand-written `Plugin::new(config)` constructors do. Returns an error
 * message, or `null` when the config is acceptable.
 *
 * Only the rules Nexus can actually trip are modelled; the point is that a
 * typo'd or over-specified config fails here exactly as it would on a real
 * gateway, rather than being silently accepted by a permissive fake.
 */
function validatePluginConfig(pluginName: string, config: unknown): string | null {
  const allowed = PLUGIN_CONFIG_ALLOWED_KEYS[pluginName];
  if (allowed === undefined) return null;
  if (config === null || config === undefined) {
    // `cors` has a required field, so an absent config is not an empty one.
    return pluginName === 'cors'
      ? "cors: 'allowed_origins' is required and must list at least one origin"
      : null;
  }
  if (!isRecord(config)) return `${pluginName}: config must be a JSON object`;

  const keys = Object.keys(config);
  if (pluginName === 'basic_auth' && keys.length > 0) {
    return 'basic_auth: no configuration fields are supported';
  }
  for (const field of keys) {
    if (!allowed.includes(field)) {
      return `${pluginName}: unknown configuration field(s): ${field}`;
    }
  }

  if (pluginName === 'access_control') {
    const nonEmpty = keys.some((field) => {
      const value = config[field];
      return Array.isArray(value) ? value.length > 0 : value === true;
    });
    if (!nonEmpty) {
      return "access_control: at least one of 'allowed_consumers', 'disallowed_consumers', 'allowed_groups', 'disallowed_groups', or 'allow_authenticated_identity=true' is required";
    }
    if (config.allow_authenticated_identity === true) {
      const hasAllowList =
        (Array.isArray(config.allowed_consumers) && config.allowed_consumers.length > 0) ||
        (Array.isArray(config.allowed_groups) && config.allowed_groups.length > 0);
      if (hasAllowList) {
        return 'access_control: allow_authenticated_identity is mutually exclusive with an allow-list';
      }
    }
  }

  if (pluginName === 'rate_limiting') {
    if (
      config.limit_by !== undefined &&
      !['ip', 'consumer', 'spiffe', 'spiffe_identity'].includes(String(config.limit_by))
    ) {
      return `rate_limiting: unsupported limit_by '${String(config.limit_by)}'`;
    }
    const limits = config.limits;
    if (!Array.isArray(limits) || limits.length === 0) {
      return "rate_limiting: 'limits' is required and must be non-empty";
    }
    const defaults = limits.filter((rule) => isRecord(rule) && rule.scope === 'default');
    if (defaults.length !== 1) {
      return "rate_limiting: 'limits' must contain exactly one entry with scope 'default'";
    }
    for (const rule of limits) {
      if (!isRecord(rule)) return 'rate_limiting: each limits entry must be an object';
      for (const field of Object.keys(rule)) {
        if (!RATE_LIMIT_RULE_KEYS.has(field)) {
          return `rate_limiting: unknown limits field '${field}'`;
        }
      }
      if (rule.scope === 'default' && rule.consumers !== undefined) {
        return "rate_limiting: 'consumers' is forbidden when scope is 'default'";
      }
      const preset =
        rule.requests_per_second !== undefined ||
        rule.requests_per_minute !== undefined ||
        rule.requests_per_hour !== undefined;
      const custom = rule.window_seconds !== undefined || rule.max_requests !== undefined;
      if (preset && custom) {
        return 'rate_limiting: preset and custom windows must not be mixed in one rule';
      }
      if (!preset && !custom) return 'rate_limiting: each limits rule needs a window';
      if (custom && (rule.window_seconds === undefined || rule.max_requests === undefined)) {
        return "rate_limiting: 'window_seconds' and 'max_requests' are required together";
      }
      for (const [field, [min, max]] of Object.entries(RATE_LIMIT_RULE_BOUNDS)) {
        const value = rule[field];
        if (value === undefined) continue;
        if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
          return `rate_limiting: '${field}' must be an integer between ${min} and ${max}`;
        }
      }
    }
  }

  if (pluginName === 'cors') {
    const origins = config.allowed_origins;
    if (!Array.isArray(origins) || origins.length === 0) {
      return "cors: 'allowed_origins' is required and must list at least one origin";
    }
    if (origins.length > MAX_CORS_ORIGINS) {
      return `cors: 'allowed_origins' accepts at most ${MAX_CORS_ORIGINS} entries`;
    }
    if (config.preflight_continue !== undefined && config.unmatched_preflights !== undefined) {
      return "cors: 'preflight_continue' and 'unmatched_preflights' are mutually exclusive";
    }
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Apply Edge's closed read projection to a stored consumer. */
function project(consumer: StoredConsumer): Record<string, unknown> {
  const credentials: Record<string, Record<string, unknown>[]> = {};
  for (const [type, entries] of Object.entries(consumer.credentials)) {
    if (type === 'basicauth') continue; // omitted entirely
    if (!KNOWN_CREDENTIAL_TYPES.has(type)) continue; // unknown types are omitted
    if (type === 'mtls_auth') {
      credentials[type] = entries.map((entry) => ({ identity: entry.identity }));
      continue;
    }
    if (REDACTABLE_TYPES.has(type)) {
      const field = type === 'keyauth' ? 'key' : 'secret';
      credentials[type] = entries.map(() => ({ [field]: REDACTED }));
    }
  }
  return {
    id: consumer.id,
    username: consumer.username,
    namespace: consumer.namespace,
    custom_id: consumer.custom_id,
    credentials,
    acl_groups: [...consumer.acl_groups],
    created_at: consumer.created_at,
    updated_at: consumer.updated_at,
  };
}

/** Build (but do not start) the mock. */
export function createMockFerrumEdge(options: MockFerrumEdgeOptions): MockFerrumEdge {
  const secret = new TextEncoder().encode(options.jwtSecret);
  const issuer = options.issuer ?? 'ferrum-edge';
  const audience = options.audience;
  const maxCredentials = options.maxCredentialsPerType ?? 2;
  const requireNamespaceClaim = options.requireNamespaceClaim ?? false;

  const consumers = new Map<string, StoredConsumer>();
  const proxies = new Map<string, Record<string, unknown>>();
  const pluginConfigs = new Map<string, Record<string, unknown>>();
  const namespaces = new Map<string, { name: string; description: string | null }>();
  const requests: RecordedRequest[] = [];
  const failures: QueuedFailure[] = [];

  /** `<namespace>|<proxy_id>|<method>|<status>` → cumulative count. */
  const requestCounters = new Map<string, number>();
  /** `<namespace>|<proxy_id>` → observed durations in milliseconds. */
  const requestDurations = new Map<string, number[]>();
  /** `<namespace>|<proxy_id>` → seeded runtime backend state. */
  const backendStates = new Map<string, SeededBackendState & { sinceEpochMs: number }>();

  let health: Record<string, unknown> = {
    status: 'ok',
    ready: true,
    mode: 'database',
    admin_writes_enabled: true,
    database: { status: 'connected', type: 'sqlite' },
  };

  let server: Server | null = null;
  let baseUrl = '';
  /** Remembered so `stop()` → `start()` comes back on the same URL. */
  let boundPort = 0;

  function key(namespace: string, id: string): string {
    return `${namespace}/${id}`;
  }

  function consumersIn(namespace: string): StoredConsumer[] {
    return [...consumers.values()].filter((consumer) => consumer.namespace === namespace);
  }

  function identityTaken(namespace: string, values: (string | null)[], selfId?: string): boolean {
    const wanted = new Set(values.filter((value): value is string => Boolean(value)));
    return consumersIn(namespace).some((consumer) => {
      if (consumer.id === selfId) return false;
      return (
        wanted.has(consumer.id) ||
        wanted.has(consumer.username) ||
        (consumer.custom_id !== null && wanted.has(consumer.custom_id))
      );
    });
  }

  /* ── Metrics rendering ────────────────────────────────────────────────── */

  /**
   * Escape a label value the way the exposition format requires: backslash,
   * double quote and newline. Present so the client's parser is exercised
   * against real escaping rather than only against tidy identifiers.
   */
  function escapeLabel(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  }

  function renderLabels(labels: Record<string, string>): string {
    const rendered = Object.entries(labels)
      .map(([name, value]) => `${name}="${escapeLabel(value)}"`)
      .join(',');
    return `{${rendered}}`;
  }

  /**
   * Render the Prometheus exposition for every seeded proxy.
   *
   * Only the two families Nexus reads are emitted in full, plus one unrelated
   * family and the usual `# HELP` / `# TYPE` comments, so a scrape has
   * something to ignore.
   */
  function renderMetrics(): string {
    const lines: string[] = [
      '# HELP ferrum_gateway_uptime_seconds Seconds since the gateway process started.',
      '# TYPE ferrum_gateway_uptime_seconds gauge',
      `ferrum_gateway_uptime_seconds ${MOCK_GATEWAY_UPTIME_SECONDS}`,
      '# HELP ferrum_requests_total Total number of requests processed.',
      '# TYPE ferrum_requests_total counter',
    ];

    for (const [counterKey, count] of requestCounters) {
      const [namespace, proxyId, method, status] = counterKey.split('|');
      lines.push(
        `ferrum_requests_total${renderLabels({
          proxy_id: proxyId ?? '',
          method: method ?? '',
          status_code: status ?? '',
          namespace: namespace ?? '',
        })} ${count}`,
      );
    }

    lines.push(
      '# HELP ferrum_request_duration_ms Request duration in milliseconds.',
      '# TYPE ferrum_request_duration_ms histogram',
    );

    for (const [durationKey, observations] of requestDurations) {
      const [namespace, proxyId] = durationKey.split('|');
      const labels = { proxy_id: proxyId ?? '', namespace: namespace ?? '' };
      let cumulative = 0;
      for (const bound of HISTOGRAM_BOUNDS) {
        cumulative = observations.filter((value) => value <= bound).length;
        lines.push(
          `ferrum_request_duration_ms_bucket${renderLabels({
            ...labels,
            le: String(bound),
          })} ${cumulative}`,
        );
      }
      lines.push(
        `ferrum_request_duration_ms_bucket${renderLabels({ ...labels, le: '+Inf' })} ${
          observations.length
        }`,
        `ferrum_request_duration_ms_sum${renderLabels(labels)} ${observations.reduce(
          (sum, value) => sum + value,
          0,
        )}`,
        `ferrum_request_duration_ms_count${renderLabels(labels)} ${observations.length}`,
      );
    }

    return `${lines.join('\n')}\n`;
  }

  /** The `GET /admin/metrics` JSON payload, shaped like `docs/admin_metrics.md`. */
  function renderAdminMetrics(): Record<string, unknown> {
    const circuitBreakers: Record<string, unknown>[] = [];
    const unhealthyTargets: Record<string, unknown>[] = [];

    for (const [stateKey, state] of backendStates) {
      const [namespace, proxyId] = stateKey.split('|');
      if (state.breaker !== undefined) {
        circuitBreakers.push({
          namespace,
          proxy_id: proxyId,
          state: state.breaker,
          failure_count: state.breaker === 'closed' ? 0 : 5,
          success_count: state.breaker === 'half_open' ? 1 : 0,
        });
      }
      if (state.unhealthyTarget !== undefined) {
        unhealthyTargets.push({
          namespace,
          proxy_id: proxyId,
          target: state.unhealthyTarget,
          type: 'passive',
          since_epoch_ms: state.sinceEpochMs,
        });
      }
    }

    let totalRequests = 0;
    for (const count of requestCounters.values()) totalRequests += count;

    return {
      gateway: {
        mode: 'database',
        ferrum_version: '0.9.0',
        uptime_seconds: MOCK_GATEWAY_UPTIME_SECONDS,
        total_requests: totalRequests,
        proxy_count: proxies.size,
        consumer_count: consumers.size,
      },
      circuit_breakers: circuitBreakers,
      health_check: {
        unhealthy_target_count: unhealthyTargets.length,
        unhealthy_targets: unhealthyTargets,
      },
    };
  }

  function sendText(res: ServerResponse, status: number, body: string): void {
    res.writeHead(status, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
    res.end(body);
  }

  function send(res: ServerResponse, status: number, body?: unknown): void {
    if (body === undefined) {
      res.writeHead(status);
      res.end();
      return;
    }
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(payload);
  }

  function fail(res: ServerResponse, status: number, message: string): void {
    send(res, status, { error: message });
  }

  function paginate<T>(items: T[], query: URLSearchParams): Record<string, unknown> {
    const limit = Math.min(Number(query.get('limit') ?? 100) || 100, 1000);
    const offset = Math.max(Number(query.get('offset') ?? 0) || 0, 0);
    return {
      data: items.slice(offset, offset + limit),
      pagination: { offset, limit, total: items.length },
    };
  }

  async function verifyToken(req: IncomingMessage): Promise<Record<string, unknown> | Error> {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.toLowerCase().startsWith('bearer ')) {
      return new Error('Missing or malformed Authorization header');
    }
    const token = header.slice(7).trim();
    try {
      const { payload } = await jwtVerify(token, secret, { issuer, algorithms: ['HS256'] });
      const claims = payload as unknown as Record<string, unknown>;
      for (const claim of ['sub', 'iat', 'nbf', 'exp', 'jti']) {
        if (claims[claim] === undefined) return new Error(`Missing required claim '${claim}'`);
      }
      if (typeof claims.role !== 'string') return new Error('Missing required claim "role"');
      if (audience === undefined && claims.aud !== undefined) {
        // Matches Edge: an unexpected audience is a hard rejection.
        return new Error('Token carries an unexpected audience');
      }
      if (audience !== undefined && claims.aud !== audience) {
        return new Error('Token audience mismatch');
      }
      // A garbled tenancy claim is refused at authentication time whether or
      // not enforcement is on — it must never widen access.
      if (claims.ns !== undefined && namespacesInClaim(claims.ns) === null) {
        return new Error('Malformed "ns" claim');
      }
      return claims;
    } catch (error) {
      return new Error(error instanceof Error ? error.message : 'Invalid token');
    }
  }

  /**
   * The namespaces an `ns` claim authorizes, or `null` when it is malformed.
   *
   * Edge accepts a single string (`"ns": "prod"`) or an array of strings
   * (`"ns": ["prod", "staging"]`). Non-string entries and empty strings are
   * malformed.
   */
  function namespacesInClaim(claim: unknown): string[] | null {
    if (typeof claim === 'string') return claim === '' ? null : [claim];
    if (!Array.isArray(claim) || claim.length === 0) return null;
    const names: string[] = [];
    for (const entry of claim) {
      if (typeof entry !== 'string' || entry === '') return null;
      names.push(entry);
    }
    return names;
  }

  /**
   * Whether `claims` may address `namespace`, mirroring the gateway's
   * `FERRUM_ADMIN_REQUIRE_NAMESPACE_CLAIM=true`. With enforcement off every
   * token addresses every namespace; with it on, a token carrying no `ns` at
   * all is refused because tenancy intent must be explicit.
   */
  function claimAuthorizesNamespace(
    claims: Record<string, unknown> | null,
    namespace: string,
  ): boolean {
    if (!requireNamespaceClaim) return true;
    const allowed = namespacesInClaim(claims?.ns);
    return allowed !== null && allowed.includes(namespace);
  }

  async function readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    if (raw.trim() === '') return undefined;
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return Symbol.for('invalid-json');
    }
  }

  /* ── Route handlers ───────────────────────────────────────────────────── */

  function handleConsumers(
    res: ServerResponse,
    method: string,
    segments: string[],
    namespace: string,
    body: unknown,
    query: URLSearchParams,
  ): void {
    const [, id, credentialsSegment, credentialType, indexSegment] = segments;

    if (id === undefined) {
      if (method === 'GET') {
        send(res, 200, paginate(consumersIn(namespace).map(project), query));
        return;
      }
      if (method === 'POST') {
        if (!isRecord(body)) return fail(res, 400, 'Request body must be a JSON object');
        for (const field of Object.keys(body)) {
          if (!CONSUMER_KEYS.has(field)) return fail(res, 400, `unknown field: ${field}`);
        }
        const username = typeof body.username === 'string' ? body.username : '';
        if (username === '') return fail(res, 400, 'username must be non-empty');
        const newId = typeof body.id === 'string' && body.id !== '' ? body.id : randomUUID();
        const customId = typeof body.custom_id === 'string' ? body.custom_id : null;
        if (identityTaken(namespace, [newId, username, customId])) {
          return fail(
            res,
            409,
            'Consumer identity or credential conflicts with another Consumer in the namespace',
          );
        }
        const stored: StoredConsumer = {
          id: newId,
          username,
          namespace,
          custom_id: customId,
          credentials: normaliseCredentials(body.credentials),
          acl_groups: Array.isArray(body.acl_groups) ? body.acl_groups.map(String) : [],
          created_at: nowIso(),
          updated_at: nowIso(),
        };
        consumers.set(key(namespace, stored.id), stored);
        send(res, 201, project(stored));
        return;
      }
      return fail(res, 405, 'Method not allowed');
    }

    const stored = consumers.get(key(namespace, id));

    if (credentialsSegment === undefined) {
      if (method === 'GET') {
        if (!stored) return fail(res, 404, 'Consumer not found');
        return send(res, 200, project(stored));
      }
      if (method === 'PUT') {
        if (!stored) return fail(res, 404, 'Consumer not found');
        if (!isRecord(body)) return fail(res, 400, 'Request body must be a JSON object');
        for (const field of Object.keys(body)) {
          if (!CONSUMER_KEYS.has(field)) return fail(res, 400, `unknown field: ${field}`);
        }
        const username = typeof body.username === 'string' ? body.username : stored.username;
        const customId = typeof body.custom_id === 'string' ? body.custom_id : null;
        if (identityTaken(namespace, [username, customId], stored.id)) {
          return fail(
            res,
            409,
            'Consumer identity or credential conflicts with another Consumer in the namespace',
          );
        }
        stored.username = username;
        stored.custom_id = customId;
        stored.acl_groups = Array.isArray(body.acl_groups) ? body.acl_groups.map(String) : [];
        stored.credentials = mergeCredentialsOnReplace(stored.credentials, body.credentials);
        stored.updated_at = nowIso();
        return send(res, 200, project(stored));
      }
      if (method === 'DELETE') {
        if (!stored) return fail(res, 404, 'Consumer not found');
        consumers.delete(key(namespace, id));
        return send(res, 204);
      }
      return fail(res, 405, 'Method not allowed');
    }

    if (credentialsSegment !== 'credentials' || credentialType === undefined) {
      return fail(res, 404, 'Not found');
    }
    if (!stored) return fail(res, 404, 'Consumer not found');
    if (!KNOWN_CREDENTIAL_TYPES.has(credentialType)) {
      return fail(res, 400, `Unknown credential type '${credentialType}'`);
    }

    if (indexSegment !== undefined) {
      if (method !== 'DELETE') return fail(res, 405, 'Method not allowed');
      const index = Number(indexSegment);
      if (!Number.isInteger(index) || index < 0) {
        return fail(res, 400, 'Invalid credential index — must be a non-negative integer');
      }
      const entries = stored.credentials[credentialType];
      if (!entries || index >= entries.length) return fail(res, 404, 'Credential not found');
      entries.splice(index, 1);
      if (entries.length === 0) delete stored.credentials[credentialType];
      stored.updated_at = nowIso();
      return send(res, 200, project(stored));
    }

    if (method === 'POST') {
      if (!isRecord(body)) return fail(res, 400, 'Credential entry must be a JSON object');
      const entries = stored.credentials[credentialType] ?? [];
      if (entries.length >= maxCredentials) {
        return fail(res, 400, 'FERRUM_MAX_CREDENTIALS_PER_TYPE exceeded');
      }
      if (credentialType === 'keyauth' && body.key === REDACTED) {
        return fail(res, 400, '[REDACTED] is not accepted as credential material');
      }
      entries.push({ ...body });
      stored.credentials[credentialType] = entries;
      stored.updated_at = nowIso();
      return send(res, 200, project(stored));
    }
    if (method === 'PUT') {
      const list = Array.isArray(body) ? body : isRecord(body) ? [body] : null;
      if (!list) return fail(res, 400, 'Credential body must be an object or an array');
      if (list.length === 0) return fail(res, 400, 'Credential array must not be empty');
      if (list.length > maxCredentials) {
        return fail(res, 400, 'FERRUM_MAX_CREDENTIALS_PER_TYPE exceeded');
      }
      stored.credentials[credentialType] = list.map((entry) => ({ ...(entry as object) }));
      stored.updated_at = nowIso();
      return send(res, 200, project(stored));
    }
    if (method === 'DELETE') {
      delete stored.credentials[credentialType];
      stored.updated_at = nowIso();
      return send(res, 204);
    }
    return fail(res, 405, 'Method not allowed');
  }

  function normaliseCredentials(value: unknown): Record<string, Record<string, unknown>[]> {
    if (!isRecord(value)) return {};
    const result: Record<string, Record<string, unknown>[]> = {};
    for (const [type, entries] of Object.entries(value)) {
      if (Array.isArray(entries)) {
        result[type] = entries.filter(isRecord).map((entry) => ({ ...entry }));
      } else if (isRecord(entries)) {
        result[type] = [{ ...entries }];
      }
    }
    return result;
  }

  /**
   * `PUT /consumers/{id}` credential rules (§4.4): types the read projection
   * cannot express (`basicauth`) survive omission; types it can express are
   * removed when omitted; a `[REDACTED]` placeholder restores the stored entry
   * at the same index.
   */
  function mergeCredentialsOnReplace(
    stored: Record<string, Record<string, unknown>[]>,
    incoming: unknown,
  ): Record<string, Record<string, unknown>[]> {
    const submitted = normaliseCredentials(incoming);
    const result: Record<string, Record<string, unknown>[]> = {};

    for (const [type, entries] of Object.entries(submitted)) {
      const previous = stored[type] ?? [];
      result[type] = entries.map((entry, index) => {
        const field = type === 'keyauth' ? 'key' : 'secret';
        if (entry[field] === REDACTED) {
          const restored = previous[index];
          return restored ? { ...restored } : { ...entry };
        }
        return { ...entry };
      });
    }
    // Types absent from the read projection are preserved when omitted.
    for (const [type, entries] of Object.entries(stored)) {
      if (result[type] !== undefined) continue;
      if (type === 'basicauth' || !KNOWN_CREDENTIAL_TYPES.has(type)) result[type] = entries;
    }
    return result;
  }

  /**
   * Validate a proxy's `plugins[]` the way Edge's
   * `validate_proxy_plugin_associations` does, returning the joined 400 text or
   * `null`.
   *
   * The association id is resolved **namespace-locally**, so a config in
   * another tenant reads as non-existent rather than leaking across.
   */
  function proxyAssociationError(
    proxyId: string,
    namespace: string,
    plugins: unknown,
  ): string | null {
    if (plugins === undefined || plugins === null) return null;
    if (!Array.isArray(plugins)) return 'plugins must be an array of plugin associations';

    const errors: string[] = [];
    const seen = new Set<string>();
    for (const association of plugins) {
      if (!isRecord(association) || typeof association.plugin_config_id !== 'string') {
        return 'plugins entries must be objects carrying a string plugin_config_id';
      }
      const configId = association.plugin_config_id;
      if (seen.has(configId)) {
        errors.push(`Proxy '${proxyId}' references plugin_config '${configId}' more than once`);
        continue;
      }
      seen.add(configId);

      const config = pluginConfigs.get(key(namespace, configId));
      if (!config) {
        errors.push(`Proxy '${proxyId}' references non-existent plugin_config '${configId}'`);
        continue;
      }
      if (config.scope === 'global') {
        errors.push(
          `Proxy '${proxyId}' references plugin_config '${configId}' with scope 'global' — proxy associations may only reference proxy-scoped or proxy_group-scoped plugin configs`,
        );
        continue;
      }
      if (config.scope === 'proxy' && config.proxy_id !== proxyId) {
        errors.push(
          `Proxy '${proxyId}' references plugin_config '${configId}' targeted to proxy '${String(config.proxy_id ?? '<none>')}'`,
        );
        continue;
      }
      if (config.scope === 'proxy_group' && config.proxy_id != null) {
        errors.push(
          `Proxy '${proxyId}' references proxy_group plugin_config '${configId}' with proxy_id '${String(config.proxy_id)}'`,
        );
      }
    }

    return errors.length === 0 ? null : `Invalid proxy plugin associations: ${errors.join('; ')}`;
  }

  function handleProxies(
    res: ServerResponse,
    method: string,
    segments: string[],
    namespace: string,
    body: unknown,
    query: URLSearchParams,
  ): void {
    const id = segments[1];
    if (id === undefined) {
      if (method === 'GET') {
        const items = [...proxies.values()].filter((proxy) => proxy.namespace === namespace);
        return send(res, 200, paginate(items, query));
      }
      if (method === 'POST') {
        if (!isRecord(body)) return fail(res, 400, 'Request body must be a JSON object');
        for (const field of Object.keys(body)) {
          if (!PROXY_KEYS.has(field)) return fail(res, 400, `unknown field: ${field}`);
        }
        if (typeof body.listen_path !== 'string' || !body.listen_path.startsWith('/')) {
          return fail(res, 400, "listen_path must start with '/', '~' (regex), or '=/' (exact)");
        }
        if (typeof body.backend_host !== 'string' || body.backend_host === '') {
          return fail(res, 400, 'backend_host must be non-empty (or set upstream_id)');
        }
        const duplicate = [...proxies.values()].some(
          (proxy) => proxy.namespace === namespace && proxy.listen_path === body.listen_path,
        );
        if (duplicate) return fail(res, 409, 'listen_path already exists in this namespace');
        const newId = typeof body.id === 'string' && body.id !== '' ? body.id : randomUUID();
        const associationProblem = proxyAssociationError(newId, namespace, body.plugins);
        if (associationProblem) return fail(res, 400, associationProblem);
        const proxy = {
          ...body,
          id: newId,
          namespace,
          strip_listen_path: body.strip_listen_path ?? true,
          created_at: nowIso(),
          updated_at: nowIso(),
        };
        proxies.set(key(namespace, String(proxy.id)), proxy);
        return send(res, 201, proxy);
      }
      return fail(res, 405, 'Method not allowed');
    }

    const existing = proxies.get(key(namespace, id));
    if (method === 'GET') {
      return existing ? send(res, 200, existing) : fail(res, 404, 'Proxy not found');
    }
    if (method === 'PUT') {
      if (!existing) return fail(res, 404, 'Proxy not found');
      if (!isRecord(body)) return fail(res, 400, 'Request body must be a JSON object');
      for (const field of Object.keys(body)) {
        if (!PROXY_KEYS.has(field)) return fail(res, 400, `unknown field: ${field}`);
      }
      const associationProblem = proxyAssociationError(id, namespace, body.plugins);
      if (associationProblem) return fail(res, 400, associationProblem);
      const updated = {
        ...body,
        id,
        namespace,
        created_at: existing.created_at,
        updated_at: nowIso(),
      };
      proxies.set(key(namespace, id), updated);
      return send(res, 200, updated);
    }
    if (method === 'DELETE') {
      if (!existing) return fail(res, 404, 'Proxy not found');
      proxies.delete(key(namespace, id));
      for (const [configKey, config] of pluginConfigs) {
        if (config.namespace === namespace && config.proxy_id === id)
          pluginConfigs.delete(configKey);
      }
      return send(res, 204);
    }
    return fail(res, 405, 'Method not allowed');
  }

  function handlePluginConfigs(
    res: ServerResponse,
    method: string,
    segments: string[],
    namespace: string,
    body: unknown,
    query: URLSearchParams,
  ): void {
    const id = segments[2];
    if (id === undefined) {
      if (method === 'GET') {
        const items = [...pluginConfigs.values()].filter((item) => item.namespace === namespace);
        return send(res, 200, paginate(items, query));
      }
      if (method === 'POST') {
        if (!isRecord(body)) return fail(res, 400, 'Request body must be a JSON object');
        for (const field of Object.keys(body)) {
          if (!PLUGIN_CONFIG_KEYS.has(field)) return fail(res, 400, `unknown field: ${field}`);
        }
        if (typeof body.plugin_name !== 'string') return fail(res, 400, 'plugin_name is required');
        if (body.scope !== 'proxy' && body.scope !== 'global' && body.scope !== 'proxy_group') {
          return fail(res, 400, 'scope must be global, proxy or proxy_group');
        }
        if (body.scope === 'proxy' && typeof body.proxy_id !== 'string') {
          return fail(res, 400, "PluginConfig with scope 'proxy' must have proxy_id");
        }
        if (body.scope !== 'proxy' && body.proxy_id != null) {
          return fail(
            res,
            400,
            `PluginConfig with scope '${String(body.scope)}' must not have proxy_id`,
          );
        }
        if (body.scope === 'proxy' && !proxies.has(key(namespace, String(body.proxy_id)))) {
          return fail(
            res,
            400,
            `PluginConfig references non-existent proxy_id '${String(body.proxy_id)}'`,
          );
        }
        // Edge constructs an `enabled: true` plugin strictly and rejects a bad
        // config with a 400 *before* storing it.
        if (body.enabled !== false) {
          const problem = validatePluginConfig(body.plugin_name, body.config);
          if (problem) return fail(res, 400, problem);
        }
        const config = {
          ...body,
          id: typeof body.id === 'string' && body.id !== '' ? body.id : randomUUID(),
          namespace,
          enabled: body.enabled ?? true,
          config: body.config ?? {},
          created_at: nowIso(),
          updated_at: nowIso(),
        };
        pluginConfigs.set(key(namespace, String(config.id)), config);
        return send(res, 201, config);
      }
      return fail(res, 405, 'Method not allowed');
    }

    const existing = pluginConfigs.get(key(namespace, id));
    if (method === 'GET') {
      return existing ? send(res, 200, existing) : fail(res, 404, 'Plugin config not found');
    }
    if (method === 'PUT') {
      if (!existing) return fail(res, 404, 'Plugin config not found');
      if (!isRecord(body)) return fail(res, 400, 'Request body must be a JSON object');
      if (body.enabled !== false) {
        const problem = validatePluginConfig(
          String(body.plugin_name ?? existing.plugin_name),
          body.config,
        );
        if (problem) return fail(res, 400, problem);
      }
      const updated = {
        ...body,
        id,
        namespace,
        created_at: existing.created_at,
        updated_at: nowIso(),
      };
      pluginConfigs.set(key(namespace, id), updated);
      return send(res, 200, updated);
    }
    if (method === 'DELETE') {
      if (!existing) return fail(res, 404, 'Plugin config not found');
      pluginConfigs.delete(key(namespace, id));
      return send(res, 204);
    }
    return fail(res, 405, 'Method not allowed');
  }

  function handleNamespaces(
    res: ServerResponse,
    method: string,
    segments: string[],
    body: unknown,
    query: URLSearchParams,
  ): void {
    const name = segments[1];
    if (name === undefined) {
      if (method === 'GET') {
        const derived = new Set<string>(namespaces.keys());
        for (const consumer of consumers.values()) derived.add(consumer.namespace);
        for (const proxy of proxies.values()) derived.add(String(proxy.namespace));
        return send(res, 200, paginate([...derived].sort(), query));
      }
      if (method === 'POST') {
        if (!isRecord(body) || typeof body.name !== 'string') {
          return fail(res, 400, 'name is required');
        }
        if (namespaces.has(body.name)) return fail(res, 409, 'Namespace already exists');
        namespaces.set(body.name, {
          name: body.name,
          description: typeof body.description === 'string' ? body.description : null,
        });
        return send(res, 201, { name: body.name, created_at: nowIso(), updated_at: nowIso() });
      }
      return fail(res, 405, 'Method not allowed');
    }

    const existing = namespaces.get(name);
    if (method === 'GET') {
      if (!existing) return fail(res, 404, 'Namespace not found');
      return send(res, 200, { ...existing, created_at: nowIso(), updated_at: nowIso() });
    }
    if (method === 'DELETE') {
      if (!existing) return fail(res, 404, 'Namespace not found');
      namespaces.delete(name);
      return send(res, 204);
    }
    return fail(res, 405, 'Method not allowed');
  }

  /* ── Dispatcher ───────────────────────────────────────────────────────── */

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://mock.invalid');
    const segments = url.pathname.split('/').filter((segment) => segment !== '');
    const method = req.method ?? 'GET';
    const namespaceHeader = req.headers['x-ferrum-namespace'];
    const namespace = typeof namespaceHeader === 'string' ? namespaceHeader : DEFAULT_NAMESPACE;
    const body = await readBody(req);

    if (body === Symbol.for('invalid-json')) return fail(res, 400, 'Malformed JSON body');

    // /live is always unauthenticated; everything else needs a valid admin JWT.
    if (segments[0] === 'live') {
      requests.push({ method, path: url.pathname, query: {}, namespace, body: null, claims: null });
      return send(res, 200, { status: 'ok' });
    }

    const verified = await verifyToken(req);
    const claims = verified instanceof Error ? null : verified;
    requests.push({
      method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      namespace,
      body: body === undefined ? null : body,
      claims,
    });

    if (verified instanceof Error) return fail(res, 401, verified.message);
    if (claims?.role !== 'admin' && segments[0] === 'consumers') {
      return fail(res, 403, `Admin role '${String(claims?.role)}' cannot access this endpoint`);
    }

    // Namespace-scoped surfaces are selected by `X-Ferrum-Namespace`; the
    // `/namespaces/{name}` registry routes are selected by the name in the path.
    const scopedNamespace =
      segments[0] === 'consumers' || segments[0] === 'proxies'
        ? namespace
        : segments[0] === 'plugins' && segments[1] === 'config'
          ? namespace
          : segments[0] === 'namespaces' && segments[1] !== undefined
            ? decodeURIComponent(segments[1])
            : null;
    if (scopedNamespace !== null && !claimAuthorizesNamespace(claims, scopedNamespace)) {
      return fail(res, 403, `Token is not authorized for namespace '${scopedNamespace}'`);
    }

    const failure = failures.find(
      (entry) =>
        (entry.pathContains === undefined || url.pathname.includes(entry.pathContains)) &&
        (entry.method === undefined || entry.method === method),
    );
    if (failure) {
      failures.splice(failures.indexOf(failure), 1);
      return send(res, failure.status, failure.body ?? { error: 'Injected failure' });
    }

    switch (segments[0]) {
      case 'health':
      case 'status':
        // Edge serves the *complete* payload with a 503 while it is
        // `starting`, `draining` or `unavailable` — not an error body.
        return send(res, health.ready === false ? 503 : 200, health);
      case 'version':
        // Real Edge has no /version; the mock answers 404 so the client's
        // tolerant probe is exercised.
        return fail(res, 404, 'Not found');
      case 'metrics':
        // Authenticated like every other admin surface. Series are labelled by
        // namespace rather than scoped by the request header, exactly as the
        // process-global Prometheus exporter does.
        if (method !== 'GET') return fail(res, 405, 'Method not allowed');
        return sendText(res, 200, renderMetrics());
      case 'admin':
        if (segments[1] !== 'metrics') return fail(res, 404, 'Not found');
        if (method !== 'GET') return fail(res, 405, 'Method not allowed');
        return send(res, 200, renderAdminMetrics());
      case 'namespaces':
        return handleNamespaces(res, method, segments, body, url.searchParams);
      case 'consumers':
        return handleConsumers(res, method, segments, namespace, body, url.searchParams);
      case 'proxies':
        return handleProxies(res, method, segments, namespace, body, url.searchParams);
      case 'plugins':
        if (segments[1] === 'config') {
          return handlePluginConfigs(res, method, segments, namespace, body, url.searchParams);
        }
        if (method === 'GET') {
          return send(res, 200, [
            'key_auth',
            'basic_auth',
            'jwt_auth',
            'access_control',
            'cors',
            'rate_limiting',
          ]);
        }
        return fail(res, 404, 'Not found');
      default:
        return fail(res, 404, 'Not found');
    }
  }

  return {
    get url(): string {
      return baseUrl;
    },
    requests,
    consumers,
    proxies,
    pluginConfigs,

    async start(): Promise<string> {
      if (server) return baseUrl;
      server = createServer((req, res) => {
        handle(req, res).catch((error: unknown) => {
          send(res, 500, { error: error instanceof Error ? error.message : 'mock failure' });
        });
      });
      await new Promise<void>((resolveListen) => {
        server?.listen(boundPort, '127.0.0.1', () => resolveListen());
      });
      const address = server.address() as AddressInfo;
      boundPort = address.port;
      baseUrl = `http://127.0.0.1:${address.port}`;
      return baseUrl;
    },

    async stop(): Promise<void> {
      if (!server) return;
      const current = server;
      server = null;
      await new Promise<void>((resolveClose) => current.close(() => resolveClose()));
    },

    reset(): void {
      consumers.clear();
      proxies.clear();
      pluginConfigs.clear();
      namespaces.clear();
      requests.length = 0;
      failures.length = 0;
      requestCounters.clear();
      requestDurations.clear();
      backendStates.clear();
    },

    setHealth(payload: Record<string, unknown>): void {
      health = payload;
    },

    queueFailure(status: number, body?: unknown, pathContains?: string, method?: string): void {
      failures.push({
        status,
        body: body ?? { error: 'Injected failure' },
        ...(pathContains === undefined ? {} : { pathContains }),
        ...(method === undefined ? {} : { method }),
      });
    },

    seedConsumer(consumer): StoredConsumer {
      const namespace = consumer.namespace ?? DEFAULT_NAMESPACE;
      const stored: StoredConsumer = {
        id: consumer.id ?? randomUUID(),
        username: consumer.username,
        namespace,
        custom_id: consumer.custom_id ?? null,
        credentials: consumer.credentials ?? {},
        acl_groups: consumer.acl_groups ?? [],
        created_at: consumer.created_at ?? nowIso(),
        updated_at: consumer.updated_at ?? nowIso(),
      };
      consumers.set(key(namespace, stored.id), stored);
      return stored;
    },

    recordRequests(proxyId, entry, namespace = 'nexus'): void {
      const counterKey = `${namespace}|${proxyId}|${entry.method}|${String(entry.status)}`;
      requestCounters.set(counterKey, (requestCounters.get(counterKey) ?? 0) + entry.count);
      if (entry.durations && entry.durations.length > 0) {
        const durationKey = `${namespace}|${proxyId}`;
        const existing = requestDurations.get(durationKey) ?? [];
        existing.push(...entry.durations);
        requestDurations.set(durationKey, existing);
      }
    },

    setBackendState(proxyId, state, namespace = 'nexus'): void {
      backendStates.set(`${namespace}|${proxyId}`, { ...state, sinceEpochMs: Date.now() });
    },

    consumerByUsername(username, namespace = 'nexus'): StoredConsumer | undefined {
      return [...consumers.values()].find(
        (consumer) => consumer.namespace === namespace && consumer.username === username,
      );
    },

    proxyByName(name, namespace = 'nexus'): Record<string, unknown> | undefined {
      return [...proxies.values()].find(
        (proxy) => proxy.namespace === namespace && proxy.name === name,
      );
    },

    pluginsForProxy(proxyId, namespace = 'nexus'): Record<string, unknown>[] {
      return [...pluginConfigs.values()].filter(
        (config) => config.namespace === namespace && config.proxy_id === proxyId,
      );
    },

    effectivePluginsForProxy(proxyId, namespace = 'nexus'): Record<string, unknown>[] {
      const proxy = proxies.get(key(namespace, proxyId));
      if (!proxy) return [];
      const associated = new Set(
        (Array.isArray(proxy.plugins) ? proxy.plugins : [])
          .filter(isRecord)
          .map((association) => String(association.plugin_config_id)),
      );

      // A scoped config runs only when the proxy associates it, and a
      // proxy-scoped one additionally has to name this proxy.
      const scopedApplies = (config: Record<string, unknown>): boolean => {
        if (config.namespace !== namespace || config.enabled === false) return false;
        if (config.scope === 'proxy') {
          return config.proxy_id === proxyId && associated.has(String(config.id));
        }
        if (config.scope === 'proxy_group') return associated.has(String(config.id));
        return false;
      };

      const scoped = [...pluginConfigs.values()].filter(scopedApplies);
      // A global config is shadowed by any scoped config of the same plugin
      // that applies to this proxy.
      const globals = [...pluginConfigs.values()].filter(
        (config) =>
          config.namespace === namespace &&
          config.enabled !== false &&
          config.scope === 'global' &&
          !scoped.some((candidate) => candidate.plugin_name === config.plugin_name),
      );
      return [...globals, ...scoped];
    },

    pluginForProxy(proxyId, pluginName, namespace = 'nexus'): Record<string, unknown> | undefined {
      return [...pluginConfigs.values()].find(
        (config) =>
          config.namespace === namespace &&
          config.proxy_id === proxyId &&
          config.plugin_name === pluginName,
      );
    },

    callsTo(method, pathContains): RecordedRequest[] {
      return requests.filter(
        (entry) => entry.method === method && entry.path.includes(pathContains),
      );
    },
  };
}
