/**
 * Session plumbing.
 *
 * Sessions are server-side rows in the `sessions` table. The client receives
 * only an opaque session id in an HttpOnly cookie; a separate CSRF cookie is
 * readable by JS so the SPA can echo it back in the `X-Nexus-CSRF` header on
 * state-changing requests.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { v4 as uuid } from 'uuid';
import { constantTimeEqual, randomToken } from '../lib/crypto.js';
import type { ResolvedConfig } from '../config/index.js';
import type { NexusStore } from '../db/store.js';
import type { UserRole, UserStatus } from '@ferrum-nexus/shared';
import { unauthorized, forbidden } from '../lib/errors.js';
import { SESSION_COOKIE_NAME, CSRF_COOKIE, CSRF_HEADER } from '@ferrum-nexus/shared';

export interface AuthenticatedUser {
  id: string;
  email: string;
  status: UserStatus;
  roles: UserRole[];
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Populated by `attachAuth`. Undefined for anonymous requests. */
    auth?: AuthenticatedUser;
  }
}

export function isStateChanging(method: string): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
}

export interface SessionService {
  createSession(opts: {
    userId: string;
    userAgent: string | null;
    ip: string | null;
  }): Promise<{ sessionId: string; csrfToken: string; expiresAt: string }>;
  destroySession(sessionId: string): Promise<void>;
  destroyAllForUser(userId: string): Promise<void>;
  resolveSession(req: FastifyRequest): Promise<AuthenticatedUser | null>;
  setCookies(reply: FastifyReply, sessionId: string, csrfToken: string, expiresAt: string): void;
  clearCookies(reply: FastifyReply): void;
  /**
   * Issue a CSRF token for use on anonymous mutations (register/login/password
   * reset). The token is bound to a random value placed in the `nexus_csrf`
   * cookie; the SPA reads the cookie and echoes the value in the
   * `X-Nexus-CSRF` header. The double-submit pattern prevents a cross-origin
   * site from forging the request because it can't read the cookie.
   */
  setAnonymousCsrfCookie(reply: FastifyReply): string;
}

export function createSessionService(
  config: ResolvedConfig,
  store: NexusStore,
): SessionService {
  return {
    async createSession({ userId, userAgent, ip }) {
      const sessionId = uuid();
      const csrfToken = randomToken(24);
      const now = new Date();
      const expires = new Date(now.getTime() + config.session.ttlSeconds * 1000);
      await store.sessions.create({
        id: sessionId,
        user_id: userId,
        csrf_token: csrfToken,
        user_agent: userAgent,
        ip,
        created_at: now.toISOString(),
        expires_at: expires.toISOString(),
      });
      return { sessionId, csrfToken, expiresAt: expires.toISOString() };
    },
    async destroySession(sessionId) {
      await store.sessions.delete(sessionId);
    },
    async destroyAllForUser(userId) {
      await store.sessions.deleteForUser(userId);
    },
    async resolveSession(req) {
      const sid = req.cookies[config.session.cookieName ?? SESSION_COOKIE_NAME];
      if (!sid) return null;
      const session = await store.sessions.find(sid);
      if (!session) return null;
      if (new Date(session.expires_at).getTime() < Date.now()) {
        await store.sessions.delete(sid);
        return null;
      }
      const user = await store.users.findById(session.user_id);
      if (!user || user.status === 'disabled') return null;
      const roles = await store.userRoles.forUser(user.id);
      // Stash csrf token on the request so middleware can compare.
      (req as FastifyRequest & { _sessionCsrf?: string })._sessionCsrf = session.csrf_token;
      return {
        id: user.id,
        email: user.email,
        status: user.status,
        roles,
      };
    },
    setCookies(reply, sessionId, csrfToken, expiresAt) {
      const maxAge = Math.max(1, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
      reply.setCookie(config.session.cookieName, sessionId, {
        path: '/',
        httpOnly: true,
        secure: config.session.secure,
        sameSite: 'lax',
        maxAge,
      });
      reply.setCookie(CSRF_COOKIE, csrfToken, {
        path: '/',
        httpOnly: false,
        secure: config.session.secure,
        sameSite: 'lax',
        maxAge,
      });
    },
    clearCookies(reply) {
      reply.clearCookie(config.session.cookieName, { path: '/' });
      reply.clearCookie(CSRF_COOKIE, { path: '/' });
    },
    setAnonymousCsrfCookie(reply) {
      const token = randomToken(24);
      reply.setCookie(CSRF_COOKIE, token, {
        path: '/',
        httpOnly: false,
        secure: config.session.secure,
        sameSite: 'lax',
        // One hour is enough to complete a login or registration; if the user
        // takes longer, the SPA simply re-fetches /api/csrf-token.
        maxAge: 3600,
      });
      return token;
    },
  };
}

/** Require a session. Throws 401 if missing. */
export function requireAuth(req: FastifyRequest): AuthenticatedUser {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

/** Require any one of the listed roles. */
export function requireRole(req: FastifyRequest, ...roles: UserRole[]): AuthenticatedUser {
  const user = requireAuth(req);
  if (!roles.some((r) => user.roles.includes(r))) {
    throw forbidden('Insufficient role');
  }
  return user;
}

/**
 * Compare the request's CSRF header to the value bound to the requester.
 *
 * For authenticated requests the bound value is the session's `csrf_token`.
 * For anonymous mutations (register, login, password reset) we use a
 * double-submit cookie: the SPA reads the `nexus_csrf` cookie (set by
 * `setAnonymousCsrfCookie`) and echoes it in the header. A cross-origin
 * attacker cannot read the cookie under our `SameSite=Lax` policy, so they
 * cannot forge the header.
 */
export function verifyCsrf(req: FastifyRequest): void {
  if (!isStateChanging(req.method)) return;
  const header = req.headers[CSRF_HEADER] || req.headers[CSRF_HEADER.toLowerCase()];
  const provided = Array.isArray(header) ? header[0] : header;
  if (!provided) throw forbidden('CSRF token missing');

  const sessionCsrf = (req as FastifyRequest & { _sessionCsrf?: string })._sessionCsrf;
  const expected = sessionCsrf ?? req.cookies[CSRF_COOKIE];
  if (!expected) throw forbidden('CSRF token missing');
  if (!constantTimeEqual(provided, expected)) {
    throw forbidden('CSRF token mismatch');
  }
}
