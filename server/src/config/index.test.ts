import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadConfig, type EnvRecord } from './index.js';
import { isNexusError } from '../lib/errors.js';

const SECRET = 'a'.repeat(40);

function baseEnv(overrides: EnvRecord = {}): EnvRecord {
  return {
    NEXUS_SECRET_KEY: SECRET,
    FERRUM_ADMIN_JWT_SECRET: SECRET,
    ...overrides,
  };
}

function expectConfigError(env: EnvRecord, needle: string): void {
  assert.throws(
    () => loadConfig(env),
    (error: unknown) => {
      assert.ok(isNexusError(error), 'expected a NexusError');
      assert.equal(error.code, 'INTERNAL');
      assert.match(error.message, new RegExp(needle));
      return true;
    },
  );
}

describe('loadConfig', () => {
  it('applies every documented default', () => {
    const config = loadConfig(baseEnv());

    assert.equal(config.host, '127.0.0.1');
    assert.equal(config.port, 8787);
    assert.equal(config.publicUrl, 'http://127.0.0.1:5173');
    assert.equal(config.trustProxy, false);
    assert.equal(config.logLevel, 'info');
    assert.equal(config.sessionTtlSeconds, 43_200);
    assert.equal(config.db.driver, 'sqlite');
    assert.equal(config.db.sqlitePath, './data/nexus.sqlite');
    assert.equal(config.db.allowStandalone, false);
    assert.equal(config.edge.adminUrl, 'http://127.0.0.1:9000');
    assert.equal(config.edge.namespace, 'nexus');
    assert.equal(config.edge.jwtTtlSeconds, 60);
    assert.equal(config.edge.jwtIssuer, 'ferrum-edge');
    assert.equal(config.edge.jwtAudience, undefined);
    assert.equal(config.edge.maxCredentialsPerType, 2);
    assert.equal(config.smtp.port, 587);
    assert.equal(config.smtp.from, 'Ferrum Nexus <no-reply@example.com>');
  });

  it('requires NEXUS_SECRET_KEY and FERRUM_ADMIN_JWT_SECRET', () => {
    expectConfigError({ FERRUM_ADMIN_JWT_SECRET: SECRET }, 'NEXUS_SECRET_KEY');
    expectConfigError({ NEXUS_SECRET_KEY: SECRET }, 'FERRUM_ADMIN_JWT_SECRET');
  });

  it('rejects short secrets', () => {
    expectConfigError(baseEnv({ NEXUS_SECRET_KEY: 'too-short' }), 'at least 32 characters');
    expectConfigError(baseEnv({ FERRUM_ADMIN_JWT_SECRET: 'too-short' }), 'at least 32 characters');
  });

  it('allows plaintext http for loopback admin URLs', () => {
    for (const url of ['http://127.0.0.1:9000', 'http://localhost:9000', 'http://[::1]:9000']) {
      const config = loadConfig(baseEnv({ FERRUM_ADMIN_URL: url }));
      assert.ok(config.edge.adminUrl.startsWith('http://'));
    }
  });

  it('refuses plaintext http for a non-loopback admin URL', () => {
    expectConfigError(
      baseEnv({ FERRUM_ADMIN_URL: 'http://gateway.internal:9000' }),
      'FERRUM_ADMIN_ALLOW_INSECURE_HTTP',
    );
  });

  it('allows the insecure escape hatch when explicitly enabled', () => {
    const config = loadConfig(
      baseEnv({
        FERRUM_ADMIN_URL: 'http://gateway.internal:9000',
        FERRUM_ADMIN_ALLOW_INSECURE_HTTP: 'true',
      }),
    );
    assert.equal(config.edge.adminUrl, 'http://gateway.internal:9000');
  });

  it('accepts https for any host', () => {
    const config = loadConfig(baseEnv({ FERRUM_ADMIN_URL: 'https://gateway.example.com:9443/' }));
    assert.equal(config.edge.adminUrl, 'https://gateway.example.com:9443');
  });

  it('rejects an unknown database driver and a missing URL for remote drivers', () => {
    expectConfigError(
      baseEnv({ NEXUS_DB_DRIVER: 'cassandra' }),
      'sqlite, postgres, mysql, mongodb',
    );
    expectConfigError(baseEnv({ NEXUS_DB_DRIVER: 'postgres' }), 'NEXUS_DB_URL is required');
  });

  it('rejects an invalid namespace and an out-of-range JWT TTL', () => {
    expectConfigError(baseEnv({ FERRUM_NAMESPACE: '-bad-' }), 'FERRUM_NAMESPACE');
    expectConfigError(baseEnv({ FERRUM_ADMIN_JWT_TTL: '99999' }), 'FERRUM_ADMIN_JWT_TTL');
  });

  it('disables rate limiting in the test environment', () => {
    assert.equal(loadConfig(baseEnv({ NEXUS_ENV: 'test' })).rateLimitEnabled, false);
    assert.equal(loadConfig(baseEnv({ NEXUS_ENV: 'production' })).rateLimitEnabled, true);
  });

  it('treats blank optional variables as unset', () => {
    const config = loadConfig(
      baseEnv({ FERRUM_ADMIN_JWT_AUDIENCE: '   ', FERRUM_ADMIN_CA_FILE: '', NEXUS_SMTP_HOST: '' }),
    );
    assert.equal(config.edge.jwtAudience, undefined);
    assert.equal(config.edge.caFile, undefined);
    assert.equal(config.smtp.host, undefined);
  });

  it('parses booleans in every documented spelling', () => {
    assert.equal(loadConfig(baseEnv({ NEXUS_TRUST_PROXY: 'TRUE' })).trustProxy, true);
    assert.equal(loadConfig(baseEnv({ NEXUS_TRUST_PROXY: 'no' })).trustProxy, false);
    expectConfigError(baseEnv({ NEXUS_TRUST_PROXY: 'maybe' }), 'true or false');
  });
});
