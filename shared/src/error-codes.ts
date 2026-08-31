/**
 * Stable machine-readable error codes.
 *
 * Every Nexus backend error responds with `{ error: { code, message, details? } }`
 * where `code` is one of these values. Codes are part of the public API
 * contract — never rename one, only add.
 */
export const ERROR_CODES = {
  /** Request body/query/params failed schema validation. HTTP 400. */
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  /** No valid session, or the session expired. HTTP 401. */
  UNAUTHORIZED: 'UNAUTHORIZED',
  /** Authenticated but the role or ownership check failed. HTTP 403. */
  FORBIDDEN: 'FORBIDDEN',
  /** Target resource does not exist (or is not visible to the caller). HTTP 404. */
  NOT_FOUND: 'NOT_FOUND',
  /** Uniqueness or state conflict (duplicate email, slug, active grant). HTTP 409. */
  CONFLICT: 'CONFLICT',
  /** `X-Nexus-CSRF` header missing or not matching the `nexus_csrf` cookie. HTTP 403. */
  CSRF_MISMATCH: 'CSRF_MISMATCH',
  /** CAPTCHA token missing, expired, or rejected by the provider. HTTP 400. */
  CAPTCHA_FAILED: 'CAPTCHA_FAILED',
  /** Too many requests from this identity/IP. HTTP 429. */
  RATE_LIMITED: 'RATE_LIMITED',
  /** Account exists but its email address has not been verified yet. HTTP 403. */
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',
  /** Account has been disabled by an admin. HTTP 403. */
  USER_DISABLED: 'USER_DISABLED',
  /** Refused: would remove, demote, or disable the last active super_admin. HTTP 409. */
  LAST_SUPER_ADMIN: 'LAST_SUPER_ADMIN',
  /** Show-once credential material was already retrieved and cannot be shown again. HTTP 410. */
  SHOW_ONCE_ALREADY: 'SHOW_ONCE_ALREADY',
  /** Ferrum Edge Admin API unreachable (network error / timeout). HTTP 502. */
  EDGE_UNAVAILABLE: 'EDGE_UNAVAILABLE',
  /** Ferrum Edge Admin API returned an error response. HTTP 502. */
  EDGE_ERROR: 'EDGE_ERROR',
  /** Uploaded OpenAPI document could not be parsed or failed validation. HTTP 400. */
  SPEC_INVALID: 'SPEC_INVALID',
  /** Email could not be enqueued or exhausted its outbox retries. HTTP 500. */
  OUTBOX_FAILURE: 'OUTBOX_FAILURE',
  /** Unexpected server-side failure. HTTP 500. */
  INTERNAL: 'INTERNAL',
} as const;

/** Union of every stable error code. */
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** All error codes as a readonly array (useful for exhaustive tests/validation). */
export const ALL_ERROR_CODES = Object.values(ERROR_CODES) as readonly ErrorCode[];

/** Runtime type guard for {@link ErrorCode}. */
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ALL_ERROR_CODES as readonly string[]).includes(value);
}

/** Default HTTP status paired with each error code by the server error handler. */
export const ERROR_CODE_STATUS: Readonly<Record<ErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  CSRF_MISMATCH: 403,
  CAPTCHA_FAILED: 400,
  RATE_LIMITED: 429,
  EMAIL_NOT_VERIFIED: 403,
  USER_DISABLED: 403,
  LAST_SUPER_ADMIN: 409,
  SHOW_ONCE_ALREADY: 410,
  EDGE_UNAVAILABLE: 502,
  EDGE_ERROR: 502,
  SPEC_INVALID: 400,
  OUTBOX_FAILURE: 500,
  INTERNAL: 500,
};
