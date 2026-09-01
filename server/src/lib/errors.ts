/**
 * The single error type every Nexus route, service and adapter throws.
 *
 * Codes come from `@ferrum-nexus/shared` so the browser, the server and the
 * docs all agree on one closed set; the HTTP status is looked up from
 * `ERROR_CODE_STATUS` rather than being passed around by hand.
 */

import { ERROR_CODE_STATUS, type ErrorCode } from '@ferrum-nexus/shared';

/** Structured, machine-classifiable error surfaced as `{ error: { code, message, details? } }`. */
export class NexusError extends Error {
  /** Stable machine code from the shared catalog. */
  readonly code: ErrorCode;

  /** HTTP status the error handler responds with. */
  readonly statusCode: number;

  /** Optional structured context (validation issues, conflicting field, …). */
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions | undefined);
    this.name = 'NexusError';
    this.code = code;
    this.statusCode = ERROR_CODE_STATUS[code];
    this.details = details;
    Error.captureStackTrace?.(this, NexusError);
  }

  /** JSON body fragment for this error (never includes the stack or the cause). */
  toBody(): { code: ErrorCode; message: string; details?: unknown } {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }
}

/** Type guard: is `value` a {@link NexusError}? */
export function isNexusError(value: unknown): value is NexusError {
  return value instanceof NexusError;
}

/* ── Helper constructors ────────────────────────────────────────────────── */

/** 400 — request body/query/params failed schema validation. */
export function validationFailed(
  message = 'Request validation failed',
  details?: unknown,
): NexusError {
  return new NexusError('VALIDATION_FAILED', message, details);
}

/** 401 — no session, or the session expired. */
export function unauthorized(message = 'Authentication required'): NexusError {
  return new NexusError('UNAUTHORIZED', message);
}

/** 403 — authenticated, but the role or ownership check failed. */
export function forbidden(
  message = 'You do not have permission to perform this action',
): NexusError {
  return new NexusError('FORBIDDEN', message);
}

/** 403 — `X-Nexus-CSRF` missing or not matching the `nexus_csrf` cookie/session. */
export function csrfMismatch(message = 'CSRF token missing or invalid'): NexusError {
  return new NexusError('CSRF_MISMATCH', message);
}

/** 404 — target resource does not exist, or is not visible to the caller. */
export function notFound(what = 'Resource', id?: string): NexusError {
  return new NexusError(
    'NOT_FOUND',
    id ? `${what} '${id}' was not found` : `${what} was not found`,
  );
}

/** 409 — uniqueness or state conflict. */
export function conflict(message: string, details?: unknown): NexusError {
  return new NexusError('CONFLICT', message, details);
}

/** 400 — CAPTCHA token missing, expired or rejected by the provider. */
export function captchaFailed(message = 'CAPTCHA verification failed'): NexusError {
  return new NexusError('CAPTCHA_FAILED', message);
}

/** 403 — the account exists but its email address is not verified yet. */
export function emailNotVerified(message = 'Email address has not been verified'): NexusError {
  return new NexusError('EMAIL_NOT_VERIFIED', message);
}

/** 403 — the account has been disabled by an administrator. */
export function userDisabled(message = 'This account has been disabled'): NexusError {
  return new NexusError('USER_DISABLED', message);
}

/** 409 — the operation would remove, demote or disable the last active super_admin. */
export function lastSuperAdmin(
  message = 'The last active super admin cannot be removed, demoted or disabled',
): NexusError {
  return new NexusError('LAST_SUPER_ADMIN', message);
}

/** 410 — show-once credential material was already retrieved. */
export function showOnceAlready(
  message = 'This secret was already shown and cannot be shown again',
): NexusError {
  return new NexusError('SHOW_ONCE_ALREADY', message);
}

/**
 * 502 — the Ferrum Edge Admin API could not be reached (DNS, connect, TLS,
 * socket or timeout). Never carries upstream text; the cause is logged.
 */
export function edgeUnavailable(
  message = 'The Ferrum Edge Admin API is unreachable',
  cause?: unknown,
): NexusError {
  return new NexusError('EDGE_UNAVAILABLE', message, undefined, { cause });
}

/**
 * 502 — the Ferrum Edge Admin API answered with an error status. The upstream
 * `{"error": "..."}` text is logged by the client, never echoed to browsers.
 */
export function edgeError(
  message = 'The Ferrum Edge Admin API rejected the request',
  details?: unknown,
): NexusError {
  return new NexusError('EDGE_ERROR', message, details);
}

/** 400 — uploaded OpenAPI document could not be parsed or failed validation. */
export function specInvalid(message: string, details?: unknown): NexusError {
  return new NexusError('SPEC_INVALID', message, details);
}

/** 500 — email could not be enqueued, or exhausted its outbox retries. */
export function outboxFailure(message = 'Email could not be queued for delivery'): NexusError {
  return new NexusError('OUTBOX_FAILURE', message);
}

/** 500 — unexpected server-side failure. The message is never sent verbatim to clients. */
export function internal(message = 'Internal server error', cause?: unknown): NexusError {
  return new NexusError('INTERNAL', message, undefined, { cause });
}
