/**
 * Wire shapes of the Ferrum Edge Admin API — only the subset Nexus uses.
 *
 * Two rules from the Edge source shape everything here:
 *
 * 1. `Proxy`, `Consumer`, `PluginConfig` and `Upstream` all carry
 *    `#[serde(deny_unknown_fields)]`. **Sending a field Edge does not know is a
 *    400, never a silent no-op.** The request types below are therefore
 *    deliberately narrow — add a field only after confirming it against
 *    `ref-edge-admin.md`.
 * 2. Every plugin's `config` is hand-parsed against a **closed key allowlist**,
 *    so the plugin config types are exact, not "at least these keys".
 */

import type { AuthPluginType, EdgeCredentialType, HttpMethod } from '@ferrum-nexus/shared';

/* ── Envelopes ──────────────────────────────────────────────────────────── */

/** Pagination block returned by every Edge list endpoint. */
export interface EdgePagination {
  offset: number;
  /** The page size the server applied, not the number of items returned. */
  limit: number;
  /** Total rows matching, ignoring pagination. */
  total: number;
}

/** Standard Edge list envelope: `{ data, pagination }`. */
export interface EdgePage<T> {
  data: T[];
  pagination: EdgePagination;
}

/** Edge's flat error body. There is no stable machine-readable code. */
export interface EdgeErrorBody {
  error: string;
  /** Present on live-apply 503s: the row is durable but not yet live. */
  applied?: boolean;
  /** `config_rejected` | `reload_timeout` | `sequence_unavailable`. */
  reason?: string;
  /** Present on some namespace/Mongo errors — names the config to change. */
  detail?: string;
}

/** Query parameters accepted by Edge list endpoints. */
export interface EdgeListQuery {
  limit?: number;
  offset?: number;
}

/* ── Namespaces ─────────────────────────────────────────────────────────── */

/** A namespace registry row (`GET /namespaces/{name}`). */
export interface EdgeNamespace {
  name: string;
  description?: string | null;
  created_at?: string;
  updated_at?: string;
}

/* ── Consumers and credentials ──────────────────────────────────────────── */

/** `keyauth` entry — the API key for the `key_auth` plugin. */
export interface EdgeKeyAuthCredential {
  /** Reads always return the literal string `[REDACTED]`. */
  key: string;
}

/** `basicauth` entry — write-only; never present in a read response. */
export interface EdgeBasicAuthCredential {
  password?: string;
  /** `hmac_sha256:<64 hex>` pre-hashed form. */
  password_hash?: string;
}

/** `jwt` entry — HS256 shared secret, 32–4096 characters. */
export interface EdgeJwtCredential {
  /** Reads always return the literal string `[REDACTED]`. */
  secret: string;
}

/** Any credential entry Nexus writes. */
export type EdgeCredentialEntry =
  EdgeKeyAuthCredential | EdgeBasicAuthCredential | EdgeJwtCredential;

/**
 * `Consumer.credentials` — a map of credential type to a **non-empty array** of
 * entries. The array is the rotation mechanism, capped by the gateway's
 * `FERRUM_MAX_CREDENTIALS_PER_TYPE` (default 2).
 */
export type EdgeCredentialMap = Partial<Record<EdgeCredentialType, EdgeCredentialEntry[]>> &
  Record<string, EdgeCredentialEntry[] | undefined>;

/** A Ferrum consumer as returned by the Admin API (credentials redacted). */
export interface EdgeConsumer {
  id: string;
  username: string;
  namespace: string;
  custom_id?: string | null;
  credentials: EdgeCredentialMap;
  /** ACL group memberships; max 500 entries of max 255 chars each. */
  acl_groups: string[];
  created_at?: string;
  updated_at?: string;
}

/**
 * Body for `POST /consumers` and `PUT /consumers/{id}`.
 *
 * `namespace` is intentionally absent: the `X-Ferrum-Namespace` header
 * overwrites it on the wire, and sending unknown/read-only fields risks a 400.
 * `PUT` is a whole-resource replace — always build it from a `GET` response so
 * omitted credential types are not deleted.
 */
export interface EdgeConsumerWrite {
  id?: string;
  username: string;
  custom_id?: string | null;
  credentials?: EdgeCredentialMap;
  acl_groups?: string[];
}

/* ── Proxies ────────────────────────────────────────────────────────────── */

/** Backend scheme enum. Nexus only ever uses the HTTP family. */
export type EdgeBackendScheme = 'http' | 'https' | 'tcp' | 'tcps' | 'udp' | 'dtls';

/**
 * `Proxy.circuit_breaker` — passive failure detection in front of the backend.
 *
 * Every field carries a serde default, so `{}` is a legal config; Nexus sends
 * the defaults explicitly instead, because a proxy document that shows its own
 * thresholds is what an operator can reason about, and because a gateway
 * upgrade that changed a default must not silently change the failure policy of
 * an already-published API.
 */
export interface EdgeCircuitBreakerConfig {
  /** Consecutive failures that trip the circuit open. Default 5. */
  failure_threshold: number;
  /** Consecutive half-open successes that close it again. Default 3. */
  success_threshold: number;
  /** Seconds to stay open before probing. Default 30. */
  timeout_seconds: number;
  /** Response codes counted as failures. Default `[500, 502, 503, 504]`. */
  failure_status_codes: number[];
  /** Concurrent probes allowed while half-open. Default 1. */
  half_open_max_requests: number;
  /** Count TCP/DNS/TLS/connect-timeout errors as failures. Default true. */
  trip_on_connection_errors: boolean;
}

/** A Ferrum proxy (HTTP-family subset). */
export interface EdgeProxy {
  id: string;
  namespace: string;
  name?: string | null;
  listen_path?: string | null;
  hosts?: string[];
  backend_scheme?: EdgeBackendScheme | null;
  backend_host?: string;
  backend_port?: number;
  backend_path?: string | null;
  strip_listen_path?: boolean;
  preserve_host_header?: boolean;
  /** TCP connect timeout in ms. Gateway default 5000. */
  backend_connect_timeout_ms?: number;
  /** Backend read timeout in ms. Gateway default 30000; `0` disables it. */
  backend_read_timeout_ms?: number;
  /** Backend write timeout in ms. Gateway default 30000; `0` disables it. */
  backend_write_timeout_ms?: number;
  /** Accepted HTTP methods; `null` (the default) accepts all of them. */
  allowed_methods?: HttpMethod[] | null;
  /**
   * Origins accepted on a WebSocket upgrade, compared case-insensitively.
   * `[]` (the default) performs no check at all. Independent of the `cors`
   * plugin, which does not run on upgrades.
   */
  allowed_ws_origins?: string[];
  circuit_breaker?: EdgeCircuitBreakerConfig | null;
  plugins?: EdgePluginAssociation[];
  api_spec_id?: string | null;
  created_at?: string;
  updated_at?: string;
}

/** An entry of `Proxy.plugins` — the `proxy_group` attach mechanism. */
export interface EdgePluginAssociation {
  plugin_config_id: string;
}

/**
 * Body for `POST /proxies` — the shape Nexus **composes** from scratch.
 *
 * Only the HTTP-family fields Nexus actually sets — Edge's `Proxy` write shape
 * is far wider (timeouts, backend TLS, pooling, upstreams, stream listeners).
 * `namespace`, `created_at` and `updated_at` are *accepted* by the deserializer
 * but server-owned: the namespace comes from `X-Ferrum-Namespace` and the
 * timestamps from the server, so Nexus never sends them.
 *
 * A proxy is created before its plugin configs exist, so there is nothing to
 * associate yet and `plugins` is deliberately absent here — see
 * {@link EdgeProxyReplace}, which is the shape every *later* write takes.
 */
export interface EdgeProxyWrite {
  id?: string;
  name?: string | null;
  /** `/<namespace>/<slug>` for a Nexus-published API. */
  listen_path: string;
  hosts?: string[];
  backend_scheme?: 'http' | 'https';
  backend_host: string;
  backend_port: number;
  backend_path?: string | null;
  strip_listen_path?: boolean;
  preserve_host_header?: boolean;
  backend_connect_timeout_ms?: number;
  backend_read_timeout_ms?: number;
  backend_write_timeout_ms?: number;
  /**
   * Accepted HTTP methods. A method outside the list is `405`ed **before any
   * plugin runs**, so a proxy carrying a `cors` plugin must list `OPTIONS` or
   * every browser preflight fails.
   */
  allowed_methods?: HttpMethod[] | null;
  /** WebSocket `Origin` allow-list; `[]` means no check. */
  allowed_ws_origins?: string[];
  circuit_breaker?: EdgeCircuitBreakerConfig | null;
}

/**
 * Body for `PUT /proxies/{id}` — the shape Nexus **echoes** rather than
 * composes.
 *
 * `PUT` is a whole-resource replace with no concurrency token, and `Proxy`
 * carries `deny_unknown_fields`, so the only safe body is the document
 * `GET /proxies/{id}` just returned, with the handful of fields being changed
 * overwritten and the server-owned ones (`namespace`, `created_at`,
 * `updated_at`) dropped. Edge's `Proxy` is far wider than {@link EdgeProxy}
 * models — timeouts, backend TLS, pooling, `upstream_id`, stream listeners —
 * and every unmodelled key an operator set has to survive the round trip, so
 * the index signature is deliberate: those values come straight off the wire
 * and are never interpreted.
 *
 * **Never hand-write one.** Build it by copying a `GET` response; the
 * publishing service's `mutateProxy` is the only intended producer.
 */
export interface EdgeProxyReplace {
  /**
   * Which plugin configs this proxy runs. A proxy-scoped config is inert until
   * its id appears here (`plugin_cache.rs`
   * `scoped_plugin_config_applies_to_proxy`), and an omitted or empty list
   * detaches every one of them.
   */
  plugins?: EdgePluginAssociation[];
  /** Every other field, copied verbatim from the preceding `GET`. */
  [field: string]: unknown;
}

/* ── Plugin configs ─────────────────────────────────────────────────────── */

/** Attach scope of a plugin config. Nexus always uses `proxy`. */
export type EdgePluginScope = 'global' | 'proxy' | 'proxy_group';

/** `key_auth` config — exactly two accepted keys. */
export interface EdgeKeyAuthConfig {
  /** `header:<name>` or `query:<name>`. Default `header:X-API-Key`. */
  key_location?: string;
  /** Strip the credential before forwarding. Default `true`. */
  hide_credentials?: boolean;
}

/** `basic_auth` takes no configuration at all — `{}` or `null` only. */
export type EdgeBasicAuthConfig = Record<string, never>;

/** `jwt_auth` config subset Nexus sets. */
export interface EdgeJwtAuthConfig {
  token_lookup?: string;
  /** Claim whose value maps to the consumer. Default `sub`. */
  consumer_claim_field?: string;
  require_exp?: boolean;
  expected_issuer?: string;
  audiences?: string[];
  leeway_secs?: number;
}

/**
 * `access_control` config — exactly five accepted keys, at least one of which
 * must be non-empty. Nexus only ever sets `allowed_groups`; see
 * `ref-edge-admin.md` §7.5 for why usernames are a trap.
 */
export interface EdgeAccessControlConfig {
  allowed_consumers?: string[];
  disallowed_consumers?: string[];
  /** `[aclGroupForApi(apiId)]` — the only field Nexus writes. */
  allowed_groups?: string[];
  disallowed_groups?: string[];
  /** Mutually exclusive with any allow-list; Nexus never sets it. */
  allow_authenticated_identity?: boolean;
}

/** One rule inside `rate_limiting.limits`. */
export interface EdgeRateLimitRule {
  scope: 'default' | 'consumers';
  /** Required iff `scope === 'consumers'`; forbidden otherwise. */
  consumers?: string[];
  requests_per_second?: number;
  requests_per_minute?: number;
  requests_per_hour?: number;
  /** Custom window; must be paired with `max_requests` and never mixed with the preset trio. */
  window_seconds?: number;
  max_requests?: number;
}

/** `rate_limiting` config — `limits` is required and needs exactly one `default` rule. */
export interface EdgeRateLimitingConfig {
  /** Only `ip`, `consumer` or `spiffe`. */
  limit_by?: 'ip' | 'consumer' | 'spiffe';
  expose_headers?: boolean;
  limits: EdgeRateLimitRule[];
  /**
   * Where the counters live. `local` (the default) is **per gateway process**,
   * so N data-plane replicas enforce N times the quota; `redis` shares one
   * counter across them.
   */
  sync_mode?: 'local' | 'redis';
  /** `redis://` or `rediss://`. Required when `sync_mode` is `redis`. */
  redis_url?: string;
  /** Upgrade a `redis://` connection to TLS. */
  redis_tls?: boolean;
}

/**
 * One `cors.allowed_origins` entry.
 *
 * A plain string is Edge's **native** syntax (`"*"`, an exact
 * `scheme://host[:port]`, or a `*.suffix.com` wildcard). An object is the
 * Istio `StringMatch` form and carries **exactly one** of `exact`/`prefix`/
 * `regex` with literal semantics — `{ exact: '*.example.com' }` matches that
 * one literal string, while the plain string matches every subdomain.
 */
export type EdgeCorsOrigin = string | { exact: string } | { prefix: string } | { regex: string };

/**
 * `cors` config — a closed key set with `allowed_origins` required and bounded
 * at 64 entries. `preflight_continue` and `unmatched_preflights` are mutually
 * exclusive. Nexus does not write this plugin today; the type exists so an
 * operator-managed CORS config read back off a proxy is not `unknown`.
 */
export interface EdgeCorsConfig {
  /** Required, 1–64 entries. There is no implicit wildcard. */
  allowed_origins: EdgeCorsOrigin[];
  /** Preflight policy only; never evaluated against an actual request. */
  allowed_methods?: string[];
  /** Preflight policy only; never evaluated against an actual request. */
  allowed_headers?: string[];
  exposed_headers?: string[];
  /** Incompatible with wildcard/universal origins. */
  allow_credentials?: boolean;
  /** Preflight cache seconds; native default 86400. */
  max_age?: number;
  /** Pass allowed preflights to the backend. */
  preflight_continue?: boolean;
  /** Istio projection marker; mutually exclusive with `preflight_continue`. */
  unmatched_preflights?: 'forward' | 'ignore';
}

/**
 * One entry of `openapi_validator.operations`.
 *
 * These three fields are the whole required set: `request_body` and
 * `responses` are optional, and a schema-free entry is legal as long as the
 * config also sets `fail_on_unknown_operation`. `path_regex` is anchored by
 * Edge into `^(?:…)$` on top of whatever it is given, so an already-anchored
 * pattern — which is what Edge's own spec importer emits — is accepted and
 * behaves identically.
 */
export interface EdgeOpenapiValidatorOperation {
  /** Uppercase HTTP method; Edge upper-cases it again on the way in. */
  method: string;
  /** The path template, used for the operation label and for ordering ties. */
  path_template: string;
  /** Full-match regex over the canonical policy path (listen path included). */
  path_regex: string;
}

/**
 * `openapi_validator` config — a closed key set at every level.
 *
 * **Nexus never writes one.** Edge refuses a hand-built `openapi_validator` on
 * a proxy with no attached `api_spec` (`validate_openapi_validator_precondition`
 * in `admin/crud.rs`), so the only way a portal gets one is to let the gateway
 * generate it from a submitted document — see `spec-document.ts`. This type
 * describes what comes *back* out of Edge, which is what the publishing tests
 * assert the generated table against.
 */
export interface EdgeOpenapiValidatorConfig {
  /** `block` rejects, `log_only` records, `disabled` skips. Native default `block`. */
  enforcement_mode?: 'block' | 'log_only' | 'disabled';
  validate_request?: boolean;
  validate_response?: boolean;
  /** Reject a request matching no operation. Native default `true`. */
  fail_on_unknown_operation?: boolean;
  /** Required, and rejected when empty. */
  operations: EdgeOpenapiValidatorOperation[];
  /** Escape hatches evaluated *before* the unknown-operation check. */
  bypass?: {
    /** Regexes over the request path. */
    paths?: string[];
    /** HTTP methods skipped wholesale — how a CORS preflight survives. */
    methods?: string[];
    /** Authenticated identities or consumer usernames. */
    consumers?: string[];
    /** Header name → required value, or `null` for "any value". */
    header_present?: Record<string, string | null>;
  };
}

/** Any plugin config body Nexus writes. */
export type EdgePluginSettings =
  | EdgeKeyAuthConfig
  | EdgeBasicAuthConfig
  | EdgeJwtAuthConfig
  | EdgeAccessControlConfig
  | EdgeRateLimitingConfig
  | EdgeCorsConfig
  | EdgeOpenapiValidatorConfig
  | Record<string, unknown>;

/**
 * A per-instance execution `trigger` on a plugin config.
 *
 * Edge accepts a full predicate tree over method, path, host, SNI, headers,
 * query, cookies, protocol, source CIDR, listener port and post-authentication
 * identity; a node sets exactly one of `all`, `any`, `not` or `match`, and a
 * `match` leaf sets exactly one predicate. Nexus emits only the `all`/`match`
 * shapes its portal-level trigger compiles to, so this type is deliberately
 * loose about the leaf rather than modelling a grammar nothing here generates.
 *
 * **Not every plugin accepts one.** Edge refuses a trigger on a plugin that
 * publishes contextless initial-response-header policy, a fixed per-proxy body
 * ceiling, or contextless response-trailer ownership — `supports_trigger` on
 * each palette descriptor records which is which.
 */
export interface EdgePluginTrigger {
  when: Record<string, unknown>;
}

/** A plugin config resource. */
export interface EdgePluginConfig {
  id: string;
  namespace: string;
  plugin_name: string;
  config: Record<string, unknown>;
  scope: EdgePluginScope;
  proxy_id?: string | null;
  enabled: boolean;
  priority_override?: number | null;
  /** Absent on an instance that runs for every request on its proxy. */
  trigger?: EdgePluginTrigger | null;
  api_spec_id?: string | null;
  created_at?: string;
  updated_at?: string;
}

/** Body for `POST /plugins/config` / `PUT /plugins/config/{id}`. */
export interface EdgePluginConfigWrite {
  id?: string;
  /** One of `GET /plugins`; `key_auth`, `basic_auth`, `jwt_auth`, `access_control`, `rate_limiting`. */
  plugin_name: AuthPluginType | 'access_control' | 'rate_limiting' | string;
  scope: EdgePluginScope;
  /** Required when `scope === 'proxy'`; must be absent otherwise. */
  proxy_id?: string | null;
  enabled: boolean;
  config: EdgePluginSettings;
  /**
   * Execution priority override. Nexus never *chooses* one — the plugin
   * ordering is the gateway's — but a proxy rebuild has to carry an operator's
   * across, so it is omitted rather than sent as `null` when there is none.
   */
  priority_override?: number;
  /**
   * Per-instance execution trigger. Omitted entirely — never sent as `null` —
   * when the instance should run for every request: `PUT /plugins/config/{id}`
   * is a whole-resource replace, so omitting the key is how a trigger is
   * removed.
   */
  trigger?: EdgePluginTrigger;
}

/* ── API specs ──────────────────────────────────────────────────────────── */

/**
 * An OpenAPI document submitted to `POST`/`PUT /api-specs`.
 *
 * The provider's own document, with `servers` rewritten to the listen path and
 * the `x-ferrum-proxy` / `x-ferrum-validate` extensions stamped on — Edge
 * creates the proxy and generates the `openapi_validator` from it in one
 * transaction. Deliberately untyped past the root: the body is whatever the
 * provider uploaded, and Nexus is not a spec linter.
 *
 * @see server/src/publishing/spec-document.ts, which is the only producer.
 */
export type EdgeApiSpecDocument = Record<string, unknown>;

/** `201`/`200` body of `POST`/`PUT /api-specs`. */
export interface EdgeApiSpecRef {
  /** UUID of the spec — new on create, unchanged on replace. */
  id: string;
  /** The proxy this spec owns. Echoes the submitted `x-ferrum-proxy.id`. */
  proxy_id: string;
  /** `openapi` version string detected in the document. */
  spec_version?: string;
  /** Lowercase hex SHA-256 of the stored bytes. */
  content_hash?: string;
}

/**
 * One row of `GET /api-specs` — metadata only; the document is not included.
 *
 * Nexus reads exactly one field off it, `id`, which is how it finds the spec
 * behind a proxy without storing an id whose lifecycle it does not own. The
 * rest is here because the wire carries it.
 */
export interface EdgeApiSpecSummary {
  id: string;
  proxy_id: string;
  namespace?: string;
  spec_version?: string;
  spec_format?: 'json' | 'yaml';
  title?: string | null;
  info_version?: string | null;
  operation_count?: number;
  content_hash?: string;
  created_at?: string;
  updated_at?: string;
}

/**
 * `GET /api-specs` — a **different** envelope from every other list endpoint.
 *
 * The rest of the Admin API pages with {@link EdgePage}'s `data` +
 * `pagination`; `/api-specs` is flat, with `items` and the counters alongside
 * it. Not a Nexus modelling choice — it is what the gateway sends
 * (`ApiSpecListResponse` in `openapi.yaml`), and reading `data` off it silently
 * yields nothing.
 */
export interface EdgeApiSpecPage {
  items: EdgeApiSpecSummary[];
  limit?: number;
  offset?: number;
  next_offset?: number | null;
  total?: number;
}

/* ── Health ─────────────────────────────────────────────────────────────── */

/**
 * Authenticated `GET /health`. Nexus watches `mode`, `ready` and
 * `admin_writes_enabled`; the rest is diagnostic.
 */
export interface EdgeHealth {
  status: string;
  ready?: boolean;
  timestamp?: string;
  mode?: string;
  admin_writes_enabled?: boolean;
  config_rejected?: boolean;
  database?: { status?: string; type?: string };
  cached_config?: { proxy_count?: number; consumer_count?: number };
}

/** Result of the Nexus-side Edge probe used by `GET /api/health`. */
export interface EdgeProbe {
  /**
   * Whether the gateway answered at all. A gateway that answered `503` because
   * it is `starting`/`draining`/`unavailable` is **reachable** — read `ready`.
   */
  reachable: boolean;
  /** Round-trip time of the probe in milliseconds. */
  latencyMs: number;
  /**
   * Edge's own status word (`ok`, `degraded`, `starting`, `unavailable`,
   * `draining`), or `null` when nothing answered.
   */
  status: string | null;
  /** Edge's readiness verdict, or `null` when nothing answered. */
  ready: boolean | null;
  /** `mode` from the authenticated health payload, when it answered. */
  mode: string | null;
  /** Whether Edge will currently accept config writes. */
  adminWritesEnabled: boolean | null;
  /**
   * Gateway version string, or `null`.
   *
   * Edge has **no `/version` endpoint** (`ref-edge-admin.md` §10.5); this is
   * populated only if a deployment exposes one, and is `null` otherwise.
   */
  version: string | null;
  /** Failure detail, safe to log; never echoed to browsers. */
  error: string | null;
}

/* ── Runtime metrics ────────────────────────────────────────────────────── */

/**
 * `ferrum_requests_total` for one proxy, reduced to the two label dimensions
 * Nexus renders.
 *
 * Every count is **cumulative since the gateway process started** — Edge
 * exposes no windowed per-proxy counter and Nexus stores no history, so there
 * is no honest way to derive "requests in the last hour" from this.
 */
export interface EdgeRequestCounts {
  /** `method` label → cumulative count. */
  byMethod: Record<string, number>;
  /** `status_code` label → cumulative count. */
  byStatus: Record<string, number>;
  /** Sum over every kept series. */
  total: number;
}

/** One `le` bucket of `ferrum_request_duration_ms`. */
export interface EdgeLatencyBucket {
  /** Upper bound in milliseconds; `Infinity` for the `+Inf` bucket. */
  le: number;
  /** Cumulative count of observations at or below `le`. */
  count: number;
}

/** `ferrum_request_duration_ms` for one proxy. */
export interface EdgeLatencyHistogram {
  /** Buckets sorted ascending by `le`, with the `+Inf` bucket last. */
  buckets: EdgeLatencyBucket[];
  /** The `_count` sample, or `null` when the exposition carried none. */
  count: number | null;
  /** The `_sum` sample, or `null` when the exposition carried none. */
  sum: number | null;
}

/** What one `GET /metrics` scrape yielded for a single proxy. */
export interface EdgeProxyMetrics {
  /**
   * `false` when the scrape could not be completed or produced nothing usable
   * (gateway unreachable, non-2xx, or a body with no recognisable samples). The
   * counters are then zeroed rather than absent, so callers never branch on
   * `undefined`.
   */
  available: boolean;
  requests: EdgeRequestCounts;
  latency: EdgeLatencyHistogram;
}

/**
 * One `circuit_breakers[]` entry from `GET /admin/metrics`.
 *
 * `target` is present only for per-target (upstream) breakers; a proxy with a
 * direct backend gets one per-proxy breaker with no target. A proxy that has no
 * `circuit_breaker` config, or has one but has never been hit, does not appear
 * in the array at all — which is why "no breaker" cannot be read as "healthy".
 */
export interface EdgeCircuitBreaker {
  namespace?: string;
  proxy_id: string;
  target?: string;
  /** `closed` | `open` | `half_open`. Treated as an open set. */
  state: string;
  failure_count?: number;
  success_count?: number;
}

/** One `health_check.unhealthy_targets[]` entry from `GET /admin/metrics`. */
export interface EdgeUnhealthyTarget {
  namespace?: string;
  /** Set for passive (traffic-based) ejections on a direct-backend proxy. */
  proxy_id?: string;
  /** Set for active health-check failures against an upstream's target. */
  upstream_id?: string;
  /** `host:port` of the failing target. */
  target?: string;
  /** `active` | `passive`. */
  type?: string;
  /** Unix epoch milliseconds since which the target has been unhealthy. */
  since_epoch_ms?: number;
}

/** What one `GET /admin/metrics` read yielded for a single proxy. */
export interface EdgeBackendState {
  /** `false` when the gateway was unreachable or answered unusably. */
  available: boolean;
  /** Breakers scoped to this proxy, per-proxy and per-target alike. */
  breakers: EdgeCircuitBreaker[];
  /** Unhealthy targets attributed to this proxy. */
  unhealthyTargets: EdgeUnhealthyTarget[];
  /** `gateway.uptime_seconds`, or `null` when absent. */
  uptimeSeconds: number | null;
}
