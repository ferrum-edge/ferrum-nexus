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
 * - `listen_path` uniqueness per namespace, checked on `POST /proxies`,
 *   `PUT /proxies/{id}` and both `/api-specs` writes — and **excluding the
 *   proxy being written**, which is what lets a whole-resource replace *move* a
 *   proxy from one path to another. Real Edge does the same, at admission
 *   (`check_listen_path_unique(…, existing_proxy_id)`) and again inside the
 *   write transaction (`ensure_proxy_route_unique_tx`, `AND id != ?`). That is
 *   the write the staged publish depends on: a proxy is built on
 *   `/<ns>/.staging/<hex>` and cut over to its real path once every plugin is
 *   associated.
 * - API specs: `POST`/`PUT /api-specs` create the proxy from `x-ferrum-proxy`,
 *   stamp `api_spec_id` on it, and generate an associated `openapi_validator`
 *   whose operation table is built from the document's paths prefixed by the
 *   `servers[]` pathnames — plus the admission rule that makes issue #49 fail
 *   here as loudly as it does on a real gateway: a hand-built
 *   `openapi_validator` on a proxy with no attached spec is a `400`.
 *
 *   Faithful about the **operation table**, which is what `routes` enforcement
 *   is. Real Edge additionally materializes request/response schemas into each
 *   generated operation (`responses: { "200": {…} }` and friends) after
 *   resolving `$ref`s; reproducing that here would be reimplementing the
 *   gateway's extractor, so generated operations carry only `method`,
 *   `path_template` and `path_regex`.
 *
 * Every request is recorded in {@link MockFerrumEdge.requests} for assertions.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
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

/** An API spec as the mock stores it. */
export interface StoredApiSpec {
  id: string;
  namespace: string;
  /** The proxy this spec owns; unique per namespace. */
  proxy_id: string;
  /** The submitted document, verbatim. */
  document: Record<string, unknown>;
  spec_version: string;
  content_hash: string;
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

/** A queued synthetic delay, consumed by the next matching request. */
interface QueuedDelay {
  /** Only delay requests whose path contains this substring. */
  pathContains: string;
  /** Milliseconds to hold the request before handling it. */
  ms: number;
  /** Only delay requests using this method. */
  method?: string;
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
  /**
   * Matching requests to let through before failing one.
   *
   * Needed where one operation makes the *same* call twice and only the second
   * is under test: the enforcement conversion associates the restored plugins
   * with a `PUT /proxies/{id}` and then cuts the proxy over with another.
   */
  skip: number;
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
   * operation, `method`. `skip` lets that many matching requests through first,
   * for an operation that makes the same call twice.
   */
  queueFailure(
    status: number,
    body?: unknown,
    pathContains?: string,
    method?: string,
    skip?: number,
  ): void;
  /**
   * Hold the next request whose path contains `pathContains` for `ms` *before*
   * it is handled, then forget the entry.
   *
   * The barrier the two-instance race tests need. Note the "before it is
   * handled": a held request has not touched the stored resource yet, so
   * delaying a `PUT` is what opens a lost-update window — another writer can
   * read the pre-`PUT` state and write over it, and the held `PUT` then lands
   * on top of that. Delaying a `GET` does *not* make it read stale data; it
   * reads whatever is current when the delay ends.
   *
   * Applied after authentication and after the request is recorded, so a held
   * request still shows up in `requests` at the moment it arrived.
   */
  delay(pathContains: string, ms: number, method?: string): void;
  /** Direct access to stored consumers, keyed `<namespace>/<id>`. */
  readonly consumers: Map<string, StoredConsumer>;
  /** Direct access to stored proxies, keyed `<namespace>/<id>`. */
  readonly proxies: Map<string, Record<string, unknown>>;
  /** Direct access to stored plugin configs, keyed `<namespace>/<id>`. */
  readonly pluginConfigs: Map<string, Record<string, unknown>>;
  /** Direct access to stored API specs, keyed `<namespace>/<id>`. */
  readonly apiSpecs: Map<string, StoredApiSpec>;
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
   * The proxy currently answering on `listenPath`, or `undefined`.
   *
   * This is the "would a client reach anything here?" question, and it is what
   * the staged-cutover tests assert: while a publish is in flight the real
   * `/<namespace>/<slug>` must be served by nothing at all, and after a failed
   * one it must stay that way.
   */
  proxyServing(listenPath: string, namespace?: string): Record<string, unknown> | undefined;
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
  /**
   * The spec that owns a proxy, or `undefined`.
   *
   * `spec.document` is the exact body Nexus submitted, so a test can assert the
   * `servers` rewrite and the `x-ferrum-*` extensions character for character.
   */
  apiSpecForProxy(proxyId: string, namespace?: string): StoredApiSpec | undefined;
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
  // ── The provider plugin palette (`shared/src/plugins.ts`) ──────────────
  // Key sets taken from Ferrum Edge's `openapi.yaml`; every one of these
  // schemas is `additionalProperties: false`, so a typo'd field is a 400 on a
  // real gateway and must be one here too.
  security_headers: [
    'content_type_options',
    'frame_options',
    'referrer_policy',
    'hsts',
    'content_security_policy',
    'permissions_policy',
    'set',
    'remove',
    'override_existing',
  ],
  request_size_limiting: ['max_bytes'],
  response_size_limiting: ['max_bytes', 'require_buffered_check'],
  ip_restriction: ['allow', 'deny', 'mode'],
  bot_detection: [
    'blocked_patterns',
    'allow_list',
    'allow_missing_user_agent',
    'custom_response_code',
  ],
  correlation_id: ['header_name', 'echo_downstream'],
  compression: [
    'algorithms',
    'min_content_length',
    'content_types',
    'max_decompressed_request_size',
    'remove_accept_encoding',
    'gzip_level',
    'brotli_quality',
    'decompress_request',
  ],
  response_caching: [
    'ttl_seconds',
    'max_entries',
    'max_entry_size_bytes',
    'max_total_size_bytes',
    'cacheable_methods',
    'cacheable_status_codes',
    'respect_cache_control',
    'respect_no_cache',
    'vary_by_headers',
    'cache_key_include_query',
    'cache_key_include_consumer',
    'anonymous_caller_scope',
    'add_cache_status_header',
    'invalidate_on_unsafe_methods',
  ],
  request_deduplication: [
    'header_name',
    'ttl_seconds',
    'inflight_ttl_seconds',
    'max_entries',
    'max_entry_size_bytes',
    'max_total_size_bytes',
    'applicable_methods',
    'scope_by_consumer',
    'anonymous_caller_scope',
    'enforce_required',
    'sync_mode',
    'redis_url',
    'redis_tls',
    'redis_key_prefix',
    'redis_pool_size',
    'redis_connect_timeout_seconds',
    'redis_health_check_interval_seconds',
    'redis_username',
    'redis_password',
    'on_redis_unavailable',
  ],
  request_termination: ['status_code', 'content_type', 'body', 'message', 'trigger'],
  openapi_validator: [
    'enforcement_mode',
    'validate_request',
    'validate_response',
    'fail_on_unknown_operation',
    'fail_on_missing_response_schema',
    'max_body_bytes',
    'request_content_types',
    'response_content_types',
    'schema_draft',
    'operations',
    'bypass',
    'error_response',
    'error_truncate_chars',
  ],
};

/**
 * Fixed fields of an `openapi_validator` operation entry. Edge closes this
 * object too, so a `path_template` typed `pathTemplate` is a 400 and not a
 * silently ignored key.
 */
const OPENAPI_OPERATION_KEYS = new Set([
  'method',
  'path_template',
  'path_regex',
  'operation_label',
  'request_required',
  'request_body',
  'responses',
]);

/** `openapi_validator.bypass` is a closed key set as well. */
const OPENAPI_BYPASS_KEYS = new Set(['paths', 'methods', 'consumers', 'header_present']);

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

/* ── API specs ──────────────────────────────────────────────────────────── */

/**
 * The closed key set of the `x-ferrum-validate` object form
 * (`docs/api_specs.md`). `operations` is deliberately *not* in it: it is always
 * regenerated from the document, and Edge rejects a document that tries to
 * supply one — which is exactly the mistake issue #49 was built on.
 */
const FERRUM_VALIDATE_KEYS = new Set([
  'mode',
  'request',
  'response',
  'validate_request',
  'validate_response',
  'bypass',
  'fail_on_unknown_operation',
  'fail_on_missing_response_schema',
  'max_body_bytes',
  'error_response',
  'error_truncate_chars',
]);

/** The OpenAPI HTTP-method keys the importer enumerates on a path item. */
const OPENAPI_METHOD_KEYS = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
] as const;

/**
 * Escape a literal the way Rust's `regex::escape` does — the crate's meta
 * characters, which include the reserved-but-inert `#`, `&`, `-` and `~`. `/`
 * is not one of them. Edge's own extractor (`path_template_to_regex` in
 * `admin/api_specs/extractor.rs`) calls the same function.
 */
function escapeRegex(literal: string): string {
  return literal.replace(/[\\.+*?()|[\]{}^$#&\-~]/g, '\\$&');
}

/** A path template as a regex body, with `{param}` widened to `[^/]+`. */
function pathTemplateRegex(template: string): string {
  return template
    .split(/(\{[^{}/]+\})/)
    .map((part) => (/^\{[^{}/]+\}$/.test(part) ? '[^/]+' : escapeRegex(part)))
    .join('');
}

/**
 * The effective path prefixes contributed by `servers[]`.
 *
 * Only the *pathname* of each server URL counts — scheme, authority, query and
 * fragment are dropped — and distinct pathnames each emit their own matcher, in
 * document order. No `servers` at all leaves the Paths keys unprefixed, which
 * is the trap Nexus avoids by rewriting `servers` to the listen path: a
 * document left with its upstream there generates `^/invoices$` and nothing
 * arriving at `/nexus/<slug>/invoices` can ever match it.
 */
function serverBases(servers: unknown): string[] {
  if (!Array.isArray(servers) || servers.length === 0) return [''];
  const bases: string[] = [];
  for (const entry of servers) {
    if (!isRecord(entry) || typeof entry.url !== 'string') continue;
    const { pathname } = new URL(entry.url, 'http://spec.invalid');
    const base = pathname === '/' ? '' : pathname.replace(/\/$/, '');
    if (!bases.includes(base)) bases.push(base);
  }
  return bases.length === 0 ? [''] : bases;
}

/** The operation table Edge's importer generates from a document. */
function generateOperations(document: Record<string, unknown>): Record<string, unknown>[] {
  const paths = isRecord(document.paths) ? document.paths : {};
  const bases = serverBases(document.servers);
  const operations: Record<string, unknown>[] = [];
  for (const [template, item] of Object.entries(paths)) {
    if (!isRecord(item)) continue;
    for (const method of OPENAPI_METHOD_KEYS) {
      if (item[method] === undefined) continue;
      for (const base of bases) {
        operations.push({
          method: method.toUpperCase(),
          path_template: `${base}${template}`,
          path_regex: `^${escapeRegex(base)}${pathTemplateRegex(template)}$`,
        });
      }
    }
  }
  return operations;
}

/**
 * The `openapi_validator` config Edge generates for `x-ferrum-validate`.
 *
 * The object form's `mode` / `request.enabled` / `response.enabled` are
 * projected onto the plugin's own `enforcement_mode` / `validate_request` /
 * `validate_response` keys, which is the rename a caller has to get right.
 */
function generateValidatorConfig(
  document: Record<string, unknown>,
  validate: Record<string, unknown>,
): Record<string, unknown> {
  const request = isRecord(validate.request) ? validate.request : {};
  const response = isRecord(validate.response) ? validate.response : {};
  return {
    enforcement_mode: validate.mode ?? 'block',
    validate_request: validate.validate_request ?? request.enabled ?? true,
    validate_response: validate.validate_response ?? response.enabled ?? true,
    fail_on_unknown_operation: validate.fail_on_unknown_operation ?? true,
    ...(validate.bypass === undefined ? {} : { bypass: validate.bypass }),
    operations: generateOperations(document),
  };
}

/** `Proxy.allowed_methods` entries, from the openapi enum. */
const PROXY_HTTP_METHODS = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
  'TRACE',
  'CONNECT',
]);

/**
 * Validate the proxy fields Nexus now writes beyond the backend/listen set,
 * the way Edge's `Proxy` deserializer does. Returns an error message, or
 * `null` when the body is acceptable.
 *
 * Only the checks a Nexus bug could actually trip are modelled: a method
 * outside the enum, a circuit breaker that is not an object, and a WS origin
 * list that is not an array of strings. Each is a `400` on a real gateway, so
 * a permissive fake would let a broken publish look healthy.
 */
function validateProxySettings(body: Record<string, unknown>): string | null {
  const methods = body.allowed_methods;
  if (methods !== undefined && methods !== null) {
    if (!Array.isArray(methods)) return 'allowed_methods must be an array of HTTP methods or null';
    // Edge's rule (`src/config/types.rs`): `null` means allow all, and the only
    // other legal value is a non-empty list — `[]` is not a deny-all, it is a 400.
    if (methods.length === 0) {
      return 'allowed_methods must be null (allow all) or a non-empty array';
    }
    for (const method of methods) {
      if (typeof method !== 'string' || !PROXY_HTTP_METHODS.has(method)) {
        return `allowed_methods: unknown HTTP method '${String(method)}'`;
      }
    }
  }

  const breaker = body.circuit_breaker;
  if (breaker !== undefined && breaker !== null && !isRecord(breaker)) {
    return 'circuit_breaker must be an object or null';
  }

  const origins = body.allowed_ws_origins;
  if (origins !== undefined) {
    if (!Array.isArray(origins) || origins.some((origin) => typeof origin !== 'string')) {
      return 'allowed_ws_origins must be an array of strings';
    }
  }

  return null;
}

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

  if (pluginName === 'openapi_validator') {
    const problem = openapiValidatorError(config);
    if (problem) return problem;
  }

  return palettePluginError(pluginName, config);
}

/** Redis-only `request_deduplication` keys, rejected outside `sync_mode: redis`. */
const DEDUP_REDIS_KEYS = [
  'redis_url',
  'redis_tls',
  'redis_key_prefix',
  'redis_pool_size',
  'redis_connect_timeout_seconds',
  'redis_health_check_interval_seconds',
  'redis_username',
  'redis_password',
  'on_redis_unavailable',
];

/**
 * Admission rules the palette plugins carry **beyond** their closed key sets.
 *
 * Same principle as {@link openapiValidatorError}: only the checks Nexus can
 * actually trip are modelled. The interesting failure is a config Nexus writes,
 * a permissive fake accepts, and a real gateway refuses — so every rule here
 * mirrors one documented in Edge's `openapi.yaml`.
 */
function palettePluginError(pluginName: string, config: Record<string, unknown>): string | null {
  const positiveInt = (value: unknown): boolean =>
    typeof value === 'number' && Number.isInteger(value) && value > 0;

  switch (pluginName) {
    case 'request_size_limiting':
    case 'response_size_limiting':
      // Required and must be greater than zero — Edge rejects plugin creation
      // when it is missing or 0.
      if (!positiveInt(config.max_bytes)) {
        return `${pluginName}: 'max_bytes' is required and must be an integer greater than zero`;
      }
      return null;

    case 'ip_restriction': {
      // `anyOf: [{required:[allow], allow.minItems:1}, {required:[deny], …}]`
      const allow = Array.isArray(config.allow) ? config.allow : [];
      const deny = Array.isArray(config.deny) ? config.deny : [];
      if (allow.length === 0 && deny.length === 0) {
        return "ip_restriction: at least one of 'allow' or 'deny' must be non-empty";
      }
      if (
        config.mode !== undefined &&
        !['allow_first', 'deny_first'].includes(String(config.mode))
      ) {
        return `ip_restriction: unsupported mode '${String(config.mode)}'`;
      }
      return null;
    }

    case 'bot_detection': {
      const blocked = config.blocked_patterns;
      if (
        Array.isArray(blocked) &&
        blocked.length === 0 &&
        config.allow_missing_user_agent !== false
      ) {
        return "bot_detection: an empty 'blocked_patterns' is only valid with 'allow_missing_user_agent: false'";
      }
      const code = config.custom_response_code;
      if (
        code !== undefined &&
        code !== null &&
        (typeof code !== 'number' || !Number.isInteger(code) || code < 400 || code > 599)
      ) {
        return "bot_detection: 'custom_response_code' must be an integer between 400 and 599";
      }
      return null;
    }

    case 'compression': {
      const algorithms = config.algorithms;
      if (algorithms === undefined) return null;
      if (!Array.isArray(algorithms)) return "compression: 'algorithms' must be an array";
      for (const algorithm of algorithms) {
        if (!['gzip', 'br', 'brotli'].includes(String(algorithm))) {
          return `compression: unsupported algorithm '${String(algorithm)}'`;
        }
      }
      return null;
    }

    case 'response_caching': {
      const methods = config.cacheable_methods;
      if (methods !== undefined) {
        if (!Array.isArray(methods) || methods.length === 0) {
          return "response_caching: 'cacheable_methods' must contain at least one entry";
        }
        for (const method of methods) {
          // Only bodyless retrieval methods: cache lookup runs before the
          // request body is final, so a body-bearing method cannot be keyed.
          if (!['GET', 'HEAD'].includes(String(method))) {
            return `response_caching: '${String(method)}' is not a cacheable method`;
          }
        }
      }
      const statuses = config.cacheable_status_codes;
      if (statuses !== undefined) {
        if (!Array.isArray(statuses) || statuses.length === 0) {
          return "response_caching: 'cacheable_status_codes' must contain at least one entry";
        }
        for (const status of statuses) {
          if (
            typeof status !== 'number' ||
            !Number.isInteger(status) ||
            status < 200 ||
            status > 599 ||
            status === 206 ||
            status === 304
          ) {
            return `response_caching: '${String(status)}' is not a storable status`;
          }
        }
      }
      return null;
    }

    case 'request_deduplication': {
      if (
        config.sync_mode !== undefined &&
        !['local', 'redis'].includes(String(config.sync_mode))
      ) {
        return `request_deduplication: unsupported sync_mode '${String(config.sync_mode)}'`;
      }
      const redisMode = config.sync_mode === 'redis';
      if (redisMode && typeof config.redis_url !== 'string') {
        return "request_deduplication: 'redis_url' is required when sync_mode is 'redis'";
      }
      if (!redisMode) {
        for (const field of DEDUP_REDIS_KEYS) {
          if (config[field] !== undefined) {
            return `request_deduplication: '${field}' is only valid when sync_mode is 'redis'`;
          }
        }
      }
      const methods = config.applicable_methods;
      if (methods !== undefined && (!Array.isArray(methods) || methods.length === 0)) {
        return "request_deduplication: 'applicable_methods' must contain at least one entry";
      }
      return null;
    }

    case 'request_termination': {
      const status = config.status_code;
      if (
        status !== undefined &&
        (typeof status !== 'number' || !Number.isInteger(status) || status < 200 || status > 599)
      ) {
        return "request_termination: 'status_code' must be an integer between 200 and 599";
      }
      return null;
    }

    default:
      return null;
  }
}

/**
 * Plugins whose per-instance execution `trigger` Edge **refuses**, with the
 * reason it gives.
 *
 * A trigger can only gate a plugin whose whole effect flows through its own
 * per-request hooks. `security_headers` re-asserts initial response headers
 * from paths that hold no request context; the two size limits publish a fixed
 * per-proxy body ceiling the proxy core enforces outside the hook chain; and
 * `compression` and `correlation_id` publish contextless response-trailer
 * ownership into the per-generation policy. Gating any of them would leave the
 * instance half-applied, so Edge rejects the config rather than accept an
 * ambiguous one.
 *
 * `response_caching` is refused too while `add_cache_status_header` is at its
 * `true` default; the palette never offers a trigger on it, so the mock does
 * not model the conditional half of that rule.
 *
 * @see Edge `docs/plugin_execution_order.md` §"Phases outside the trigger boundary"
 */
const PLUGIN_TRIGGER_REFUSED: Readonly<Record<string, string>> = {
  security_headers:
    'the plugin owns the initial response-header policy, which is re-asserted without a request context',
  request_size_limiting:
    'the plugin publishes a fixed per-proxy request-body ceiling that the proxy core enforces before a per-request trigger can be evaluated',
  response_size_limiting:
    'the plugin publishes a fixed per-proxy response-body ceiling that the proxy core enforces outside the per-request plugin hook chain',
  compression:
    'the plugin publishes contextless response-trailer ownership into the per-generation policy',
  correlation_id:
    'the plugin publishes contextless response-trailer ownership into the per-generation policy',
};

/** The four branches one `PluginTriggerNode` may set — exactly one of them. */
const TRIGGER_NODE_BRANCHES = ['all', 'any', 'not', 'match'];

/** The leaf predicates `PluginTriggerMatch` accepts — exactly one per leaf. */
const TRIGGER_MATCH_PREDICATES = [
  'method',
  'path',
  'host',
  'sni',
  'header',
  'query',
  'cookie',
  'protocol',
  'source_cidr',
  'namespace',
  'proxy_id',
  'listen_port',
  'consumer',
  'auth_method',
  'spiffe_id',
];

/**
 * Validate a plugin config's `trigger` the way Edge's `PluginTrigger`
 * deserializer plus its admission checks do. Returns an error message, or
 * `null` when the trigger is acceptable.
 *
 * A permissive fake would be actively misleading here: a trigger Edge refuses
 * is a `400` that leaves the plugin unattached, and a malformed predicate tree
 * is the difference between "runs on POST /orders" and "runs on everything".
 */
function validatePluginTrigger(pluginName: string, trigger: unknown): string | null {
  if (trigger === undefined || trigger === null) return null;

  const refusal = PLUGIN_TRIGGER_REFUSED[pluginName];
  if (refusal !== undefined) {
    return `${pluginName}: a trigger is not supported — ${refusal}`;
  }
  if (!isRecord(trigger)) return 'trigger must be a JSON object';
  for (const field of Object.keys(trigger)) {
    if (field !== 'when') return `trigger: unknown field '${field}'`;
  }
  if (trigger.when === undefined) return "trigger: 'when' is required";
  return triggerNodeError(trigger.when, 'trigger.when');
}

/** One node of the predicate tree; recursive for `all`/`any`/`not`. */
function triggerNodeError(node: unknown, path: string): string | null {
  if (!isRecord(node)) return `${path} must be a JSON object`;
  const keys = Object.keys(node);
  for (const key of keys) {
    if (!TRIGGER_NODE_BRANCHES.includes(key)) return `${path}: unknown field '${key}'`;
  }
  // A node with zero or several branches has no defined truth value.
  if (keys.length !== 1) return `${path} must set exactly one of all, any, not or match`;

  const branch = keys[0];
  if (branch === 'not') return triggerNodeError(node.not, `${path}.not`);
  if (branch === 'all' || branch === 'any') {
    const children = node[branch];
    if (!Array.isArray(children) || children.length === 0) {
      return `${path}.${branch} must be a non-empty array`;
    }
    for (const [index, child] of children.entries()) {
      const problem = triggerNodeError(child, `${path}.${branch}[${index}]`);
      if (problem) return problem;
    }
    return null;
  }

  const leaf = node.match;
  if (!isRecord(leaf)) return `${path}.match must be a JSON object`;
  const predicates = Object.keys(leaf);
  for (const predicate of predicates) {
    if (!TRIGGER_MATCH_PREDICATES.includes(predicate)) {
      return `${path}.match: unknown predicate '${predicate}'`;
    }
  }
  if (predicates.length !== 1) return `${path}.match must set exactly one predicate`;

  if (leaf.method !== undefined && (!Array.isArray(leaf.method) || leaf.method.length === 0)) {
    return `${path}.match.method must be a non-empty array`;
  }
  if (leaf.path !== undefined) {
    if (!isRecord(leaf.path)) return `${path}.match.path must be a JSON object`;
    const forms = Object.keys(leaf.path).filter((key) => key !== 'case_insensitive');
    if (forms.length !== 1 || !['exact', 'prefix', 'regex'].includes(String(forms[0]))) {
      return `${path}.match.path must set exactly one of exact, prefix or regex`;
    }
  }
  return null;
}

/**
 * Edge's admission checks for `openapi_validator`, reduced to what Nexus can
 * actually get wrong.
 *
 * The plugin is registered `FailClosed`, so a rejected config never becomes
 * the running policy — a direct Admin write is a 400. That makes a permissive
 * fake actively misleading: the interesting failure is a config Nexus writes,
 * the mock accepts, and the real gateway would refuse. So the three things
 * that decide whether the generated body is admissible are checked here — the
 * closed key sets, the required non-empty `operations` array with its three
 * mandatory string fields, and a `path_regex` that compiles.
 *
 * The schema-bearing parts (`request_body`, `responses`, media maps, draft
 * selection) are not modelled: Nexus never generates them.
 */
function openapiValidatorError(config: Record<string, unknown>): string | null {
  const operations = config.operations;
  if (!Array.isArray(operations)) {
    return "openapi_validator: 'operations' is required and must be an array";
  }
  if (operations.length === 0) return "openapi_validator: 'operations' must not be empty";

  for (const [index, operation] of operations.entries()) {
    if (!isRecord(operation)) {
      return `openapi_validator: operations[${index}] must be an object`;
    }
    for (const field of Object.keys(operation)) {
      if (!OPENAPI_OPERATION_KEYS.has(field)) {
        return `openapi_validator: operations[${index}] unknown field '${field}'`;
      }
    }
    for (const field of ['method', 'path_template', 'path_regex']) {
      const value = operation[field];
      if (typeof value !== 'string' || value === '') {
        return `openapi_validator: operations[${index}].${field} is required and must be a non-empty string`;
      }
    }
    try {
      // Edge anchors the operator's pattern into `^(?:…)$` before compiling it,
      // so an already-anchored regex is double-anchored and must still compile.
      new RegExp(`^(?:${String(operation.path_regex)})$`);
    } catch {
      return `openapi_validator: operations[${index}].path_regex is invalid`;
    }
  }

  const bypass = config.bypass;
  if (bypass !== undefined) {
    if (!isRecord(bypass)) return "openapi_validator: 'bypass' must be an object";
    for (const field of Object.keys(bypass)) {
      if (!OPENAPI_BYPASS_KEYS.has(field)) {
        return `openapi_validator: bypass unknown field '${field}'`;
      }
    }
    if (bypass.methods !== undefined && !Array.isArray(bypass.methods)) {
      return "openapi_validator: 'bypass.methods' must be an array of strings";
    }
  }

  // A config with no schemas and no unknown-operation check enforces nothing at
  // all, which Edge refuses rather than accepting as a no-op policy.
  if (config.fail_on_unknown_operation === false) {
    return 'openapi_validator: no validation rules configured -- provide request or response schemas';
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
  const apiSpecs = new Map<string, StoredApiSpec>();
  const namespaces = new Map<string, { name: string; description: string | null }>();
  const requests: RecordedRequest[] = [];
  const failures: QueuedFailure[] = [];
  const delays: QueuedDelay[] = [];

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

  /**
   * Whether another proxy in `namespace` already serves `listenPath`.
   *
   * `exceptProxyId` is the proxy a `PUT` is replacing (or re-inserting from a
   * spec): a whole-resource write must not conflict with the row it is
   * overwriting, which is what makes the staged cutover onto the real listen
   * path — and every ordinary settings `PUT` — legal.
   */
  function listenPathTaken(
    namespace: string,
    listenPath: unknown,
    exceptProxyId?: string,
  ): boolean {
    return [...proxies.values()].some(
      (proxy) =>
        proxy.namespace === namespace &&
        proxy.listen_path === listenPath &&
        String(proxy.id) !== exceptProxyId,
    );
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
        const settingsProblem = validateProxySettings(body);
        if (settingsProblem) return fail(res, 400, settingsProblem);
        if (listenPathTaken(namespace, body.listen_path)) {
          return fail(res, 409, 'listen_path already exists in this namespace');
        }
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
      const settingsProblem = validateProxySettings(body);
      if (settingsProblem) return fail(res, 400, settingsProblem);
      // A whole-resource replace may move the proxy — that is how the staged
      // publish cuts a finished proxy over from its `.staging/…` path onto the
      // real one. The uniqueness check therefore excludes the proxy being
      // replaced, or every no-op `PUT` would collide with itself.
      if (listenPathTaken(namespace, body.listen_path, id)) {
        return fail(res, 409, 'listen_path already exists in this namespace');
      }
      const updated = {
        ...body,
        id,
        namespace,
        // Server-owned like the timestamps: only the spec importer sets or
        // clears the ownership tag, so a replace can neither adopt a proxy into
        // a spec nor orphan one out of it.
        ...(existing.api_spec_id == null ? {} : { api_spec_id: existing.api_spec_id }),
        created_at: existing.created_at,
        updated_at: nowIso(),
      };
      proxies.set(key(namespace, id), updated);
      return send(res, 200, updated);
    }
    if (method === 'DELETE') {
      if (!existing) return fail(res, 404, 'Proxy not found');
      // Cascades the plugin configs *and* the spec that owns the proxy, which
      // is what makes deleting the proxy a complete rollback for a `routes`
      // publish.
      deleteProxyCascade(namespace, id);
      return send(res, 204);
    }
    return fail(res, 405, 'Method not allowed');
  }

  /* ── API specs ──────────────────────────────────────────────────────────
   * A spec owns exactly one proxy and every resource it generated. Both
   * cascades are real: deleting the spec deletes the proxy, and deleting the
   * proxy deletes the spec.
   */

  /** The spec that owns `proxyId`, or `undefined`. */
  function specForProxy(namespace: string, proxyId: string): StoredApiSpec | undefined {
    return [...apiSpecs.values()].find(
      (spec) => spec.namespace === namespace && spec.proxy_id === proxyId,
    );
  }

  /** Whether `proxyId` carries an attached spec — the `openapi_validator` gate. */
  function proxyHasSpec(namespace: string, proxyId: string): boolean {
    return proxies.get(key(namespace, proxyId))?.api_spec_id != null;
  }

  /** Every plugin config the spec generated, by its ownership tag. */
  function specOwnedConfigs(namespace: string, specId: string): Record<string, unknown>[] {
    return [...pluginConfigs.values()].filter(
      (config) => config.namespace === namespace && config.api_spec_id === specId,
    );
  }

  /** Add ids to a proxy's association list, skipping ones already there. */
  function associateOnProxy(proxy: Record<string, unknown>, ids: string[]): void {
    const current = (Array.isArray(proxy.plugins) ? proxy.plugins : []).filter(isRecord);
    const present = new Set(current.map((entry) => String(entry.plugin_config_id)));
    proxy.plugins = [
      ...current,
      ...ids.filter((id) => !present.has(id)).map((id) => ({ plugin_config_id: id })),
    ];
  }

  /**
   * The structural checks `POST` and `PUT /api-specs` share, returning the
   * `x-ferrum-proxy` body once the document passes.
   */
  function apiSpecProblem(
    body: unknown,
  ): { error: string; status: number } | { proxy: Record<string, unknown> } {
    if (!isRecord(body)) return { error: 'Request body must be a JSON object', status: 400 };
    if (body['x-ferrum-consumers'] !== undefined) {
      return { error: 'x-ferrum-consumers is not allowed in spec documents', status: 400 };
    }
    const proxy = body['x-ferrum-proxy'];
    if (!isRecord(proxy)) {
      return { error: 'Spec document must contain an x-ferrum-proxy object', status: 400 };
    }
    if (proxy.api_spec_id !== undefined) {
      return { error: 'api_spec_id is server-managed and must be omitted', status: 422 };
    }
    for (const field of Object.keys(proxy)) {
      if (!PROXY_KEYS.has(field)) return { error: `unknown field: ${field}`, status: 400 };
    }
    const validate = body['x-ferrum-validate'];
    if (isRecord(validate)) {
      for (const field of Object.keys(validate)) {
        if (!FERRUM_VALIDATE_KEYS.has(field)) {
          return { error: `unknown x-ferrum-validate field: ${field}`, status: 400 };
        }
      }
    }
    const settingsProblem = validateProxySettings(proxy);
    if (settingsProblem) return { error: settingsProblem, status: 400 };
    return { proxy };
  }

  /**
   * Insert (or re-insert) the proxy a spec owns and regenerate its plugins.
   *
   * Hand-owned plugin configs and their associations are untouched by a
   * replace: the association list is rebuilt from the ones that survive, plus
   * the freshly generated validator.
   */
  function applySpecDocument(
    namespace: string,
    specId: string,
    proxyId: string,
    document: Record<string, unknown>,
    proxyBody: Record<string, unknown>,
    createdAt: string,
  ): void {
    const survivors = [...pluginConfigs.values()]
      .filter(
        (config) =>
          config.namespace === namespace &&
          config.proxy_id === proxyId &&
          config.api_spec_id !== specId,
      )
      .map((config) => String(config.id));
    for (const [configKey, config] of pluginConfigs) {
      if (config.namespace === namespace && config.api_spec_id === specId) {
        pluginConfigs.delete(configKey);
      }
    }

    const proxy: Record<string, unknown> = {
      ...proxyBody,
      id: proxyId,
      namespace,
      strip_listen_path: proxyBody.strip_listen_path ?? true,
      api_spec_id: specId,
      plugins: [],
      created_at: createdAt,
      updated_at: nowIso(),
    };
    proxies.set(key(namespace, proxyId), proxy);

    const generated: string[] = [];
    const validate = document['x-ferrum-validate'];
    if (validate === true || isRecord(validate)) {
      const config = {
        id: randomUUID(),
        plugin_name: 'openapi_validator',
        namespace,
        config: generateValidatorConfig(document, isRecord(validate) ? validate : {}),
        scope: 'proxy',
        proxy_id: proxyId,
        enabled: true,
        api_spec_id: specId,
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      pluginConfigs.set(key(namespace, config.id), config);
      generated.push(config.id);
    }
    associateOnProxy(proxy, [...generated, ...survivors]);
  }

  function handleApiSpecs(
    res: ServerResponse,
    method: string,
    segments: string[],
    namespace: string,
    body: unknown,
    query: URLSearchParams,
  ): void {
    const [, first, second] = segments;

    if (first === 'by-proxy') {
      if (second === undefined) return fail(res, 404, 'Not found');
      if (method !== 'GET') return fail(res, 405, 'Method not allowed');
      const spec = specForProxy(namespace, second);
      return spec ? send(res, 200, spec.document) : fail(res, 404, 'API spec not found');
    }

    if (first === undefined) {
      if (method === 'GET') {
        // `/api-specs` pages with its own flat envelope — `items` and the
        // counters beside it — rather than the `data` + `pagination` shape
        // every other list route uses.
        const proxyFilter = query.get('proxy_id');
        const items = [...apiSpecs.values()]
          .filter((spec) => spec.namespace === namespace)
          .filter((spec) => proxyFilter === null || spec.proxy_id === proxyFilter)
          .map((spec) => summariseSpec(spec));
        const limit = Number(query.get('limit') ?? 50) || 50;
        const offset = Number(query.get('offset') ?? 0) || 0;
        const page = items.slice(offset, offset + limit);
        return send(res, 200, {
          items: page,
          limit,
          offset,
          next_offset: offset + page.length < items.length ? offset + page.length : null,
          total: items.length,
        });
      }
      if (method !== 'POST') return fail(res, 405, 'Method not allowed');

      const checked = apiSpecProblem(body);
      if ('error' in checked) return fail(res, checked.status, checked.error);
      const document = body as Record<string, unknown>;
      const proxyBody = checked.proxy;

      if (typeof proxyBody.listen_path !== 'string' || !proxyBody.listen_path.startsWith('/')) {
        return fail(res, 400, "listen_path must start with '/', '~' (regex), or '=/' (exact)");
      }
      const proxyId =
        typeof proxyBody.id === 'string' && proxyBody.id !== '' ? proxyBody.id : randomUUID();
      if (proxies.has(key(namespace, proxyId))) {
        return fail(res, 409, `Proxy '${proxyId}' already exists in this namespace`);
      }
      if (listenPathTaken(namespace, proxyBody.listen_path)) {
        return fail(res, 409, 'listen_path already exists in this namespace');
      }
      if (specForProxy(namespace, proxyId)) {
        return fail(res, 409, `A spec already exists for proxy '${proxyId}'`);
      }

      const spec: StoredApiSpec = {
        id: randomUUID(),
        namespace,
        proxy_id: proxyId,
        document,
        spec_version: typeof document.openapi === 'string' ? document.openapi : '3.1.0',
        content_hash: createHash('sha256').update(JSON.stringify(document)).digest('hex'),
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      apiSpecs.set(key(namespace, spec.id), spec);
      applySpecDocument(namespace, spec.id, proxyId, document, proxyBody, spec.created_at);
      return send(res, 201, {
        id: spec.id,
        proxy_id: proxyId,
        spec_version: spec.spec_version,
        content_hash: spec.content_hash,
      });
    }

    const existing = apiSpecs.get(key(namespace, first));
    if (method === 'GET') {
      return existing ? send(res, 200, existing.document) : fail(res, 404, 'API spec not found');
    }
    if (method === 'PUT') {
      if (!existing) return fail(res, 404, 'API spec not found');
      const checked = apiSpecProblem(body);
      if ('error' in checked) return fail(res, checked.status, checked.error);
      const document = body as Record<string, unknown>;
      const proxyBody = checked.proxy;
      if (typeof proxyBody.id === 'string' && proxyBody.id !== existing.proxy_id) {
        return fail(res, 409, 'x-ferrum-proxy.id may not move an existing spec to another proxy');
      }
      if (typeof proxyBody.listen_path !== 'string' || !proxyBody.listen_path.startsWith('/')) {
        return fail(res, 400, "listen_path must start with '/', '~' (regex), or '=/' (exact)");
      }
      // The re-insert honours a *changed* `listen_path` — that is how a staged
      // spec-owned proxy is cut over onto the real path — so the uniqueness
      // check applies here too, excluding the proxy being re-inserted.
      if (listenPathTaken(namespace, proxyBody.listen_path, existing.proxy_id)) {
        return fail(res, 409, 'listen_path already exists in this namespace');
      }
      const proxy = proxies.get(key(namespace, existing.proxy_id));
      existing.document = document;
      existing.spec_version = typeof document.openapi === 'string' ? document.openapi : '3.1.0';
      existing.content_hash = createHash('sha256').update(JSON.stringify(document)).digest('hex');
      existing.updated_at = nowIso();
      // The proxy is **re-inserted** from the submitted `x-ferrum-proxy`, not
      // merged into: anything the body omits is gone.
      applySpecDocument(
        namespace,
        existing.id,
        existing.proxy_id,
        document,
        proxyBody,
        typeof proxy?.created_at === 'string' ? proxy.created_at : nowIso(),
      );
      return send(res, 200, {
        id: existing.id,
        proxy_id: existing.proxy_id,
        spec_version: existing.spec_version,
        content_hash: existing.content_hash,
      });
    }
    if (method === 'DELETE') {
      if (!existing) return fail(res, 404, 'API spec not found');
      apiSpecs.delete(key(namespace, first));
      deleteProxyCascade(namespace, existing.proxy_id);
      return send(res, 204);
    }
    return fail(res, 405, 'Method not allowed');
  }

  /** `GET /api-specs` metadata; the document itself is never in a list. */
  function summariseSpec(spec: StoredApiSpec): Record<string, unknown> {
    const info = isRecord(spec.document.info) ? spec.document.info : {};
    return {
      id: spec.id,
      proxy_id: spec.proxy_id,
      namespace: spec.namespace,
      spec_version: spec.spec_version,
      spec_format: 'json',
      title: typeof info.title === 'string' ? info.title : null,
      info_version: typeof info.version === 'string' ? info.version : null,
      operation_count: generateOperations(spec.document).length,
      content_hash: spec.content_hash,
      created_at: spec.created_at,
      updated_at: spec.updated_at,
    };
  }

  /**
   * Remove a proxy, every plugin config scoped to it, and the spec that owns
   * it. Both directions of the cascade land here so they cannot drift apart.
   */
  function deleteProxyCascade(namespace: string, proxyId: string): void {
    proxies.delete(key(namespace, proxyId));
    for (const [configKey, config] of pluginConfigs) {
      if (config.namespace === namespace && config.proxy_id === proxyId) {
        pluginConfigs.delete(configKey);
      }
    }
    for (const [specKey, spec] of apiSpecs) {
      if (spec.namespace === namespace && spec.proxy_id === proxyId) apiSpecs.delete(specKey);
    }
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
        // Edge's `validate_openapi_validator_precondition` (`admin/crud.rs`):
        // the validator's operation table is the gateway's to generate from an
        // imported document, so a hand-built one has nowhere to come from. This
        // is the rule the mock used to be missing — the reason a `routes` API
        // was green in CI and broken on every real gateway (issue #49).
        if (
          body.plugin_name === 'openapi_validator' &&
          !proxyHasSpec(namespace, String(body.proxy_id))
        ) {
          return fail(res, 400, 'openapi_validator requires a proxy with an attached api_spec');
        }
        // Edge constructs an `enabled: true` plugin strictly and rejects a bad
        // config with a 400 *before* storing it.
        if (body.enabled !== false) {
          const problem = validatePluginConfig(body.plugin_name, body.config);
          if (problem) return fail(res, 400, problem);
        }
        // The trigger is checked either way: it is a property of the config
        // resource rather than of the constructed plugin, and Edge refuses one
        // on a plugin that cannot be gated whatever `enabled` says.
        const triggerProblem = validatePluginTrigger(body.plugin_name, body.trigger);
        if (triggerProblem) return fail(res, 400, triggerProblem);
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
      // A replace is deserialized by the same `deny_unknown_fields` struct as a
      // create, so the closed field set applies here too.
      for (const field of Object.keys(body)) {
        if (!PLUGIN_CONFIG_KEYS.has(field)) return fail(res, 400, `unknown field: ${field}`);
      }
      const pluginName = String(body.plugin_name ?? existing.plugin_name);
      if (body.enabled !== false) {
        const problem = validatePluginConfig(pluginName, body.config);
        if (problem) return fail(res, 400, problem);
      }
      const triggerProblem = validatePluginTrigger(pluginName, body.trigger);
      if (triggerProblem) return fail(res, 400, triggerProblem);
      if (
        pluginName === 'openapi_validator' &&
        !proxyHasSpec(namespace, String(body.proxy_id ?? existing.proxy_id))
      ) {
        return fail(res, 400, 'openapi_validator requires a proxy with an attached api_spec');
      }
      const updated = {
        ...body,
        id,
        namespace,
        // Server-owned: a replace cannot claim or disclaim spec ownership.
        ...(existing.api_spec_id == null ? {} : { api_spec_id: existing.api_spec_id }),
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
      segments[0] === 'consumers' || segments[0] === 'proxies' || segments[0] === 'api-specs'
        ? namespace
        : segments[0] === 'plugins' && segments[1] === 'config'
          ? namespace
          : segments[0] === 'namespaces' && segments[1] !== undefined
            ? decodeURIComponent(segments[1])
            : null;
    if (scopedNamespace !== null && !claimAuthorizesNamespace(claims, scopedNamespace)) {
      return fail(res, 403, `Token is not authorized for namespace '${scopedNamespace}'`);
    }

    const held = delays.find(
      (entry) =>
        url.pathname.includes(entry.pathContains) &&
        (entry.method === undefined || entry.method === method),
    );
    if (held) {
      delays.splice(delays.indexOf(held), 1);
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, held.ms));
    }

    const failure = failures.find(
      (entry) =>
        (entry.pathContains === undefined || url.pathname.includes(entry.pathContains)) &&
        (entry.method === undefined || entry.method === method),
    );
    if (failure) {
      if (failure.skip > 0) {
        failure.skip -= 1;
      } else {
        failures.splice(failures.indexOf(failure), 1);
        return send(res, failure.status, failure.body ?? { error: 'Injected failure' });
      }
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
      case 'api-specs':
        return handleApiSpecs(res, method, segments, namespace, body, url.searchParams);
      case 'plugins':
        if (segments[1] === 'config') {
          return handlePluginConfigs(res, method, segments, namespace, body, url.searchParams);
        }
        if (method === 'GET') {
          // The plugins Nexus writes: the six first-class ones plus every
          // member of the provider palette. Real Edge lists ~75; anything not
          // here is one Nexus never names.
          return send(res, 200, [
            'key_auth',
            'basic_auth',
            'jwt_auth',
            'access_control',
            'cors',
            'rate_limiting',
            'openapi_validator',
            'security_headers',
            'request_size_limiting',
            'response_size_limiting',
            'ip_restriction',
            'bot_detection',
            'correlation_id',
            'compression',
            'response_caching',
            'request_deduplication',
            'request_termination',
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
    apiSpecs,

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
      apiSpecs.clear();
      namespaces.clear();
      requests.length = 0;
      failures.length = 0;
      delays.length = 0;
      requestCounters.clear();
      requestDurations.clear();
      backendStates.clear();
    },

    setHealth(payload: Record<string, unknown>): void {
      health = payload;
    },

    queueFailure(
      status: number,
      body?: unknown,
      pathContains?: string,
      method?: string,
      skip = 0,
    ): void {
      failures.push({
        status,
        body: body ?? { error: 'Injected failure' },
        skip,
        ...(pathContains === undefined ? {} : { pathContains }),
        ...(method === undefined ? {} : { method }),
      });
    },

    delay(pathContains: string, ms: number, method?: string): void {
      delays.push({ pathContains, ms, ...(method === undefined ? {} : { method }) });
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

    proxyServing(listenPath, namespace = 'nexus'): Record<string, unknown> | undefined {
      return [...proxies.values()].find(
        (proxy) => proxy.namespace === namespace && proxy.listen_path === listenPath,
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

    apiSpecForProxy(proxyId, namespace = 'nexus'): StoredApiSpec | undefined {
      return specForProxy(namespace, proxyId);
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
