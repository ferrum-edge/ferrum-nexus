/**
 * The one place that knows how the session cookie pair is written and cleared.
 *
 * Three callers share it and must not drift apart: `/api/auth` (login,
 * register, logout), `/api/users` (a password change re-issues the session),
 * and the auth plugin's sliding-expiration hook, which re-stamps the pair
 * whenever it extends the session row. Keeping the flags in a single module is
 * what makes "the cookie lifetime always matches the row" checkable.
 */

import type { FastifyReply } from 'fastify';

import { CSRF_COOKIE, SESSION_COOKIE } from '@ferrum-nexus/shared';

import type { NexusConfig } from '../config/index.js';

/**
 * The material written to the cookie pair. `IssuedSession` satisfies this
 * structurally; the sliding-expiration hook builds one from the request cookie
 * and the stored `csrf_token`.
 */
export interface SessionCookieMaterial {
  /** Opaque token for the HttpOnly `nexus_session` cookie. */
  token: string;
  /** Double-submit token for the readable `nexus_csrf` cookie. */
  csrfToken: string;
}

/**
 * Write the session pair.
 *
 * `nexus_session` is HttpOnly (bearer-equivalent); `nexus_csrf` deliberately is
 * not, because the double-submit check needs the browser to read it. Both are
 * `SameSite=Lax`, path `/`, and `Secure` unless `NEXUS_COOKIE_SECURE=false`
 * (the default outside `NEXUS_ENV=development`).
 *
 * `Max-Age` is always the full session TTL, so a re-issue after a slide moves
 * the browser's expiry forward in step with the `sessions.expires_at` row.
 */
export function setSessionCookies(
  reply: FastifyReply,
  config: NexusConfig,
  issued: SessionCookieMaterial,
): void {
  const base = {
    path: '/',
    sameSite: 'lax' as const,
    secure: config.cookieSecure,
    maxAge: config.sessionTtlSeconds,
  };
  reply.setCookie(SESSION_COOKIE, issued.token, { ...base, httpOnly: true });
  reply.setCookie(CSRF_COOKIE, issued.csrfToken, { ...base, httpOnly: false });
}

/** Clear the session pair on sign-out. */
export function clearSessionCookies(reply: FastifyReply, config: NexusConfig): void {
  const base = { path: '/', sameSite: 'lax' as const, secure: config.cookieSecure };
  reply.clearCookie(SESSION_COOKIE, { ...base, httpOnly: true });
  reply.clearCookie(CSRF_COOKIE, { ...base, httpOnly: false });
}
