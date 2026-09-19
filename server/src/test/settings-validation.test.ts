/** Settings validation must reject the whole patch before any service effects. */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type {
  AdminSettingsResponse,
  ApiErrorBody,
  UpdateSettingsRequest,
} from '@ferrum-nexus/shared';

import {
  buildTestApp,
  TEST_CAPTCHA_TOKEN,
  testCaptchaTransport,
  type TestApp,
  type TestSession,
} from './helpers.js';

describe('strict settings route validation', () => {
  let harness: TestApp;
  let founder: TestSession;
  let client: TestSession;
  let captchaCalls = 0;

  const initial: UpdateSettingsRequest = {
    branding: {
      portal_name: 'Original portal',
      primary_color: '#123456',
      tagline: 'Original tagline',
      footer_links: [{ label: 'Help', url: 'https://example.test/help' }],
    },
    captcha: {
      enabled: false,
      provider: 'turnstile',
      site_key: 'original-site',
      secret_key: 'original-captcha-secret',
    },
    smtp: {
      host: 'smtp.example.test',
      port: 2525,
      secure: false,
      username: 'mailer',
      password: 'original-smtp-password',
      from_address: 'original@example.test',
    },
    registration: {
      open_registration: true,
      require_email_verification: false,
      allowed_roles: ['client', 'provider'],
    },
    gateway: { public_url: 'https://gateway.example.test' },
  };

  before(async () => {
    harness = await buildTestApp({
      deps: {
        captchaTransport: async (url, params) => {
          captchaCalls += 1;
          return testCaptchaTransport(url, params);
        },
      },
    });
    founder = await harness.registerUser();
    client = await harness.registerUser();
    const response = await harness.authed(founder, {
      method: 'PUT',
      url: '/api/admin/settings',
      payload: initial,
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(captchaCalls, 0);
  });

  after(async () => {
    await harness.close();
  });

  const invalidPatches = [
    { payload: { bogus_section: { x: 1 } }, paths: ['bogus_section'] },
    { payload: { portal_name: 'Flat name' }, paths: ['portal_name'] },
    {
      payload: { branding: { portal_name: 'Changed', portal_nam: 'Typo', other: {} } },
      paths: ['branding.portal_nam', 'branding.other'],
    },
    { payload: { captcha: { enable: true } }, paths: ['captcha.enable'] },
    { payload: { smtp: { hostname: 'smtp.other.test' } }, paths: ['smtp.hostname'] },
    { payload: { registration: { open: false } }, paths: ['registration.open'] },
    { payload: { gateway: { url: 'https://other.test' } }, paths: ['gateway.url'] },
    {
      payload: {
        branding: {
          footer_links: [
            { label: 'Valid', url: 'https://example.test' },
            { label: 'Help', url: 'https://example.test/help', target: { name: '_blank' } },
          ],
        },
      },
      paths: ['branding.footer_links.1.target'],
    },
    {
      payload: {
        captcha: { secret_set: true, enforcement: 'disabled' },
        smtp: { password_set: true, password_source: 'environment' },
      },
      paths: [
        'captcha.secret_set',
        'captcha.enforcement',
        'smtp.password_set',
        'smtp.password_source',
      ],
    },
    {
      payload: {
        branding: { portal_name: 'Must not save' },
        captcha: {
          enabled: true,
          secret_key: 'replacement-captcha-secret',
          captcha_token: TEST_CAPTCHA_TOKEN,
        },
        smtp: { password: 'replacement-smtp-password' },
        registration: { open_registration: false },
        gateway: { public_url: 'https://replacement.test', extra: {} },
      },
      paths: ['gateway.extra'],
    },
  ];

  for (const { payload, paths } of invalidPatches) {
    it(`rejects ${paths.join(', ')} without writes, audit or CAPTCHA verification`, async () => {
      const settingsBefore = await harness.store.settings.all();
      const auditBefore = await harness.auditRows();
      const response = await harness.authed(founder, {
        method: 'PUT',
        url: '/api/admin/settings',
        payload,
      });
      assert.equal(response.statusCode, 400, response.body);
      const error = response.json<ApiErrorBody>().error;
      assert.equal(error.code, 'VALIDATION_FAILED');
      const details = error.details as { path: string; code: string; message: string }[];
      assert.ok(Array.isArray(details), response.body);
      assert.deepEqual(
        details.map((issue) => issue.path).sort(),
        [...paths].sort(),
      );
      assert.ok(details.every((issue) => issue.code === 'unrecognized_keys' && issue.message));
      assert.deepEqual(await harness.store.settings.all(), settingsBefore);
      assert.deepEqual(await harness.auditRows(), auditBefore);
      assert.equal(captchaCalls, 0, 'invalid input never reaches the activation self-test');
      assert.ok(!response.body.includes('replacement-captcha-secret'));
      assert.ok(!response.body.includes('replacement-smtp-password'));
    });
  }

  it('still validates known fields in every section before saving any sibling', async () => {
    const settingsBefore = await harness.store.settings.all();
    const auditBefore = await harness.auditRows();
    const response = await harness.authed(founder, {
      method: 'PUT',
      url: '/api/admin/settings',
      payload: {
        branding: { portal_name: 'Must not save', footer_links: [{ label: 'Missing URL' }] },
        captcha: { enabled: 'true' },
        smtp: { port: 0 },
        registration: { allowed_roles: [{ role: 'client' }] },
        gateway: { public_url: { origin: 'https://example.test' } },
      },
    });
    assert.equal(response.statusCode, 400, response.body);
    const error = response.json<ApiErrorBody>().error;
    assert.equal(error.code, 'VALIDATION_FAILED');
    const details = error.details as { path: string }[];
    assert.deepEqual(
      details.map((issue) => issue.path).sort(),
      [
        'branding.footer_links.0.url',
        'captcha.enabled',
        'smtp.port',
        'registration.allowed_roles.0',
        'gateway.public_url',
      ].sort(),
    );
    assert.deepEqual(await harness.store.settings.all(), settingsBefore);
    assert.deepEqual(await harness.auditRows(), auditBefore);
  });

  it('keeps the session, role and CSRF guards ahead of settings writes', async () => {
    const settingsBefore = await harness.store.settings.all();
    const auditBefore = await harness.auditRows();
    const payload: UpdateSettingsRequest = { branding: { portal_name: 'Forbidden' } };
    const anonymous = await harness.app.inject({
      method: 'PUT',
      url: '/api/admin/settings',
      payload,
    });
    assert.equal(anonymous.statusCode, 401, anonymous.body);
    const forbidden = await harness.authed(client, {
      method: 'PUT',
      url: '/api/admin/settings',
      payload,
    });
    assert.equal(forbidden.statusCode, 403, forbidden.body);
    assert.equal(forbidden.json<ApiErrorBody>().error.code, 'FORBIDDEN');
    const noCsrf = await harness.app.inject({
      method: 'PUT',
      url: '/api/admin/settings',
      headers: { cookie: founder.cookieHeader },
      payload,
    });
    assert.equal(noCsrf.statusCode, 403, noCsrf.body);
    assert.equal(noCsrf.json<ApiErrorBody>().error.code, 'CSRF_MISMATCH');
    assert.deepEqual(await harness.store.settings.all(), settingsBefore);
    assert.deepEqual(await harness.auditRows(), auditBefore);
  });

  it('preserves omitted fields and secrets in valid partial edits', async () => {
    const before = await harness.services.settings.getAdminSettings();
    const secretRows = await harness.store.settings.getMany([
      'smtp.password',
      'captcha.secret_key',
    ]);
    const auditCount = await harness.store.auditLogs.count({ action: 'admin.settings_update' });
    const patch: UpdateSettingsRequest = {
      branding: { portal_name: 'Updated portal' },
      captcha: { site_key: 'updated-site' },
      smtp: { from_address: 'updated@example.test' },
      registration: { open_registration: false },
      gateway: { public_url: 'https://updated.example.test/' },
    };
    const response = await harness.authed(founder, {
      method: 'PUT',
      url: '/api/admin/settings',
      payload: patch,
    });
    assert.equal(response.statusCode, 200, response.body);
    const settings = response.json<AdminSettingsResponse>();
    assert.deepEqual(settings, {
      branding: { ...before.branding, ...patch.branding },
      captcha: { ...before.captcha, ...patch.captcha },
      smtp: { ...before.smtp, ...patch.smtp },
      registration: { ...before.registration, ...patch.registration },
      gateway: { public_url: 'https://updated.example.test' },
    });
    assert.equal(settings.smtp.password_set, true);
    assert.equal(settings.captcha.secret_set, true);
    assert.ok(!response.body.includes('original-smtp-password'));
    assert.ok(!response.body.includes('original-captcha-secret'));
    assert.deepEqual(
      await harness.store.settings.getMany(['smtp.password', 'captcha.secret_key']),
      secretRows,
    );
    const audit = await harness.store.auditLogs.list({ action: 'admin.settings_update' });
    assert.equal(audit.total, auditCount + 1);
    const changed = audit.items.find((row) => {
      const details = row.details as { changed_keys: string[] };
      return (
        details.changed_keys.includes('smtp.from_address') && details.changed_keys.length === 5
      );
    });
    assert.ok(changed, 'one audit row names exactly the supplied fields');
    assert.deepEqual((changed.details as { changed_keys: string[] }).changed_keys.sort(), [
      'branding.portal_name',
      'captcha.site_key',
      'gateway.public_url',
      'registration.open_registration',
      'smtp.from_address',
    ]);

    const singleSection = await harness.authed(founder, {
      method: 'PUT',
      url: '/api/admin/settings',
      payload: { branding: { tagline: null } } satisfies UpdateSettingsRequest,
    });
    assert.equal(singleSection.statusCode, 200, singleSection.body);
    assert.deepEqual(singleSection.json<AdminSettingsResponse>(), {
      ...settings,
      branding: { ...settings.branding, tagline: null },
    });
  });
});
