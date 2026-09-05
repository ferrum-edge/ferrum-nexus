/**
 * Registration, sign-in, sign-out, email verification and password recovery.
 *
 * Rules enforced here rather than in the routes, so every caller gets them:
 *
 * - Email addresses are unique case-insensitively and stored lowercased.
 * - **While the portal has no active `super_admin`, the next registration
 *   becomes one and is automatically email-verified**; every other account
 *   gets the registrable role it asked for (`client` or `provider`) and nothing
 *   more. The founder's seat is taken under the cross-instance
 *   {@link SUPER_ADMIN_LOCK_KEY} lock and inside one transaction, so the
 *   account, the {@link SUPER_ADMIN_CLAIM_KEY} record and the role commit
 *   together or not at all — see {@link AuthService.register}.
 * - **A founding registration must present the bootstrap token**
 *   (`NEXUS_BOOTSTRAP_TOKEN`, or the per-process value printed at startup).
 *   Public self-registration can therefore never elect a founder: the lock
 *   decides *which* candidate wins, the token decides who may stand. The gate
 *   is "no active super_admin", not "no user", so a portal whose founder was
 *   never seated — the failure mode this guards against — can still be
 *   bootstrapped, and only through the token.
 * - Passwords are scrypt-hashed; verification is constant-time and a missing
 *   account still costs one hash so sign-in does not leak which emails exist.
 * - The two "email me a link" endpoints — {@link AuthService.requestPasswordReset}
 *   and {@link AuthService.resendVerification} — answer `ok` to everything and
 *   pay the same scrypt cost whatever they decide, so neither the body, the
 *   status nor the latency says whether an address has an account.
 * - Every successful register/login/logout/verify/reset writes an audit row.
 */

import {
  EMAIL_VERIFICATION_TTL_SECONDS,
  MIN_PASSWORD_LENGTH,
  PASSWORD_RESET_THROTTLE_SECONDS,
  PASSWORD_RESET_TTL_SECONDS,
  VERIFICATION_RESEND_THROTTLE_SECONDS,
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
import { secretEquals } from '../lib/crypto.js';
import {
  conflict,
  emailNotVerified,
  forbidden,
  unauthorized,
  userDisabled,
  validationFailed,
} from '../lib/errors.js';
import { isoInSeconds, nowIso } from '../lib/ids.js';
import { SUPER_ADMIN_LOCK_KEY, type KeyedSerializer } from '../lib/keyed-serializer.js';
import type { CaptchaService } from './captcha.js';
import { createPasswordChangeSerializer } from './password-change.js';

/** `app_settings` key holding the registration policy. */
export const REGISTRATION_SETTINGS_KEY = 'registration';

/**
 * `app_settings` key that records the bootstrap election.
 *
 * Its value is `{ user_id, claimed_at }` — the account seated as the portal's
 * founding `super_admin`. It is a record, not the lock: the seat is decided by
 * {@link SUPER_ADMIN_LOCK_KEY} plus a count of active super admins taken inside
 * the founder's transaction, and this row is written in that same transaction,
 * so it can only ever describe a founder who was actually committed. A stale
 * value left behind by a deployment that predates the atomic seat is simply
 * overwritten when the portal is bootstrapped again.
 */
export const SUPER_ADMIN_CLAIM_KEY = 'bootstrap.super_admin_claimed';

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

/**
 * Value hashed to pad out the "email me a link" endpoints.
 *
 * Those endpoints do very different amounts of work depending on the answer —
 * mint a token and queue a message, or return immediately — and the difference
 * is exactly the fact the response is not allowed to reveal. Hashing this
 * string with the real scrypt parameters costs ~100 ms, an order of magnitude
 * more than the queueing it hides, and {@link withTimingFloor} starts it before
 * the branch and awaits it after, so every path takes about that long.
 */
const TIMING_FLOOR_SECRET = 'ferrum-nexus-anti-enumeration-timing-floor';

/**
 * The single rejection every bad reset link gets.
 *
 * Unknown, expired and already-spent all produce this one code and this one
 * message. Distinguishing them would hand an attacker holding a guessed token
 * an oracle telling them how close they were.
 */
function invalidResetLink(): Error {
  return validationFailed('That password reset link is not valid or has expired');
}

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
  /** Out-of-band bootstrap secret; required only while no active `super_admin` exists. */
  bootstrap_token?: string | undefined;
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
 * Everything a registration writes, computed before any lock or transaction.
 *
 * The password is already hashed: the one slow step of a registration happens
 * with nothing held, and the transaction that follows is a handful of inserts.
 */
interface RegistrationDraft {
  email: string;
  passwordHash: string;
  displayName: string;
  role: RegistrableRole;
  company: string | null;
  phone: string | null;
  requireEmailVerification: boolean;
  ip: string | null;
}

/** What a committed registration transaction produced. */
interface RegistrationOutcome {
  record: UserRecord;
  /** True when the account was seated as the founding `super_admin`. */
  promoted: boolean;
  /** Plaintext verification token minted in the transaction, when one was. */
  verificationToken: string | null;
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

/**
 * Hook invoked when a fresh single-use link has been minted and must be
 * emailed — a password reset, or a re-sent verification.
 *
 * The service deliberately does not depend on the email service: it mints and
 * audits, the composition root delivers. `tokenId` is the row id of the token,
 * which is what the outbox idempotency key is built from, so one minted token
 * can produce at most one message.
 */
export type OnEmailTokenIssued = (event: {
  user: User;
  /** Plaintext token for the link; only its hash is stored. */
  token: string;
  /** `email_verification_tokens.id` — a stable, non-secret handle for the token. */
  tokenId: string;
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
  /**
   * Queue a fresh verification link for an unverified account.
   *
   * Resolves with nothing whatever it decided — unknown address, disabled
   * account, already verified, or throttled all look the same from outside.
   */
  resendVerification(email: string, context: RequestContext): Promise<void>;
  /**
   * Queue a password-reset link.
   *
   * Same contract as {@link AuthService.resendVerification}: it never reports
   * whether anything was sent.
   */
  requestPasswordReset(email: string, context: RequestContext): Promise<void>;
  /**
   * Redeem a reset link: set the new password, verify the address, and
   * terminate every session of the account.
   *
   * Throws `VALIDATION_FAILED` for a token that is unknown, expired or already
   * spent — one code and one message for all three, so a caller cannot probe
   * which it was.
   */
  resetPassword(token: string, newPassword: string, context: RequestContext): Promise<void>;
  /** Issue a fresh session for a user (used by login and post-registration). */
  issueSession(user: UserRecord, context: RequestContext): Promise<IssuedSession>;
  /** Current registration policy, with defaults applied. */
  getRegistrationPolicy(): Promise<RegistrationPolicy>;
  /**
   * True while the portal has no active `super_admin`, i.e. the next
   * registration is the bootstrap one and must carry a valid `bootstrap_token`.
   *
   * Deliberately not "no accounts": a portal whose founding registration was
   * cut short before the role landed has users but nobody to administer them,
   * and this is what lets the documented bootstrap flow — token and all — put
   * that right instead of leaving it to database surgery. An established
   * portal with a seated super admin answers `false` whatever else is true of
   * it.
   *
   * Published on `GET /api/branding` so the sign-up form can ask for the token
   * up front. It is a hint, not a gate — {@link AuthService.register} decides,
   * and decides again under the lock.
   */
  bootstrapRequired(): Promise<boolean>;
}

/** Dependencies of {@link createAuthService}. */
export interface AuthServiceDeps {
  config: NexusConfig;
  store: NexusStore;
  crypto: NexusCrypto;
  audit: AuditService;
  captcha: CaptchaService;
  /**
   * Store-level cross-instance lock, built in the composition root from
   * `store.leases`. The founder's seat is taken under
   * {@link SUPER_ADMIN_LOCK_KEY} — the same key every transition that can
   * shrink the active `super_admin` set runs under — so two instances cannot
   * each seat a founder, and a bootstrap cannot interleave with a demotion.
   */
  locks: KeyedSerializer;
  /** Optional hook so the email service can enqueue the verification mail. */
  onRegistered?: OnRegistered;
  /** Optional hook that delivers a re-sent verification link. */
  onVerificationResend?: OnEmailTokenIssued;
  /** Optional hook that delivers a password-reset link. */
  onPasswordResetRequested?: OnEmailTokenIssued;
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
  const { config, store, crypto, audit, captcha, locks } = deps;
  const serializePasswordChange = createPasswordChangeSerializer(store);

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

  /**
   * Run `body` with a scrypt derivation racing alongside it, and return only
   * once both have finished.
   *
   * The point is that `body` returns after wildly different amounts of work —
   * "this address has no account" is a single indexed SELECT, "here is your
   * reset link" is a token insert, an audit row and a rendered message — and
   * the endpoint's whole contract is that an observer cannot tell those apart.
   * A floor that costs more than the widest branch flattens them; starting it
   * first rather than adding it afterwards keeps the endpoint's latency at one
   * hash instead of two.
   */
  async function withTimingFloor<T>(body: () => Promise<T>): Promise<T> {
    const floor = crypto.hashPassword(TIMING_FLOOR_SECRET);
    try {
      return await body();
    } finally {
      await floor;
    }
  }

  /**
   * Gate the bootstrap registration on the out-of-band token.
   *
   * Seating a founder is the one place where an anonymous request can hand
   * itself `super_admin`, so while the seat is open "who is allowed to win"
   * has to be answered before "who won". The expected value is
   * {@link NexusConfig.bootstrapToken}: `NEXUS_BOOTSTRAP_TOKEN`, or the
   * per-process token the entry point generates and logs. An unset token means
   * no value can match — a server built without one simply cannot be
   * bootstrapped over HTTP, which is the safe direction to fail in.
   */
  function requireBootstrapToken(presented: string | undefined): void {
    const expected = config.bootstrapToken;
    if (expected !== undefined && presented !== undefined && secretEquals(presented, expected)) {
      return;
    }
    throw forbidden(
      'This portal has no super_admin yet, so the next registration becomes its super_admin ' +
        'and must include the bootstrap token printed in the server log at startup ' +
        '(or the configured NEXUS_BOOTSTRAP_TOKEN)',
    );
  }

  async function bootstrapRequired(): Promise<boolean> {
    return (await store.users.countActiveSuperAdmins()) === 0;
  }

  /**
   * Write one registration — account, founder record, verification token and
   * audit row — through `tx`, so they commit or roll back together.
   *
   * `founder` is the decision, already taken by the caller: `true` seats the
   * account as a verified `super_admin` and records it under
   * {@link SUPER_ADMIN_CLAIM_KEY}; `false` creates the ordinary member the
   * draft describes. Nothing here hashes, waits or calls out — everything slow
   * happened before the transaction opened.
   */
  async function persistRegistration(
    tx: NexusStore,
    draft: RegistrationDraft,
    founder: boolean,
  ): Promise<RegistrationOutcome> {
    const record = await tx.users.create({
      email: draft.email,
      password_hash: draft.passwordHash,
      display_name: draft.displayName,
      role: founder ? 'super_admin' : draft.role,
      company: draft.company,
      phone: draft.phone,
      status: 'active',
      // The founder bootstraps the platform: verified, since there is nobody
      // to configure SMTP for them.
      email_verified: founder || !draft.requireEmailVerification,
    });

    if (founder) {
      // An upsert on purpose: a deployment that predates the atomic seat can
      // hold a stale record pointing at an account that was never promoted,
      // and this transaction — under the lock, having counted zero active
      // super admins — is exactly the writer allowed to replace it.
      await tx.settings.set(SUPER_ADMIN_CLAIM_KEY, { user_id: record.id, claimed_at: nowIso() });
    }

    const requiresVerification = !founder && draft.requireEmailVerification;
    let verificationToken: string | null = null;
    if (requiresVerification) {
      verificationToken = crypto.newSessionToken();
      await tx.verificationTokens.create({
        user_id: record.id,
        token_hash: crypto.hashToken(verificationToken),
        purpose: 'email_verification',
        expires_at: isoInSeconds(EMAIL_VERIFICATION_TTL_SECONDS),
      });
    }

    await audit.forStore(tx).record(
      { id: record.id, role: record.role },
      AuditAction.AUTH_REGISTER,
      { type: 'user', id: record.id },
      {
        email: draft.email,
        role: record.role,
        first_user: founder,
        verification_required: requiresVerification,
      },
      draft.ip,
    );

    return { record, promoted: founder, verificationToken };
  }

  /**
   * Seat the founder, or fall back to an ordinary member if the seat is taken.
   *
   * Runs inside {@link SUPER_ADMIN_LOCK_KEY} *and* a transaction. The lock is
   * what makes the count authoritative across instances: every writer that can
   * add or remove an active `super_admin` takes it, so a zero counted here
   * stays zero until this body has committed. The transaction is what makes the
   * seat all-or-nothing: a failure after the account is created — the case
   * that used to leave a portal with users and no administrator — rolls the
   * account back too, and the next attempt finds the seat still open.
   *
   * A candidate that arrives to a seat somebody else has just taken is not an
   * error; it keeps the role it asked for, exactly as a later registration
   * would.
   */
  async function seatFounder(
    tx: NexusStore,
    draft: RegistrationDraft,
  ): Promise<RegistrationOutcome> {
    const seatTaken = (await tx.users.countActiveSuperAdmins()) > 0;
    return persistRegistration(tx, draft, !seatTaken);
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
    bootstrapRequired,

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

      // Advisory only: it decides whether the registration policy applies, and
      // whether this registration stands for the founder's seat below. It is
      // *not* what makes anyone a super_admin — the seat is decided again under
      // the lock. A portal with no super admin also implies the default policy,
      // since editing it needs an administrator account.
      const seatOpen = await bootstrapRequired();
      if (seatOpen) {
        // The founder is seated here, so this registration has to prove it
        // comes from whoever runs the server. Checked before the password is
        // hashed and before any row is written: a caller without the token
        // leaves no trace beyond the audit-free 403 it gets back.
        requireBootstrapToken(input.bootstrap_token);
      } else {
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

      // Hash before the lock and before the transaction. Scrypt takes ~100 ms,
      // and any number of registrations may be in flight here at once; none of
      // them may hold the super-admin lock or a write transaction (on SQLite,
      // the whole connection) for that long.
      const draft: RegistrationDraft = {
        email,
        passwordHash: await crypto.hashPassword(password),
        displayName: input.display_name.trim(),
        role: input.role,
        company: input.company ?? null,
        phone: input.phone ?? null,
        requireEmailVerification: policy.require_email_verification,
        ip: context.ip,
      };

      // The lock is taken *outside* the transaction (see `KeyedSerializer`):
      // the lease repository runs statements of its own, and waiting for it
      // from inside a body would, on SQLite, wait on the very transaction that
      // has to finish before the lease can be released.
      const founderTransaction = (): Promise<RegistrationOutcome> =>
        store.transaction((tx) => seatFounder(tx, draft));
      const { record, promoted, verificationToken } = seatOpen
        ? await locks(SUPER_ADMIN_LOCK_KEY, founderTransaction)
        : await store.transaction((tx) => persistRegistration(tx, draft, false));

      const requiresVerification = !promoted && verificationToken !== null;
      const user = toPublicUser(record);

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
      const row = await store.verificationTokens.findByTokenHash(
        crypto.hashToken(token),
        'email_verification',
      );
      if (!row) throw validationFailed('That verification link is not valid');
      if (row.used_at !== null) throw conflict('That verification link has already been used');
      if (Date.parse(row.expires_at) <= Date.now()) {
        throw validationFailed('That verification link has expired');
      }

      // Burn, verify and audit in one transaction. The token is single-use and
      // there is no resend endpoint, so spending it and *then* failing to mark
      // the account verified locked that account out permanently: the retry saw
      // a spent token and the user could never sign in. The `used_at IS NULL`
      // predicate on the burn still does the work of making it single-use —
      // the transaction only makes sure the burn does not outlive its purpose.
      const updated = await store.transaction(async (tx) => {
        const burned = await tx.verificationTokens.markUsed(row.id, nowIso());
        if (!burned) throw conflict('That verification link has already been used');

        const user = await tx.users.update(row.user_id, { email_verified: true });
        if (!user) throw validationFailed('That verification link is not valid');

        await audit
          .forStore(tx)
          .record(
            { id: user.id, role: user.role },
            AuditAction.AUTH_VERIFY_EMAIL,
            { type: 'user', id: user.id },
            {},
            context.ip,
          );
        return user;
      });

      return { verified: true, user: toPublicUser(updated) };
    },

    async resendVerification(rawEmail, context): Promise<void> {
      await withTimingFloor(async () => {
        const email = rawEmail.trim().toLowerCase();
        const record = await store.users.findByEmail(email);
        // Four different reasons to send nothing, all of them invisible to the
        // caller: no such address, the account is disabled, it is already
        // verified, or a link is already on its way.
        if (!record || record.status !== 'active' || record.email_verified) return;
        const existing = await store.verificationTokens.findLatestLiveForUser(
          record.id,
          'email_verification',
          nowIso(),
        );
        if (
          existing &&
          Date.parse(existing.created_at) > Date.now() - VERIFICATION_RESEND_THROTTLE_SECONDS * 1000
        ) {
          return;
        }
        const token = crypto.newSessionToken();
        const issuedAt = nowIso();
        const notBefore = new Date(
          Date.parse(issuedAt) - VERIFICATION_RESEND_THROTTLE_SECONDS * 1000,
        ).toISOString();
        if (
          !(await store.verificationTokens.claimIssue(
            record.id,
            'email_verification',
            issuedAt,
            notBefore,
          ))
        ) {
          return;
        }
        const row = await store.transaction(async (tx) => {
          // Supersede the link from registration (or an earlier resend): the
          // address should only ever have one live verification token.
          await tx.verificationTokens.deleteForUser(record.id, 'email_verification');
          const created = await tx.verificationTokens.create({
            user_id: record.id,
            token_hash: crypto.hashToken(token),
            purpose: 'email_verification',
            expires_at: isoInSeconds(EMAIL_VERIFICATION_TTL_SECONDS),
          });
          await audit
            .forStore(tx)
            .record(
              { id: record.id, role: record.role },
              AuditAction.AUTH_VERIFICATION_RESEND,
              { type: 'user', id: record.id },
              { email },
              context.ip,
            );
          return created;
        });

        if (deps.onVerificationResend) {
          await deps.onVerificationResend({
            user: toPublicUser(record),
            token,
            tokenId: row.id,
            requestContext: context,
          });
        }
      });
    },

    async requestPasswordReset(rawEmail, context): Promise<void> {
      await withTimingFloor(async () => {
        const email = rawEmail.trim().toLowerCase();
        const record = await store.users.findByEmail(email);
        if (!record || record.status !== 'active') return;
        const existing = await store.verificationTokens.findLatestLiveForUser(
          record.id,
          'password_reset',
          nowIso(),
        );
        if (
          existing &&
          Date.parse(existing.created_at) > Date.now() - PASSWORD_RESET_THROTTLE_SECONDS * 1000
        ) {
          return;
        }
        const token = crypto.newSessionToken();
        const issuedAt = nowIso();
        const notBefore = new Date(
          Date.parse(issuedAt) - PASSWORD_RESET_THROTTLE_SECONDS * 1000,
        ).toISOString();
        if (
          !(await store.verificationTokens.claimIssue(
            record.id,
            'password_reset',
            issuedAt,
            notBefore,
          ))
        ) {
          return;
        }
        const row = await store.transaction(async (tx) => {
          const created = await tx.verificationTokens.create({
            user_id: record.id,
            token_hash: crypto.hashToken(token),
            purpose: 'password_reset',
            expires_at: isoInSeconds(PASSWORD_RESET_TTL_SECONDS),
          });

          // Only the path that actually issued a link is audited, so the log
          // distinguishes the four outcomes the response cannot.
          await audit
            .forStore(tx)
            .record(
              { id: record.id, role: record.role },
              AuditAction.AUTH_PASSWORD_RESET_REQUEST,
              { type: 'user', id: record.id },
              { email },
              context.ip,
            );
          return created;
        });

        if (deps.onPasswordResetRequested) {
          await deps.onPasswordResetRequested({
            user: toPublicUser(record),
            token,
            tokenId: row.id,
            requestContext: context,
          });
        }
      });
    },

    async resetPassword(token, newPassword, context): Promise<void> {
      if (newPassword.length < MIN_PASSWORD_LENGTH) {
        throw validationFailed(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      }

      const row = await store.verificationTokens.findByTokenHash(
        crypto.hashToken(token),
        'password_reset',
      );
      if (!row || row.used_at !== null || Date.parse(row.expires_at) <= Date.now()) {
        throw invalidResetLink();
      }
      const record = await store.users.findById(row.user_id);
      if (!record) throw invalidResetLink();
      if (record.status !== 'active') throw userDisabled();

      // Hash outside the transaction: scrypt takes ~100 ms and holding a write
      // transaction open across it would serialise unrelated work behind it.
      const passwordHash = await crypto.hashPassword(newPassword);

      await serializePasswordChange(record.id, async () => {
        await store.transaction(async (tx) => {
          // Recheck after taking the lease: an earlier change may have deleted
          // the link, or it may have expired while hashing or waiting.
          const live = await tx.verificationTokens.findByTokenHash(
            crypto.hashToken(token),
            'password_reset',
          );
          if (!live || live.used_at !== null || Date.parse(live.expires_at) <= Date.now()) {
            throw invalidResetLink();
          }
          const current = await tx.users.findById(record.id);
          if (!current) throw invalidResetLink();
          if (current.status !== 'active') throw userDisabled();
          const burned = await tx.verificationTokens.markUsed(live.id, nowIso());
          if (!burned) throw invalidResetLink();

          const updated = await tx.users.update(record.id, {
            password_hash: passwordHash,
            // Redeeming a link mailed to the address proves the mailbox, which is
            // all verification ever claimed.
            email_verified: true,
          });
          if (!updated) throw invalidResetLink();

          // Any other reset link for this account dies with this one, and every
          // session goes: whoever prompted the reset must not keep a live one.
          await tx.verificationTokens.deleteForUser(record.id, 'password_reset');
          await tx.sessions.deleteForUser(record.id);

          await audit
            .forStore(tx)
            .record(
              { id: updated.id, role: updated.role },
              AuditAction.AUTH_PASSWORD_RESET,
              { type: 'user', id: updated.id },
              { email: updated.email },
              context.ip,
            );
        });
      });
    },
  };
}
