/**
 * The readiness wait is bounded by its deadline even when one check stalls
 * (issue #606). These run without the stack: `run.sh` runs them first.
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import { waitFor } from './harness.js';

/** How far past the deadline a rejection may land on a loaded CI runner. */
const TOLERANCE_MS = 1_000;

async function elapsed(run: () => Promise<unknown>): Promise<number> {
  const started = Date.now();
  await run();
  return Date.now() - started;
}

describe('waitFor', () => {
  let server: Server;
  let base: string;
  let closed = 0;

  before(async () => {
    // Accepts the connection and sends headers, then never finishes the body.
    server = createServer((request, response) => {
      request.on('close', () => {
        closed += 1;
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"status":');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns as soon as the check passes', async () => {
    let calls = 0;
    await waitFor('a ready check', async () => ++calls === 2, 5_000);
    assert.equal(calls, 2);
  });

  it('gives up at the deadline on a check that never settles', async () => {
    let signal: AbortSignal | undefined;
    const took = await elapsed(() =>
      assert.rejects(
        waitFor(
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
      waitFor(
        'a late check',
        () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 400)),
        150,
      ),
      /Timed out after 150ms waiting for a late check/,
    );
  });

  it('cancels a response whose body stalls', async () => {
    const took = await elapsed(() =>
      assert.rejects(
        waitFor(
          'a stalled body',
          async (signal) => {
            const response = await fetch(`${base}/health`, { signal });
            const body = (await response.json()) as { status?: string };
            return body.status === 'ok';
          },
          300,
        ),
        /Timed out after 300ms waiting for a stalled body/,
      ),
    );
    assert.ok(took < 300 + TOLERANCE_MS, `rejected after ${took}ms`);
    const deadline = Date.now() + TOLERANCE_MS;
    while (closed === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(closed > 0, 'the stalled request was torn down, not left open');
  });
});
