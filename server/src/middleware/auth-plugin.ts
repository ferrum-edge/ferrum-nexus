import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { SessionService } from '../auth/session.js';
import { isStateChanging, verifyCsrf } from '../auth/session.js';

/**
 * Resolve the session for every request and enforce CSRF on state-changing
 * requests *if* a session exists. Routes that need authentication should still
 * call `requireAuth(req)` to enforce that an authenticated user is present.
 */
export function registerAuthPlugin(app: FastifyInstance, sessions: SessionService): void {
  app.addHook('preHandler', async (req: FastifyRequest) => {
    const auth = await sessions.resolveSession(req);
    if (auth) {
      req.auth = auth;
      if (isStateChanging(req.method) && !isCsrfExempt(req.url)) {
        verifyCsrf(req);
      }
    }
  });
}

const CSRF_EXEMPT_PREFIXES = ['/api/auth/login', '/api/auth/register', '/api/auth/forgot-password'];

function isCsrfExempt(url: string): boolean {
  // Login/registration cannot present a CSRF token yet (no session); they are
  // rate-limited instead.
  return CSRF_EXEMPT_PREFIXES.some((p) => url.startsWith(p));
}
