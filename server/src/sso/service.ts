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
 *   attaches the identity to that account only when the callback comes back
 *   to the same session and the portal already holds proof of the account's
 *   address in `user_email_proofs`. The provider's `email_verified` is not
 *   enough here: whoever registered the address first holds a session too,
 *   and could otherwise attach an identity of their own that survives the
 *   rightful holder's password reset. The one exception is the founding
 *   `super_admin` recorded under `SUPER_ADMIN_CLAIM_KEY`, whose seat the
 *   operator's bootstrap token already proved. Accepting an explicit link
 *   records no proof of its own.
 * - **Otherwise an existing account with the same address is linked only
 *   when both sides have proven it**: the provider asserts
 *   `email_verified: true` (the JSON boolean) *and* the portal holds a proof
 *   of the address in `user_email_proofs` — a redeemed verification link, a
 *   completed reset, or a provider that verified it before. `email_verified`
 *   alone is not proof. An `admin` or `super_admin` is never linked this way,
 *   and neither is an account this provider's claims would make one: its
 *   holder links explicitly. Anything less is refused and nothing is linked.
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
 *
 * A role is the account's, and a session carries no provider, so claims never
 * promote an account to `admin` while it holds an identity at another provider
 * that is not itself trusted to grant `admin`: the promotion is withheld and
 * audited, and a `super_admin` decides. A promotion that does go through ends
 * the account's other sessions, so none opened before it inherits the role.
 *
 * That transaction re-reads the provider: one removed, disabled or
 * reconfigured while the callback waited on the provider's token endpoint, or
 * a login policy turned to `local_only`, commits nothing. A first-time link or
 * a provisioned account commits under the provider's `ssoProviderLockKey`,
 * which settings saves hold too, so the re-read cannot miss a save that is
 * committing at the same moment.
 */

import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  isReleasedEmail,
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
import {
  SUPER_ADMIN_CLAIM_KEY,
  type AuthService,
  type IssuedSession,
  type RequestContext,
} from '../auth/service.js';
import type { NexusConfig } from '../config/index.js';
import { runGatewayTeardown, type CredentialsService } from '../credentials/service.js';
import type { NexusStore, UserIdentityRecord, UserRecord } from '../db/store.js';
import { SCRYPT_PARAMS, type NexusCrypto } from '../lib/crypto.js';
import { conflict, forbidden, notFound, validationFailed } from '../lib/errors.js';
import { nowIso } from '../lib/ids.js';
import {
  SSO_SETTINGS_LOCK_KEY,
  ssoProviderLockKey,
  userLifecycleLockKey,
  type KeyedSerializer,
} from '../lib/keyed-serializer.js';
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
  /** Refuse a manual admin promotion while lower-trust provider identities remain linked. */
  assertManualAdminPromotionAllowed(tx: NexusStore, userId: Uuid): Promise<void>;
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

/**
 * Whether an automatic link would leave a provider identity on an
 * administrator's account: the account is an `admin` or `super_admin` already,
 * or the claims this sign-in carries would make it one.
 *
 * The second half is the one that matters across providers. The role is the
 * account's, not the identity's, so a promotion by this provider would hand
 * administrator access to every identity already on the account — one a
 * lower-trust provider provisioned or linked included — and to its live
 * sessions. Only an explicit link, made by the account's holder from a
 * signed-in session, may put an identity on an administrator's account.
 */
function privilegedAutoLink(
  account: UserRecord,
  mapping: ClaimMapping,
  provider: SsoProviderSettings,
): boolean {
  if (roleAtLeast(account.role, 'admin')) return true;
  const mapped = planClaimsChange(account, mapping, provider, false)?.role;
  return mapped !== undefined && roleAtLeast(mapped, 'admin');
}

/**
 * Whether the deployment trusts `provider` to make the accounts it opens
 * administrators: it re-applies the role on every sign-in (`sync_roles`) and
 * its default role or one of its mappings is `admin`.
 *
 * An identity at such a provider can already raise its account to `admin` on
 * its own, so another provider's promotion hands it nothing new. Any other
 * provider is lower-trust for this purpose.
 */
function grantsAdmin(provider: SsoProviderSettings): boolean {
  if (!provider.sync_roles) return false;
  const roles = [provider.default_role, ...provider.role_mappings.map((rule) => rule.role)];
  return roles.some((role) => role !== null && roleAtLeast(role, 'admin'));
}

/** How a sign-in reaches its account. */
type SignInPlan =
  | {
      kind: 'returning';
      user: UserRecord;
      identity: UserIdentityRecord;
      initiatingSessionId?: Uuid;
    }
  | { kind: 'link'; user: UserRecord; explicit: boolean; initiatingSessionId?: Uuid }
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

  /**
   * Re-read the settings through `tx`, inside the transaction about to commit
   * what a callback decided, and refuse unless the login policy still allows
   * single sign-on and the provider is still in force, enabled, and configured
   * exactly as the callback found it before its slow token exchange.
   *
   * A commit that writes one of the provider's links runs under the
   * provider's {@link ssoProviderLockKey}, which a settings save takes as well,
   * so a removal or a disable that has committed is seen here, and one that
   * has not yet started waits for this commit. A returning sign-in writes
   * nothing a save reads, so this re-read alone orders it against one.
   */
  async function currentSettings(
    tx: NexusStore,
    provider: SsoProviderSettings,
  ): Promise<StoredSsoSettings> {
    const stored = await readStoredSsoSettings(tx);
    if (stored.policy === 'local_only') {
      throw new OidcError('sso_disabled', 'The login policy became local_only during sign-in');
    }
    const current = providersInForce(config, stored).find(
      ({ settings }) => settings.id === provider.id,
    );
    if (!current || !current.settings.enabled) {
      throw new OidcError('sso_disabled', 'The provider was removed or disabled during sign-in');
    }
    if (!isDeepStrictEqual(current.settings, provider)) {
      throw new OidcError('sso_disabled', 'The provider was reconfigured during sign-in');
    }
    return stored;
  }

  /**
   * The providers other than `provider` at which the account holds an
   * identity, leaving out those {@link grantsAdmin} trusts with `admin` under
   * the identity's issuer. Read through `tx`, under the account's
   * {@link userLifecycleLockKey}, so an automatic link committing at another
   * provider is either seen here or sees the promotion.
   *
   * Explicit links count as well as automatic ones. A session records neither
   * the provider nor the password that opened it, so an explicit link proves
   * only that someone holding a session on the account made it — possibly
   * through the very lower-trust identity this guards against.
   */
  async function lowerTrustProviders(
    tx: NexusStore,
    userId: Uuid,
    provider: SsoProviderSettings,
    stored: StoredSsoSettings,
  ): Promise<string[]> {
    const trusted = new Map(
      providersInForce(config, stored)
        .filter(({ settings }) => grantsAdmin(settings))
        .map(({ settings }): [string, string] => [settings.id, settings.issuer]),
    );
    const others = (await tx.userIdentities.listByUser(userId)).filter(
      (identity) =>
        identity.provider_id !== provider.id &&
        trusted.get(identity.provider_id) !== identity.issuer,
    );
    return [...new Set(others.map((identity) => identity.provider_id))].sort();
  }

  async function lowerTrustProvidersForManualPromotion(
    tx: NexusStore,
    userId: Uuid,
    stored: StoredSsoSettings,
  ): Promise<string[]> {
    const trusted = new Map(
      providersInForce(config, stored)
        .filter(({ settings }) => grantsAdmin(settings))
        .map(({ settings }): [string, string] => [settings.id, settings.issuer]),
    );
    const identities = await tx.userIdentities.listByUser(userId);
    return [
      ...new Set(
        identities
          .filter((identity) => trusted.get(identity.provider_id) !== identity.issuer)
          .map((identity) => identity.provider_id),
      ),
    ].sort();
  }

  /**
   * Run `fn` holding {@link ssoProviderLockKey} for every one of `providerIds`,
   * taken one inside the other in sorted order so two saves never wait on each
   * other's keys. Never called inside a transaction.
   */
  function underProviderLocks<T>(providerIds: Iterable<string>, fn: () => Promise<T>): Promise<T> {
    const keys = [...new Set(providerIds)].sort().map(ssoProviderLockKey);
    let section = fn;
    // Innermost last: the first key in sorted order is the outermost section.
    for (const key of keys.reverse()) {
      const inner = section;
      section = () => locks(key, inner);
    }
    return section();
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
   * owes, taken under the same lifecycle key. Never a `super_admin`. Taken
   * inside the provider's {@link ssoProviderLockKey}, and only while the
   * provider and `deprovision_on_access_loss` are still as the callback read
   * them.
   */
  async function deprovision(
    user: UserRecord,
    provider: SsoProviderSettings,
    subject: string,
    context: RequestContext,
  ): Promise<void> {
    const job = await locks(ssoProviderLockKey(provider.id), () =>
      locks(userLifecycleLockKey(user.id), () =>
        store.transaction(async (tx) => {
          // The provider, and the setting that called for this, as they are
          // now: a stale callback deprovisions nobody.
          const stored = await currentSettings(tx, provider);
          if (!stored.deprovision_on_access_loss) return null;
          const current = await tx.users.findById(user.id);
          if (!current || current.status !== 'active' || current.role === 'super_admin') {
            return null;
          }
          const disabled = await tx.users.updateIfMatches(
            current.id,
            { role: current.role, status: 'active' },
            { status: 'disabled' },
          );
          if (!disabled) return null;
          const queued = await tx.gatewayTeardownJobs.upsertPending(current.id, null, nowIso());
          const terminatedSessions = await tx.sessions.deleteForUser(current.id);
          // A deprovision is a disable: an outstanding reset link must die with
          // the session cut-off, or re-enabling the account inside the link's
          // lifetime would revive a recovery capability the disable ended
          // (issue #499). Committed with the status flip like every other disable.
          const revokedResetLinks = await tx.verificationTokens.deleteForUser(
            current.id,
            'password_reset',
          );
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
              ...(revokedResetLinks > 0 ? { revoked_reset_links: revokedResetLinks } : {}),
              gateway_teardown: 'queued',
            },
            context.ip,
          );
          return queued;
        }),
      ),
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
    return (
      proof !== null &&
      proof.method !== 'verification_link' &&
      proof.email === account.email.trim().toLowerCase()
    );
  }

  /**
   * Whether `account` is the portal's founding `super_admin`: the account
   * recorded under {@link SUPER_ADMIN_CLAIM_KEY}, seated with the operator's
   * bootstrap token. That token proves the operator owns the account, which
   * stands in for a mailbox proof on an explicit link — a portal without SMTP
   * gives its founder no other way to earn one.
   */
  async function seatedFounder(account: UserRecord): Promise<boolean> {
    if (account.role !== 'super_admin') return false;
    const claim: unknown = (await store.settings.get(SUPER_ADMIN_CLAIM_KEY))?.value;
    return (
      typeof claim === 'object' &&
      claim !== null &&
      (claim as { user_id?: unknown }).user_id === account.id
    );
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
      return {
        kind: 'returning',
        user: account,
        identity,
        initiatingSessionId: current.sessionId,
      };
    }
    const links = await store.userIdentities.listByUser(account.id);
    if (links.some((link) => link.provider_id === settings.id)) {
      throw new OidcError('already_linked', 'The account is already linked at this provider');
    }
    // The portal must already hold proof that this account's holder controls
    // its address. The provider asserting `email_verified` for the same
    // address is not enough: an account registered on someone else's address
    // has a session too, and could attach an identity that outlives the
    // rightful holder's password reset.
    if (!(await addressProven(account)) && !(await seatedFounder(account))) {
      throw new OidcError('address_unproven', 'The portal holds no proof of the address');
    }
    if (mapping.role === null && account.role !== 'super_admin') {
      throw new OidcError('access_denied', 'The claims map to no role');
    }
    return {
      kind: 'link',
      user: account,
      explicit: true,
      initiatingSessionId: current.sessionId,
    };
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

    if (email === null || isReleasedEmail(email)) {
      throw new OidcError('email_required', 'The ID token has no usable email');
    }
    checkDomains(email, emailVerified, settings.allowed_email_domains);
    const existing = await store.users.findByEmail(email);
    if (existing) {
      if (!settings.link_existing_accounts) {
        throw new OidcError('account_exists', 'Linking existing accounts is off for this provider');
      }
      // Whoever controls a provider that asserts this address would gain the
      // account: never an administrator's, nor one these claims would make
      // an administrator's, which links explicitly instead.
      if (privilegedAutoLink(existing, mapping, settings)) {
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

    const commit = (): Promise<IssuedSession> =>
      store.transaction(async (tx) => {
        // What the callback read before its token exchange may be stale by
        // now: the provider, the login policy and the deployment-wide domain
        // list are held to what is committed, in the transaction that commits.
        const stored = await currentSettings(tx, provider);
        checkDomains(email, emailVerified, stored.allowed_email_domains);
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
          if (plan.initiatingSessionId !== undefined) {
            // The request's authenticated session was cached before token exchange.
            // Promotion, logout or password recovery may have revoked it meanwhile.
            // Check under the lifecycle lease, in the transaction that links and
            // issues the replacement, including an already-linked explicit attempt.
            const session = await tx.sessions.findById(plan.initiatingSessionId);
            if (
              !session ||
              session.user_id !== current.id ||
              Date.parse(session.expires_at) <= Date.now()
            ) {
              throw new OidcError(
                'link_session_mismatch',
                'The initiating session is no longer valid',
              );
            }
          }
          user = current;
          if (plan.kind === 'link') {
            // Held to the account as it is now: a role granted since the plan
            // was made, or one these claims are about to grant, makes this an
            // administrator's account, which only an explicit link may reach.
            if (!plan.explicit && privilegedAutoLink(user, mapping, provider)) {
              throw new OidcError('privileged_account', 'Administrator accounts link explicitly');
            }
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
            // An automatic link held both proofs of this very address, so the
            // provider's verification refreshes the portal's. An explicit link
            // records none: there the provider's word alone would be the proof.
            if (
              !plan.explicit &&
              emailVerified &&
              email !== null &&
              email === user.email.trim().toLowerCase()
            ) {
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

          const planned = planClaimsChange(user, mapping, provider, orgExists);
          let change = planned;
          // A promotion to administrator reaches every identity on the account
          // and every session it has: neither the role nor a session belongs
          // to one provider. While a lower-trust provider can open the account,
          // claims do not promote it; the promotion is withheld, audited, and
          // left to a super admin, and the rest of the sign-in goes ahead.
          const promotedTo = planned?.role;
          let withheld: string[] = [];
          if (
            promotedTo !== undefined &&
            roleAtLeast(promotedTo, 'admin') &&
            !roleAtLeast(user.role, 'admin')
          ) {
            withheld = await lowerTrustProviders(tx, user.id, provider, stored);
            if (withheld.length > 0) {
              const orgId = planned?.org_id;
              change = orgId !== undefined ? { org_id: orgId } : null;
            }
          }
          if (change !== null || withheld.length > 0) {
            let updated = user;
            let terminatedSessions: number | null = null;
            if (change !== null) {
              const row = await tx.users.updateIfMatches(
                user.id,
                { role: user.role, status: 'active' },
                change,
              );
              if (!row) throw new OidcError('server_error', 'The account changed during sign-in');
              updated = row;
              // A raised role starts from the session this sign-in issues. One
              // opened earlier, through another provider, a password or an
              // identity since unlinked, must not inherit it.
              if (change.role !== undefined && !roleAtLeast(user.role, change.role)) {
                terminatedSessions = await tx.sessions.deleteForUser(user.id);
              }
            }
            await audit.forStore(tx).record(
              SYSTEM_ACTOR,
              AuditAction.AUTH_SSO_CLAIMS_SYNC,
              { type: 'user', id: user.id },
              {
                provider_id: provider.id,
                subject,
                ...(change !== null && change.role !== undefined
                  ? { from_role: user.role, to_role: change.role }
                  : {}),
                ...(change !== null && change.org_id !== undefined
                  ? { from_org_id: user.org_id, to_org_id: change.org_id }
                  : {}),
                ...(withheld.length > 0
                  ? {
                      role_withheld: promotedTo,
                      withheld_reason: 'lower_trust_identities',
                      lower_trust_provider_ids: withheld,
                    }
                  : {}),
                ...(terminatedSessions !== null ? { terminated_sessions: terminatedSessions } : {}),
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

    // Keys are taken before the transaction, never inside it.
    //
    // A first-time link or a provisioned account writes one of the provider's
    // links, which a settings save that removes the provider deletes by
    // predicate. The provider's key orders the two: the save either committed
    // before this body's re-read, or waits for this commit and removes the new
    // link with the rest. A returning sign-in writes nothing a save reads, so
    // the re-read alone orders it, and it does not queue every sign-in at the
    // provider behind one key.
    //
    // Any sign-in into an existing account also takes the account's lifecycle
    // key, inside the provider's: a promotion reads the account's links and an
    // automatic link at another provider reads its role, and each writes what
    // the other reads.
    const accountId = plan.kind === 'provision' ? null : plan.user.id;
    const underAccount =
      accountId === null ? commit : () => locks(userLifecycleLockKey(accountId), commit);
    return plan.kind === 'returning'
      ? underAccount()
      : locks(ssoProviderLockKey(provider.id), underAccount);
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
      // Providers whose issuer this save changes.
      const reissued: string[] = [];
      const issuerHasLinks = (id: string): Error =>
        validationFailed(
          `Provider '${id}' has linked accounts; add another provider for that issuer`,
        );
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
          // Checked here for a prompt answer, and again under the provider's
          // key, where no first-time link can commit in between.
          const before = previous.get(provider.id);
          if (before !== undefined && before.issuer !== provider.issuer) {
            reissued.push(provider.id);
            if ((await store.userIdentities.countByProvider(provider.id)) > 0) {
              throw issuerHasLinks(provider.id);
            }
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
      // Every provider this save can touch — removed, disabled, reconfigured,
      // or cut off by the policy or the domain list — is locked first, so a
      // callback that read the old settings either commits before this save
      // or re-reads the new ones and commits nothing (`currentSettings`).
      const affected = [
        ...providersInForce(config, stored).map(({ settings }) => settings.id),
        ...next.providers.map((provider) => provider.id),
      ];
      await locks(SSO_SETTINGS_LOCK_KEY, () =>
        underProviderLocks(affected, () =>
          store.transaction(async (tx) => {
            // A compare-and-swap. Everything above, the keys just taken and the
            // providers whose links go below included, was worked out from
            // `stored`, which was read before any key was held. A save that
            // committed since would make all of it stale: a provider it added
            // would be dropped unlocked, and its links left behind.
            if (!isDeepStrictEqual(await readStoredSsoSettings(tx), stored)) {
              throw conflict(
                'Single sign-on settings changed since they were read; reload and try again',
              );
            }
            for (const id of reissued) {
              if ((await tx.userIdentities.countByProvider(id)) > 0) throw issuerHasLinks(id);
            }
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
            const nextProviders = new Map(
              providersInForce(config, next).map(({ settings }): [string, SsoProviderSettings] => [
                settings.id,
                settings,
              ]),
            );
            const providersTrustLowered = providersInForce(config, stored)
              .filter(({ settings }) => {
                const updated = nextProviders.get(settings.id);
                return (
                  updated !== undefined &&
                  updated.issuer === settings.issuer &&
                  grantsAdmin(settings) &&
                  !grantsAdmin(updated)
                );
              })
              .map(({ settings }) => settings.id)
              .sort();
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
                ...(providersTrustLowered.length > 0
                  ? { providers_trust_lowered: providersTrustLowered }
                  : {}),
              },
              ip,
            );
          }),
        ),
      );
      oidc.clearCache();
      return getAdminSettings();
    },

    async listIdentities(userId): Promise<UserIdentity[]> {
      if (!(await store.users.findById(userId))) throw notFound('User', userId);
      return (await store.userIdentities.listByUser(userId)).map(toUserIdentity);
    },

    async assertManualAdminPromotionAllowed(tx, userId): Promise<void> {
      const lowerTrustProviders = await lowerTrustProvidersForManualPromotion(
        tx,
        userId,
        await readStoredSsoSettings(tx),
      );
      if (lowerTrustProviders.length > 0) {
        throw conflict(
          'Remove or raise the trust of linked single sign-on identities before promoting ' +
            'this account to admin',
          { lower_trust_provider_ids: lowerTrustProviders },
        );
      }
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
