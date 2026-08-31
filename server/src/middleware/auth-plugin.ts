/**
 * Session resolution, CSRF enforcement and RBAC guards.
 *
 * The plugin adds two hooks to the root instance:
 *
 * 1. `onRequest` — resolve the `nexus_session` cookie into `request.session`
 *    and `request.currentUser`, applying expiry, account-status and sliding
 *    expiration rules. It never rejects: an anonymous request simply carries
 *    `null`, and the route's own guard decides whether that is acceptable.
 * 2. `onRequest` (after the first) — enforce the double-submit CSRF check on
 *    every mutating `/api` request that carries a session, except the
 *    pre-authentication auth endpoints.
 *
 * CSRF is bound to the session, not merely double-submitted: the
 * `X-Nexus-CSRF` header must equal the `nexus_csrf` cookie **and** the
 * `csrf_token` stored on the session row. Logout is deliberately **not**
 * exempt — it is a state change like any other.
 */

import { timingSafeEqual } from 'node:crypto';

import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
} from 'fastify';

import {
  CSRF_COOKIE,
  CSRF_HEADER_LOWER,
  SESSION_COOKIE,
  roleAtLeast,
  type Role,
} from '@ferrum-nexus/shared';

import type { NexusConfig } from '../config/index.js';
import type { NexusStore, SessionRecord, UserRecord } from '../db/store.js';
import type { NexusCrypto } from '../lib/crypto.js';
import { csrfMismatch, forbidden, unauthorized, userDisabled } from '../lib/errors.js';
import { isoInSeconds } from '../lib/ids.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** The authenticated account, or `null` for an anonymous request. */
    currentUser: UserRecord | null;
    /** The live session row backing `currentUser`, or `null`. */
    session: SessionRecord | null;
  }
}

/** Dependencies the auth plugin needs from the composition root. */
export interface AuthPluginOptions {
  config: NexusConfig;
  store: NexusStore;
  crypto: NexusCrypto;
}

/**
 * Routes exempt from CSRF because they are reached before a session exists.
 * Logout is *not* here on purpose.
 */
export const CSRF_EXEMPT_PATHS: readonly string[] = [
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/verify-email',
  '/api/auth/captcha',
];

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** An authenticated principal: the session row plus its account. */
export interface AuthContext {
  user: UserRecord;
  session: SessionRecord;
}

function safeEqual(a: string | undefined, b: string | undefined): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** Path of the request without its query string. */
function pathOf(request: FastifyRequest): string {
  const index = request.url.indexOf('?');
  return index === -1 ? request.url : request.url.slice(0, index);
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const raw = request.headers[name];
  if (Array.isArray(raw)) return raw[0];
  return typeof raw === 'string' ? raw : undefined;
}

/**
 * Session resolution + CSRF plugin.
 *
 * Registered with `skip-override` so its request decorators and hooks apply to
 * the whole server rather than an encapsulated child scope (this is what
 * `fastify-plugin` does; Nexus does it inline to avoid the dependency).
 */
const authPlugin: FastifyPluginAsync<AuthPluginOptions> = async (app, options) => {
  const { config, store, crypto } = options;

  app.decorateRequest('currentUser', null);
  app.decorateRequest('session', null);

  app.addHook('onRequest', async (request: FastifyRequest) => {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return;

    const session = await store.sessions.findByTokenHash(crypto.hashToken(token));
    if (!session) return;

    const now = Date.now();
    if (Date.parse(session.expires_at) <= now) {
      await store.sessions.delete(session.id);
      return;
    }

    const user = await store.users.findById(session.user_id);
    if (!user || user.status !== 'active') {
      // A disabled or deleted account must not keep a usable session.
      await store.sessions.deleteForUser(session.user_id);
      return;
    }

    request.session = session;
    request.currentUser = user;

    // Sliding expiration: only write when less than half the TTL remains, so a
    // busy SPA does not issue one UPDATE per request.
    const remainingMs = Date.parse(session.expires_at) - now;
    if (remainingMs < (config.sessionTtlSeconds * 1000) / 2) {
      const expiresAt = isoInSeconds(config.sessionTtlSeconds);
      await store.sessions.touch(session.id, expiresAt);
      request.session = { ...session, expires_at: expiresAt };
    }
  });

  app.addHook('onRequest', async (request: FastifyRequest) => {
    if (SAFE_METHODS.has(request.method)) return;
    const path = pathOf(request);
    if (!path.startsWith('/api')) return;
    if (CSRF_EXEMPT_PATHS.includes(path)) return;
    // Anonymous mutations are rejected by the route's own auth guard with 401;
    // there is no session-bound token to compare against yet.
    if (!request.session) return;

    const header = headerValue(request, CSRF_HEADER_LOWER);
    const cookie = request.cookies[CSRF_COOKIE];
    if (!safeEqual(header, cookie) || !safeEqual(header, request.session.csrf_token)) {
      throw csrfMismatch();
    }
  });
};

// Fastify's encapsulation escape hatch — the same marker `fastify-plugin` sets.
Object.defineProperty(authPlugin, Symbol.for('skip-override'), { value: true });
Object.defineProperty(authPlugin, Symbol.for('fastify.display-name'), { value: 'nexus-auth' });

export { authPlugin };

/** Register the auth plugin on `app`. */
export async function registerAuthPlugin(
  app: FastifyInstance,
  options: AuthPluginOptions,
): Promise<void> {
  await app.register(authPlugin, options);
}

/* ── Guards ─────────────────────────────────────────────────────────────── */

/**
 * Assert that the request is authenticated and return the principal.
 *
 * Throws `UNAUTHORIZED` when there is no live session and `USER_DISABLED` when
 * the account was disabled between requests.
 */
export function requireAuth(request: FastifyRequest): AuthContext {
  const user = request.currentUser;
  const session = request.session;
  if (!user || !session) throw unauthorized();
  if (user.status !== 'active') throw userDisabled();
  return { user, session };
}

/** `onRequest`/`preHandler` hook form of {@link requireAuth}. */
export const requireAuthHook: onRequestHookHandler = (
  request: FastifyRequest,
  _reply: FastifyReply,
  done: (error?: Error) => void,
) => {
  try {
    requireAuth(request);
    done();
  } catch (error) {
    done(error as Error);
  }
};

/**
 * Guard requiring at least `role` (roles are strictly ordered, so `admin`
 * satisfies a `provider` requirement).
 */
export function requireRole(role: Role): onRequestHookHandler {
  return (request: FastifyRequest, _reply: FastifyReply, done: (error?: Error) => void) => {
    try {
      const { user } = requireAuth(request);
      if (!roleAtLeast(user.role, role)) {
        throw forbidden(`This action requires the ${role} role`);
      }
      done();
    } catch (error) {
      done(error as Error);
    }
  };
}

/** Assert a minimum role imperatively, from inside a handler or service call. */
export function assertRole(request: FastifyRequest, role: Role): AuthContext {
  const context = requireAuth(request);
  if (!roleAtLeast(context.user.role, role)) {
    throw forbidden(`This action requires the ${role} role`);
  }
  return context;
}

/** Client IP, honouring `X-Forwarded-For` only when `NEXUS_TRUST_PROXY` is set. */
export function clientIp(request: FastifyRequest): string | null {
  return request.ip ?? null;
}
