/**
 * `/api/auth` — register, login, logout, me, email verification, password
 * recovery, captcha config.
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
  type ForgotPasswordResponse,
  type LoginResponse,
  type LogoutResponse,
  type MeResponse,
  type RegisterResponse,
  type ResendVerificationResponse,
  type ResetPasswordResponse,
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

/**
 * Shared by `resend-verification` and `forgot-password`.
 *
 * Same shape as the login body's email so a malformed address is rejected the
 * same way in all three, rather than becoming a second thing the response can
 * say about an address.
 */
const emailOnlyBody = z.object({
  email: z.string().trim().email().max(320),
});

const resetPasswordBody = z.object({
  token: z.string().trim().min(8).max(512),
  new_password: z.string().min(MIN_PASSWORD_LENGTH).max(1024),
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

  // The three routes below are anonymous and deliberately uninformative: each
  // answers `{ ok: true }` whatever it decided to do, so neither status, body
  // nor timing tells the caller whether the address has an account. The
  // `/api/auth/*` rate limiter is what bounds how fast they can be asked.

  app.post('/resend-verification', async (request): Promise<ResendVerificationResponse> => {
    const input = parseOrThrow(emailOnlyBody, request.body);
    await auth.resendVerification(input.email, requestContext(request));
    return { ok: true };
  });

  app.post('/forgot-password', async (request): Promise<ForgotPasswordResponse> => {
    const input = parseOrThrow(emailOnlyBody, request.body);
    await auth.requestPasswordReset(input.email, requestContext(request));
    return { ok: true };
  });

  app.post('/reset-password', async (request, reply): Promise<ResetPasswordResponse> => {
    const input = parseOrThrow(resetPasswordBody, request.body);
    await auth.resetPassword(input.token, input.new_password, requestContext(request));
    // Every session of the account was just destroyed server-side. If this
    // browser was holding one of them, its cookies are now dead weight that
    // would only produce a confusing 401 on the next page.
    clearSessionCookies(reply, config);
    return { ok: true };
  });

  app.get('/captcha', async (): Promise<CaptchaConfigResponse> => captcha.getPublicConfig());
};
