import type { FastifyInstance } from 'fastify';
import type { ResolvedConfig } from '../config/index.js';
import type { UsersService } from '../users/service.js';
import type { SessionService } from '../auth/session.js';
import { LoginInput, RegistrationInput } from '../users/service.js';
import { z } from 'zod';
import { badRequest, unauthorized } from '../lib/errors.js';
import { requireAuth } from '../auth/session.js';
import type { SettingsService } from '../admin/settings-service.js';
import { verifyCaptchaIfEnabled } from '../auth/captcha.js';
import { auditActorFromRequest } from '../audit/service.js';

const AUTH_RATE_LIMIT = {
  config: {
    rateLimit: {
      max: 20,
      timeWindow: '1 minute',
    },
  },
};

export async function registerAuthRoutes(
  app: FastifyInstance,
  opts: {
    config: ResolvedConfig;
    users: UsersService;
    sessions: SessionService;
    settings: SettingsService;
  },
): Promise<void> {
  const { config, users, sessions, settings } = opts;

  app.post('/api/auth/register', AUTH_RATE_LIMIT, async (req, reply) => {
    const cfg = await settings.public();
    if (!cfg.registrationEnabled) {
      throw badRequest('registration_disabled', 'Registration is currently disabled');
    }
    const input = RegistrationInput.parse(req.body);
    await verifyCaptchaIfEnabled(settings, input.captchaToken, req.ip);
    const { user, verifyToken, requiresAdminApproval } = await users.register(
      input,
      auditActorFromRequest(req),
    );
    // Don't auto-login on register when email verification is required.
    if (!verifyToken && !requiresAdminApproval) {
      const session = await sessions.createSession({
        userId: user.id,
        userAgent: req.headers['user-agent'] ?? null,
        ip: req.ip ?? null,
      });
      sessions.setCookies(reply, session.sessionId, session.csrfToken, session.expiresAt);
    }
    reply.status(201).send({ user, requiresVerification: !!verifyToken, requiresAdminApproval });
  });

  app.post('/api/auth/login', AUTH_RATE_LIMIT, async (req, reply) => {
    const input = LoginInput.parse(req.body);
    const user = await users.login(input);
    const session = await sessions.createSession({
      userId: user.id,
      userAgent: req.headers['user-agent'] ?? null,
      ip: req.ip ?? null,
    });
    sessions.setCookies(reply, session.sessionId, session.csrfToken, session.expiresAt);
    reply.send({ user });
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const sid = req.cookies[config.session.cookieName];
    if (sid) await sessions.destroySession(sid);
    sessions.clearCookies(reply);
    reply.status(204).send();
  });

  app.post('/api/auth/verify-email', AUTH_RATE_LIMIT, async (req, reply) => {
    const { token } = z.object({ token: z.string() }).parse(req.body);
    const user = await users.verifyEmail(token);
    reply.send({ user });
  });

  app.post('/api/auth/forgot-password', AUTH_RATE_LIMIT, async (req, reply) => {
    const { email } = z.object({ email: z.string().email() }).parse(req.body);
    await users.startPasswordReset(email);
    // Always return success to avoid disclosing whether the email exists.
    reply.status(202).send({ ok: true });
  });

  app.post('/api/auth/reset-password', AUTH_RATE_LIMIT, async (req, reply) => {
    const { token, password } = z
      .object({ token: z.string(), password: z.string().min(8) })
      .parse(req.body);
    await users.completePasswordReset(token, password);
    reply.status(204).send();
  });

  app.post('/api/auth/change-password', async (req, reply) => {
    const user = requireAuth(req);
    const { currentPassword, newPassword } = z
      .object({ currentPassword: z.string(), newPassword: z.string().min(8) })
      .parse(req.body);
    await users.updatePassword(user.id, currentPassword, newPassword);
    // Destroy all sessions so other devices are logged out.
    await sessions.destroyAllForUser(user.id);
    sessions.clearCookies(reply);
    reply.status(204).send();
  });

  app.get('/api/me', async (req, reply) => {
    if (!req.auth) throw unauthorized();
    const user = await users.loadById(req.auth.id);
    reply.send({ user });
  });

  app.put('/api/me/contact', async (req, reply) => {
    const user = requireAuth(req);
    const patch = z
      .object({ name: z.string().min(1).max(255).optional(), phone: z.string().max(64).optional() })
      .parse(req.body);
    const updated = await users.updateContact(user.id, patch);
    reply.send({ user: updated });
  });

  app.get('/api/public/settings', async (_req, reply) => {
    const settingsPublic = await settings.public();
    reply.send(settingsPublic);
  });

  // Anonymous CSRF bootstrap. The SPA calls this before submitting any
  // anonymous mutation (register, login, forgot-password, reset-password) to
  // pick up a `nexus_csrf` cookie + token value. The response body returns the
  // token for convenience but the cookie is the source of truth — the
  // double-submit check in `verifyCsrf` reads the cookie, not the body.
  app.get('/api/csrf-token', async (_req, reply) => {
    const token = sessions.setAnonymousCsrfCookie(reply);
    reply.send({ token });
  });
}
