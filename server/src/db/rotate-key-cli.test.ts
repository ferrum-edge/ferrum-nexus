import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { assertEnvFileKeyConsistent } from './rotate-key-cli.js';

const KEY_A = 'a'.repeat(32);
const KEY_B = 'b'.repeat(32);

describe('rotate-key-cli — .env key consistency guard', () => {
  let root: string;
  let envFile: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'nexus-rotate-cli-'));
    envFile = join(root, '.env');
    writeFileSync(envFile, `NEXUS_SECRET_KEY=${KEY_A}\n`);
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('refuses when the .env declares a different NEXUS_SECRET_KEY than the effective one', () => {
    try {
      assertEnvFileKeyConsistent(envFile, KEY_B, false);
      assert.fail('expected the guard to refuse the key mismatch');
    } catch (error) {
      assert.ok(error instanceof Error, 'expected an Error');
      assert.match(error.message, /\.env file at /);
      assert.match(error.message, /NEXUS_SECRET_KEY/);
      assert.match(error.message, /--allow-env-mismatch/);
    }
  });

  it('allows the mismatch with --allow-env-mismatch', () => {
    assert.doesNotThrow(() => assertEnvFileKeyConsistent(envFile, KEY_B, true));
  });

  it('is a no-op when the .env key matches the effective one', () => {
    assert.doesNotThrow(() => assertEnvFileKeyConsistent(envFile, KEY_A, false));
  });

  it('is a no-op when there is no .env to read', () => {
    assert.doesNotThrow(() => assertEnvFileKeyConsistent(null, KEY_B, false));
  });
});