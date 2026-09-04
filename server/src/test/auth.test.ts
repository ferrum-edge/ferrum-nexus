import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type { LightMyRequestResponse } from 'fastify';

import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE, type ApiErrorBody } from '@ferrum-nexus/shared';

import { AuditAction } from '../audit/service.js';
import { REGISTRATION_SETTINGS_KEY, SUPER_ADMIN_CLAIM_KEY } from '../auth/service.js';
import { createCrypto } from '../lib/crypto.js';
import { isoInSeconds } from '../lib/ids.js';
import {
  buildTestApp,
  cookieValue,
  TEST_BOOTSTRAP_TOKEN,
  TEST_PASSWORD,
  TEST_SECRET_KEY,
  type TestApp,
} from './helpers.js';

function errorCode(body: string): string {
  return (JSON.parse(body) as ApiErrorBody).error.code;
}

describe('auth flow', () => {
  let harness: TestApp;

  before(async () => {
    harness = await buildTestApp();
  });

  after(async () => {
    await harness.close();
  });

  it('makes the first registered account a verified super_admin', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: 'Founder@Example.Test',
        password: TEST_PASSWORD,
        display_name: 'Founder',
        // A client role is requested; the bootstrap rule overrides it.
        role: 'client',
        bootstrap_token: TEST_BOOTSTRAP_TOKEN,
      },
    });

    assert.equal(response.statusCode, 201);
    const body = response.json<{
      user: { role: string; email: string; email_verified: boolean };
    }>();
    assert.equal(body.user.role, 'super_admin');
    assert.equal(body.user.email, 'founder@example.test', 'email is normalised to lowercase');
    assert.equal(body.user.email_verified, true);
    assert.ok(cookieValue(response, SESSION_COOKIE), 'the founder lands signed in');
    assert.ok(cookieValue(response, CSRF_COOKIE));
  });

  it('gives later registrations the role they asked for', async () => {
    const session = await harness.registerUser({ email: 'second@example.test', role: 'client' });
    assert.equal(session.user.role, 'client');

    const provider = await harness.registerUser({ email: 'third@example.test', role: 'provider' });
    assert.equal(provider.user.role, 'provider');
  });

  it('rejects a duplicate email with 409 CONFLICT, case-insensitively', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: 'SECOND@example.test',
        password: TEST_PASSWORD,
        display_name: 'Impostor',
        role: 'client',
      },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(errorCode(response.body), 'CONFLICT');
  });

  it('rejects a weak password and an elevated role with 400', async () => {
    const weak = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: 'weak@example.test',
        password: 'short',
        display_name: 'Weak',
        role: 'client',
      },
    });
    assert.equal(weak.statusCode, 400);
    assert.equal(errorCode(weak.body), 'VALIDATION_FAILED');

    const elevated = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: 'sneaky@example.test',
        password: TEST_PASSWORD,
        display_name: 'Sneaky',
        role: 'super_admin',
      },
    });
    assert.equal(elevated.statusCode, 400);
    assert.equal(errorCode(elevated.body), 'VALIDATION_FAILED');
  });

  it('signs in with the right password and refuses the wrong one', async () => {
    const ok = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'second@example.test', password: TEST_PASSWORD },
    });
    assert.equal(ok.statusCode, 200);
    const body = ok.json<{ csrf_token: string; expires_at: string }>();
    assert.equal(body.csrf_token, cookieValue(ok, CSRF_COOKIE));
    assert.ok(Date.parse(body.expires_at) > Date.now());

    const wrong = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'second@example.test', password: 'not-the-password' },
    });
    assert.equal(wrong.statusCode, 401);
    assert.equal(errorCode(wrong.body), 'UNAUTHORIZED');

    const missing = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'nobody@example.test', password: TEST_PASSWORD },
    });
    assert.equal(
      missing.statusCode,
      401,
      'an unknown account is indistinguishable from a bad password',
    );
    assert.equal(errorCode(missing.body), 'UNAUTHORIZED');
  });

  it('returns the principal and capabilities from /me', async () => {
    const session = await harness.loginUser('second@example.test');
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: session.cookieHeader },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json<{
      user: { email: string };
      csrf_token: string;
      capabilities: Record<string, boolean>;
    }>();
    assert.equal(body.user.email, 'second@example.test');
    assert.equal(body.csrf_token, session.csrfToken);
    assert.deepEqual(body.capabilities, {
      can_publish_apis: false,
      can_review_access_requests: false,
      can_manage_users: false,
      can_manage_settings: false,
      can_view_audit_log: false,
      can_use_god_mode: false,
    });

    const anonymous = await harness.app.inject({ method: 'GET', url: '/api/auth/me' });
    assert.equal(anonymous.statusCode, 401);
    assert.equal(errorCode(anonymous.body), 'UNAUTHORIZED');
  });

  it('reports super_admin capabilities including god mode', async () => {
    const founder = await harness.loginUser('founder@example.test');
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: founder.cookieHeader },
    });
    const body = response.json<{ capabilities: Record<string, boolean> }>();
    assert.equal(body.capabilities.can_use_god_mode, true);
    assert.equal(body.capabilities.can_manage_settings, true);
  });

  describe('CSRF', () => {
    it('rejects a mutation without the X-Nexus-CSRF header', async () => {
      const session = await harness.loginUser('second@example.test');
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { cookie: session.cookieHeader },
      });
      assert.equal(response.statusCode, 403);
      assert.equal(errorCode(response.body), 'CSRF_MISMATCH');
    });

    it('rejects a header that does not match the session token', async () => {
      const session = await harness.loginUser('second@example.test');
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { cookie: session.cookieHeader, [CSRF_HEADER]: 'not-the-token' },
      });
      assert.equal(response.statusCode, 403);
      assert.equal(errorCode(response.body), 'CSRF_MISMATCH');
    });

    it('rejects a matching cookie/header pair that is not bound to the session', async () => {
      const session = await harness.loginUser('second@example.test');
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: {
          cookie: `${SESSION_COOKIE}=${session.sessionToken}; ${CSRF_COOKIE}=forged-token`,
          [CSRF_HEADER]: 'forged-token',
        },
      });
      assert.equal(response.statusCode, 403);
      assert.equal(errorCode(response.body), 'CSRF_MISMATCH');
    });

    it('accepts a mutation with the matching header, and clears the session', async () => {
      const session = await harness.loginUser('second@example.test');
      const response = await harness.authed(session, { method: 'POST', url: '/api/auth/logout' });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { ok: true });
      assert.equal(cookieValue(response, SESSION_COOKIE), '');

      const afterLogout = await harness.app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { cookie: session.cookieHeader },
      });
      assert.equal(afterLogout.statusCode, 401, 'the session row is gone');
    });

    it('does not require CSRF on the pre-authentication endpoints', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'second@example.test', password: TEST_PASSWORD },
      });
      assert.equal(response.statusCode, 200);
    });
  });

  it('refuses a disabled account with 403 USER_DISABLED', async () => {
    const session = await harness.registerUser({ email: 'disabled@example.test' });
    await harness.store.users.update(session.user.id, { status: 'disabled' });

    const login = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'disabled@example.test', password: TEST_PASSWORD },
    });
    assert.equal(login.statusCode, 403);
    assert.equal(errorCode(login.body), 'USER_DISABLED');

    const existingSession = await harness.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: session.cookieHeader },
    });
    assert.equal(
      existingSession.statusCode,
      401,
      'live sessions are dropped for a disabled account',
    );
  });

  it('exposes the public captcha configuration without auth', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/api/auth/captcha' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { enabled: false, provider: 'none', site_key: null });
  });

  it('writes an audit row for register, login and logout', async () => {
    const session = await harness.registerUser({ email: 'audited@example.test' });

    const registered = await harness.store.auditLogs.list({
      actor_user_id: session.user.id,
      action: AuditAction.AUTH_REGISTER,
    });
    assert.equal(registered.total, 1);
    assert.equal(registered.items[0]?.target_type, 'user');
    assert.equal(registered.items[0]?.actor_role, 'client');
    assert.equal(registered.items[0]?.details.email, 'audited@example.test');

    const loggedIn = await harness.loginUser('audited@example.test');
    const loginRows = await harness.store.auditLogs.list({
      actor_user_id: session.user.id,
      action: AuditAction.AUTH_LOGIN,
    });
    assert.equal(loginRows.total, 1);

    await harness.authed(loggedIn, { method: 'POST', url: '/api/auth/logout' });
    const logoutRows = await harness.store.auditLogs.list({
      actor_user_id: session.user.id,
      action: AuditAction.AUTH_LOGOUT,
    });
    assert.equal(logoutRows.total, 1);
  });

  it('answers unknown API routes with the shared error body', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/api/nope' });
    assert.equal(response.statusCode, 404);
    assert.equal(errorCode(response.body), 'NOT_FOUND');
    assert.equal(response.headers['cache-control'], 'no-store');
  });
});

describe('sliding session expiry', () => {
  let harness: TestApp;

  before(async () => {
    harness = await buildTestApp();
  });

  after(async () => {
    await harness.close();
  });

  /** Every `Set-Cookie` on the response, keyed by cookie name. */
  function setCookies(response: { headers: Record<string, unknown> }): Map<string, string> {
    const raw = response.headers['set-cookie'];
    const list = Array.isArray(raw) ? (raw as string[]) : typeof raw === 'string' ? [raw] : [];
    return new Map(list.map((header) => [header.slice(0, header.indexOf('=')), header]));
  }

  function maxAgeOf(header: string): number | null {
    const match = /(?:^|;\s*)Max-Age=(-?\d+)/i.exec(header);
    return match ? Number(match[1]) : null;
  }

  /** The stored row behind a session cookie, via the same hash the server uses. */
  async function sessionRowFor(token: string) {
    const hash = createCrypto(TEST_SECRET_KEY).hashToken(token);
    const row = await harness.store.sessions.findByTokenHash(hash);
    assert.ok(row, 'the session row exists');
    return row;
  }

  it('re-issues both cookies with a full Max-Age when it slides the row', async () => {
    const session = await harness.registerUser({ email: 'slider@example.test' });
    const ttl = harness.config.sessionTtlSeconds;
    const row = await sessionRowFor(session.sessionToken);

    // Less than half the TTL left, which is what makes the hook write.
    await harness.store.sessions.touch(row.id, isoInSeconds(ttl / 4));

    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: session.cookieHeader },
    });
    assert.equal(response.statusCode, 200);

    const cookies = setCookies(response);
    const sessionCookie = cookies.get(SESSION_COOKIE);
    const csrfCookie = cookies.get(CSRF_COOKIE);
    assert.ok(sessionCookie, 'the session cookie is re-issued');
    assert.ok(csrfCookie, 'the CSRF cookie is re-issued');

    assert.equal(maxAgeOf(sessionCookie), ttl, 'the browser expiry moves with the row');
    assert.equal(maxAgeOf(csrfCookie), ttl);

    // The values must not rotate — the client keeps using the tokens it has.
    assert.equal(cookieValue(response, SESSION_COOKIE), session.sessionToken);
    assert.equal(cookieValue(response, CSRF_COOKIE), session.csrfToken);
    assert.match(sessionCookie, /HttpOnly/i);
    assert.doesNotMatch(csrfCookie, /HttpOnly/i);

    const slid = await sessionRowFor(session.sessionToken);
    assert.ok(
      Date.parse(slid.expires_at) - Date.now() > (ttl * 1000) / 2,
      'the row was extended too',
    );
  });

  it('sets no cookies while more than half the TTL remains', async () => {
    const session = await harness.registerUser({ email: 'fresh@example.test' });
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: session.cookieHeader },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(setCookies(response).size, 0, 'a busy SPA is not re-stamped on every request');
  });
});

describe('email verification', () => {
  let harness: TestApp;
  const issued: { userId: string; token: string | null }[] = [];

  before(async () => {
    harness = await buildTestApp({
      deps: {
        onRegistered: async ({ user, verificationToken }) => {
          issued.push({ userId: user.id, token: verificationToken });
        },
      },
    });
    // The founder bootstraps the platform before the policy is tightened.
    await harness.registerUser({ email: 'boss@example.test', role: 'provider' });
    await harness.store.settings.set(REGISTRATION_SETTINGS_KEY, {
      open_registration: true,
      require_email_verification: true,
      allowed_roles: ['client', 'provider'],
    });
  });

  after(async () => {
    await harness.close();
  });

  it('blocks sign-in until the emailed token is redeemed', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: 'unverified@example.test',
        password: TEST_PASSWORD,
        display_name: 'Unverified',
        role: 'client',
      },
    });
    assert.equal(response.statusCode, 201);
    assert.equal(
      response.json<{ email_verification_required: boolean }>().email_verification_required,
      true,
    );
    assert.equal(cookieValue(response, SESSION_COOKIE), undefined, 'no session until verified');

    const blocked = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'unverified@example.test', password: TEST_PASSWORD },
    });
    assert.equal(blocked.statusCode, 403);
    assert.equal(errorCode(blocked.body), 'EMAIL_NOT_VERIFIED');

    const token = issued.at(-1)?.token;
    assert.ok(token, 'the onRegistered hook receives the plaintext token exactly once');

    const verified = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/verify-email',
      payload: { token },
    });
    assert.equal(verified.statusCode, 200);
    assert.equal(verified.json<{ verified: boolean }>().verified, true);

    const nowAllowed = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'unverified@example.test', password: TEST_PASSWORD },
    });
    assert.equal(nowAllowed.statusCode, 200);
  });

  it('refuses to redeem the same token twice', async () => {
    const token = issued.at(-1)?.token;
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/verify-email',
      payload: { token },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(errorCode(response.body), 'CONFLICT');
  });

  it('refuses an unknown or expired token', async () => {
    const unknown = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/verify-email',
      payload: { token: 'this-token-was-never-issued' },
    });
    assert.equal(unknown.statusCode, 400);
    assert.equal(errorCode(unknown.body), 'VALIDATION_FAILED');

    const user = await harness.store.users.findByEmail('boss@example.test');
    assert.ok(user);
    const expiredToken = 'an-expired-verification-token-value';
    await harness.store.verificationTokens.create({
      user_id: user.id,
      token_hash: harness.app.nexus.crypto.hashToken(expiredToken),
      purpose: 'email_verification',
      expires_at: isoInSeconds(-60),
    });

    const expired = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/verify-email',
      payload: { token: expiredToken },
    });
    assert.equal(expired.statusCode, 400);
    assert.match(expired.body, /expired/);
  });
});

describe('registration policy', () => {
  let harness: TestApp;

  before(async () => {
    harness = await buildTestApp();
    await harness.registerUser({ email: 'owner@example.test' });
  });

  after(async () => {
    await harness.close();
  });

  it('honours closed registration and restricted roles', async () => {
    await harness.store.settings.set(REGISTRATION_SETTINGS_KEY, {
      open_registration: false,
      require_email_verification: false,
      allowed_roles: ['client'],
    });
    const closed = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: 'late@example.test',
        password: TEST_PASSWORD,
        display_name: 'Late',
        role: 'client',
      },
    });
    assert.equal(closed.statusCode, 403);
    assert.equal(errorCode(closed.body), 'FORBIDDEN');

    await harness.store.settings.set(REGISTRATION_SETTINGS_KEY, {
      open_registration: true,
      require_email_verification: false,
      allowed_roles: ['client'],
    });
    const wrongRole = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: 'provider@example.test',
        password: TEST_PASSWORD,
        display_name: 'Provider',
        role: 'provider',
      },
    });
    assert.equal(wrongRole.statusCode, 403);

    const allowed = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: 'client@example.test',
        password: TEST_PASSWORD,
        display_name: 'Client',
        role: 'client',
      },
    });
    assert.equal(allowed.statusCode, 201);
  });
});

describe('bootstrap token', () => {
  let harness: TestApp;

  /** `POST /api/auth/register` with whatever bootstrap field the case needs. */
  function register(
    email: string,
    payload: Record<string, unknown> = {},
  ): Promise<LightMyRequestResponse> {
    return harness.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email,
        password: TEST_PASSWORD,
        display_name: 'Candidate',
        role: 'client',
        ...payload,
      },
    });
  }

  async function brandingRequiresBootstrap(): Promise<boolean> {
    const response = await harness.app.inject({ method: 'GET', url: '/api/branding' });
    assert.equal(response.statusCode, 200);
    return response.json<{ bootstrap_required: boolean }>().bootstrap_required;
  }

  before(async () => {
    harness = await buildTestApp();
  });

  after(async () => {
    await harness.close();
  });

  it('advertises that the empty portal needs bootstrapping', async () => {
    assert.equal(await brandingRequiresBootstrap(), true);
  });

  it('refuses the first registration with no token, writing nothing', async () => {
    const response = await register('drive-by@example.test');

    assert.equal(response.statusCode, 403);
    assert.equal(errorCode(response.body), 'FORBIDDEN');
    assert.match(response.body, /bootstrap token/);
    assert.equal(cookieValue(response, SESSION_COOKIE), undefined, 'no session is issued');

    // The refusal is total: no account, and the election is still unclaimed,
    // so the real operator can still bootstrap afterwards.
    assert.equal(await harness.store.users.count(), 0);
    assert.equal(await harness.store.users.findByEmail('drive-by@example.test'), null);
    assert.equal(await harness.store.settings.get(SUPER_ADMIN_CLAIM_KEY), null);
  });

  it('refuses a wrong token', async () => {
    const wrong = await register('guesser@example.test', {
      bootstrap_token: `${TEST_BOOTSTRAP_TOKEN}x`,
    });
    assert.equal(wrong.statusCode, 403);
    assert.equal(errorCode(wrong.body), 'FORBIDDEN');

    // A prefix of the real token is no closer than any other wrong value.
    const truncated = await register('guesser2@example.test', {
      bootstrap_token: TEST_BOOTSTRAP_TOKEN.slice(0, -1),
    });
    assert.equal(truncated.statusCode, 403);
    assert.equal(await harness.store.users.count(), 0);
  });

  it('accepts the right token and elects a verified super_admin', async () => {
    const response = await register('operator@example.test', {
      bootstrap_token: TEST_BOOTSTRAP_TOKEN,
    });

    assert.equal(response.statusCode, 201, response.body);
    const user = response.json<{ user: { role: string; email_verified: boolean } }>().user;
    assert.equal(user.role, 'super_admin');
    assert.equal(user.email_verified, true);
    assert.ok(cookieValue(response, SESSION_COOKIE), 'the founder lands signed in');
    assert.ok(cookieValue(response, CSRF_COOKIE));
    assert.equal(await brandingRequiresBootstrap(), false, 'the portal is no longer empty');
  });

  it('ignores the field once the portal has an account', async () => {
    const plain = await register('joiner@example.test');
    assert.equal(plain.statusCode, 201, plain.body);
    assert.equal(plain.json<{ user: { role: string } }>().user.role, 'client');

    // Replaying the operator's token buys nothing: the claim is already spent
    // and the token only ever gated the empty-portal path.
    const replay = await register('replayer@example.test', {
      bootstrap_token: TEST_BOOTSTRAP_TOKEN,
    });
    assert.equal(replay.statusCode, 201, replay.body);
    assert.equal(replay.json<{ user: { role: string } }>().user.role, 'client');

    const admins = await harness.store.users.list({ role: 'super_admin' });
    assert.equal(admins.total, 1);
  });
});

describe('bootstrap super_admin election', () => {
  let harness: TestApp;

  before(async () => {
    harness = await buildTestApp();
  });

  after(async () => {
    await harness.close();
  });

  it('promotes exactly one of six concurrent registrations against an empty portal', async () => {
    // Every one of these reads an empty `users` table and then awaits ~100 ms
    // of scrypt before inserting, so all six are inside the old
    // count()-then-create window at the same time.
    // Three uncredentialed callers ride along inside the same window. Building
    // both arrays before the first await is what puts all nine in flight at
    // once; the gatecrashers must bounce whichever of the six wins.
    const inFlight = Array.from({ length: 6 }, (_unused, index) =>
      harness.app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          email: `racer${index}@example.test`,
          password: TEST_PASSWORD,
          display_name: `Racer ${index}`,
          role: 'client',
          // Every racer holds the operator's token, so the token is not what
          // separates them — the atomic claim is.
          bootstrap_token: TEST_BOOTSTRAP_TOKEN,
        },
      }),
    );
    const gatecrashing = Array.from({ length: 3 }, (_unused, index) =>
      harness.app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          email: `gatecrasher${index}@example.test`,
          password: TEST_PASSWORD,
          display_name: `Gatecrasher ${index}`,
          role: 'client',
          ...(index === 0 ? {} : { bootstrap_token: `wrong-token-${index}-padded-out` }),
        },
      }),
    );
    const [responses, gatecrashers] = await Promise.all([
      Promise.all(inFlight),
      Promise.all(gatecrashing),
    ]);

    for (const response of gatecrashers) {
      assert.equal(response.statusCode, 403, response.body);
      assert.equal(errorCode(response.body), 'FORBIDDEN');
    }

    for (const response of responses) assert.equal(response.statusCode, 201, response.body);
    const users = responses.map(
      (response) =>
        response.json<{ user: { id: string; role: string; email_verified: boolean } }>().user,
    );

    const founders = users.filter((user) => user.role === 'super_admin');
    assert.equal(
      founders.length,
      1,
      `exactly one racer may be promoted, got ${founders.length}: ${users.map((user) => user.role).join(', ')}`,
    );
    for (const loser of users.filter((user) => user.role !== 'super_admin')) {
      assert.equal(loser.role, 'client', 'losers keep the role they asked for');
    }

    // The election is visible in storage, not just in the responses.
    const stored = await harness.store.users.list({ role: 'super_admin' });
    assert.equal(stored.total, 1);
    assert.equal(stored.items[0]?.id, founders[0]?.id);

    const claim = await harness.store.settings.get(SUPER_ADMIN_CLAIM_KEY);
    assert.deepEqual((claim?.value as { user_id: string }).user_id, founders[0]?.id);
    assert.equal(founders[0]?.email_verified, true, 'the founder is auto-verified');

    // A later registration finds the key taken and stays a client.
    const late = await harness.registerUser({ email: 'late-racer@example.test' });
    assert.equal(late.user.role, 'client');
  });
});
