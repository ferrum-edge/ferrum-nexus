/**
 * ferrum-nexus#231 — an exported `FERRUM_NAMESPACE` or `FERRUM_ADMIN_URL`
 * silently beats the `.env` file the operator is reading, and the portal then
 * publishes into a namespace (or at a gateway) that file never named.
 *
 * The precedence rule is unchanged and stays unchanged: the environment wins.
 * What changes is that it stops being silent — loudly in production, and by
 * refusing to boot everywhere else unless the override is acknowledged.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { EnvOverride } from '../config/env-file.js';
import { loadConfig, type EnvRecord, type NexusConfig } from '../config/index.js';
import { assertEnvOverridesAllowed, envOverrideBanner } from '../index.js';
import { isNexusError } from '../lib/errors.js';
import { TEST_SECRET_KEY, TEST_EDGE_JWT_SECRET } from './helpers.js';

const NAMESPACE_OVERRIDE: EnvOverride = {
  key: 'FERRUM_NAMESPACE',
  fromFile: 'nexus',
  fromProcess: 'ferrum-foundry-demo',
};

function config(env: EnvRecord = {}): NexusConfig {
  return loadConfig({
    NEXUS_SECRET_KEY: TEST_SECRET_KEY,
    FERRUM_ADMIN_JWT_SECRET: TEST_EDGE_JWT_SECRET,
    NEXUS_LOG_LEVEL: 'silent',
    ...env,
  });
}

describe('startup env-override guard', () => {
  it('names the variable, both values, and which one won', () => {
    const banner = envOverrideBanner([NAMESPACE_OVERRIDE], '/srv/nexus/.env');
    assert.match(banner, /FERRUM_NAMESPACE/);
    assert.match(banner, /\/srv\/nexus\/\.env: nexus/);
    assert.match(banner, /environment: {2}ferrum-foundry-demo {3}<-- wins/);
  });

  it('falls back to `.env` when no file path is known', () => {
    assert.match(envOverrideBanner([NAMESPACE_OVERRIDE], null), /\.env: nexus/);
  });

  it('refuses to start in development', () => {
    let error: unknown;
    try {
      assertEnvOverridesAllowed([NAMESPACE_OVERRIDE], config({ NEXUS_ENV: 'development' }), null);
    } catch (caught) {
      error = caught;
    }
    assert.ok(isNexusError(error));
    assert.equal(error.code, 'VALIDATION_FAILED');
    assert.match(error.message, /FERRUM_NAMESPACE/);
    assert.match(error.message, /ferrum-foundry-demo/);
    assert.match(error.message, /NEXUS_ALLOW_ENV_OVERRIDE=true/);
    assert.deepEqual(error.details, { overrides: ['FERRUM_NAMESPACE'] });
  });

  it('starts in development once the override is acknowledged', () => {
    assert.doesNotThrow(() => {
      assertEnvOverridesAllowed(
        [NAMESPACE_OVERRIDE],
        config({ NEXUS_ENV: 'development', NEXUS_ALLOW_ENV_OVERRIDE: 'true' }),
        null,
      );
    });
  });

  it('stays warn-only in production, where the environment is the config', () => {
    const production = config({ NEXUS_ENV: 'production' });
    assert.equal(production.allowEnvOverride, false);
    assert.doesNotThrow(() => {
      assertEnvOverridesAllowed([NAMESPACE_OVERRIDE], production, null);
    });
  });

  it('does nothing when the file and the environment agree', () => {
    assert.doesNotThrow(() => {
      assertEnvOverridesAllowed([], config({ NEXUS_ENV: 'development' }), null);
    });
  });
});
