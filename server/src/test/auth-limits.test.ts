/** Exercise the production limiter scopes through the real Fastify routes. */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { ApiErrorBody, MeResponse } from '@ferrum-nexus/shared';

import { buildTestApp, TEST_PASSWORD, type TestApp } from './helpers.js';

const SENSITIVE_ROUTES = [
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/forgot-password',
  '/api/auth/reset-password',
  '/api/auth/verify-email',
  '/api/auth/resend-verification',
];

describe('auth rate-limit scopes', () => {
  let harness: TestApp;

  beforeEach(async () => {
    harness = await buildTestApp({
      env: { NEXUS_ENV: 'development', NEXUS_RATE_LIMIT_ENABLED: 'true' },
      deps: { startOutboxWorker: false },
    });
  });

  afterEach(async () => {
    await harness.close();
  });

  it('allows registration and login after repeated bootstrap reads', async () => {
    const founder = await harness.registerUser();
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const captcha = await harness.app.inject({
        method: 'GET',
        url: '/api/auth/captcha?bootstrap=true',
      });
      assert.equal(captcha.statusCode, 200, captcha.body);
      const anonymous = await harness.app.inject({ method: 'GET', url: '/api/auth/me' });
      assert.equal(anonymous.statusCode, 401, anonymous.body);
      const me = await harness.authed(founder, { method: 'GET', url: '/api/auth/me' });
      assert.equal(me.statusCode, 200, me.body);
      assert.equal(me.json<MeResponse>().user.id, founder.user.id);
    }

    const newcomer = await harness.registerUser();
    const login = await harness.loginUser(newcomer.user.email);
    assert.equal(login.user.id, newcomer.user.id);
  });

  it('shares the strict allowance across sensitive routes while preserving reads', async () => {
    const founder = await harness.registerUser();
    const remoteAddress = '198.51.100.10';
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress,
        payload: { email: founder.user.email, password: 'wrong-password' },
      });
      assert.equal(response.statusCode, 401, response.body);
    }

    for (const url of [...SENSITIVE_ROUTES, '/api/auth/logout']) {
      const response = await harness.authed(founder, {
        method: 'POST',
        url,
        remoteAddress,
        payload: {},
      });
      assert.equal(response.statusCode, 429, url);
      assert.equal(response.json<ApiErrorBody>().error.code, 'RATE_LIMITED');
    }
    for (const url of ['/api/auth/me', '/api/auth/captcha']) {
      const response = await harness.authed(founder, { method: 'GET', url, remoteAddress });
      assert.equal(response.statusCode, 200, response.body);
    }
    const peer = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '198.51.100.11',
      payload: { email: founder.user.email, password: TEST_PASSWORD },
    });
    assert.equal(peer.statusCode, 200, peer.body);
  });

  for (const [index, url] of SENSITIVE_ROUTES.entries()) {
    it(`counts rejected attempts at ${url} against the shared strict budget`, async () => {
      const remoteAddress = `198.51.100.${index + 20}`;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const response = await harness.app.inject({
          method: 'POST',
          url,
          remoteAddress,
          payload: {},
        });
        assert.equal(response.statusCode, 400, response.body);
        assert.equal(response.json<ApiErrorBody>().error.code, 'VALIDATION_FAILED');
      }
      // Switching to another sensitive endpoint must not create a new budget.
      const limited = await harness.app.inject({
        method: 'POST',
        url: url === '/api/auth/login' ? '/api/auth/register' : '/api/auth/login',
        remoteAddress,
        payload: {},
      });
      assert.equal(limited.statusCode, 429, limited.body);
      assert.equal(limited.json<ApiErrorBody>().error.code, 'RATE_LIMITED');
    });
  }

  it('bounds bootstrap reads separately and ignores untrusted forwarded headers', async () => {
    const founder = await harness.registerUser();
    const remoteAddress = '198.51.100.30';
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const response = await harness.authed(founder, {
        method: 'GET',
        url: attempt % 2 === 0 ? '/api/auth/me' : '/api/auth/captcha',
        remoteAddress,
        headers: { 'x-forwarded-for': `203.0.113.${attempt + 1}` },
      });
      assert.equal(response.statusCode, 200, response.body);
    }
    for (const url of ['/api/auth/me', '/api/auth/captcha']) {
      const limited = await harness.authed(founder, { method: 'GET', url, remoteAddress });
      assert.equal(limited.statusCode, 429, limited.body);
      assert.equal(limited.json<ApiErrorBody>().error.code, 'RATE_LIMITED');
      const peer = await harness.authed(founder, {
        method: 'GET',
        url,
        remoteAddress: '198.51.100.31',
      });
      assert.equal(peer.statusCode, 200, peer.body);
    }
    const login = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress,
      payload: { email: founder.user.email, password: TEST_PASSWORD },
    });
    assert.equal(login.statusCode, 200, login.body);
    for (const url of ['/api/branding', '/api/health']) {
      const response = await harness.app.inject({ method: 'GET', url, remoteAddress });
      assert.equal(response.statusCode, 200, response.body);
    }
  });

  it('bounds current-password checks on PATCH /api/users/me per account', async () => {
    // Issue #333: the self-service change checks `current_password`, and sat
    // outside every limiter, so a stolen session could guess it unthrottled.
    const founder = await harness.registerUser();
    const guesser = await harness.registerUser();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await harness.authed(guesser, {
        method: 'PATCH',
        url: '/api/users/me',
        // Rotating source addresses must not buy a fresh allowance.
        remoteAddress: `198.51.100.${attempt + 50}`,
        payload: { current_password: `guess-${attempt}`, new_password: 'a-new-password-1' },
      });
      assert.equal(response.statusCode, 403, response.body);
      assert.equal(response.json<ApiErrorBody>().error.code, 'FORBIDDEN');
    }
    // The right password is refused too once the budget is spent: the limit
    // is what stops the guessing, not a lockout after a hit.
    const limited = await harness.authed(guesser, {
      method: 'PATCH',
      url: '/api/users/me',
      payload: { current_password: TEST_PASSWORD, new_password: 'a-new-password-1' },
    });
    assert.equal(limited.statusCode, 429, limited.body);
    assert.equal(limited.json<ApiErrorBody>().error.code, 'RATE_LIMITED');

    // Reads on the same scope stay unthrottled, and another account keeps its
    // own budget.
    const me = await harness.authed(guesser, { method: 'GET', url: '/api/users/me' });
    assert.equal(me.statusCode, 200, me.body);
    const other = await harness.authed(founder, {
      method: 'PATCH',
      url: '/api/users/me',
      payload: { display_name: 'Founder' },
    });
    assert.equal(other.statusCode, 200, other.body);
  });
});

it('uses the trusted proxy client for the shared bootstrap budget', async () => {
  const harness = await buildTestApp({
    env: {
      NEXUS_ENV: 'development',
      NEXUS_RATE_LIMIT_ENABLED: 'true',
      NEXUS_TRUSTED_PROXIES: 'loopback',
    },
    deps: { startOutboxWorker: false },
  });
  try {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/auth/captcha',
        headers: { 'x-forwarded-for': `203.0.113.${attempt + 1}, 198.51.100.40` },
      });
      assert.equal(response.statusCode, 200, response.body);
    }
    const limited = await harness.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { 'x-forwarded-for': '203.0.113.200, 198.51.100.40' },
    });
    assert.equal(limited.statusCode, 429, limited.body);
    assert.equal(limited.json<ApiErrorBody>().error.code, 'RATE_LIMITED');
    const peer = await harness.app.inject({
      method: 'GET',
      url: '/api/auth/captcha',
      headers: { 'x-forwarded-for': '203.0.113.200, 198.51.100.41' },
    });
    assert.equal(peer.statusCode, 200, peer.body);
  } finally {
    await harness.close();
  }
});

for (const env of [
  { NEXUS_ENV: 'development', NEXUS_RATE_LIMIT_ENABLED: 'false' },
  { NEXUS_ENV: 'test', NEXUS_RATE_LIMIT_ENABLED: 'true' },
]) {
  it(`disables both auth budgets for ${JSON.stringify(env)}`, async () => {
    const harness = await buildTestApp({ env, deps: { startOutboxWorker: false } });
    try {
      for (let attempt = 0; attempt < 125; attempt += 1) {
        for (const url of ['/api/auth/me', '/api/auth/captcha']) {
          const response = await harness.app.inject({ method: 'GET', url });
          assert.equal(response.statusCode, url.endsWith('/me') ? 401 : 200, response.body);
        }
      }
      for (let attempt = 0; attempt < 25; attempt += 1) {
        const response = await harness.app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: {},
        });
        assert.equal(response.statusCode, 400, response.body);
      }
      const founder = await harness.registerUser();
      assert.equal((await harness.loginUser(founder.user.email)).user.id, founder.user.id);
    } finally {
      await harness.close();
    }
  });
}
