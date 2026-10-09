import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decodeJwt, decodeProtectedHeader, jwtVerify } from 'jose';

import type { EdgeConfig } from '../config/index.js';
import { isNexusError } from '../lib/errors.js';
import {
  createAdminTokenMinter,
  createFleetReadTokenMinter,
  signAdminJwt,
  DEFAULT_ADMIN_SUBJECT,
} from './jwt.js';

const SECRET = 'ferrum-admin-jwt-secret-0123456789abcdef';

function edgeConfig(overrides: Partial<EdgeConfig> = {}): EdgeConfig {
  return {
    adminUrl: 'http://127.0.0.1:9000',
    jwtSecret: SECRET,
    jwtTtlSeconds: 60,
    jwtIssuer: 'ferrum-edge',
    jwtAudience: undefined,
    namespace: 'nexus',
    gatewayPublicUrl: undefined,
    caFile: undefined,
    allowInsecureHttp: false,
    timeoutMs: 5_000,
    maxCredentialsPerType: 2,
    rateLimit: { syncMode: 'local', redisUrl: undefined, redisTls: false },
    ...overrides,
  };
}

describe('signAdminJwt', () => {
  it('stamps every claim Ferrum Edge requires, and no aud by default', async () => {
    const token = await signAdminJwt({
      secret: SECRET,
      issuer: 'ferrum-edge',
      subject: DEFAULT_ADMIN_SUBJECT,
      role: 'admin',
      namespace: 'nexus',
      ttlSeconds: 60,
    });

    assert.equal(decodeProtectedHeader(token).alg, 'HS256');
    const claims = decodeJwt(token);
    assert.equal(claims.iss, 'ferrum-edge');
    assert.equal(claims.sub, 'ferrum-nexus');
    assert.equal(claims.role, 'admin');
    assert.equal(typeof claims.jti, 'string');
    assert.equal(typeof claims.iat, 'number');
    assert.equal(claims.nbf, claims.iat, 'nbf equals iat');
    assert.equal(claims.exp, (claims.iat ?? 0) + 60);
    assert.equal(
      claims.ns,
      'nexus',
      'a gateway with FERRUM_ADMIN_REQUIRE_NAMESPACE_CLAIM=true needs the ns claim',
    );
    assert.equal(typeof claims.ns, 'string', 'ns is stamped in the single-string form');
    assert.ok(!('aud' in claims), 'an unexpected aud is rejected by Edge, so it is never stamped');

    const verified = await jwtVerify(token, new TextEncoder().encode(SECRET), {
      issuer: 'ferrum-edge',
      algorithms: ['HS256'],
    });
    assert.equal(verified.payload.role, 'admin');
  });

  it('stamps aud only when an audience is configured', async () => {
    const token = await signAdminJwt({
      secret: SECRET,
      issuer: 'ferrum-edge',
      subject: 'ferrum-nexus',
      role: 'admin',
      namespace: 'nexus',
      audience: 'ferrum-gateway',
      ttlSeconds: 60,
    });
    assert.equal(decodeJwt(token).aud, 'ferrum-gateway');
  });

  it('mints a unique jti per token', async () => {
    const options = {
      secret: SECRET,
      issuer: 'ferrum-edge',
      subject: 'ferrum-nexus',
      role: 'admin' as const,
      namespace: 'nexus',
      ttlSeconds: 60,
    };
    const first = decodeJwt(await signAdminJwt(options));
    const second = decodeJwt(await signAdminJwt(options));
    assert.notEqual(first.jti, second.jti);
  });

  it('rejects invalid signing inputs', async () => {
    const base = {
      secret: SECRET,
      issuer: 'ferrum-edge',
      subject: 'ferrum-nexus',
      role: 'admin' as const,
      namespace: 'nexus',
      ttlSeconds: 60,
    };
    const isConfigError = (error: unknown): boolean =>
      isNexusError(error) && error.code === 'INTERNAL';

    await assert.rejects(() => signAdminJwt({ ...base, secret: 'short' }), isConfigError);
    await assert.rejects(() => signAdminJwt({ ...base, issuer: '  ' }), isConfigError);
    await assert.rejects(() => signAdminJwt({ ...base, subject: '' }), isConfigError);
    await assert.rejects(() => signAdminJwt({ ...base, ttlSeconds: 0 }), isConfigError);
    await assert.rejects(() => signAdminJwt({ ...base, ttlSeconds: 7_200 }), isConfigError);
    // Edge treats an empty `ns` entry as a malformed claim and 401s on it.
    await assert.rejects(() => signAdminJwt({ ...base, namespace: '  ' }), isConfigError);
    // A token without `ns` is fleet-wide; it may never claim more than `viewer`.
    await assert.rejects(() => signAdminJwt({ ...base, namespace: null }), isConfigError);
    await assert.rejects(
      () => signAdminJwt({ ...base, role: 'operator', namespace: null }),
      isConfigError,
    );
  });

  it('omits ns only for a viewer token given no namespace', async () => {
    const token = await signAdminJwt({
      secret: SECRET,
      issuer: 'ferrum-edge',
      subject: DEFAULT_ADMIN_SUBJECT,
      role: 'viewer',
      namespace: null,
      ttlSeconds: 60,
    });
    const claims = decodeJwt(token);
    assert.equal(claims.role, 'viewer');
    assert.ok(!('ns' in claims));
  });
});

describe('createFleetReadTokenMinter', () => {
  const FLEET_SECRET = 'ferrum-admin-viewer-key-0123456789abcdef';

  it('is absent unless a fleet-read key is configured', () => {
    assert.equal(createFleetReadTokenMinter(edgeConfig()), null);
  });

  it('mints claim-less viewer tokens with the fleet-read key, whatever role is asked', async () => {
    const minter = createFleetReadTokenMinter(edgeConfig({ fleetReadJwtSecret: FLEET_SECRET }));
    assert.ok(minter);
    const token = await minter.getToken(DEFAULT_ADMIN_SUBJECT, 'admin');
    const claims = decodeJwt(token);
    assert.equal(claims.role, 'viewer');
    assert.ok(!('ns' in claims), 'the token reaches fleet-global reads only without a claim');

    await jwtVerify(token, new TextEncoder().encode(FLEET_SECRET), { algorithms: ['HS256'] });
    await assert.rejects(() =>
      jwtVerify(token, new TextEncoder().encode(SECRET), { algorithms: ['HS256'] }),
    );
  });

  it('never shares a cache entry with the admin minter', async () => {
    const config = edgeConfig({ jwtTtlSeconds: 600, fleetReadJwtSecret: FLEET_SECRET });
    const admin = await createAdminTokenMinter(config).getToken();
    const fleet = await createFleetReadTokenMinter(config)?.getToken();
    assert.notEqual(admin, fleet);
    assert.equal(decodeJwt(admin).ns, 'nexus');
  });
});

describe('createAdminTokenMinter', () => {
  it('reuses a cached token while it still has life left', async () => {
    const minter = createAdminTokenMinter(edgeConfig({ jwtTtlSeconds: 600 }));
    const first = await minter.getToken();
    const second = await minter.getToken();
    assert.equal(first, second);
    assert.equal(minter.size(), 1);
  });

  it('caches per subject and role', async () => {
    const minter = createAdminTokenMinter(edgeConfig({ jwtTtlSeconds: 600 }));
    const platform = await minter.getToken();
    const onBehalf = await minter.getToken('nexus-user:abc');
    assert.notEqual(platform, onBehalf);
    assert.equal(decodeJwt(onBehalf).sub, 'nexus-user:abc');
    assert.equal(minter.size(), 2);
  });

  it('re-mints whenever the token is inside the refresh window', async () => {
    // The refresh buffer is min(60, max(1, ttl / 4)). With ttl = 5 the buffer
    // is 1s, so a token is only reused while more than 4s of life remain —
    // with ttl = 5 that is immediately true, and with ttl = 5 and a buffer
    // equal to the whole lifetime it is never true. Use ttl = 5 for the reuse
    // case and ttl = 1 (buffer == ttl) for the always-refresh case.
    const shortLived = createAdminTokenMinter(edgeConfig({ jwtTtlSeconds: 1 }));
    const first = await shortLived.getToken();
    const second = await shortLived.getToken();
    assert.notEqual(decodeJwt(first).jti, decodeJwt(second).jti);

    const longLived = createAdminTokenMinter(edgeConfig({ jwtTtlSeconds: 5 }));
    assert.equal(await longLived.getToken(), await longLived.getToken());
  });

  it('clears the cache on demand', async () => {
    const minter = createAdminTokenMinter(edgeConfig({ jwtTtlSeconds: 600 }));
    await minter.getToken();
    assert.equal(minter.size(), 1);
    minter.clearCache();
    assert.equal(minter.size(), 0);
  });

  it('stamps the configured namespace and keys the cache on it', async () => {
    const staging = createAdminTokenMinter(edgeConfig({ jwtTtlSeconds: 600 }));
    assert.equal(decodeJwt(await staging.getToken()).ns, 'nexus');

    // Two minters differing only in namespace must not share a cache entry,
    // or one tenant's token would be handed to the other's calls.
    const other = createAdminTokenMinter(
      edgeConfig({ jwtTtlSeconds: 600, namespace: 'nexus-staging' }),
    );
    assert.equal(decodeJwt(await other.getToken()).ns, 'nexus-staging');
  });
});
