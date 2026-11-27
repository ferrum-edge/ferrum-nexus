import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { loadConfig } from '../config/index.js';
import { createStore } from '../db/index.js';
import type { NexusStore } from '../db/store.js';
import { createCrypto, deriveKey, encryptJsonWithKey, SETTINGS_KEY_INFO } from '../lib/crypto.js';
import { rotateEncryptedSettings } from './rotate-key.js';

const DO_NOT_OPEN_NEXUS = /do not open with NEXUS_SECRET_KEY_PREVIOUS/;
const NOTHING_CHANGED = /nothing was changed/;

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
      assert.match(error.message, DO_NOT_OPEN_NEXUS);
      assert.match(error.message, NOTHING_CHANGED);
      return true;
    });
    assert.deepEqual(await store.settings.get('smtp.password'), before);
  });

  it('refuses a blob that is not bound to its row, changing nothing', async () => {
    // An unbound `v1` envelope under the right key: what a storage-layer
    // writer could have copied from another setting. Runtime reads refuse it,
    // and so does rotation, so it cannot be laundered into a bound blob.
    const unbound = encryptJsonWithKey(deriveKey(NEW_KEY, SETTINGS_KEY_INFO), 'transplanted');
    await store.settings.set('smtp.username', unbound, true);
    const before = await store.settings.get('smtp.password');
    await assert.rejects(rotateEncryptedSettings(store, next, previous), (error: Error) => {
      assert.match(error.message, DO_NOT_OPEN_NEXUS);
      assert.match(error.message, NOTHING_CHANGED);
      return true;
    });
    assert.deepEqual(await store.settings.get('smtp.password'), before);
    assert.equal((await store.settings.get('smtp.username'))?.value, unbound);
    await store.settings.delete('smtp.username');
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
