import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';

import { SignJWT } from 'jose';

import { aclGroupForApi } from '@ferrum-nexus/shared';

import type { EdgeConfig } from '../config/index.js';
import { isNexusError } from '../lib/errors.js';
import { createMockFerrumEdge, type MockFerrumEdge } from '../test/mock-ferrum-edge.js';
import {
  createFerrumAdminClient,
  createKeyedSerializer,
  type FerrumAdminClient,
} from './client.js';
import type { AdminTokenMinter } from './jwt.js';

const SECRET = 'ferrum-admin-client-test-secret-0123456789';

let edge: MockFerrumEdge;
let client: FerrumAdminClient;

function configFor(url: string, overrides: Partial<EdgeConfig> = {}): EdgeConfig {
  return {
    adminUrl: url,
    jwtSecret: SECRET,
    jwtTtlSeconds: 60,
    jwtIssuer: 'ferrum-edge',
    jwtAudience: undefined,
    namespace: 'nexus',
    caFile: undefined,
    allowInsecureHttp: false,
    timeoutMs: 2_000,
    maxCredentialsPerType: 2,
    ...overrides,
  };
}

describe('ferrum admin client', () => {
  before(async () => {
    edge = createMockFerrumEdge({ jwtSecret: SECRET, issuer: 'ferrum-edge' });
    const url = await edge.start();
    client = createFerrumAdminClient(configFor(url));
  });

  after(async () => {
    await client.close();
    await edge.stop();
  });

  afterEach(() => {
    edge.reset();
  });

  it('authenticates with an admin JWT and sends the namespace header on every call', async () => {
    await client.consumers.list();
    const recorded = edge.requests.at(-1);
    assert.equal(recorded?.namespace, 'nexus');
    assert.equal(recorded?.claims?.role, 'admin');
    assert.equal(recorded?.claims?.iss, 'ferrum-edge');
    assert.equal(recorded?.claims?.sub, 'ferrum-nexus');
    assert.equal(recorded?.claims?.ns, 'nexus', 'the tenancy claim rides on every call');
  });

  it('creates, reads and replaces a consumer with redacted credentials', async () => {
    const created = await client.consumers.create({
      id: 'user-1',
      username: 'nexus-user-1',
      custom_id: 'nexus:user:1',
      credentials: { keyauth: [{ key: 'super-secret-key' }] },
      acl_groups: [],
    });
    assert.equal(created.id, 'user-1');
    assert.deepEqual(created.credentials.keyauth, [{ key: '[REDACTED]' }]);

    const fetched = await client.consumers.get('user-1');
    assert.equal(fetched?.username, 'nexus-user-1');
    assert.equal(await client.consumers.get('missing'), null, '404 becomes null, not an error');

    const replaced = await client.consumers.replace('user-1', {
      username: fetched?.username ?? '',
      custom_id: fetched?.custom_id ?? null,
      credentials: fetched?.credentials,
      acl_groups: [aclGroupForApi('api-1')],
    });
    assert.deepEqual(replaced.acl_groups, ['nexus:api:api-1:approved']);
    assert.deepEqual(
      replaced.credentials.keyauth,
      [{ key: '[REDACTED]' }],
      'a [REDACTED] placeholder restores the stored key rather than overwriting it',
    );
  });

  it('finds a consumer by username by scanning the list endpoint', async () => {
    await client.consumers.create({ id: 'u-a', username: 'nexus-user-a' });
    await client.consumers.create({ id: 'u-b', username: 'nexus-user-b' });
    const found = await client.consumers.getByUsername('nexus-user-b');
    assert.equal(found?.id, 'u-b');
    assert.equal(await client.consumers.getByUsername('nexus-user-zz'), null);
  });

  it('appends and deletes credentials by index, capped by the gateway', async () => {
    await client.consumers.create({
      id: 'rot-1',
      username: 'nexus-user-rot',
      credentials: { keyauth: [{ key: 'old-key' }] },
    });

    const rotated = await client.consumers.addCredential('rot-1', 'keyauth', { key: 'new-key' });
    assert.equal(rotated.credentials.keyauth?.length, 2);

    await assert.rejects(
      () => client.consumers.addCredential('rot-1', 'keyauth', { key: 'third-key' }),
      (error: unknown) => isNexusError(error) && error.code === 'EDGE_ERROR',
    );

    const finalized = await client.consumers.deleteCredentialAt('rot-1', 'keyauth', 0);
    assert.equal(finalized.credentials.keyauth?.length, 1);
    assert.equal(edge.consumers.get('nexus/rot-1')?.credentials.keyauth?.[0]?.key, 'new-key');
  });

  it('creates a proxy and attaches proxy-scoped plugin configs', async () => {
    const proxy = await client.proxies.create({
      id: 'proxy-1',
      listen_path: '/nexus/billing',
      backend_scheme: 'https',
      backend_host: 'billing.internal',
      backend_port: 443,
      strip_listen_path: true,
    });
    assert.equal(proxy.id, 'proxy-1');

    await client.pluginConfigs.create({
      plugin_name: 'key_auth',
      scope: 'proxy',
      proxy_id: 'proxy-1',
      enabled: true,
      config: { key_location: 'header:X-API-Key', hide_credentials: true },
    });
    await client.pluginConfigs.create({
      plugin_name: 'access_control',
      scope: 'proxy',
      proxy_id: 'proxy-1',
      enabled: true,
      config: { allowed_groups: [aclGroupForApi('api-1')] },
    });

    const attached = await client.pluginConfigs.listByProxy('proxy-1');
    assert.deepEqual(attached.map((config) => config.plugin_name).sort(), [
      'access_control',
      'key_auth',
    ]);

    await client.proxies.delete('proxy-1');
    assert.equal(await client.proxies.get('proxy-1'), null);
    assert.equal((await client.pluginConfigs.listByProxy('proxy-1')).length, 0);
  });

  it('rejects a proxy body carrying an unknown field (Edge denies unknown fields)', async () => {
    await assert.rejects(
      () =>
        client.proxies.create({
          listen_path: '/nexus/oops',
          backend_host: 'x.internal',
          backend_port: 443,
          // @ts-expect-error deliberately sending a field Edge does not know
          priority: 10,
        }),
      (error: unknown) => isNexusError(error) && error.code === 'EDGE_ERROR',
    );
  });

  describe('error mapping', () => {
    it('maps an upstream 503 to EDGE_ERROR without echoing the upstream text', async () => {
      edge.queueFailure(503, {
        error: 'internal detail nobody outside should see',
        applied: false,
      });
      await assert.rejects(
        () => client.consumers.list(),
        (error: unknown) => {
          assert.ok(isNexusError(error));
          assert.equal(error.code, 'EDGE_ERROR');
          assert.equal(error.statusCode, 502);
          assert.ok(!error.message.includes('nobody outside should see'));
          assert.match(error.message, /has not applied it yet/);
          return true;
        },
      );
    });

    it('maps other upstream errors to EDGE_ERROR', async () => {
      edge.queueFailure(500, { error: 'boom' });
      await assert.rejects(
        () => client.consumers.list(),
        (error: unknown) => isNexusError(error) && error.code === 'EDGE_ERROR',
      );

      edge.queueFailure(403, { error: 'role denied' });
      await assert.rejects(
        () => client.consumers.list(),
        (error: unknown) =>
          isNexusError(error) &&
          error.code === 'EDGE_ERROR' &&
          /admin credentials/.test(error.message),
      );
    });

    it('echoes the gateway text on a validation refusal but not on a 5xx', async () => {
      // 400/409/422 describe the caller's own request, so the reason travels.
      edge.queueFailure(409, { error: 'listen_path already exists in this namespace' });
      await assert.rejects(
        () => client.consumers.list(),
        (error: unknown) => {
          assert.ok(isNexusError(error));
          assert.equal(error.code, 'EDGE_ERROR');
          assert.match(error.message, /listen_path already exists/);
          assert.deepEqual(error.details, {
            status: 409,
            gateway_message: 'listen_path already exists in this namespace',
          });
          return true;
        },
      );

      // A 500 is about the gateway's own state and stays opaque.
      edge.queueFailure(500, { error: 'internal detail nobody outside should see' });
      await assert.rejects(
        () => client.consumers.list(),
        (error: unknown) => {
          assert.ok(isNexusError(error));
          assert.ok(!error.message.includes('nobody outside should see'));
          assert.deepEqual(error.details, { status: 500 });
          return true;
        },
      );
    });

    it('trims a runaway gateway message to 500 characters', async () => {
      edge.queueFailure(400, { error: 'x'.repeat(2_000) });
      await assert.rejects(
        () => client.consumers.list(),
        (error: unknown) => {
          assert.ok(isNexusError(error));
          const { gateway_message: message } = error.details as { gateway_message: string };
          assert.equal(message.length, 500);
          return true;
        },
      );
    });

    it('maps a refused connection to EDGE_UNAVAILABLE', async () => {
      // Port 1 is reserved and never listening.
      const offline = createFerrumAdminClient(configFor('http://127.0.0.1:1'));
      try {
        await assert.rejects(
          () => offline.consumers.list(),
          (error: unknown) => {
            assert.ok(isNexusError(error));
            assert.equal(error.code, 'EDGE_UNAVAILABLE');
            assert.equal(error.statusCode, 502);
            return true;
          },
        );
      } finally {
        await offline.close();
      }
    });
  });

  describe('probes', () => {
    const READY_HEALTH = {
      status: 'ok',
      ready: true,
      mode: 'database',
      admin_writes_enabled: true,
      database: { status: 'connected', type: 'sqlite' },
    };

    it('reports the gateway mode and tolerates a missing /version endpoint', async () => {
      const probe = await client.probe();
      assert.equal(probe.reachable, true);
      assert.equal(probe.status, 'ok');
      assert.equal(probe.ready, true);
      assert.equal(probe.mode, 'database');
      assert.equal(probe.adminWritesEnabled, true);
      assert.equal(probe.version, null, 'Edge has no /version endpoint');
      assert.equal(probe.error, null);
    });

    it('parses the 503 health payload Edge serves while it is not ready', async () => {
      // `starting` / `draining` / `unavailable` all come back as a 503 with a
      // complete HealthResponse. That is a reachable gateway, not a failure.
      edge.setHealth({
        status: 'draining',
        ready: false,
        mode: 'database',
        admin_writes_enabled: false,
      });
      try {
        const health = await client.health();
        assert.equal(health.status, 'draining');
        assert.equal(health.ready, false);

        const probe = await client.probe();
        assert.equal(probe.reachable, true, 'a 503 health payload is not "unreachable"');
        assert.equal(probe.status, 'draining');
        assert.equal(probe.ready, false);
        assert.equal(probe.adminWritesEnabled, false);
        assert.equal(probe.error, null);
      } finally {
        edge.setHealth(READY_HEALTH);
      }
    });

    it('still treats a 503 that is not a health payload as a failure', async () => {
      edge.queueFailure(503, { error: 'database unavailable' }, '/health');
      const probe = await client.probe();
      assert.equal(probe.reachable, false);
      assert.equal(probe.ready, null);
      assert.ok(probe.error);
    });

    it('never throws when the gateway is unreachable', async () => {
      const offline = createFerrumAdminClient(configFor('http://127.0.0.1:1'));
      try {
        const probe = await offline.probe();
        assert.equal(probe.reachable, false);
        assert.equal(probe.status, null);
        assert.equal(probe.ready, null);
        assert.ok(probe.error);
      } finally {
        await offline.close();
      }
    });
  });

  describe('namespace claim enforcement', () => {
    /** A minter that signs whatever claims a test wants, `ns` included or not. */
    function minterStamping(extra: Record<string, unknown>): AdminTokenMinter {
      return {
        async getToken(subject = 'ferrum-nexus'): Promise<string> {
          const now = Math.floor(Date.now() / 1000);
          return new SignJWT({ role: 'admin', ...extra })
            .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
            .setIssuer('ferrum-edge')
            .setSubject(subject)
            .setIssuedAt(now)
            .setNotBefore(now)
            .setExpirationTime(now + 60)
            .setJti(randomUUID())
            .sign(new TextEncoder().encode(SECRET));
        },
        clearCache(): void {},
        size(): number {
          return 0;
        },
      };
    }

    it('works against a gateway requiring the ns claim, and 403s without one', async () => {
      const strict = createMockFerrumEdge({
        jwtSecret: SECRET,
        issuer: 'ferrum-edge',
        requireNamespaceClaim: true,
      });
      const url = await strict.start();
      const stamped = createFerrumAdminClient(configFor(url));
      const unstamped = createFerrumAdminClient(configFor(url), undefined, {
        minter: minterStamping({}),
      });
      const wrongTenant = createFerrumAdminClient(configFor(url), undefined, {
        minter: minterStamping({ ns: ['nexus-staging'] }),
      });

      try {
        // The real minter stamps `ns`, so the ordinary client just works.
        const page = await stamped.consumers.list();
        assert.equal(page.pagination.total, 0);

        for (const [label, denied] of [
          ['a token with no ns claim', unstamped],
          ['a token scoped to another namespace', wrongTenant],
        ] as const) {
          await assert.rejects(
            () => denied.consumers.list(),
            (error: unknown) => {
              assert.ok(isNexusError(error), label);
              assert.equal(error.code, 'EDGE_ERROR');
              assert.match(error.message, /admin credentials/);
              return true;
            },
            label,
          );
        }
      } finally {
        await stamped.close();
        await unstamped.close();
        await wrongTenant.close();
        await strict.stop();
      }
    });

    it('rejects a malformed ns claim even with enforcement off', async () => {
      const lax = createFerrumAdminClient(configFor(edge.url), undefined, {
        // A non-string entry is a garbled tenancy claim; Edge 401s at
        // authentication time so it can never widen access.
        minter: minterStamping({ ns: ['nexus', 7] }),
      });
      try {
        await assert.rejects(
          () => lax.consumers.list(),
          (error: unknown) => isNexusError(error) && error.code === 'EDGE_ERROR',
        );
      } finally {
        await lax.close();
      }
    });
  });

  describe('plugin config validation', () => {
    it('rejects a rate_limiting quota above the gateway ceiling', async () => {
      await client.proxies.create({
        id: 'rl-proxy',
        listen_path: '/nexus/rl',
        backend_host: 'rl.internal',
        backend_port: 443,
      });

      await assert.rejects(
        () =>
          client.pluginConfigs.create({
            plugin_name: 'rate_limiting',
            scope: 'proxy',
            proxy_id: 'rl-proxy',
            enabled: true,
            // Edge caps max_requests at 1_000_000; one digit too many is a 400.
            config: { limits: [{ scope: 'default', window_seconds: 60, max_requests: 1_000_001 }] },
          }),
        (error: unknown) => {
          assert.ok(isNexusError(error));
          assert.equal(error.code, 'EDGE_ERROR');
          assert.match(error.message, /max_requests/);
          return true;
        },
      );

      // The same rule one below the ceiling is accepted.
      const accepted = await client.pluginConfigs.create({
        plugin_name: 'rate_limiting',
        scope: 'proxy',
        proxy_id: 'rl-proxy',
        enabled: true,
        config: { limits: [{ scope: 'default', window_seconds: 60, max_requests: 1_000_000 }] },
      });
      assert.equal(accepted.plugin_name, 'rate_limiting');
    });

    it('requires a non-empty cors allowed_origins', async () => {
      await client.proxies.create({
        id: 'cors-proxy',
        listen_path: '/nexus/cors',
        backend_host: 'cors.internal',
        backend_port: 443,
      });

      await assert.rejects(
        () =>
          client.pluginConfigs.create({
            plugin_name: 'cors',
            scope: 'proxy',
            proxy_id: 'cors-proxy',
            enabled: true,
            config: { allowed_origins: [] },
          }),
        (error: unknown) => isNexusError(error) && /allowed_origins/.test(error.message),
      );

      const created = await client.pluginConfigs.create({
        plugin_name: 'cors',
        scope: 'proxy',
        proxy_id: 'cors-proxy',
        enabled: true,
        config: { allowed_origins: ['https://portal.example.com'], allow_credentials: true },
      });
      assert.equal(created.plugin_name, 'cors');
    });
  });

  describe('proxy plugin associations', () => {
    it('refuses an association Edge would refuse', async () => {
      await client.proxies.create({
        id: 'assoc-a',
        listen_path: '/nexus/assoc-a',
        backend_host: 'a.internal',
        backend_port: 443,
      });
      await client.proxies.create({
        id: 'assoc-b',
        listen_path: '/nexus/assoc-b',
        backend_host: 'b.internal',
        backend_port: 443,
      });
      const onA = await client.pluginConfigs.create({
        id: 'cfg-on-a',
        plugin_name: 'key_auth',
        scope: 'proxy',
        proxy_id: 'assoc-a',
        enabled: true,
        config: {},
      });
      await client.pluginConfigs.create({
        id: 'cfg-global',
        plugin_name: 'access_control',
        scope: 'global',
        enabled: true,
        config: { allowed_groups: [aclGroupForApi('api-1')] },
      });

      const rejects = async (plugins: unknown, pattern: RegExp): Promise<void> => {
        await assert.rejects(
          () =>
            client.proxies.replace('assoc-b', {
              listen_path: '/nexus/assoc-b',
              backend_host: 'b.internal',
              backend_port: 443,
              // @ts-expect-error `plugins` is not part of the narrow Nexus write shape
              plugins,
            }),
          (error: unknown) => {
            assert.ok(isNexusError(error));
            assert.match(error.message, pattern);
            return true;
          },
        );
      };

      await rejects([{ plugin_config_id: 'nope' }], /non-existent plugin_config/);
      await rejects([{ plugin_config_id: 'cfg-global' }], /scope 'global'/);
      await rejects([{ plugin_config_id: onA.id }], /targeted to proxy 'assoc-a'/);
      await rejects(
        [{ plugin_config_id: 'cfg-on-a' }, { plugin_config_id: 'cfg-on-a' }],
        /more than once/,
      );
    });

    it('separates the plugin configs Edge stores from the ones it would run', async () => {
      await client.proxies.create({
        id: 'eff-proxy',
        listen_path: '/nexus/eff',
        backend_host: 'eff.internal',
        backend_port: 443,
      });
      const config = await client.pluginConfigs.create({
        id: 'eff-key-auth',
        plugin_name: 'key_auth',
        scope: 'proxy',
        proxy_id: 'eff-proxy',
        enabled: true,
        config: {},
      });

      // Written but never associated: live Edge would not install it.
      assert.equal(edge.pluginsForProxy('eff-proxy').length, 1);
      assert.deepEqual(edge.effectivePluginsForProxy('eff-proxy'), []);

      await client.proxies.replace('eff-proxy', {
        listen_path: '/nexus/eff',
        backend_host: 'eff.internal',
        backend_port: 443,
        // @ts-expect-error `plugins` is not part of the narrow Nexus write shape
        plugins: [{ plugin_config_id: config.id }],
      });
      assert.deepEqual(
        edge.effectivePluginsForProxy('eff-proxy').map((entry) => entry.id),
        ['eff-key-auth'],
      );
    });
  });

  describe('serializePerKey', () => {
    it('prevents concurrent read-modify-write updates from losing an ACL group', async () => {
      await client.consumers.create({ id: 'ser-1', username: 'nexus-user-ser', acl_groups: [] });

      const addGroup = async (apiId: string): Promise<void> => {
        const current = await client.consumers.get('ser-1');
        if (!current) throw new Error('consumer vanished');
        await client.consumers.replace('ser-1', {
          username: current.username,
          custom_id: current.custom_id ?? null,
          credentials: current.credentials,
          acl_groups: [...current.acl_groups, aclGroupForApi(apiId)],
        });
      };

      await Promise.all([
        client.serializePerKey('ser-1', () => addGroup('api-a')),
        client.serializePerKey('ser-1', () => addGroup('api-b')),
      ]);

      const stored = edge.consumers.get('nexus/ser-1');
      assert.deepEqual(stored?.acl_groups.sort(), [
        'nexus:api:api-a:approved',
        'nexus:api:api-b:approved',
      ]);
    });

    it('runs different keys concurrently but one key in order', async () => {
      const serialize = createKeyedSerializer();
      const order: string[] = [];
      const task = (label: string, delay: number) => async (): Promise<void> => {
        order.push(`${label}:start`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        order.push(`${label}:end`);
      };

      await Promise.all([
        serialize('a', task('a1', 20)),
        serialize('a', task('a2', 0)),
        serialize('b', task('b1', 0)),
      ]);

      assert.ok(order.indexOf('a1:end') < order.indexOf('a2:start'), 'same key is serialised');
      assert.ok(order.indexOf('b1:start') < order.indexOf('a1:end'), 'other keys are not blocked');
    });

    it('keeps the queue alive after a rejected task', async () => {
      const serialize = createKeyedSerializer();
      await assert.rejects(() => serialize('k', async () => Promise.reject(new Error('nope'))));
      assert.equal(await serialize('k', async () => 'recovered'), 'recovered');
    });
  });
});
