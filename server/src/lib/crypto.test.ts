import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createCrypto,
  decryptJsonWithKey,
  deriveKey,
  encryptJsonWithKey,
  fingerprint,
  hashPassword,
  isEncryptedBlob,
  last4,
  randomToken,
  SESSION_HMAC_KEY_INFO,
  SETTINGS_KEY_INFO,
  verifyPassword,
} from './crypto.js';
import { isNexusError } from './errors.js';

const SECRET = 'unit-test-master-secret-0123456789abcdef';

describe('password hashing', () => {
  it('round-trips a password', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    assert.match(hash, /^scrypt:16384:8:1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    assert.equal(await verifyPassword('correct-horse-battery-staple', hash), true);
    assert.equal(await verifyPassword('wrong-password', hash), false);
  });

  it('produces a different hash every time (random salt)', async () => {
    const a = await hashPassword('same-password');
    const b = await hashPassword('same-password');
    assert.notEqual(a, b);
    assert.equal(await verifyPassword('same-password', a), true);
    assert.equal(await verifyPassword('same-password', b), true);
  });

  it('returns false for malformed stored hashes instead of throwing', async () => {
    for (const bad of [
      '',
      'not-a-hash',
      'scrypt:1:2:3',
      'bcrypt:1:2:3:aa:bb',
      'scrypt:x:8:1:aa:bb',
    ]) {
      assert.equal(await verifyPassword('anything', bad), false);
    }
  });
});

describe('settings encryption', () => {
  it('round-trips JSON values', () => {
    const key = deriveKey(SECRET, SETTINGS_KEY_INFO);
    for (const value of ['smtp-password', 42, true, null, { a: 1, b: ['x'] }]) {
      const blob = encryptJsonWithKey(key, value);
      assert.ok(isEncryptedBlob(blob));
      assert.match(blob, /^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]*:[A-Za-z0-9+/=]+$/);
      assert.deepEqual(decryptJsonWithKey(key, blob), value);
    }
  });

  it('never emits the plaintext inside the blob', () => {
    const key = deriveKey(SECRET, SETTINGS_KEY_INFO);
    const blob = encryptJsonWithKey(key, 'super-secret-smtp-password');
    assert.ok(!blob.includes('super-secret'));
  });

  it('rejects a tampered ciphertext', () => {
    const key = deriveKey(SECRET, SETTINGS_KEY_INFO);
    const blob = encryptJsonWithKey(key, 'value');
    const parts = blob.split(':');
    const tampered = Buffer.from(parts[2] ?? '', 'base64');
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    parts[2] = tampered.toString('base64');
    assert.throws(
      () => decryptJsonWithKey(key, parts.join(':')),
      (error: unknown) => isNexusError(error) && error.code === 'INTERNAL',
    );
  });

  it('rejects a tampered authentication tag and a wrong key', () => {
    const key = deriveKey(SECRET, SETTINGS_KEY_INFO);
    const blob = encryptJsonWithKey(key, 'value');
    const parts = blob.split(':');
    const tag = Buffer.from(parts[3] ?? '', 'base64');
    tag[0] = (tag[0] ?? 0) ^ 0x01;
    parts[3] = tag.toString('base64');
    assert.throws(() => decryptJsonWithKey(key, parts.join(':')));

    const otherKey = deriveKey('a-completely-different-master-secret-key', SETTINGS_KEY_INFO);
    assert.throws(() => decryptJsonWithKey(otherKey, blob));
  });

  it('rejects a malformed blob', () => {
    const key = deriveKey(SECRET, SETTINGS_KEY_INFO);
    for (const bad of ['', 'v1:only:three', 'v2:a:b:c', 'plain-text']) {
      assert.throws(() => decryptJsonWithKey(key, bad));
    }
  });
});

describe('key derivation', () => {
  it('derives independent keys per info label', () => {
    const settings = deriveKey(SECRET, SETTINGS_KEY_INFO);
    const session = deriveKey(SECRET, SESSION_HMAC_KEY_INFO);
    assert.equal(settings.length, 32);
    assert.equal(session.length, 32);
    assert.notEqual(settings.toString('hex'), session.toString('hex'));
  });

  it('is deterministic for the same secret', () => {
    assert.equal(
      deriveKey(SECRET, SETTINGS_KEY_INFO).toString('hex'),
      deriveKey(SECRET, SETTINGS_KEY_INFO).toString('hex'),
    );
  });
});

describe('createCrypto', () => {
  it('hashes session tokens deterministically and secretly', () => {
    const crypto = createCrypto(SECRET);
    const token = crypto.newSessionToken();
    const hash = crypto.hashToken(token);
    assert.equal(crypto.hashToken(token), hash);
    assert.notEqual(hash, token);
    assert.match(hash, /^[0-9a-f]{64}$/);

    const other = createCrypto('another-master-secret-0123456789abcdefgh');
    assert.notEqual(other.hashToken(token), hash);
  });

  it('round-trips encrypted settings through the bound helper', () => {
    const crypto = createCrypto(SECRET);
    const blob = crypto.encryptJson({ host: 'smtp.example.com', password: 'hunter2' });
    assert.deepEqual(crypto.decryptJson(blob), { host: 'smtp.example.com', password: 'hunter2' });
  });
});

describe('fingerprints and tokens', () => {
  it('fingerprints with sha256 hex', () => {
    assert.match(fingerprint('nxs_abc'), /^[0-9a-f]{64}$/);
    assert.equal(fingerprint('nxs_abc'), fingerprint('nxs_abc'));
    assert.notEqual(fingerprint('nxs_abc'), fingerprint('nxs_abd'));
  });

  it('takes the last four characters of a secret', () => {
    assert.equal(last4('abcdefgh'), 'efgh');
    assert.equal(last4('abc'), 'abc');
  });

  it('produces unique url-safe tokens', () => {
    const tokens = new Set(Array.from({ length: 64 }, () => randomToken()));
    assert.equal(tokens.size, 64);
    for (const token of tokens) assert.match(token, /^[A-Za-z0-9_-]+$/);
  });
});
