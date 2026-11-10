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
 *
 * The fan-out writes one transaction per chunk of recipients (issue #682); a
 * chunk that fails is retried one recipient at a time, so a persistent failure
 * still costs only the account it belongs to.
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
  const members: TestSession[] = [];

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
      members.push(
        await harness.registerUser({ email: `accounting-member-${index}@example.test` }),
      );
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
    // The second recipient's platform thread can never be created. The other
    // two still get the announcement — that is the whole point of catching
    // per-recipient errors — but the counts have to say one of them did not.
    const refused = members[1]!.user.id;
    let refusals = 0;
    faults.failWhen('threads', 'create', (input) => {
      const hit = (input as { participant_a?: string }).participant_a === refused;
      if (hit) refusals += 1;
      return hit;
    });
    let response: LightMyRequestResponse;
    try {
      response = await send('Partly delivered');
    } finally {
      faults.clear();
    }

    assert.equal(response.statusCode, 200, response.body);
    assert.ok(refusals > 0, 'the intended failure was reached');
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

  it('does not count an optional email failure as an undelivered recipient', async () => {
    // One recipient's mail copy is refused after its inbox row landed:
    // delivery is the inbox write, so all recipients count delivered and
    // none failed; only the two other mail copies queue.
    const refused = members[0]!.user.id;
    faults.failWhen(
      'emailOutbox',
      'enqueue',
      (input) => (input as { recipient_user_id?: string }).recipient_user_id === refused,
    );
    let response: LightMyRequestResponse;
    try {
      response = await harness.authed(founder, {
        method: 'POST',
        url: '/api/admin/god/broadcast',
        payload: {
          subject: 'Mail copy failed',
          body: 'An announcement',
          audience: { scope: 'all' },
          send_email: true,
        },
      });
    } finally {
      faults.clear();
    }
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json<GodBroadcastResponse>();
    assert.equal(body.delivered, 3);
    assert.equal(body.failed, 0);
    assert.equal(body.emails_enqueued, 2);
    assert.ok(body.delivered + body.failed <= 3, 'no recipient is counted on both sides');
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

describe('a broadcast fanned out in chunks', () => {
  it('reuses each platform thread and confines a failure to its account (#682)', async () => {
    let faults: FaultInjectingStore | undefined;
    // Two recipients per transaction: five accounts make three chunks.
    const harness = await buildTestApp({
      deps: { startOutboxWorker: false, massEmailChunkRecipients: 2 },
      wrapStore: (store) => {
        faults = faultInjectingStore(store);
        return faults.store;
      },
    });
    try {
      const founder = await harness.registerUser({ email: 'chunk-founder@example.test' });
      const members: TestSession[] = [];
      for (const index of [1, 2, 3, 4, 5]) {
        members.push(await harness.registerUser({ email: `chunk-member-${index}@example.test` }));
      }
      const ids = members.map((member) => member.user.id);
      const broadcast = async (subject: string): Promise<GodBroadcastResponse> => {
        const response = await harness.authed(founder, {
          method: 'POST',
          url: '/api/admin/god/broadcast',
          payload: { subject, body: subject, audience: { scope: 'all' } },
        });
        assert.equal(response.statusCode, 200, response.body);
        return response.json<GodBroadcastResponse>();
      };

      const first = await broadcast('First announcement');
      assert.equal(first.delivered, 5);
      assert.equal(first.failed, 0);
      assert.equal(first.threads_created, 5, 'every recipient gets a platform thread');

      // One recipient can no longer be written to. Whoever shares its chunk,
      // and the other chunks, still are.
      const refused = ids[3]!;
      const ownerOf = new Map(
        (await harness.store.threads.listPlatformByParticipants(ids)).map((thread) => [
          thread.id,
          thread.participant_a,
        ]),
      );
      faults!.failWhen(
        'messages',
        'create',
        (input) => ownerOf.get((input as { thread_id: string }).thread_id) === refused,
      );
      let second: GodBroadcastResponse;
      try {
        second = await broadcast('Second announcement');
      } finally {
        faults!.clear();
      }
      assert.equal(second.delivered, 4);
      assert.equal(second.failed, 1);
      assert.equal(second.threads_created, 0, 'the existing threads are reused');

      const threads = await harness.store.threads.listPlatformByParticipants(ids);
      assert.equal(threads.length, 5, 'still one platform thread per recipient');
      for (const thread of threads) {
        const messages = await harness.store.messages.listByThread(thread.id);
        assert.deepEqual(
          messages.items.map((message) => message.body),
          thread.participant_a === refused
            ? ['First announcement']
            : ['First announcement', 'Second announcement'],
          thread.participant_a,
        );
      }
    } finally {
      await harness.close();
    }
  });
});
