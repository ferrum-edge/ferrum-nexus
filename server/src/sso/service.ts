/**
 * OpenID Connect single sign-on: the sign-in flow, account provisioning and
 * linking, claim mapping, and its administration.
 *
 * The flow is the authorization-code grant with PKCE:
 *
 * 1. `GET /api/auth/sso/:provider/start` (or, to link the signed-in account,
 *    `POST /api/auth/sso/:provider/link`) mints a `state`, a `nonce` and a
 *    PKCE verifier, seals them — with the provider id, the page to return to,
 *    an expiry and, for a link, the account and session — into the
 *    short-lived HttpOnly `nexus_sso` cookie, and sends the browser to the
 *    provider with the `S256` challenge.
 * 2. `GET /api/auth/sso/:provider/callback` opens that cookie (and clears it,
 *    whatever happens next), requires the returned `state` to equal the
 *    sealed one, redeems the code with the verifier, and validates the ID
 *    token — signature, issuer, audience, expiry and the sealed `nonce`
 *    (`sso/oidc.ts`).
 *
 * Which account the sign-in opens is decided by these rules, in order:
 *
 * - **A linked subject** — `(provider, issuer, sub)` in `user_identities` —
 *   opens its account. The email address plays no part: a provider that
 *   changes it does not move the sign-in to another account.
 * - **An explicit link** — started from the profile of a signed-in account —
 *   attaches the identity to that account, and only when the callback comes
 *   back to the same session.
 * - **Otherwise an existing account with the same address is linked only
 *   when both sides have proven it**: the provider asserts
 *   `email_verified: true` (the JSON boolean) *and* the portal holds a proof
 *   of the address in `user_email_proofs` — a redeemed verification link, a
 *   completed reset, or a provider that verified it before. `email_verified`
 *   alone is not proof. An `admin` or `super_admin` is never linked this way;
 *   its holder links explicitly. Anything less is refused and nothing is
 *   linked.
 * - **Otherwise, with just-in-time provisioning on, a new account is created**
 *   (by default only for a verified address), with the role and organization
 *   the claims map to. It is never a `super_admin`, and it has no password.
 *
 * Every sign-in re-reads the claims: the role and organization follow the
 * mappings (`sso/mapping.ts`, and never for a `super_admin`), and claims that
 * map to no role refuse the sign-in — except a `super_admin`'s — and, when
 * the deployment says so, disable the account through the same durable
 * gateway revocation an administrator's disable queues. The session is the
 * ordinary portal session (`auth/service.ts`), and every change commits in
 * one transaction with its audit row.
 */

import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  roleAtLeast,
  SSO_TRANSACTION_TTL_SECONDS,
  type LoginPolicy,
  type SsoAdminSettingsResponse,
  type SsoErrorReason,
  type SsoProviderSettings,
  type SsoPublicConfigResponse,
  type UpdateSsoSettingsRequest,
  type UserIdentity,
  type Uuid,
} from '@ferrum-nexus/shared';

import { AuditAction, SYSTEM_ACTOR, type AuditActor, type AuditService } from '../audit/service.js';
import type { AuthService, IssuedSession, RequestContext } from '../auth/service.js';
import type { NexusConfig } from '../config/index.js';
import { runGatewayTeardown, type CredentialsService } from '../credentials/service.js';
import type { NexusStore, UserIdentityRecord, UserRecord } from '../db/store.js';
import { SCRYPT_PARAMS, type NexusCrypto } from '../lib/crypto.js';
import { forbidden, notFound, validationFailed } from '../lib/errors.js';
import { nowIso } from '../lib/ids.js';
import { userLifecycleLockKey, type KeyedSerializer } from '../lib/keyed-serializer.js';
import {
  issuerProblem,
  MAX_ALLOWED_EMAIL_DOMAINS,
  MAX_SSO_PROVIDERS,
  normalizeEmailDomain,
} from './config.js';
import {
  displayNameFromClaims,
  emailDomainAllowed,
  emailVerifiedClaim,
  mapClaims,
  normalizeEmailClaim,
  planClaimsChange,
  type ClaimMapping,
} from './mapping.js';
import {
  authorizationUrl,
  createOidcClient,
  OidcError,
  pkceChallenge,
  randomUrlToken,
  tokensEqual,
  type IdTokenClaims,
  type OidcClient,
} from './oidc.js';
import {
  providersInForce,
  readStoredSsoSettings,
  resolveSsoProviders,
  shadowedProviderIds,
  ssoClientSecretKey,
  SSO_SETTINGS_KEY,
  type ResolvedSsoProvider,
  type StoredSsoSettings,
} from './settings.js';

/** What one sign-in attempt seals into the `nexus_sso` cookie. */
interface SsoTransaction {
  v: 1;
  provider: string;
  state: string;
  nonce: string;
  verifier: string;
  /** A same-origin path, already checked by {@link safeReturnPath}. */
  return_to: string;
  /** Epoch milliseconds. */
  expires_at: number;
  /** For an explicit link: the account that started it, else `null`. */
  link_user_id: Uuid | null;
  /** For an explicit link: the session that started it, else `null`. */
  link_session_id: Uuid | null;
}

/** Result of {@link SsoService.start}. */
export interface SsoStartResult {
  /** Where to redirect the browser: the provider, or the sign-in page with an error. */
  location: string;
  /** The sealed attempt for the `nexus_sso` cookie; `null` when sign-in cannot start. */
  transaction: string | null;
}

/** Result of {@link SsoService.callback}. */
export type SsoCallbackResult =
  | { ok: true; location: string; issued: IssuedSession }
  | { ok: false; location: string; reason: SsoErrorReason };

/** The query string a provider sends to the callback. */
export interface SsoCallbackQuery {
  code?: string | undefined;
  state?: string | undefined;
  error?: string | undefined;
}

/** The signed-in principal a callback arrives with, if any. */
export interface SsoCurrentSession {
  userId: Uuid;
  sessionId: Uuid;
}

/** Single sign-on operations. */
export interface SsoService {
  /** `GET /api/auth/sso`: what the sign-in page offers. */
  publicConfig(): Promise<SsoPublicConfigResponse>;
  /** Begin a sign-in. Never throws; a refusal redirects to the sign-in page. */
  start(providerId: string, returnTo: unknown): Promise<SsoStartResult>;
  /**
   * Begin linking the signed-in account to a provider. Throws
   * `VALIDATION_FAILED` (with `details.reason`) when it cannot start.
   */
  startLink(
    providerId: string,
    current: SsoCurrentSession,
  ): Promise<{ location: string; transaction: string }>;
  /** Finish a sign-in or a link. Never throws; a refusal redirects with a reason. */
  callback(
    providerId: string,
    query: SsoCallbackQuery,
    transactionCookie: string | undefined,
    current: SsoCurrentSession | null,
    context: RequestContext,
  ): Promise<SsoCallbackResult>;
  getAdminSettings(): Promise<SsoAdminSettingsResponse>;
  /** `super_admin` only: the settings decide who becomes an `admin`. */
  updateAdminSettings(
    actor: AuditActor & { id: Uuid },
    patch: UpdateSsoSettingsRequest,
    ip: string | null,
  ): Promise<SsoAdminSettingsResponse>;
  listIdentities(userId: Uuid): Promise<UserIdentity[]>;
  /** Remove one link. Unlinking an administrator's identity needs a `super_admin`. */
  unlinkIdentity(
    actor: UserRecord,
    userId: Uuid,
    identityId: Uuid,
    ip: string | null,
  ): Promise<void>;
}

/** Dependencies of {@link createSsoService}. */
export interface SsoServiceDeps {
  config: NexusConfig;
  store: NexusStore;
  crypto: NexusCrypto;
  audit: AuditService;
  /** Issues the ordinary portal session, inside the sign-in's transaction. */
  auth: Pick<AuthService, 'issueSession'>;
  /** Strips the gateway identity of an account deprovisioned by its claims. */
  credentials: Pick<CredentialsService, 'disableGatewayAccess'>;
  /** Store-level lock; a deprovision takes the account's lifecycle key. */
  locks: KeyedSerializer;
  /** Defaults to one built from `config.sso`. Tests inject their own. */
  oidc?: OidcClient;
  /** Where a refused sign-in's reason is recorded; never with a token in it. */
  log?: (obj: Record<string, unknown>, message: string) => void;
}

/**
 * The page a sign-in returns to, or `/`.
 *
 * Only a same-origin path is accepted — never an absolute URL, a
 * protocol-relative `//host`, a backslash trick, an API route or the sign-in
 * page itself — so the callback cannot be turned into an open redirect.
 */
export function safeReturnPath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return '/';
  if (!value.startsWith('/') || value.startsWith('//')) return '/';
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return '/';
  const path = value.split(/[?#]/, 1)[0] ?? '';
  if (path === '/api' || path.startsWith('/api/')) return '/';
  if (path === '/login' || path.startsWith('/login/')) return '/';
  return value;
}

/**
 * A password hash no password matches.
 *
 * Well-formed, so a password sign-in against an SSO-provisioned account costs
 * a full scrypt derivation and fails like any wrong password, rather than
 * failing fast and telling the caller the account has no password. The salt
 * and "hash" are random bytes, not a derivation of anything.
 */
function unusablePasswordHash(): string {
  const { N, r, p } = SCRYPT_PARAMS;
  const salt = randomBytes(16).toString('base64');
  const hash = randomBytes(SCRYPT_PARAMS.keyLength).toString('base64');
  return `scrypt:${N}:${r}:${p}:${salt}:${hash}`;
}

function toUserIdentity(record: UserIdentityRecord): UserIdentity {
  return {
    id: record.id,
    user_id: record.user_id,
    provider_id: record.provider_id,
    issuer: record.issuer,
    subject: record.subject,
    email: record.email,
    provisioned: record.provisioned,
    last_login_at: record.last_login_at,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

/**
 * Hold an address to a domain list: when the list is set, the provider must
 * have verified the address, and it must be in one of the domains. An
 * unverified claim is refused rather than trusted to be in the domain it says.
 */
function checkDomains(email: string | null, emailVerified: boolean, domains: string[]): void {
  if (domains.length === 0) return;
  if (email === null) throw new OidcError('email_required', 'A domain check needs an email');
  if (!emailVerified) {
    throw new OidcError('email_not_verified', 'A domain check needs a verified address');
  }
  if (!emailDomainAllowed(email, domains)) {
    throw new OidcError('email_domain_not_allowed', 'The email domain is not allowed');
  }
}

/** How a sign-in reaches its account. */
type SignInPlan =
  | { kind: 'returning'; user: UserRecord; identity: UserIdentityRecord }
  | { kind: 'link'; user: UserRecord; explicit: boolean }
  | { kind: 'provision' };

/** Build the single sign-on service. */
export function createSsoService(deps: SsoServiceDeps): SsoService {
  const { config, store, crypto, audit, auth, credentials, locks } = deps;
  const oidc =
    deps.oidc ??
    createOidcClient({
      allowHttpLoopback: config.sso.allowHttpLoopback,
      allowPrivateAddresses: config.sso.allowPrivateAddresses,
    });

  function redirectUri(providerId: string): string {
    return `${config.publicUrl}/api/auth/sso/${encodeURIComponent(providerId)}/callback`;
  }

  function errorLocation(reason: SsoErrorReason, linking: boolean): string {
    return `${config.publicUrl}${linking ? '/profile' : '/login'}?sso_error=${reason}`;
  }

  /** Record why a sign-in was refused — the reason and the provider, nothing else. */
  function refused(providerId: string, error: unknown): SsoErrorReason {
    const reason: SsoErrorReason = error instanceof OidcError ? error.reason : 'server_error';
    const detail =
      error instanceof OidcError
        ? error.message
        : error instanceof Error
          ? error.name
          : 'unknown failure';
    deps.log?.({ provider_id: providerId, reason, detail }, 'A single sign-on attempt was refused');
    return reason;
  }

  async function findProvider(
    providerId: string,
    stored: StoredSsoSettings,
  ): Promise<ResolvedSsoProvider> {
    if (stored.policy === 'local_only') {
      throw new OidcError('sso_disabled', 'The login policy is local_only');
    }
    const provider = (await resolveSsoProviders(config, store, crypto, stored)).find(
      (candidate) => candidate.settings.id === providerId,
    );
    if (!provider || !provider.settings.enabled) {
      throw new OidcError('sso_disabled', 'No enabled provider has that id');
    }
    if (provider.secretUnreadable) {
      throw new OidcError(
        'provider_unavailable',
        'The stored client secret does not decrypt; re-enter it in the admin settings',
      );
    }
    return provider;
  }

  /** Mint and seal one attempt, and build the authorization request for it. */
  async function begin(
    provider: ResolvedSsoProvider,
    returnTo: string,
    link: SsoCurrentSession | null,
  ): Promise<{ location: string; transaction: string }> {
    const discovery = await oidc.discover(provider.settings.issuer);
    const transaction: SsoTransaction = {
      v: 1,
      provider: provider.settings.id,
      state: randomUrlToken(),
      nonce: randomUrlToken(),
      verifier: randomUrlToken(),
      return_to: returnTo,
      expires_at: Date.now() + SSO_TRANSACTION_TTL_SECONDS * 1000,
      link_user_id: link?.userId ?? null,
      link_session_id: link?.sessionId ?? null,
    };
    return {
      location: authorizationUrl({
        discovery,
        clientId: provider.settings.client_id,
        redirectUri: redirectUri(provider.settings.id),
        scopes: provider.settings.scopes,
        state: transaction.state,
        nonce: transaction.nonce,
        codeChallenge: pkceChallenge(transaction.verifier),
      }),
      transaction: crypto.sealSsoTransaction(transaction),
    };
  }

  function openTransaction(cookie: string | undefined): SsoTransaction | null {
    if (cookie === undefined || cookie === '') return null;
    let value: unknown;
    try {
      value = crypto.openSsoTransaction<unknown>(cookie);
    } catch {
      return null;
    }
    if (value === null || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const optionalId = (field: unknown): field is string | null =>
      field === null || typeof field === 'string';
    if (
      record.v !== 1 ||
      typeof record.provider !== 'string' ||
      typeof record.state !== 'string' ||
      typeof record.nonce !== 'string' ||
      typeof record.verifier !== 'string' ||
      typeof record.return_to !== 'string' ||
      typeof record.expires_at !== 'number' ||
      !optionalId(record.link_user_id) ||
      !optionalId(record.link_session_id)
    ) {
      return null;
    }
    return {
      v: 1,
      provider: record.provider,
      state: record.state,
      nonce: record.nonce,
      verifier: record.verifier,
      return_to: safeReturnPath(record.return_to),
      expires_at: record.expires_at,
      link_user_id: record.link_user_id,
      link_session_id: record.link_session_id,
    };
  }

  /**
   * Disable an account whose claims no longer map to any role, and queue its
   * gateway revocation — the same durable work an administrator's disable
   * owes, taken under the same lifecycle key. Never a `super_admin`.
   */
  async function deprovision(
    user: UserRecord,
    provider: SsoProviderSettings,
    subject: string,
    context: RequestContext,
  ): Promise<void> {
    const job = await locks(userLifecycleLockKey(user.id), () =>
      store.transaction(async (tx) => {
        const current = await tx.users.findById(user.id);
        if (!current || current.status !== 'active' || current.role === 'super_admin') return null;
        const disabled = await tx.users.updateIfMatches(
          current.id,
          { role: current.role, status: 'active' },
          { status: 'disabled' },
        );
        if (!disabled) return null;
        const queued = await tx.gatewayTeardownJobs.upsertPending(current.id, null, nowIso());
        const terminatedSessions = await tx.sessions.deleteForUser(current.id);
        await audit.forStore(tx).record(
          SYSTEM_ACTOR,
          AuditAction.AUTH_SSO_DEPROVISION,
          { type: 'user', id: current.id },
          {
            provider_id: provider.id,
            subject,
            reason: 'no_mapped_role',
            role: current.role,
            terminated_sessions: terminatedSessions,
            gateway_teardown: 'queued',
          },
          context.ip,
        );
        return queued;
      }),
    );
    if (!job) return;
    const attempt = await runGatewayTeardown({
      credentials,
      store,
      userId: user.id,
      subject: user.id,
      job,
      ...(deps.log ? { log: deps.log } : {}),
    });
    if (attempt.outcome !== 'pending') {
      await audit.record(
        SYSTEM_ACTOR,
        AuditAction.USER_GATEWAY_TEARDOWN_COMPLETE,
        { type: 'user', id: user.id },
        { inline: true, ...attempt.details },
        context.ip,
      );
    }
  }

  /**
   * Whether the portal holds proof that `account`'s holder controls its
   * current address — the portal half of the linking rule.
   *
   * `users.email_verified` is not proof: with the registration policy's
   * verification off, every registration is marked verified without any, and
   * turning verification on later does not change what those rows are. A
   * proof is written only by a redeemed verification link, a completed
   * password reset, or a provider that verified the address, and covers the
   * address it was written for.
   */
  async function addressProven(account: UserRecord): Promise<boolean> {
    const proof = await store.emailProofs.findByUser(account.id);
    return proof !== null && proof.email === account.email.trim().toLowerCase();
  }

  /** Decide which account an explicit link attaches to. */
  async function planExplicitLink(
    provider: ResolvedSsoProvider,
    claims: IdTokenClaims,
    email: string | null,
    emailVerified: boolean,
    mapping: ClaimMapping,
    transaction: SsoTransaction,
    current: SsoCurrentSession | null,
  ): Promise<SignInPlan> {
    // The attempt is bound to the session that started it: a link that comes
    // back to another browser, or after the session changed, attaches nothing.
    if (
      current === null ||
      current.userId !== transaction.link_user_id ||
      current.sessionId !== transaction.link_session_id
    ) {
      throw new OidcError('link_session_mismatch', 'The link did not return to its session');
    }
    const settings = provider.settings;
    checkDomains(email, emailVerified, settings.allowed_email_domains);
    const account = await store.users.findById(current.userId);
    if (!account || account.status !== 'active') {
      throw new OidcError('account_disabled', 'The account is not active');
    }
    const identity = await store.userIdentities.findBySubject(
      settings.id,
      settings.issuer,
      claims.sub,
    );
    if (identity) {
      if (identity.user_id !== account.id) {
        throw new OidcError('already_linked', 'The identity is linked to another account');
      }
      return { kind: 'returning', user: account, identity };
    }
    const links = await store.userIdentities.listByUser(account.id);
    if (links.some((link) => link.provider_id === settings.id)) {
      throw new OidcError('already_linked', 'The account is already linked at this provider');
    }
    if (mapping.role === null && account.role !== 'super_admin') {
      throw new OidcError('access_denied', 'The claims map to no role');
    }
    return { kind: 'link', user: account, explicit: true };
  }

  /** Decide which account the claims open, refusing with an {@link OidcError}. */
  async function planSignIn(
    provider: ResolvedSsoProvider,
    claims: IdTokenClaims,
    email: string | null,
    emailVerified: boolean,
    mapping: ClaimMapping,
    stored: StoredSsoSettings,
    context: RequestContext,
  ): Promise<SignInPlan> {
    const settings = provider.settings;
    const identity = await store.userIdentities.findBySubject(
      settings.id,
      settings.issuer,
      claims.sub,
    );
    if (identity) {
      const user = await store.users.findById(identity.user_id);
      if (!user) throw new OidcError('server_error', 'The linked account no longer exists');
      if (user.status !== 'active') {
        throw new OidcError('account_disabled', 'The linked account is disabled');
      }
      // A super admin's role is never decided by claims, so claims that map
      // to nothing do not lock one out either.
      if (mapping.role === null && user.role !== 'super_admin') {
        if (stored.deprovision_on_access_loss) {
          await deprovision(user, settings, claims.sub, context);
        }
        throw new OidcError('access_denied', 'The claims map to no role');
      }
      return { kind: 'returning', user, identity };
    }

    if (email === null) throw new OidcError('email_required', 'The ID token has no usable email');
    checkDomains(email, emailVerified, settings.allowed_email_domains);
    const existing = await store.users.findByEmail(email);
    if (existing) {
      if (!settings.link_existing_accounts) {
        throw new OidcError('account_exists', 'Linking existing accounts is off for this provider');
      }
      // Whoever controls a provider that asserts this address would gain the
      // account: never an administrator's, which links explicitly instead.
      if (roleAtLeast(existing.role, 'admin')) {
        throw new OidcError('privileged_account', 'Administrator accounts link explicitly');
      }
      if (!emailVerified) {
        throw new OidcError('email_not_verified', 'The provider did not verify the address');
      }
      if (!(await addressProven(existing))) {
        throw new OidcError('account_exists', 'The portal holds no proof of the address');
      }
      if (existing.status !== 'active') {
        throw new OidcError('account_disabled', 'The matching account is disabled');
      }
      const links = await store.userIdentities.listByUser(existing.id);
      if (links.some((link) => link.provider_id === settings.id)) {
        throw new OidcError(
          'account_exists',
          'The account is already linked to another subject at this provider',
        );
      }
      if (mapping.role === null) throw new OidcError('access_denied', 'The claims map to no role');
      return { kind: 'link', user: existing, explicit: false };
    }

    if (!settings.jit_provisioning) {
      throw new OidcError('signup_disabled', 'Just-in-time provisioning is off');
    }
    if (settings.require_verified_email && !emailVerified) {
      throw new OidcError('email_not_verified', 'The provider did not verify the address');
    }
    if (mapping.role === null) throw new OidcError('access_denied', 'The claims map to no role');
    return { kind: 'provision' };
  }

  /**
   * Carry out the plan: provision or link, sync the claims, stamp the link
   * and open the session — one transaction, every change audited in it, so a
   * failure leaves no half-linked account and no unaudited role change.
   */
  async function signIn(
    plan: SignInPlan,
    provider: SsoProviderSettings,
    claims: IdTokenClaims,
    email: string | null,
    emailVerified: boolean,
    mapping: ClaimMapping,
    context: RequestContext,
  ): Promise<IssuedSession> {
    // Everything slow or random that does not depend on the database happens
    // before the body, which may be re-run on contention.
    const at = nowIso();
    const passwordHash = plan.kind === 'provision' ? unusablePasswordHash() : '';
    const orgExists =
      typeof mapping.orgId === 'string'
        ? (await store.organizations.findById(mapping.orgId)) !== null
        : false;
    const subject = claims.sub;

    return store.transaction(async (tx) => {
      let user: UserRecord;
      let identityId: Uuid;
      if (plan.kind === 'provision') {
        if (email === null || mapping.role === null) {
          throw new OidcError('server_error', 'Provisioning without an address or a role');
        }
        user = await tx.users.create({
          email,
          password_hash: passwordHash,
          display_name: displayNameFromClaims(claims, email),
          role: mapping.role,
          org_id: typeof mapping.orgId === 'string' && orgExists ? mapping.orgId : null,
          status: 'active',
          email_verified: emailVerified,
        });
        const identity = await tx.userIdentities.create({
          user_id: user.id,
          provider_id: provider.id,
          issuer: provider.issuer,
          subject,
          email,
          provisioned: true,
          last_login_at: at,
        });
        identityId = identity.id;
        // The account never has a local password, whatever later happens to
        // this link or this provider.
        await tx.passwordLocks.create(user.id, provider.id, at);
        if (emailVerified) {
          await tx.emailProofs.upsert(user.id, email, 'identity_provider', at);
        }
        await audit.forStore(tx).record(
          { id: user.id, role: user.role },
          AuditAction.AUTH_SSO_PROVISION,
          { type: 'user', id: user.id },
          {
            provider_id: provider.id,
            subject,
            email,
            email_verified: emailVerified,
            role: user.role,
            org_id: user.org_id,
            role_mapping: mapping.roleMapping,
            org_mapping: mapping.orgMapping,
          },
          context.ip,
        );
      } else {
        const current = await tx.users.findById(plan.user.id);
        if (!current) throw new OidcError('server_error', 'The account no longer exists');
        if (current.status !== 'active') {
          throw new OidcError('account_disabled', 'The account was disabled during sign-in');
        }
        user = current;
        if (plan.kind === 'link') {
          const identity = await tx.userIdentities.create({
            user_id: user.id,
            provider_id: provider.id,
            issuer: provider.issuer,
            subject,
            email,
            provisioned: false,
            last_login_at: at,
          });
          identityId = identity.id;
          // A provider that verified this very address is proof of it too.
          if (emailVerified && email !== null && email === user.email.trim().toLowerCase()) {
            await tx.emailProofs.upsert(user.id, email, 'identity_provider', at);
          }
          await audit.forStore(tx).record(
            { id: user.id, role: user.role },
            AuditAction.AUTH_SSO_LINK,
            { type: 'user', id: user.id },
            {
              provider_id: provider.id,
              subject,
              identity_id: identity.id,
              email,
              explicit: plan.explicit,
              email_verified_by_provider: emailVerified,
            },
            context.ip,
          );
        } else {
          identityId = plan.identity.id;
          if (!(await tx.userIdentities.touchLogin(identityId, email, at))) {
            throw new OidcError('server_error', 'The identity was unlinked during sign-in');
          }
        }

        const change = planClaimsChange(user, mapping, provider, orgExists);
        if (change) {
          const updated = await tx.users.updateIfMatches(
            user.id,
            { role: user.role, status: 'active' },
            change,
          );
          if (!updated) throw new OidcError('server_error', 'The account changed during sign-in');
          await audit.forStore(tx).record(
            SYSTEM_ACTOR,
            AuditAction.AUTH_SSO_CLAIMS_SYNC,
            { type: 'user', id: user.id },
            {
              provider_id: provider.id,
              subject,
              ...(change.role !== undefined ? { from_role: user.role, to_role: change.role } : {}),
              ...(change.org_id !== undefined
                ? { from_org_id: user.org_id, to_org_id: change.org_id }
                : {}),
              role_mapping: mapping.roleMapping,
              org_mapping: mapping.orgMapping,
            },
            context.ip,
          );
          user = updated;
        }
      }

      await tx.users.touchLastLogin(user.id, at);
      const issued = await auth.issueSession(user, context, tx);
      await audit.forStore(tx).record(
        { id: user.id, role: user.role },
        AuditAction.AUTH_SSO_LOGIN,
        { type: 'user', id: user.id },
        {
          provider_id: provider.id,
          subject,
          identity_id: identityId,
          email,
          ...(plan.kind === 'provision' ? { provisioned: true } : {}),
          ...(plan.kind === 'link' ? { linked: true } : {}),
        },
        context.ip,
      );
      return issued;
    });
  }

  async function publicConfig(): Promise<SsoPublicConfigResponse> {
    const stored = await readStoredSsoSettings(store);
    const policy: LoginPolicy = stored.policy;
    const providers =
      policy === 'local_only'
        ? []
        : providersInForce(config, stored)
            .filter(({ settings }) => settings.enabled)
            .map(({ settings }) => ({ id: settings.id, display_name: settings.display_name }));
    return {
      policy,
      password_login:
        policy !== 'sso_only'
          ? 'enabled'
          : config.sso.breakGlassLocalLogin
            ? 'break_glass'
            : 'disabled',
      registration_enabled: policy !== 'sso_only',
      providers,
    };
  }

  async function getAdminSettings(): Promise<SsoAdminSettingsResponse> {
    const stored = await readStoredSsoSettings(store);
    const providers = await resolveSsoProviders(config, store, crypto, stored);
    return {
      policy: stored.policy,
      allowed_email_domains: stored.allowed_email_domains,
      deprovision_on_access_loss: stored.deprovision_on_access_loss,
      break_glass_local_login: config.sso.breakGlassLocalLogin,
      providers: providers.map((provider) => ({
        ...provider.settings,
        source: provider.source,
        client_secret_set: provider.clientSecret !== null,
        redirect_uri: redirectUri(provider.settings.id),
      })),
      shadowed_provider_ids: shadowedProviderIds(config, stored),
    };
  }

  /** Normalise one list of domains, refusing anything that is not one. */
  function normalizeDomains(entries: readonly string[], what: string): string[] {
    if (entries.length > MAX_ALLOWED_EMAIL_DOMAINS) {
      throw validationFailed(`At most ${MAX_ALLOWED_EMAIL_DOMAINS} email domains are allowed`);
    }
    const domains: string[] = [];
    for (const entry of entries) {
      const domain = normalizeEmailDomain(entry);
      if (domain === null) throw validationFailed(`${what}: '${entry}' is not a domain name`);
      if (!domains.includes(domain)) domains.push(domain);
    }
    return domains;
  }

  return {
    publicConfig,
    getAdminSettings,

    async start(providerId, returnTo): Promise<SsoStartResult> {
      try {
        const stored = await readStoredSsoSettings(store);
        const provider = await findProvider(providerId, stored);
        return await begin(provider, safeReturnPath(returnTo), null);
      } catch (error) {
        return { location: errorLocation(refused(providerId, error), false), transaction: null };
      }
    },

    async startLink(providerId, current): Promise<{ location: string; transaction: string }> {
      try {
        const stored = await readStoredSsoSettings(store);
        const provider = await findProvider(providerId, stored);
        return await begin(provider, '/profile', current);
      } catch (error) {
        const reason = refused(providerId, error);
        throw validationFailed('Linking cannot start with that provider', { reason });
      }
    },

    async callback(
      providerId,
      query,
      transactionCookie,
      current,
      context,
    ): Promise<SsoCallbackResult> {
      let linking = false;
      try {
        const stored = await readStoredSsoSettings(store);
        const provider = await findProvider(providerId, stored);

        // The attempt this browser started — and only it. Without the sealed
        // cookie, or with a `state` that is not the one it holds, the response
        // is somebody else's (login CSRF) or a replay, and is refused before
        // the code is ever redeemed.
        const transaction = openTransaction(transactionCookie);
        if (
          transaction === null ||
          transaction.provider !== provider.settings.id ||
          transaction.expires_at <= Date.now()
        ) {
          throw new OidcError('invalid_state', 'No live sign-in attempt for this browser');
        }
        linking = transaction.link_user_id !== null;
        if (typeof query.state !== 'string' || !tokensEqual(query.state, transaction.state)) {
          throw new OidcError('invalid_state', 'The state does not match this sign-in attempt');
        }
        if (query.error !== undefined) {
          throw new OidcError('idp_error', 'The provider refused the authorization request');
        }
        if (typeof query.code !== 'string' || query.code === '') {
          throw new OidcError('idp_error', 'The provider returned no authorization code');
        }

        const discovery = await oidc.discover(provider.settings.issuer);
        const tokens = await oidc.exchangeCode({
          discovery,
          clientId: provider.settings.client_id,
          clientSecret: provider.clientSecret,
          code: query.code,
          redirectUri: redirectUri(provider.settings.id),
          codeVerifier: transaction.verifier,
        });
        const claims = await oidc.validateIdToken({
          idToken: tokens.idToken,
          discovery,
          clientId: provider.settings.client_id,
          nonce: transaction.nonce,
          accessToken: tokens.accessToken,
        });

        const email = normalizeEmailClaim(claims.email);
        const emailVerified = emailVerifiedClaim(claims.email_verified);
        // The deployment-wide list applies to every sign-in, returning ones
        // included; the provider's own list to linking and provisioning.
        checkDomains(email, emailVerified, stored.allowed_email_domains);
        const mapping = mapClaims(provider.settings, claims);
        const plan = linking
          ? await planExplicitLink(
              provider,
              claims,
              email,
              emailVerified,
              mapping,
              transaction,
              current,
            )
          : await planSignIn(provider, claims, email, emailVerified, mapping, stored, context);
        const issued = await signIn(
          plan,
          provider.settings,
          claims,
          email,
          emailVerified,
          mapping,
          context,
        );
        return { ok: true, location: `${config.publicUrl}${transaction.return_to}`, issued };
      } catch (error) {
        const reason = refused(providerId, error);
        return { ok: false, location: errorLocation(reason, linking), reason };
      }
    },

    async updateAdminSettings(actor, patch, ip): Promise<SsoAdminSettingsResponse> {
      if (actor.role === null || !roleAtLeast(actor.role, 'super_admin')) {
        throw forbidden('Only a super admin can change single sign-on settings');
      }
      const stored = await readStoredSsoSettings(store);
      const next: StoredSsoSettings = { ...stored, providers: [...stored.providers] };
      const changed: string[] = [];

      if (patch.policy !== undefined && patch.policy !== stored.policy) {
        next.policy = patch.policy;
        changed.push('policy');
      }
      if (patch.allowed_email_domains !== undefined) {
        const domains = normalizeDomains(patch.allowed_email_domains, 'Allowed email domains');
        if (!isDeepStrictEqual(domains, stored.allowed_email_domains)) {
          next.allowed_email_domains = domains;
          changed.push('allowed_email_domains');
        }
      }
      if (
        patch.deprovision_on_access_loss !== undefined &&
        patch.deprovision_on_access_loss !== stored.deprovision_on_access_loss
      ) {
        next.deprovision_on_access_loss = patch.deprovision_on_access_loss;
        changed.push('deprovision_on_access_loss');
      }

      // Provider id → the secret to store, or `null` to delete the stored one.
      const secretWrites = new Map<string, string | null>();
      const added: string[] = [];
      const removed: string[] = [];
      if (patch.providers !== undefined) {
        const envIds = new Set(config.sso.providers.map((provider) => provider.settings.id));
        if (envIds.size + patch.providers.length > MAX_SSO_PROVIDERS) {
          throw validationFailed(`At most ${MAX_SSO_PROVIDERS} providers can be configured`);
        }
        const previous = new Map(stored.providers.map((provider) => [provider.id, provider]));
        const seen = new Set<string>();
        const providers: SsoProviderSettings[] = [];
        for (const { client_secret: secret, ...provider } of patch.providers) {
          if (seen.has(provider.id)) {
            throw validationFailed(`Provider '${provider.id}' is listed more than once`);
          }
          seen.add(provider.id);
          if (envIds.has(provider.id)) {
            throw validationFailed(
              `Provider '${provider.id}' comes from NEXUS_OIDC_PROVIDERS and is read-only here`,
            );
          }
          const problem = issuerProblem(provider.issuer, config.sso.allowHttpLoopback);
          if (problem !== null) {
            throw validationFailed(`Provider '${provider.id}' issuer ${problem}`);
          }
          // Links are keyed on the issuer: moving a provider with links to
          // another issuer would strand them, or worse, keep an id pointing at
          // accounts the new issuer's subjects must not reach.
          const before = previous.get(provider.id);
          if (
            before !== undefined &&
            before.issuer !== provider.issuer &&
            (await store.userIdentities.countByProvider(provider.id)) > 0
          ) {
            throw validationFailed(
              `Provider '${provider.id}' has linked accounts; add another provider for that issuer`,
            );
          }
          for (const mapping of provider.org_mappings) {
            if (!(await store.organizations.findById(mapping.org_id))) {
              throw notFound('Organization', mapping.org_id);
            }
          }
          providers.push({
            ...provider,
            allowed_email_domains: normalizeDomains(
              provider.allowed_email_domains,
              `Provider '${provider.id}' allowed email domains`,
            ),
          });
          if (secret !== undefined) secretWrites.set(provider.id, secret);
        }
        for (const id of seen) if (!previous.has(id)) added.push(id);
        for (const id of previous.keys()) {
          if (!seen.has(id)) {
            removed.push(id);
            secretWrites.set(id, null);
          }
        }
        next.providers = providers;
        if (!isDeepStrictEqual(next.providers, stored.providers)) changed.push('providers');
      }

      // A policy that refuses passwords needs a way in that is not a password
      // — for everyone, and for the super admin saving it in particular.
      if (next.policy === 'sso_only' && (patch.policy !== undefined || patch.providers)) {
        const enabled = new Map(
          providersInForce(config, next)
            .filter(({ settings }) => settings.enabled)
            .map(({ settings }): [string, string] => [settings.id, settings.issuer]),
        );
        if (enabled.size === 0) {
          throw validationFailed('The sso_only policy needs at least one enabled provider');
        }
        const own = await store.userIdentities.listByUser(actor.id);
        if (!own.some((link) => enabled.get(link.provider_id) === link.issuer)) {
          throw validationFailed(
            'Link your own account to an enabled provider (Profile → Linked sign-in) ' +
              'before switching to sso_only',
          );
        }
      }

      if (changed.length === 0 && secretWrites.size === 0) return getAdminSettings();

      // Encrypted before the body, which may be re-run.
      const encrypted = new Map<string, string | null>();
      for (const [id, secret] of secretWrites) {
        encrypted.set(id, secret === null ? null : crypto.encryptJson(secret));
      }
      await store.transaction(async (tx) => {
        await tx.settings.set(SSO_SETTINGS_KEY, next, false);
        for (const [id, blob] of encrypted) {
          if (blob === null) await tx.settings.delete(ssoClientSecretKey(id));
          else await tx.settings.set(ssoClientSecretKey(id), blob, true);
        }
        // A removed provider's links go with it, so a provider added later
        // under the same id starts with none. A stored provider shadowed by an
        // environment one leaves the links alone: they are the environment
        // provider's, which stays in force.
        const envIds = new Set(config.sso.providers.map((provider) => provider.settings.id));
        const linksRemoved: Record<string, number> = {};
        for (const id of removed) {
          if (envIds.has(id)) continue;
          linksRemoved[id] = await tx.userIdentities.deleteByProvider(id);
        }
        // Key names and provider ids only: never a secret, and never the
        // mappings themselves, which the settings page shows to admins anyway.
        await audit.forStore(tx).record(
          actor,
          AuditAction.ADMIN_SETTINGS_UPDATE,
          { type: 'settings', id: SSO_SETTINGS_KEY },
          {
            section: 'sso',
            changed_keys: changed,
            providers_added: added,
            providers_removed: removed,
            links_removed: linksRemoved,
            client_secrets_changed: [...secretWrites.keys()],
          },
          ip,
        );
      });
      oidc.clearCache();
      return getAdminSettings();
    },

    async listIdentities(userId): Promise<UserIdentity[]> {
      if (!(await store.users.findById(userId))) throw notFound('User', userId);
      return (await store.userIdentities.listByUser(userId)).map(toUserIdentity);
    },

    async unlinkIdentity(actor, userId, identityId, ip): Promise<void> {
      const target = await store.users.findById(userId);
      if (!target) throw notFound('User', userId);
      if (roleAtLeast(target.role, 'admin') && !roleAtLeast(actor.role, 'super_admin')) {
        throw forbidden("Only a super admin can unlink an administrator's identity");
      }
      await store.transaction(async (tx) => {
        const identity = await tx.userIdentities.findById(identityId);
        if (!identity || identity.user_id !== userId) throw notFound('Identity', identityId);
        if (!(await tx.userIdentities.delete(identity.id))) throw notFound('Identity', identityId);
        await audit.forStore(tx).record(
          { id: actor.id, role: actor.role },
          AuditAction.AUTH_SSO_UNLINK,
          { type: 'user', id: userId },
          {
            identity_id: identity.id,
            provider_id: identity.provider_id,
            subject: identity.subject,
          },
          ip,
        );
      });
    },
  };
}
