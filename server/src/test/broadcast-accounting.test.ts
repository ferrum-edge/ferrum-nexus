/**
 * What a god-mode broadcast records, and when it records it.
 *
 * Two things this PR made load-bearing had to move for it to hold:
 *
 * 1. **The countable row goes in first.** `NEXUS_MAX_BROADCASTS_PER_DAY` counts
 *    the actor's `god.broadcast` audit rows, and that row used to be written
 *    *after* the fan-out. A failure there left an announcement that had already
 *    reached the whole portal uncharged against the ceiling, absent from the
 *    trail, and answered with a `500` whose natural retry announced everything
 *    a second time. It is now written before the first recipient is touched;
 *    what the attempt achieved is a separate `god.broadcast_complete` row.
 * 2. **Delivery is counted, not assumed.** Per-recipient failures are logged
 *    and skipped so one bad account cannot stop an emergency announcement —
 *    which meant the response and the audit row reported the *audience* size,
 *    so a broadcast that reached nobody looked exactly like one that reached
 *    everybody. `delivered` and `failed` are counted in the loop and appear in
 *    both.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type { LightMyRequestResponse } from 'fastify';

import type { ApiErrorBody, GodBroadcastResponse } from '@ferrum-nexus/shared';

import { faultInjectingStore, type FaultInjectingStore } from './fault-injection.js';
import { buildTestApp, type TestApp, type TestSession } from './helpers.js';

function errorBody(body: string): ApiErrorBody['error'] {
  return (JSON.parse(body) as ApiErrorBody).error;
}

describe('broadcast accounting', () => {
  let harness: TestApp;
  let faults: FaultInjectingStore;
  let founder: TestSession;

  before(async () => {
    harness = await buildTestApp({
      deps: { startOutboxWorker: false },
      wrapStore: (store) => {
        faults = faultInjectingStore(store);
        return faults.store;
      },
    });
    founder = await harness.registerUser({ email: 'accounting-founder@example.test' });
    for (const index of [1, 2, 3]) {
      await harness.registerUser({ email: `accounting-member-${index}@example.test` });
    }
  });

  after(async () => {
    await harness.close();
  });

  /** Send one announcement to the whole portal. */
  function send(subject: string): Promise<LightMyRequestResponse> {
    return harness.authed(founder, {
      method: 'POST',
      url: '/api/admin/god/broadcast',
      payload: { subject, body: 'An announcement', audience: { scope: 'all' } },
    });
  }

  it('reports delivered and failed, and says so in the completion row', async () => {
    // The second recipient's message insert fails. The other two still get the
    // announcement — that is the whole point of catching per-recipient errors —
    // but the counts have to say one of them did not.
    faults.failAfter('messages', 'create', 1);
    const response = await send('Partly delivered');

    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(faults.pending(), [], 'the intended failure was reached');
    const body = response.json<GodBroadcastResponse>();
    assert.equal(body.delivered, 2, 'two of the three recipients got the message');
    assert.equal(body.failed, 1);

    const rows = await harness.auditRows('god.broadcast_complete');
    const completion = rows.find((row) => row.details.reason === 'Partly delivered');
    assert.ok(completion, 'the outcome was recorded');
    assert.equal(completion.details.delivered, 2);
    assert.equal(completion.details.failed, 1);
    assert.equal(completion.details.recipients, 3, 'the audience size is still recorded');
  });

  it('reports a clean broadcast as wholly delivered', async () => {
    const response = await send('Wholly delivered');
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json<GodBroadcastResponse>();
    assert.equal(body.delivered, 3);
    assert.equal(body.failed, 0);
    assert.equal(body.notified, 3);
  });

  it('charges the slot and names the broadcast when the outcome is not recorded', async () => {
    const started = (await harness.auditRows('god.broadcast')).length;
    const completed = (await harness.auditRows('god.broadcast_complete')).length;

    // The `god.broadcast` row is written first and the completion row last, so
    // failing the *second* audit write of the request is the case where the
    // announcement has already gone out.
    faults.failAfter('auditLogs', 'create', 1);
    const response = await send('Unrecorded outcome');

    // Still a success: the announcement was delivered, and a `500` here would
    // invite a retry that delivered it twice.
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(faults.pending(), [], 'the intended failure was reached');
    assert.equal(response.json<GodBroadcastResponse>().delivered, 3);

    const rows = await harness.auditRows('god.broadcast');
    assert.equal(rows.length, started + 1, 'the attempt is charged against the daily ceiling');
    assert.equal(
      (await harness.auditRows('god.broadcast_complete')).length,
      completed,
      'the outcome row is the one that failed',
    );
    // Found by subject rather than by position: rows written in the same
    // millisecond tie on the ordering, and this one has to be *this* attempt.
    const attempt = rows.find((row) => row.details.reason === 'Unrecorded outcome');
    assert.ok(attempt, 'the trail names the broadcast that went out');
    assert.equal(attempt.details.phase, 'started');
    assert.equal(attempt.details.recipients, 3, 'the trail still names what was broadcast');
  });

  it('writes no countable row when the attempt itself cannot be recorded', async () => {
    const started = (await harness.auditRows('god.broadcast')).length;
    const threadsBefore = (await harness.store.threads.list({}, { limit: 100 })).total;

    faults.failNext('auditLogs', 'create');
    const refused = await send('Never started');

    assert.equal(refused.statusCode, 500, refused.body);
    assert.deepEqual(faults.pending(), []);
    assert.equal((await harness.auditRows('god.broadcast')).length, started);
    assert.equal(
      (await harness.store.threads.list({}, { limit: 100 })).total,
      threadsBefore,
      'the 500 is truthful: the fan-out never began',
    );
  });
});

describe('a broadcast whose audience matches nobody', () => {
  it('is refused, and does not spend a daily slot', async () => {
    const harness = await buildTestApp({
      env: { NEXUS_MAX_BROADCASTS_PER_DAY: '2' },
      deps: { startOutboxWorker: false },
    });
    try {
      const founder = await harness.registerUser({ email: 'lonely-founder@example.test' });
      const before = (await harness.auditRows('god.broadcast')).length;

      // A portal of one: `scope: 'all'` matches only the sender, who is always
      // excluded from their own broadcast.
      const refused = await harness.authed(founder, {
        method: 'POST',
        url: '/api/admin/god/broadcast',
        payload: {
          subject: 'Nobody is listening',
          body: 'There is no one else here.',
          audience: { scope: 'all' },
        },
      });

      assert.equal(refused.statusCode, 400, refused.body);
      assert.equal(errorBody(refused.body).code, 'VALIDATION_FAILED');
      assert.equal(
        (await harness.auditRows('god.broadcast')).length,
        before,
        'a broadcast that reaches nobody is not one of the twenty a day',
      );

      // And the slots it did not spend are still there: two more go out.
      await harness.registerUser({ email: 'lonely-member@example.test' });
      for (const subject of ['One', 'Two']) {
        const sent = await harness.authed(founder, {
          method: 'POST',
          url: '/api/admin/god/broadcast',
          payload: { subject, body: 'An announcement', audience: { scope: 'all' } },
        });
        assert.equal(sent.statusCode, 200, sent.body);
      }
    } finally {
      await harness.close();
    }
  });
});
