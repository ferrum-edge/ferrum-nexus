/**
 * Entity shapes exactly as the Nexus HTTP API serialises them.
 *
 * These are the *wire* representations, not the database rows: secrets
 * (`password_hash`, session token hashes, encrypted setting blobs) are never
 * present here, and boolean-ish 0/1 columns are surfaced as real booleans.
 *
 * Conventions (design doc §Core architecture rules):
 * - every `id` is a string UUID;
 * - every timestamp is an ISO-8601 string (e.g. `2026-08-31T12:00:00.000Z`);
 * - optional/absent values are `null`, not omitted.
 */

import type { Role } from './roles.js';
import type { AuthPluginType, EmailTemplateKey } from './constants.js';

/** A string UUID primary key. */
export type Uuid = string;

/** An ISO-8601 timestamp string. */
export type IsoTimestamp = string;

/* ── Users & organizations ──────────────────────────────────────────────── */

/** Lifecycle state of a portal account. */
export type UserStatus = 'active' | 'disabled';

/** A portal account as returned by the API — never includes `password_hash`. */
export interface User {
  id: Uuid;
  email: string;
  display_name: string;
  role: Role;
  org_id: Uuid | null;
  company: string | null;
  phone: string | null;
  status: UserStatus;
  email_verified: boolean;
  last_login_at: IsoTimestamp | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

/** Reduced user shape embedded in other payloads (message senders, decision actors). */
export interface UserSummary {
  id: Uuid;
  email: string;
  display_name: string;
  role: Role;
}

/** Lightweight grouping for providers. */
export interface Organization {
  id: Uuid;
  name: string;
  description: string | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

/* ── APIs & specs ───────────────────────────────────────────────────────── */

/** Publication state of an API. */
export type ApiStatus = 'published' | 'retired';

/** Who may see an API in the catalog. */
export type ApiVisibility = 'public' | 'internal';

/** Format of an uploaded API description document. */
export type SpecFormat = 'openapi';

/** Per-API rate limit forwarded to the Edge rate-limit plugin. */
export interface RateLimitConfig {
  /** Allowed requests per `window_seconds`. */
  limit: number;
  /** Rolling window length in seconds. */
  window_seconds: number;
}

/**
 * Per-API browser CORS policy forwarded to the Edge `cors` plugin.
 *
 * `null` on an {@link Api} means no `cors` plugin is attached at all, so the
 * gateway adds no CORS headers and a browser treats the API as same-origin
 * only. This is deliberately not "allow nothing" — an absent plugin and a
 * plugin with an empty origin list are different things on the gateway.
 */
export interface CorsConfig {
  /**
   * Origins the gateway will echo back, e.g. `https://app.example.com`. At
   * least one, at most {@link MAX_CORS_ORIGINS}.
   */
  allowed_origins: string[];
  /** Whether the gateway sets `Access-Control-Allow-Credentials`. */
  allow_credentials: boolean;
}

/** A published API and the Edge proxy backing it. */
export interface Api {
  id: Uuid;
  name: string;
  slug: string;
  description: string | null;
  owner_user_id: Uuid;
  ferrum_proxy_id: string | null;
  /**
   * The upstream Nexus last wrote to the gateway, normalized to
   * `scheme://host:port[/basePath]` (IPv6 hosts bracketed). `null` on rows
   * published before this was recorded — read the proxy from Edge for those.
   */
  upstream_url: string | null;
  namespace: string;
  version: string;
  spec_format: SpecFormat;
  /** Whether clients may submit access requests for this API. */
  requestable: boolean;
  auth_plugin: AuthPluginType;
  rate_limit: RateLimitConfig | null;
  /** Browser CORS policy, or `null` when the gateway adds no CORS headers. */
  cors: CorsConfig | null;
  status: ApiStatus;
  visibility: ApiVisibility;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

/**
 * Catalog listing row: an API plus viewer-relative access state.
 *
 * The effective gateway upstream is provider-only operational data and must
 * never be exposed by the catalog.
 */
export interface CatalogApi extends Omit<Api, 'upstream_url'> {
  owner: UserSummary | null;
  /** Access state of the calling user for this API, when authenticated. */
  access_state: CatalogAccessState;
}

/** The calling user's relationship to a catalog API. */
export type CatalogAccessState = 'none' | 'pending' | 'granted' | 'denied' | 'revoked' | 'owner';

/** Metadata about a stored spec revision (never carries the raw document). */
export interface ApiSpecSummary {
  id: Uuid;
  api_id: Uuid;
  version: string;
  parsed_title: string | null;
  parsed_version: string | null;
  is_current: boolean;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

/** A spec revision including the raw document as uploaded. */
export interface ApiSpec extends ApiSpecSummary {
  /** The document exactly as uploaded (JSON or YAML text). */
  raw_spec: string;
}

/* ── Access requests & grants ───────────────────────────────────────────── */

/** Lifecycle of an access request. */
export type AccessRequestStatus = 'pending' | 'approved' | 'denied' | 'revoked' | 'cancelled';

/** A client's request for access to a requestable API. */
export interface AccessRequest {
  id: Uuid;
  api_id: Uuid;
  user_id: Uuid;
  justification: string;
  status: AccessRequestStatus;
  decided_by: Uuid | null;
  decided_at: IsoTimestamp | null;
  decision_note: string | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
  /** Denormalised joins included by list/detail endpoints. */
  api?: ApiSummary;
  requester?: UserSummary;
}

/** Compact API reference embedded in requests, grants and threads. */
export interface ApiSummary {
  id: Uuid;
  name: string;
  slug: string;
  version: string;
  owner_user_id: Uuid;
}

/** Lifecycle of a grant. */
export type GrantStatus = 'active' | 'revoked';

/** An active (or historical) authorization binding a user to an API's ACL group. */
export interface Grant {
  id: Uuid;
  api_id: Uuid;
  user_id: Uuid;
  access_request_id: Uuid | null;
  /** Always `nexus:api:<api_id>:approved`. */
  acl_group: string;
  status: GrantStatus;
  granted_by: Uuid;
  revoked_by: Uuid | null;
  revoked_at: IsoTimestamp | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
  api?: ApiSummary;
  user?: UserSummary;
}

/* ── Credentials & consumers ────────────────────────────────────────────── */

/** Lifecycle of a gateway credential. */
export type CredentialStatus = 'active' | 'retiring' | 'revoked';

/**
 * Credential flavour, using Ferrum Edge's credential-type keys (the keys of
 * `Consumer.credentials` on the Admin API): `keyauth` satisfies the
 * `key_auth` plugin, `basicauth` satisfies `basic_auth`, `jwt` satisfies
 * `jwt_auth`.
 */
export type CredentialType = 'keyauth' | 'basicauth' | 'jwt';

/**
 * Everything Nexus retains about a gateway credential. Plaintext material is
 * returned exactly once at issue/rotate time and is never stored.
 */
export interface CredentialMetadata {
  id: Uuid;
  user_id: Uuid;
  ferrum_consumer_id: string;
  credential_type: CredentialType;
  ferrum_credential_id: string;
  /** SHA-256 fingerprint of the plaintext secret. */
  fingerprint: string;
  /** Last four characters of the plaintext secret, for identification. */
  last4: string;
  label: string | null;
  status: CredentialStatus;
  /** Set on the replacement credential produced by a rotation. */
  rotated_from_id: Uuid | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

/** Cached mapping of a Nexus user to their Ferrum Edge consumer in a namespace. */
export interface Consumer {
  id: Uuid;
  user_id: Uuid;
  namespace: string;
  ferrum_consumer_id: string;
  ferrum_username: string;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

/* ── Messaging ──────────────────────────────────────────────────────────── */

/** A conversation between a client and a provider (or the platform). */
export interface MessageThread {
  id: Uuid;
  subject: string;
  api_id: Uuid | null;
  created_by: Uuid;
  /** The client participant. */
  participant_a: Uuid;
  /** The provider participant; `null` for platform/admin broadcast threads. */
  participant_b: Uuid | null;
  last_message_at: IsoTimestamp | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
  api?: ApiSummary;
  participants?: UserSummary[];
  /** Present on list endpoints as a preview of the newest message. */
  last_message_preview?: string | null;
}

/** A single message inside a thread. */
export interface Message {
  id: Uuid;
  thread_id: Uuid;
  sender_user_id: Uuid;
  body: string;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
  sender?: UserSummary;
}

/** A thread together with its full message list. */
export interface MessageThreadDetail extends MessageThread {
  messages: Message[];
}

/* ── Notifications ──────────────────────────────────────────────────────── */

/** Category of an in-app notification; drives the icon and default copy. */
export type NotificationType =
  | 'access_request_created'
  | 'access_request_approved'
  | 'access_request_denied'
  | 'access_revoked'
  | 'message_received'
  | 'credential_rotated'
  | 'api_published'
  | 'system';

/** An in-app notification for a single user. */
export interface Notification {
  id: Uuid;
  user_id: Uuid;
  type: NotificationType;
  title: string;
  body: string;
  /** In-app route to open when the notification is clicked. */
  link: string | null;
  read_at: IsoTimestamp | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

/* ── Email ──────────────────────────────────────────────────────────────── */

/** Delivery state of a queued email. */
export type EmailOutboxStatus = 'pending' | 'sending' | 'sent' | 'failed';

/** A row of the transactional email outbox (admin visibility only). */
export interface EmailOutboxEntry {
  id: Uuid;
  to_email: string;
  subject: string;
  status: EmailOutboxStatus;
  attempts: number;
  next_attempt_at: IsoTimestamp | null;
  last_error: string | null;
  idempotency_key: string | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

/** An admin-editable transactional email template. */
export interface EmailTemplate {
  id: Uuid;
  key: EmailTemplateKey;
  subject: string;
  body_html: string;
  body_text: string;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

/* ── Audit ──────────────────────────────────────────────────────────────── */

/** An append-only audit record written for every state-changing request. */
export interface AuditLog {
  id: Uuid;
  actor_user_id: Uuid | null;
  actor_role: Role | null;
  /** Dot-namespaced action, e.g. `access_request.approve`. */
  action: string;
  target_type: string;
  target_id: string | null;
  /** Arbitrary structured context; the shape depends on `action`. */
  details: Record<string, unknown>;
  ip: string | null;
  created_at: IsoTimestamp;
  actor?: UserSummary | null;
}

/* ── Settings, branding, captcha ────────────────────────────────────────── */

/** Portal branding, safe to expose without authentication. */
export interface BrandingSettings {
  /** Portal display name shown in the header and emails. */
  portal_name: string;
  /** Logo encoded as a `data:` URL, or `null` when unset. */
  logo_data_url: string | null;
  /** Primary accent colour as a CSS hex string. */
  primary_color: string;
  /** Accent colour used for secondary emphasis. */
  accent_color: string;
  /** Theme applied before the user makes a choice. */
  default_theme: ThemePreference;
  /** Optional short blurb rendered on the login/register pages. */
  tagline: string | null;
  /** Optional support contact surfaced in the footer. */
  support_email: string | null;
}

/** Theme selection persisted under `nexus:theme`. */
export type ThemePreference = 'dark' | 'light' | 'system';

/** Supported CAPTCHA vendors. */
export type CaptchaProvider = 'none' | 'recaptcha' | 'hcaptcha' | 'turnstile';

/** CAPTCHA configuration safe for the browser — never carries the secret key. */
export interface CaptchaPublicConfig {
  enabled: boolean;
  provider: CaptchaProvider;
  /** Vendor site key; `null` when CAPTCHA is disabled. */
  site_key: string | null;
}

/** SMTP configuration as returned to admins — the password is never included. */
export interface SmtpSettings {
  host: string | null;
  port: number;
  secure: boolean;
  username: string | null;
  /** True when an encrypted password is stored; the value itself is not returned. */
  password_set: boolean;
  from_address: string | null;
}

/** Registration/verification policy knobs. */
export interface RegistrationSettings {
  /** Whether self-service registration is open. */
  open_registration: boolean;
  /** Whether users must verify their email before signing in. */
  require_email_verification: boolean;
  /** Roles a visitor may self-select at registration. */
  allowed_roles: Role[];
}

/* ── Health ─────────────────────────────────────────────────────────────── */

/** Coarse health verdict for the app or one of its dependencies. */
export type HealthStatus = 'ok' | 'degraded' | 'down';

/** Health of a single dependency. */
export interface DependencyHealth {
  status: HealthStatus;
  /** Round-trip latency of the probe in milliseconds, when measured. */
  latency_ms: number | null;
  /** Failure detail when `status` is not `ok`. */
  error: string | null;
}

/** Aggregate health payload returned by `GET /api/health`. */
export interface AppHealth {
  status: HealthStatus;
  version: string;
  uptime_seconds: number;
  checked_at: IsoTimestamp;
  database: DependencyHealth & { driver: DbDriver };
  edge: EdgeHealth;
}

/** Supported persistence backends. */
export type DbDriver = 'sqlite' | 'postgres' | 'mysql' | 'mongodb';

/**
 * Coarse verdict for the gateway.
 *
 * `not_ready` is its own state on purpose: Edge answers `503` with a complete
 * health payload while it is `starting`, `draining` or `unavailable`, which is
 * a reachable gateway reporting itself unready — not an unreachable one.
 */
export type EdgeHealthStatus = 'ok' | 'not_ready' | 'down';

/** Health of the Ferrum Edge Admin API, as reported by `GET /api/health/edge`. */
export interface EdgeHealth extends Omit<DependencyHealth, 'status'> {
  status: EdgeHealthStatus;
  /** Edge's own readiness verdict, or `null` when it did not answer. */
  ready: boolean | null;
  /** Gateway operating mode (`database`, `file`, `cp`, `dp`, …), or `null`. */
  mode: string | null;
  /** Whether the gateway will currently accept config writes, or `null`. */
  admin_writes_enabled: boolean | null;
  /**
   * Gateway version string.
   *
   * Always `null` against a stock gateway — Ferrum Edge exposes **no version
   * endpoint**. Take the real version from your deployment metadata.
   */
  edge_version: string | null;
  namespace: string;
}
