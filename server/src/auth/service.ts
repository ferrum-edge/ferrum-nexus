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
 * - Registration is the accepted exception: a taken address is refused with
 *   `409`, because a sign-up that signs the new account straight in cannot
 *   answer a duplicate the way it answers a success. It hashes the password
 *   before looking, so the refusal costs what a registration costs and says
 *   nothing its body does not (`docs/security.md`, "Session security").
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
import type {
  NexusStore,
  SessionRecord,
  UserRecord,
  VerificationTokenPurpose,
} from '../db/store.js';
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
import { rewordLeaseLost } from '../lib/lease-fence.js';
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

/**
 * `CONFLICT` text for a sign-in whose password-change lease changed hands
 * before its session could commit (issue #384): nothing was issued, and the
 * password it presented may no longer be the account's.
 */
export const SIGN_IN_LEASE_LOST_MESSAGE =
  'Signing in took too long and no session was created — please sign in again';

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
  /**
   * True when a configured CAPTCHA would have demanded a token and
   * `NEXUS_CAPTCHA_ENFORCEMENT=disabled` waived it.
   *
   * Carried into the audit row rather than inferred later: the break-glass
   * switch is a runtime flag with no trace in the database, so the rows written
   * while it was on are the only record that these accounts were seated without
   * the brake the settings page says is active.
   */
  captchaBypassed: boolean;
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
 * Queue the message carrying one minted link, through the mint's own
 * transaction.
 *
 * Returned by a {@link PrepareEmailToken} hook and called inside the
 * transaction that claims the throttle window and writes the token, with that
 * transaction's store. `tokenId` is the row id of the token, which is what the
 * outbox idempotency key is built from, so one minted token can produce at most
 * one message. Everything it does must go through `tx`: the body may be re-run
 * on contention, and a rolled-back attempt must leave no message behind.
 */
export type QueueEmailToken = (tx: NexusStore, tokenId: string) => Promise<void>;

/**
 * Hook that prepares the email for a single-use link about to be minted — a
 * password reset, or a re-sent verification.
 *
 * The service deliberately does not depend on the email service: it mints and
 * audits, the composition root renders and queues. Delivery is split in two so
 * it can commit *with* the mint rather than after it (issue #342). This half
 * runs before anything is claimed and does everything that can fail on its own
 * — resolving the template and rendering it — so a broken template leaves the
 * throttle window unspent. The {@link QueueEmailToken} it returns is the outbox
 * insert, and it runs inside the mint's transaction: an insert that fails rolls
 * the claim, the token and the audit row back with it.
 */
export type PrepareEmailToken = (event: {
  user: User;
  /** Plaintext token for the link; only its hash is stored. */
  token: string;
  requestContext: RequestContext;
}) => Promise<QueueEmailToken>;

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
  /**
   * Issue a fresh session for a user (used by login and post-registration).
   *
   * `db` is the store the row is written through — a transaction-scoped one
   * when the issuance must commit, or roll back, with a surrounding change.
   */
  issueSession(user: UserRecord, context: RequestContext, db?: NexusStore): Promise<IssuedSession>;
  /** Current registration policy, with defaults applied. */
  getRegistrationPolicy(): Promise<RegistrationPolicy>;
  /** Revision of committed bootstrap changes on this instance. */
  getBrandingRevision(): number;
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
  /**
   * Structured logger, at `warn`, for a failure the response is forbidden to
   * describe.
   *
   * Only the recovery endpoints reach it: `forgot-password` and
   * `resend-verification` answer one uniform `200` whatever happens, so a
   * store fault under them is invisible to the caller by design and this is
   * the only place it is recorded.
   */
  log?: (obj: Record<string, unknown>, message: string) => void;
  /** Optional hook so the email service can enqueue the verification mail. */
  onRegistered?: OnRegistered;
  /** Optional hook that renders and queues a re-sent verification link. */
  prepareVerificationResend?: PrepareEmailToken;
  /** Optional hook that renders and queues a password-reset link. */
  preparePasswordReset?: PrepareEmailToken;
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

/** Read registration defaults or overrides through the supplied store. */
export async function readRegistrationPolicy(store: NexusStore): Promise<RegistrationPolicy> {
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

/** Build the authentication service. */
export function createAuthService(deps: AuthServiceDeps): AuthService {
  const { config, store, crypto, audit, captcha, locks } = deps;
  let brandingRevision = 0;
  const serializePasswordChange = createPasswordChangeSerializer(store);

  async function getRegistrationPolicy(): Promise<RegistrationPolicy> {
    return readRegistrationPolicy(store);
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
   * Run a recovery-link issuance so that the caller learns nothing from it —
   * including when it fails.
   *
   * {@link withTimingFloor} equalises how long the branches take, but an
   * exception escaping it still reaches the client as a `500`, and the only
   * branch that can raise one is the branch that has an account to mint for.
   * A partially failing store therefore answers `500` for a real address and
   * `200` for an unknown one, which is precisely the distinction
   * `docs/security.md` says these two endpoints must never make (issue #137).
   *
   * So a failure is logged and swallowed here, and the caller gets the
   * documented `200 { "ok": true }` either way. Nothing is lost by it: the
   * claim rolls back with the mint *and with the outbox insert* — the message
   * is rendered before the claim and queued inside the same transaction — so
   * the next attempt (the user pressing the button again) issues the link the
   * failed one did not (issues #137, #342). The route layer never sees
   * these, hence the log line; it is the only record that the endpoint could
   * not do its work.
   */
  async function withUniformAnswer(
    purpose: VerificationTokenPurpose,
    body: () => Promise<void>,
  ): Promise<void> {
    await withTimingFloor(async () => {
      try {
        await body();
      } catch (error) {
        deps.log?.(
          { purpose, error: error instanceof Error ? error.message : String(error) },
          'an email token could not be issued; the caller was answered uniformly',
        );
      }
    });
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
        ...(draft.captchaBypassed ? { captcha_bypassed: true } : {}),
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

  async function issueSession(
    user: UserRecord,
    context: RequestContext,
    db: NexusStore = store,
  ): Promise<IssuedSession> {
    const token = crypto.newSessionToken();
    const csrfToken = crypto.newSessionToken();
    const expiresAt = isoInSeconds(config.sessionTtlSeconds);
    const session = await db.sessions.create({
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
    getBrandingRevision: () => brandingRevision,
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

      const captchaOutcome = await captcha.verify(input.captcha_token, context.ip);

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

      // Hash before the lock and before the transaction. Scrypt takes ~100 ms,
      // and any number of registrations may be in flight here at once; none of
      // them may hold the super-admin lock or a write transaction (on SQLite,
      // the whole connection) for that long.
      //
      // And hash before the duplicate check, so a taken address costs the same
      // scrypt derivation as a free one. The `409` below still names the
      // address as taken — registration is the one anonymous flow that
      // accepts that, see `docs/security.md` — but it answers no sooner than a
      // real registration would, so its latency adds nothing to what its body
      // already says, and a prober pays the full cost of a sign-up per guess
      // (issue #344).
      const passwordHash = await crypto.hashPassword(password);

      if (await store.users.findByEmail(email)) {
        throw conflict('An account with that email address already exists');
      }

      const draft: RegistrationDraft = {
        email,
        passwordHash,
        displayName: input.display_name.trim(),
        role: input.role,
        company: input.company ?? null,
        phone: input.phone ?? null,
        requireEmailVerification: policy.require_email_verification,
        ip: context.ip,
        captchaBypassed: captchaOutcome === 'bypassed',
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

      if (promoted) brandingRevision += 1;

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
      const captchaOutcome = await captcha.verify(input.captcha_token, context.ip);

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

      // Issue under the password-change lease, and only against the hash that
      // was just verified. The scrypt check above takes ~100 ms with nothing
      // held, and a reset or self-service change that commits inside that
      // window deletes every session of the account — before this one exists.
      // Issuing unconditionally afterwards minted a live session from a
      // password the account no longer has (issue #325). Both changers hold
      // this lease from their transaction through their own issuance, so a
      // re-read inside it sees either the old hash with no change pending, or
      // the new one. The re-read and the insert share one transaction, which
      // is what the lease's fence guards: a sign-in that stalled past the TTL
      // while a change took the lease over rolls back rather than minting a
      // session from the replaced password (issue #384), and is told so in
      // words about signing in rather than about a change.
      const at = nowIso();
      const issued = await rewordLeaseLost(SIGN_IN_LEASE_LOST_MESSAGE, () =>
        serializePasswordChange(record.id, () =>
          store.transaction(async (tx) => {
            const current = await tx.users.findById(record.id);
            // The same answer a wrong password gets: from the caller's side, the
            // password it presented is no longer the account's.
            if (!current || current.password_hash !== record.password_hash) {
              throw unauthorized('Email address or password is incorrect');
            }
            if (current.status !== 'active') throw userDisabled();
            await tx.users.touchLastLogin(record.id, at);
            return issueSession(current, context, tx);
          }),
        ),
      );

      await audit.record(
        { id: record.id, role: record.role },
        AuditAction.AUTH_LOGIN,
        { type: 'user', id: record.id },
        // `captcha_bypassed` only ever appears while the operator's break-glass
        // switch is on, which is the one state where a sign-in that looks
        // CAPTCHA-protected was not.
        { email, ...(captchaOutcome === 'bypassed' ? { captcha_bypassed: true } : {}) },
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
      await withUniformAnswer('email_verification', async () => {
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
        // Rendered before anything is claimed: a template that cannot be
        // rendered fails here, with the window still unspent (issue #342).
        const queueEmail = deps.prepareVerificationResend
          ? await deps.prepareVerificationResend({
              user: toPublicUser(record),
              token,
              requestContext: context,
            })
          : null;
        const issuedAt = nowIso();
        const notBefore = new Date(
          Date.parse(issuedAt) - VERIFICATION_RESEND_THROTTLE_SECONDS * 1000,
        ).toISOString();
        await store.transaction(async (tx) => {
          // The claim is the *first* write of the mint, not a separate one
          // before it. It is still the single conditional write that makes
          // concurrent requests produce exactly one link — but it now commits
          // with the token and its message or rolls back with them, so a mint
          // or a queueing that fails leaves the recipient's ten-minute window
          // unspent (issues #137, #342).
          if (
            !(await tx.verificationTokens.claimIssue(
              record.id,
              'email_verification',
              issuedAt,
              notBefore,
            ))
          ) {
            // Genuinely throttled: another request holds the window.
            return;
          }
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
          // Last, and inside: the delivery is part of what the window was
          // spent on, so it commits or rolls back with the claim.
          if (queueEmail) await queueEmail(tx, created.id);
        });
      });
    },

    async requestPasswordReset(rawEmail, context): Promise<void> {
      await withUniformAnswer('password_reset', async () => {
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
        // Rendered before the claim, for the reason `resendVerification` gives.
        const queueEmail = deps.preparePasswordReset
          ? await deps.preparePasswordReset({
              user: toPublicUser(record),
              token,
              requestContext: context,
            })
          : null;
        const issuedAt = nowIso();
        const notBefore = new Date(
          Date.parse(issuedAt) - PASSWORD_RESET_THROTTLE_SECONDS * 1000,
        ).toISOString();
        await store.transaction(async (tx) => {
          // Inside the transaction, for the reason `resendVerification` gives:
          // account recovery must not spend the window on a link that was
          // never minted, or never queued (issues #137, #342).
          if (
            !(await tx.verificationTokens.claimIssue(
              record.id,
              'password_reset',
              issuedAt,
              notBefore,
            ))
          ) {
            // Genuinely throttled: another request holds the window.
            return;
          }
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
          if (queueEmail) await queueEmail(tx, created.id);
        });
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
