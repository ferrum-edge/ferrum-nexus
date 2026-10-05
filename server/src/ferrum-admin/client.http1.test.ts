import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSecureServer, type ServerHttp2Session } from 'node:http2';
import type { Socket } from 'node:net';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { jwtVerify } from 'jose';

import type { EdgeConfig } from '../config/index.js';
import { isNexusError } from '../lib/errors.js';
import { createFerrumAdminClient } from './client.js';

const FIXTURES = new URL('../test/fixtures/http1-tls/', import.meta.url);
const SECRET = 'http1-test-admin-secret-0123456789abcdef';

interface CapturedRequest {
  method: string;
  version: string;
  authorization: string;
  namespace: unknown;
}

describe('admin transport after the Undici 8 migration', () => {
  it('negotiates H1 with an H2-capable peer and retries only the reset read', async (t) => {
    const sockets = new Set<Socket>();
    const sessions = new Set<ServerHttp2Session>();
    const protocols: (string | false)[] = [];
    const requests: CapturedRequest[] = [];
    let resets = 0;
    const server = createSecureServer({
      key: readFileSync(new URL('agent8-key.pem', FIXTURES)),
      cert: readFileSync(new URL('agent8-cert.pem', FIXTURES)),
      allowHTTP1: true,
    });
    server.on('secureConnection', (socket) => {
      protocols.push(socket.alpnProtocol);
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server.on('session', (session) => {
      sessions.add(session);
      session.on('close', () => sessions.delete(session));
    });
    server.on('request', (req, res) => {
      requests.push({
        method: req.method ?? '',
        version: req.httpVersion,
        authorization: String(req.headers.authorization ?? ''),
        namespace: req.headers['x-ferrum-namespace'],
      });
      if (resets > 0) {
        resets -= 1;
        req.on('end', () => req.socket.destroy());
        req.resume();
        return;
      }
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', ready: true, mode: 'database' }));
    });
    await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const config: EdgeConfig = {
      adminUrl: `https://localhost:${address.port}`,
      jwtSecret: SECRET,
      jwtTtlSeconds: 60,
      jwtIssuer: 'ferrum-edge',
      jwtAudience: undefined,
      namespace: 'nexus',
      gatewayPublicUrl: undefined,
      caFile: fileURLToPath(new URL('fake-startcom-root-cert.pem', FIXTURES)),
      allowInsecureHttp: false,
      timeoutMs: 5_000,
      maxCredentialsPerType: 2,
      rateLimit: { syncMode: 'local', redisUrl: undefined, redisTls: false },
    };
    const client = createFerrumAdminClient(config);
    t.after(async () => {
      await client.close();
      for (const session of sessions) session.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    });

    assert.equal((await client.health()).ready, true);
    assert.deepEqual(protocols, ['http/1.1'], 'the peer offers H2 but the owned agent disables it');
    resets = 1;
    assert.equal((await client.health()).ready, true);
    assert.equal(requests.length, 3, 'the reset pooled read has exactly one retry');
    assert.deepEqual(protocols, ['http/1.1', 'http/1.1'], 'the retry opens a fresh H1 socket');

    resets = 1;
    await assert.rejects(client.consumers.create({ username: 'alice' }), (error: unknown) => {
      assert.ok(isNexusError(error));
      assert.equal(error.code, 'EDGE_UNAVAILABLE');
      return true;
    });
    assert.deepEqual(
      requests.map((request) => request.method),
      ['GET', 'GET', 'GET', 'POST'],
    );
    assert.equal(resets, 0, 'the write reached the peer once and was not replayed');
    for (const request of requests) {
      assert.equal(request.version, '1.1');
      assert.equal(request.namespace, 'nexus');
      assert.match(request.authorization, /^Bearer /);
      const { payload } = await jwtVerify(
        request.authorization.slice('Bearer '.length),
        new TextEncoder().encode(SECRET),
        { issuer: 'ferrum-edge', algorithms: ['HS256'] },
      );
      assert.equal(payload.role, 'admin');
      assert.equal(payload.ns, 'nexus');
      assert.equal(payload.aud, undefined);
    }
  });
});
