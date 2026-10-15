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
import { after, before, beforeEach, describe, it } from 'node:test';

import {
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
import { buildTestApp, type TestApp } from './helpers.js';

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

  before(async () => {
    harness = await buildTestApp({ deps: { startOutboxWorker: false } });
    crypto = createCrypto(harness.config.secretKey);
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
});
