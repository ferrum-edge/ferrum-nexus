/**
 * Ferrum Edge admission rules the mock gateway (`mock-ferrum-edge.ts`) copies.
 *
 * The mock spells these out itself rather than reading them from the code
 * under test, so it keeps modelling the gateway if Nexus's own copy drifts.
 * They are kept free of imports so the acceptance suite
 * (`e2e/src/dataplane.test.ts`) can load this file and compare each rule with
 * the real gateway: the pinned release in the required `acceptance` job, and
 * Edge `main` in the Edge Main Drift workflow. A rule Edge changes fails there
 * instead of leaving the mock accepting what Edge refuses, or the reverse.
 */

/**
 * Edge's `MAX_ACL_GROUPS_PER_CONSUMER`, written out rather than imported from
 * Nexus so the mock keeps modelling the gateway if Nexus's copy drifts.
 */
export const EDGE_MAX_ACL_GROUPS = 500;

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
export const PROXY_KEYS = new Set([
  'labels',
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
  // Edge v0.9.9: the WebSocket `permessage-deflate` mode and the `;` path
  // parameter opt-in. Both are read back on every proxy, so a read-modify-write
  // replace carries them.
  'websocket_permessage_deflate',
  'allow_path_parameters',
  'created_at',
  'updated_at',
]);

/**
 * Plugin configs the mock validates strictly, mirroring Edge's closed key
 * allowlists (Edge `docs/plugins.md`, one section per plugin). Anything not
 * listed here is stored without inspection, exactly as an unknown-to-Nexus
 * plugin would be.
 */
export const PLUGIN_CONFIG_ALLOWED_KEYS: Readonly<Record<string, readonly string[]>> = {
  // `schema` and `schema_ref` are in Edge's closed list too, but Edge refuses
  // either on this plugin; see PROMETHEUS_METRICS_UNSUPPORTED_KEYS.
  prometheus_metrics: [
    'cache_invalidation_min_age_ms',
    'mesh_series_budget_per_family',
    'render_cache_ttl_seconds',
    // Edge v0.9.19 adds configurable histogram buckets.
    'request_duration_buckets_ms',
    'session_duration_buckets_ms',
    'stale_entry_ttl_seconds',
  ],
  key_auth: ['key_location', 'hide_credentials'],
  // `basic_auth` accepts exactly one field: `hide_credentials`, which defaults
  // to `true`. `null` and `{}` are equally valid, and both mean that default.
  basic_auth: ['hide_credentials'],
  jwt_auth: [
    'token_lookup',
    'consumer_claim_field',
    'require_exp',
    'require_nbf',
    'expected_issuer',
    'expected_issuers',
    'audiences',
    'leeway_secs',
    // Edge v0.9.19 pins the HMAC algorithm and can strip the token before
    // forwarding (default `false`); Nexus sets neither.
    'algorithm',
    'hide_credentials',
  ],
  access_control: [
    'allowed_consumers',
    'disallowed_consumers',
    'allowed_groups',
    'disallowed_groups',
    'allow_authenticated_identity',
    // Edge v0.9.19 external-identity access rules; Nexus sets neither.
    'allowed_external_identities',
    'disallowed_external_identities',
  ],
  rate_limiting: [
    'mcp_tool_calls',
    'limit_by',
    // Edge v0.9.15: the IPv6 prefix that groups IP keys (default 64).
    'ipv6_prefix',
    'expose_headers',
    'limits',
    // Edge v0.9.19: the cap on tracked rate-limit keys.
    'max_state_entries',
    'sync_mode',
    'redis_url',
    'redis_tls',
    'redis_key_prefix',
    'redis_pool_size',
    'redis_failure_policy',
    'redis_connect_timeout_seconds',
    'redis_health_check_interval_seconds',
    'redis_username',
    'redis_password',
  ],
  mcp_gateway: [
    'enabled',
    'mode',
    'endpoint',
    'servers',
    'discovery',
    'sessions',
    'capabilities',
    'policy',
    'validation',
    'observability',
  ],
  ai_tool_governor: [
    'enabled',
    'mode',
    'default_action',
    'unknown_shape_action',
    'inspect',
    'tools',
    'approval',
    'response',
    'observability',
  ],
  ai_prompt_shield: [
    'action',
    'patterns',
    'custom_patterns',
    'scan_fields',
    'exclude_roles',
    'redaction_placeholder',
    'max_scan_bytes',
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
    // Edge v0.9.19: answer Private Network Access preflights.
    'allow_private_network',
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
  // Edge v0.9.21 refuses `ip_restriction.mode` and the two `response_caching`
  // cache-key switches as unknown keys (issue #727, ferrum-edge#7114); the
  // mock refuses them too, so no test can pass on a body Edge refuses.
  ip_restriction: ['allow', 'deny'],
  bot_detection: [
    'blocked_patterns',
    'allow_list',
    'allow_missing_user_agent',
    'custom_response_code',
  ],
  correlation_id: ['header_name', 'echo_downstream', 'inbound_policy'],
  compression: [
    'algorithms',
    'min_content_length',
    'content_types',
    'max_decompressed_request_size',
    'remove_accept_encoding',
    'gzip_level',
    'brotli_quality',
    'decompress_request',
    // Edge v0.9.19: opt-in zstd and strong-ETag weakening.
    'zstd_level',
    'weaken_strong_etag',
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
    'anonymous_caller_scope',
    'add_cache_status_header',
    'invalidate_on_unsafe_methods',
    'ignore_request_headers',
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
    // Edge v0.9.19: caller partitioning and the in-flight marker cap.
    'caller_partition',
    'max_inflight_entries',
  ],
  // Edge v0.9.19 adds canned-response `headers`.
  request_termination: ['status_code', 'content_type', 'body', 'message', 'trigger', 'headers'],
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
 * Every field Edge's `PluginConfig` deserializer accepts (openapi
 * `PluginConfig`); `deny_unknown_fields` makes anything else a 400.
 * `namespace`, `created_at` and `updated_at` are accepted but server-owned.
 */
export const PLUGIN_CONFIG_KEYS = new Set([
  'labels',
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

/**
 * Every field Edge's `Consumer` deserializer accepts (`deny_unknown_fields`).
 * `namespace`, `created_at` and `updated_at` are accepted but server-owned.
 */
export const CONSUMER_KEYS = new Set([
  'labels',
  'id',
  'username',
  'namespace',
  'custom_id',
  'credentials',
  'acl_groups',
  'created_at',
  'updated_at',
]);

/**
 * Keys Edge's `prometheus_metrics` closed list names but its constructor
 * refuses (transaction-log schema customization applies only to log-shipping
 * plugins), with Edge v0.9.21's refusal.
 */
export const PROMETHEUS_METRICS_UNSUPPORTED_KEYS = ['schema', 'schema_ref'] as const;
export const PROMETHEUS_METRICS_SCHEMA_UNSUPPORTED =
  'prometheus_metrics: `schema` / `schema_ref` is not supported ' +
  '(transaction-log schema customization applies only to log-shipping plugins; ' +
  'see docs/plugins.md)';

/** `Proxy.allowed_methods` entries, from the openapi enum. */
export const PROXY_HTTP_METHODS = new Set([
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
