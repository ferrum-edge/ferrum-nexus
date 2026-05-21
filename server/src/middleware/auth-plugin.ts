import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { SessionService } from '../auth/session.js';
import { isStateChanging, verifyCsrf } from '../auth/session.js';

// Routes that legitimately can't enforce CSRF — the SPA bootstraps from these
// before it owns a token (the token endpoint itself) or these are server-side
// callbacks that have their own integrity check. Keep this list short.
const CSRF_EXEMPT_PATHS = new Set<string>([
  '/api/csrf-token',
  '/api/health',
]);

/**
 * Resolve the session for every request and enforce CSRF on every
 * state-changing request — both authenticated and anonymous. Anonymous
 * mutations use the double-submit cookie (`verifyCsrf` checks the
 * `nexus_csrf` cookie when there is no session). Routes that require an
 * authenticated user should still call `requireAuth(req)`.
 */
export function registerAuthPlugin(app: FastifyInstance, sessions: SessionService): void {
  app.addHook('preHandler', async (req: FastifyRequest) => {
    const auth = await sessions.resolveSession(req);
    if (auth) req.auth = auth;
    if (isStateChanging(req.method) && !CSRF_EXEMPT_PATHS.has(req.routeOptions?.url ?? req.url)) {
      verifyCsrf(req);
    }
  });
}
