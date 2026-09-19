/**
 * `NEXUS_CAPTCHA_ENFORCEMENT` — the operator's break-glass switch.
 *
 * CAPTCHA is configured from the admin UI and fails closed, so a wrong site
 * key, a secret that no longer decrypts or an unreachable vendor refuses every
 * password login, the enabling super admin's included. Recovery used to mean
 * editing the `app_settings` row by hand (ferrum-nexus#252).
 *
 * `disabled` makes register and login skip verification and hides the widget,
 * **without touching a stored setting**, so an operator with host access signs
 * in, fixes the configuration and puts the variable back. What it must not do
 * is hide itself: the state is reported to super admins on
 * `GET /api/admin/settings` and every session it lets through is audited with
 * `captcha_bypassed: true`.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type {
  AdminSettingsResponse,
  ApiErrorBody,
  CaptchaConfigResponse,
} from '@ferrum-nexus/shared';

import { buildTestApp, TEST_PASSWORD, type TestApp, type TestSession } from './helpers.js';

/** A stored configuration whose vendor answers nothing — the lockout in #252. */
const BROKEN_CAPTCHA = { enabled: true, provider: 'turnstile', site_key: 'public-site' };

/** Seed `app_settings` directly: the point is a portal already holding a bad block. */
async function seedBrokenCaptcha(harness: TestApp): Promise<void> {
  await harness.store.settings.set('captcha', BROKEN_CAPTCHA, false);
  await harness.store.settings.set('captcha.secret_key', 'stored-secret', false);
}

describe('CAPTCHA enforcement disabled (break-glass)', () => {
  let harness: TestApp;
  let founder: TestSession;
  let vendorCalls: number;

  before(async () => {
    harness = await buildTestApp({
      env: { NEXUS_CAPTCHA_ENFORCEMENT: 'disabled' },
      deps: {
        captchaTransport: async () => {
          vendorCalls += 1;
          return { success: true, errors: [] };
        },
      },
    });
    // Seated before the bad block exists, exactly as the locked-out operator
    // was: the account is fine, the challenge in front of it is not.
    founder = await harness.registerUser();
    vendorCalls = 0;
    await seedBrokenCaptcha(harness);
  });
  after(async () => {
    await harness.close();
  });

  it('lets an existing account sign in without a token, and says so in the audit', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: founder.user.email, password: TEST_PASSWORD },
    });
    assert.equal(response.statusCode, 200, response.body);
    const logins = await harness.auditRows('auth.login');
    assert.equal(logins[0]?.details.captcha_bypassed, true);
    // Nothing was asked of a vendor that is the reason the portal is stuck.
    assert.equal(vendorCalls, 0);
  });

  it('lets a registration through, and says so in the audit', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: 'break-glass@example.test',
        password: TEST_PASSWORD,
        display_name: 'Break Glass',
        role: 'client',
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    const registrations = await harness.auditRows('auth.register');
    assert.equal(registrations[0]?.details.captcha_bypassed, true);
    assert.equal(vendorCalls, 0);
  });

  it('hides the widget, so the sign-in form cannot wait on a broken script', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/api/auth/captcha' });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json<CaptchaConfigResponse>().enabled, false);
    assert.equal(response.json<CaptchaConfigResponse>().site_key, null);
    assert.equal(await harness.services.captcha.isEnabled(), false);
  });

  it('reports itself to an administrator instead of looking like a bug', async () => {
    const response = await harness.authed(founder, { method: 'GET', url: '/api/admin/settings' });
    assert.equal(response.statusCode, 200, response.body);
    const captcha = response.json<AdminSettingsResponse>().captcha;
    // The stored block is untouched; only the enforcement of it is off.
    assert.equal(captcha.enabled, true);
    assert.equal(captcha.provider, 'turnstile');
    assert.equal(captcha.enforcement, 'disabled');
    const stored = await harness.store.settings.get('captcha');
    assert.deepEqual(stored?.value, BROKEN_CAPTCHA);
  });

  it('cannot be switched from the API', async () => {
    const settingsBefore = await harness.store.settings.all();
    const auditBefore = await harness.auditRows('admin.settings_update');
    const response = await harness.authed(founder, {
      method: 'PUT',
      url: '/api/admin/settings',
      // Enforcement is an operator-only setting, rejected by the strict schema.
      payload: { captcha: { enforcement: 'enforced' } },
    });
    assert.equal(response.statusCode, 400, response.body);
    const error = response.json<ApiErrorBody>().error;
    assert.equal(error.code, 'VALIDATION_FAILED');
    assert.deepEqual(
      (error.details as { path: string; code: string }[]).map(({ path, code }) => ({ path, code })),
      [{ path: 'captcha.enforcement', code: 'unrecognized_keys' }],
    );
    assert.deepEqual(await harness.store.settings.all(), settingsBefore);
    assert.deepEqual(await harness.auditRows('admin.settings_update'), auditBefore);
    assert.equal(vendorCalls, 0);
    const current = await harness.authed(founder, { method: 'GET', url: '/api/admin/settings' });
    assert.equal(current.statusCode, 200, current.body);
    assert.equal(current.json<AdminSettingsResponse>().captcha.enforcement, 'disabled');
  });

  it('still makes a repaired configuration prove itself before it is stored', async () => {
    const refused = await harness.authed(founder, {
      method: 'PUT',
      url: '/api/admin/settings',
      payload: { captcha: { site_key: 'repaired-site', secret_key: 'repaired-secret' } },
    });
    assert.equal(refused.statusCode, 400, refused.body);
    assert.equal(refused.json<ApiErrorBody>().error.code, 'CAPTCHA_SELF_TEST_FAILED');

    const accepted = await harness.authed(founder, {
      method: 'PUT',
      url: '/api/admin/settings',
      payload: {
        captcha: {
          site_key: 'repaired-site',
          secret_key: 'repaired-secret',
          captcha_token: 'solved-from-the-settings-page',
        },
      },
    });
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal(vendorCalls, 1);
  });
});

describe('CAPTCHA enforcement left at its default', () => {
  let harness: TestApp;
  let founder: TestSession;

  before(async () => {
    harness = await buildTestApp();
    founder = await harness.registerUser();
    // One ordinary sign-in before the bad block exists, so the audit assertion
    // below has a real row to look at rather than an empty list.
    await harness.loginUser(founder.user.email);
    await seedBrokenCaptcha(harness);
  });
  after(async () => {
    await harness.close();
  });

  it('still refuses a login carrying no token', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: founder.user.email, password: TEST_PASSWORD },
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json<ApiErrorBody>().error.code, 'CAPTCHA_FAILED');
  });

  it('still refuses a registration carrying no token', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: 'blocked@example.test',
        password: TEST_PASSWORD,
        display_name: 'Blocked',
        role: 'client',
      },
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json<ApiErrorBody>().error.code, 'CAPTCHA_FAILED');
  });

  it('marks no session as bypassed and reports enforcement to an administrator', async () => {
    const response = await harness.authed(founder, { method: 'GET', url: '/api/admin/settings' });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json<AdminSettingsResponse>().captcha.enforcement, 'enforced');
    const logins = await harness.auditRows('auth.login');
    assert.ok(logins.length > 0, 'the ordinary sign-in was audited');
    for (const row of logins) assert.equal(row.details.captcha_bypassed, undefined);
  });
});
