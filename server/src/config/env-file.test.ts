import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { envFileCandidates, environmentWithEnvFile, findEnvFile } from './env-file.js';

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

  it('is a no-op without a file', () => {
    rmSync(join(root, '.env'));
    const input = { NEXUS_PORT: '8787' };
    const { env, file } = environmentWithEnvFile(input, workspace);
    assert.equal(file, null);
    assert.equal(env, input);
  });
});
