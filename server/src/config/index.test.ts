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
    assert.equal(config.trustedProxies, false);
    assert.equal(config.allowPrivateUpstreams, false);
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
    assert.equal(config.edge.gatewayPublicUrl, undefined);
    assert.equal(config.edge.maxCredentialsPerType, 2);
    assert.deepEqual(config.edge.rateLimit, {
      syncMode: 'local',
      redisUrl: undefined,
      redisTls: false,
    });
    assert.equal(config.smtp.port, 587);
    assert.equal(config.smtp.from, 'Ferrum Nexus <no-reply@example.com>');
  });

  describe('FERRUM_GATEWAY_PUBLIC_URL', () => {
    it('normalises an origin and strips a trailing slash', () => {
      const config = loadConfig(
        baseEnv({ FERRUM_GATEWAY_PUBLIC_URL: 'https://api.example.com:8443/' }),
      );
      assert.equal(config.edge.gatewayPublicUrl, 'https://api.example.com:8443');
    });

    it('treats a blank value as unset', () => {
      assert.equal(
        loadConfig(baseEnv({ FERRUM_GATEWAY_PUBLIC_URL: '  ' })).edge.gatewayPublicUrl,
        undefined,
      );
    });

    for (const value of [
      'https://api.example.com/v1',
      'https://api.example.com?x=1',
      'https://user:pass@api.example.com',
      'ftp://api.example.com',
      'api.example.com',
    ]) {
      it(`rejects ${value}`, () => {
        expectConfigError(
          baseEnv({ FERRUM_GATEWAY_PUBLIC_URL: value }),
          'FERRUM_GATEWAY_PUBLIC_URL',
        );
      });
    }
  });

  it('requires NEXUS_SECRET_KEY and FERRUM_ADMIN_JWT_SECRET', () => {
    expectConfigError({ FERRUM_ADMIN_JWT_SECRET: SECRET }, 'NEXUS_SECRET_KEY');
    expectConfigError({ NEXUS_SECRET_KEY: SECRET }, 'FERRUM_ADMIN_JWT_SECRET');
  });

  it('rejects short secrets', () => {
    expectConfigError(baseEnv({ NEXUS_SECRET_KEY: 'too-short' }), 'at least 32 characters');
    expectConfigError(baseEnv({ FERRUM_ADMIN_JWT_SECRET: 'too-short' }), 'at least 32 characters');
  });

  it('leaves NEXUS_BOOTSTRAP_TOKEN unset by default and accepts a long one', () => {
    assert.equal(loadConfig(baseEnv()).bootstrapToken, undefined);
    assert.equal(
      loadConfig(baseEnv({ NEXUS_BOOTSTRAP_TOKEN: '   ' })).bootstrapToken,
      undefined,
      'blank means unset, so the entry point generates one',
    );
    assert.equal(
      loadConfig(baseEnv({ NEXUS_BOOTSTRAP_TOKEN: 'b'.repeat(64) })).bootstrapToken,
      'b'.repeat(64),
    );
  });

  it('rejects a short NEXUS_BOOTSTRAP_TOKEN', () => {
    // A guessable token is worse than none: it looks configured while leaving
    // the founding super_admin election open to anyone who can reach the port.
    expectConfigError(
      baseEnv({ NEXUS_BOOTSTRAP_TOKEN: 'sekret' }),
      'NEXUS_BOOTSTRAP_TOKEN must be at least 16 characters',
    );
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
    assert.equal(
      loadConfig(baseEnv({ NEXUS_DB_ALLOW_STANDALONE: 'TRUE' })).db.allowStandalone,
      true,
    );
    assert.equal(
      loadConfig(baseEnv({ NEXUS_DB_ALLOW_STANDALONE: 'no' })).db.allowStandalone,
      false,
    );
    expectConfigError(baseEnv({ NEXUS_DB_ALLOW_STANDALONE: 'maybe' }), 'true or false');
  });

  it('trusts no proxy unless one is named', () => {
    assert.equal(loadConfig(baseEnv()).trustedProxies, false);
    assert.equal(loadConfig(baseEnv({ NEXUS_TRUSTED_PROXIES: '  ' })).trustedProxies, false);
    assert.equal(loadConfig(baseEnv({ NEXUS_TRUSTED_PROXIES: '2' })).trustedProxies, 2);
    assert.deepEqual(
      loadConfig(baseEnv({ NEXUS_TRUSTED_PROXIES: '10.0.0.0/8, 192.168.1.7 ,loopback' }))
        .trustedProxies,
      ['10.0.0.0/8', '192.168.1.7', 'loopback'],
    );
  });

  it('keeps NEXUS_TRUST_PROXY=true as a deprecated one-hop alias', () => {
    assert.equal(loadConfig(baseEnv({ NEXUS_TRUST_PROXY: 'true' })).trustedProxies, 1);
    assert.equal(loadConfig(baseEnv({ NEXUS_TRUST_PROXY: 'false' })).trustedProxies, false);
    // The explicit variable wins when both are set.
    assert.equal(
      loadConfig(baseEnv({ NEXUS_TRUST_PROXY: 'true', NEXUS_TRUSTED_PROXIES: '3' })).trustedProxies,
      3,
    );
    // …and the alias no longer decides the cookie flag.
    assert.equal(
      loadConfig(baseEnv({ NEXUS_TRUST_PROXY: 'true', NEXUS_ENV: 'development' })).cookieSecure,
      false,
    );
  });

  it('rejects a trusted-proxy list that is neither a hop count nor addresses', () => {
    expectConfigError(baseEnv({ NEXUS_TRUSTED_PROXIES: 'true' }), 'NEXUS_TRUSTED_PROXIES');
    expectConfigError(baseEnv({ NEXUS_TRUSTED_PROXIES: '0' }), 'between 1 and 32');
    expectConfigError(
      baseEnv({ NEXUS_TRUSTED_PROXIES: '10.0.0.1,proxy.example.com' }),
      'proxy.example.com',
    );
  });

  it('defaults cookies to Secure everywhere but development', () => {
    assert.equal(loadConfig(baseEnv({ NEXUS_ENV: 'production' })).cookieSecure, true);
    assert.equal(loadConfig(baseEnv({ NEXUS_ENV: 'test' })).cookieSecure, true);
    assert.equal(loadConfig(baseEnv({ NEXUS_ENV: 'development' })).cookieSecure, false);
    assert.equal(
      loadConfig(baseEnv({ NEXUS_ENV: 'development', NEXUS_COOKIE_SECURE: 'true' })).cookieSecure,
      true,
    );
    assert.equal(
      loadConfig(baseEnv({ NEXUS_ENV: 'production', NEXUS_COOKIE_SECURE: 'off' })).cookieSecure,
      false,
    );
    expectConfigError(baseEnv({ NEXUS_COOKIE_SECURE: 'maybe' }), 'NEXUS_COOKIE_SECURE');
  });

  it('defaults rate-limit counters to local and takes a Redis endpoint', () => {
    const redis = loadConfig(
      baseEnv({
        FERRUM_RATE_LIMIT_SYNC_MODE: 'redis',
        FERRUM_RATE_LIMIT_REDIS_URL: 'rediss://cache.example.com:6380/1',
        FERRUM_RATE_LIMIT_REDIS_TLS: 'true',
      }),
    );
    assert.deepEqual(redis.edge.rateLimit, {
      syncMode: 'redis',
      redisUrl: 'rediss://cache.example.com:6380/1',
      redisTls: true,
    });

    // An endpoint left over from a previous experiment must not be stamped onto
    // plugin configs that say `local` — Edge would reject the combination.
    const local = loadConfig(baseEnv({ FERRUM_RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379/0' }));
    assert.equal(local.edge.rateLimit.syncMode, 'local');
    assert.equal(local.edge.rateLimit.redisUrl, undefined);
  });

  it('rejects an unknown sync mode, a missing endpoint and a non-Redis URL', () => {
    expectConfigError(
      baseEnv({ FERRUM_RATE_LIMIT_SYNC_MODE: 'memcached' }),
      'FERRUM_RATE_LIMIT_SYNC_MODE must be local or redis',
    );
    expectConfigError(
      baseEnv({ FERRUM_RATE_LIMIT_SYNC_MODE: 'redis' }),
      'FERRUM_RATE_LIMIT_REDIS_URL is required when FERRUM_RATE_LIMIT_SYNC_MODE=redis',
    );
    expectConfigError(
      baseEnv({
        FERRUM_RATE_LIMIT_SYNC_MODE: 'redis',
        FERRUM_RATE_LIMIT_REDIS_URL: 'https://cache.example.com',
      }),
      'FERRUM_RATE_LIMIT_REDIS_URL must be a redis:// or rediss:// URL',
    );
  });

  it('reads NEXUS_ALLOW_PRIVATE_UPSTREAMS as a boolean', () => {
    assert.equal(
      loadConfig(baseEnv({ NEXUS_ALLOW_PRIVATE_UPSTREAMS: 'true' })).allowPrivateUpstreams,
      true,
    );
    expectConfigError(
      baseEnv({ NEXUS_ALLOW_PRIVATE_UPSTREAMS: 'sometimes' }),
      'NEXUS_ALLOW_PRIVATE_UPSTREAMS must be true or false',
    );
  });
});
