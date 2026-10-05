import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, request } from 'node:http';
import { after, afterEach, before, describe, it } from 'node:test';

import { SignJWT } from 'jose';

import { aclGroupForApi } from '@ferrum-nexus/shared';

import type { EdgeConfig } from '../config/index.js';
import { isNexusError } from '../lib/errors.js';
import { createEdgePluginBinder } from '../publishing/edge-plugins.js';
import { handOwnedPlugins } from '../publishing/spec-document.js';
import {
  createMockFerrumEdge,
  mockBasicPasswordHash,
  type MockFerrumEdge,
} from '../test/mock-ferrum-edge.js';
import {
  CONSUMER_SCAN_LIMIT,
  createFerrumAdminClient,
  createKeyedSerializer,
  type FerrumAdminClient,
} from './client.js';
import { createAdminTokenMinter, type AdminTokenMinter } from './jwt.js';
import type { EdgeApiSpecDocument, EdgeProxyWrite } from './types.js';

const SECRET = 'ferrum-admin-client-test-secret-0123456789';

let edge: MockFerrumEdge;
let edgeUrl: string;
let client: FerrumAdminClient;

function configFor(url: string, overrides: Partial<EdgeConfig> = {}): EdgeConfig {
  return {
    adminUrl: url,
    jwtSecret: SECRET,
    jwtTtlSeconds: 60,
    jwtIssuer: 'ferrum-edge',
    jwtAudience: undefined,
    namespace: 'nexus',
    gatewayPublicUrl: undefined,
    caFile: undefined,
    allowInsecureHttp: false,
    timeoutMs: 2_000,
    maxCredentialsPerType: 2,
    rateLimit: { syncMode: 'local', redisUrl: undefined, redisTls: false },
    ...overrides,
  };
}

/** Exercise the mock's actual whole-consumer input independently of the metadata builder. */
async function rawConsumerPut(id: string, credentials: unknown, etag: string): Promise<Response> {
  const token = await createAdminTokenMinter(configFor(edgeUrl)).getToken('mock-contract-test');
  return fetch(`${edgeUrl}/consumers/${id}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      'x-ferrum-namespace': 'nexus',
      'content-type': 'application/json',
      'if-match': etag,
    },
    body: JSON.stringify({ id, username: id, credentials, acl_groups: ['approved'] }),
  });
}

describe('ferrum admin client', () => {
  before(async () => {
    edge = createMockFerrumEdge({ jwtSecret: SECRET, issuer: 'ferrum-edge' });
    const url = await edge.start();
    edgeUrl = url;
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
    assert.equal(recorded?.provisionedBy, 'ferrum-nexus');
    assert.equal(recorded?.claims?.role, 'admin');
    assert.equal(recorded?.claims?.iss, 'ferrum-edge');
    assert.equal(recorded?.claims?.sub, 'ferrum-nexus');
    assert.equal(recorded?.claims?.ns, 'nexus', 'the tenancy claim rides on every call');
  });

  it('creates, reads and conditionally replaces from complete consumer verification', async () => {
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

    const snapshot = await client.consumers.verification('user-1');
    assert.ok(snapshot);
    const replaced = await client.consumers.replace(
      'user-1',
      {
        username: fetched?.username ?? '',
        custom_id: fetched?.custom_id ?? null,
        credentials: snapshot.consumer.credentials,
        acl_groups: [aclGroupForApi('api-1')],
      },
      undefined,
      snapshot.etag,
    );
    assert.deepEqual(replaced.acl_groups, ['nexus:api:api-1:approved']);
    assert.deepEqual(
      replaced.credentials.keyauth,
      [{ key: '[REDACTED]' }],
      'ordinary responses stay redacted after a complete replacement',
    );
    assert.equal(
      edge.consumers.get('nexus/user-1')?.credentials.keyauth?.[0]?.key,
      'super-secret-key',
    );
  });

  it('refuses missing tags and unmatched redacted credentials without effects', async () => {
    await client.consumers.create({ id: 'placeholder', username: 'placeholder' });
    const snapshot = await client.consumers.verification('placeholder');
    assert.ok(snapshot);
    const before = structuredClone(edge.consumers.get('nexus/placeholder'));
    const offset = edge.requests.length;
    await assert.rejects(client.consumers.replace('placeholder', { username: 'placeholder' }));
    assert.equal(edge.requests.length, offset, 'missing precondition is refused before dispatch');
    await assert.rejects(
      client.consumers.replace(
        'placeholder',
        { username: 'placeholder', credentials: { keyauth: [{ key: '[REDACTED]' }] } },
        undefined,
        snapshot.etag,
      ),
    );
    assert.deepEqual(edge.consumers.get('nexus/placeholder'), before);
  });

  it('hashes Basic create, append, type replacement and metadata PUT', async () => {
    await client.consumers.create({
      id: 'basic-hashing',
      username: 'basic-hashing',
      credentials: { basicauth: [{ password: 'initial-password' }] },
    });
    const stored = edge.consumers.get('nexus/basic-hashing')!;
    assert.deepEqual(stored.credentials.basicauth, [
      { password_hash: mockBasicPasswordHash('initial-password') },
    ]);
    await client.consumers.addCredential('basic-hashing', 'basicauth', {
      password: 'appended-password',
    });
    assert.deepEqual(stored.credentials.basicauth?.[1], {
      password_hash: mockBasicPasswordHash('appended-password'),
    });
    await client.consumers.replaceCredentials('basic-hashing', 'basicauth', [
      { password: 'replacement-password' },
    ]);
    const snapshot = await client.consumers.verification('basic-hashing');
    assert.deepEqual(snapshot?.consumer.credentials.basicauth, [
      { password_hash: mockBasicPasswordHash('replacement-password') },
    ]);
    await client.consumers.replace(
      'basic-hashing',
      {
        username: stored.username,
        credentials: snapshot!.consumer.credentials,
        acl_groups: ['approved'],
      },
      undefined,
      snapshot!.etag,
    );
    assert.deepEqual(stored.credentials.basicauth, [
      { password_hash: mockBasicPasswordHash('replacement-password') },
    ]);
    assert.deepEqual(stored.acl_groups, ['approved']);
    assert.ok(!JSON.stringify(stored).includes('replacement-password'));
    const refreshed = await client.consumers.verification(stored.id);
    const response = await rawConsumerPut(
      stored.id,
      { basicauth: [{ password: 'whole-consumer-password' }] },
      refreshed!.etag,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(stored.credentials.basicauth, [
      { password_hash: mockBasicPasswordHash('whole-consumer-password') },
    ]);
    assert.ok(!JSON.stringify(await response.json()).includes('whole-consumer-password'));
  });

  it('rejects owner-closed credential fields without effects', async () => {
    const basic = { password: 'secret-password', username: 'unsupported' };
    const jwt = { secret: 's'.repeat(32), issuer: 'unsupported' };
    for (const [type, entry] of [['basicauth', basic], ['jwt', jwt]] as const) {
      await assert.rejects(
        client.consumers.create({
          username: `closed-${type}`,
          credentials: { [type]: [entry] },
        }),
      );
      await client.consumers.create({ id: `closed-${type}`, username: `closed-${type}` });
      const stored = edge.consumers.get(`nexus/closed-${type}`)!;
      const before = structuredClone(stored);
      await assert.rejects(client.consumers.addCredential(stored.id, type, entry));
      await assert.rejects(client.consumers.replaceCredentials(stored.id, type, [entry]));
      const snapshot = await client.consumers.verification(stored.id);
      const response = await rawConsumerPut(stored.id, { [type]: [entry] }, snapshot!.etag);
      assert.equal(response.status, 400);
      await response.arrayBuffer();
      assert.deepEqual(stored, before);
    }
  });

  it('projects legacy known objects and refuses invalid hidden custom history without loss', async () => {
    await client.consumers.create({
      id: 'legacy-objects',
      username: 'legacy-objects',
      credentials: {
        jwt: [{ secret: 'j'.repeat(32) }],
      },
    });
    const stored = edge.consumers.get('nexus/legacy-objects')!;
    // Deliberate raw historical fixture boundary: unknown owner fields are not
    // ordinary typed credential input. Restore history can hold single objects.
    const history = stored.credentials as unknown as Record<string, unknown>;
    history.keyauth = { key: 'prefix[REDACTED]suffix', operator: 'kept' };
    history.custom = [{ marker: '[REDACTED]' }];
    history.jwt = { secret: 'j'.repeat(32), algorithm: 'legacy' };
    const snapshot = await client.consumers.verification(stored.id);
    await client.consumers.replace(
      stored.id,
      {
        username: stored.username,
        credentials: snapshot!.consumer.credentials,
        acl_groups: ['ok'],
      },
      undefined,
      snapshot!.etag,
    );
    assert.deepEqual(stored.credentials, {
      keyauth: [{ key: 'prefix[REDACTED]suffix', operator: 'kept' }],
      jwt: [{ secret: 'j'.repeat(32) }],
      custom: [{ marker: '[REDACTED]' }],
    });
    const invalid = stored.credentials as unknown as Record<string, unknown>;
    invalid.custom = { hidden: 'custom-history-canary' };
    const before = structuredClone(stored);
    const next = await client.consumers.verification(stored.id);
    await assert.rejects(
      client.consumers.replace(
        stored.id,
        { username: stored.username, credentials: next!.consumer.credentials, acl_groups: [] },
        undefined,
        next!.etag,
      ),
      (error: unknown) => {
        assert.ok(isNexusError(error));
        assert.ok(!JSON.stringify(error).includes('custom-history-canary'));
        return true;
      },
    );
    assert.deepEqual(
      stored,
      before,
      'hidden invalid state is retained instead of silently dropped',
    );
  });

  it('refuses unrepresentable Basic history without a write or disclosure', async () => {
    await client.consumers.create({
      id: 'legacy-basic',
      username: 'legacy-basic',
      credentials: { basicauth: [{ password: 'legacy-password-canary' }] },
    });
    const stored = edge.consumers.get('nexus/legacy-basic')!;
    stored.credentials.basicauth![0]!.future = true;
    const snapshot = await client.consumers.verification(stored.id);
    const offset = edge.requests.length;
    await assert.rejects(
      client.consumers.replace(
        stored.id,
        { username: stored.username, credentials: snapshot!.consumer.credentials, acl_groups: [] },
        undefined,
        snapshot!.etag,
      ),
      (error: unknown) => {
        assert.ok(isNexusError(error));
        assert.equal(
          (error.details as { reason: string }).reason,
          'consumer_metadata_unrepresentable',
        );
        assert.ok(!JSON.stringify(error).includes('hmac_sha256:'));
        return true;
      },
    );
    assert.equal(edge.requests.length, offset);
    assert.deepEqual(stored.acl_groups, []);
    const raw = await rawConsumerPut(stored.id, {}, snapshot!.etag);
    assert.equal(raw.status, 400, 'the owner also refuses the restored invalid hidden entry');
    await raw.arrayBuffer();
  });

  it('attributes every provisioning path while retaining caller labels and actor subjects', async () => {
    await client.consumers.create(
      { id: 'attribution-user', username: 'attribution-user', labels: { team: 'platform' } },
      'admin-user',
    );
    await client.proxies.create({
      id: 'attribution-proxy',
      listen_path: '/nexus/attribution',
      backend_host: 'example.com',
      backend_port: 443,
    });
    await client.pluginConfigs.create({
      id: 'attribution-cors',
      plugin_name: 'cors',
      scope: 'proxy',
      proxy_id: 'attribution-proxy',
      enabled: false,
      config: {},
    });
    await client.apiSpecs.create({
      openapi: '3.0.3',
      info: { title: 'Attribution', version: '1' },
      paths: {},
      'x-ferrum-proxy': {
        id: 'attribution-spec',
        listen_path: '/nexus/attribution-spec',
        backend_host: 'example.com',
        backend_port: 443,
      },
    });
    for (const path of ['/consumers', '/proxies', '/plugins/config', '/api-specs']) {
      const recorded = edge.callsTo('POST', path).at(-1);
      assert.equal(recorded?.provisionedBy, 'ferrum-nexus', path);
    }
    const consumer = edge.callsTo('POST', '/consumers').at(-1);
    assert.deepEqual((consumer?.body as { labels: Record<string, string> }).labels, {
      team: 'platform',
    });
    assert.equal(consumer?.claims?.sub, 'admin-user');
    assert.deepEqual((await client.consumers.get('attribution-user'))?.labels, {
      team: 'platform',
    });
  });

  it('finds a consumer by username by scanning the list endpoint', async () => {
    await client.consumers.create({ id: 'u-a', username: 'nexus-user-a' });
    await client.consumers.create({ id: 'u-b', username: 'nexus-user-b' });
    const found = await client.consumers.getByUsername('nexus-user-b');
    assert.equal(found?.id, 'u-b');
    assert.equal(await client.consumers.getByUsername('nexus-user-zz'), null);
  });

  it('refuses to answer "not found" for a namespace the username scan cannot finish', async () => {
    await client.consumers.create({ id: 'u-first', username: 'nexus-user-first' });
    for (let index = 0; index < CONSUMER_SCAN_LIMIT; index += 1) {
      edge.seedConsumer({ username: `filler-${index}`, namespace: 'nexus' });
    }
    // Within the scan: found as ever.
    assert.equal((await client.consumers.getByUsername('nexus-user-first'))?.id, 'u-first');
    // Beyond it: the scan gave up, and says so rather than answering `null`.
    await assert.rejects(
      () => client.consumers.getByUsername('nexus-user-zz'),
      (error: unknown) =>
        isNexusError(error) &&
        error.code === 'EDGE_ERROR' &&
        /more consumers/i.test(error.message) &&
        /restore the consumer id mapping from backup/i.test(error.message),
    );
    // Exactly the cap is still a complete read.
    edge.consumers.delete('nexus/u-first');
    assert.equal(await client.consumers.getByUsername('nexus-user-zz'), null);
  });

  it('does not scan or create after a failed direct identity lookup', async () => {
    edge.queueFailure(503, { error: 'unavailable' }, '/consumers/', 'GET');
    await assert.rejects(() => client.consumers.ensure({ username: 'nexus-user-direct' }));
    assert.equal(edge.callsTo('POST', '/consumers').length, 0);
    assert.equal(
      edge.callsTo('GET', '/consumers').filter((call) => call.path === '/consumers').length,
      0,
    );
  });

  it('does not scan after an uncertain create acknowledgement', async () => {
    edge.queueFailure(503, { error: 'unavailable' }, '/consumers', 'POST');
    await assert.rejects(() => client.consumers.ensure({ username: 'nexus-user-direct' }));
    assert.equal(edge.callsTo('POST', '/consumers').length, 1);
    assert.equal(
      edge.callsTo('GET', '/consumers').filter((call) => call.path === '/consumers').length,
      0,
    );
  });

  it('rejects unsupported mock consumer filters instead of pretending to filter', async () => {
    await assert.rejects(
      // @ts-expect-error Edge does not support username filtering.
      () => client.consumers.list({ username: 'missing' }),
      (error: unknown) => isNexusError(error) && error.code === 'EDGE_ERROR',
    );
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

  it('asks the gateway for one proxy’s configs instead of paging the namespace', async () => {
    for (const id of ['proxy-a', 'proxy-b']) {
      await client.proxies.create({
        id,
        listen_path: `/nexus/${id}`,
        backend_scheme: 'https',
        backend_host: `${id}.internal`,
        backend_port: 443,
        strip_listen_path: true,
      });
      await client.pluginConfigs.create({
        plugin_name: 'key_auth',
        scope: 'proxy',
        proxy_id: id,
        enabled: true,
        config: { key_location: 'header:X-API-Key', hide_credentials: true },
      });
    }
    await client.pluginConfigs.create({
      plugin_name: 'prometheus_metrics',
      scope: 'global',
      enabled: true,
      config: {},
    });

    const before = edge.requests.length;
    const attached = await client.pluginConfigs.listByProxy('proxy-a');
    assert.deepEqual(
      attached.map((config) => config.proxy_id),
      ['proxy-a'],
    );
    const reads = edge.requests.slice(before);
    assert.equal(reads.length, 1, 'one filtered page covers the proxy');
    assert.equal(reads[0]?.path, '/plugins/config');
    assert.deepEqual(reads[0]?.query, { proxy_id: 'proxy-a', limit: '1000', offset: '0' });

    // An unknown proxy is an empty page, as on Edge, and the unfiltered list
    // still returns every config in the namespace.
    assert.deepEqual(await client.pluginConfigs.listByProxy('proxy-missing'), []);
    assert.equal((await client.pluginConfigs.list()).pagination.total, 3);
  });

  it('meets the listen-path admission rules of Edge v0.9.9', async () => {
    // Nexus only writes `/<namespace>/<slug>` and staging paths, which pass;
    // the mock refuses what the pinned gateway refuses, so a regression that
    // wrote one of these would fail here as it would against Edge.
    for (const listenPath of ['/nexus//empty', '/nexus/..;x/dot', '/nexus/matrix;v=1']) {
      await assert.rejects(
        () =>
          client.proxies.create({
            listen_path: listenPath,
            backend_host: 'billing.internal',
            backend_port: 443,
          }),
        (error: unknown) => isNexusError(error) && error.code === 'EDGE_ERROR',
        listenPath,
      );
    }
    assert.equal((await client.proxies.list()).pagination.total, 0);

    // A `;` is admitted on a proxy that opts in to path parameters.
    const optedIn = await client.proxies.create({
      listen_path: '/nexus/matrix;v=1',
      backend_host: 'billing.internal',
      backend_port: 443,
      allow_path_parameters: true,
    } as EdgeProxyWrite);
    assert.equal(optedIn.listen_path, '/nexus/matrix;v=1');
  });

  it('refuses incomplete HTTP proxy snapshots before replacing security associations', async (t) => {
    const proxyId = 'association-snapshot';
    const proxyPath = `/proxies/${proxyId}`;
    const binder = createEdgePluginBinder(client);
    const created = await client.proxies.create({
      id: proxyId,
      listen_path: '/association-snapshot',
      backend_host: 'billing.internal',
      backend_port: 443,
    });
    assert.deepEqual(created.plugins, [], 'an explicit empty snapshot is valid');
    const auth = await binder.attach(proxyId, 'key_auth', {}, 'operator');
    const acl = await binder.attach(
      proxyId,
      'access_control',
      { allowed_groups: [aclGroupForApi('api-1')] },
      'operator',
    );
    await binder.associate(proxyId, [auth.id, acl.id], 'operator');
    const addition = await binder.attach(proxyId, 'basic_auth', null, 'operator');
    const original = await client.proxies.get(proxyId);
    assert.ok(original);
    assert.deepEqual(original.plugins, [
      { plugin_config_id: auth.id },
      { plugin_config_id: acl.id },
    ]);
    const effectiveIds = () => edge.effectivePluginsForProxy(proxyId).map((config) => config.id);
    assert.deepEqual(effectiveIds(), [auth.id, acl.id]);
    const proxyWrites = () =>
      edge.requests.filter((entry) => entry.method === 'PUT' && entry.path === proxyPath).length;
    const writesBefore = proxyWrites();

    let omitPlugins = true;
    let interceptedReads = 0;
    let relayWrites = 0;
    const relay = createServer((req, res) => {
      if (req.method === 'PUT' && req.url === proxyPath) relayWrites += 1;
      if (omitPlugins && req.method === 'GET' && req.url === proxyPath) {
        interceptedReads += 1;
        req.resume();
        // Copy the actual stored proxy, omitting only its association snapshot.
        const stored = edge.proxies.get(`nexus/${proxyId}`);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ...stored, plugins: undefined }));
        return;
      }
      const upstream = request(
        new URL(req.url ?? '/', edge.url),
        { method: req.method, headers: req.headers },
        (response) => {
          res.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(res);
        },
      );
      upstream.on('error', () => res.destroy());
      req.pipe(upstream);
    });
    await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
    const address = relay.address();
    assert.ok(address && typeof address !== 'string');
    const relayed = createFerrumAdminClient(configFor(`http://127.0.0.1:${address.port}`));
    t.after(async () => {
      await relayed.close();
      await new Promise<void>((resolve, reject) => {
        relay.close((error) => (error ? reject(error) : resolve()));
        relay.closeAllConnections();
      });
    });
    const relayedBinder = createEdgePluginBinder(relayed);
    await assert.rejects(
      () => relayedBinder.associate(proxyId, [addition.id], 'operator'),
      (error: unknown) => {
        assert.ok(isNexusError(error));
        assert.equal(error.code, 'EDGE_PROTOCOL_ERROR');
        assert.equal(error.statusCode, 502);
        return true;
      },
    );
    assert.equal(interceptedReads, 1);
    assert.equal(relayWrites, 0, 'no proxy PUT was attempted');
    assert.equal(proxyWrites(), writesBefore);
    assert.deepEqual(edge.proxies.get(`nexus/${proxyId}`), original);
    assert.deepEqual(effectiveIds(), [auth.id, acl.id]);

    omitPlugins = false;
    await relayedBinder.associate(proxyId, [addition.id], 'operator');
    assert.equal(relayWrites, 1);
    assert.equal(proxyWrites(), writesBefore + 1);
    assert.deepEqual(edge.proxies.get(`nexus/${proxyId}`)?.plugins, [
      ...original.plugins,
      { plugin_config_id: addition.id },
    ]);
    assert.deepEqual(effectiveIds(), [auth.id, acl.id, addition.id]);
  });

  it('accepts the one basic_auth config key Edge accepts, and rejects the rest', async () => {
    await client.proxies.create({
      id: 'basic-auth-config',
      listen_path: '/basic-auth-config',
      backend_host: 'billing.internal',
      backend_port: 443,
    });
    const attach = (config: Record<string, unknown>) =>
      client.pluginConfigs.create({
        plugin_name: 'basic_auth',
        scope: 'proxy',
        proxy_id: 'basic-auth-config',
        enabled: true,
        config,
      });

    // Nexus sends `{}`; an operator may set the legacy opt-out by hand.
    assert.deepEqual((await attach({})).config, {});
    assert.deepEqual((await attach({ hide_credentials: false })).config, {
      hide_credentials: false,
    });

    // The key set is still closed — `key_auth`'s other key does not carry over.
    await assert.rejects(
      () => attach({ key_location: 'header:X-API-Key' }),
      (error: unknown) => isNexusError(error) && error.code === 'EDGE_ERROR',
    );
  });

  it('preserves null basic_auth config over HTTP through binder restore and rollback', async () => {
    const binder = createEdgePluginBinder(client);
    const proxyBody = {
      id: 'null-config-proxy',
      listen_path: '/null-config',
      backend_host: 'billing.internal',
      backend_port: 443,
    };
    await client.proxies.create(proxyBody);
    const created = await binder.attach(proxyBody.id, 'basic_auth', null, 'operator');
    await binder.associate(proxyBody.id, [created.id], 'operator');
    const fetched = await client.pluginConfigs.get(created.id);
    assert.ok(fetched);
    assert.equal(fetched.config, null);
    const snapshots = handOwnedPlugins(await binder.listByProxy(proxyBody.id));
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0]?.config, null);

    // A proxy rebuild cascades its configs. Restore must echo the actual null,
    // keep the config id and make the plugin effective on the recreated proxy.
    await client.proxies.delete(proxyBody.id);
    await client.proxies.create(proxyBody);
    await binder.restorePlugins(proxyBody.id, snapshots, 'operator');
    assert.equal((await client.pluginConfigs.get(created.id))?.config, null);
    assert.equal(edge.effectivePluginsForProxy(proxyBody.id)[0]?.id, created.id);
    assert.equal(edge.effectivePluginsForProxy(proxyBody.id)[0]?.config, null);

    // Object settings mean replace; compensation restores the saved null via
    // PUT instead of treating it as the optional-plugin removal sentinel.
    const replaceUndo: (() => Promise<void>)[] = [];
    await binder.reconcileOptionalPlugin(
      proxyBody.id,
      fetched,
      'basic_auth',
      {},
      'operator',
      replaceUndo,
    );
    assert.deepEqual((await client.pluginConfigs.get(created.id))?.config, {});
    for (const undo of replaceUndo.reverse()) await undo();
    assert.equal((await client.pluginConfigs.get(created.id))?.config, null);

    // The optional null argument still means remove. Its undo recreates and
    // associates the saved resource with a null config, rather than deleting it.
    const removeUndo: (() => Promise<void>)[] = [];
    await binder.reconcileOptionalPlugin(
      proxyBody.id,
      fetched,
      'basic_auth',
      null,
      'operator',
      removeUndo,
    );
    assert.equal(await client.pluginConfigs.get(created.id), null);
    assert.deepEqual(edge.effectivePluginsForProxy(proxyBody.id), []);
    for (const undo of removeUndo.reverse()) await undo();
    const restored = await binder.listByProxy(proxyBody.id);
    assert.equal(restored.length, 1);
    assert.equal(restored[0]?.config, null);
    assert.equal(edge.effectivePluginsForProxy(proxyBody.id)[0]?.config, null);
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
    it('restores applied:false details for a non-credential write', async () => {
      edge.queueFailure(
        503,
        {
          error: 'internal detail nobody outside should see',
          applied: false,
          reason: 'private gateway reason',
        },
        '/proxies',
        'POST',
      );
      await assert.rejects(
        () =>
          client.proxies.create({
            listen_path: '/nexus/oops',
            backend_host: 'x.internal',
            backend_port: 443,
          }),
        (error: unknown) => {
          assert.ok(isNexusError(error));
          assert.equal(error.code, 'EDGE_ERROR');
          assert.equal(error.statusCode, 502);
          assert.match(error.message, /has not applied it yet/);
          assert.deepEqual(error.details, { status: 503, reason: 'private gateway reason' });
          return true;
        },
      );
    });

    it('keeps a GET 503 generic', async () => {
      edge.queueFailure(503, { error: 'private read failure' });
      await assert.rejects(
        () => client.consumers.list(),
        (error: unknown) =>
          isNexusError(error) &&
          error.code === 'EDGE_ERROR' &&
          error.message === 'The gateway rejected the request' &&
          JSON.stringify(error.details) === JSON.stringify({ status: 503 }),
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

    it('never exposes credential material echoed in Edge mutation errors or logs', async () => {
      const secret = `credential-canary-${randomUUID()}`;
      const logs: Record<string, unknown>[] = [];
      const logged = createFerrumAdminClient(configFor(edgeUrl), {
        debug: (entry) => logs.push(entry),
        warn: (entry) => logs.push(entry),
        error: (entry) => logs.push(entry),
      });
      try {
        for (const [type, entry] of [
          ['keyauth', { key: secret }],
          ['basicauth', { password: secret }],
          ['jwt', { secret }],
        ] as const) {
          const credentialPath = `/consumers/fixed-consumer-id/credentials/${type}`;
          for (const status of [422, 500]) {
            const logsBefore = logs.length;
            edge.queueFailure(
              status,
              {
                error: `refused ${secret}`,
                reason: `reason ${secret}`,
                details: { echoed: secret },
              },
              '/consumers/',
              'POST',
            );
            await assert.rejects(
              () => logged.consumers.addCredential('fixed-consumer-id', type, entry),
              (error: unknown) => {
                assert.ok(isNexusError(error));
                assert.ok(
                  !JSON.stringify({
                    message: error.message,
                    details: error.details,
                    cause: error.cause,
                    stack: error.stack,
                  }).includes(secret),
                );
                return true;
              },
            );
            assert.ok(logs.length > logsBefore);
            assert.ok(!JSON.stringify(logs.slice(logsBefore)).includes(secret));
            assert.ok(logs.slice(logsBefore).some((entry) => entry.path === credentialPath));
          }
        }
      } finally {
        await logged.close();
      }
    });

    it('classifies credential-write 503 responses without exposing Edge text', async () => {
      for (const [body, details] of [
        [
          {
            error: 'failed with durable secret-canary',
            reason: 'private reason secret-canary',
            applied: false,
          },
          { status: 503, kind: 'write_durable_not_live' },
        ],
        [
          { error: 'uncertain secret-canary', reason: 'private reason secret-canary' },
          { status: 503, kind: 'write_acknowledgement_uncertain' },
        ],
      ] as const) {
        edge.queueFailure(503, body, '/consumers/', 'POST');
        await assert.rejects(
          () => client.consumers.addCredential('fixed-consumer-id', 'keyauth', { key: 'secret' }),
          (error: unknown) => {
            assert.ok(isNexusError(error));
            assert.deepEqual(error.details, details);
            assert.ok(!JSON.stringify(error.toBody()).includes('secret-canary'));
            assert.ok(!JSON.stringify(error.toBody()).includes('reason'));
            return true;
          },
        );
      }
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
        await stamped.assertBackendEgress();

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
          await assert.rejects(
            () => denied.assertBackendEgress(),
            (error: unknown) => isNexusError(error) && error.code === 'EDGE_ERROR',
          );
          await assert.rejects(
            () => denied.consumers.verification('missing'),
            (error: unknown) => isNexusError(error) && error.code === 'EDGE_ERROR',
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

  describe('api specs', () => {
    it('reports parse categories and their distinct details from the mock importer', async () => {
      const malformed = specDocument('bad-extension', '/nexus/bad-extension', ['/invoices']);
      malformed['x-ferrum-proxy'] = { upstream_url: 'https://example.com' };
      for (const [document, code, explanation] of [
        [{}, 'UnknownVersion', 'unknown spec version'],
        [malformed, 'MalformedExtension', 'unknown field: upstream_url'],
      ] as const) {
        await assert.rejects(
          () => client.apiSpecs.create(document),
          (error: unknown) => {
            assert.ok(isNexusError(error));
            assert.equal(error.code, 'EDGE_REJECTED_SPEC');
            assert.equal(error.statusCode, 400);
            assert.ok(error.message.includes(explanation));
            assert.equal((error.details as { gateway_code: string }).gateway_code, code);
            return true;
          },
        );
      }
    });

    it('bounds spec diagnostics and keeps gateway failures opaque', async () => {
      const logs: Record<string, unknown>[] = [];
      const messages: (string | undefined)[] = [];
      const logged = createFerrumAdminClient(configFor(edgeUrl), {
        debug: () => undefined,
        warn: () => undefined,
        error: (entry, message) => {
          logs.push(entry);
          messages.push(message);
        },
      });
      const document = specDocument('diagnostics', '/nexus/diagnostics', ['/invoices']);
      try {
        for (const details of ['x'.repeat(2_000), { private: 'not a string' }]) {
          const rejection = {
            error: 'Spec parse failed',
            code: 'MalformedExtension',
            details,
          };
          edge.queueFailure(422, rejection, '/api-specs', 'POST');
          await assert.rejects(
            () => logged.apiSpecs.create(document),
            (error: unknown) => {
              assert.ok(isNexusError(error));
              assert.equal(error.code, 'EDGE_REJECTED_SPEC');
              assert.ok(!JSON.stringify(error.toBody()).includes('not a string'));
              const diagnostics = error.details as {
                gateway_message: string;
                gateway_code: string;
              };
              assert.equal(diagnostics.gateway_code, 'MalformedExtension');
              assert.equal(
                diagnostics.gateway_message.length,
                typeof details === 'string' ? 500 : 'Spec parse failed'.length,
              );
              return true;
            },
          );
          assert.deepEqual(logs.at(-1)?.gateway_response, rejection);
        }

        const failures = [
          null,
          { resource_type: 'ignored', errors: [42] },
          { resource_type: 'proxy', errors: ['overlapping listen_path', 'not echoed'] },
          { resource_type: 'plugin_config', errors: ['invalid config'] },
          { resource_type: 'proxy', errors: ['x'.repeat(2_000)] },
        ];
        edge.queueFailure(400, { error: 'Spec validation failed', failures }, '/api-specs', 'PUT');
        await assert.rejects(
          () => logged.apiSpecs.replace('diagnostics', document),
          (error: unknown) => {
            assert.ok(isNexusError(error));
            assert.equal(error.code, 'EDGE_REJECTED_SPEC');
            assert.match(
              error.message,
              /proxy: overlapping listen_path; plugin_config: invalid config/,
            );
            assert.ok(!error.message.includes('not echoed'));
            assert.equal(
              (error.details as { gateway_message: string }).gateway_message.length,
              500,
            );
            return true;
          },
        );
        assert.deepEqual(logs.at(-1)?.gateway_response, {
          error: 'Spec validation failed',
          failures,
        });

        for (const status of [401, 403, 500, 503]) {
          edge.queueFailure(
            status,
            { error: 'Spec parse failed', details: 'private detail', code: 'PrivateCode' },
            '/api-specs',
            'POST',
          );
          await assert.rejects(
            () => logged.apiSpecs.create(document),
            (error: unknown) => {
              assert.ok(isNexusError(error));
              assert.equal(error.code, 'EDGE_ERROR');
              assert.equal(error.statusCode, 502);
              assert.deepEqual(error.details, { status });
              assert.ok(!error.message.includes('private detail'));
              return true;
            },
          );
        }

        const before = edge.requests.length;
        document['x-cycle'] = document;
        await assert.rejects(
          () => logged.apiSpecs.create(document),
          (error: unknown) => isNexusError(error) && error.code === 'INTERNAL',
        );
        assert.equal(edge.requests.length, before + 1, 'only the fresh policy read was dispatched');
        assert.equal(edge.requests.at(-1)?.path, '/backend-egress-policy');
        assert.equal(logs.at(-1)?.path, '/api-specs');
        assert.equal(logs.at(-1)?.status, undefined);
        assert.equal(messages.at(-1), 'Ferrum Edge Admin API request serialization failed');
      } finally {
        await logged.close();
      }
    });

    /** A document the importer will accept, owning `proxyId`. */
    function specDocument(
      proxyId: string,
      listenPath: string,
      paths: string[],
    ): EdgeApiSpecDocument {
      return {
        openapi: '3.1.0',
        info: { title: 'Spec API', version: '1.0.0' },
        servers: [{ url: '/' }],
        paths: Object.fromEntries(
          paths.map((path) => [path, { get: { responses: { '200': { description: 'OK' } } } }]),
        ),
        'x-ferrum-proxy': {
          id: proxyId,
          name: `nexus-${proxyId}`,
          listen_path: listenPath,
          backend_host: 'spec.internal',
          backend_port: 443,
          backend_scheme: 'https',
        },
        'x-ferrum-validate': {
          mode: 'block',
          request: { enabled: false },
          response: { enabled: false },
          fail_on_unknown_operation: true,
        },
      };
    }

    it('creates the proxy and its generated validator in one call', async () => {
      const ref = await client.apiSpecs.create(
        specDocument('spec-proxy', '/nexus/spec', ['/invoices', '/invoices/{id}']),
      );

      assert.equal(ref.proxy_id, 'spec-proxy');
      assert.ok(ref.id);

      // The proxy carries the ownership stamp that admission looks for, and the
      // validator is already associated — neither is a separate call.
      const proxy = await client.proxies.get('spec-proxy');
      assert.equal(proxy?.api_spec_id, ref.id);
      const validator = edge.pluginForProxy('spec-proxy', 'openapi_validator');
      assert.ok(validator);
      assert.deepEqual(
        edge.effectivePluginsForProxy('spec-proxy').map((plugin) => plugin.plugin_name),
        ['openapi_validator'],
      );
      // Edge mounts operations beneath the listen prefix itself. A root server
      // base keeps that prefix from appearing twice.
      assert.deepEqual((validator.config as { operations: unknown[] }).operations, [
        {
          method: 'GET',
          path_template: '/nexus/spec/invoices',
          path_regex: '^/nexus/spec/invoices$',
        },
        {
          method: 'GET',
          path_template: '/nexus/spec/invoices/{id}',
          path_regex: '^/nexus/spec/invoices/[^/]+$',
        },
      ]);
    });

    it('admits embedded validator fields only after regenerating its operation table', async () => {
      for (const operations of [undefined, [{ method: 'GET', path_regex: '[' }]]) {
        const id = `embedded-validator-${operations === undefined ? 'missing' : 'stale'}`;
        const document = specDocument(id, '/nexus/embedded', ['/invoices']);
        document['x-ferrum-plugins'] = [
          {
            id: `${id}-routes`,
            plugin_name: 'openapi_validator',
            enabled: true,
            labels: { operator: 'preserve' },
            priority_override: 2_900,
            config: {
              request_content_types: ['application/problem+json'],
              ...(operations === undefined ? {} : { operations }),
            },
          },
        ];
        const ref = await client.apiSpecs.create(document);
        const validator = edge.pluginForProxy(id, 'openapi_validator');
        assert.ok(validator);
        assert.equal(validator.id, `${id}-routes`);
        assert.deepEqual(validator.labels, { operator: 'preserve' });
        assert.equal(validator.priority_override, 2_900);
        assert.deepEqual(
          (validator.config as Record<string, unknown>).request_content_types,
          ['application/problem+json'],
        );
        assert.deepEqual((validator.config as Record<string, unknown>).operations, [
          {
            method: 'GET',
            path_template: '/nexus/embedded/invoices',
            path_regex: '^/nexus/embedded/invoices$',
          },
        ]);
        await client.apiSpecs.delete(ref.id);
      }
      const invalid = specDocument('invalid-embedded', '/nexus/invalid', ['/invoices']);
      invalid['x-ferrum-plugins'] = [
        { plugin_name: 'openapi_validator', config: { unknown_policy_field: true } },
      ];
      await assert.rejects(
        client.apiSpecs.create(invalid),
        (error: unknown) => isNexusError(error) && error.code === 'EDGE_REJECTED_SPEC',
      );
      assert.equal(edge.proxies.has('nexus/invalid-embedded'), false);
    });

    it('models literal root paths and listen/server joins in the importer', async () => {
      const cases = [
        { listen: '/p2/oas2', server: '/', root: '/p2/oas2', item: '/p2/oas2/items/' },
        { listen: '/p2/oas2/', server: '/', root: '/p2/oas2/', item: '/p2/oas2/items/' },
        { listen: '/p2/oas2', server: undefined, root: '/p2/oas2', item: '/p2/oas2/items/' },
        { listen: '/p2/oas2/', server: undefined, root: '/p2/oas2/', item: '/p2/oas2/items/' },
        { listen: '/p2/oas2/', server: '/v1/', root: '/p2/oas2/v1', item: '/p2/oas2/v1/items/' },
        { listen: '/', server: '/', root: '/', item: '/items/' },
        {
          listen: '/audit-main/api-slug/',
          server: 'https://backend.example.test/v1',
          root: '/audit-main/api-slug/v1',
          item: '/audit-main/api-slug/v1/items/',
        },
        {
          listen: '/audit-main/api-slug',
          server: '/audit-main/api-slug',
          root: '/audit-main/api-slug/audit-main/api-slug',
          item: '/audit-main/api-slug/audit-main/api-slug/items/',
        },
      ];
      for (const [index, entry] of cases.entries()) {
        for (const strip of [true, false]) {
          const proxyId = `mount-${index}-${strip}`;
          const document = specDocument(proxyId, entry.listen, ['/', '/items/']);
          if (entry.server === undefined) delete document.servers;
          else document.servers = [{ url: entry.server }];
          const proxy = document['x-ferrum-proxy'] as Record<string, unknown>;
          proxy.strip_listen_path = strip;
          proxy.backend_path = '/backend/base/';
          const ref = await client.apiSpecs.create(document);
          const validator = edge.pluginForProxy(proxyId, 'openapi_validator');
          assert.ok(validator);
          const { operations } = validator.config as { operations: Record<string, unknown>[] };
          assert.deepEqual(
            operations.map((operation) => operation.path_template),
            [entry.root, entry.item],
          );
          for (const [operationIndex, path] of [entry.root, entry.item].entries()) {
            const regex = new RegExp(String(operations[operationIndex]?.path_regex));
            assert.ok(regex.test(path), `${proxyId}: ${path}`);
            assert.ok(!regex.test(`${path}extra`), `${proxyId}: anchored matcher`);
            const alternateSlash = path.endsWith('/') ? path.slice(0, -1) : `${path}/`;
            assert.ok(!regex.test(alternateSlash), `${proxyId}: literal trailing slash`);
          }
          await client.apiSpecs.delete(ref.id);
        }
      }
    });

    it('mounts resolved Path Items using the nearest server override', async () => {
      const document = specDocument('nested-mount', '/audit-main/api-slug/', []);
      document.servers = [{ url: '/root-base' }];
      document.paths = {
        '/root': { get: { responses: { '200': { description: 'OK' } } } },
        '/items': {
          $ref: '#/components/pathItems/Items',
          servers: [{ url: '/sibling-base' }],
        },
        '/alias': { $ref: '#/paths/~1items' },
      };
      document.components = {
        pathItems: {
          Items: {
            servers: [{ url: '/referenced-base' }],
            get: { responses: { '200': { description: 'OK' } } },
            post: {
              servers: [{ url: 'https://backend.example.test/operation-base/' }],
              responses: { '201': { description: 'Created' } },
            },
          },
        },
      };
      await client.apiSpecs.create(document);
      const validator = edge.pluginForProxy('nested-mount', 'openapi_validator');
      assert.ok(validator);
      const { operations } = validator.config as { operations: Record<string, unknown>[] };
      assert.deepEqual(
        operations.map((operation) => `${operation.method} ${operation.path_template}`),
        [
          'GET /audit-main/api-slug/root-base/root',
          'GET /audit-main/api-slug/sibling-base/items',
          'POST /audit-main/api-slug/operation-base/items',
          'GET /audit-main/api-slug/sibling-base/alias',
          'POST /audit-main/api-slug/operation-base/alias',
        ],
      );
    });

    it('refuses a hand-built openapi_validator on a proxy with no spec', async () => {
      // Edge's `validate_openapi_validator_precondition`: the operation table is
      // the gateway's to generate. This is issue #49 in one assertion.
      await client.proxies.create({
        id: 'plain-proxy',
        listen_path: '/nexus/plain',
        backend_host: 'plain.internal',
        backend_port: 443,
      });

      await assert.rejects(
        () =>
          client.pluginConfigs.create({
            plugin_name: 'openapi_validator',
            scope: 'proxy',
            proxy_id: 'plain-proxy',
            enabled: true,
            config: {
              fail_on_unknown_operation: true,
              operations: [
                {
                  method: 'GET',
                  path_template: '/nexus/plain/invoices',
                  path_regex: '^/nexus/plain/invoices$',
                },
              ],
            },
          }),
        (error: unknown) =>
          isNexusError(error) &&
          /openapi_validator requires a proxy with an attached api_spec/.test(error.message),
      );
    });

    it('regenerates the validator on a replace and leaves hand-owned plugins alone', async () => {
      const ref = await client.apiSpecs.create(
        specDocument('replace-proxy', '/nexus/replace', ['/invoices']),
      );
      const generated = String(edge.pluginForProxy('replace-proxy', 'openapi_validator')?.id);
      const auth = await client.pluginConfigs.create({
        plugin_name: 'key_auth',
        scope: 'proxy',
        proxy_id: 'replace-proxy',
        enabled: true,
        config: {},
      });
      const current = await client.proxies.get('replace-proxy');
      assert.ok(current);
      await client.proxies.replace('replace-proxy', {
        ...current,
        plugins: [{ plugin_config_id: generated }, { plugin_config_id: auth.id }],
      });

      await client.apiSpecs.replace(
        ref.id,
        specDocument('replace-proxy', '/nexus/replace', ['/invoices', '/payments']),
      );

      // A new validator row, regenerated from the new document and re-associated.
      const validator = edge.pluginForProxy('replace-proxy', 'openapi_validator');
      assert.notEqual(String(validator?.id), generated);
      assert.deepEqual(
        (validator?.config as { operations: { path_template: string }[] }).operations.map(
          (operation) => operation.path_template,
        ),
        ['/nexus/replace/invoices', '/nexus/replace/payments'],
      );
      // The hand-owned auth plugin is untouched: the API is never open across a
      // spec replace.
      assert.ok(await client.pluginConfigs.get(auth.id));
      assert.deepEqual(
        edge
          .effectivePluginsForProxy('replace-proxy')
          .map((plugin) => String(plugin.plugin_name))
          .sort(),
        ['key_auth', 'openapi_validator'],
      );
    });

    it('finds the spec behind a proxy, and nothing behind one without', async () => {
      const ref = await client.apiSpecs.create(
        specDocument('found-proxy', '/nexus/found', ['/invoices']),
      );
      await client.proxies.create({
        id: 'unowned-proxy',
        listen_path: '/nexus/unowned',
        backend_host: 'unowned.internal',
        backend_port: 443,
      });

      // `/api-specs` pages with its own `items` envelope rather than the
      // `data` + `pagination` shape every other list route uses.
      assert.equal((await client.apiSpecs.findByProxy('found-proxy'))?.id, ref.id);
      assert.equal(await client.apiSpecs.findByProxy('unowned-proxy'), null);
    });

    it('refuses a second spec for a listen path that already exists', async () => {
      await client.apiSpecs.create(specDocument('first-proxy', '/nexus/taken', ['/invoices']));

      await assert.rejects(
        () => client.apiSpecs.create(specDocument('second-proxy', '/nexus/taken', ['/invoices'])),
        (error: unknown) => {
          assert.ok(isNexusError(error));
          assert.equal(error.code, 'EDGE_REJECTED_SPEC');
          assert.equal(error.statusCode, 400);
          assert.match(error.message, /proxy: A proxy with overlapping hosts and listen_path/);
          return true;
        },
      );
    });

    it('cascades both ways between a spec and its proxy', async () => {
      const ref = await client.apiSpecs.create(
        specDocument('cascade-proxy', '/nexus/cascade', ['/invoices']),
      );

      // Deleting the proxy takes the spec and the generated validator with it —
      // which is what makes a proxy delete a complete rollback.
      await client.proxies.delete('cascade-proxy');
      assert.equal(await client.apiSpecs.findByProxy('cascade-proxy'), null);
      assert.equal(edge.pluginsForProxy('cascade-proxy').length, 0);

      const second = await client.apiSpecs.create(
        specDocument('cascade-proxy', '/nexus/cascade', ['/invoices']),
      );
      assert.notEqual(second.id, ref.id);

      // And the other direction.
      await client.apiSpecs.delete(second.id);
      assert.equal(await client.proxies.get('cascade-proxy'), null);
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
        const snapshot = await client.consumers.verification('ser-1');
        if (!snapshot) throw new Error('consumer vanished');
        const current = snapshot.consumer;
        await client.consumers.replace(
          'ser-1',
          {
            username: current.username,
            custom_id: current.custom_id ?? null,
            credentials: current.credentials,
            acl_groups: [...current.acl_groups, aclGroupForApi(apiId)],
          },
          undefined,
          snapshot.etag,
        );
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
