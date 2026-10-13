import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { loadConfig } from '../config/index.js';
import { createAuditService } from '../audit/service.js';
import { createStore } from '../db/index.js';
import type { NexusStore } from '../db/store.js';
import { createCrypto, deriveKey, encryptJsonWithKey, SETTINGS_KEY_INFO } from '../lib/crypto.js';
import { createKeyedSerializer } from '../lib/keyed-serializer.js';
import { bindLegacyEncryptedSettings, rotateEncryptedSettings } from './rotate-key.js';

const OLD_KEY = 'old-master-key-0123456789abcdef0123456789abcdef';
const NEW_KEY = 'new-master-key-fedcba9876543210fedcba9876543210';

describe('rotateEncryptedSettings', () => {
  let store: NexusStore;
  const previous = createCrypto(OLD_KEY);
  const next = createCrypto(NEW_KEY);

  before(async () => {
    store = createStore(
      loadConfig({
        NEXUS_ENV: 'test',
        NEXUS_SECRET_KEY: OLD_KEY,
        NEXUS_SQLITE_PATH: ':memory:',
        FERRUM_ADMIN_JWT_SECRET: 'edge-secret-0123456789abcdef0123456789abcdef',
        FERRUM_ADMIN_URL: 'http://127.0.0.1:9000',
      }),
    );
    await store.init();
    await store.migrate();
    await store.settings.set(
      'smtp.password',
      previous.encryptJson('smtp.password', 'hunter2'),
      true,
    );
    await store.settings.set(
      'captcha.secret_key',
      previous.encryptJson('captcha.secret_key', '0xSECRET'),
      true,
    );
    await store.settings.set('branding', { name: 'Nexus' }, false);
  });

  after(async () => {
    await store.close();
  });

  it('rewrites every encrypted row under the new key and leaves plaintext rows alone', async () => {
    const summary = await rotateEncryptedSettings(store, previous, next);
    assert.deepEqual(summary, {
      rotated: 2,
      skipped: 1,
      keys: ['captcha.secret_key', 'smtp.password'].sort(),
    });
    const smtp = await store.settings.get('smtp.password');
    assert.equal(smtp?.encrypted, true);
    assert.equal(next.decryptJson('smtp.password', String(smtp?.value)), 'hunter2');
    assert.throws(
      () => previous.decryptJson('smtp.password', String(smtp?.value)),
      'the old key no longer opens it',
    );
    assert.equal(
      next.decryptJson(
        'captcha.secret_key',
        String((await store.settings.get('captcha.secret_key'))?.value),
      ),
      '0xSECRET',
    );
    assert.deepEqual((await store.settings.get('branding'))?.value, { name: 'Nexus' });
  });

  it('refuses to run twice, and changes nothing when the previous key is wrong', async () => {
    const before = await store.settings.get('smtp.password');
    await assert.rejects(rotateEncryptedSettings(store, previous, next), (error: Error) => {
      assert.match(error.message, /do not open with NEXUS_SECRET_KEY_PREVIOUS/);
      assert.match(error.message, /nothing was changed/);
      return true;
    });
    assert.deepEqual(await store.settings.get('smtp.password'), before);
  });

  it('is a no-op on a database with no encrypted rows', async () => {
    await store.settings.delete('smtp.password');
    await store.settings.delete('captcha.secret_key');
    assert.deepEqual(await rotateEncryptedSettings(store, next, previous), {
      rotated: 0,
      skipped: 1,
      keys: [],
    });
  });
});

/** A cross-instance serializer of its own, as a separate Nexus process has. */
const locksFor = (store: NexusStore) => createKeyedSerializer({ leases: store.leases });

describe('bindLegacyEncryptedSettings', () => {
  let store: NexusStore;
  const crypto = createCrypto(OLD_KEY);
  /** An unbound `v1` blob, as a release before key binding wrote it. */
  const legacy = (secretKey: string, value: unknown): string =>
    encryptJsonWithKey(deriveKey(secretKey, SETTINGS_KEY_INFO), value);

  before(async () => {
    store = createStore(
      loadConfig({
        NEXUS_ENV: 'test',
        NEXUS_SECRET_KEY: OLD_KEY,
        NEXUS_SQLITE_PATH: ':memory:',
        FERRUM_ADMIN_JWT_SECRET: 'edge-secret-0123456789abcdef0123456789abcdef',
        FERRUM_ADMIN_URL: 'http://127.0.0.1:9000',
      }),
    );
    await store.init();
    await store.migrate();
  });

  after(async () => {
    await store.close();
  });

  it('re-binds every legacy row it can open to its own key, once, and records it', async () => {
    const audit = createAuditService(store);
    await store.settings.set('smtp.password', legacy(OLD_KEY, 'hunter2'), true);
    await store.settings.set('captcha.secret_key', legacy(NEW_KEY, '0xSECRET'), true);
    const bound = crypto.encryptJson('sso.client_secret.a', 'already-bound');
    await store.settings.set('sso.client_secret.a', bound, true);

    // Runtime reads refuse the unbound row until it is re-bound.
    const before = String((await store.settings.get('smtp.password'))?.value);
    assert.throws(() => crypto.decryptJson('smtp.password', before));
    assert.equal(crypto.decryptLegacySetting('smtp.password', before), 'hunter2');

    assert.deepEqual(await bindLegacyEncryptedSettings(store, crypto, audit, locksFor(store)), {
      alreadyRecorded: false,
      bound: ['smtp.password'],
      changed: [],
      unreadable: ['captcha.secret_key'],
    });
    const smtp = String((await store.settings.get('smtp.password'))?.value);
    assert.ok(smtp.startsWith('v2:'));
    assert.equal(crypto.decryptJson('smtp.password', smtp), 'hunter2');
    assert.throws(() => crypto.decryptJson('captcha.secret_key', smtp), 'bound to its own row');
    assert.equal((await store.settings.get('sso.client_secret.a'))?.value, bound);
    const marker = await store.auditLogs.list({ action: 'settings.encryption_bound' });
    assert.equal(marker.items.length, 1);

    // After the recorded conversion, a pre-upgrade `v1` copy of another
    // setting's secret written into the SMTP row is never re-bound there.
    const transplanted = legacy(OLD_KEY, 'oidc-client-secret');
    await store.settings.set('smtp.password', transplanted, true);
    assert.deepEqual(await bindLegacyEncryptedSettings(store, crypto, audit, locksFor(store)), {
      alreadyRecorded: true,
      bound: [],
      changed: [],
      unreadable: ['captcha.secret_key', 'smtp.password'],
    });
    assert.equal((await store.settings.get('smtp.password'))?.value, transplanted);
    assert.throws(() => crypto.decryptJson('smtp.password', transplanted));

    // Nor does a later key rotation launder it into a valid bound blob: the
    // rotation refuses and changes nothing.
    const rows = await store.settings.all();
    await assert.rejects(
      rotateEncryptedSettings(store, crypto, createCrypto(NEW_KEY)),
      (error: Error) => {
        assert.match(error.message, /smtp\.password/);
        return true;
      },
    );
    assert.deepEqual(await store.settings.all(), rows);
  });

  it('never overwrites a value another writer saved after it was read', async () => {
    const other = createStore(
      loadConfig({
        NEXUS_ENV: 'test',
        NEXUS_SECRET_KEY: OLD_KEY,
        NEXUS_SQLITE_PATH: ':memory:',
        FERRUM_ADMIN_JWT_SECRET: 'edge-secret-0123456789abcdef0123456789abcdef',
        FERRUM_ADMIN_URL: 'http://127.0.0.1:9000',
      }),
    );
    await other.init();
    await other.migrate();
    try {
      await other.settings.set('captcha.secret_key', legacy(OLD_KEY, '0xOLD'), true);
      await other.settings.set('smtp.password', legacy(OLD_KEY, 'old-password'), true);
      const fresh = crypto.encryptJson('captcha.secret_key', 'saved-meanwhile');
      const read = other.settings.all.bind(other.settings);
      // Another instance saves the CAPTCHA secret and deletes the SMTP
      // override between the scan and the swap.
      other.settings.all = async () => {
        const rows = await read();
        await other.settings.set('captcha.secret_key', fresh, true);
        await other.settings.delete('smtp.password');
        return rows;
      };
      const summary = await bindLegacyEncryptedSettings(
        other,
        crypto,
        createAuditService(other),
        locksFor(other),
      );
      assert.deepEqual(summary.bound, []);
      assert.deepEqual(summary.changed, ['captcha.secret_key', 'smtp.password']);
      assert.deepEqual(summary.unreadable, []);
      assert.equal((await other.settings.get('captcha.secret_key'))?.value, fresh);
      assert.equal(await other.settings.get('smtp.password'), null);
    } finally {
      await other.close();
    }
  });

  it('converts once and writes one marker when instances start together', async () => {
    const shared = createStore(
      loadConfig({
        NEXUS_ENV: 'test',
        NEXUS_SECRET_KEY: OLD_KEY,
        NEXUS_SQLITE_PATH: ':memory:',
        FERRUM_ADMIN_JWT_SECRET: 'edge-secret-0123456789abcdef0123456789abcdef',
        FERRUM_ADMIN_URL: 'http://127.0.0.1:9000',
      }),
    );
    await shared.init();
    await shared.migrate();
    try {
      await shared.settings.set('smtp.password', legacy(OLD_KEY, 'hunter2'), true);
      const audit = createAuditService(shared);
      const [first, second] = await Promise.all([
        bindLegacyEncryptedSettings(shared, crypto, audit, locksFor(shared)),
        bindLegacyEncryptedSettings(shared, crypto, audit, locksFor(shared)),
      ]);
      const summaries = [first, second].sort(
        (a, b) => Number(a.alreadyRecorded) - Number(b.alreadyRecorded),
      );
      assert.deepEqual(summaries, [
        { alreadyRecorded: false, bound: ['smtp.password'], changed: [], unreadable: [] },
        { alreadyRecorded: true, bound: [], changed: [], unreadable: [] },
      ]);
      const markers = await shared.auditLogs.list({ action: 'settings.encryption_bound' });
      assert.equal(markers.total, 1);
    } finally {
      await shared.close();
    }
  });
});
