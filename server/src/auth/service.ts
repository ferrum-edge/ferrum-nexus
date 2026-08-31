/**
 * Registration, sign-in, sign-out and email verification.
 *
 * Rules enforced here rather than in the routes, so every caller gets them:
 *
 * - Email addresses are unique case-insensitively and stored lowercased.
 * - **The first account ever created becomes `super_admin` and is
 *   automatically email-verified**; later accounts get the registrable role
 *   they asked for (`client` or `provider`) and nothing more.
 * - Passwords are scrypt-hashed; verification is constant-time and a missing
 *   account still costs one hash so sign-in does not leak which emails exist.
 * - Every successful register/login/logout/verify writes an audit row.
 */

import {
  EMAIL_VERIFICATION_TTL_SECONDS,
  MIN_PASSWORD_LENGTH,
  isRegistrableRole,
  roleAtLeast,
  type Capabilities,
  type RegistrableRole,
  type Role,
  type User,
} from '@ferrum-nexus/shared';

import { AuditAction, ANONYMOUS_ACTOR, type AuditService } from '../audit/service.js';
import type { NexusConfig } from '../config/index.js';
import type { NexusStore, SessionRecord, UserRecord } from '../db/store.js';
import type { NexusCrypto } from '../lib/crypto.js';
import {
  conflict,
  emailNotVerified,
  forbidden,
  unauthorized,
  userDisabled,
  validationFailed,
} from '../lib/errors.js';
import { isoInSeconds, nowIso } from '../lib/ids.js';
import type { CaptchaService } from './captcha.js';

/** `app_settings` key holding the registration policy. */
export const REGISTRATION_SETTINGS_KEY = 'registration';

/** Stored registration policy, with the defaults applied when unset. */
export interface RegistrationPolicy {
  open_registration: boolean;
  require_email_verification: boolean;
  allowed_roles: Role[];
}

/**
 * Well-formed scrypt hash that no password matches, used to equalise sign-in
 * timing when the email address does not exist.
 */
const DECOY_PASSWORD_HASH = `scrypt:16384:8:1:AAAAAAAAAAAAAAAAAAAAAA==:${'A'.repeat(43)}=`;

const DEFAULT_REGISTRATION_POLICY: RegistrationPolicy = {
  open_registration: true,
  require_email_verification: false,
  allowed_roles: ['client', 'provider'],
};

/** Per-request context recorded on sessions and audit rows. */
export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
}

/** A newly issued session and the values the browser must receive. */
export interface IssuedSession {
  session: SessionRecord;
  /** Opaque token for the HttpOnly `nexus_session` cookie. Only the hash is stored. */
  token: string;
  /** Double-submit token for the `nexus_csrf` cookie and the `X-Nexus-CSRF` header. */
  csrfToken: string;
  expiresAt: string;
}

/** Input for {@link AuthService.register}. */
export interface RegisterInput {
  email: string;
  password: string;
  display_name: string;
  role: RegistrableRole;
  company?: string | null;
  phone?: string | null;
  captcha_token?: string | undefined;
}

/** Result of {@link AuthService.register}. */
export interface RegisterResult {
  user: User;
  /** True when sign-in is blocked until the emailed link is used. */
  emailVerificationRequired: boolean;
  /** Present only when verification was not required, so the user lands signed in. */
  issued: IssuedSession | null;
}

/** Input for {@link AuthService.login}. */
export interface LoginInput {
  email: string;
  password: string;
  captcha_token?: string | undefined;
}

/** Result of {@link AuthService.login}. */
export interface LoginResult {
  user: User;
  issued: IssuedSession;
}

/**
 * Hook invoked after a successful registration, before the response is sent.
 *
 * The email service is composed later in the build; until it exists this stays
 * `undefined` and the verification token is simply not delivered. When wired,
 * enqueue the `verification` template with `verificationToken` and an
 * `idempotencyKey` of `verify:<user.id>`.
 */
export type OnRegistered = (event: {
  user: User;
  /** Plaintext token to embed in the verification link; only the hash is stored. */
  verificationToken: string | null;
  requestContext: RequestContext;
}) => Promise<void>;

/** Authentication operations. */
export interface AuthService {
  register(input: RegisterInput, context: RequestContext): Promise<RegisterResult>;
  login(input: LoginInput, context: RequestContext): Promise<LoginResult>;
  /** Destroy the session behind a request. Safe to call with no session. */
  logout(
    session: SessionRecord | null,
    user: UserRecord | null,
    context: RequestContext,
  ): Promise<void>;
  /** `GET /api/auth/me` payload for an authenticated request. */
  me(
    user: UserRecord,
    session: SessionRecord,
  ): { user: User; csrf_token: string; expires_at: string; capabilities: Capabilities };
  /** Redeem a single-use verification token. */
  verifyEmail(token: string, context: RequestContext): Promise<{ verified: boolean; user: User }>;
  /** Issue a fresh session for a user (used by login and post-registration). */
  issueSession(user: UserRecord, context: RequestContext): Promise<IssuedSession>;
  /** Current registration policy, with defaults applied. */
  getRegistrationPolicy(): Promise<RegistrationPolicy>;
}

/** Dependencies of {@link createAuthService}. */
export interface AuthServiceDeps {
  config: NexusConfig;
  store: NexusStore;
  crypto: NexusCrypto;
  audit: AuditService;
  captcha: CaptchaService;
  /** Optional hook so the email service can enqueue the verification mail. */
  onRegistered?: OnRegistered;
}

/** Strip the password hash: the wire shape of a user. */
export function toPublicUser(record: UserRecord): User {
  const { password_hash: _passwordHash, ...user } = record;
  return user;
}

/** Role-derived flags the SPA uses for nav filtering. */
export function capabilitiesFor(role: Role): Capabilities {
  return {
    can_publish_apis: roleAtLeast(role, 'provider'),
    can_review_access_requests: roleAtLeast(role, 'provider'),
    can_manage_users: roleAtLeast(role, 'admin'),
    can_manage_settings: roleAtLeast(role, 'admin'),
    can_view_audit_log: roleAtLeast(role, 'admin'),
    can_use_god_mode: roleAtLeast(role, 'super_admin'),
  };
}

/** Build the authentication service. */
export function createAuthService(deps: AuthServiceDeps): AuthService {
  const { config, store, crypto, audit, captcha } = deps;

  async function getRegistrationPolicy(): Promise<RegistrationPolicy> {
    const row = await store.settings.get(REGISTRATION_SETTINGS_KEY);
    if (!row || row.value === null || typeof row.value !== 'object') {
      return DEFAULT_REGISTRATION_POLICY;
    }
    const value = row.value as Partial<RegistrationPolicy>;
    return {
      open_registration: value.open_registration !== false,
      require_email_verification: value.require_email_verification === true,
      allowed_roles: Array.isArray(value.allowed_roles)
        ? value.allowed_roles.filter((role): role is Role => typeof role === 'string')
        : DEFAULT_REGISTRATION_POLICY.allowed_roles,
    };
  }

  async function issueSession(user: UserRecord, context: RequestContext): Promise<IssuedSession> {
    const token = crypto.newSessionToken();
    const csrfToken = crypto.newSessionToken();
    const expiresAt = isoInSeconds(config.sessionTtlSeconds);
    const session = await store.sessions.create({
      token_hash: crypto.hashToken(token),
      user_id: user.id,
      csrf_token: csrfToken,
      expires_at: expiresAt,
      ip: context.ip,
      user_agent: context.userAgent,
    });
    return { session, token, csrfToken, expiresAt };
  }

  return {
    getRegistrationPolicy,
    issueSession,

    async register(input, context): Promise<RegisterResult> {
      const policy = await getRegistrationPolicy();
      const email = input.email.trim().toLowerCase();
      const password = input.password;

      if (password.length < MIN_PASSWORD_LENGTH) {
        throw validationFailed(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      }
      if (!isRegistrableRole(input.role)) {
        throw validationFailed('Role must be client or provider');
      }

      await captcha.verify(input.captcha_token, context.ip);

      const isFirstUser = (await store.users.count()) === 0;
      if (!isFirstUser) {
        if (!policy.open_registration) {
          throw forbidden('Self-service registration is currently closed');
        }
        if (!policy.allowed_roles.includes(input.role)) {
          throw forbidden(`Registration with the ${input.role} role is not permitted`);
        }
      }

      if (await store.users.findByEmail(email)) {
        throw conflict('An account with that email address already exists');
      }

      // The very first account bootstraps the platform: super_admin, verified.
      const role: Role = isFirstUser ? 'super_admin' : input.role;
      const requiresVerification = !isFirstUser && policy.require_email_verification;

      const record = await store.users.create({
        email,
        password_hash: await crypto.hashPassword(password),
        display_name: input.display_name.trim(),
        role,
        company: input.company ?? null,
        phone: input.phone ?? null,
        status: 'active',
        email_verified: !requiresVerification,
      });
      const user = toPublicUser(record);

      let verificationToken: string | null = null;
      if (requiresVerification) {
        verificationToken = crypto.newSessionToken();
        await store.verificationTokens.create({
          user_id: record.id,
          token_hash: crypto.hashToken(verificationToken),
          expires_at: isoInSeconds(EMAIL_VERIFICATION_TTL_SECONDS),
        });
      }

      await audit.record(
        { id: record.id, role },
        AuditAction.AUTH_REGISTER,
        { type: 'user', id: record.id },
        { email, role, first_user: isFirstUser, verification_required: requiresVerification },
        context.ip,
      );

      if (deps.onRegistered) {
        await deps.onRegistered({ user, verificationToken, requestContext: context });
      }

      const issued = requiresVerification ? null : await issueSession(record, context);
      return { user, emailVerificationRequired: requiresVerification, issued };
    },

    async login(input, context): Promise<LoginResult> {
      const email = input.email.trim().toLowerCase();
      await captcha.verify(input.captcha_token, context.ip);

      const record = await store.users.findByEmail(email);
      // Always run a real scrypt derivation so "no such account" and "wrong
      // password" cost the same and sign-in cannot enumerate addresses.
      const passwordOk = await crypto.verifyPassword(
        input.password,
        record?.password_hash ?? DECOY_PASSWORD_HASH,
      );

      if (!record || !passwordOk) {
        throw unauthorized('Email address or password is incorrect');
      }
      if (record.status !== 'active') {
        throw userDisabled();
      }

      const policy = await getRegistrationPolicy();
      if (policy.require_email_verification && !record.email_verified) {
        throw emailNotVerified('Please verify your email address before signing in');
      }

      const at = nowIso();
      await store.users.touchLastLogin(record.id, at);
      const issued = await issueSession(record, context);

      await audit.record(
        { id: record.id, role: record.role },
        AuditAction.AUTH_LOGIN,
        { type: 'user', id: record.id },
        { email },
        context.ip,
      );

      return { user: { ...toPublicUser(record), last_login_at: at }, issued };
    },

    async logout(session, user, context): Promise<void> {
      if (!session) return;
      await store.sessions.delete(session.id);
      await audit.record(
        user ? { id: user.id, role: user.role } : ANONYMOUS_ACTOR,
        AuditAction.AUTH_LOGOUT,
        { type: 'session', id: session.id },
        {},
        context.ip,
      );
    },

    me(user, session) {
      return {
        user: toPublicUser(user),
        csrf_token: session.csrf_token,
        expires_at: session.expires_at,
        capabilities: capabilitiesFor(user.role),
      };
    },

    async verifyEmail(token, context): Promise<{ verified: boolean; user: User }> {
      const row = await store.verificationTokens.findByTokenHash(crypto.hashToken(token));
      if (!row) throw validationFailed('That verification link is not valid');
      if (row.used_at !== null) throw conflict('That verification link has already been used');
      if (Date.parse(row.expires_at) <= Date.now()) {
        throw validationFailed('That verification link has expired');
      }

      const burned = await store.verificationTokens.markUsed(row.id, nowIso());
      if (!burned) throw conflict('That verification link has already been used');

      const updated = await store.users.update(row.user_id, { email_verified: true });
      if (!updated) throw validationFailed('That verification link is not valid');

      await audit.record(
        { id: updated.id, role: updated.role },
        AuditAction.AUTH_VERIFY_EMAIL,
        { type: 'user', id: updated.id },
        {},
        context.ip,
      );

      return { verified: true, user: toPublicUser(updated) };
    },
  };
}
