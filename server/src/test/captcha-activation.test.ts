import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import type { UpdateSettingsRequest } from '@ferrum-nexus/shared';

import { buildTestApp, type TestApp, type TestSession } from './helpers.js';

const complete = {
  enabled: true,
  provider: 'turnstile' as const,
  site_key: 'public-site',
  secret_key: 'private-captcha',
};

describe('CAPTCHA activation admission', () => {
  let harness: TestApp;
  let founder: TestSession;
  let verified: number;

  before(async () => {
    harness = await buildTestApp({
      deps: {
        captchaTransport: async () => {
          verified += 1;
          return { success: true, errors: [] };
        },
      },
    });
    founder = await harness.registerUser();
  });
  beforeEach(async () => {
    verified = 0;
    await harness.store.settings.delete('captcha');
    await harness.store.settings.delete('captcha.secret_key');
  });
  after(async () => {
    await harness.close();
  });

  async function save(captcha: UpdateSettingsRequest['captcha']) {
    return harness.authed(founder, {
      method: 'PUT',
      url: '/api/admin/settings',
      payload: { branding: { tagline: 'This patch must be atomic' }, captcha },
    });
  }

  const invalid: UpdateSettingsRequest['captcha'][] = [
    { ...complete, site_key: null },
    { ...complete, site_key: '   ' },
    { ...complete, provider: 'none' },
    { ...complete, secret_key: undefined },
    { ...complete, secret_key: null },
    { ...complete, secret_key: '   ' },
  ];
  for (const [index, captcha] of invalid.entries()) {
    it(`rejects incomplete activation ${index + 1} without committing a patch prefix`, async () => {
      const beforeRows = await harness.store.settings.all();
      const beforeAudit = await harness.auditRows('admin.settings_update');
      const response = await save(captcha);
      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error.code, 'VALIDATION_FAILED');
      assert.deepEqual(await harness.store.settings.all(), beforeRows);
      assert.deepEqual(await harness.auditRows('admin.settings_update'), beforeAudit);
      assert.equal((await harness.services.captcha.getPublicConfig()).enabled, false);
      assert.doesNotMatch(response.body, /private-captcha/);
    });
  }

  it('activates with a new secret, retains a stored secret, and rejects clearing active keys', async () => {
    assert.equal((await save(complete)).statusCode, 200);
    assert.deepEqual(await harness.services.captcha.getPublicConfig(), {
      enabled: true,
      provider: 'turnstile',
      site_key: 'public-site',
    });
    await harness.services.captcha.verify('synthetic-token');
    assert.equal(verified, 1);
    assert.equal((await save({ enabled: true })).statusCode, 200);
    assert.equal((await save({ site_key: null })).statusCode, 400);
    assert.equal((await save({ secret_key: null })).statusCode, 400);
    assert.equal((await save({ provider: 'none' })).statusCode, 400);
    assert.equal((await save({ enabled: false, secret_key: null, site_key: null })).statusCode, 200);
    assert.equal((await harness.services.captcha.getPublicConfig()).enabled, false);
    await harness.services.captcha.verify(undefined);
    assert.equal(verified, 1);
  });

  it('keeps verification closed when an encrypted secret is unreadable', async () => {
    assert.equal((await save(complete)).statusCode, 200);
    await harness.store.settings.set('captcha.secret_key', 'unreadable-encrypted-blob', true);
    assert.equal((await harness.services.captcha.getPublicConfig()).enabled, true);
    await assert.rejects(harness.services.captcha.verify('synthetic-token'), /not fully configured/);
    assert.equal(verified, 0);
    assert.equal((await save({ enabled: true })).statusCode, 400);
    assert.equal((await save({ secret_key: 'replacement-secret' })).statusCode, 200);
  });

  it('does not advertise a widget for incomplete legacy settings or bypass verification', async () => {
    const legacy = { enabled: true, provider: 'turnstile', site_key: null };
    await harness.store.settings.set('captcha', legacy, false);
    await harness.store.settings.set('captcha.secret_key', 'legacy-secret', false);
    assert.equal((await harness.services.captcha.getPublicConfig()).enabled, false);
    await assert.rejects(harness.services.captcha.verify('synthetic-token'), /not fully configured/);
    await harness.store.settings.set('captcha', { ...legacy, site_key: 'public-site' }, false);
    await harness.store.settings.delete('captcha.secret_key');
    assert.equal((await harness.services.captcha.getPublicConfig()).enabled, false);
    await assert.rejects(harness.services.captcha.verify('synthetic-token'), /not fully configured/);
    assert.equal(verified, 0);
  });
});
