/**
 * `/api/auth` — register, login, logout, me, email verification, password
 * recovery, captcha config, and OpenID Connect single sign-on.
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
  SSO_PROVIDER_ID_PATTERN,
  SSO_TRANSACTION_COOKIE,
  type CaptchaConfigResponse,
  type ForgotPasswordResponse,
  type LoginResponse,
  type LogoutResponse,
  type MeResponse,
  type RegisterResponse,
  type ResendVerificationResponse,
  type ResetPasswordResponse,
  type SsoPublicConfigResponse,
  type StartSsoLinkResponse,
  type VerifyEmailResponse,
} from '@ferrum-nexus/shared';

import type { AuthService } from '../auth/service.js';
import type { CaptchaService } from '../auth/captcha.js';
import type { NexusConfig } from '../config/index.js';
import { requestContext, requireAuth } from '../middleware/auth-plugin.js';
import {
  clearSessionCookies,
  clearSsoTransactionCookie,
  setSessionCookies,
  setSsoTransactionCookie,
} from '../middleware/session-cookies.js';
import { parseOrThrow } from '../middleware/error-handler.js';
import type { SsoService } from '../sso/service.js';

/** Services this route plugin needs. */
export interface AuthRoutesOptions {
  config: NexusConfig;
  auth: AuthService;
  sso: SsoService;
}

const registerBody = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(1024),
  display_name: z.string().trim().min(1).max(200),
  role: z.enum(REGISTRABLE_ROLES),
  company: z.string().trim().max(200).nullish(),
  phone: z.string().trim().max(64).nullish(),
  captcha_token: z.string().max(4096).optional(),
  // Required by the service while the portal is empty; the shape is not the
  // place to say so, since "is the portal empty" is not a property of the body.
  bootstrap_token: z.string().max(512).optional(),
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

const ssoProviderParams = z.object({
  provider: z.string().regex(new RegExp(SSO_PROVIDER_ID_PATTERN)),
});

const ssoStartQuery = z.object({ return_to: z.string().max(512).optional() });

/**
 * What a provider sends back. Unknown parameters (`session_state`, `iss`,
 * `scope`, …) are ignored; the error description is never read, because it
 * is free text the provider controls.
 */
const ssoCallbackQuery = z.object({
  code: z.string().min(1).max(4096).optional(),
  state: z.string().min(1).max(512).optional(),
  error: z.string().max(256).optional(),
});

/** `/api/auth` route plugin. */
export const authRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (app, options) => {
  const { config, auth, sso } = options;

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
        bootstrap_token: input.bootstrap_token,
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

  app.post('/verify-email', async (request): Promise<VerifyEmailResponse> => {
    const input = parseOrThrow(verifyEmailBody, request.body);
    return auth.verifyEmail(input.token, requestContext(request));
  });

  // The three routes below are anonymous and deliberately uninformative: each
  // answers `{ ok: true }` whatever it decided to do, so neither status, body
  // nor timing tells the caller whether the address has an account. The
  // shared sensitive-auth rate limiter bounds how fast they can be asked.

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

  // Single sign-on. Both routes are top-level browser navigations, so they
  // answer with redirects — to the provider, back into the SPA, or to the
  // sign-in page with `?sso_error=<reason>` — never with JSON. Both are GETs,
  // outside the CSRF check by method; what binds a callback to the browser
  // that started it is the sealed `state` in the `nexus_sso` cookie.

  app.get('/sso/:provider/start', async (request, reply) => {
    const params = ssoProviderParams.safeParse(request.params);
    const query = ssoStartQuery.safeParse(request.query);
    const result = await sso.start(
      params.success ? params.data.provider : '',
      query.success ? query.data.return_to : undefined,
    );
    if (result.transaction !== null) {
      setSsoTransactionCookie(reply, config, result.transaction);
    }
    return reply.redirect(result.location, 302);
  });

  app.get('/sso/:provider/callback', async (request, reply) => {
    // Spent whatever happens next: a second callback with the same attempt
    // finds nothing to match.
    const transaction = request.cookies[SSO_TRANSACTION_COOKIE];
    clearSsoTransactionCookie(reply, config);
    const params = ssoProviderParams.safeParse(request.params);
    const query = ssoCallbackQuery.safeParse(request.query);
    const current =
      request.session && request.currentUser
        ? { userId: request.currentUser.id, sessionId: request.session.id }
        : null;
    const result = await sso.callback(
      params.success ? params.data.provider : '',
      // A malformed query is a callback nobody can finish, and reads as one
      // with no state at all.
      query.success ? query.data : {},
      transaction,
      current,
      requestContext(request),
    );
    if (result.ok) setSessionCookies(reply, config, result.issued);
    return reply.redirect(result.location, 302);
  });

  // Linking the signed-in account: a POST under the session and its CSRF
  // token, so a cross-site page cannot start one. The attempt is sealed with
  // this account and session, and the callback attaches the identity only when
  // it returns to them. The SPA then navigates the browser to `location`.
  app.post('/sso/:provider/link', async (request, reply): Promise<StartSsoLinkResponse> => {
    const { user, session } = requireAuth(request);
    const { provider } = parseOrThrow(ssoProviderParams, request.params);
    const started = await sso.startLink(provider, { userId: user.id, sessionId: session.id });
    setSsoTransactionCookie(reply, config, started.transaction);
    return { location: started.location };
  });
};

/** Read-only bootstrap routes registered under their own rate-limit scope. */
export const authBootstrapRoutes: FastifyPluginAsync<{
  auth: AuthService;
  captcha: CaptchaService;
  sso: SsoService;
}> = async (app, { auth, captcha, sso }) => {
  app.get('/me', async (request): Promise<MeResponse> => {
    const { user, session } = requireAuth(request);
    return auth.me(user, session);
  });

  app.get('/captcha', async (): Promise<CaptchaConfigResponse> => captcha.getPublicConfig());

  // What the sign-in page offers: the login policy and the enabled providers.
  app.get('/sso', async (): Promise<SsoPublicConfigResponse> => sso.publicConfig());
};
