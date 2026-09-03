/**
 * Cross-cutting constants and naming helpers shared by server and web.
 *
 * Everything here is pure and dependency-free: naming conventions for Ferrum
 * Edge objects, cookie/header names, and UI/pagination defaults.
 */

/* ── Ferrum Edge naming ─────────────────────────────────────────────────── */

/** Prefix of every ACL group Nexus manages on the gateway. */
export const ACL_GROUP_PREFIX = 'nexus:api:';

/** Suffix of an "approved access" ACL group. */
export const ACL_GROUP_APPROVED_SUFFIX = ':approved';

/**
 * ACL group added to a consumer when access to an API is approved.
 *
 * @example aclGroupForApi('a1b2') // 'nexus:api:a1b2:approved'
 */
export function aclGroupForApi(apiId: string): string {
  return `${ACL_GROUP_PREFIX}${apiId}${ACL_GROUP_APPROVED_SUFFIX}`;
}

/**
 * Extract the API id from an ACL group produced by {@link aclGroupForApi},
 * or `null` when the string is not a Nexus-managed group.
 */
export function apiIdFromAclGroup(group: string): string | null {
  if (!group.startsWith(ACL_GROUP_PREFIX) || !group.endsWith(ACL_GROUP_APPROVED_SUFFIX)) {
    return null;
  }
  const id = group.slice(ACL_GROUP_PREFIX.length, group.length - ACL_GROUP_APPROVED_SUFFIX.length);
  return id.length > 0 ? id : null;
}

/** Prefix of the Edge consumer username owned by a Nexus user account. */
export const CONSUMER_USERNAME_PREFIX = 'nexus-user-';

/** Prefix of the Edge consumer username used for a provider's test consumer. */
export const TEST_CONSUMER_USERNAME_PREFIX = 'nexus-test-';

/**
 * Username of the single Ferrum consumer owned by a Nexus user in a namespace.
 *
 * @example consumerUsernameForUser('u-1') // 'nexus-user-u-1'
 */
export function consumerUsernameForUser(userId: string): string {
  return `${CONSUMER_USERNAME_PREFIX}${userId}`;
}

/**
 * Username of the throwaway test consumer a provider may create for their API.
 *
 * @example testConsumerUsername('api-1') // 'nexus-test-api-1'
 */
export function testConsumerUsername(apiId: string): string {
  return `${TEST_CONSUMER_USERNAME_PREFIX}${apiId}`;
}

/** Default Ferrum Edge namespace Nexus manages (overridable via `FERRUM_NAMESPACE`). */
export const DEFAULT_FERRUM_NAMESPACE = 'nexus';

/**
 * Gateway listen path for a published API: `/<namespace>/<slug>`.
 *
 * @example listenPathFor('nexus', 'billing') // '/nexus/billing'
 */
export function listenPathFor(namespace: string, slug: string): string {
  return `/${namespace}/${slug}`;
}

/* ── Auth plugins ───────────────────────────────────────────────────────── */

/**
 * Ferrum Edge authentication plugin an API may be protected with.
 * These are the exact Edge plugin names (`GET /plugins`).
 */
export type AuthPluginType = 'key_auth' | 'basic_auth' | 'jwt_auth';

/** Every selectable auth plugin, in UI display order. */
export const AUTH_PLUGIN_TYPES = [
  'key_auth',
  'basic_auth',
  'jwt_auth',
] as const satisfies readonly AuthPluginType[];

/** Human-readable labels for {@link AuthPluginType}. */
export const AUTH_PLUGIN_LABELS: Readonly<Record<AuthPluginType, string>> = {
  key_auth: 'API Key',
  basic_auth: 'HTTP Basic',
  jwt_auth: 'JWT',
};

/**
 * Ferrum Edge consumer credential type (the key inside `Consumer.credentials`)
 * satisfied by each auth plugin. Note the names intentionally differ from the
 * plugin names on the Edge API.
 */
export const CREDENTIAL_TYPE_FOR_PLUGIN = {
  key_auth: 'keyauth',
  basic_auth: 'basicauth',
  jwt_auth: 'jwt',
} as const satisfies Readonly<Record<AuthPluginType, string>>;

/** Ferrum Edge credential type keys Nexus manages. */
export type EdgeCredentialType = (typeof CREDENTIAL_TYPE_FOR_PLUGIN)[AuthPluginType];

/** Runtime type guard for {@link AuthPluginType}. */
export function isAuthPluginType(value: unknown): value is AuthPluginType {
  return typeof value === 'string' && (AUTH_PLUGIN_TYPES as readonly string[]).includes(value);
}

/** Name of the Edge plugin used to restrict a requestable API to its ACL group. */
export const ACCESS_CONTROL_PLUGIN = 'access_control';

/** Name of the Edge plugin used to enforce a per-API rate limit. */
export const RATE_LIMIT_PLUGIN = 'rate_limiting';

/* ── Proxy runtime settings ─────────────────────────────────────────────── */

/**
 * HTTP methods a proxy's `allowed_methods` may name, in the order of Ferrum
 * Edge's own enum. Anything outside this set is a `400` from the gateway.
 */
export const HTTP_METHODS = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
  'TRACE',
  'CONNECT',
] as const;

/** One entry of {@link HTTP_METHODS}. */
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** Runtime type guard for {@link HttpMethod}. */
export function isHttpMethod(value: unknown): value is HttpMethod {
  return typeof value === 'string' && (HTTP_METHODS as readonly string[]).includes(value);
}

/**
 * Shortest backend timeout the portal will accept, in milliseconds.
 *
 * Edge's own floor is 0 ("disabled") on the read and write timeouts, which is
 * not a setting a provider should be able to choose from a portal form: a
 * hung upstream would then hold a gateway worker indefinitely. The portal
 * therefore exposes a positive range only, and "leave it to the gateway
 * default" is expressed by sending no timeouts at all.
 */
export const MIN_BACKEND_TIMEOUT_MS = 100;

/** Longest backend timeout the portal will accept, in milliseconds (5 minutes). */
export const MAX_BACKEND_TIMEOUT_MS = 300_000;

/** Edge's default TCP connect timeout, shown as the placeholder on the form. */
export const DEFAULT_BACKEND_CONNECT_TIMEOUT_MS = 5_000;

/** Edge's default backend read timeout. */
export const DEFAULT_BACKEND_READ_TIMEOUT_MS = 30_000;

/** Edge's default backend write timeout. */
export const DEFAULT_BACKEND_WRITE_TIMEOUT_MS = 30_000;

/* ── Cookies, headers, storage keys ─────────────────────────────────────── */

/** HttpOnly session cookie holding the opaque session token. */
export const SESSION_COOKIE = 'nexus_session';

/** Readable (non-HttpOnly) cookie half of the double-submit CSRF pair. */
export const CSRF_COOKIE = 'nexus_csrf';

/** Request header that must echo the {@link CSRF_COOKIE} value on mutations. */
export const CSRF_HEADER = 'X-Nexus-CSRF';

/** Lowercased {@link CSRF_HEADER}, matching Node's normalized header keys. */
export const CSRF_HEADER_LOWER = 'x-nexus-csrf';

/** localStorage key persisting the user's light/dark theme choice. */
export const THEME_STORAGE_KEY = 'nexus:theme';

/* ── Email templates ────────────────────────────────────────────────────── */

/** Key identifying a stored, admin-editable email template. */
export type EmailTemplateKey =
  | 'verification'
  | 'password_reset'
  | 'access_approved'
  | 'access_denied'
  | 'access_revoked'
  | 'message_received'
  | 'mass'
  | 'credential_rotated';

/** Every email template key, in admin UI display order. */
export const EMAIL_TEMPLATE_KEYS = [
  'verification',
  'password_reset',
  'access_approved',
  'access_denied',
  'access_revoked',
  'message_received',
  'mass',
  'credential_rotated',
] as const satisfies readonly EmailTemplateKey[];

/** Human-readable labels for {@link EmailTemplateKey}. */
export const EMAIL_TEMPLATE_LABELS: Readonly<Record<EmailTemplateKey, string>> = {
  verification: 'Email verification',
  password_reset: 'Password reset',
  access_approved: 'Access request approved',
  access_denied: 'Access request denied',
  access_revoked: 'Access revoked',
  message_received: 'New message received',
  mass: 'Mass email',
  credential_rotated: 'Credential rotated',
};

/** Runtime type guard for {@link EmailTemplateKey}. */
export function isEmailTemplateKey(value: unknown): value is EmailTemplateKey {
  return typeof value === 'string' && (EMAIL_TEMPLATE_KEYS as readonly string[]).includes(value);
}

/* ── Defaults and limits ────────────────────────────────────────────────── */

/** Default `limit` applied to list endpoints when the caller omits one. */
export const DEFAULT_PAGE_SIZE = 25;

/** Largest `limit` a list endpoint will honour. */
export const MAX_PAGE_SIZE = 200;

/** Session idle lifetime in seconds (12 hours). */
export const DEFAULT_SESSION_TTL_SECONDS = 43_200;

/** Email verification token lifetime in seconds (24 hours). */
export const EMAIL_VERIFICATION_TTL_SECONDS = 86_400;

/** Password reset token lifetime in seconds (1 hour). */
export const PASSWORD_RESET_TTL_SECONDS = 3_600;

/**
 * Minimum gap between two password-reset emails for the same account.
 *
 * A second `POST /api/auth/forgot-password` inside this window is answered
 * exactly like the first but sends nothing, so the endpoint cannot be used to
 * flood someone's inbox. It never changes the response, so it also cannot be
 * used to tell an existing address from an unknown one.
 */
export const PASSWORD_RESET_THROTTLE_SECONDS = 600;

/**
 * Minimum gap between two verification emails for the same account.
 *
 * Same contract as {@link PASSWORD_RESET_THROTTLE_SECONDS}: a resend inside the
 * window is answered identically and sends nothing.
 */
export const VERIFICATION_RESEND_THROTTLE_SECONDS = 600;

/** Outbox worker poll interval in milliseconds. */
export const OUTBOX_POLL_INTERVAL_MS = 5_000;

/** Maximum delivery attempts before an outbox row is marked `failed`. */
export const OUTBOX_MAX_ATTEMPTS = 5;

/** Minimum accepted password length at registration. */
export const MIN_PASSWORD_LENGTH = 12;

/** Maximum length of an access-request justification. */
export const MAX_JUSTIFICATION_LENGTH = 2_000;

/**
 * Largest `limit` a rate limit may ask for.
 *
 * This is Ferrum Edge's own ceiling on the `rate_limiting` plugin's
 * `max_requests`. Nexus validates against it so an out-of-range value is a
 * `400 VALIDATION_FAILED` from the portal rather than a `400` from the gateway
 * half-way through publishing.
 */
export const MAX_RATE_LIMIT_REQUESTS = 1_000_000;

/** Longest rate-limit window Edge accepts, in seconds (24 hours). */
export const MAX_RATE_LIMIT_WINDOW_SECONDS = 86_400;

/** Maximum number of origins the Edge `cors` plugin accepts in one config. */
export const MAX_CORS_ORIGINS = 64;

/** Maximum size in bytes of an uploaded OpenAPI document. */
export const MAX_SPEC_BYTES = 2 * 1024 * 1024;

/**
 * Maximum number of path items an uploaded OpenAPI document may declare.
 *
 * {@link MAX_SPEC_BYTES} alone is not a bound on *structure*: a server-valid
 * 2 MiB JSON document fits tens of thousands of minimal operations, and the SPA
 * renders one card per operation, so a single publish could freeze every
 * catalog viewer. The largest real-world public APIs sit far below this —
 * Stripe and GitHub are in the hundreds of paths, the biggest Azure surfaces in
 * the low thousands — so this is generous for anything a portal legitimately
 * fronts while still being a hard ceiling on render cost.
 */
export const MAX_SPEC_PATHS = 2_000;

/**
 * Maximum number of operations (path item × HTTP method) an uploaded OpenAPI
 * document may declare. Sized against the same real-world APIs as
 * {@link MAX_SPEC_PATHS}, allowing a healthy average of methods per path.
 */
export const MAX_SPEC_OPERATIONS = 3_000;

/**
 * HTTP methods that make a key of an OpenAPI path item an *operation*. Every
 * other key (`parameters`, `summary`, `servers`, `$ref`, extensions) is not.
 */
export const OPENAPI_OPERATION_METHODS = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
] as const satisfies readonly string[];

/**
 * Clamp a caller-supplied page size into `[1, MAX_PAGE_SIZE]`, falling back to
 * {@link DEFAULT_PAGE_SIZE} when it is absent or not a finite number.
 */
export function clampPageSize(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_PAGE_SIZE;
  const floored = Math.floor(limit);
  if (floored < 1) return 1;
  return Math.min(floored, MAX_PAGE_SIZE);
}
