/**
 * Admission and the activation self-test for the `captcha` settings section.
 *
 * Two rules meet here, and both refuse *before* anything is written:
 *
 * 1. **Completeness** — an enabled configuration needs a provider other than
 *    `none`, a site key and a usable secret.
 * 2. **The self-test** — turning CAPTCHA on, or moving its provider, site key
 *    or secret while it is on, makes register *and login* demand a token from
 *    every account, the enabling super admin included. So the patch has to
 *    carry a `captcha_token` that the **new** configuration verifies, through
 *    the same vendor call a login makes. A portal can no longer adopt a
 *    challenge it cannot check and lock everybody out of sign-in
 *    (ferrum-nexus#252).
 *
 * Turning CAPTCHA *off* deliberately needs no token: that is the in-portal half
 * of the recovery path, for whoever can still authenticate.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import type { ApiErrorBody, UpdateSettingsRequest } from '@ferrum-nexus/shared';

import type { CaptchaTransport } from '../auth/captcha.js';
import type { AuditLogRecord, SettingRecord } from '../db/store.js';
import { buildTestApp, type TestApp, type TestSession } from './helpers.js';

/** A token the stub vendor accepts for any secret. */
const GOOD_TOKEN = 'solved-challenge';

const complete = {
  enabled: true,
  provider: 'turnstile' as const,
  site_key: 'public-site',
  secret_key: 'private-captcha',
  captcha_token: GOOD_TOKEN,
};

/**
 * One recorded call to the vendor's `siteverify` endpoint.
 *
 * `remoteip` is the administrator's request address, forwarded exactly as a
 * login forwards the visitor's (the harness injects from `127.0.0.1`); a direct
 * `verify()` call with no address records `null`.
 */
interface VendorCall {
  secret: string;
  response: string;
  remoteip: string | null;
}

describe('CAPTCHA activation admission', () => {
  let harness: TestApp;
  let founder: TestSession;
  let calls: VendorCall[];
  /** Swapped per test to model a rejecting or unreachable vendor. */
  let accept: (secret: string, token: string) => boolean;
  let unreachable: boolean;

  const transport: CaptchaTransport = async (_url, params) => {
    const secret = params.get('secret') ?? '';
    const response = params.get('response') ?? '';
    calls.push({ secret, response, remoteip: params.get('remoteip') });
    if (unreachable) throw new Error('vendor unreachable');
    return accept(secret, response)
      ? { success: true, errors: [] }
      : { success: false, errors: ['invalid-input-response'] };
  };

  before(async () => {
    harness = await buildTestApp({ deps: { captchaTransport: transport } });
    founder = await harness.registerUser();
  });
  beforeEach(async () => {
    calls = [];
    accept = (_secret, token) => token === GOOD_TOKEN;
    unreachable = false;
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

  /** Every row a refused patch must have left exactly as it found it. */
  interface Baseline {
    rows: SettingRecord[];
    audit: AuditLogRecord[];
  }

  async function snapshot(): Promise<Baseline> {
    return {
      rows: await harness.store.settings.all(),
      audit: await harness.auditRows('admin.settings_update'),
    };
  }

  /** Assert a refusal stored nothing at all — no setting row, no audit row. */
  async function assertNothingCommitted(baseline: Baseline): Promise<void> {
    assert.deepEqual(await harness.store.settings.all(), baseline.rows);
    assert.deepEqual(await harness.auditRows('admin.settings_update'), baseline.audit);
  }

  /* ── Completeness ─────────────────────────────────────────────────────── */

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
      const baseline = await snapshot();
      const response = await save(captcha);
      assert.equal(response.statusCode, 400);
      assert.equal(response.json<ApiErrorBody>().error.code, 'VALIDATION_FAILED');
      await assertNothingCommitted(baseline);
      assert.equal((await harness.services.captcha.getPublicConfig()).enabled, false);
      assert.doesNotMatch(response.body, /private-captcha/);
      // An unusable configuration is refused on its own terms; the vendor is
      // never asked about a site key and secret that cannot both be present.
      assert.deepEqual(calls, []);
    });
  }

  /* ── The activation self-test ─────────────────────────────────────────── */

  it('refuses an activation carrying no token and stores nothing', async () => {
    const baseline = await snapshot();
    const response = await save({ ...complete, captcha_token: undefined });
    assert.equal(response.statusCode, 400, response.body);
    const body = response.json<ApiErrorBody>();
    assert.equal(body.error.code, 'CAPTCHA_SELF_TEST_FAILED');
    assert.deepEqual(body.error.details, { reason: 'token_required' });
    await assertNothingCommitted(baseline);
    assert.equal((await harness.services.captcha.getPublicConfig()).enabled, false);
    assert.deepEqual(calls, []);
  });

  it('refuses an activation whose token the new configuration rejects', async () => {
    const baseline = await snapshot();
    const response = await save({ ...complete, captcha_token: 'stale-token' });
    assert.equal(response.statusCode, 400, response.body);
    const body = response.json<ApiErrorBody>();
    assert.equal(body.error.code, 'CAPTCHA_SELF_TEST_FAILED');
    assert.deepEqual(body.error.details, { reason: 'rejected' });
    await assertNothingCommitted(baseline);
    assert.equal((await harness.services.captcha.getPublicConfig()).enabled, false);
    // Verified against the configuration being saved, not the stored one.
    assert.deepEqual(calls, [
      { secret: 'private-captcha', response: 'stale-token', remoteip: '127.0.0.1' },
    ]);
    assert.doesNotMatch(response.body, /private-captcha/);
  });

  it('refuses an activation the vendor could not be reached to confirm', async () => {
    unreachable = true;
    const baseline = await snapshot();
    const response = await save(complete);
    assert.equal(response.statusCode, 400, response.body);
    const body = response.json<ApiErrorBody>();
    assert.equal(body.error.code, 'CAPTCHA_SELF_TEST_FAILED');
    assert.deepEqual(body.error.details, { reason: 'provider_unreachable' });
    await assertNothingCommitted(baseline);
    assert.equal((await harness.services.captcha.getPublicConfig()).enabled, false);
  });

  it('stores an activation whose token the new configuration accepts', async () => {
    const beforeAudit = await harness.auditRows('admin.settings_update');
    assert.equal((await save(complete)).statusCode, 200);
    assert.deepEqual(await harness.services.captcha.getPublicConfig(), {
      enabled: true,
      provider: 'turnstile',
      site_key: 'public-site',
    });
    assert.deepEqual(calls, [
      { secret: 'private-captcha', response: GOOD_TOKEN, remoteip: '127.0.0.1' },
    ]);
    const audit = await harness.auditRows('admin.settings_update');
    assert.equal(audit.length, beforeAudit.length + 1);
    assert.equal(audit[0]?.details?.captcha_self_test, 'passed');
    assert.doesNotMatch(JSON.stringify(audit), /private-captcha/);
  });

  it('proves the secret in the patch rather than the one already stored', async () => {
    assert.equal((await save(complete)).statusCode, 200);
    // From here the stub vendor answers for one secret only, so which secret
    // the self-test sends is the whole difference between the two saves below.
    accept = (secret) => secret === 'replacement-secret';

    const stale = await save({ secret_key: 'private-captcha', captcha_token: GOOD_TOKEN });
    assert.equal(stale.statusCode, 400, stale.body);
    assert.deepEqual(stale.json<ApiErrorBody>().error.details, { reason: 'rejected' });

    const accepted = await save({ secret_key: 'replacement-secret', captcha_token: GOOD_TOKEN });
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.deepEqual(calls.at(-1), {
      secret: 'replacement-secret',
      response: GOOD_TOKEN,
      remoteip: '127.0.0.1',
    });
  });

  type CaptchaPatch = NonNullable<UpdateSettingsRequest['captcha']>;
  const moves: { name: string; patch: CaptchaPatch }[] = [
    { name: 'provider', patch: { provider: 'hcaptcha' } },
    { name: 'site key', patch: { site_key: 'another-site' } },
    { name: 'secret key', patch: { secret_key: 'another-secret' } },
  ];
  for (const move of moves) {
    it(`re-requires a token when the ${move.name} changes while CAPTCHA is on`, async () => {
      assert.equal((await save(complete)).statusCode, 200);
      const baseline = await snapshot();
      const refused = await save(move.patch);
      assert.equal(refused.statusCode, 400, refused.body);
      assert.equal(refused.json<ApiErrorBody>().error.code, 'CAPTCHA_SELF_TEST_FAILED');
      await assertNothingCommitted(baseline);
      const accepted = await save({ ...move.patch, captcha_token: GOOD_TOKEN });
      assert.equal(accepted.statusCode, 200, accepted.body);
    });
  }

  it('needs no token to re-save an unchanged configuration', async () => {
    assert.equal((await save(complete)).statusCode, 200);
    calls = [];
    assert.equal((await save({ enabled: true })).statusCode, 200);
    assert.equal((await save({ site_key: 'public-site' })).statusCode, 200);
    assert.equal((await save({ provider: 'turnstile' })).statusCode, 200);
    // Nothing about the challenge moved, so nothing was asked of the vendor.
    assert.deepEqual(calls, []);
  });

  it('needs no token to turn CAPTCHA off, which is the in-portal way back', async () => {
    assert.equal((await save(complete)).statusCode, 200);
    calls = [];
    const disabled = await save({ enabled: false, secret_key: null, site_key: null });
    assert.equal(disabled.statusCode, 200, disabled.body);
    assert.equal((await harness.services.captcha.getPublicConfig()).enabled, false);
    assert.deepEqual(calls, []);
    assert.equal(await harness.services.captcha.verify(undefined), 'not_required');
  });

  it('leaves an unrelated patch alone', async () => {
    const response = await harness.authed(founder, {
      method: 'PUT',
      url: '/api/admin/settings',
      payload: { branding: { tagline: 'No CAPTCHA section here' } },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(calls, []);
  });

  /* ── Refusals that survive the self-test ──────────────────────────────── */

  it('refuses to clear a key the active configuration needs', async () => {
    assert.equal((await save(complete)).statusCode, 200);
    assert.equal((await save({ site_key: null, captcha_token: GOOD_TOKEN })).statusCode, 400);
    assert.equal((await save({ secret_key: null, captcha_token: GOOD_TOKEN })).statusCode, 400);
    assert.equal((await save({ provider: 'none', captcha_token: GOOD_TOKEN })).statusCode, 400);
    assert.equal((await harness.services.captcha.getPublicConfig()).enabled, true);
  });

  it('keeps verification closed when an encrypted secret is unreadable', async () => {
    assert.equal((await save(complete)).statusCode, 200);
    await harness.store.settings.set('captcha.secret_key', 'unreadable-encrypted-blob', true);
    assert.equal((await harness.services.captcha.getPublicConfig()).enabled, true);
    await assert.rejects(
      harness.services.captcha.verify('synthetic-token'),
      /not fully configured/,
    );
    // Re-saving the same block cannot repair it: with no readable secret there
    // is nothing to prove the configuration with.
    assert.equal((await save({ enabled: true })).statusCode, 400);
    const replaced = await save({ secret_key: 'replacement-secret', captcha_token: GOOD_TOKEN });
    assert.equal(replaced.statusCode, 200, replaced.body);
  });

  it('hides incomplete legacy widgets and keeps verification closed', async () => {
    const legacy = { enabled: true, provider: 'turnstile', site_key: null };
    await harness.store.settings.set('captcha', legacy, false);
    await harness.store.settings.set('captcha.secret_key', 'legacy-secret', false);
    assert.equal((await harness.services.captcha.getPublicConfig()).enabled, false);
    await assert.rejects(
      harness.services.captcha.verify('synthetic-token'),
      /not fully configured/,
    );
    await harness.store.settings.set('captcha', { ...legacy, site_key: 'public-site' }, false);
    await harness.store.settings.delete('captcha.secret_key');
    assert.equal((await harness.services.captcha.getPublicConfig()).enabled, false);
    await assert.rejects(
      harness.services.captcha.verify('synthetic-token'),
      /not fully configured/,
    );
    assert.deepEqual(calls, []);
  });

  it('verifies a solved challenge on login once activation has been proven', async () => {
    assert.equal((await save(complete)).statusCode, 200);
    calls = [];
    assert.equal(await harness.services.captcha.verify(GOOD_TOKEN), 'verified');
    assert.deepEqual(calls, [{ secret: 'private-captcha', response: GOOD_TOKEN, remoteip: null }]);
  });
});
