import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  envFileCandidates,
  environmentWithEnvFile,
  findEnvFile,
  guardedEnvOverrides,
  GUARDED_ENV_KEYS,
} from './env-file.js';

describe('config — .env file loading', () => {
  let root: string;
  let workspace: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'nexus-env-'));
    workspace = join(root, 'server');
    mkdirSync(workspace);
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('looks in the working directory first, then its parent', () => {
    assert.deepEqual(envFileCandidates(workspace), [join(workspace, '.env'), join(root, '.env')]);
    assert.equal(findEnvFile(workspace), null);
    writeFileSync(join(root, '.env'), 'NEXUS_PORT=9001\n');
    assert.equal(findEnvFile(workspace), join(root, '.env'));
    writeFileSync(join(workspace, '.env'), 'NEXUS_PORT=9002\n');
    assert.equal(findEnvFile(workspace), join(workspace, '.env'));
    rmSync(join(workspace, '.env'));
  });

  it('parses the file but lets the real environment win', () => {
    writeFileSync(
      join(root, '.env'),
      [
        '# comment',
        'NEXUS_SECRET_KEY="from-file-0123456789abcdef0123456789abcdef"',
        "FERRUM_ADMIN_JWT_SECRET='single-quoted-0123456789abcdef0123456789'",
        'export NEXUS_PORT=9001',
        'NEXUS_LOG_LEVEL=debug',
        '',
      ].join('\n'),
    );
    const { env, file } = environmentWithEnvFile({ NEXUS_PORT: '8787', UNRELATED: 'x' }, workspace);
    assert.equal(file, join(root, '.env'));
    assert.equal(env.NEXUS_SECRET_KEY, 'from-file-0123456789abcdef0123456789abcdef');
    assert.equal(env.FERRUM_ADMIN_JWT_SECRET, 'single-quoted-0123456789abcdef0123456789');
    assert.equal(env.NEXUS_LOG_LEVEL, 'debug');
    assert.equal(env.NEXUS_PORT, '8787', 'an exported variable overrides the file');
    assert.equal(env.UNRELATED, 'x');
  });

  it('reports the guarded keys the environment silently overrode', () => {
    writeFileSync(
      join(root, '.env'),
      [
        'NEXUS_SECRET_KEY=from-file-0123456789abcdef0123456789abcdef',
        'FERRUM_NAMESPACE=nexus',
        'FERRUM_ADMIN_URL=http://127.0.0.1:9000',
        'NEXUS_LOG_LEVEL=debug',
        '',
      ].join('\n'),
    );
    const { env, overrides } = environmentWithEnvFile(
      {
        FERRUM_NAMESPACE: 'ferrum-foundry-demo',
        // Identical to the file, so it is not a disagreement.
        FERRUM_ADMIN_URL: 'http://127.0.0.1:9000',
        // Not guarded: overriding it per process is exactly what it is for.
        NEXUS_LOG_LEVEL: 'trace',
      },
      workspace,
    );
    assert.deepEqual(overrides, [
      {
        key: 'FERRUM_NAMESPACE',
        fromFile: 'nexus',
        fromProcess: 'ferrum-foundry-demo',
      },
    ]);
    assert.equal(env.FERRUM_NAMESPACE, 'ferrum-foundry-demo', 'the environment still wins');
    assert.equal(env.NEXUS_LOG_LEVEL, 'trace');
  });

  it('guards exactly FERRUM_NAMESPACE and FERRUM_ADMIN_URL, and only on a difference', () => {
    assert.deepEqual([...GUARDED_ENV_KEYS], ['FERRUM_NAMESPACE', 'FERRUM_ADMIN_URL']);
    // A key the file never set has nothing to disagree with.
    assert.deepEqual(guardedEnvOverrides({ FERRUM_NAMESPACE: 'a' }, {}), []);
    // …and neither has one the environment never set.
    assert.deepEqual(guardedEnvOverrides({}, { FERRUM_NAMESPACE: 'a' }), []);
    assert.deepEqual(guardedEnvOverrides({ FERRUM_NAMESPACE: 'a' }, { FERRUM_NAMESPACE: 'a' }), []);
    assert.deepEqual(
      guardedEnvOverrides(
        { FERRUM_NAMESPACE: 'a', FERRUM_ADMIN_URL: 'http://b:9000' },
        { FERRUM_NAMESPACE: 'z', FERRUM_ADMIN_URL: 'http://y:9000' },
      ),
      [
        { key: 'FERRUM_NAMESPACE', fromFile: 'z', fromProcess: 'a' },
        { key: 'FERRUM_ADMIN_URL', fromFile: 'http://y:9000', fromProcess: 'http://b:9000' },
      ],
    );
  });

  it('is a no-op without a file', () => {
    rmSync(join(root, '.env'));
    const input = { NEXUS_PORT: '8787' };
    const { env, file, overrides } = environmentWithEnvFile(input, workspace);
    assert.equal(file, null);
    assert.equal(env, input);
    assert.deepEqual(overrides, []);
  });
});
