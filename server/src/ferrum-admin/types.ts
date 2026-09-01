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

import type { AuthPluginType, EdgeCredentialType } from '@ferrum-nexus/shared';

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
 * Body for `POST /proxies` / `PUT /proxies/{id}`.
 *
 * Only the HTTP-family fields Nexus actually sets. `namespace`, `created_at`
 * and `updated_at` are server-owned and must not be sent.
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
}

/** Any plugin config body Nexus writes. */
export type EdgePluginSettings =
  | EdgeKeyAuthConfig
  | EdgeBasicAuthConfig
  | EdgeJwtAuthConfig
  | EdgeAccessControlConfig
  | EdgeRateLimitingConfig
  | Record<string, unknown>;

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
  reachable: boolean;
  /** Round-trip time of the probe in milliseconds. */
  latencyMs: number;
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
