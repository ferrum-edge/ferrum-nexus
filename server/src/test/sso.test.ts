/**
 * OpenID Connect single sign-on, end to end through the real routes against a
 * real (in-process, loopback) provider — see `mock-oidc-provider.ts`.
 *
 * Covers the flow's own guarantees (state, nonce, PKCE, ID token
 * validation), provisioning and the account-linking rules, claim mapping to
 * roles and organizations (never `super_admin`), the login policies and the
 * bootstrap path under them, deprovisioning, administration, and that an SSO
 * account is an ordinary account to the rest of the portal — its Edge
 * consumer included.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type { LightMyRequestResponse } from 'fastify';

import {
  consumerUsernameForUser,
  CSRF_COOKIE,
  SESSION_COOKIE,
  SSO_TRANSACTION_COOKIE,
  type SsoAdminSettingsResponse,
  type SsoPublicConfigResponse,
  type User,
} from '@ferrum-nexus/shared';

import { AuditAction } from '../audit/service.js';
import { REGISTRATION_SETTINGS_KEY } from '../auth/service.js';
import type { LeaseRepo, NexusStore, UserRecord } from '../db/store.js';
import { isoInSeconds } from '../lib/ids.js';
import { ssoProviderLockKey, userLifecycleLockKey } from '../lib/keyed-serializer.js';
import { readStoredSsoSettings, SSO_SETTINGS_KEY, ssoClientSecretKey } from '../sso/settings.js';
import {
  buildTestApp,
  cookieValue,
  TEST_BOOTSTRAP_TOKEN,
  TEST_PASSWORD,
  type TestApp,
  type TestSession,
} from './helpers.js';
import {
  createMockOidcProvider,
  type MockAuthorization,
  type MockOidcProvider,
} from './mock-oidc-provider.js';

const CORP_SECRET = 'corp-client-secret-value';
const PARTNER_SECRET = 'partner-client-secret-value';

let counter = 0;

/** A fresh subject and address for one test. */
function person(prefix = 'person'): { sub: string; email: string } {
  counter += 1;
  return { sub: `${prefix}-subject-${counter}`, email: `${prefix}${counter}@corp.example.test` };
}

interface Attempt {
  start: LightMyRequestResponse;
  authorization: MockAuthorization;
  transaction: string;
}

/** Start a sign-in and act as the user at the provider. */
async function begin(
  h: TestApp,
  idp: MockOidcProvider,
  providerId: string,
  claims: Record<string, unknown>,
  returnTo?: string,
): Promise<Attempt> {
  const query = returnTo === undefined ? '' : `?return_to=${encodeURIComponent(returnTo)}`;
  const start = await h.app.inject({
    method: 'GET',
    url: `/api/auth/sso/${providerId}/start${query}`,
  });
  assert.equal(start.statusCode, 302, start.body);
  const transaction = cookieValue(start, SSO_TRANSACTION_COOKIE);
  assert.ok(transaction, `the attempt is sealed into a cookie: ${String(start.headers.location)}`);
  const authorization = idp.authorize(String(start.headers.location), claims);
  return { start, authorization, transaction };
}

/** Deliver the provider's response to the callback, as the browser would. */
async function finish(
  h: TestApp,
  providerId: string,
  attempt: Attempt,
  overrides: {
    state?: string;
    code?: string;
    cookie?: string | null;
    error?: string;
    session?: TestSession;
  } = {},
): Promise<LightMyRequestResponse> {
  const query = new URLSearchParams({
    code: overrides.code ?? attempt.authorization.code,
    state: overrides.state ?? attempt.authorization.state,
    ...(overrides.error === undefined ? {} : { error: overrides.error }),
  });
  const cookie = overrides.cookie === undefined ? attempt.transaction : overrides.cookie;
  const cookies: Record<string, string> = {
    ...(cookie === null ? {} : { [SSO_TRANSACTION_COOKIE]: cookie }),
    ...(overrides.session
      ? {
          [SESSION_COOKIE]: overrides.session.sessionToken,
          [CSRF_COOKIE]: overrides.session.csrfToken,
        }
      : {}),
  };
  return h.app.inject({
    method: 'GET',
    url: `/api/auth/sso/${providerId}/callback?${query.toString()}`,
    cookies,
  });
}

/** Start an explicit link from a signed-in session, and act as the user at the provider. */
async function beginLink(
  h: TestApp,
  idp: MockOidcProvider,
  providerId: string,
  session: TestSession,
  claims: Record<string, unknown>,
): Promise<Attempt> {
  const start = await h.authed(session, {
    method: 'POST',
    url: `/api/auth/sso/${providerId}/link`,
  });
  assert.equal(start.statusCode, 200, start.body);
  const transaction = cookieValue(start, SSO_TRANSACTION_COOKIE);
  assert.ok(transaction, 'the link attempt is sealed into a cookie');
  const authorization = idp.authorize(start.json<{ location: string }>().location, claims);
  return { start, authorization, transaction };
}

/** Link `session`'s account to the provider end to end. */
async function link(
  h: TestApp,
  idp: MockOidcProvider,
  providerId: string,
  session: TestSession,
  claims: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  const attempt = await beginLink(h, idp, providerId, session, claims);
  return finish(h, providerId, attempt, { session });
}

/** The `sso_error` a refused callback redirected with, or `null` on success. */
function ssoError(response: LightMyRequestResponse): string | null {
  assert.equal(response.statusCode, 302, response.body);
  const location = new URL(String(response.headers.location));
  return location.searchParams.get('sso_error');
}

/** The session a successful callback set, as the harness models one. */
async function sessionOf(h: TestApp, response: LightMyRequestResponse): Promise<TestSession> {
  const sessionToken = cookieValue(response, SESSION_COOKIE);
  const csrfToken = cookieValue(response, CSRF_COOKIE);
  assert.ok(sessionToken && csrfToken, `no session: ${String(response.headers.location)}`);
  const cookieHeader = `${SESSION_COOKIE}=${sessionToken}; ${CSRF_COOKIE}=${csrfToken}`;
  const me = await h.app.inject({
    method: 'GET',
    url: '/api/auth/me',
    headers: { cookie: cookieHeader },
  });
  assert.equal(me.statusCode, 200, me.body);
  return { user: me.json<{ user: User }>().user, sessionToken, csrfToken, cookieHeader };
}

/** Sign in end to end and return the callback's response. */
async function signIn(
  h: TestApp,
  idp: MockOidcProvider,
  providerId: string,
  claims: Record<string, unknown>,
  returnTo?: string,
): Promise<LightMyRequestResponse> {
  return finish(h, providerId, await begin(h, idp, providerId, claims, returnTo));
}

/** The account can neither sign in with a password nor get a reset link. */
async function assertNoLocalPassword(h: TestApp, email: string): Promise<void> {
  const login = await h.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: TEST_PASSWORD },
  });
  assert.equal(login.statusCode, 401, login.body);
  const forgot = await h.app.inject({
    method: 'POST',
    url: '/api/auth/forgot-password',
    payload: { email },
  });
  assert.equal(forgot.statusCode, 200, forgot.body);
  const mailed = (await h.outbox()).filter((message) => message.to_email === email);
  assert.deepEqual(mailed, [], 'no reset link is issued');
}

/** The store-level leases the app takes, as a test sees them. */
interface LeaseWatch {
  /** Every key taken, in order. */
  taken: string[];
  /**
   * Run once, the next time `key` is taken: while it is held, and before the
   * work under it starts. For a callback that is between its plan and the
   * transaction that commits it; for a settings save, between its read of the
   * settings and its write.
   */
  next: { key: string; run: () => Promise<void> } | null;
}

/** Wrap `store` so that every lease it grants is reported to `watch`. */
function watchLeases(store: NexusStore, watch: LeaseWatch): NexusStore {
  const leases = new Proxy(store.leases, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property);
      if (property !== 'acquire') return value;
      return async (...args: Parameters<LeaseRepo['acquire']>): Promise<boolean> => {
        const taken = await target.acquire(...args);
        const [key] = args;
        if (taken) {
          watch.taken.push(key);
          const hook = watch.next;
          if (hook !== null && hook.key === key) {
            watch.next = null;
            await hook.run();
          }
        }
        return taken;
      };
    },
  });
  return new Proxy(store, {
    get(target, property) {
      if (property === 'leases') return leases;
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** Resolve after `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function providersEnv(corp: MockOidcProvider, partner: MockOidcProvider): string {
  return JSON.stringify([
    {
      id: 'corp',
      display_name: 'Corporate SSO',
      issuer: corp.issuer,
      client_id: 'nexus-corp',
      client_secret: CORP_SECRET,
      role_mappings: [
        { claim: 'groups', value: 'api-publishers', role: 'provider' },
        { claim: 'groups', value: 'portal-admins', role: 'admin' },
      ],
    },
    {
      id: 'partner',
      display_name: 'Partner IdP',
      issuer: partner.issuer,
      client_id: 'nexus-partner',
      default_role: null,
      disable_local_password_for_linked: true,
      role_mappings: [{ claim: 'groups', value: 'partners', role: 'client' }],
    },
  ]);
}

describe('single sign-on', () => {
  let corp: MockOidcProvider;
  let partner: MockOidcProvider;
  let h: TestApp;
  let founder: TestSession;
  let logLines: string[];
  const leases: LeaseWatch = { taken: [], next: null };

  before(async () => {
    corp = createMockOidcProvider({ clientId: 'nexus-corp', clientSecret: CORP_SECRET });
    partner = createMockOidcProvider({ clientId: 'nexus-partner', clientSecret: null });
    await corp.start();
    await partner.start();
    logLines = [];
    h = await buildTestApp({
      env: {
        NEXUS_OIDC_ALLOW_HTTP_LOOPBACK: 'true',
        NEXUS_OIDC_PROVIDERS: providersEnv(corp, partner),
      },
      wrapStore: (store) => watchLeases(store, leases),
      deps: {
        logger: {
          level: 'warn',
          stream: {
            write(line: string): void {
              logLines.push(line);
            },
          },
        },
      },
    });
    founder = await h.registerUser({ email: 'founder@corp.example.test' });
    assert.equal(founder.user.role, 'super_admin');
  });

  after(async () => {
    await h?.close();
    await corp?.stop();
    await partner?.stop();
  });

  /* ── The flow ───────────────────────────────────────────────────────── */

  it('lists the enabled providers for the sign-in page', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/api/auth/sso' });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json<SsoPublicConfigResponse>();
    assert.equal(body.policy, 'local_and_sso');
    assert.equal(body.password_login, 'enabled');
    assert.equal(body.registration_enabled, true);
    assert.deepEqual(body.providers, [
      { id: 'corp', display_name: 'Corporate SSO' },
      { id: 'partner', display_name: 'Partner IdP' },
    ]);
    assert.doesNotMatch(response.body, /secret/i);
  });

  it('starts an authorization-code request with PKCE S256, state and nonce', async () => {
    const attempt = await begin(h, corp, 'corp', { sub: 'x' });
    const params = attempt.authorization.params;
    assert.equal(params.get('response_type'), 'code');
    assert.equal(params.get('client_id'), 'nexus-corp');
    assert.equal(params.get('code_challenge_method'), 'S256');
    assert.match(params.get('code_challenge') ?? '', /^[A-Za-z0-9_-]{43}$/);
    assert.match(params.get('state') ?? '', /^[A-Za-z0-9_-]{43}$/);
    assert.match(params.get('nonce') ?? '', /^[A-Za-z0-9_-]{43}$/);
    assert.equal(params.get('redirect_uri'), `${h.config.publicUrl}/api/auth/sso/corp/callback`);
    assert.equal(params.get('scope'), 'openid email profile');
    // The attempt cookie is HttpOnly, scoped to the SSO routes, and the
    // response carrying it is never cacheable.
    const cookies = attempt.start.cookies as { name: string; path?: string; httpOnly?: boolean }[];
    const cookie = cookies.find((entry) => entry.name === SSO_TRANSACTION_COOKIE);
    assert.equal(cookie?.path, '/api/auth/sso');
    assert.equal(cookie?.httpOnly, true);
    assert.equal(attempt.start.headers['cache-control'], 'private, no-store');
    // Nothing the attempt carries is readable in the cookie.
    for (const value of [params.get('state'), params.get('nonce')]) {
      assert.equal(attempt.transaction.includes(value ?? '<none>'), false);
    }
  });

  it('provisions an account on first sign-in and signs it in', async () => {
    const who = person('jit');
    const response = await signIn(
      h,
      corp,
      'corp',
      { ...who, email_verified: true, name: 'Jit Person', groups: ['api-publishers'] },
      '/catalog?q=billing',
    );
    assert.equal(ssoError(response), null);
    assert.equal(response.headers.location, `${h.config.publicUrl}/catalog?q=billing`);
    assert.equal(response.headers['cache-control'], 'private, no-store');
    const session = await sessionOf(h, response);
    assert.equal(session.user.email, who.email);
    assert.equal(session.user.display_name, 'Jit Person');
    assert.equal(session.user.role, 'provider');
    assert.equal(session.user.email_verified, true);
    // The attempt is spent with the callback.
    const cleared = (response.cookies as { name: string; value: string }[]).find(
      (entry) => entry.name === SSO_TRANSACTION_COOKIE,
    );
    assert.equal(cleared?.value, '');

    const identities = await h.store.userIdentities.listByUser(session.user.id);
    assert.deepEqual(
      identities.map((identity) => [identity.provider_id, identity.subject, identity.email]),
      [['corp', who.sub, who.email]],
    );
    const provision = (await h.auditRows(AuditAction.AUTH_SSO_PROVISION)).find(
      (row) => row.target_id === session.user.id,
    );
    assert.equal(provision?.details.role, 'provider');
    const login = (await h.auditRows(AuditAction.AUTH_SSO_LOGIN)).find(
      (row) => row.target_id === session.user.id,
    );
    assert.equal(login?.details.provisioned, true);
    assert.equal(login?.details.provider_id, 'corp');
  });

  it('opens the same account on a returning sign-in, whatever the email says now', async () => {
    const who = person('return');
    const first = await sessionOf(
      h,
      await signIn(h, corp, 'corp', { ...who, email_verified: true, groups: [] }),
    );
    const again = await signIn(h, corp, 'corp', {
      sub: who.sub,
      email: 'renamed@corp.example.test',
      email_verified: true,
      groups: [],
    });
    const second = await sessionOf(h, again);
    assert.equal(second.user.id, first.user.id);
    assert.equal(second.user.email, who.email, 'the portal address is not rewritten');
    const [identity] = await h.store.userIdentities.listByUser(first.user.id);
    assert.equal(identity?.email, 'renamed@corp.example.test');
    assert.ok(identity?.last_login_at);
  });

  it('signs an SSO account in as an ordinary account, Edge consumer included', async () => {
    const who = person('edge');
    const session = await sessionOf(
      h,
      await signIn(h, corp, 'corp', { ...who, email_verified: true }),
    );
    const issued = await h.authed(session, {
      method: 'POST',
      url: '/api/credentials',
      payload: { credential_type: 'keyauth' },
    });
    assert.equal(issued.statusCode, 201, issued.body);
    const consumer = h.edge.consumerByUsername(consumerUsernameForUser(session.user.id));
    assert.ok(consumer, 'the account is nexus-user-<id> on the gateway, like any other');
    // A password sign-in against the provisioned account fails like a wrong password.
    const login = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: who.email, password: TEST_PASSWORD },
    });
    assert.equal(login.statusCode, 401, login.body);
  });

  /* ── What the callback refuses ──────────────────────────────────────── */

  it('refuses a state that is not the one this browser sealed', async () => {
    const who = person('state');
    const attempt = await begin(h, corp, 'corp', { ...who, email_verified: true });
    assert.equal(ssoError(await finish(h, 'corp', attempt, { state: 'forged' })), 'invalid_state');
    assert.equal(await h.store.users.findByEmail(who.email), null);
  });

  it('refuses a callback without the attempt cookie, or with another attempt’s', async () => {
    const who = person('cookie');
    const attempt = await begin(h, corp, 'corp', { ...who, email_verified: true });
    assert.equal(ssoError(await finish(h, 'corp', attempt, { cookie: null })), 'invalid_state');
    const garbage = await finish(h, 'corp', attempt, { cookie: 'garbage' });
    assert.equal(ssoError(garbage), 'invalid_state');
    // An attempt started for one provider cannot complete at another.
    const other = await begin(h, partner, 'partner', { ...who, email_verified: true });
    assert.equal(
      ssoError(await finish(h, 'corp', attempt, { cookie: other.transaction })),
      'invalid_state',
    );
    assert.equal(await h.store.users.findByEmail(who.email), null);
  });

  it('refuses an attempt whose sealed cookie has expired', async () => {
    const who = person('expired');
    const attempt = await begin(h, corp, 'corp', { ...who, email_verified: true });
    const sealed = h.app.nexus.crypto.openSsoTransaction<Record<string, unknown>>(
      attempt.transaction,
    );
    const expired = h.app.nexus.crypto.sealSsoTransaction({
      ...sealed,
      expires_at: Date.now() - 1_000,
    });
    assert.equal(ssoError(await finish(h, 'corp', attempt, { cookie: expired })), 'invalid_state');
    assert.equal(await h.store.users.findByEmail(who.email), null);
  });

  it('binds the code to its own PKCE verifier', async () => {
    // Deliver attempt A's code and state with attempt B's sealed cookie
    // re-sealed around A's state: the only thing left that does not match is
    // the verifier, and the provider refuses the code without it.
    const who = person('pkce');
    const a = await begin(h, corp, 'corp', { ...who, email_verified: true });
    const b = await begin(h, corp, 'corp', { ...who, email_verified: true });
    const sealed = h.app.nexus.crypto.openSsoTransaction<Record<string, unknown>>(b.transaction);
    const mixed = h.app.nexus.crypto.sealSsoTransaction({
      ...sealed,
      state: a.authorization.state,
    });
    const response = await finish(h, 'corp', a, { cookie: mixed });
    assert.equal(ssoError(response), 'provider_unavailable');
    const sent = corp.tokenRequests.at(-1);
    assert.equal(sent?.form.get('code_verifier'), sealed.verifier);
    assert.equal(await h.store.users.findByEmail(who.email), null);
  });

  it('never redeems the same attempt twice', async () => {
    const who = person('replay');
    const attempt = await begin(h, corp, 'corp', { ...who, email_verified: true });
    assert.equal(ssoError(await finish(h, 'corp', attempt)), null);
    // The code is single-use at the provider, whatever the portal does.
    assert.equal(ssoError(await finish(h, 'corp', attempt)), 'provider_unavailable');
  });

  it('refuses an ID token whose nonce is not this attempt’s', async () => {
    const who = person('nonce');
    corp.nextIdToken = (payload) => ({ ...payload, nonce: 'another-attempts-nonce' });
    const response = await signIn(h, corp, 'corp', { ...who, email_verified: true });
    assert.equal(ssoError(response), 'token_invalid');
    assert.equal(await h.store.users.findByEmail(who.email), null);
  });

  it('refuses an ID token for another audience, from another issuer, or expired', async () => {
    const who = person('claims');
    const now = Math.floor(Date.now() / 1000);
    for (const tamper of [
      { aud: 'someone-else' },
      { iss: 'https://evil.example.com' },
      { iat: now - 3600, exp: now - 600 },
    ]) {
      corp.nextIdToken = (payload) => ({ ...payload, ...tamper });
      const response = await signIn(h, corp, 'corp', { ...who, email_verified: true });
      assert.equal(ssoError(response), 'token_invalid', JSON.stringify(tamper));
    }
    assert.equal(await h.store.users.findByEmail(who.email), null);
  });

  it('refuses unsigned and HMAC-signed ID tokens', async () => {
    const who = person('alg');
    for (const signing of ['none', 'hs256', 'foreign-key'] as const) {
      corp.nextSigning = signing;
      const response = await signIn(h, corp, 'corp', { ...who, email_verified: true });
      assert.equal(ssoError(response), 'token_invalid', signing);
    }
    assert.equal(await h.store.users.findByEmail(who.email), null);
  });

  it('reports a provider-side refusal without echoing it', async () => {
    const attempt = await begin(h, corp, 'corp', { sub: 'x' });
    const response = await finish(h, 'corp', attempt, { error: 'access_denied' });
    assert.equal(ssoError(response), 'idp_error');
  });

  it('only returns to a same-origin portal path', async () => {
    for (const returnTo of ['https://evil.example.com/', '//evil.example.com', '/api/auth/me']) {
      const who = person('redirect');
      const response = await signIn(h, corp, 'corp', { ...who, email_verified: true }, returnTo);
      assert.equal(response.headers.location, `${h.config.publicUrl}/`, returnTo);
    }
  });

  /* ── Linking ────────────────────────────────────────────────────────── */

  /** A local account, with or without a recorded proof of its address. */
  async function localAccount(
    email: string,
    proven: boolean,
    role: UserRecord['role'] = 'client',
  ): Promise<UserRecord> {
    const account = await h.store.users.create({
      email,
      password_hash: 'scrypt:16384:8:1:c2FsdA==:aGFzaA==',
      display_name: 'Local Account',
      role,
      status: 'active',
      email_verified: true,
    });
    if (proven) {
      const at = new Date().toISOString();
      await h.store.emailProofs.upsert(account.id, email, 'verification_link', at);
    }
    return account;
  }

  it('links a local account only when both sides proved the address', async () => {
    const local = await localAccount('linkme@corp.example.test', true);
    const response = await signIn(h, corp, 'corp', {
      sub: 'link-subject',
      email: 'LinkMe@corp.example.test',
      email_verified: true,
    });
    const session = await sessionOf(h, response);
    assert.equal(session.user.id, local.id);
    const row = (await h.auditRows(AuditAction.AUTH_SSO_LINK)).find(
      (entry) => entry.target_id === local.id,
    );
    assert.equal(row?.details.provider_id, 'corp');
    assert.equal(row?.details.subject, 'link-subject');
    assert.equal(row?.details.explicit, false);
    const [identity] = await h.store.userIdentities.listByUser(local.id);
    assert.equal(identity?.issuer, corp.issuer);
    assert.equal(identity?.provisioned, false);
  });

  it('never links, or provisions, on an address the provider did not verify', async () => {
    const local = await localAccount('takeover@corp.example.test', true);
    for (const emailVerified of [false, 'true', undefined]) {
      const response = await signIn(h, corp, 'corp', {
        sub: `attacker-${String(emailVerified)}`,
        email: 'takeover@corp.example.test',
        ...(emailVerified === undefined ? {} : { email_verified: emailVerified }),
      });
      assert.equal(ssoError(response), 'email_not_verified', String(emailVerified));
    }
    assert.deepEqual(await h.store.userIdentities.listByUser(local.id), []);
    const unverified = person('unverified');
    const response = await signIn(h, corp, 'corp', { ...unverified, email_verified: false });
    assert.equal(ssoError(response), 'email_not_verified');
    assert.equal(await h.store.users.findByEmail(unverified.email), null);
  });

  it('never links to an account the portal holds no proof for', async () => {
    const local = await localAccount('unproven@corp.example.test', false);
    const response = await signIn(h, corp, 'corp', {
      sub: 'unproven-subject',
      email: 'unproven@corp.example.test',
      email_verified: true,
    });
    assert.equal(ssoError(response), 'account_exists');
    assert.deepEqual(await h.store.userIdentities.listByUser(local.id), []);
  });

  it('never links to an account registered with verification off, once it is on', async () => {
    // Registered with verification off: marked verified without any proof.
    const squatted = await h.registerUser({ email: 'squatted@corp.example.test' });
    assert.equal(squatted.user.email_verified, true);
    // An administrator turns verification on afterwards; the old row still
    // proves nothing, so the victim's first single sign-on must not land in it.
    const previous = await h.store.settings.get(REGISTRATION_SETTINGS_KEY);
    await h.store.settings.set(REGISTRATION_SETTINGS_KEY, {
      open_registration: true,
      require_email_verification: true,
      allowed_roles: ['client', 'provider'],
    });
    try {
      const response = await signIn(h, corp, 'corp', {
        sub: 'victim-subject',
        email: 'squatted@corp.example.test',
        email_verified: true,
      });
      assert.equal(ssoError(response), 'account_exists');
      assert.deepEqual(await h.store.userIdentities.listByUser(squatted.user.id), []);
    } finally {
      if (previous) await h.store.settings.set(REGISTRATION_SETTINGS_KEY, previous.value);
      else await h.store.settings.delete(REGISTRATION_SETTINGS_KEY);
    }
  });

  it('records a redeemed verification link or reset as proof', async () => {
    const local = await localAccount('proof-by-reset@corp.example.test', false);
    const token = 'reset-token-for-proof-0123456789';
    await h.store.verificationTokens.create({
      user_id: local.id,
      token_hash: h.app.nexus.crypto.hashToken(token),
      purpose: 'password_reset',
      expires_at: new Date(Date.now() + 600_000).toISOString(),
    });
    const reset = await h.app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      payload: { token, new_password: TEST_PASSWORD },
    });
    assert.equal(reset.statusCode, 200, reset.body);
    const proof = await h.store.emailProofs.findByUser(local.id);
    assert.equal(proof?.method, 'password_reset');
    const response = await signIn(h, corp, 'corp', {
      sub: 'proof-by-reset-subject',
      email: 'proof-by-reset@corp.example.test',
      email_verified: true,
    });
    assert.equal((await sessionOf(h, response)).user.id, local.id);
  });

  it('never links an administrator automatically, whatever the provider asserts', async () => {
    for (const role of ['admin', 'super_admin'] as const) {
      const privileged = await localAccount(`${role}-target@corp.example.test`, true, role);
      const response = await signIn(h, partner, 'partner', {
        sub: `${role}-impostor`,
        email: `${role}-target@corp.example.test`,
        email_verified: true,
        groups: ['partners'],
      });
      assert.equal(ssoError(response), 'privileged_account', role);
      assert.deepEqual(await h.store.userIdentities.listByUser(privileged.id), []);
    }
  });

  it('never links automatically when the claims would make the account an admin', async () => {
    // A lower-trust provider (partner) provisions the address first, and
    // records its own verified proof of it.
    const who = person('promote');
    const lowTrust = await sessionOf(
      h,
      await signIn(h, partner, 'partner', {
        sub: `${who.sub}-partner`,
        email: who.email,
        email_verified: true,
        groups: ['partners'],
      }),
    );
    assert.equal(lowTrust.user.role, 'client');

    // The address's holder then signs in at corp, which maps them to admin.
    // Linking automatically would promote the shared account, and with it the
    // partner identity and its live session.
    const corpClaims = {
      sub: `${who.sub}-corp`,
      email: who.email,
      email_verified: true,
      groups: ['portal-admins'],
    };
    const refused = await signIn(h, corp, 'corp', corpClaims);
    assert.equal(ssoError(refused), 'privileged_account');
    assert.equal((await h.store.users.findById(lowTrust.user.id))?.role, 'client');
    const identities = await h.store.userIdentities.listByUser(lowTrust.user.id);
    assert.deepEqual(
      identities.map((identity) => identity.provider_id),
      ['partner'],
    );
    assert.equal(
      await h.store.userIdentities.findBySubject('corp', corp.issuer, corpClaims.sub),
      null,
    );
    const syncs = (await h.auditRows(AuditAction.AUTH_SSO_CLAIMS_SYNC)).filter(
      (row) => row.target_id === lowTrust.user.id,
    );
    assert.deepEqual(syncs, []);
    const me = await h.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: lowTrust.cookieHeader },
    });
    assert.equal(
      me.json<{ user: User }>().user.role,
      'client',
      'the partner session gains nothing',
    );

    // An explicit link, made from a signed-in session, still attaches the
    // admin-mapped identity. It does not promote the account while the
    // partner identity can open it too: a session does not say which provider
    // opened it, so the link proves no more than the partner session did.
    const linked = await link(h, corp, 'corp', lowTrust, corpClaims);
    assert.equal(ssoError(linked), null);
    assert.equal((await sessionOf(h, linked)).user.role, 'client');
    assert.equal((await h.store.users.findById(lowTrust.user.id))?.role, 'client');
    const row = (await h.auditRows(AuditAction.AUTH_SSO_LINK)).find(
      (entry) => entry.target_id === lowTrust.user.id && entry.details.provider_id === 'corp',
    );
    assert.equal(row?.details.explicit, true);
  });

  it('re-checks the account inside the transaction that would link it', async () => {
    const local = await localAccount('recheck-target@corp.example.test', true);
    const attempt = await begin(h, partner, 'partner', {
      sub: 'recheck-partner',
      email: local.email,
      email_verified: true,
      groups: ['partners'],
    });
    // The plan finds a client and links it; by the time the link commits, the
    // account is an administrator's.
    leases.next = {
      key: ssoProviderLockKey('partner'),
      run: async () => {
        await h.store.users.update(local.id, { role: 'admin' });
      },
    };
    const response = await finish(h, 'partner', attempt);
    assert.equal(leases.next, null, 'the account changed between the plan and the commit');
    assert.equal(ssoError(response), 'privileged_account');
    assert.equal(cookieValue(response, SESSION_COOKIE), undefined);
    assert.deepEqual(await h.store.userIdentities.listByUser(local.id), []);
    assert.equal((await h.store.users.findById(local.id))?.role, 'admin');
  });

  it('never promotes an account a lower-trust provider can open (#495)', async () => {
    /** The role `session` acts with now, or the status code it gets instead. */
    const roleOf = async (session: TestSession): Promise<string | number> => {
      const me = await h.app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { cookie: session.cookieHeader },
      });
      return me.statusCode === 200 ? me.json<{ user: User }>().user.role : me.statusCode;
    };

    // The victim is provisioned at corp as a client, which proves the address.
    const who = person('reversed');
    const corpClaims = { ...who, email_verified: true };
    const victim = await sessionOf(h, await signIn(h, corp, 'corp', corpClaims));
    assert.equal(victim.user.role, 'client');

    // Whoever controls partner, which maps nobody above client, asserts the
    // same verified address. The account is no administrator's and partner
    // would not make it one, so partner links to it and holds a session.
    const attacker = await sessionOf(
      h,
      await signIn(h, partner, 'partner', {
        sub: `${who.sub}-partner`,
        email: who.email,
        email_verified: true,
        groups: ['partners'],
      }),
    );
    assert.equal(attacker.user.id, victim.user.id);

    // The victim is then made an administrator at corp. Their next sign-in
    // goes ahead, but the promotion is withheld: the role is the account's,
    // so it would reach the partner identity and its live session too.
    const admins = { ...corpClaims, groups: ['portal-admins'] };
    const withheld = await signIn(h, corp, 'corp', admins);
    assert.equal(ssoError(withheld), null);
    assert.equal((await sessionOf(h, withheld)).user.role, 'client');
    assert.equal((await h.store.users.findById(victim.user.id))?.role, 'client');
    assert.equal(await roleOf(attacker), 'client', 'the partner session gains nothing');
    const held = (await h.auditRows(AuditAction.AUTH_SSO_CLAIMS_SYNC)).filter(
      (row) => row.target_id === victim.user.id,
    );
    assert.equal(held.length, 1);
    assert.equal(held[0]?.details.role_withheld, 'admin');
    assert.equal(held[0]?.details.withheld_reason, 'lower_trust_identities');
    assert.deepEqual(held[0]?.details.lower_trust_provider_ids, ['partner']);
    assert.equal(held[0]?.details.to_role, undefined);

    // A super admin reviews the account and removes the partner identity. The
    // next corp sign-in promotes it and ends every session opened before it,
    // the partner one included, so none of them inherits the new role.
    const partnerIdentity = (await h.store.userIdentities.listByUser(victim.user.id)).find(
      (identity) => identity.provider_id === 'partner',
    );
    assert.ok(partnerIdentity);
    const unlinked = await h.authed(founder, {
      method: 'DELETE',
      url: `/api/users/${victim.user.id}/identities/${partnerIdentity.id}`,
    });
    assert.equal(unlinked.statusCode, 200, unlinked.body);
    const promoted = await sessionOf(h, await signIn(h, corp, 'corp', admins));
    assert.equal(promoted.user.role, 'admin');
    assert.equal(await roleOf(attacker), 401, 'the partner session was ended');
    assert.equal(await roleOf(victim), 401, 'so was every other earlier session');
    assert.equal(await roleOf(promoted), 'admin');
    const sync = (await h.auditRows(AuditAction.AUTH_SSO_CLAIMS_SYNC)).find(
      (row) => row.target_id === victim.user.id && row.details.to_role === 'admin',
    );
    assert.equal(sync?.details.from_role, 'client');
    assert.equal(sync?.details.terminated_sessions, 3);
  });

  it('promotes an account whose other providers are trusted with admin', async () => {
    const provider = {
      id: 'trusted',
      display_name: 'Trusted',
      issuer: partner.issuer,
      client_id: 'nexus-partner',
      scopes: ['openid', 'email'],
      enabled: true,
      jit_provisioning: true,
      link_existing_accounts: true,
      require_verified_email: true,
      allowed_email_domains: [],
      disable_local_password_for_linked: false,
      sync_roles: true,
      default_role: 'client',
      role_mappings: [{ claim: 'groups', value: 'trusted-admins', role: 'admin' }],
      org_mappings: [],
    };
    const put = (providers: unknown[]): Promise<LightMyRequestResponse> =>
      h.authed(founder, { method: 'PUT', url: '/api/admin/sso', payload: { providers } });
    assert.equal((await put([provider])).statusCode, 200);
    try {
      const who = person('trusted');
      const first = await sessionOf(
        h,
        await signIn(h, partner, 'trusted', { ...who, email_verified: true }),
      );
      const corpClaims = { sub: `${who.sub}-corp`, email: who.email, email_verified: true };
      assert.equal(
        (await sessionOf(h, await signIn(h, corp, 'corp', corpClaims))).user.id,
        first.user.id,
      );
      // `trusted` could make the account an administrator itself, so corp's
      // promotion hands its identity nothing new.
      const promoted = await signIn(h, corp, 'corp', { ...corpClaims, groups: ['portal-admins'] });
      assert.equal((await sessionOf(h, promoted)).user.role, 'admin');
    } finally {
      assert.equal((await put([])).statusCode, 200);
    }
  });

  it('links explicitly from a signed-in session, and only back to that session', async () => {
    // Registered as typed, stored lowercased; the proof, recorded under the
    // address as typed too, still covers it.
    const holder = await h.registerUser({ email: 'Explicit@Corp.example.test' });
    assert.equal(holder.user.email, 'explicit@corp.example.test');
    await h.store.emailProofs.upsert(
      holder.user.id,
      'Explicit@Corp.example.test',
      'verification_link',
      new Date().toISOString(),
    );
    // The identity's address differs from the account's: an explicit link
    // attaches it anyway, because the holder of the proven account started it.
    const claims = { sub: 'explicit-subject', email: 'someone-else@corp.example.test' };

    // Back to no session, or another one: nothing is attached.
    const stray = await beginLink(h, corp, 'corp', holder, claims);
    assert.equal(ssoError(await finish(h, 'corp', stray)), 'link_session_mismatch');
    const other = await h.registerUser({ email: 'explicit-other@corp.example.test' });
    const crossed = await beginLink(h, corp, 'corp', holder, claims);
    const crossedResponse = await finish(h, 'corp', crossed, { session: other });
    assert.equal(ssoError(crossedResponse), 'link_session_mismatch');
    assert.match(String(crossedResponse.headers.location), /\/profile\?sso_error=/);
    assert.deepEqual(await h.store.userIdentities.listByUser(holder.user.id), []);

    const linked = await link(h, corp, 'corp', holder, claims);
    assert.equal(ssoError(linked), null);
    assert.equal(linked.headers.location, `${h.config.publicUrl}/profile`);
    const [identity] = await h.store.userIdentities.listByUser(holder.user.id);
    assert.equal(identity?.subject, 'explicit-subject');
    const row = (await h.auditRows(AuditAction.AUTH_SSO_LINK)).find(
      (entry) => entry.target_id === holder.user.id,
    );
    assert.equal(row?.details.explicit, true);
    // The portal's proof stands as it was: the link recorded none of its own.
    const proof = await h.store.emailProofs.findByUser(holder.user.id);
    assert.equal(proof?.email, 'explicit@corp.example.test');
    assert.equal(proof?.method, 'verification_link');

    // The same subject cannot then be attached to another account.
    const again = await link(h, corp, 'corp', other, claims);
    assert.equal(ssoError(again), 'already_linked');

    // The account's own view lists the link.
    const mine = await h.authed(holder, { method: 'GET', url: '/api/users/me/identities' });
    assert.equal(mine.statusCode, 200, mine.body);
    assert.equal(mine.json<{ items: unknown[] }>().items.length, 1);
  });

  it('refuses an explicit link to an account the portal holds no proof for', async () => {
    // Registered with verification off: signed in, but nothing proves the address.
    const holder = await h.registerUser({ email: 'explicit-unproven@corp.example.test' });
    assert.equal(await h.store.emailProofs.findByUser(holder.user.id), null);
    const sub = 'explicit-unproven-subject';
    const attempts: [string, Record<string, unknown>][] = [
      [
        'the provider verifies the same address',
        { email: holder.user.email, email_verified: true },
      ],
      [
        'the provider verifies another address',
        { email: 'elsewhere@corp.example.test', email_verified: true },
      ],
      ['email_verified absent', { email: holder.user.email }],
      ['email_verified the string "true"', { email: holder.user.email, email_verified: 'true' }],
    ];
    for (const [label, claims] of attempts) {
      const refused = await link(h, corp, 'corp', holder, { sub, ...claims });
      assert.equal(ssoError(refused), 'address_unproven', label);
      assert.match(String(refused.headers.location), /\/profile\?sso_error=address_unproven$/);
    }
    assert.deepEqual(await h.store.userIdentities.listByUser(holder.user.id), []);
    assert.equal(await h.store.userIdentities.findBySubject('corp', corp.issuer, sub), null);
    // No refused attempt turned the provider's word into a proof either.
    assert.equal(await h.store.emailProofs.findByUser(holder.user.id), null);
  });

  it('keeps a pre-registered address from carrying an identity past a reset', async () => {
    // Verification is off (the default): whoever registers the victim's
    // address first is signed in at once…
    const squatter = await h.registerUser({ email: 'prehijack-victim@corp.example.test' });
    assert.equal(squatter.user.email_verified, true);
    // …and tries to attach a provider account of their own, which would keep
    // opening the account by `sub` after the victim takes it back.
    const attacker = {
      sub: 'prehijack-attacker',
      email: 'prehijack-attacker@corp.example.test',
      email_verified: true,
    };
    const refused = await link(h, corp, 'corp', squatter, attacker);
    assert.equal(ssoError(refused), 'address_unproven');
    assert.deepEqual(await h.store.userIdentities.listByUser(squatter.user.id), []);

    // The victim takes the account back with a password reset, which proves
    // the address.
    const token = 'reset-token-for-prehijack-012345';
    await h.store.verificationTokens.create({
      user_id: squatter.user.id,
      token_hash: h.app.nexus.crypto.hashToken(token),
      purpose: 'password_reset',
      expires_at: new Date(Date.now() + 600_000).toISOString(),
    });
    const reset = await h.app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      payload: { token, new_password: TEST_PASSWORD },
    });
    assert.equal(reset.statusCode, 200, reset.body);

    // The attacker's identity opens nothing of the victim's.
    await signIn(h, corp, 'corp', attacker);
    const identity = await h.store.userIdentities.findBySubject('corp', corp.issuer, attacker.sub);
    assert.ok(identity);
    assert.notEqual(identity.user_id, squatter.user.id);

    // The victim, now proven, links their own identity; the link adds no
    // provider proof over the reset's.
    const victim = await h.loginUser(squatter.user.email);
    const linked = await link(h, corp, 'corp', victim, {
      sub: 'prehijack-victim',
      email: squatter.user.email,
      email_verified: true,
    });
    assert.equal(ssoError(linked), null);
    assert.equal(
      (await h.store.emailProofs.findByUser(squatter.user.id))?.method,
      'password_reset',
    );
  });

  it('holds a second provider to the same rule, and one identity per provider', async () => {
    const who = person('cross');
    const account = await sessionOf(
      h,
      await signIn(h, corp, 'corp', { ...who, email_verified: true }),
    );
    // The partner provider does not verify: no link across providers.
    const unverified = await signIn(h, partner, 'partner', {
      sub: `${who.sub}-partner`,
      email: who.email,
      email_verified: false,
      groups: ['partners'],
    });
    assert.equal(ssoError(unverified), 'email_not_verified');
    // It does now: the provider-verified address is proof, and the account
    // gains its second identity.
    const verified = await signIn(h, partner, 'partner', {
      sub: `${who.sub}-partner`,
      email: who.email,
      email_verified: true,
      groups: ['partners'],
    });
    assert.equal((await sessionOf(h, verified)).user.id, account.user.id);
    // A different subject at corp cannot attach itself to the same account.
    const second = await signIn(h, corp, 'corp', {
      sub: `${who.sub}-again`,
      email: who.email,
      email_verified: true,
    });
    assert.equal(ssoError(second), 'account_exists');
    const providers = (await h.store.userIdentities.listByUser(account.user.id))
      .map((identity) => identity.provider_id)
      .sort();
    assert.deepEqual(providers, ['corp', 'partner']);
  });

  /* ── Passwords after single sign-on ─────────────────────────────────── */

  it('gives a provisioned account no password to sign in with or to reset', async () => {
    const who = person('nopassword');
    await sessionOf(h, await signIn(h, corp, 'corp', { ...who, email_verified: true }));
    const forgot = await h.app.inject({
      method: 'POST',
      url: '/api/auth/forgot-password',
      payload: { email: who.email },
    });
    assert.equal(forgot.statusCode, 200, forgot.body);
    assert.deepEqual(
      (await h.outbox()).filter((message) => message.to_email === who.email),
      [],
      'no reset link is issued',
    );
    const account = await h.store.users.findByEmail(who.email);
    assert.ok(account);
    const token = 'reset-token-for-provisioned-0123';
    await h.store.verificationTokens.create({
      user_id: account.id,
      token_hash: h.app.nexus.crypto.hashToken(token),
      purpose: 'password_reset',
      expires_at: new Date(Date.now() + 600_000).toISOString(),
    });
    const reset = await h.app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      payload: { token, new_password: TEST_PASSWORD },
    });
    assert.equal(reset.statusCode, 400, reset.body);
  });

  it('keeps a linked account’s password unless its provider says otherwise', async () => {
    const local = await h.registerUser({ email: 'keeps-password@corp.example.test' });
    await h.store.emailProofs.upsert(
      local.user.id,
      local.user.email,
      'verification_link',
      new Date().toISOString(),
    );
    // corp leaves linked accounts their password.
    await sessionOf(
      h,
      await signIn(h, corp, 'corp', {
        sub: 'keeps-password-subject',
        email: local.user.email,
        email_verified: true,
      }),
    );
    assert.equal((await h.loginUser(local.user.email)).user.id, local.user.id);
    // partner sets disable_local_password_for_linked: once linked there, the
    // provider's offboarding holds for the account.
    await sessionOf(
      h,
      await signIn(h, partner, 'partner', {
        sub: 'keeps-password-partner',
        email: local.user.email,
        email_verified: true,
        groups: ['partners'],
      }),
    );
    const login = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: local.user.email, password: TEST_PASSWORD },
    });
    assert.equal(login.statusCode, 401, login.body);
  });

  /* ── Mapping ────────────────────────────────────────────────────────── */

  it('re-applies the mapped role on every sign-in, and audits the change', async () => {
    const who = person('roles');
    const first = await sessionOf(
      h,
      await signIn(h, corp, 'corp', { ...who, email_verified: true, groups: ['portal-admins'] }),
    );
    assert.equal(first.user.role, 'admin');
    const demoted = await sessionOf(
      h,
      await signIn(h, corp, 'corp', { ...who, email_verified: true, groups: ['api-publishers'] }),
    );
    assert.equal(demoted.user.role, 'provider');
    const sync = (await h.auditRows(AuditAction.AUTH_SSO_CLAIMS_SYNC)).find(
      (row) => row.target_id === first.user.id,
    );
    assert.equal(sync?.details.from_role, 'admin');
    assert.equal(sync?.details.to_role, 'provider');
    assert.equal(sync?.actor_user_id, null, 'a claim-driven change is the system’s');
  });

  it('never grants, removes or changes super_admin from claims', async () => {
    const superAdmins = async (): Promise<string[]> =>
      (await h.store.users.list({ role: 'super_admin' }, { limit: 100 })).items
        .map((user) => user.id)
        .sort();
    const before = await superAdmins();
    assert.ok(before.includes(founder.user.id));
    // A super admin links explicitly, from their own session.
    const linked = await link(h, corp, 'corp', founder, {
      sub: 'founder-subject',
      email: founder.user.email,
      email_verified: true,
      groups: [],
    });
    assert.equal(ssoError(linked), null);
    // The provider's verification of the founder's address is no proof of it.
    assert.equal(await h.store.emailProofs.findByUser(founder.user.id), null);
    const session = await sessionOf(h, linked);
    assert.equal(session.user.id, founder.user.id);
    assert.equal(session.user.role, 'super_admin', 'a claim mapping to client does not demote');
    const again = await sessionOf(
      h,
      await signIn(h, corp, 'corp', {
        sub: 'founder-subject',
        email: founder.user.email,
        email_verified: true,
        groups: ['portal-admins'],
      }),
    );
    assert.equal(again.user.role, 'super_admin');
    const syncs = (await h.auditRows(AuditAction.AUTH_SSO_CLAIMS_SYNC)).filter(
      (row) => row.target_id === founder.user.id,
    );
    assert.deepEqual(syncs, []);
    // And no claim makes anyone else one.
    assert.deepEqual(await superAdmins(), before);
  });

  it('never locks a super admin out for claims that map to no role', async () => {
    // Needs only the founder seated in `before`: the founder links without an
    // address proof, so nothing another test links or proves matters here.
    const response = await signIn(h, partner, 'partner', { sub: 'founder-partner', groups: [] });
    // Not linked at partner: refused like anyone unknown…
    assert.notEqual(ssoError(response), null);
    // …but once linked, a super admin with no mapped role still signs in.
    const linked = await link(h, partner, 'partner', founder, {
      sub: 'founder-partner',
      groups: [],
    });
    assert.equal(ssoError(linked), null);
    const returning = await signIn(h, partner, 'partner', { sub: 'founder-partner', groups: [] });
    assert.equal((await sessionOf(h, returning)).user.role, 'super_admin');
  });

  it('denies claims that map to no role, and creates nothing', async () => {
    const who = person('denied');
    const response = await signIn(h, partner, 'partner', {
      ...who,
      email_verified: true,
      groups: ['not-partners'],
    });
    assert.equal(ssoError(response), 'access_denied');
    assert.equal(await h.store.users.findByEmail(who.email), null);
  });

  /* ── Administration ─────────────────────────────────────────────────── */

  it('shows administrators the providers without their secrets', async () => {
    const response = await h.authed(founder, { method: 'GET', url: '/api/admin/sso' });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json<SsoAdminSettingsResponse>();
    const corpView = body.providers.find((provider) => provider.id === 'corp');
    assert.equal(corpView?.source, 'environment');
    assert.equal(corpView?.client_secret_set, true);
    assert.equal(corpView?.redirect_uri, `${h.config.publicUrl}/api/auth/sso/corp/callback`);
    const partnerView = body.providers.find((provider) => provider.id === 'partner');
    assert.equal(partnerView?.client_secret_set, false);
    assert.equal(response.body.includes(CORP_SECRET), false);
  });

  it('lets only a super admin change the settings, and stores secrets encrypted', async () => {
    const admin = await h.registerUser({ email: 'sso-admin@corp.example.test' });
    await h.store.users.update(admin.user.id, { role: 'admin' });
    const denied = await h.authed(admin, {
      method: 'PUT',
      url: '/api/admin/sso',
      payload: { policy: 'local_only' },
    });
    assert.equal(denied.statusCode, 403, denied.body);

    const extra = {
      id: 'extra',
      display_name: 'Extra',
      issuer: 'https://extra.example.com',
      client_id: 'nexus-extra',
      scopes: ['openid', 'email'],
      enabled: false,
      jit_provisioning: true,
      link_existing_accounts: true,
      require_verified_email: true,
      allowed_email_domains: [],
      disable_local_password_for_linked: false,
      sync_roles: true,
      default_role: 'client',
      role_mappings: [],
      org_mappings: [],
      client_secret: PARTNER_SECRET,
    };
    const saved = await h.authed(founder, {
      method: 'PUT',
      url: '/api/admin/sso',
      payload: { providers: [extra], allowed_email_domains: [] },
    });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.body.includes(PARTNER_SECRET), false);
    const view = saved.json<SsoAdminSettingsResponse>().providers.find((p) => p.id === 'extra');
    assert.equal(view?.source, 'settings');
    assert.equal(view?.client_secret_set, true);
    const row = await h.store.settings.get(ssoClientSecretKey('extra'));
    assert.equal(row?.encrypted, true);
    assert.equal(String(row?.value).includes(PARTNER_SECRET), false);
    const audit = (await h.auditRows(AuditAction.ADMIN_SETTINGS_UPDATE)).find(
      (entry) => entry.target_id === SSO_SETTINGS_KEY,
    );
    assert.deepEqual(audit?.details.client_secrets_changed, ['extra']);
    assert.equal(JSON.stringify(audit?.details).includes(PARTNER_SECRET), false);

    // An environment provider cannot be shadowed, super_admin is not a
    // mappable role, and an issuer must be HTTPS.
    for (const provider of [
      { ...extra, id: 'corp' },
      { ...extra, role_mappings: [{ claim: 'groups', value: 'root', role: 'super_admin' }] },
      { ...extra, issuer: 'http://extra.example.com' },
    ]) {
      const refused = await h.authed(founder, {
        method: 'PUT',
        url: '/api/admin/sso',
        payload: { providers: [provider] },
      });
      assert.equal(refused.statusCode, 400, refused.body);
    }

    // Removing the provider removes its secret.
    const removed = await h.authed(founder, {
      method: 'PUT',
      url: '/api/admin/sso',
      payload: { providers: [] },
    });
    assert.equal(removed.statusCode, 200, removed.body);
    assert.equal(await h.store.settings.get(ssoClientSecretKey('extra')), null);
  });

  it('restricts sign-in to the allowed email domains', async () => {
    const set = await h.authed(founder, {
      method: 'PUT',
      url: '/api/admin/sso',
      payload: { allowed_email_domains: ['@Allowed.Example.Test'] },
    });
    assert.equal(set.statusCode, 200, set.body);
    assert.deepEqual(set.json<SsoAdminSettingsResponse>().allowed_email_domains, [
      'allowed.example.test',
    ]);
    try {
      const outside = person('domain');
      const refused = await signIn(h, corp, 'corp', { ...outside, email_verified: true });
      assert.equal(ssoError(refused), 'email_domain_not_allowed');
      // An address the provider did not verify proves no domain.
      const unverified = await signIn(h, corp, 'corp', {
        sub: 'domain-unverified',
        email: 'claims@allowed.example.test',
        email_verified: false,
      });
      assert.equal(ssoError(unverified), 'email_not_verified');
      const inside = await signIn(h, corp, 'corp', {
        sub: 'domain-inside',
        email: 'someone@allowed.example.test',
        email_verified: true,
      });
      assert.equal(ssoError(inside), null);
    } finally {
      await h.authed(founder, {
        method: 'PUT',
        url: '/api/admin/sso',
        payload: { allowed_email_domains: [] },
      });
    }
  });

  it('keeps links to their issuer: no issuer change with links, removal deletes them', async () => {
    const provider = {
      id: 'lifecycle',
      display_name: 'Lifecycle',
      issuer: corp.issuer,
      client_id: 'nexus-corp',
      client_secret: CORP_SECRET,
      scopes: ['openid', 'email'],
      enabled: true,
      jit_provisioning: true,
      link_existing_accounts: true,
      require_verified_email: true,
      allowed_email_domains: ['corp.example.test'],
      disable_local_password_for_linked: false,
      sync_roles: true,
      default_role: 'client',
      role_mappings: [],
      org_mappings: [],
    };
    const put = (providers: unknown[]): Promise<LightMyRequestResponse> =>
      h.authed(founder, { method: 'PUT', url: '/api/admin/sso', payload: { providers } });
    assert.equal((await put([provider])).statusCode, 200);

    // The provider's own domain list applies when provisioning.
    const outsider = await signIn(h, corp, 'lifecycle', {
      sub: 'lifecycle-outsider',
      email: 'someone@elsewhere.example.test',
      email_verified: true,
    });
    assert.equal(ssoError(outsider), 'email_domain_not_allowed');
    const who = person('lifecycle');
    const account = await sessionOf(
      h,
      await signIn(h, corp, 'lifecycle', { ...who, email_verified: true }),
    );
    assert.equal(await h.store.userIdentities.countByProvider('lifecycle'), 1);

    const moved = await put([{ ...provider, issuer: 'https://another.example.com' }]);
    assert.equal(moved.statusCode, 400, moved.body);

    // Removing the provider removes its links, so an id reused later starts clean.
    assert.equal((await put([])).statusCode, 200);
    assert.equal(await h.store.userIdentities.countByProvider('lifecycle'), 0);
    const removal = (await h.auditRows(AuditAction.ADMIN_SETTINGS_UPDATE)).find(
      (row) => row.target_id === SSO_SETTINGS_KEY,
    );
    assert.deepEqual(removal?.details.links_removed, { lifecycle: 1 });
    // The account it provisioned stays active, and still has no password: a
    // reset must not keep a user the provider offboarded.
    assert.equal((await h.store.users.findById(account.user.id))?.status, 'active');
    assert.equal(
      (await h.store.passwordLocks.findByUser(account.user.id))?.provider_id,
      'lifecycle',
    );
    await assertNoLocalPassword(h, who.email);
    assert.equal((await put([provider])).statusCode, 200);
    // The same subject, now asserting another address, is a stranger: the
    // old link did not survive to open the old account.
    const reused = await signIn(h, corp, 'lifecycle', {
      sub: who.sub,
      email: person('reused').email,
      email_verified: true,
    });
    assert.notEqual((await sessionOf(h, reused)).user.id, account.user.id);
    assert.equal((await put([])).statusCode, 200);
  });

  it('commits nothing for a callback whose provider changed while it waited', async () => {
    const provider = {
      id: 'inflight',
      display_name: 'In flight',
      issuer: corp.issuer,
      client_id: 'nexus-corp',
      client_secret: CORP_SECRET,
      scopes: ['openid', 'email'],
      enabled: true,
      jit_provisioning: true,
      link_existing_accounts: true,
      require_verified_email: true,
      allowed_email_domains: [],
      disable_local_password_for_linked: false,
      sync_roles: true,
      default_role: 'client',
      role_mappings: [{ claim: 'groups', value: 'portal-admins', role: 'admin' }],
      org_mappings: [],
    };
    const put = (providers: unknown[]): Promise<LightMyRequestResponse> =>
      h.authed(founder, { method: 'PUT', url: '/api/admin/sso', payload: { providers } });
    /** Deliver `attempt` once `providers` were saved while it waited on the token endpoint. */
    const finishAfterSave = async (
      attempt: Attempt,
      providers: unknown[],
    ): Promise<LightMyRequestResponse> => {
      let saved = 0;
      corp.beforeNextTokenResponse = async () => {
        saved = (await put(providers)).statusCode;
      };
      const response = await finish(h, 'inflight', attempt);
      assert.equal(saved, 200, 'the save committed while the callback waited');
      return response;
    };
    assert.equal((await put([provider])).statusCode, 200);

    // Removed while a first sign-in waited: nothing is provisioned.
    const fresh = person('inflight');
    const removed = await finishAfterSave(
      await begin(h, corp, 'inflight', { ...fresh, email_verified: true }),
      [],
    );
    assert.equal(ssoError(removed), 'sso_disabled');
    assert.equal(cookieValue(removed, SESSION_COOKIE), undefined);
    assert.equal(await h.store.users.findByEmail(fresh.email), null);
    assert.equal(
      await h.store.userIdentities.findBySubject('inflight', corp.issuer, fresh.sub),
      null,
    );

    // Disabled while an automatic link waited: nothing is linked.
    assert.equal((await put([provider])).statusCode, 200);
    const local = await localAccount('inflight-link@corp.example.test', true);
    const disabled = await finishAfterSave(
      await begin(h, corp, 'inflight', {
        sub: 'inflight-link-subject',
        email: local.email,
        email_verified: true,
      }),
      [{ ...provider, enabled: false }],
    );
    assert.equal(ssoError(disabled), 'sso_disabled');
    assert.deepEqual(await h.store.userIdentities.listByUser(local.id), []);

    // A returning account: a mapping removed mid-flight is not applied from
    // the stale copy, and a disable mid-flight issues no session.
    assert.equal((await put([provider])).statusCode, 200);
    const returning = person('inflight-returning');
    const first = await sessionOf(
      h,
      await signIn(h, corp, 'inflight', { ...returning, email_verified: true }),
    );
    assert.equal(first.user.role, 'client');
    const logins = async (): Promise<number> => {
      const rows = await h.auditRows(AuditAction.AUTH_SSO_LOGIN);
      return rows.filter((row) => row.target_id === first.user.id).length;
    };
    const loginsBefore = await logins();
    const [identityBefore] = await h.store.userIdentities.listByUser(first.user.id);

    const remapped = await finishAfterSave(
      await begin(h, corp, 'inflight', {
        ...returning,
        email_verified: true,
        groups: ['portal-admins'],
      }),
      [{ ...provider, role_mappings: [] }],
    );
    assert.equal(ssoError(remapped), 'sso_disabled');
    assert.equal((await h.store.users.findById(first.user.id))?.role, 'client');

    const stale = await finishAfterSave(
      await begin(h, corp, 'inflight', { ...returning, email_verified: true }),
      [{ ...provider, role_mappings: [], enabled: false }],
    );
    assert.equal(ssoError(stale), 'sso_disabled');
    assert.equal(cookieValue(stale, SESSION_COOKIE), undefined);
    assert.equal(await logins(), loginsBefore);
    const [identityAfter] = await h.store.userIdentities.listByUser(first.user.id);
    assert.equal(identityAfter?.last_login_at, identityBefore?.last_login_at);

    assert.equal((await put([])).statusCode, 200);
  });

  it('orders a first-time link, not a returning sign-in, against a settings save', async () => {
    const provider = {
      id: 'ordered',
      display_name: 'Ordered',
      issuer: corp.issuer,
      client_id: 'nexus-corp',
      client_secret: CORP_SECRET,
      scopes: ['openid', 'email'],
      enabled: true,
      jit_provisioning: true,
      link_existing_accounts: true,
      require_verified_email: true,
      allowed_email_domains: [],
      disable_local_password_for_linked: false,
      sync_roles: true,
      default_role: 'client',
      role_mappings: [],
      org_mappings: [],
    };
    const put = (providers: unknown[]): Promise<LightMyRequestResponse> =>
      h.authed(founder, { method: 'PUT', url: '/api/admin/sso', payload: { providers } });
    assert.equal((await put([provider])).statusCode, 200);

    // A returning sign-in holds only its account's key: sign-ins at one
    // provider do not queue behind each other deployment-wide.
    const returning = person('ordered-returning');
    const account = await sessionOf(
      h,
      await signIn(h, corp, 'ordered', { ...returning, email_verified: true }),
    );
    leases.taken = [];
    const again = await signIn(h, corp, 'ordered', { ...returning, email_verified: true });
    assert.equal((await sessionOf(h, again)).user.id, account.user.id);
    const lifecycleKey = userLifecycleLockKey(account.user.id);
    assert.deepEqual(
      leases.taken.filter((key) => key.startsWith('sso:') || key === lifecycleKey),
      [lifecycleKey],
    );

    // A first-time sign-in provisions under the provider's key. A save that
    // removes the provider meanwhile waits for it, then removes its link.
    const fresh = person('ordered-fresh');
    const attempt = await begin(h, corp, 'ordered', { ...fresh, email_verified: true });
    const race: { save: Promise<LightMyRequestResponse> | null; whileHeld: string | null } = {
      save: null,
      whileHeld: null,
    };
    leases.next = {
      key: ssoProviderLockKey('ordered'),
      run: async () => {
        const save = put([]);
        race.save = save;
        race.whileHeld = await Promise.race([
          save.then(() => 'saved'),
          delay(300).then(() => 'waiting'),
        ]);
      },
    };
    const response = await finish(h, 'ordered', attempt);
    assert.equal(race.whileHeld, 'waiting', 'the save waited for the provisioning to commit');
    assert.equal(ssoError(response), null);
    assert.ok(await h.store.users.findByEmail(fresh.email));
    assert.ok(race.save, 'the save was started');
    assert.equal((await race.save).statusCode, 200);
    assert.equal(await h.store.userIdentities.countByProvider('ordered'), 0);
    const removal = (await h.auditRows(AuditAction.ADMIN_SETTINGS_UPDATE)).find(
      (row) => row.target_id === SSO_SETTINGS_KEY,
    );
    assert.deepEqual(removal?.details.links_removed, { ordered: 2 });
  });

  it('refuses a settings save when the settings changed after it read them', async () => {
    const before = await readStoredSsoSettings(h.store);
    assert.equal(before.deprovision_on_access_loss, false);
    // Another save adds a provider after this one read the settings and
    // before it holds its keys. Writing over it would drop the new provider
    // without locking it or removing its links.
    const added = {
      id: 'swapped',
      display_name: 'Swapped',
      issuer: 'https://swapped.example.com',
      client_id: 'nexus-swapped',
      scopes: ['openid', 'email'],
      enabled: false,
      jit_provisioning: true,
      link_existing_accounts: true,
      require_verified_email: true,
      allowed_email_domains: [],
      disable_local_password_for_linked: false,
      sync_roles: true,
      default_role: 'client',
      role_mappings: [],
      org_mappings: [],
    };
    leases.next = {
      key: ssoProviderLockKey('corp'),
      run: async () => {
        await h.store.settings.set(
          SSO_SETTINGS_KEY,
          { ...before, providers: [...before.providers, added] },
          false,
        );
      },
    };
    try {
      const refused = await h.authed(founder, {
        method: 'PUT',
        url: '/api/admin/sso',
        payload: { deprovision_on_access_loss: true },
      });
      assert.equal(leases.next, null, 'the settings changed while the save held its keys');
      assert.equal(refused.statusCode, 409, refused.body);
      const after = await readStoredSsoSettings(h.store);
      assert.equal(after.deprovision_on_access_loss, false);
      assert.deepEqual(
        after.providers.map((provider) => provider.id),
        [...before.providers.map((provider) => provider.id), 'swapped'],
      );
    } finally {
      leases.next = null;
      await h.store.settings.set(SSO_SETTINGS_KEY, before, false);
    }
  });

  it('reports a stored provider that an environment provider shadows', async () => {
    const current = (await h.store.settings.get(SSO_SETTINGS_KEY))?.value ?? {};
    const shadow = {
      id: 'corp',
      display_name: 'Stale corp',
      issuer: 'https://stale.example.com',
      client_id: 'stale',
      scopes: ['openid'],
      enabled: true,
      jit_provisioning: true,
      link_existing_accounts: true,
      require_verified_email: true,
      allowed_email_domains: [],
      disable_local_password_for_linked: false,
      sync_roles: true,
      default_role: 'client',
      role_mappings: [],
      org_mappings: [],
    };
    await h.store.settings.set(SSO_SETTINGS_KEY, { ...(current as object), providers: [shadow] });
    const view = await h.authed(founder, { method: 'GET', url: '/api/admin/sso' });
    const body = view.json<SsoAdminSettingsResponse>();
    assert.deepEqual(body.shadowed_provider_ids, ['corp']);
    const corpView = body.providers.filter((provider) => provider.id === 'corp');
    assert.equal(corpView.length, 1);
    assert.equal(corpView[0]?.source, 'environment');

    // Saving removes the shadowed provider, and leaves the environment
    // provider's links — which share its id — alone.
    const links = await h.store.userIdentities.countByProvider('corp');
    assert.ok(links > 0);
    const saved = await h.authed(founder, {
      method: 'PUT',
      url: '/api/admin/sso',
      payload: { providers: [] },
    });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.deepEqual(saved.json<SsoAdminSettingsResponse>().shadowed_provider_ids, []);
    assert.equal(await h.store.userIdentities.countByProvider('corp'), links);
  });

  it('lets an administrator list and remove an account’s links', async () => {
    const who = person('unlink');
    const session = await sessionOf(
      h,
      await signIn(h, corp, 'corp', { ...who, email_verified: true }),
    );
    const listed = await h.authed(founder, {
      method: 'GET',
      url: `/api/users/${session.user.id}/identities`,
    });
    assert.equal(listed.statusCode, 200, listed.body);
    const [identity] = listed.json<{ items: { id: string; provider_id: string }[] }>().items;
    assert.equal(identity?.provider_id, 'corp');
    const removed = await h.authed(founder, {
      method: 'DELETE',
      url: `/api/users/${session.user.id}/identities/${identity?.id ?? ''}`,
    });
    assert.equal(removed.statusCode, 200, removed.body);
    assert.deepEqual(await h.store.userIdentities.listByUser(session.user.id), []);
    const unlink = (await h.auditRows(AuditAction.AUTH_SSO_UNLINK)).find(
      (row) => row.target_id === session.user.id,
    );
    assert.equal(unlink?.details.subject, who.sub);
    // Unlinking the identity that provisioned the account gives it no password.
    await assertNoLocalPassword(h, who.email);
    // The client itself cannot.
    const forbidden = await h.authed(session, {
      method: 'GET',
      url: `/api/users/${session.user.id}/identities`,
    });
    assert.equal(forbidden.statusCode, 403, forbidden.body);
  });

  it('keeps tokens, codes and secrets out of the audit log and the server log', async () => {
    const attempt = await begin(h, corp, 'corp', { ...person('secrets'), email_verified: true });
    await finish(h, 'corp', attempt);
    await finish(h, 'corp', attempt, { state: 'forged' });
    const rows = JSON.stringify(await h.auditRows());
    const logs = logLines.join('\n');
    for (const secret of [
      attempt.authorization.code,
      attempt.authorization.state,
      attempt.authorization.params.get('nonce') ?? '<nonce>',
      attempt.transaction,
      CORP_SECRET,
    ]) {
      assert.equal(rows.includes(secret), false, 'audit rows');
      assert.equal(logs.includes(secret), false, 'log lines');
    }
    assert.ok(logs.includes('A single sign-on attempt was refused'), 'refusals are logged');
  });
});

describe('single sign-on organization mapping and deprovisioning', () => {
  let corp: MockOidcProvider;
  let partner: MockOidcProvider;
  let h: TestApp;
  let founder: TestSession;
  let orgId = '';

  before(async () => {
    corp = createMockOidcProvider({ clientId: 'nexus-corp', clientSecret: CORP_SECRET });
    partner = createMockOidcProvider({ clientId: 'nexus-partner', clientSecret: null });
    await corp.start();
    await partner.start();
    h = await buildTestApp({
      env: {
        NEXUS_OIDC_ALLOW_HTTP_LOOPBACK: 'true',
        NEXUS_OIDC_PROVIDERS: providersEnv(corp, partner),
      },
    });
    founder = await h.registerUser({ email: 'org-founder@corp.example.test' });
    orgId = (await h.store.organizations.create({ name: 'Payments', description: null })).id;
    // A provider saved through the admin API, as opposed to the environment:
    // its secret is stored encrypted and read back for the token request.
    const saved = await h.authed(founder, {
      method: 'PUT',
      url: '/api/admin/sso',
      payload: {
        providers: [
          {
            id: 'corp-orgs',
            display_name: 'Corporate SSO (organizations)',
            issuer: corp.issuer,
            client_id: 'nexus-corp',
            client_secret: CORP_SECRET,
            scopes: ['openid', 'email', 'profile'],
            enabled: true,
            jit_provisioning: true,
            link_existing_accounts: true,
            require_verified_email: true,
            allowed_email_domains: [],
            disable_local_password_for_linked: false,
            sync_roles: true,
            default_role: 'client',
            role_mappings: [],
            org_mappings: [{ claim: 'department', value: 'payments', org_id: orgId }],
          },
        ],
      },
    });
    assert.equal(saved.statusCode, 200, saved.body);
  });

  after(async () => {
    await h?.close();
    await corp?.stop();
    await partner?.stop();
  });

  it('maps the organization from claims, and follows it on later sign-ins', async () => {
    const who = person('org');
    const first = await sessionOf(
      h,
      await signIn(h, corp, 'corp-orgs', { ...who, email_verified: true, department: 'payments' }),
    );
    assert.equal(first.user.org_id, orgId);
    const moved = await sessionOf(
      h,
      await signIn(h, corp, 'corp-orgs', { ...who, email_verified: true, department: 'sales' }),
    );
    assert.equal(moved.user.org_id, null);
    const sync = (await h.auditRows(AuditAction.AUTH_SSO_CLAIMS_SYNC)).find(
      (row) => row.target_id === first.user.id,
    );
    assert.equal(sync?.details.from_org_id, orgId);
    assert.equal(sync?.details.to_org_id, null);
  });

  it('disables an account whose claims lost their role, when deprovisioning is on', async () => {
    const who = person('deprovision');
    const claims = { ...who, email_verified: true, groups: ['partners'] };
    const account = await sessionOf(h, await signIn(h, partner, 'partner', claims));
    await h.authed(account, {
      method: 'POST',
      url: '/api/credentials',
      payload: { credential_type: 'keyauth' },
    });

    // A live recovery link an administrator would expect a disable to end.
    const resetToken = 'a-live-reset-link-for-deprovision';
    const resetHash = h.app.nexus.crypto.hashToken(resetToken);
    await h.store.verificationTokens.create({
      user_id: account.user.id,
      token_hash: resetHash,
      purpose: 'password_reset',
      expires_at: isoInSeconds(3600),
    });

    // Off (the default): the sign-in is refused and the account left alone.
    const refused = await signIn(h, partner, 'partner', { ...claims, groups: [] });
    assert.equal(ssoError(refused), 'access_denied');
    assert.equal((await h.store.users.findById(account.user.id))?.status, 'active');

    const enable = await h.authed(founder, {
      method: 'PUT',
      url: '/api/admin/sso',
      payload: { deprovision_on_access_loss: true },
    });
    assert.equal(enable.statusCode, 200, enable.body);
    const deprovisioned = await signIn(h, partner, 'partner', { ...claims, groups: [] });
    assert.equal(ssoError(deprovisioned), 'access_denied');
    assert.equal((await h.store.users.findById(account.user.id))?.status, 'disabled');
    // Through the same durable revocation an administrator's disable queues.
    const job = await h.store.gatewayTeardownJobs.findByUser(account.user.id);
    assert.ok(job, 'a gateway teardown was queued');
    const credentials = await h.store.credentials.list({ user_id: account.user.id });
    assert.ok(credentials.items.every((credential) => credential.status === 'revoked'));
    const row = (await h.auditRows(AuditAction.AUTH_SSO_DEPROVISION)).find(
      (entry) => entry.target_id === account.user.id,
    );
    assert.equal(row?.details.gateway_teardown, 'queued');
    assert.equal(
      await h.store.verificationTokens.findByTokenHash(resetHash, 'password_reset'),
      null,
      'the deprovision revoked the outstanding reset link',
    );
    // The old session is gone.
    const me = await h.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: account.cookieHeader },
    });
    assert.equal(me.statusCode, 401);
    // And a later sign-in reports the account as disabled.
    const later = await signIn(h, partner, 'partner', claims);
    assert.equal(ssoError(later), 'account_disabled');
  });
});

describe('single sign-on login policies', () => {
  let corp: MockOidcProvider;
  let partner: MockOidcProvider;

  before(async () => {
    corp = createMockOidcProvider({ clientId: 'nexus-corp', clientSecret: CORP_SECRET });
    partner = createMockOidcProvider({ clientId: 'nexus-partner', clientSecret: null });
    await corp.start();
    await partner.start();
  });

  after(async () => {
    await corp?.stop();
    await partner?.stop();
  });

  async function app(breakGlass = false): Promise<TestApp> {
    return buildTestApp({
      env: {
        NEXUS_OIDC_ALLOW_HTTP_LOOPBACK: 'true',
        NEXUS_OIDC_PROVIDERS: providersEnv(corp, partner),
        NEXUS_SSO_BREAK_GLASS_LOCAL_LOGIN: breakGlass ? 'true' : 'false',
      },
    });
  }

  async function publicConfig(h: TestApp): Promise<SsoPublicConfigResponse> {
    const response = await h.app.inject({ method: 'GET', url: '/api/auth/sso' });
    assert.equal(response.statusCode, 200, response.body);
    return response.json<SsoPublicConfigResponse>();
  }

  async function setPolicy(h: TestApp, policy: string): Promise<void> {
    const current = (await h.store.settings.get(SSO_SETTINGS_KEY))?.value ?? {};
    await h.store.settings.set(SSO_SETTINGS_KEY, { ...(current as object), policy }, false);
  }

  it('local_only: no providers offered, and the SSO routes refuse', async () => {
    const h = await app();
    try {
      await setPolicy(h, 'local_only');
      const config = await publicConfig(h);
      assert.deepEqual(config.providers, []);
      assert.equal(config.password_login, 'enabled');
      const start = await h.app.inject({ method: 'GET', url: '/api/auth/sso/corp/start' });
      assert.equal(ssoError(start), 'sso_disabled');
      assert.equal(cookieValue(start, SSO_TRANSACTION_COOKIE), undefined);
    } finally {
      await h.close();
    }
  });

  it('sso_only: refuses passwords and registration, but not the founder', async () => {
    const h = await app();
    try {
      // Set before anybody exists: the founder's seat is taken with the
      // bootstrap token whatever the policy says.
      await setPolicy(h, 'sso_only');
      const founder = await h.registerUser({ email: 'sso-only-founder@corp.example.test' });
      assert.equal(founder.user.role, 'super_admin');

      const register = await h.app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          email: 'late@corp.example.test',
          password: TEST_PASSWORD,
          display_name: 'Late',
          role: 'client',
          bootstrap_token: TEST_BOOTSTRAP_TOKEN,
        },
      });
      assert.equal(register.statusCode, 403, register.body);

      const login = await h.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: founder.user.email, password: TEST_PASSWORD },
      });
      assert.equal(login.statusCode, 403, login.body);

      const config = await publicConfig(h);
      assert.equal(config.password_login, 'disabled');
      assert.equal(config.registration_enabled, false);

      // Single sign-on still provisions.
      const who = person('ssoonly');
      const response = await signIn(h, corp, 'corp', { ...who, email_verified: true });
      assert.equal(ssoError(response), null);
    } finally {
      await h.close();
    }
  });

  it('sso_only with break-glass: a super admin may use a password, nobody else', async () => {
    const h = await app(true);
    try {
      const founder = await h.registerUser({ email: 'glass-founder@corp.example.test' });
      const client = await h.registerUser({ email: 'glass-client@corp.example.test' });
      await setPolicy(h, 'sso_only');
      const config = await publicConfig(h);
      assert.equal(config.password_login, 'break_glass');

      const admitted = await h.loginUser(founder.user.email);
      assert.equal(admitted.user.role, 'super_admin');
      const row = (await h.auditRows(AuditAction.AUTH_LOGIN)).find(
        (entry) => entry.target_id === founder.user.id,
      );
      assert.equal(row?.details.break_glass, true);

      const refused = await h.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: client.user.email, password: TEST_PASSWORD },
      });
      assert.equal(refused.statusCode, 401, refused.body);
    } finally {
      await h.close();
    }
  });

  it('keeps break-glass open to a super admin linked to a strict provider', async () => {
    const h = await app(true);
    try {
      const founder = await h.registerUser({ email: 'strict-founder@corp.example.test' });
      // partner sets disable_local_password_for_linked, which binds everyone
      // linked there but a super admin.
      const linked = await link(h, partner, 'partner', founder, {
        sub: 'strict-founder-subject',
        groups: ['partners'],
      });
      assert.equal(ssoError(linked), null);
      assert.equal((await h.loginUser(founder.user.email)).user.id, founder.user.id);
      const put = await h.authed(founder, {
        method: 'PUT',
        url: '/api/admin/sso',
        payload: { policy: 'sso_only' },
      });
      assert.equal(put.statusCode, 200, put.body);
      // Were the provider down, break-glass would still let the super admin in.
      const admitted = await h.loginUser(founder.user.email);
      assert.equal(admitted.user.role, 'super_admin');
    } finally {
      await h.close();
    }
  });

  it('refuses sso_only without an enabled provider to sign in with', async () => {
    const h = await buildTestApp();
    try {
      const founder = await h.registerUser();
      const response = await h.authed(founder, {
        method: 'PUT',
        url: '/api/admin/sso',
        payload: { policy: 'sso_only' },
      });
      assert.equal(response.statusCode, 400, response.body);
    } finally {
      await h.close();
    }
  });

  it('refuses sso_only until the saving super admin has a link of their own', async () => {
    const h = await app();
    try {
      const founder = await h.registerUser({ email: 'own-link@corp.example.test' });
      const put = (): Promise<LightMyRequestResponse> =>
        h.authed(founder, {
          method: 'PUT',
          url: '/api/admin/sso',
          payload: { policy: 'sso_only' },
        });
      const refused = await put();
      assert.equal(refused.statusCode, 400, refused.body);
      assert.match(refused.body, /Link your own account/);
      const linked = await link(h, corp, 'corp', founder, {
        sub: 'own-link-subject',
        email: founder.user.email,
        email_verified: true,
      });
      assert.equal(ssoError(linked), null);
      assert.equal((await put()).statusCode, 200);
    } finally {
      await h.close();
    }
  });

  it('lets the unproven founder link explicitly, and no other super admin', async () => {
    const h = await app();
    try {
      const founder = await h.registerUser({ email: 'unproven-founder@corp.example.test' });
      assert.equal(founder.user.role, 'super_admin');
      assert.equal(await h.store.emailProofs.findByUser(founder.user.id), null);
      // The bootstrap token proved the seat: no address, verified or not, needed.
      const linked = await link(h, corp, 'corp', founder, { sub: 'unproven-founder-subject' });
      assert.equal(ssoError(linked), null);
      const [identity] = await h.store.userIdentities.listByUser(founder.user.id);
      assert.equal(identity?.subject, 'unproven-founder-subject');
      assert.equal(await h.store.emailProofs.findByUser(founder.user.id), null);

      // A super admin promoted later was never seated by the token.
      const promoted = await h.registerUser({ email: 'promoted-super@corp.example.test' });
      await h.store.users.update(promoted.user.id, { role: 'super_admin' });
      const refused = await link(h, corp, 'corp', promoted, {
        sub: 'promoted-super-subject',
        email: promoted.user.email,
        email_verified: true,
      });
      assert.equal(ssoError(refused), 'address_unproven');
      assert.deepEqual(await h.store.userIdentities.listByUser(promoted.user.id), []);
    } finally {
      await h.close();
    }
  });

  it('never seats a founder from single sign-on', async () => {
    const h = await app();
    try {
      const response = await signIn(h, corp, 'corp', {
        ...person('first'),
        email_verified: true,
        groups: ['portal-admins'],
      });
      const session = await sessionOf(h, response);
      assert.equal(session.user.role, 'admin', 'the mapped role, never super_admin');
      assert.equal(await h.services.auth.bootstrapRequired(), true, 'the seat stays open');
    } finally {
      await h.close();
    }
  });
});
