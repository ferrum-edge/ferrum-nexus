/**
 * The readiness wait is bounded by its deadline even when one check stalls
 * (issue #606). These run without the stack: `run.sh` runs them first, against
 * a local listener that stalls the way a half-up service can.
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

type Harness = typeof import('./harness.js');

/** How far past the deadline a rejection may land on a loaded CI runner. */
const TOLERANCE_MS = 1_000;
/** The default readiness deadline these tests run the harness with. */
const READY_MS = 400;

async function elapsed(run: () => Promise<unknown>): Promise<number> {
  const started = Date.now();
  await run();
  return Date.now() - started;
}

describe('waitFor', () => {
  let server: Server;
  let harness: Harness;
  const closed = new Map<string, number>();

  async function closedOn(path: string): Promise<number> {
    const deadline = Date.now() + TOLERANCE_MS;
    while ((closed.get(path) ?? 0) === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return closed.get(path) ?? 0;
  }

  before(async () => {
    server = createServer((request, response) => {
      const path = (request.url ?? '').split('?')[0] ?? '';
      response.on('close', () => closed.set(path, (closed.get(path) ?? 0) + 1));
      if (path === '/api/v1/messages') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({ messages: [{ ID: 'm1', To: [{ Address: 'a@example.test' }] }] }),
        );
        return;
      }
      if (path === '/api/v1/message/m1') return; // never answers
      // Headers, then a body that never finishes: `/unready` as a 503.
      response.writeHead(path === '/unready' ? 503 : 200, { 'content-type': 'application/json' });
      response.write('{"status":');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.E2E_GATEWAY_URL = base;
    process.env.E2E_PORTAL_URL = base;
    process.env.E2E_MAIL_URL = base;
    process.env.E2E_READY_TIMEOUT_MS = String(READY_MS);
    harness = await import('./harness.js');
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns as soon as the check passes', async () => {
    let calls = 0;
    await harness.waitFor('a ready check', async () => ++calls === 2, 5_000);
    assert.equal(calls, 2);
  });

  it('retries a check that throws synchronously, without an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', record);
    try {
      let calls = 0;
      await harness.waitFor(
        'a check that throws first',
        (() => {
          calls += 1;
          if (calls === 1) throw new Error('not ready');
          return Promise.resolve(true);
        }) as (signal: AbortSignal) => Promise<boolean>,
        5_000,
      );
      assert.equal(calls, 2);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual(unhandled, []);
    } finally {
      process.off('unhandledRejection', record);
    }
  });

  it('gives up at the deadline on a check that never settles', async () => {
    let signal: AbortSignal | undefined;
    const took = await elapsed(() =>
      assert.rejects(
        harness.waitFor(
          'a stalled check',
          (given) => {
            signal = given;
            return new Promise<boolean>(() => undefined);
          },
          200,
        ),
        /Timed out after 200ms waiting for a stalled check: the last check did not finish/,
      ),
    );
    assert.ok(took < 200 + TOLERANCE_MS, `rejected after ${took}ms`);
    assert.equal(signal?.aborted, true, 'the stalled attempt was cancelled');
  });

  it('does not count a success that arrives after the deadline', async () => {
    await assert.rejects(
      harness.waitFor(
        'a late check',
        () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 400)),
        150,
      ),
      /Timed out after 150ms waiting for a late check/,
    );
  });

  it('cancels a gateway response whose body stalls, without the check forwarding a signal', async () => {
    const took = await elapsed(() =>
      assert.rejects(
        harness.waitFor(
          'a stalled body',
          async () => {
            const response = await harness.callGateway('/stalled');
            const body = (await response.json()) as { status?: string };
            return body.status === 'ok';
          },
          300,
        ),
        /Timed out after 300ms waiting for a stalled body/,
      ),
    );
    assert.ok(took < 300 + TOLERANCE_MS, `rejected after ${took}ms`);
    assert.ok((await closedOn('/stalled')) > 0, 'the stalled request was torn down');
  });

  it('closes an unread non-OK response as soon as its attempt ends', async () => {
    let attempts = 0;
    await assert.rejects(
      harness.waitFor(
        'a 503',
        async () => {
          attempts += 1;
          return (await harness.portalRaw('GET', '/unready')).ok;
        },
        300,
      ),
      /Timed out after 300ms waiting for a 503/,
    );
    assert.ok(attempts >= 1);
    assert.ok((await closedOn('/unready')) >= attempts, 'no unread body was left open');
  });

  it('bounds the mail read, message body included', async () => {
    const took = await elapsed(() =>
      assert.rejects(harness.latestMailTo('a@example.test'), /waiting for mail delivered to/),
    );
    assert.ok(took < READY_MS + TOLERANCE_MS, `rejected after ${took}ms`);
    assert.ok((await closedOn('/api/v1/message/m1')) > 0, 'the stalled detail read was cancelled');
  });
});
