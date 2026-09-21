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
import type {
  AuthPluginType,
  EmailTemplateKey,
  HttpMethod,
  SpecEnforcementLevel,
} from './constants.js';

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

/**
 * Who may see an API in the catalog — and, for `private`, who may open it.
 *
 * The three are deliberately distinct, because two of them answer different
 * questions:
 *
 * - `public` — listed in the browse view and readable by any signed-in
 *   account.
 * - `internal` — **unlisted, not secret.** Kept out of the browse view so the
 *   catalog stays a curated shop window, while anybody holding the link can
 *   still read the documentation and request access. This is what it has
 *   always meant, and it did not change when `private` was added.
 * - `private` — **permission enforced.** Neither listed nor openable unless
 *   the viewer is the owner, an administrator, an approved client, or someone
 *   the provider explicitly authorized. Guessing or being handed a slug is not
 *   enough.
 *
 * None of the three is a data-plane control. What stops an unapproved caller
 * reaching the API is the `access_control` plugin and its ACL group on the
 * gateway; visibility governs the *documentation* only, and a private API with
 * no access control in front of it is still callable by anyone who knows the
 * URL.
 */
export type ApiVisibility = 'public' | 'internal' | 'private';

/**
 * Whether the portal believes this API is deployed on the gateway.
 *
 * `deployed` is the ordinary state and what every API reads back as until
 * something says otherwise. `repair_required` is written when the portal has
 * *established* that the gateway no longer serves the API — today only by a
 * reconciliation pass answering `404` for the stored `ferrum_proxy_id`, or by
 * a restore attempt that failed partway — and it stays until a restore
 * succeeds.
 *
 * It is deliberately a separate field from {@link Api.ferrum_proxy_id} rather
 * than being derived from it. Clearing a dead proxy reference is what makes the
 * rest of the portal stop writing to a proxy that is not there; on its own it
 * also made the API look like one that simply has no deployment yet, so the
 * next reconciliation pass reported a clean portal while the API served
 * nothing (issue #284). The reference and the unresolved condition are two
 * different facts, and this is the second one.
 */
export type ApiGatewayState = 'deployed' | 'repair_required';

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
   *
   * Responses always use this name. Request bodies may send
   * {@link CorsConfigRequest.origins} instead; that alias is normalized here
   * and is never returned.
   */
  allowed_origins: string[];
  /** Whether the gateway sets `Access-Control-Allow-Credentials`. */
  allow_credentials: boolean;
  /** Extra request headers, in addition to the headers required by authentication. */
  allowed_headers?: string[];
  /** Require an exact CORS origin on WebSocket upgrades. Defaults to true when omitted. */
  enforce_websocket_origins?: boolean;
}

/**
 * CORS body accepted on `POST /api/apis` and `PATCH /api/apis/:id`.
 *
 * `origins` is an alias for {@link CorsConfig.allowed_origins}. The server
 * normalizes it to `allowed_origins` before anything is stored or returned.
 * Sending both keys with different values is `400 VALIDATION_FAILED` naming
 * both. Stored {@link Api.cors} and every response remain {@link CorsConfig}.
 */
export interface CorsConfigRequest {
  allowed_origins?: string[];
  /** Alias for {@link CorsConfig.allowed_origins}; never emitted on the way out. */
  origins?: string[];
  allow_credentials?: boolean;
  allowed_headers?: string[];
  enforce_websocket_origins?: boolean;
}

/**
 * Backend timeouts written onto the Edge proxy, in milliseconds.
 *
 * All three move together: `null` on an {@link Api} means the proxy keeps the
 * gateway's own defaults (5 000 / 30 000 / 30 000), and the portal never
 * writes a partial set, because Edge's `PUT /proxies/{id}` is a
 * whole-resource replace where an omitted key means "reset to the default"
 * rather than "leave alone".
 */
export interface ApiTimeouts {
  /** TCP connect timeout (`backend_connect_timeout_ms`). */
  connect_ms: number;
  /** Backend response read timeout (`backend_read_timeout_ms`). */
  read_ms: number;
  /** Backend write timeout (`backend_write_timeout_ms`). */
  write_ms: number;
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
  /**
   * Gateway listen path, always `/<namespace>/<slug>`. Derived, never stored —
   * see {@link listenPathFor}.
   */
  listen_path: string;
  /**
   * Absolute URL a client sends requests to: the configured public origin of
   * the gateway's proxy listener followed by {@link Api.listen_path}, e.g.
   * `https://api.example.com/nexus/billing`.
   *
   * `null` when no operator has configured a public gateway origin (neither the
   * `gateway.public_url` setting nor `FERRUM_GATEWAY_PUBLIC_URL`). Nexus never
   * guesses one: the Admin API's address is not the proxy listener's, and a
   * fabricated host would send clients somewhere real requests do not land.
   */
  invoke_url: string | null;
  version: string;
  spec_format: SpecFormat;
  /** Whether clients may submit access requests for this API. */
  requestable: boolean;
  auth_plugin: AuthPluginType;
  rate_limit: RateLimitConfig | null;
  /** Browser CORS policy, or `null` when the gateway adds no CORS headers. */
  cors: CorsConfig | null;
  /**
   * HTTP methods the gateway accepts, or `null` for "every method".
   *
   * This is the provider's own list. A request using a method outside it is
   * rejected with `405` **before any plugin runs**, so the list Nexus writes to
   * the proxy also carries `OPTIONS` whenever {@link Api.cors} is set —
   * otherwise the browser preflight would 405 before the `cors` plugin could
   * answer it.
   */
  allowed_methods: HttpMethod[] | null;
  /** Backend timeouts, or `null` when the proxy keeps the gateway defaults. */
  timeouts: ApiTimeouts | null;
  /**
   * Whether the proxy trips a circuit breaker on repeated backend failures.
   *
   * The portal models this as a switch: `true` writes Edge's own default
   * `CircuitBreakerConfig` (5 failures to open, 3 successes to close, 30 s
   * open, tripping on 500/502/503/504 and on connection errors), `false`
   * writes `null`. Tuning the thresholds is an operator's job.
   */
  circuit_breaker: boolean;
  /**
   * How much of the current OpenAPI revision the gateway enforces.
   *
   * `docs_only` (the default, and what every API published before this field
   * existed reads back as) means the document is catalog metadata only.
   * `routes` attaches an `openapi_validator` plugin that rejects any request
   * whose path and method the document does not declare — request and response
   * *bodies* are never validated at either level.
   */
  spec_enforcement: SpecEnforcementLevel;
  status: ApiStatus;
  visibility: ApiVisibility;
  /**
   * Whether the gateway is believed to be serving this API.
   *
   * `repair_required` is an actionable condition, not a cosmetic badge: the
   * public path answers `404`, approved clients' credentials reach nothing,
   * and only `POST /api/apis/:id/restore-gateway` clears it.
   */
  gateway_state: ApiGatewayState;
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

/**
 * The calling user's relationship to a catalog API.
 *
 * `open` is returned when the API does not require an access request
 * (`requestable: false`) and no owner / grant / request state applies.
 * `none` is reserved for requestable APIs the caller has not asked for.
 */
export type CatalogAccessState =
  'none' | 'open' | 'pending' | 'granted' | 'denied' | 'revoked' | 'owner';

/** Metadata about a stored spec revision (never carries the raw document). */
export interface ApiSpecSummary {
  id: Uuid;
  api_id: Uuid;
  version: string;
  parsed_title: string | null;
  parsed_version: string | null;
  is_current: boolean;
  /**
   * The account that published this revision, or `null` when it is not
   * recorded — a revision written before the column existed, or one whose
   * author's account has since been deleted. The history view renders `null`
   * as an unknown author rather than attributing the revision to somebody.
   */
  created_by: Uuid | null;
  /**
   * The revision this one restored, when it was published by a rollback.
   *
   * A rollback is a **new revision carrying an old document**, never a rewrite
   * of history, so this is the only thing that distinguishes the two. `null`
   * for an ordinary upload — and also for a rollback whose target has since
   * been dropped by retention, because the link is provenance rather than a
   * dependency.
   */
  rolled_back_from_id: Uuid | null;
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
  /** Gateway listen path, always `/<namespace>/<slug>`. */
  listen_path: string;
  /** Absolute invoke URL, or `null` when no public gateway origin is set. */
  invoke_url: string | null;
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
  /**
   * Append counter for the Edge credential array: strictly increasing per
   * `(ferrum_consumer_id, credential_type)`, assigned by the store when the
   * row is written, never reused. Edge addresses credential entries only by
   * array position, and the position of a live entry is its rank among the
   * consumer's live entries of that type ordered by this value — not by
   * `created_at`, which equal-millisecond appends and clock steps can reorder.
   *
   * `null` only on a row written before the counter existed whose order could
   * not be recovered unambiguously; such a row cannot be addressed by index and
   * its consumer needs an administrator's reconciliation.
   */
  edge_ordinal: number | null;
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
  /**
   * True when a god-mode broadcast wrote this row into a platform inbox.
   *
   * A broadcast fans one administrator's action out across every recipient, so
   * its rows are excluded from that administrator's rolling per-account message
   * budget — the broadcast carries its own bound instead. The flag is what the
   * budget query filters on, and it is surfaced so a reader can tell an
   * announcement apart from a reply an administrator typed into that thread.
   */
  broadcast: boolean;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
  sender?: UserSummary;
}

/**
 * One window of a conversation's messages.
 *
 * A conversation has no natural end, so the transcript is served a page at a
 * time from the **newest** end — that is what a reader wants to see first, and
 * it is what keeps a reply visible however long the history behind it has
 * grown. `items` is nonetheless ordered oldest-first, ready to render top to
 * bottom; walking backwards through the history means following `next_before`,
 * not incrementing an offset that shifts under you every time somebody replies.
 */
export interface MessagePage {
  /** The window, oldest message first. */
  items: Message[];
  /** Messages in the whole thread, however few this window holds. */
  total: number;
  /** Whether messages older than `items[0]` exist. */
  has_more: boolean;
  /**
   * Pass back as `before` to fetch the next older window. `null` once the
   * window reaches the start of the conversation.
   */
  next_before: Uuid | null;
}

/** A thread together with its most recent page of messages. */
export interface MessageThreadDetail extends MessageThread {
  messages: MessagePage;
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

/* ── Gateway teardown ───────────────────────────────────────────────────── */

/**
 * What disabling an account managed to do to its gateway identity.
 *
 * There is no terminal failure here on purpose. Revoking a disabled account's
 * Edge credentials is a security operation, and reporting it complete while it
 * has not happened is exactly the bug this state machine exists to prevent —
 * so an Edge outage yields `pending`, which means "queued and being retried",
 * not "gave up".
 */
export type GatewayTeardownOutcome =
  /** Groups and credentials are gone from the gateway. */
  | 'ok'
  /** The account never had an Edge consumer, so there was nothing to strip. */
  | 'no_consumer'
  /** Edge refused or was unreachable; the durable job retries until it lands. */
  | 'pending';

/** Lifecycle of one durable gateway-revocation job. */
export type GatewayTeardownJobStatus = 'pending' | 'sending' | 'done';

/** The outstanding revocation work for one disabled account (admin visibility). */
export interface GatewayTeardownState {
  status: GatewayTeardownJobStatus;
  /** Attempts made so far, including the one the disable request itself ran. */
  attempts: number;
  /** Why the last attempt failed, or `null` before the first failure. */
  last_error: string | null;
  next_attempt_at: IsoTimestamp | null;
  updated_at: IsoTimestamp;
  /** When the gateway confirmed the revocation; `null` while it is outstanding. */
  completed_at: IsoTimestamp | null;
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

export type ActorSummary = UserSummary;

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
  actor: ActorSummary | null;
}

/* ── Settings, branding, captcha ────────────────────────────────────────── */

/** Portal branding, safe to expose without authentication. */
export interface BrandingSettings {
  /** Portal display name shown in the header and emails. */
  portal_name: string;
  /** Logo encoded as a `data:` URL, or `null` when unset. */
  logo_data_url: string | null;
  /**
   * Primary brand colour as opaque CSS hex (`#rgb` or `#rrggbb`). Writes are
   * stored as lowercase `#rrggbb` so the native colour swatch, preview, and
   * derived palette all see the same value. 4- and 8-digit (alpha) forms are
   * rejected: the swatch and palette cannot render them.
   */
  primary_color: string;
  /**
   * Secondary emphasis colour (informational badges, hero glow). Same hex
   * contract as {@link BrandingSettings.primary_color}.
   */
  accent_color: string;
  /** Theme applied before the user makes a choice. */
  default_theme: ThemePreference;
  /** Optional short blurb rendered on the login/register pages. */
  tagline: string | null;
  /** Optional support contact surfaced in the footer. */
  support_email: string | null;
  /** Corner rounding preset applied to every control and card. */
  radius: BrandingRadius;
  /** Typeface preset; `system` uses the visitor's UI font, the rest are bundled. */
  font_preset: BrandingFontPreset;
  /** Navigation rail treatment: matches the surfaces, or always a dark high-contrast rail. */
  sidebar_style: BrandingSidebarStyle;
  /** Sign-in page composition: a branded hero beside the form, or the form alone. */
  login_layout: BrandingLoginLayout;
  /** Optional footer line (copyright, legal notice) shown in the shell and on the sign-in page. */
  footer_text: string | null;
  /** Optional footer links (terms, privacy, docs), `https` only. */
  footer_links: BrandingLink[];
}

/** Corner rounding presets; see `--radius-factor` in the SPA stylesheet. */
export type BrandingRadius = 'none' | 'sm' | 'md' | 'lg';

/** Bundled typeface presets. */
export type BrandingFontPreset = 'system' | 'inter' | 'manrope';

/** Navigation rail treatments. */
export type BrandingSidebarStyle = 'surface' | 'contrast';

/** Sign-in page compositions. */
export type BrandingLoginLayout = 'split' | 'centered';

/** One operator-configured footer link. */
export interface BrandingLink {
  /** Visible label, 1–60 characters. */
  label: string;
  /** Absolute `https://` (or `http://`) URL. */
  url: string;
}

/** Theme selection persisted under `nexus:theme`. */
export type ThemePreference = 'dark' | 'light' | 'system';

/**
 * Where the gateway's **proxy listener** answers, so the catalog can tell a
 * client the absolute URL to call.
 *
 * Deliberately not the portal's own origin and not the Edge Admin API's: those
 * are three different listeners, and only this one takes data-plane traffic.
 */
export interface GatewaySettings {
  /**
   * Public origin of the proxy listener — scheme, host and (non-default) port
   * only, no path, query or credentials, e.g. `https://api.example.com`.
   *
   * `null` means unconfigured, which surfaces as a `null` `invoke_url` on every
   * API rather than a guessed address.
   */
  public_url: string | null;
}

/** Supported CAPTCHA vendors. */
export type CaptchaProvider = 'none' | 'recaptcha' | 'hcaptcha' | 'turnstile';

/**
 * Whether the server acts on the stored CAPTCHA configuration at all.
 *
 * Set from the environment (`NEXUS_CAPTCHA_ENFORCEMENT`) and never through the
 * API: it is the operator's break-glass switch for a portal whose stored
 * CAPTCHA configuration is wrong or whose vendor is unreachable, which would
 * otherwise refuse every sign-in — including the super admin's. `disabled`
 * makes register and login skip verification and hides the widget; the stored
 * configuration is left exactly as it was.
 */
export type CaptchaEnforcement = 'enforced' | 'disabled';

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
 *
 * `degraded` is a gateway that is up, ready, and answering the Admin API while
 * something about the portal's relationship with it is wrong. Read
 * {@link EdgeHealth.reason} for which one.
 */
export type EdgeHealthStatus = 'ok' | 'degraded' | 'not_ready' | 'down';

/**
 * Why the gateway reads `degraded`.
 *
 * `namespace_unserved` — the gateway's data plane routes exactly one
 * namespace and it is not the one Nexus publishes into, so every proxy the
 * portal has created answers `404` on the listener. See
 * {@link EdgeNamespaceRouting}.
 */
export type EdgeHealthReason = 'namespace_unserved';

/**
 * Which namespace the portal writes to and which one the gateway's data plane
 * actually serves.
 *
 * The Admin API is multi-namespace; a single gateway process projects every
 * configuration snapshot down to its own `FERRUM_NAMESPACE` before building
 * the router. A write to any other namespace is accepted and never routed.
 *
 * `active`, `serving_scope` and `data_plane_single_namespace` come from the
 * `namespace` block on Edge's authenticated `GET /health`. A gateway that
 * predates that block reports `null`/`null`/`null` here, and
 * {@link EdgeNamespaceRouting.unserved} then stays `false` — an unknown
 * topology is never a verdict. `active` and `serving_scope` are also `null`
 * for a caller below `admin`, the same way {@link EdgeHealth.mode} is.
 */
export interface EdgeNamespaceRouting {
  /** Namespace Nexus publishes into (`FERRUM_NAMESPACE` on the portal). */
  configured: string;
  /** The one namespace the gateway's data plane routes, when it says. */
  active: string | null;
  /** `single-namespace-data-plane`, `control-plane`, `no-data-plane`, or `null`. */
  serving_scope: string | null;
  /** True when everything outside `active` is unrouted by that process. */
  data_plane_single_namespace: boolean | null;
  /** True when `configured` is provably not served — proxies exist but 404. */
  unserved: boolean;
  /**
   * True when the gateway stamped `X-Ferrum-Namespace-Unserved: true` on a
   * mutation the portal made. The per-write half of the same signal, and the
   * one that catches a gateway restarted into a different namespace between
   * health probes.
   */
  unserved_mutation_observed: boolean;
  /** When the verdict was last refreshed, or `null` if the gateway never said. */
  checked_at: IsoTimestamp | null;
}

/** Health of the Ferrum Edge Admin API, as reported by `GET /api/health/edge`. */
export interface EdgeHealth extends Omit<DependencyHealth, 'status'> {
  status: EdgeHealthStatus;
  /** Set when `status` is `degraded`; `null` otherwise. */
  reason: EdgeHealthReason | null;
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
  /** Namespace routability; `unserved` is what makes `status` `degraded`. */
  namespace_routing: EdgeNamespaceRouting;
  /**
   * Whether the gateway still holds the consumer and proxy ids Nexus stored.
   *
   * Filled from the last completed reconciliation pass, never by probing Edge
   * inside the health request — see {@link EdgeReconciliationHealth}.
   */
  reconciliation: EdgeReconciliationHealth;
}

/**
 * Somebody a provider has authorized to read a private API's documentation.
 *
 * **Not a grant.** It confers no ACL group, touches no Ferrum consumer and
 * reaches no gateway: an authorized viewer can read the catalog entry and the
 * specification, and — if the API is `requestable` — ask for access through
 * the ordinary flow. Being able to read the documentation and being able to
 * call the API are two different permissions, and a portal that conflated them
 * would turn "share the docs" into an authorization bug.
 */
export interface ApiViewer {
  id: Uuid;
  api_id: Uuid;
  user_id: Uuid;
  /** The account authorized, for rendering the list. */
  user: UserSummary | null;
  /** Who authorized them; `null` once that account is gone. */
  granted_by: Uuid | null;
  /** Free-text note the provider attached, e.g. why this person was invited. */
  note: string | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

/* ── Specification change review ────────────────────────────────────────── */

/** One operation of an OpenAPI document: a path template and a method. */
export interface SpecOperationRef {
  /** The path template as written, e.g. `/invoices/{id}`. */
  path: string;
  /** Uppercase HTTP method, e.g. `GET`. */
  method: string;
}

/** An operation both documents declare, with what differs about it. */
export interface SpecOperationChange extends SpecOperationRef {
  /**
   * Short labels for the parts of the operation that differ — `parameters`,
   * `requestBody`, `responses`, `security`, `summary`, `description`,
   * `deprecated`, `tags`, `servers`, `operationId`, `callbacks`.
   *
   * Structural, and deliberately shallow: it says *that* the request body
   * changed, not how. Anything the labels do not cover shows up as `other`.
   */
  changes: string[];
}

/** A top-level `info` field that differs between two revisions. */
export interface SpecInfoChange {
  field: 'title' | 'version' | 'description';
  from: string | null;
  to: string | null;
}

/**
 * A structural comparison of two OpenAPI revisions.
 *
 * **What this is not.** It compares declared paths, methods and the shape of
 * each operation. It does not evaluate schemas, resolve `$ref`s, or reason
 * about semantics, so an empty {@link SpecDiff.potentially_breaking} is
 * emphatically *not* proof that a change is backward compatible — a response
 * schema can drop a required field, or a parameter can narrow its type, with
 * every path and method identical. It is a review aid, and the UI says so.
 */
export interface SpecDiff {
  /** The revision being compared *from* — the current one, for a rollback. */
  from: ApiSpecSummary | null;
  /** The revision being compared *to*: a retained revision, or an upload. */
  to: ApiSpecSummary | null;
  /** Operations the target declares and the source does not. */
  added_operations: SpecOperationRef[];
  /** Operations the source declares and the target does not. */
  removed_operations: SpecOperationRef[];
  /** Operations both declare, whose definitions differ. */
  changed_operations: SpecOperationChange[];
  /** Path templates the target adds outright. */
  added_paths: string[];
  /** Path templates the target drops outright. */
  removed_paths: string[];
  /** `info` fields that differ. */
  info_changes: SpecInfoChange[];
  /** Whether the document's `servers` block differs. */
  servers_changed: boolean;
  /**
   * Operations a caller is using today that the target would stop serving:
   * every removed operation, in document order.
   *
   * Under `routes` enforcement these become a `400` from the gateway's
   * generated validator; under `docs_only` they stop being documented while
   * the proxy goes on forwarding them. Either way they are the changes worth
   * reading twice, which is why they are lifted out of
   * {@link SpecDiff.removed_operations} rather than left to be counted.
   */
  potentially_breaking: SpecOperationRef[];
  /** Whether the two documents differ at all, by any of the above. */
  changed: boolean;
}

/* ── Gateway reference reconciliation ───────────────────────────────────── */

/**
 * Verdict of the last gateway-reference reconciliation pass.
 *
 * `unknown` covers both "no pass has finished yet" and "the last pass could not
 * reach the gateway": neither is evidence that the stored ids are wrong, so
 * neither degrades the portal on its own — an unreachable gateway is already
 * reported by {@link EdgeHealthStatus}.
 *
 * `orphaned` also covers a pass that found no live orphan but knows of at
 * least one API still flagged `repair_required`
 * ({@link GatewayReconciliationReport.awaiting_restore}). That condition was
 * established by an earlier pass and survives the repair that cleared the dead
 * reference, so it outranks `unknown` too: an unreachable gateway does not
 * make an unrestored deployment go away.
 */
export type GatewayReconciliationStatus = 'ok' | 'orphaned' | 'unknown';

/** What one pass asked the gateway about, for one kind of stored reference. */
export interface GatewayReferenceScan {
  /** Stored references this pass asked the gateway about. */
  checked: number;
  /** How many of those the gateway answered `404` for. */
  orphaned: number;
  /** Whether the pass reached the end of the stored references. */
  complete: boolean;
}

/** An account whose stored Edge consumer id the gateway no longer holds. */
export interface OrphanedConsumerRef {
  user_id: Uuid;
  ferrum_consumer_id: string;
  ferrum_username: string;
}

/** An API whose stored Edge proxy id the gateway no longer holds. */
export interface OrphanedProxyRef {
  api_id: Uuid;
  slug: string;
  ferrum_proxy_id: string;
}

/**
 * Full result of one reconciliation pass. Admin-facing only — it names
 * accounts and APIs, so the unauthenticated health payload carries
 * {@link EdgeReconciliationHealth} instead.
 */
export interface GatewayReconciliationReport {
  status: GatewayReconciliationStatus;
  /** When the pass ran. */
  checked_at: IsoTimestamp;
  /** Ferrum namespace the pass covered. */
  namespace: string;
  consumers: GatewayReferenceScan;
  proxies: GatewayReferenceScan;
  orphaned_consumers: OrphanedConsumerRef[];
  orphaned_proxies: OrphanedProxyRef[];
  /**
   * APIs in this namespace whose {@link Api.gateway_state} is
   * `repair_required` — the deployment condition a previous pass already
   * established and nothing has restored yet.
   *
   * Counted from the portal's own rows rather than from the gateway, so it is
   * filled on every pass including one that could not reach Edge: "we know
   * these APIs are not deployed" does not stop being true because the gateway
   * stopped answering. It is what keeps the condition visible after a repair
   * has cleared the dead proxy reference the scan would otherwise have found.
   */
  awaiting_restore: number;
  /** Why the pass could not finish; `null` when it did. */
  error: string | null;
}

/**
 * The reconciliation signal carried on the public health payload.
 *
 * `status` and `checked_at` are public — a monitor has to be able to see that
 * the portal is pointing at a gateway that does not hold its references, and
 * when that was last established. The counts and `complete` name how much of
 * the portal is affected, so they follow the same admin-only rule as the Edge
 * diagnostic text and read `null` for everyone else.
 */
export interface EdgeReconciliationHealth {
  status: GatewayReconciliationStatus;
  /** When the last pass ran, or `null` when none has finished. */
  checked_at: IsoTimestamp | null;
  /** Admin-only: accounts whose gateway consumer is gone. */
  orphaned_consumers: number | null;
  /** Admin-only: APIs whose gateway proxy is gone. */
  orphaned_proxies: number | null;
  /** Admin-only: APIs flagged `repair_required` and not restored yet. */
  awaiting_restore: number | null;
  /** Admin-only: whether the pass covered every stored reference. */
  complete: boolean | null;
}
