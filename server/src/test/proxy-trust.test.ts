/**
 * `NEXUS_TRUSTED_PROXIES` and `NEXUS_COOKIE_SECURE`.
 *
 * Two settings that used to be one. Trusting every proxy makes `request.ip`
 * the left-most `X-Forwarded-For` entry — a value the client writes, because
 * proxies *append* — and that value keys both the `/api/auth/*` rate limiter
 * and every audit row. Marking cookies `Secure` is a statement about TLS and
 * has nothing to do with it.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { CSRF_COOKIE, SESSION_COOKIE } from '@ferrum-nexus/shared';

import { buildTestApp, TEST_BOOTSTRAP_TOKEN, TEST_PASSWORD, type TestApp } from './helpers.js';

/** Raw `Set-Cookie` headers of a response, as strings. */
function setCookies(headers: Record<string, unknown>): string[] {
  const raw = headers['set-cookie'];
  if (Array.isArray(raw)) return raw.map(String);
  return raw === undefined ? [] : [String(raw)];
}

/** The `Set-Cookie` line for one cookie name. */
function cookieHeaderFor(headers: Record<string, unknown>, name: string): string {
  const line = setCookies(headers).find((cookie) => cookie.startsWith(`${name}=`));
  assert.ok(line, `expected a Set-Cookie for ${name}`);
  return line;
}

describe('proxy trust', () => {
  describe('with no trusted proxies configured (the default)', () => {
    let harness: TestApp;

    before(async () => {
      harness = await buildTestApp();
    });

    after(async () => {
      await harness.close();
    });

    it('records the socket address in the audit trail, not a forged header', async () => {
      const account = await harness.registerUser({ email: 'xff-audit@example.test' });

      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'xff-audit@example.test', password: TEST_PASSWORD },
        headers: { 'x-forwarded-for': '203.0.113.7, 198.51.100.4' },
        remoteAddress: '127.0.0.1',
      });
      assert.equal(response.statusCode, 200, response.body);

      const login = (await harness.auditRows('auth.login')).find(
        (row) => row.actor_user_id === account.user.id,
      );
      assert.equal(
        login?.ip,
        '127.0.0.1',
        'an unconfigured deployment must never take the client’s word for its own address',
      );

      // The session row it wrote agrees.
      const sessions = await harness.store.sessions.findByTokenHash(
        harness.app.nexus.crypto.hashToken(
          (response.cookies as { name: string; value: string }[]).find(
            (cookie) => cookie.name === SESSION_COOKIE,
          )?.value ?? '',
        ),
      );
      assert.equal(sessions?.ip, '127.0.0.1');
    });
  });

  describe('rate limiting', () => {
    let harness: TestApp;

    before(async () => {
      // The limiter is forced off under NEXUS_ENV=test, so this app runs as a
      // development one with it explicitly on.
      harness = await buildTestApp({
        env: { NEXUS_ENV: 'development', NEXUS_RATE_LIMIT_ENABLED: 'true' },
        deps: { startOutboxWorker: false },
      });
    });

    after(async () => {
      await harness.close();
    });

    it('cannot be evaded by rotating X-Forwarded-For', async () => {
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 25; attempt += 1) {
        const response = await harness.app.inject({
          method: 'GET',
          url: '/api/auth/captcha',
          headers: { 'x-forwarded-for': `203.0.113.${attempt}` },
        });
        statuses.push(response.statusCode);
      }
      assert.ok(
        statuses.includes(429),
        `a rotating X-Forwarded-For must not mint a fresh bucket per request: ${statuses.join(',')}`,
      );
      assert.equal(
        statuses.filter((status) => status === 200).length,
        20,
        'the limit is 20/minute',
      );
    });
  });

  describe('with a trusted proxy allowlist', () => {
    let harness: TestApp;

    before(async () => {
      harness = await buildTestApp({
        env: {
          NEXUS_ENV: 'development',
          NEXUS_RATE_LIMIT_ENABLED: 'true',
          // `app.inject` presents 127.0.0.1 as the peer.
          NEXUS_TRUSTED_PROXIES: 'loopback',
        },
        deps: { startOutboxWorker: false },
      });
    });

    after(async () => {
      await harness.close();
    });

    it('reads the address the trusted proxy recorded, not the left-most entry', async () => {
      const account = await harness.registerUser({ email: 'xff-trusted@example.test' });
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'xff-trusted@example.test', password: TEST_PASSWORD },
        headers: { 'x-forwarded-for': '203.0.113.7, 198.51.100.4' },
      });
      assert.equal(response.statusCode, 200, response.body);

      const login = (await harness.auditRows('auth.login')).find(
        (row) => row.actor_user_id === account.user.id,
      );
      assert.equal(
        login?.ip,
        '198.51.100.4',
        'one trusted hop means the right-most entry, which the client cannot choose',
      );
    });

    it('gives each forwarded client its own rate-limit bucket', async () => {
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 25; attempt += 1) {
        const response = await harness.app.inject({
          method: 'GET',
          url: '/api/auth/captcha',
          // A different real client each time, as the proxy saw it — with the
          // same forged left-most entry throughout.
          headers: { 'x-forwarded-for': `203.0.113.9, 198.51.100.${attempt}` },
        });
        statuses.push(response.statusCode);
      }
      assert.ok(!statuses.includes(429), 'distinct real clients are not one another’s neighbours');
    });
  });

  describe('with the deprecated NEXUS_TRUST_PROXY=true alias', () => {
    let harness: TestApp;

    before(async () => {
      harness = await buildTestApp({
        env: {
          NEXUS_ENV: 'development',
          NEXUS_RATE_LIMIT_ENABLED: 'true',
          NEXUS_TRUST_PROXY: 'true',
        },
        deps: { startOutboxWorker: false },
      });
    });

    after(async () => {
      await harness.close();
    });

    it('still honours X-Forwarded-For, one hop in', async () => {
      assert.equal(harness.config.trustedProxies, 1, 'the alias means exactly one hop');

      const account = await harness.registerUser({ email: 'xff-alias@example.test' });
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'xff-alias@example.test', password: TEST_PASSWORD },
        // What a real deployment sees: the client wrote the first entry, the
        // proxy appended the address it actually connected from.
        headers: { 'x-forwarded-for': '203.0.113.7, 198.51.100.4' },
      });
      assert.equal(response.statusCode, 200, response.body);

      const login = (await harness.auditRows('auth.login')).find(
        (row) => row.actor_user_id === account.user.id,
      );
      assert.equal(
        login?.ip,
        '198.51.100.4',
        'the left-most entry is the client’s own text and must never be recorded as their address',
      );
    });

    it('does not let a client mint a fresh rate-limit bucket per request', async () => {
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 25; attempt += 1) {
        const response = await harness.app.inject({
          method: 'GET',
          url: '/api/auth/captcha',
          // One real client (right-most, written by the proxy) rotating the
          // part of the header it controls.
          headers: { 'x-forwarded-for': `203.0.113.${attempt}, 198.51.100.4` },
        });
        statuses.push(response.statusCode);
      }
      assert.ok(
        statuses.includes(429),
        `the forged left-most entry must not key the limiter: ${statuses.join(',')}`,
      );
    });
  });
});

describe('cookie policy', () => {
  it('marks the session cookies Secure by default', async () => {
    const harness = await buildTestApp();
    try {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          email: 'cookie-secure@example.test',
          password: TEST_PASSWORD,
          display_name: 'Cookie',
          role: 'client',
          // A fresh harness, so this is the portal's bootstrap registration.
          bootstrap_token: TEST_BOOTSTRAP_TOKEN,
        },
      });
      assert.equal(response.statusCode, 201, response.body);

      const session = cookieHeaderFor(response.headers, SESSION_COOKIE);
      const csrf = cookieHeaderFor(response.headers, CSRF_COOKIE);
      assert.match(session, /; Secure/);
      assert.match(session, /; HttpOnly/);
      assert.match(csrf, /; Secure/);
      assert.ok(!/HttpOnly/.test(csrf), 'the double-submit token has to be readable');
    } finally {
      await harness.close();
    }
  });

  it('omits Secure in development, where the portal is served over plain http', async () => {
    const harness = await buildTestApp({
      env: { NEXUS_ENV: 'development', NEXUS_RATE_LIMIT_ENABLED: 'false' },
      deps: { startOutboxWorker: false },
    });
    try {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          email: 'cookie-dev@example.test',
          password: TEST_PASSWORD,
          display_name: 'Cookie',
          role: 'client',
          // A fresh harness, so this is the portal's bootstrap registration.
          bootstrap_token: TEST_BOOTSTRAP_TOKEN,
        },
      });
      assert.equal(response.statusCode, 201, response.body);
      assert.ok(!/; Secure/.test(cookieHeaderFor(response.headers, SESSION_COOKIE)));
      assert.ok(!/; Secure/.test(cookieHeaderFor(response.headers, CSRF_COOKIE)));
    } finally {
      await harness.close();
    }
  });

  it('keeps Secure and HSTS tied to NEXUS_COOKIE_SECURE, not to proxy trust', async () => {
    const harness = await buildTestApp({
      env: {
        NEXUS_ENV: 'development',
        NEXUS_COOKIE_SECURE: 'true',
        NEXUS_RATE_LIMIT_ENABLED: 'false',
      },
      deps: { startOutboxWorker: false },
    });
    try {
      assert.equal(harness.config.trustedProxies, false, 'no proxy is trusted here');
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          email: 'cookie-split@example.test',
          password: TEST_PASSWORD,
          display_name: 'Cookie',
          role: 'client',
          // A fresh harness, so this is the portal's bootstrap registration.
          bootstrap_token: TEST_BOOTSTRAP_TOKEN,
        },
      });
      assert.equal(response.statusCode, 201, response.body);
      assert.match(cookieHeaderFor(response.headers, SESSION_COOKIE), /; Secure/);
      assert.match(
        String(response.headers['strict-transport-security'] ?? ''),
        /max-age=31536000/,
        'HSTS follows the cookie decision',
      );
    } finally {
      await harness.close();
    }
  });
});
