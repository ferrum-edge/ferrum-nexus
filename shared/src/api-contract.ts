/**
 * Request/response DTOs for every endpoint of the Nexus HTTP API.
 *
 * Both sides of the wire import these: `server/src/routes/*` validates into
 * them with zod, and `web/src/lib/api.ts` types its client against them. Every
 * route in the design doc's "HTTP API" section has an entry here, in the same
 * order.
 */

import type { RegistrableRole, Role } from './roles.js';
import type { ErrorCode } from './error-codes.js';
import type {
  AuthPluginType,
  EmailTemplateKey,
  HttpMethod,
  SpecEnforcementLevel,
} from './constants.js';
import type {
  AccessRequest,
  AccessRequestStatus,
  Api,
  ApiSpecSummary,
  ApiStatus,
  ApiTimeouts,
  ApiVisibility,
  AppHealth,
  AuditLog,
  BrandingSettings,
  CaptchaProvider,
  CaptchaPublicConfig,
  CatalogApi,
  CorsConfig,
  CredentialMetadata,
  CredentialType,
  EdgeHealth,
  EmailTemplate,
  GatewaySettings,
  GatewayTeardownOutcome,
  GatewayTeardownState,
  Grant,
  GrantStatus,
  IsoTimestamp,
  Message,
  MessageThread,
  MessageThreadDetail,
  Notification,
  NotificationType,
  Organization,
  RateLimitConfig,
  RegistrationSettings,
  SmtpSettings,
  ThemePreference,
  User,
  UserStatus,
  Uuid,
} from './entities.js';
import type { ApiPlugin, ApiPluginTrigger } from './plugins.js';

/* ── Envelopes ──────────────────────────────────────────────────────────── */

/** Query parameters accepted by every list endpoint. */
export interface ListQuery {
  /** Page size; clamped to `[1, MAX_PAGE_SIZE]`, defaults to `DEFAULT_PAGE_SIZE`. */
  limit?: number;
  /** Zero-based row offset. */
  offset?: number;
}

/** Standard list response envelope: the page plus the unpaginated total. */
export interface Paginated<T> {
  items: T[];
  /** Total number of rows matching the filters, ignoring limit/offset. */
  total: number;
}

/** Body of every non-2xx response. */
export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    /** Field-level validation issues or provider error context. */
    details?: unknown;
  };
}

/** Response for mutations that return nothing but success. */
export interface OkResponse {
  ok: true;
}

/* ── Health ─────────────────────────────────────────────────────────────── */

/** `GET /api/health` */
export type HealthResponse = AppHealth;

/** `GET /api/health/edge` */
export type EdgeHealthResponse = EdgeHealth;

/* ── Auth ───────────────────────────────────────────────────────────────── */

/** `POST /api/auth/register` */
export interface RegisterRequest {
  email: string;
  password: string;
  display_name: string;
  /** Ignored for the very first account, which always becomes `super_admin`. */
  role: RegistrableRole;
  company?: string | null;
  phone?: string | null;
  /** Vendor CAPTCHA token; required when CAPTCHA is enabled. */
  captcha_token?: string;
}

/** `POST /api/auth/register` */
export interface RegisterResponse {
  user: User;
  /** True when a verification email was enqueued and sign-in is blocked until used. */
  email_verification_required: boolean;
}

/** `POST /api/auth/login` */
export interface LoginRequest {
  email: string;
  password: string;
  captcha_token?: string;
}

/** `POST /api/auth/login` — sets the session + CSRF cookies. */
export interface LoginResponse {
  user: User;
  /** Value the client must echo in the `X-Nexus-CSRF` header. */
  csrf_token: string;
  expires_at: IsoTimestamp;
}

/** `POST /api/auth/logout` */
export type LogoutResponse = OkResponse;

/** `GET /api/auth/me` — also the shape used to bootstrap the SPA. */
export interface MeResponse {
  user: User;
  csrf_token: string;
  expires_at: IsoTimestamp;
  /** Convenience flags derived from the role, so the SPA does not re-derive them. */
  capabilities: Capabilities;
}

/** Role-derived permission flags surfaced to the SPA for nav filtering. */
export interface Capabilities {
  can_publish_apis: boolean;
  can_review_access_requests: boolean;
  can_manage_users: boolean;
  can_manage_settings: boolean;
  can_view_audit_log: boolean;
  can_use_god_mode: boolean;
}

/** `POST /api/auth/verify-email` */
export interface VerifyEmailRequest {
  token: string;
}

/** `POST /api/auth/verify-email` */
export interface VerifyEmailResponse {
  verified: boolean;
  user: User;
}

/** `POST /api/auth/resend-verification` */
export interface ResendVerificationRequest {
  email: string;
}

/**
 * `POST /api/auth/resend-verification`
 *
 * Always `{ ok: true }`, on the same anti-enumeration contract as
 * {@link ForgotPasswordResponse}: unknown, disabled, already-verified and
 * throttled all look identical.
 */
export type ResendVerificationResponse = OkResponse;

/** `POST /api/auth/forgot-password` */
export interface ForgotPasswordRequest {
  email: string;
}

/**
 * `POST /api/auth/forgot-password`
 *
 * Always `{ ok: true }`, with the same status and body whether the address has
 * an account, belongs to a disabled one, or was asked for again inside the
 * resend throttle. The response is deliberately not a signal.
 */
export type ForgotPasswordResponse = OkResponse;

/** `POST /api/auth/reset-password` */
export interface ResetPasswordRequest {
  token: string;
  new_password: string;
}

/**
 * `POST /api/auth/reset-password`
 *
 * On success every session of the account has been terminated, so the caller
 * must sign in again with the new password.
 */
export type ResetPasswordResponse = OkResponse;

/** `GET /api/auth/captcha` — public widget configuration. */
export type CaptchaConfigResponse = CaptchaPublicConfig;

/* ── Users & organizations ──────────────────────────────────────────────── */

/** `GET /api/users/me` */
export interface GetMeUserResponse {
  user: User;
}

/** `PATCH /api/users/me` — profile self-service. */
export interface UpdateMeRequest {
  display_name?: string;
  company?: string | null;
  phone?: string | null;
  /** Required when `new_password` is supplied. */
  current_password?: string;
  new_password?: string;
}

/** `PATCH /api/users/me` */
export type UpdateMeResponse = GetMeUserResponse;

/** `GET /api/users` (admin) */
export interface ListUsersQuery extends ListQuery {
  role?: Role;
  status?: UserStatus;
  org_id?: Uuid;
  /** Case-insensitive substring match on email or display name. */
  q?: string;
}

/** `GET /api/users` (admin) */
export interface ListUsersResponse extends Paginated<User> {
  /**
   * Disabled accounts whose gateway credentials have not been revoked yet,
   * across the whole portal rather than this page. Anything above zero means
   * the teardown worker is still retrying against Edge.
   */
  pending_gateway_teardowns: number;
}

/** `GET /api/users/:id` (admin) */
export interface GetUserResponse {
  user: User;
  /** Outstanding or completed gateway revocation; `null` when there is none. */
  gateway_teardown: GatewayTeardownState | null;
}

/** `PATCH /api/users/:id` (admin) — role and status management. */
export interface UpdateUserRequest {
  role?: Role;
  status?: UserStatus;
  org_id?: Uuid | null;
  display_name?: string;
}

/** `PATCH /api/users/:id` (admin) */
export interface UpdateUserResponse {
  user: User;
  /**
   * Present only when this request disabled the account. `pending` means the
   * portal account is off but the gateway credentials are still being revoked
   * in the background — the operation is not complete.
   */
  gateway_teardown?: GatewayTeardownOutcome;
}

/** `POST /api/users/:id/gateway-teardown/retry` (admin) */
export interface RetryGatewayTeardownResponse {
  gateway_teardown: GatewayTeardownOutcome;
  /** The job after the attempt: `done` on success, still `pending` otherwise. */
  job: GatewayTeardownState | null;
}

/** `GET /api/organizations` (admin) */
export type ListOrganizationsQuery = ListQuery;

/** `GET /api/organizations` (admin) */
export type ListOrganizationsResponse = Paginated<Organization>;

/** `POST /api/organizations` (admin) */
export interface CreateOrganizationRequest {
  name: string;
  description?: string | null;
}

/** `POST /api/organizations` (admin) */
export interface CreateOrganizationResponse {
  organization: Organization;
}

/* ── Catalog ────────────────────────────────────────────────────────────── */

/** `GET /api/catalog` */
export interface CatalogListQuery extends ListQuery {
  /** Case-insensitive substring match on name, slug or description. */
  q?: string;
  /** Only APIs that accept access requests. */
  requestable?: boolean;
  visibility?: ApiVisibility;
  owner_user_id?: Uuid;
}

/** `GET /api/catalog` */
export type CatalogListResponse = Paginated<CatalogApi>;

/** `GET /api/catalog/:slug` */
export interface CatalogDetailResponse {
  api: CatalogApi;
  /** Metadata for the current spec revision; `null` when none is published. */
  spec: ApiSpecSummary | null;
  /** The caller's open access request for this API, when one exists. */
  my_request: AccessRequest | null;
  /** The caller's active grant for this API, when one exists. */
  my_grant: Grant | null;
}

/** `GET /api/catalog/:slug/spec` — the raw document plus its metadata. */
export interface CatalogSpecResponse {
  api_id: Uuid;
  version: string;
  /** The document exactly as uploaded (JSON or YAML text). */
  raw_spec: string;
  /** `application/json` or `application/yaml`, matching `raw_spec`. */
  content_type: string;
  parsed_title: string | null;
  parsed_version: string | null;
}

/* ── Publishing (provider) ──────────────────────────────────────────────── */

/** `GET /api/apis` */
export interface ListApisQuery extends ListQuery {
  /** Restrict to the caller's own APIs (default for providers). */
  mine?: boolean;
  owner_user_id?: Uuid;
  status?: ApiStatus;
  q?: string;
}

/** `GET /api/apis` */
export type ListApisResponse = Paginated<Api>;

/** `POST /api/apis` — publishing creates the Edge proxy and its plugins. */
export interface PublishApiRequest {
  name: string;
  /** URL-safe identifier; the gateway listen path becomes `/<namespace>/<slug>`. */
  slug: string;
  description?: string | null;
  version: string;
  /** Upstream the Edge proxy forwards to. */
  upstream_url: string;
  /** The OpenAPI document as uploaded (JSON or YAML text). */
  spec: string;
  auth_plugin: AuthPluginType;
  requestable: boolean;
  visibility: ApiVisibility;
  rate_limit?: RateLimitConfig | null;
  /** Browser CORS policy; omit or send `null` for no gateway CORS headers. */
  cors?: CorsConfig | null;
  /**
   * HTTP methods the gateway accepts. Omit or send `null` to accept every
   * method. `OPTIONS` is added to the list written to the gateway whenever
   * `cors` is set, so a preflight is not rejected before the plugin runs.
   */
  allowed_methods?: HttpMethod[] | null;
  /** Backend timeouts; omit or send `null` to keep the gateway defaults. */
  timeouts?: ApiTimeouts | null;
  /** Trip a circuit breaker on repeated backend failures. Defaults to `false`. */
  circuit_breaker?: boolean;
  /**
   * How much of the uploaded document the gateway enforces. Defaults to
   * `docs_only`; `routes` additionally rejects any path/method the spec does
   * not declare. Bodies are never validated.
   */
  spec_enforcement?: SpecEnforcementLevel;
}

/** `POST /api/apis` */
export interface PublishApiResponse {
  api: Api;
  spec: ApiSpecSummary;
}

/** `GET /api/apis/:id` */
export interface GetApiResponse {
  api: Api;
  spec: ApiSpecSummary | null;
  /** Counts shown on the provider's API card. */
  stats: ApiStats;
}

/** Aggregate counters for a provider's API. */
export interface ApiStats {
  pending_requests: number;
  active_grants: number;
  total_requests: number;
}

/** `PATCH /api/apis/:id` — safe runtime settings only; the spec has its own route. */
export interface UpdateApiRequest {
  name?: string;
  description?: string | null;
  version?: string;
  upstream_url?: string;
  auth_plugin?: AuthPluginType;
  requestable?: boolean;
  visibility?: ApiVisibility;
  rate_limit?: RateLimitConfig | null;
  /** Replace the CORS policy, or send `null` to remove it from the gateway. */
  cors?: CorsConfig | null;
  /** Replace the method allow-list, or send `null` to accept every method again. */
  allowed_methods?: HttpMethod[] | null;
  /** Replace the backend timeouts, or send `null` to restore the gateway defaults. */
  timeouts?: ApiTimeouts | null;
  circuit_breaker?: boolean;
  /**
   * Switch OpenAPI enforcement on (`routes`) or back off (`docs_only`), which
   * attaches or detaches the gateway's `openapi_validator` accordingly.
   */
  spec_enforcement?: SpecEnforcementLevel;
  status?: ApiStatus;
}

/** `PATCH /api/apis/:id` */
export interface UpdateApiResponse {
  api: Api;
}

/** `DELETE /api/apis/:id` — removes the Edge proxy and its plugins. */
export type DeleteApiResponse = OkResponse;

/** `PUT /api/apis/:id/spec` — publish a new spec revision. */
export interface UpdateApiSpecRequest {
  /** The OpenAPI document as uploaded (JSON or YAML text). */
  spec: string;
  /** Optional new API version label; defaults to the parsed spec version. */
  version?: string;
}

/** `PUT /api/apis/:id/spec` */
export interface UpdateApiSpecResponse {
  api: Api;
  spec: ApiSpecSummary;
}

/** `POST /api/apis/:id/test-consumer` — provider-only sandbox consumer. */
export interface CreateTestConsumerRequest {
  label?: string | null;
}

/**
 * `POST /api/apis/:id/test-consumer` — show-once. The plaintext secret is
 * returned here and nowhere else, ever.
 */
export interface CreateTestConsumerResponse {
  credential: CredentialMetadata;
  /** Edge consumer username, always `nexus-test-<api_id>`. */
  consumer_username: string;
  secret: ShowOnceSecret;
}

/* ── Plugin palette (provider) ──────────────────────────────────────────── */

/**
 * `GET /api/apis/:id/plugins` — every palette plugin currently configured on
 * this API.
 *
 * Only plugins the provider switched on appear; the palette itself is a static
 * catalog (`PROVIDER_PLUGINS`) the SPA already has, so the response carries
 * state, not schema. Owner or admin, like every other provider-side read.
 */
export interface ListApiPluginsResponse {
  plugins: ApiPlugin[];
}

/**
 * `PUT /api/apis/:id/plugins/:name` — create or replace one palette plugin.
 *
 * The body is validated against the descriptor's field specs, so `config`
 * carries **exactly** the keys that plugin declares: Edge's key sets are
 * closed, and an extra key is a `400` from the gateway rather than a no-op.
 */
export interface SetApiPluginRequest {
  /**
   * Defaults to `true`. `false` keeps the gateway config and its association
   * but stops Edge running it, so the provider's settings survive a temporary
   * switch-off.
   */
  enabled?: boolean;
  config: Record<string, unknown>;
  /**
   * Restrict the plugin to some methods and/or a path prefix. Only accepted
   * for a descriptor with `supports_trigger: true`; `null` removes an existing
   * one.
   */
  trigger?: ApiPluginTrigger | null;
}

/** `PUT /api/apis/:id/plugins/:name` */
export interface SetApiPluginResponse {
  plugin: ApiPlugin;
}

/** `DELETE /api/apis/:id/plugins/:name` — detaches and deletes the Edge config. */
export type DeleteApiPluginResponse = OkResponse;

/* ── Usage & backend health ─────────────────────────────────────────────── */

/**
 * `GET /api/apis/:id/usage` — what the gateway currently reports for this
 * API's proxy.
 *
 * ## What this is, and what it deliberately is not
 *
 * Nexus runs no metrics pipeline. This is a **cached read-through** of the two
 * things Ferrum Edge already exposes for a proxy: the Prometheus counters on
 * `GET /metrics` and the runtime state on `GET /admin/metrics`. Consequences a
 * reader must keep in mind:
 *
 * - **Every count is cumulative since the gateway process started**, not "this
 *   month" or "the last hour". Edge exposes no per-proxy time window and Nexus
 *   stores no history, so a restart resets the numbers to zero. Point
 *   Prometheus at Edge if you need rates or retention.
 * - **There are no per-consumer counts.** Edge's request counter is not labelled
 *   by consumer, so "who is using this API" cannot be answered from here.
 * - `available: false` means the gateway could not be read (unreachable, an
 *   error status, or an unparseable body), or the API has no proxy yet. The
 *   route still answers `200`: a gateway hiccup is not a portal failure.
 */
export interface ApiUsageResponse {
  /** Whether the numbers below came from a successful gateway read. */
  available: boolean;
  /** When Nexus produced this answer (a cached read may be up to 10s older). */
  sampled_at: IsoTimestamp;
  /**
   * `gateway.uptime_seconds` — how far back the cumulative counters reach.
   * Absent when the gateway did not report it.
   */
  gateway_uptime_seconds?: number;
  requests: ApiUsageRequests;
  /**
   * Percentiles interpolated from the gateway's `ferrum_request_duration_ms`
   * histogram buckets, exactly as `histogram_quantile` does: the value is
   * linearly interpolated inside the bucket the quantile falls in, so its
   * accuracy is bounded by that bucket's width, and a quantile landing in the
   * open-ended top bucket is reported as the highest finite bucket bound.
   * `null` when the histogram is empty or was not readable.
   */
  latency_ms: ApiUsageLatency | null;
  backend: ApiUsageBackend;
}

/** Cumulative request counters for one API's proxy. */
export interface ApiUsageRequests {
  /** Every counted request, summed across methods and status codes. */
  total: number;
  /** Requests grouped by HTTP status class. Non-numeric statuses are dropped. */
  by_status_class: ApiUsageStatusClasses;
  /** `status_code` → count, e.g. `{ '200': 1200, '429': 18 }`. */
  by_status: Record<string, number>;
  /** `method` → count, e.g. `{ GET: 900, POST: 318 }`. */
  by_method: Record<string, number>;
  /** `429`s — the rate limit turning traffic away. */
  rate_limited: number;
  /** `401`s — a missing or invalid credential. */
  unauthorized: number;
  /** `403`s — authenticated, but not in the API's ACL group. */
  forbidden: number;
}

/** Request counts bucketed by HTTP status class. */
export interface ApiUsageStatusClasses {
  '2xx': number;
  '3xx': number;
  '4xx': number;
  '5xx': number;
}

/** Interpolated latency percentiles, in milliseconds. */
export interface ApiUsageLatency {
  p50: number;
  p95: number;
  p99: number;
}

/**
 * How the gateway currently sees this API's backend.
 *
 * - `healthy` — a closed circuit breaker and no ejected target.
 * - `failing` — an open breaker, or a target passive health checking has
 *   ejected.
 * - `recovering` — a half-open breaker probing whether the backend is back.
 * - `unknown` — the gateway reports nothing about this proxy. That is the
 *   normal state for a proxy with no `circuit_breaker` configured, and for one
 *   that has never been called; it is **not** a claim that the backend is down.
 */
export interface ApiUsageBackend {
  status: ApiUsageBackendStatus;
  /** One human-readable sentence explaining `status`, or `null`. */
  detail: string | null;
  /** Since when the backend has been in a failing state, when Edge reports it. */
  since?: IsoTimestamp;
}

/** @see {@link ApiUsageBackend} */
export type ApiUsageBackendStatus = 'healthy' | 'failing' | 'recovering' | 'unknown';

/* ── Access requests & grants ───────────────────────────────────────────── */

/** `POST /api/access-requests` */
export interface CreateAccessRequestRequest {
  api_id: Uuid;
  justification: string;
}

/** `POST /api/access-requests` */
export interface CreateAccessRequestResponse {
  access_request: AccessRequest;
}

/** `GET /api/access-requests?mine|api_id` */
export interface ListAccessRequestsQuery extends ListQuery {
  /** Only the caller's own requests. */
  mine?: boolean;
  api_id?: Uuid;
  status?: AccessRequestStatus;
}

/** `GET /api/access-requests` */
export type ListAccessRequestsResponse = Paginated<AccessRequest>;

/**
 * Body for `POST /api/access-requests/:id/approve` and
 * `POST /api/access-requests/:id/deny` — the reviewer's optional note.
 */
export interface DecideAccessRequestRequest {
  decision_note?: string | null;
}

/** `POST /api/access-requests/:id/approve` */
export interface ApproveAccessRequestResponse {
  access_request: AccessRequest;
  /** The grant created by the approval; its ACL group is now on the consumer. */
  grant: Grant;
}

/** `POST /api/access-requests/:id/deny` */
export interface DenyAccessRequestResponse {
  access_request: AccessRequest;
}

/** `POST /api/access-requests/:id/cancel` — by the requester. */
export interface CancelAccessRequestResponse {
  access_request: AccessRequest;
}

/** `GET /api/grants` */
export interface ListGrantsQuery extends ListQuery {
  mine?: boolean;
  api_id?: Uuid;
  user_id?: Uuid;
  status?: GrantStatus;
}

/** `GET /api/grants` */
export type ListGrantsResponse = Paginated<Grant>;

/** `POST /api/grants/:id/revoke` */
export interface RevokeGrantRequest {
  reason?: string | null;
}

/** `POST /api/grants/:id/revoke` — the ACL group is removed from the consumer. */
export interface RevokeGrantResponse {
  grant: Grant;
}

/* ── Credentials ────────────────────────────────────────────────────────── */

/**
 * Plaintext credential material. Returned exactly once, at issue or rotate
 * time; only a fingerprint and last4 are persisted.
 */
export interface ShowOnceSecret {
  type: CredentialType;
  /** API key value — present for `keyauth`. */
  key?: string;
  /** Basic-auth username — present for `basicauth`. */
  username?: string;
  /** Basic-auth password — present for `basicauth`. */
  password?: string;
  /** JWT signing secret — present for `jwt`. */
  jwt_secret?: string;
  /** JWT `iss`/key id the gateway expects — present for `jwt`. */
  jwt_key?: string;
}

/** `GET /api/credentials` */
export interface ListCredentialsQuery extends ListQuery {
  status?: CredentialMetadata['status'];
}

/** `GET /api/credentials` */
export type ListCredentialsResponse = Paginated<CredentialMetadata>;

/** `POST /api/credentials` */
export interface IssueCredentialRequest {
  credential_type: CredentialType;
  label?: string | null;
}

/** `POST /api/credentials` — show-once: `secret` is never retrievable again. */
export interface IssueCredentialResponse {
  credential: CredentialMetadata;
  /** Edge consumer username, always `nexus-user-<user_id>`. */
  consumer_username: string;
  secret: ShowOnceSecret;
}

/** `POST /api/credentials/:id/rotate` */
export interface RotateCredentialRequest {
  label?: string | null;
}

/**
 * `POST /api/credentials/:id/rotate` — show-once. The replacement is created
 * on Edge first; the previous credential moves to `retiring` and is deleted
 * once the rotation is finalized.
 */
export interface RotateCredentialResponse {
  credential: CredentialMetadata;
  /** The credential being replaced, now in `retiring` status. */
  previous: CredentialMetadata;
  consumer_username: string;
  secret: ShowOnceSecret;
}

/** `DELETE /api/credentials/:id` */
export type DeleteCredentialResponse = OkResponse;

/* ── Messaging ──────────────────────────────────────────────────────────── */

/** `GET /api/threads` */
export interface ListThreadsQuery extends ListQuery {
  api_id?: Uuid;
  /** Case-insensitive substring match on the subject. */
  q?: string;
}

/** `GET /api/threads` */
export type ListThreadsResponse = Paginated<MessageThread>;

/** `POST /api/threads` — opens a conversation and posts the first message. */
export interface CreateThreadRequest {
  subject: string;
  /** The counterparty; omitted for a thread addressed to the platform admins. */
  recipient_user_id?: Uuid | null;
  /** Optional API the conversation is about. */
  api_id?: Uuid | null;
  /** Body of the opening message. */
  body: string;
}

/** `POST /api/threads` */
export interface CreateThreadResponse {
  thread: MessageThread;
  message: Message;
}

/** `GET /api/threads/:id` */
export type GetThreadResponse = MessageThreadDetail;

/** `POST /api/threads/:id/messages` */
export interface SendMessageRequest {
  body: string;
}

/** `POST /api/threads/:id/messages` */
export interface SendMessageResponse {
  message: Message;
}

/* ── Notifications ──────────────────────────────────────────────────────── */

/** `GET /api/notifications` */
export interface ListNotificationsQuery extends ListQuery {
  /** Only notifications that have not been read. */
  unread?: boolean;
  type?: NotificationType;
}

/** `GET /api/notifications` */
export interface ListNotificationsResponse extends Paginated<Notification> {
  /** Count of unread notifications, for the header bell badge. */
  unread_count: number;
}

/** `POST /api/notifications/read` — pass explicit ids or `all: true`. */
export interface MarkNotificationsReadRequest {
  ids?: Uuid[];
  all?: boolean;
}

/** `POST /api/notifications/read` */
export interface MarkNotificationsReadResponse {
  updated: number;
  unread_count: number;
}

/* ── Admin: settings, templates, mass email, audit ──────────────────────── */

/** CAPTCHA settings as an admin sees them — the secret is write-only. */
export interface CaptchaAdminSettings {
  enabled: boolean;
  provider: CaptchaProvider;
  site_key: string | null;
  /** True when an encrypted secret is stored; the value itself is never returned. */
  secret_set: boolean;
}

/** `GET /api/admin/settings` */
export interface AdminSettingsResponse {
  branding: BrandingSettings;
  captcha: CaptchaAdminSettings;
  smtp: SmtpSettings;
  registration: RegistrationSettings;
  /** Public origin of the gateway's proxy listener, for the catalog's invoke URLs. */
  gateway: GatewaySettings;
}

/** `PUT /api/admin/settings` — every section is optional; omitted ones are untouched. */
export interface UpdateSettingsRequest {
  branding?: Partial<BrandingSettings>;
  captcha?: {
    enabled?: boolean;
    provider?: CaptchaProvider;
    site_key?: string | null;
    /** Write-only; stored AES-256-GCM encrypted. Pass `null` to clear. */
    secret_key?: string | null;
  };
  smtp?: {
    host?: string | null;
    port?: number;
    secure?: boolean;
    username?: string | null;
    /** Write-only; stored AES-256-GCM encrypted. Pass `null` to clear. */
    password?: string | null;
    from_address?: string | null;
  };
  registration?: Partial<RegistrationSettings>;
  gateway?: {
    /**
     * Absolute `http(s)` origin with no path, query or credentials; a trailing
     * slash is stripped. `null` clears the stored value and falls back to
     * `FERRUM_GATEWAY_PUBLIC_URL`.
     */
    public_url?: string | null;
  };
}

/** `PUT /api/admin/settings` */
export type UpdateSettingsResponse = AdminSettingsResponse;

/** `POST /api/admin/settings/smtp-test` */
export interface SmtpTestRequest {
  /** Where to send the probe message; defaults to the calling admin's email. */
  to_email?: string;
}

/** `POST /api/admin/settings/smtp-test` */
export interface SmtpTestResponse {
  ok: boolean;
  /** Failure detail when `ok` is false. */
  error: string | null;
}

/** `GET /api/admin/email-templates/:key` */
export interface GetEmailTemplateResponse {
  template: EmailTemplate;
  /** Placeholder names the template may interpolate, e.g. `portal_name`. */
  available_variables: string[];
}

/** `PUT /api/admin/email-templates/:key` */
export interface UpdateEmailTemplateRequest {
  subject: string;
  body_html: string;
  body_text: string;
}

/** `PUT /api/admin/email-templates/:key` */
export interface UpdateEmailTemplateResponse {
  template: EmailTemplate;
}

/** `GET /api/admin/email-templates` */
export interface ListEmailTemplatesResponse {
  templates: EmailTemplate[];
  keys: EmailTemplateKey[];
}

/** `POST /api/admin/mass-email` — enqueues one outbox row per recipient. */
export interface MassEmailRequest {
  subject: string;
  body_html: string;
  body_text: string;
  /** Audience selector; combined with AND when several are supplied. */
  audience: MassEmailAudience;
  /** Reuse of a key makes the send idempotent (at-most-once). */
  idempotency_key?: string;
}

/** Who receives a mass email. */
export interface MassEmailAudience {
  /** `all` ignores the other filters. */
  scope: 'all' | 'filtered' | 'explicit';
  roles?: Role[];
  status?: UserStatus;
  org_id?: Uuid;
  /** Explicit recipients; used when `scope` is `explicit`. */
  user_ids?: Uuid[];
}

/** `POST /api/admin/mass-email` */
export interface MassEmailResponse {
  /** Number of outbox rows enqueued (duplicates suppressed by idempotency key). */
  enqueued: number;
  /** Recipients matched by the audience selector. */
  recipients: number;
}

/** `GET /api/admin/audit-logs` */
export interface ListAuditLogsQuery extends ListQuery {
  actor_user_id?: Uuid;
  action?: string;
  target_type?: string;
  target_id?: string;
  /** Inclusive lower bound (ISO-8601). */
  from?: IsoTimestamp;
  /** Exclusive upper bound (ISO-8601). */
  to?: IsoTimestamp;
}

/** `GET /api/admin/audit-logs` */
export type ListAuditLogsResponse = Paginated<AuditLog>;

/* ── Admin: god mode (super_admin only) ─────────────────────────────────── */

/** `POST /api/admin/god/revoke-grant` — emergency revoke, bypasses ownership. */
export interface GodRevokeGrantRequest {
  grant_id: Uuid;
  reason: string;
}

/** `POST /api/admin/god/revoke-grant` */
export interface GodRevokeGrantResponse {
  grant: Grant;
}

/** `POST /api/admin/god/delete-api` — removes the API and its Edge proxy. */
export interface GodDeleteApiRequest {
  api_id: Uuid;
  reason: string;
  /** Also revoke every active grant for the API. */
  revoke_grants?: boolean;
}

/** `POST /api/admin/god/delete-api` */
export interface GodDeleteApiResponse {
  deleted_api_id: Uuid;
  revoked_grants: number;
}

/** `POST /api/admin/god/disable-user` — refused for the last active super_admin. */
export interface GodDisableUserRequest {
  user_id: Uuid;
  reason: string;
  /** Also revoke every active grant held by the user. */
  revoke_grants?: boolean;
}

/** `POST /api/admin/god/disable-user` */
export interface GodDisableUserResponse {
  user: User;
  revoked_grants: number;
  /** Sessions destroyed as part of the disablement. */
  terminated_sessions: number;
  /**
   * Gateway revocation outcome. `pending` means the credentials are still live
   * on Edge and the teardown worker is retrying — the disable is not finished.
   */
  gateway_teardown: GatewayTeardownOutcome;
}

/** `POST /api/admin/god/broadcast` — platform message to many users at once. */
export interface GodBroadcastRequest {
  subject: string;
  body: string;
  audience: MassEmailAudience;
  /** Also enqueue an email alongside the in-app notification. */
  send_email?: boolean;
}

/** `POST /api/admin/god/broadcast` */
export interface GodBroadcastResponse {
  notified: number;
  emails_enqueued: number;
  threads_created: number;
}

/* ── Public branding ────────────────────────────────────────────────────── */

/** `GET /api/branding` — unauthenticated; drives the login page and theme. */
export interface BrandingResponse extends BrandingSettings {
  /** Echoed so the SPA can bootstrap the theme before authenticating. */
  default_theme: ThemePreference;
  captcha: CaptchaPublicConfig;
}
