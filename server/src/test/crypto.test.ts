import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  constantTimeEqual,
  decryptSetting,
  encryptSetting,
  fingerprint,
  last4,
  randomToken,
} from '../lib/crypto.js';

test('encrypt/decrypt round trip', () => {
  const key = 'a'.repeat(64);
  const enc = encryptSetting('hunter2', key);
  assert.match(enc, /^v1:/);
  assert.equal(decryptSetting(enc, key), 'hunter2');
});

test('fingerprint is stable', () => {
  const a = fingerprint('abc');
  const b = fingerprint('abc');
  assert.equal(a, b);
});

test('last4 truncates', () => {
  assert.equal(last4('abcdef'), 'cdef');
  assert.equal(last4('ab'), 'ab');
});

test('randomToken length grows with bytes', () => {
  const t = randomToken(8);
  assert.ok(t.length >= 10);
});

test('constantTimeEqual rejects mismatched UTF-8 byte lengths without throwing', () => {
  assert.equal(constantTimeEqual('é' + 'A'.repeat(31), 'A'.repeat(32)), false);
});
