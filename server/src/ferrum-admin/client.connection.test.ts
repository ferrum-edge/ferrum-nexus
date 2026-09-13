import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { describe, it, type TestContext } from 'node:test';

import type { EdgeConfig } from '../config/index.js';
import { isNexusError } from '../lib/errors.js';
import {
  ADMIN_KEEP_ALIVE_MAX_TIMEOUT_MS,
  ADMIN_KEEP_ALIVE_TIMEOUT_MS,
  ADMIN_KEEP_ALIVE_TIMEOUT_THRESHOLD_MS,
  createFerrumAdminClient,
  EDGE_DEFAULT_IDLE_TIMEOUT_MS,
  isStalePooledSocketError,
  shouldRetryOnFreshConnection,
} from './client.js';

const HEALTH_BODY = JSON.stringify({ status: 'ok', ready: true, mode: 'database' });

/**
 * A gateway that can close the connection carrying the next request instead of
 * answering it — exactly what Edge does to a pooled socket that reaches its
 * idle bound in the same instant Nexus reuses it (#248).
 */
async function gateway(t: TestContext, overrides: Partial<EdgeConfig> = {}) {
  /** `resets`: how many further requests are answered with a socket close. */
  const state = { connections: 0, resets: 0, silent: false };
  const requests: string[] = [];
  const sockets = new Set<Socket>();
  const logs: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    req.resume();
    if (state.silent) return;
    if (state.resets > 0) {
      state.resets -= 1;
      req.on('end', () => req.socket.destroy());
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(HEALTH_BODY);
  });
  server.on('connection', (socket) => {
    state.connections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const config: EdgeConfig = {
    adminUrl: `http://127.0.0.1:${address.port}`,
    jwtSecret: 'connection-test-admin-secret-0123456789abcdef',
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
    ...overrides,
  };
  const client = createFerrumAdminClient(config, {
    debug: (obj) => logs.push(obj),
    warn: (obj) => logs.push(obj),
    error: (obj) => logs.push(obj),
  });
  t.after(async () => {
    await client.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
  return { client, state, requests, logs };
}

function unavailable(error: unknown): boolean {
  assert.ok(isNexusError(error));
  assert.equal(error.code, 'EDGE_UNAVAILABLE');
  assert.equal(error.statusCode, 502);
  return true;
}

/** An `Error` shaped like the transport failures undici and Node produce. */
function socketError(name: string, code: string, cause?: unknown): Error {
  const error = new Error(`${code} (test)`);
  error.name = name;
  return Object.assign(error, { code, ...(cause === undefined ? {} : { cause }) });
}

describe('ferrum admin client connection handling', () => {
  it('keeps the pooled idle lifetime clear of the gateway idle bound', () => {
    // The whole failure mode is a client whose idle lifetime *equals* the
    // gateway's, so these margins are the fix and not incidental tuning.
    assert.ok(ADMIN_KEEP_ALIVE_TIMEOUT_MS < EDGE_DEFAULT_IDLE_TIMEOUT_MS);
    assert.ok(EDGE_DEFAULT_IDLE_TIMEOUT_MS - ADMIN_KEEP_ALIVE_TIMEOUT_MS >= 5_000);
    // A gateway hint can only raise the lifetime to this ceiling, and undici
    // subtracts the threshold from the hint before adopting it.
    assert.ok(ADMIN_KEEP_ALIVE_MAX_TIMEOUT_MS < EDGE_DEFAULT_IDLE_TIMEOUT_MS);
    assert.ok(ADMIN_KEEP_ALIVE_TIMEOUT_THRESHOLD_MS > 0);
  });

  it('recovers a read whose pooled connection the gateway closed', async (t) => {
    const edge = await gateway(t);
    assert.equal((await edge.client.health()).ready, true);
    assert.equal(edge.state.connections, 1);

    // The next GET goes out on the pooled socket; the gateway closes it
    // instead of answering, as it does at its idle boundary.
    edge.state.resets = 1;
    assert.equal((await edge.client.health()).ready, true, 'the read must recover');
    assert.equal(edge.state.connections, 2, 'the retry must use a fresh connection');
    assert.equal(edge.requests.length, 3, 'exactly one retry');
    assert.ok(
      edge.logs.some((entry) => ['UND_ERR_SOCKET', 'ECONNRESET'].includes(String(entry.code))),
      'the recovered reset is still logged',
    );
  });

  it('retries a read at most once and then reports the gateway unavailable', async (t) => {
    const edge = await gateway(t);
    edge.state.resets = 10;
    await assert.rejects(() => edge.client.health(), unavailable);
    assert.equal(edge.requests.length, 2, 'one attempt, one retry, no loop');
    assert.equal(edge.state.resets, 8);
  });

  it('reports a gateway that is not listening as unavailable without a retry', async () => {
    // A refused connection is not a stale pooled socket: no attempt is owed.
    const refused = socketError('Error', 'ECONNREFUSED');
    assert.equal(isStalePooledSocketError(refused), false);
    assert.equal(
      shouldRetryOnFreshConnection('GET', refused, false, new AbortController().signal),
      false,
    );
    // Port 1 is reserved and never listening.
    const offline = createFerrumAdminClient({
      adminUrl: 'http://127.0.0.1:1',
      jwtSecret: 'connection-test-admin-secret-0123456789abcdef',
      jwtTtlSeconds: 60,
      jwtIssuer: 'ferrum-edge',
      jwtAudience: undefined,
      namespace: 'nexus',
      gatewayPublicUrl: undefined,
      caFile: undefined,
      allowInsecureHttp: true,
      timeoutMs: 2_000,
      maxCredentialsPerType: 2,
      rateLimit: { syncMode: 'local', redisUrl: undefined, redisTls: false },
    });
    try {
      await assert.rejects(() => offline.health(), unavailable);
    } finally {
      await offline.close();
    }
  });

  it('does not retry past the call deadline', async (t) => {
    const edge = await gateway(t, { timeoutMs: 300 });
    edge.state.silent = true;
    const started = Date.now();
    await assert.rejects(() => edge.client.health(), unavailable);
    const elapsed = Date.now() - started;
    assert.equal(edge.requests.length, 1, 'an exhausted deadline buys no further attempt');
    assert.ok(elapsed < 1_500, `the deadline must bound the call, took ${elapsed}ms`);
  });

  it('never replays a mutation whose connection the gateway closed', async (t) => {
    const edge = await gateway(t);
    for (const mutate of [
      () => edge.client.consumers.create({ username: 'alice' }),
      () => edge.client.consumers.replace('consumer-1', { username: 'alice' }),
      () => edge.client.consumers.delete('consumer-1'),
    ]) {
      // Warm a pooled connection, then close it under the write.
      await edge.client.health();
      const before = edge.requests.length;
      edge.state.resets = 1;
      await assert.rejects(mutate, unavailable);
      assert.equal(edge.requests.length, before + 1, 'the gateway must see the write once');
      assert.equal(edge.state.resets, 0);
    }
  });
});

describe('stale pooled socket classification', () => {
  it('accepts the socket errors a closed connection produces', () => {
    assert.equal(isStalePooledSocketError(socketError('SocketError', 'UND_ERR_SOCKET')), true);
    assert.equal(isStalePooledSocketError(socketError('Error', 'ECONNRESET')), true);
    assert.equal(isStalePooledSocketError(socketError('Error', 'EPIPE')), true);
    assert.equal(
      isStalePooledSocketError(
        socketError('SocketError', 'UND_ERR_SOCKET', socketError('Error', 'ECONNRESET')),
      ),
      true,
      'the reset undici wraps is read off the cause chain',
    );
  });

  it('refuses failures that describe the gateway rather than the socket', () => {
    for (const error of [
      socketError('Error', 'ECONNREFUSED'),
      socketError('Error', 'ENOTFOUND'),
      socketError('ConnectTimeoutError', 'UND_ERR_CONNECT_TIMEOUT'),
      socketError('HeadersTimeoutError', 'UND_ERR_HEADERS_TIMEOUT'),
      socketError('AbortError', 'ABORT_ERR'),
      socketError('TimeoutError', 'ECONNRESET'),
      'not an error',
    ]) {
      assert.equal(isStalePooledSocketError(error), false, String(error));
    }
  });

  it('owes a second attempt only to an unanswered read inside the deadline', () => {
    const reset = socketError('Error', 'ECONNRESET');
    const live = new AbortController().signal;
    assert.equal(shouldRetryOnFreshConnection('GET', reset, false, live), true);
    assert.equal(shouldRetryOnFreshConnection('HEAD', reset, false, live), true);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal(shouldRetryOnFreshConnection(method, reset, false, live), false, method);
    }
    assert.equal(
      shouldRetryOnFreshConnection('GET', reset, true, live),
      false,
      'a response that had begun is never re-read',
    );
    assert.equal(
      shouldRetryOnFreshConnection('GET', reset, false, AbortSignal.abort()),
      false,
      'an expired deadline is not extended by a retry',
    );
  });
});
