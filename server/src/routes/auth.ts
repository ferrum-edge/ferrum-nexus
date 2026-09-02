/**
 * `/api/auth` — register, login, logout, me, verify-email, captcha config.
 *
 * Routes never import service modules: everything arrives through the plugin
 * registration options. Cookie policy lives in
 * `../middleware/session-cookies.js`, shared with the sliding-expiration hook.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import {
  MIN_PASSWORD_LENGTH,
  REGISTRABLE_ROLES,
  type CaptchaConfigResponse,
  type LoginResponse,
  type LogoutResponse,
  type MeResponse,
  type RegisterResponse,
  type VerifyEmailResponse,
} from '@ferrum-nexus/shared';

import type { AuthService } from '../auth/service.js';
import type { CaptchaService } from '../auth/captcha.js';
import type { NexusConfig } from '../config/index.js';
import { requestContext, requireAuth } from '../middleware/auth-plugin.js';
import { clearSessionCookies, setSessionCookies } from '../middleware/session-cookies.js';
import { parseOrThrow } from '../middleware/error-handler.js';

/** Services this route plugin needs. */
export interface AuthRoutesOptions {
  config: NexusConfig;
  auth: AuthService;
  captcha: CaptchaService;
}

const registerBody = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(1024),
  display_name: z.string().trim().min(1).max(200),
  role: z.enum(REGISTRABLE_ROLES),
  company: z.string().trim().max(200).nullish(),
  phone: z.string().trim().max(64).nullish(),
  captcha_token: z.string().max(4096).optional(),
});

const loginBody = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(1).max(1024),
  captcha_token: z.string().max(4096).optional(),
});

const verifyEmailBody = z.object({
  token: z.string().trim().min(8).max(512),
});

/** `/api/auth` route plugin. */
export const authRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (app, options) => {
  const { config, auth, captcha } = options;

  app.post('/register', async (request, reply): Promise<RegisterResponse> => {
    const input = parseOrThrow(registerBody, request.body);
    const result = await auth.register(
      {
        email: input.email,
        password: input.password,
        display_name: input.display_name,
        role: input.role,
        company: input.company ?? null,
        phone: input.phone ?? null,
        captcha_token: input.captcha_token,
      },
      requestContext(request),
    );
    if (result.issued) setSessionCookies(reply, config, result.issued);
    reply.status(201);
    return { user: result.user, email_verification_required: result.emailVerificationRequired };
  });

  app.post('/login', async (request, reply): Promise<LoginResponse> => {
    const input = parseOrThrow(loginBody, request.body);
    const result = await auth.login(input, requestContext(request));
    setSessionCookies(reply, config, result.issued);
    return {
      user: result.user,
      csrf_token: result.issued.csrfToken,
      expires_at: result.issued.expiresAt,
    };
  });

  app.post('/logout', async (request, reply): Promise<LogoutResponse> => {
    // CSRF is enforced for this route by the auth plugin — signing someone out
    // is a state change like any other.
    const { user, session } = requireAuth(request);
    await auth.logout(session, user, requestContext(request));
    clearSessionCookies(reply, config);
    return { ok: true };
  });

  app.get('/me', async (request): Promise<MeResponse> => {
    const { user, session } = requireAuth(request);
    return auth.me(user, session);
  });

  app.post('/verify-email', async (request): Promise<VerifyEmailResponse> => {
    const input = parseOrThrow(verifyEmailBody, request.body);
    return auth.verifyEmail(input.token, requestContext(request));
  });

  app.get('/captcha', async (): Promise<CaptchaConfigResponse> => captcha.getPublicConfig());
};
