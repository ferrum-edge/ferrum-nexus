import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it, type TestContext } from 'node:test';

import type { EdgeConfig } from '../config/index.js';
import { isNexusError } from '../lib/errors.js';
import {
  ADMIN_RESPONSE_MAX_BYTES,
  createFerrumAdminClient,
  type FerrumAdminClient,
} from './client.js';

const consumer = {
  id: 'consumer-1',
  namespace: 'nexus',
  username: 'alice',
  credentials: { keyauth: [{ key: '[REDACTED]' }] },
  acl_groups: ['approved'],
};
const proxy = { id: 'proxy-1', namespace: 'nexus', listen_path: '/billing' };
const plugin = {
  id: 'plugin-1',
  namespace: 'nexus',
  plugin_name: 'basic_auth',
  scope: 'proxy',
  proxy_id: 'proxy-1',
  enabled: true,
  config: null,
};

async function fixture(t: TestContext) {
  const reply: { status: number; body: string | Buffer; location: string; disconnect: boolean } = {
    status: 200,
    body: '',
    location: '/redirect-target',
    disconnect: false,
  };
  const requests: string[] = [];
  const logs: unknown[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    req.resume();
    if (reply.disconnect) {
      req.on('end', () => req.socket.destroy());
      return;
    }
    res.writeHead(reply.status, {
      'content-type': 'application/json',
      location: reply.location,
    });
    res.end(reply.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const config: EdgeConfig = {
    adminUrl: `http://127.0.0.1:${address.port}`,
    jwtSecret: 'socket-test-admin-secret-0123456789abcdef',
    jwtTtlSeconds: 60,
    jwtIssuer: 'ferrum-edge',
    jwtAudience: undefined,
    namespace: 'nexus',
    gatewayPublicUrl: undefined,
    caFile: undefined,
    allowInsecureHttp: true,
    timeoutMs: 5_000,
    maxCredentialsPerType: 2,
    rateLimit: { syncMode: 'local', redisUrl: undefined, redisTls: false },
  };
  const client = createFerrumAdminClient(config, {
    debug: (obj) => logs.push(obj),
    warn: (obj) => logs.push(obj),
    error: (obj) => logs.push(obj),
  });
  t.after(async () => {
    await client.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
  return { client, reply, requests, logs };
}

function protocolFailure(error: unknown): boolean {
  assert.ok(isNexusError(error));
  assert.equal(error.code, 'EDGE_PROTOCOL_ERROR');
  assert.equal(error.statusCode, 502);
  assert.equal((error.details as { kind: string }).kind, 'protocol_error');
  return true;
}

describe('Edge response contracts over HTTP sockets', () => {
  const resourceReads: [string, (client: FerrumAdminClient) => Promise<unknown>, unknown][] = [
    ['consumer', (client) => client.consumers.get('consumer-1'), consumer],
    ['proxy', (client) => client.proxies.get('proxy-1'), proxy],
    ['plugin', (client) => client.pluginConfigs.get('plugin-1'), plugin],
  ];

  for (const [name, read, valid] of resourceReads) {
    it(`${name}: only a 404 means absent; valid resources survive intact`, async (t) => {
      const { client, reply, requests, logs } = await fixture(t);
      for (const status of [201, 202, 204, 205, 206, 301, 302, 303, 304, 307, 308]) {
        for (const body of ['', JSON.stringify(valid)]) {
          Object.assign(reply, { status, body });
          const before = requests.length;
          await assert.rejects(() => read(client), protocolFailure);
          assert.equal(requests.length, before + 1, 'no redirect follow or automatic retry');
        }
      }
      for (const body of ['', ' ', '<html>private-canary</html>', '{', 'null', '[]', '{}', '42']) {
        Object.assign(reply, { status: 200, body });
        await assert.rejects(() => read(client), protocolFailure);
      }
      for (const body of ['', '<html>missing</html>', '{"error":"not found"}']) {
        Object.assign(reply, { status: 404, body });
        assert.equal(await read(client), null);
      }
      Object.assign(reply, { status: 200, body: JSON.stringify(valid) });
      assert.deepEqual(await read(client), valid);
      assert.ok(!requests.some((entry) => entry.includes('/redirect-target')));
      assert.ok(!JSON.stringify(logs).includes('private-canary'));
    });
  }

  it('refuses malformed consumer fields rather than inferring missing credentials', async (t) => {
    const { client, reply } = await fixture(t);
    for (const overrides of [
      { id: null },
      { id: 'another-consumer' },
      { namespace: 1 },
      { namespace: 'another-namespace' },
      { username: null },
      { credentials: null },
      { credentials: [] },
      { credentials: { keyauth: 'not-an-array' } },
      { credentials: { keyauth: [null] } },
      { credentials: { keyauth: [{}] } },
      { acl_groups: null },
      { acl_groups: [1] },
    ]) {
      reply.body = JSON.stringify({ ...consumer, ...overrides });
      await assert.rejects(() => client.consumers.get('consumer-1'), protocolFailure);
    }
  });

  it('requires valid pages before nullable scans can conclude absence', async (t) => {
    const { client, reply } = await fixture(t);
    const scans = [
      () => client.consumers.getByUsername('missing'),
      () => client.pluginConfigs.listByProxy('missing'),
      () => client.apiSpecs.findByProxy('missing'),
      () => client.listNamespaces(),
    ];
    for (const scan of scans) {
      for (const body of ['null', '{}', '[]', '{"data":[]}', '{"items":[]}']) {
        reply.body = body;
        await assert.rejects(scan, protocolFailure);
      }
    }
    reply.body = JSON.stringify({ data: [], pagination: { offset: 0, limit: 500, total: 1 } });
    await assert.rejects(() => client.consumers.getByUsername('missing'), protocolFailure);
    reply.body = JSON.stringify({ data: [], pagination: { offset: 0, limit: 500, total: 0 } });
    assert.equal(await client.consumers.getByUsername('missing'), null);
    reply.body = JSON.stringify({ data: [], pagination: { offset: 0, limit: 1, total: 0 } });
    await assert.rejects(() => client.consumers.getByUsername('missing'), protocolFailure);
    reply.body = JSON.stringify({ data: [], pagination: { offset: 0, limit: 1000, total: 0 } });
    assert.deepEqual(await client.pluginConfigs.listByProxy('missing'), []);
    assert.deepEqual(await client.listNamespaces(), []);
    reply.body = JSON.stringify({ items: [], offset: 0, limit: 1, total: 0 });
    assert.equal(await client.apiSpecs.findByProxy('missing'), null);
    reply.body = JSON.stringify({ items: [{}], offset: 0, limit: 1, total: 1 });
    await assert.rejects(() => client.apiSpecs.findByProxy('missing'), protocolFailure);
    const spec = { id: 'spec-1', proxy_id: 'proxy-1' };
    reply.body = JSON.stringify({ items: [spec], offset: 0, limit: 1, total: 1 });
    assert.deepEqual(await client.apiSpecs.findByProxy('proxy-1'), spec);
  });

  it('accepts 204 deletes and requires bodies for credential-index deletes', async (t) => {
    const { client, reply, requests } = await fixture(t);
    const deletes = [
      () => client.consumers.delete('consumer-1'),
      () => client.consumers.deleteCredentialType('consumer-1', 'keyauth'),
      () => client.proxies.delete('proxy-1'),
      () => client.pluginConfigs.delete('plugin-1'),
      () => client.apiSpecs.delete('spec-1'),
    ];
    for (const remove of deletes) {
      Object.assign(reply, { status: 204, body: '' });
      await remove();
      for (const status of [200, 202, 302, 307]) {
        reply.status = status;
        const before = requests.length;
        await assert.rejects(remove, protocolFailure);
        assert.equal(requests.length, before + 1, 'an uncertain write is never replayed');
      }
    }
    Object.assign(reply, { status: 204, body: '' });
    await assert.rejects(
      () => client.consumers.deleteCredentialAt('consumer-1', 'keyauth', 0),
      protocolFailure,
    );
    Object.assign(reply, { status: 200, body: JSON.stringify(consumer) });
    assert.deepEqual(
      await client.consumers.deleteCredentialAt('consumer-1', 'keyauth', 0),
      consumer,
    );
    Object.assign(reply, { status: 404, body: '' });
    await client.proxies.delete('proxy-1');
    await client.pluginConfigs.delete('plugin-1');
    await client.apiSpecs.delete('spec-1');
    await assert.rejects(
      () => client.consumers.delete('consumer-1'),
      (error: unknown) => {
        assert.ok(isNexusError(error));
        assert.equal(error.code, 'EDGE_ERROR');
        return true;
      },
    );
  });

  it('requires write acknowledgements and never replays uncertain writes', async (t) => {
    const { client, reply, requests } = await fixture(t);
    for (const [status, write] of [
      [201, () => client.consumers.create({ username: 'alice' })],
      [200, () => client.consumers.replace('consumer-1', { username: 'alice' })],
      [200, () => client.consumers.addCredential('consumer-1', 'keyauth', { key: 'test-key' })],
    ] as const) {
      for (const body of ['', 'null', '{', '<html>private-canary</html>', '{}']) {
        Object.assign(reply, { status, body });
        const before = requests.length;
        await assert.rejects(write, protocolFailure);
        assert.equal(requests.length, before + 1);
      }
      reply.body = JSON.stringify(consumer);
      assert.deepEqual(await write(), consumer);
    }
  });

  it('keeps liveness, optional version, health and namespace exceptions explicit', async (t) => {
    const { client, reply, requests } = await fixture(t);
    assert.equal(await client.live(), true, 'an empty 200 liveness acknowledgement is valid');
    reply.body = '{"status":"ok"}';
    assert.equal(await client.live(), true);
    Object.assign(reply, { status: 404, body: '' });
    assert.equal(await client.live(), false);
    assert.equal(await client.version(), null);
    reply.status = 405;
    assert.equal(await client.version(), null);
    Object.assign(reply, { status: 200, body: 'null' });
    await assert.rejects(() => client.version(), protocolFailure);
    reply.body = '{"version":"1.0.0"}';
    assert.equal(await client.version(), '1.0.0');
    Object.assign(reply, { status: 503, body: '{"status":"draining","ready":false}' });
    assert.equal((await client.health()).ready, false);
    reply.body = '{"error":"private-canary"}';
    await assert.rejects(() => client.health(), protocolFailure);
    Object.assign(reply, { status: 302, body: '' });
    await assert.rejects(() => client.live(), protocolFailure);
    await assert.rejects(() => client.version(), protocolFailure);
    const before = requests.length;
    await client.ensureNamespace();
    assert.equal(requests.length, before + 1, 'failed namespace reads must not cause a create');
  });

  it('never replays a write whose socket closes after the request arrives', async (t) => {
    const { client, reply, requests } = await fixture(t);
    reply.disconnect = true;
    for (const write of [
      () => client.consumers.create({ username: 'alice' }),
      () => client.consumers.replace('consumer-1', { username: 'alice' }),
      () => client.consumers.delete('consumer-1'),
    ]) {
      const before = requests.length;
      await assert.rejects(write, (error: unknown) => {
        assert.ok(isNexusError(error));
        assert.equal(error.code, 'EDGE_UNAVAILABLE');
        return true;
      });
      assert.equal(requests.length, before + 1);
    }
  });

  it('reports malformed telemetry as unavailable', async (t) => {
    const { client, reply } = await fixture(t);
    reply.body = '{}';
    assert.equal((await client.metrics.backendState('proxy-1')).available, false);
  });

  it('rejects invalid UTF-8 credentials without exposure or replay', async (t) => {
    const { client, reply, requests, logs } = await fixture(t);
    const prefix = JSON.stringify(consumer).replace('[REDACTED]', 'private-canary');
    const position = prefix.indexOf('private-canary') + 'private-canary'.length;
    reply.body = Buffer.concat([
      Buffer.from(prefix.slice(0, position)),
      Buffer.from([0xff]),
      Buffer.from(prefix.slice(position)),
    ]);
    for (const operation of [
      () => client.consumers.get('consumer-1'),
      () => client.consumers.addCredential('consumer-1', 'keyauth', { key: 'request-canary' }),
    ]) {
      const before = requests.length;
      await assert.rejects(operation, (error: unknown) => {
        protocolFailure(error);
        assert.ok(isNexusError(error));
        assert.deepEqual(error.details, {
          status: 200,
          kind: 'protocol_error',
          reason: 'invalid_utf8',
        });
        assert.equal(error.cause, undefined, 'decoder exceptions must not escape');
        assert.ok(!JSON.stringify(error.toBody()).includes('canary'));
        return true;
      });
      assert.equal(requests.length, before + 1, 'no automatic replay after a bad acknowledgement');
    }
    assert.ok(!JSON.stringify(logs).includes('canary'));
  });

  it('preserves UTF-8 and JSON escapes, safe absence and text metrics compatibility', async (t) => {
    const { client, reply } = await fixture(t);
    const valid = { ...consumer, username: 'alice-\u00e9-\ud83d\udd11-\ufffd' };
    reply.body = Buffer.from(JSON.stringify(valid));
    assert.deepEqual(await client.consumers.get('consumer-1'), valid);
    reply.body = JSON.stringify(consumer).replace('alice', 'alice-\\ud800');
    assert.equal((await client.consumers.get('consumer-1'))?.username, 'alice-\ud800');

    reply.body = Buffer.from([0xff]);
    reply.status = 404;
    assert.equal(await client.consumers.get('consumer-1'), null);
    assert.equal(await client.live(), false);
    await client.pluginConfigs.delete('plugin-1');
    reply.status = 405;
    assert.equal(await client.version(), null);

    reply.status = 200;
    reply.body = Buffer.concat([
      Buffer.from('# comment '),
      Buffer.from([0xff]),
      Buffer.from('\nferrum_requests_total{proxy_id="proxy-1",method="GET",status_code="200"} 3\n'),
    ]);
    const metrics = await client.metrics.scrapeProxy('proxy-1');
    assert.equal(metrics.available, true);
    assert.equal(metrics.requests.total, 3);

    reply.status = 503;
    reply.body = Buffer.concat([
      Buffer.from('{"status":"draining'),
      Buffer.from([0xff]),
      Buffer.from('","ready":false}'),
    ]);
    await assert.rejects(() => client.health(), protocolFailure);
  });

  it('bounds JSON buffering and emits only sanitized protocol diagnostics', async (t) => {
    const { client, reply, logs } = await fixture(t);
    reply.body = 'private-canary'.padEnd(ADMIN_RESPONSE_MAX_BYTES + 1, 'x');
    await assert.rejects(
      () => client.consumers.get('consumer-1'),
      (error: unknown) => {
        protocolFailure(error);
        assert.ok(isNexusError(error));
        assert.equal((error.details as { reason: string }).reason, 'response_too_large');
        assert.ok(!JSON.stringify(error.toBody()).includes('private-canary'));
        return true;
      },
    );
    assert.ok(!JSON.stringify(logs).includes('private-canary'));
  });
});
