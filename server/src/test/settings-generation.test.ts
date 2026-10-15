/**
 * A secret is only ever presented with the configuration it was stored for.
 *
 * The SMTP connection and its password, and the CAPTCHA provider and its
 * secret, are two `app_settings` rows each, committed together by the settings
 * writer but read one after the other. A read that straddled an administrator's
 * change used to pair the old relay (or vendor) with the new secret. These
 * tests commit a new configuration at exactly that point and require every
 * resolution to come from one generation.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it, mock } from 'node:test';

import type { SsoProviderSettings } from '@ferrum-nexus/shared';

import {
  createSettingsService,
  SMTP_PASSWORD_SETTINGS_KEY,
  SMTP_SETTINGS_KEY,
  type StoredSmtpSettings,
} from '../admin/settings-service.js';
import {
  CAPTCHA_SECRET_SETTINGS_KEY,
  CAPTCHA_SETTINGS_KEY,
  CAPTCHA_VERIFY_URLS,
  createCaptchaService,
} from '../auth/captcha.js';
import type { NexusStore, SettingRecord } from '../db/store.js';
import { createEmailService } from '../email/service.js';
import { createCrypto, type NexusCrypto } from '../lib/crypto.js';
import { isNexusError } from '../lib/errors.js';
import {
  parseStoredSsoSettings,
  resolveSsoProviders,
  SSO_SETTINGS_KEY,
  ssoClientSecretKey,
} from '../sso/settings.js';
import { buildTestApp, type TestApp, type TestSession } from './helpers.js';

/** `store`, with `onGet` run before each settings read of `key`. */
function intercepted(store: NexusStore, key: string, onGet: () => Promise<void>): NexusStore {
  const settings = new Proxy(store.settings, {
    get(target, property) {
      const original = Reflect.get(target, property) as unknown;
      if (property !== 'get' || typeof original !== 'function') {
        return typeof original === 'function' ? original.bind(target) : original;
      }
      return async (read: string): Promise<SettingRecord | null> => {
        if (read === key) await onGet();
        return (original as (k: string) => Promise<SettingRecord | null>).call(target, read);
      };
    },
  });
  return new Proxy(store, {
    get(target, property) {
      if (property === 'settings') return settings;
      const value = Reflect.get(target, property) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('settings read as one generation', () => {
  let harness: TestApp;
  let crypto: NexusCrypto;
  let founder: TestSession;

  before(async () => {
    harness = await buildTestApp({ deps: { startOutboxWorker: false } });
    crypto = createCrypto(harness.config.secretKey);
    // Registered before any test turns CAPTCHA on; the first account is the
    // founding super admin.
    founder = await harness.registerUser({ email: 'generation-founder@example.test' });
  });

  after(async () => {
    await harness.close();
  });

  /** One administrator save: the connection and its password, together. */
  async function commitRelay(host: string, password: string): Promise<void> {
    const connection: StoredSmtpSettings = {
      host,
      port: 587,
      secure: false,
      username: `${host}-user`,
      from_address: null,
    };
    await harness.store.transaction(async (tx) => {
      await tx.settings.set(SMTP_SETTINGS_KEY, connection, false);
      await tx.settings.set(
        SMTP_PASSWORD_SETTINGS_KEY,
        crypto.encryptJson(SMTP_PASSWORD_SETTINGS_KEY, password),
        true,
      );
    });
  }

  /** One administrator save of the CAPTCHA provider, site key and secret. */
  async function commitCaptcha(provider: 'turnstile' | 'hcaptcha', secret: string): Promise<void> {
    await harness.store.transaction(async (tx) => {
      await tx.settings.set(
        CAPTCHA_SETTINGS_KEY,
        { enabled: true, provider, site_key: `${provider}-site-key` },
        false,
      );
      await tx.settings.set(
        CAPTCHA_SECRET_SETTINGS_KEY,
        crypto.encryptJson(CAPTCHA_SECRET_SETTINGS_KEY, secret),
        true,
      );
    });
  }

  beforeEach(async () => {
    await commitRelay('relay-a.example.test', 'relay-a-password');
    await commitCaptcha('turnstile', 'turnstile-secret');
  });

  it('never pairs the previous relay with the new relay’s password', async () => {
    let moved = false;
    const store = intercepted(harness.store, SMTP_PASSWORD_SETTINGS_KEY, async () => {
      // The connection has been read; the administrator's save lands now.
      if (moved) return;
      moved = true;
      await commitRelay('relay-b.example.test', 'relay-b-password');
    });
    const email = createEmailService({ config: harness.config, store, crypto });
    const resolved = await email.resolveSettings();
    assert.ok(moved, 'the save landed between the two reads');
    assert.deepEqual(
      { host: resolved.host, user: resolved.user, password: resolved.password },
      {
        host: 'relay-b.example.test',
        user: 'relay-b.example.test-user',
        password: 'relay-b-password',
      },
    );
  });

  it('notices a change written back to an identical value within one millisecond', async () => {
    // A frozen clock gives every write the same `updated_at`, so the relay
    // row read before and after looks unchanged although it was rewritten.
    mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-15T00:00:00.000Z') });
    try {
      await commitRelay('relay-a.example.test', 'relay-a-password');
      let passwordReads = 0;
      let relayReads = 0;
      const base = intercepted(harness.store, SMTP_PASSWORD_SETTINGS_KEY, async () => {
        passwordReads += 1;
        // Relay B lands just before the password is read …
        if (passwordReads === 1) await commitRelay('relay-b.example.test', 'relay-b-password');
      });
      const store = intercepted(base, SMTP_SETTINGS_KEY, async () => {
        relayReads += 1;
        // … and relay A is saved back just before the relay row is re-read.
        if (relayReads === 2) await commitRelay('relay-a.example.test', 'relay-a-password');
      });
      const email = createEmailService({ config: harness.config, store, crypto });
      const resolved = await email.resolveSettings();
      assert.ok(passwordReads >= 2 && relayReads >= 2, 'both writes landed mid-read');
      assert.deepEqual(
        { host: resolved.host, password: resolved.password },
        { host: 'relay-a.example.test', password: 'relay-a-password' },
      );
    } finally {
      mock.timers.reset();
    }
  });

  it('gives up rather than return a mixed pair while saves keep landing', async () => {
    let saves = 0;
    const store = intercepted(harness.store, SMTP_PASSWORD_SETTINGS_KEY, async () => {
      saves += 1;
      await commitRelay(`relay-${saves}.example.test`, `relay-${saves}-password`);
    });
    const email = createEmailService({ config: harness.config, store, crypto });
    await assert.rejects(
      email.resolveSettings(),
      (error: unknown) => isNexusError(error) && error.code === 'CONFLICT',
    );
  });

  it('never sends one CAPTCHA vendor the other’s secret', async () => {
    let moved = false;
    const store = intercepted(harness.store, CAPTCHA_SECRET_SETTINGS_KEY, async () => {
      if (moved) return;
      moved = true;
      await commitCaptcha('hcaptcha', 'hcaptcha-secret');
    });
    const asked: { url: string; secret: string | null }[] = [];
    const captcha = createCaptchaService({
      store,
      crypto,
      transport: async (url, params) => {
        asked.push({ url, secret: params.get('secret') });
        return { success: true, errors: [] };
      },
    });
    assert.equal(await captcha.verify('token'), 'verified');
    assert.ok(moved, 'the save landed between the two reads');
    assert.deepEqual(asked, [{ url: CAPTCHA_VERIFY_URLS.hcaptcha, secret: 'hcaptcha-secret' }]);
  });
  function ssoProvider(issuer: string): SsoProviderSettings {
    return {
      id: 'generation-corp',
      display_name: 'Generation corp',
      issuer,
      client_id: 'generation-client',
      scopes: ['openid', 'email'],
      enabled: true,
      jit_provisioning: false,
      link_existing_accounts: false,
      require_verified_email: true,
      allowed_email_domains: [],
      disable_local_password_for_linked: false,
      sync_roles: false,
      default_role: 'client',
      role_mappings: [],
      org_mappings: [],
    };
  }

  /** One administrator save of a stored identity provider and its client secret. */
  async function commitSso(issuer: string, secret: string): Promise<void> {
    await harness.store.transaction(async (tx) => {
      await tx.settings.set(
        SSO_SETTINGS_KEY,
        {
          policy: 'local_or_sso',
          allowed_email_domains: [],
          deprovision_on_access_loss: false,
          providers: [ssoProvider(issuer)],
        },
        false,
      );
      await tx.settings.set(
        ssoClientSecretKey('generation-corp'),
        crypto.encryptJson(ssoClientSecretKey('generation-corp'), secret),
        true,
      );
    });
  }

  it('never pairs an identity provider with another issuer’s client secret', async () => {
    await commitSso('https://old-idp.example.test', 'old-idp-secret');
    const stored = parseStoredSsoSettings(await harness.store.settings.get(SSO_SETTINGS_KEY));
    assert.equal(stored.providers[0]?.issuer, 'https://old-idp.example.test');

    let moved = false;
    const store = intercepted(harness.store, ssoClientSecretKey('generation-corp'), async () => {
      if (moved) return;
      moved = true;
      await commitSso('https://new-idp.example.test', 'new-idp-secret');
    });
    // The request read the old settings; the save landed before the secret
    // read. The stale pair is refused rather than resolved.
    await assert.rejects(
      resolveSsoProviders(harness.config, store, crypto, stored),
      (error: unknown) => isNexusError(error) && error.code === 'CONFLICT',
    );
    assert.ok(moved);

    // Read again from the start, the request gets the new issuer and its own secret.
    const fresh = parseStoredSsoSettings(await harness.store.settings.get(SSO_SETTINGS_KEY));
    const resolved = await resolveSsoProviders(harness.config, store, crypto, fresh);
    const provider = resolved.find((entry) => entry.settings.id === 'generation-corp');
    assert.deepEqual(
      { issuer: provider?.settings.issuer, secret: provider?.clientSecret },
      { issuer: 'https://new-idp.example.test', secret: 'new-idp-secret' },
    );
  });

  it('runs the CAPTCHA activation self-test only with the stored provider’s own secret', async () => {
    // Turnstile is on; this save changes only its site key, so the self-test
    // posts the *stored* secret.
    let moved = false;
    let secretReads = 0;
    const asked: { url: string; secret: string | null }[] = [];
    // The third secret read is the one the self-test's secret comes from,
    // after the fingerprint and after the provider (and `secret_set`) were read.
    const store = intercepted(harness.store, CAPTCHA_SECRET_SETTINGS_KEY, async () => {
      secretReads += 1;
      if (moved || secretReads < 3) return;
      moved = true;
      await commitCaptcha('hcaptcha', 'hcaptcha-secret');
    });
    const captcha = createCaptchaService({
      store,
      crypto,
      transport: async (url, params) => {
        asked.push({ url, secret: params.get('secret') });
        return { success: true, errors: [] };
      },
    });
    const settings = createSettingsService({
      config: harness.config,
      store,
      crypto,
      audit: harness.services.audit,
      auth: harness.services.auth,
      captcha,
      locks: (_key, fn) => fn(),
    });
    await settings
      .updateSettings(
        { id: founder.user.id, role: 'super_admin' },
        { captcha: { site_key: 'turnstile-site-key-2', captcha_token: 'token' } },
      )
      .catch(() => undefined);
    assert.ok(moved, 'the save landed between the provider read and the secret read');
    assert.ok(asked.length > 0, 'the self-test reached a vendor');
    for (const call of asked) {
      const vendor = call.url === CAPTCHA_VERIFY_URLS.turnstile ? 'turnstile' : 'hcaptcha';
      assert.equal(call.secret, `${vendor}-secret`, `${vendor} received its own secret only`);
    }
  });
  it('refuses to keep a client secret across an issuer or client change', async () => {
    const put = (provider: SsoProviderSettings, secret?: string | null) =>
      harness.authed(founder, {
        method: 'PUT',
        url: '/api/admin/sso',
        payload: {
          providers: [{ ...provider, ...(secret === undefined ? {} : { client_secret: secret }) }],
        },
      });
    const first = ssoProvider('https://first-idp.example.test');
    const saved = await put(first, 'first-idp-secret');
    assert.equal(saved.statusCode, 200, saved.body);

    for (const moved of [
      { ...first, issuer: 'https://second-idp.example.test' },
      { ...first, client_id: 'another-client' },
    ]) {
      const refused = await put(moved);
      assert.equal(refused.statusCode, 400, refused.body);
      assert.match(refused.body, /requires client_secret/);
    }
    const unchanged = await put({ ...first, display_name: 'Renamed' });
    assert.equal(unchanged.statusCode, 200, unchanged.body);

    const replaced = await put(
      { ...first, issuer: 'https://second-idp.example.test' },
      'second-secret',
    );
    assert.equal(replaced.statusCode, 200, replaced.body);
    const fresh = parseStoredSsoSettings(await harness.store.settings.get(SSO_SETTINGS_KEY));
    const [provider] = await resolveSsoProviders(harness.config, harness.store, crypto, fresh);
    assert.deepEqual(
      { issuer: provider?.settings.issuer, secret: provider?.clientSecret },
      { issuer: 'https://second-idp.example.test', secret: 'second-secret' },
    );
  });
  it('refuses to keep a CAPTCHA secret across a provider change saved while off', async () => {
    const off = await harness.authed(founder, {
      method: 'PUT',
      url: '/api/admin/settings',
      payload: { captcha: { enabled: false, provider: 'hcaptcha' } },
    });
    assert.equal(off.statusCode, 400, off.body);
    assert.match(off.body, /requires sending captcha.secret_key/);
    // Turning it off without moving to another vendor needs no secret.
    const none = await harness.authed(founder, {
      method: 'PUT',
      url: '/api/admin/settings',
      payload: { captcha: { enabled: false, provider: 'none' } },
    });
    assert.equal(none.statusCode, 200, none.body);
  });
});
