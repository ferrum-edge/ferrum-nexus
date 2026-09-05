/**
 * Typed client for the Nexus HTTP API.
 *
 * Every function here maps 1:1 onto a route from the design document's "HTTP
 * API" section and is typed with the DTOs from `@ferrum-nexus/shared` — the SPA
 * never declares its own wire shapes.
 *
 * Transport rules:
 * - same-origin `/api` prefix, cookies always sent (`credentials: 'include'`);
 * - non-GET requests echo the readable `nexus_csrf` cookie in the
 *   `X-Nexus-CSRF` header (double-submit CSRF);
 * - a non-2xx response is parsed into {@link ApiError};
 * - a 401 fires the registered unauthorized handler so the auth store can tear
 *   its state down and bounce to /login.
 */

import {
  CSRF_COOKIE,
  CSRF_HEADER,
  ERROR_CODES,
  isErrorCode,
  type AdminSettingsResponse,
  type ApiUsageResponse,
  type ApproveAccessRequestResponse,
  type BrandingResponse,
  type CancelAccessRequestResponse,
  type CaptchaConfigResponse,
  type CatalogDetailResponse,
  type CatalogListQuery,
  type CatalogListResponse,
  type CatalogSpecResponse,
  type CreateAccessRequestRequest,
  type CreateAccessRequestResponse,
  type CreateOrganizationRequest,
  type CreateOrganizationResponse,
  type CreateTestConsumerRequest,
  type CreateTestConsumerResponse,
  type CreateThreadRequest,
  type CreateThreadResponse,
  type DecideAccessRequestRequest,
  type DeleteApiPluginResponse,
  type DeleteApiResponse,
  type DeleteCredentialResponse,
  type DenyAccessRequestResponse,
  type EdgeHealthResponse,
  type EmailTemplateKey,
  type ErrorCode,
  type ForgotPasswordRequest,
  type ForgotPasswordResponse,
  type GetApiResponse,
  type GetEmailTemplateResponse,
  type GetMeUserResponse,
  type GetThreadQuery,
  type GetThreadResponse,
  type GetUserResponse,
  type GodBroadcastRequest,
  type GodBroadcastResponse,
  type GodDeleteApiRequest,
  type GodDeleteApiResponse,
  type GodDisableUserRequest,
  type GodDisableUserResponse,
  type GodRevokeGrantRequest,
  type GodRevokeGrantResponse,
  type HealthResponse,
  type IssueCredentialRequest,
  type IssueCredentialResponse,
  type ListAccessRequestsQuery,
  type ListAccessRequestsResponse,
  type ListApiPluginsResponse,
  type ListApisQuery,
  type ListApisResponse,
  type ListAuditLogsQuery,
  type ListAuditLogsResponse,
  type ListCredentialsQuery,
  type ListCredentialsResponse,
  type ListEmailTemplatesResponse,
  type ListGrantsQuery,
  type ListGrantsResponse,
  type ListNotificationsQuery,
  type ListNotificationsResponse,
  type ListOrganizationsQuery,
  type ListOrganizationsResponse,
  type ListThreadMessagesQuery,
  type ListThreadMessagesResponse,
  type ListThreadsQuery,
  type ListThreadsResponse,
  type ListUsersQuery,
  type ListUsersResponse,
  type LoginRequest,
  type LoginResponse,
  type LogoutResponse,
  type MarkNotificationsReadRequest,
  type MarkNotificationsReadResponse,
  type MassEmailRequest,
  type MassEmailResponse,
  type MeResponse,
  type PublishApiRequest,
  type PublishApiResponse,
  type RegisterRequest,
  type RegisterResponse,
  type ResendVerificationRequest,
  type ResendVerificationResponse,
  type ResetPasswordRequest,
  type ResetPasswordResponse,
  type RetryGatewayTeardownResponse,
  type RevokeGrantRequest,
  type RevokeGrantResponse,
  type ReconcileCredentialsRequest,
  type ReconcileCredentialsResponse,
  type RotateCredentialRequest,
  type RotateCredentialResponse,
  type SendMessageRequest,
  type SendMessageResponse,
  type SetApiPluginRequest,
  type SetApiPluginResponse,
  type SmtpTestRequest,
  type SmtpTestResponse,
  type UpdateApiRequest,
  type UpdateApiResponse,
  type UpdateApiSpecRequest,
  type UpdateApiSpecResponse,
  type UpdateEmailTemplateRequest,
  type UpdateEmailTemplateResponse,
  type UpdateMeRequest,
  type UpdateMeResponse,
  type UpdateSettingsRequest,
  type UpdateSettingsResponse,
  type UpdateUserRequest,
  type UpdateUserResponse,
  type VerifyEmailRequest,
  type VerifyEmailResponse,
} from '@ferrum-nexus/shared';

/** Base path every request is prefixed with. */
export const API_BASE = '/api';

/** An error response from the Nexus API, carrying its stable machine code. */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, status: number, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }

  /** True when `err` is an {@link ApiError}, narrowing the type. */
  static is(err: unknown): err is ApiError {
    return err instanceof ApiError;
  }

  /** True when `err` is an {@link ApiError} carrying one of `codes`. */
  static hasCode(err: unknown, ...codes: ErrorCode[]): boolean {
    return err instanceof ApiError && codes.includes(err.code);
  }
}

type UnauthorizedHandler = () => void;

let unauthorizedHandler: UnauthorizedHandler | null = null;

/**
 * Register the callback fired whenever any request comes back 401. The auth
 * store installs itself here so a stale session tears down global state exactly
 * once, wherever the 401 surfaced.
 */
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler;
}

/** Read a document cookie by name, or `null` when absent/unreadable. */
export function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const prefix = `${name}=`;
  for (const part of document.cookie.split(';')) {
    const entry = part.trim();
    if (entry.startsWith(prefix)) {
      return decodeURIComponent(entry.slice(prefix.length));
    }
  }
  return null;
}

/** A value acceptable as a query-string parameter. */
type QueryValue = string | number | boolean | null | undefined | readonly string[];

/** Serialise a query object, dropping `undefined`/`null` entries. */
export function buildQuery(params: Record<string, QueryValue> | undefined): string {
  if (!params) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const item of value) search.append(key, item);
    } else {
      search.set(key, String(value));
    }
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

interface RequestOptions {
  query?: Record<string, QueryValue>;
  body?: unknown;
  signal?: AbortSignal;
  /** Suppress the global 401 handler — used by the auth bootstrap probe. */
  skipUnauthorizedHandler?: boolean;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

async function parseErrorBody(
  response: Response,
): Promise<{ code: ErrorCode; message: string; details?: unknown }> {
  const fallbackCode: ErrorCode =
    response.status === 401
      ? ERROR_CODES.UNAUTHORIZED
      : response.status === 403
        ? ERROR_CODES.FORBIDDEN
        : response.status === 404
          ? ERROR_CODES.NOT_FOUND
          : ERROR_CODES.INTERNAL;
  const text = await response.text().catch(() => '');
  if (!text) {
    return { code: fallbackCode, message: `Request failed with status ${response.status}` };
  }
  try {
    // The body shape is validated below, so `unknown` is narrowed by hand.
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && 'error' in parsed) {
      const envelope = (parsed as { error: unknown }).error;
      if (envelope && typeof envelope === 'object') {
        const { code, message, details } = envelope as {
          code?: unknown;
          message?: unknown;
          details?: unknown;
        };
        return {
          code: isErrorCode(code) ? code : fallbackCode,
          message:
            typeof message === 'string' && message.length > 0
              ? message
              : `Request failed with status ${response.status}`,
          details,
        };
      }
    }
  } catch {
    /* Not JSON — fall through to the raw text below. */
  }
  return { code: fallbackCode, message: text.slice(0, 500) };
}

/** Issue a request against the Nexus API and decode its JSON response. */
export async function request<T>(
  method: string,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const headers = new Headers({ Accept: 'application/json' });
  const init: RequestInit = { method, credentials: 'include', headers };

  if (options.body !== undefined) {
    headers.set('Content-Type', 'application/json');
    init.body = JSON.stringify(options.body);
  }
  if (!SAFE_METHODS.has(method.toUpperCase())) {
    const csrf = readCookie(CSRF_COOKIE);
    if (csrf) headers.set(CSRF_HEADER, csrf);
  }
  if (options.signal) init.signal = options.signal;

  const response = await fetch(`${API_BASE}${path}${buildQuery(options.query)}`, init);

  if (!response.ok) {
    const { code, message, details } = await parseErrorBody(response);
    if (response.status === 401 && !options.skipUnauthorizedHandler) {
      unauthorizedHandler?.();
    }
    throw new ApiError(code, message, response.status, details);
  }

  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

const get = <T>(path: string, query?: Record<string, QueryValue>, signal?: AbortSignal) =>
  request<T>('GET', path, { query, signal });
const post = <T>(path: string, body?: unknown) => request<T>('POST', path, { body });
const put = <T>(path: string, body?: unknown) => request<T>('PUT', path, { body });
const patch = <T>(path: string, body?: unknown) => request<T>('PATCH', path, { body });
const del = <T>(path: string) => request<T>('DELETE', path);

/* ── Health ─────────────────────────────────────────────────────────────── */

export const healthApi = {
  get: (): Promise<HealthResponse> => get<HealthResponse>('/health'),
  edge: (): Promise<EdgeHealthResponse> => get<EdgeHealthResponse>('/health/edge'),
};

/* ── Auth ───────────────────────────────────────────────────────────────── */

export const authApi = {
  register: (body: RegisterRequest): Promise<RegisterResponse> =>
    post<RegisterResponse>('/auth/register', body),
  login: (body: LoginRequest): Promise<LoginResponse> => post<LoginResponse>('/auth/login', body),
  logout: (): Promise<LogoutResponse> => post<LogoutResponse>('/auth/logout'),
  me: (): Promise<MeResponse> => request<MeResponse>('GET', '/auth/me'),
  /** Bootstrap probe: a 401 here is an expected "not signed in", not a teardown. */
  meSilent: (): Promise<MeResponse> =>
    request<MeResponse>('GET', '/auth/me', { skipUnauthorizedHandler: true }),
  verifyEmail: (body: VerifyEmailRequest): Promise<VerifyEmailResponse> =>
    post<VerifyEmailResponse>('/auth/verify-email', body),
  /**
   * Ask for a fresh verification link.
   *
   * Resolves with `{ ok: true }` even for an address with no account — the
   * server deliberately says nothing about who exists, so the UI must not
   * present the result as confirmation that the address is registered.
   */
  resendVerification: (body: ResendVerificationRequest): Promise<ResendVerificationResponse> =>
    post<ResendVerificationResponse>('/auth/resend-verification', body),
  /** Ask for a password-reset link. Same uninformative contract as above. */
  forgotPassword: (body: ForgotPasswordRequest): Promise<ForgotPasswordResponse> =>
    post<ForgotPasswordResponse>('/auth/forgot-password', body),
  /** Redeem a reset link. On success every session of the account is gone. */
  resetPassword: (body: ResetPasswordRequest): Promise<ResetPasswordResponse> =>
    post<ResetPasswordResponse>('/auth/reset-password', body),
  captcha: (): Promise<CaptchaConfigResponse> => get<CaptchaConfigResponse>('/auth/captcha'),
};

/* ── Users & organizations ──────────────────────────────────────────────── */

export const usersApi = {
  me: (): Promise<GetMeUserResponse> => get<GetMeUserResponse>('/users/me'),
  updateMe: (body: UpdateMeRequest): Promise<UpdateMeResponse> =>
    patch<UpdateMeResponse>('/users/me', body),
  list: (query: ListUsersQuery = {}): Promise<ListUsersResponse> =>
    get<ListUsersResponse>('/users', { ...query }),
  get: (id: string): Promise<GetUserResponse> =>
    get<GetUserResponse>(`/users/${encodeURIComponent(id)}`),
  update: (id: string, body: UpdateUserRequest): Promise<UpdateUserResponse> =>
    patch<UpdateUserResponse>(`/users/${encodeURIComponent(id)}`, body),
  retryGatewayTeardown: (id: string): Promise<RetryGatewayTeardownResponse> =>
    post<RetryGatewayTeardownResponse>(`/users/${encodeURIComponent(id)}/gateway-teardown/retry`),
};

export const organizationsApi = {
  list: (query: ListOrganizationsQuery = {}): Promise<ListOrganizationsResponse> =>
    get<ListOrganizationsResponse>('/organizations', { ...query }),
  create: (body: CreateOrganizationRequest): Promise<CreateOrganizationResponse> =>
    post<CreateOrganizationResponse>('/organizations', body),
};

/* ── Catalog ────────────────────────────────────────────────────────────── */

export const catalogApi = {
  list: (query: CatalogListQuery = {}): Promise<CatalogListResponse> =>
    get<CatalogListResponse>('/catalog', { ...query }),
  detail: (slug: string): Promise<CatalogDetailResponse> =>
    get<CatalogDetailResponse>(`/catalog/${encodeURIComponent(slug)}`),
  spec: (slug: string): Promise<CatalogSpecResponse> =>
    get<CatalogSpecResponse>(`/catalog/${encodeURIComponent(slug)}/spec`),
};

/* ── Publishing (provider) ──────────────────────────────────────────────── */

export const apisApi = {
  list: (query: ListApisQuery = {}): Promise<ListApisResponse> =>
    get<ListApisResponse>('/apis', { ...query }),
  get: (id: string): Promise<GetApiResponse> =>
    get<GetApiResponse>(`/apis/${encodeURIComponent(id)}`),
  /** Gateway counters and backend state; answers 200 even when Edge is down. */
  usage: (id: string): Promise<ApiUsageResponse> =>
    get<ApiUsageResponse>(`/apis/${encodeURIComponent(id)}/usage`),
  publish: (body: PublishApiRequest): Promise<PublishApiResponse> =>
    post<PublishApiResponse>('/apis', body),
  update: (id: string, body: UpdateApiRequest): Promise<UpdateApiResponse> =>
    patch<UpdateApiResponse>(`/apis/${encodeURIComponent(id)}`, body),
  remove: (id: string): Promise<DeleteApiResponse> =>
    del<DeleteApiResponse>(`/apis/${encodeURIComponent(id)}`),
  updateSpec: (id: string, body: UpdateApiSpecRequest): Promise<UpdateApiSpecResponse> =>
    put<UpdateApiSpecResponse>(`/apis/${encodeURIComponent(id)}/spec`, body),
  createTestConsumer: (
    id: string,
    body: CreateTestConsumerRequest = {},
  ): Promise<CreateTestConsumerResponse> =>
    post<CreateTestConsumerResponse>(`/apis/${encodeURIComponent(id)}/test-consumer`, body),

  /* ── Plugin palette ─────────────────────────────────────────────────── */
  //
  // Only the *state* crosses the wire: which palette plugins this API has on,
  // and how each is configured. The palette itself — the plugins, their fields
  // and their bounds — is the static `PROVIDER_PLUGINS` catalog the SPA imports
  // from `@ferrum-nexus/shared`, so there is nothing to fetch for it.

  listPlugins: (id: string): Promise<ListApiPluginsResponse> =>
    get<ListApiPluginsResponse>(`/apis/${encodeURIComponent(id)}/plugins`),
  setPlugin: (id: string, name: string, body: SetApiPluginRequest): Promise<SetApiPluginResponse> =>
    put<SetApiPluginResponse>(
      `/apis/${encodeURIComponent(id)}/plugins/${encodeURIComponent(name)}`,
      body,
    ),
  removePlugin: (id: string, name: string): Promise<DeleteApiPluginResponse> =>
    del<DeleteApiPluginResponse>(
      `/apis/${encodeURIComponent(id)}/plugins/${encodeURIComponent(name)}`,
    ),
};

/* ── Access requests & grants ───────────────────────────────────────────── */

export const accessRequestsApi = {
  list: (query: ListAccessRequestsQuery = {}): Promise<ListAccessRequestsResponse> =>
    get<ListAccessRequestsResponse>('/access-requests', { ...query }),
  create: (body: CreateAccessRequestRequest): Promise<CreateAccessRequestResponse> =>
    post<CreateAccessRequestResponse>('/access-requests', body),
  cancel: (id: string): Promise<CancelAccessRequestResponse> =>
    post<CancelAccessRequestResponse>(`/access-requests/${encodeURIComponent(id)}/cancel`),
  approve: (
    id: string,
    body: DecideAccessRequestRequest = {},
  ): Promise<ApproveAccessRequestResponse> =>
    post<ApproveAccessRequestResponse>(`/access-requests/${encodeURIComponent(id)}/approve`, body),
  deny: (id: string, body: DecideAccessRequestRequest = {}): Promise<DenyAccessRequestResponse> =>
    post<DenyAccessRequestResponse>(`/access-requests/${encodeURIComponent(id)}/deny`, body),
};

export const grantsApi = {
  list: (query: ListGrantsQuery = {}): Promise<ListGrantsResponse> =>
    get<ListGrantsResponse>('/grants', { ...query }),
  revoke: (id: string, body: RevokeGrantRequest = {}): Promise<RevokeGrantResponse> =>
    post<RevokeGrantResponse>(`/grants/${encodeURIComponent(id)}/revoke`, body),
};

/* ── Credentials ────────────────────────────────────────────────────────── */

export const credentialsApi = {
  list: (query: ListCredentialsQuery = {}): Promise<ListCredentialsResponse> =>
    get<ListCredentialsResponse>('/credentials', { ...query }),
  issue: (body: IssueCredentialRequest): Promise<IssueCredentialResponse> =>
    post<IssueCredentialResponse>('/credentials', body),
  rotate: (id: string, body: RotateCredentialRequest = {}): Promise<RotateCredentialResponse> =>
    post<RotateCredentialResponse>(`/credentials/${encodeURIComponent(id)}/rotate`, body),
  remove: (id: string): Promise<DeleteCredentialResponse> =>
    del<DeleteCredentialResponse>(`/credentials/${encodeURIComponent(id)}`),
};

/* ── Messaging ──────────────────────────────────────────────────────────── */

export const threadsApi = {
  list: (query: ListThreadsQuery = {}): Promise<ListThreadsResponse> =>
    get<ListThreadsResponse>('/threads', { ...query }),
  create: (body: CreateThreadRequest): Promise<CreateThreadResponse> =>
    post<CreateThreadResponse>('/threads', body),
  get: (id: string, query: GetThreadQuery = {}): Promise<GetThreadResponse> =>
    get<GetThreadResponse>(`/threads/${encodeURIComponent(id)}`, { ...query }),
  /** One older window of a conversation, for "load older messages". */
  messages: (
    id: string,
    query: ListThreadMessagesQuery = {},
  ): Promise<ListThreadMessagesResponse> =>
    get<ListThreadMessagesResponse>(`/threads/${encodeURIComponent(id)}/messages`, { ...query }),
  sendMessage: (id: string, body: SendMessageRequest): Promise<SendMessageResponse> =>
    post<SendMessageResponse>(`/threads/${encodeURIComponent(id)}/messages`, body),
};

/* ── Notifications ──────────────────────────────────────────────────────── */

export const notificationsApi = {
  list: (query: ListNotificationsQuery = {}): Promise<ListNotificationsResponse> =>
    get<ListNotificationsResponse>('/notifications', { ...query }),
  markRead: (body: MarkNotificationsReadRequest): Promise<MarkNotificationsReadResponse> =>
    post<MarkNotificationsReadResponse>('/notifications/read', body),
};

/* ── Admin ──────────────────────────────────────────────────────────────── */

export const adminApi = {
  getSettings: (): Promise<AdminSettingsResponse> => get<AdminSettingsResponse>('/admin/settings'),
  updateSettings: (body: UpdateSettingsRequest): Promise<UpdateSettingsResponse> =>
    put<UpdateSettingsResponse>('/admin/settings', body),
  smtpTest: (body: SmtpTestRequest = {}): Promise<SmtpTestResponse> =>
    post<SmtpTestResponse>('/admin/settings/smtp-test', body),
  listEmailTemplates: (): Promise<ListEmailTemplatesResponse> =>
    get<ListEmailTemplatesResponse>('/admin/email-templates'),
  getEmailTemplate: (key: EmailTemplateKey): Promise<GetEmailTemplateResponse> =>
    get<GetEmailTemplateResponse>(`/admin/email-templates/${encodeURIComponent(key)}`),
  updateEmailTemplate: (
    key: EmailTemplateKey,
    body: UpdateEmailTemplateRequest,
  ): Promise<UpdateEmailTemplateResponse> =>
    put<UpdateEmailTemplateResponse>(`/admin/email-templates/${encodeURIComponent(key)}`, body),
  massEmail: (body: MassEmailRequest): Promise<MassEmailResponse> =>
    post<MassEmailResponse>('/admin/mass-email', body),
  auditLogs: (query: ListAuditLogsQuery = {}): Promise<ListAuditLogsResponse> =>
    get<ListAuditLogsResponse>('/admin/audit-logs', { ...query }),
  reconcileCredentials: (
    body: ReconcileCredentialsRequest,
  ): Promise<ReconcileCredentialsResponse> =>
    post<ReconcileCredentialsResponse>('/admin/credentials/reconcile', body),
};

/* ── Admin: god mode (super_admin only) ─────────────────────────────────── */

export const godApi = {
  revokeGrant: (body: GodRevokeGrantRequest): Promise<GodRevokeGrantResponse> =>
    post<GodRevokeGrantResponse>('/admin/god/revoke-grant', body),
  deleteApi: (body: GodDeleteApiRequest): Promise<GodDeleteApiResponse> =>
    post<GodDeleteApiResponse>('/admin/god/delete-api', body),
  disableUser: (body: GodDisableUserRequest): Promise<GodDisableUserResponse> =>
    post<GodDisableUserResponse>('/admin/god/disable-user', body),
  broadcast: (body: GodBroadcastRequest): Promise<GodBroadcastResponse> =>
    post<GodBroadcastResponse>('/admin/god/broadcast', body),
};

/* ── Public branding ────────────────────────────────────────────────────── */

export const brandingApi = {
  get: (): Promise<BrandingResponse> => get<BrandingResponse>('/branding'),
};
