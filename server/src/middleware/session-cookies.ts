/**
 * The one place that knows how the session cookie pair is written and cleared.
 *
 * Three callers share it and must not drift apart: `/api/auth` (login,
 * register, logout, and the single sign-on callback), `/api/users` (a password
 * change re-issues the session), and the auth plugin's sliding-expiration
 * hook, which re-stamps the pair whenever it extends the session row. Keeping
 * the flags in a single module is what makes "the cookie lifetime always
 * matches the row" checkable. The short-lived single sign-on attempt cookie
 * is written here too, under the same no-cache rule.
 *
 * It also owns the rule that keeps those cookies out of shared caches: a
 * response carrying `Set-Cookie` is never cacheable. The pair is a bearer
 * credential, so a proxy or CDN that stored one response and replayed it to
 * another client would hand that client the session. {@link setSessionCookies}
 * and {@link clearSessionCookies} mark their reply at once, and
 * {@link responseCachingHook}, the root `onSend` hook, re-applies the rule to
 * every response as it leaves, whatever directive a handler wrote meanwhile.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  SSO_TRANSACTION_COOKIE,
  SSO_TRANSACTION_COOKIE_PATH,
  SSO_TRANSACTION_TTL_SECONDS,
} from '@ferrum-nexus/shared';

import type { NexusConfig } from '../config/index.js';
import { isApiRequest } from './api-route.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * The route answers with a response shared caches may store (it sets its
     * own `Cache-Control: public`). The auth plugin never slides the session on
     * such a route, so the handler's response carries no session cookies; if a
     * cookie is set anyway, {@link responseCachingHook} makes it uncacheable.
     */
    sharedCacheable?: boolean;
  }
}

/** The `Cache-Control` of every response that sets or clears a cookie. */
export const COOKIE_RESPONSE_CACHE_CONTROL = 'private, no-store';

/** The `Cache-Control` of every other `/api` response that does not set its own. */
export const API_DEFAULT_CACHE_CONTROL = 'no-store';

/** Append `Cookie` to the reply's `Vary` unless it is already covered. */
function varyOnCookie(reply: FastifyReply): void {
  const current = reply.getHeader('vary');
  const joined = Array.isArray(current) ? current.join(',') : String(current ?? '');
  const values = joined
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (values.some((value) => value === '*' || value.toLowerCase() === 'cookie')) return;
  reply.header('vary', [...values, 'Cookie'].join(', '));
}

/**
 * Make the reply unstorable by any cache: `private, no-store`, overriding any
 * directive already set (a `public` one included), plus `Vary: Cookie`.
 */
export function forbidResponseCaching(reply: FastifyReply): void {
  reply.header('cache-control', COOKIE_RESPONSE_CACHE_CONTROL);
  varyOnCookie(reply);
}

/**
 * Root `onSend` hook: the final say on a response's cacheability.
 *
 * - Any response carrying `Set-Cookie` (200, 304 and errors alike) is forced to
 *   {@link COOKIE_RESPONSE_CACHE_CONTROL}, replacing whatever the handler set.
 * - Any other `/api` response without its own directive gets
 *   {@link API_DEFAULT_CACHE_CONTROL}.
 *
 * This hook sees headers set through Fastify's reply API. Raw response headers
 * (`reply.raw.setHeader` or `writeHead`) and hijacked replies bypass this hook;
 * those paths must not set cookies. No such path exists today.
 *
 * It must be added after `@fastify/cookie` is registered: that plugin
 * serializes `reply.setCookie` calls into the `Set-Cookie` header in its own
 * root `onSend` hook, and Fastify runs hooks in registration order, so by the
 * time this one runs every cookie the request set is visible as a header.
 */
export async function responseCachingHook(
  request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
): Promise<unknown> {
  if (reply.hasHeader('set-cookie')) {
    forbidResponseCaching(reply);
  } else if (isApiRequest(request) && !reply.hasHeader('cache-control')) {
    reply.header('cache-control', API_DEFAULT_CACHE_CONTROL);
  }
  return payload;
}

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
  forbidResponseCaching(reply);
}

/** Clear the session pair on sign-out. */
export function clearSessionCookies(reply: FastifyReply, config: NexusConfig): void {
  const base = { path: '/', sameSite: 'lax' as const, secure: config.cookieSecure };
  reply.clearCookie(SESSION_COOKIE, { ...base, httpOnly: true });
  reply.clearCookie(CSRF_COOKIE, { ...base, httpOnly: false });
  forbidResponseCaching(reply);
}

/**
 * Write the sealed single sign-on attempt (`nexus_sso`).
 *
 * HttpOnly, scoped to `/api/auth/sso` so no other route ever receives it, and
 * alive only as long as one attempt may take. `SameSite=Lax` rather than
 * `Strict` on purpose: the provider sends the browser back with a top-level
 * cross-site `GET`, and a `Strict` cookie would not come with it. What makes
 * the callback safe against a forged response is not the cookie's reach but
 * its content — the sealed `state` the response has to match.
 */
export function setSsoTransactionCookie(
  reply: FastifyReply,
  config: NexusConfig,
  sealed: string,
): void {
  reply.setCookie(SSO_TRANSACTION_COOKIE, sealed, {
    path: SSO_TRANSACTION_COOKIE_PATH,
    sameSite: 'lax',
    secure: config.cookieSecure,
    httpOnly: true,
    maxAge: SSO_TRANSACTION_TTL_SECONDS,
  });
  forbidResponseCaching(reply);
}

/** Clear the single sign-on attempt: every callback spends it, whatever the outcome. */
export function clearSsoTransactionCookie(reply: FastifyReply, config: NexusConfig): void {
  reply.clearCookie(SSO_TRANSACTION_COOKIE, {
    path: SSO_TRANSACTION_COOKIE_PATH,
    sameSite: 'lax',
    secure: config.cookieSecure,
    httpOnly: true,
  });
  forbidResponseCaching(reply);
}
