/**
 * What an outbound send does when the per-account key is held elsewhere and the
 * wait runs out — the `409` the docs promise on both send paths.
 *
 * The daily message budget and the two broadcast ceilings are read-then-write
 * checks, so each one runs inside a lease keyed to the account
 * (`messages:budget:<user>`, `god:broadcast:<user>`). A lease another instance
 * is holding is normally waited out; a lease still held after
 * `LEASE_WAIT_MS` is a `CONFLICT`, deliberately, rather than a silent overshoot
 * of the ceiling the lease exists to enforce.
 *
 * The wait is 30 seconds in production, which is not a thing a test can sit
 * through, so these apps are built with `sendLockWaitMs: 0` — one attempt, then
 * the refusal. The lease itself is real: planted in `edge_leases` under a
 * foreign owner, exactly as a second Nexus process would leave it, and the
 * cases assert both halves of the promise — the caller is told to retry, and
 * nothing was written on the way to telling them.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type { ApiErrorBody } from '@ferrum-nexus/shared';

import { isoInSeconds, nowIso } from '../lib/ids.js';
import {
  broadcastLockKey,
  messageBudgetLockKey,
  SEND_LOCK_CONFLICT_MESSAGE,
} from '../lib/keyed-serializer.js';
import { buildTestApp, type TestApp, type TestSession } from './helpers.js';

/** The instance that is supposedly still busy with this account's send. */
const FOREIGN_OWNER = 'another-nexus-instance';

function errorBody(body: string): ApiErrorBody['error'] {
  return (JSON.parse(body) as ApiErrorBody).error;
}

describe('a send whose per-account key is held elsewhere', () => {
  let harness: TestApp;
  let founder: TestSession;
  let member: TestSession;

  before(async () => {
    harness = await buildTestApp({
      // One lease attempt, then the refusal — the 30 s production wait is not
      // something a test can sit through, and the timeout is the behaviour
      // under test.
      deps: { startOutboxWorker: false, sendLockWaitMs: 0 },
    });
    founder = await harness.registerUser({ email: 'send-lock-founder@example.test' });
    member = await harness.registerUser({ email: 'send-lock-member@example.test' });
  });

  after(async () => {
    await harness.close();
  });

  /** Plant a live lease owned by somebody else, as a second instance would. */
  async function plant(key: string): Promise<void> {
    const taken = await harness.store.leases.acquire(
      key,
      FOREIGN_OWNER,
      isoInSeconds(60),
      nowIso(),
    );
    assert.equal(taken, true, 'the foreign lease was planted');
  }

  it('refuses a message with CONFLICT and writes nothing', async () => {
    const key = messageBudgetLockKey(member.user.id);
    await plant(key);
    try {
      const threadsBefore = (await harness.store.threads.list({}, { limit: 50 })).total;
      const auditBefore = (await harness.auditRows('message.send')).length;

      const refused = await harness.authed(member, {
        method: 'POST',
        url: '/api/threads',
        payload: { subject: 'Blocked', body: 'The other instance still holds the key' },
      });

      assert.equal(refused.statusCode, 409, refused.body);
      const failure = errorBody(refused.body);
      assert.equal(failure.code, 'CONFLICT');
      assert.equal(failure.message, SEND_LOCK_CONFLICT_MESSAGE);
      assert.equal((await harness.store.threads.list({}, { limit: 50 })).total, threadsBefore);
      assert.equal((await harness.auditRows('message.send')).length, auditBefore);
      assert.equal(
        await harness.store.messages.countBySenderSince(member.user.id, new Date(0).toISOString()),
        0,
        'the refusal is not a partial send',
      );
    } finally {
      await harness.store.leases.release(key, FOREIGN_OWNER);
    }

    // And the same request goes through once the other instance is done, so
    // the lease is what refused it and not something incidental.
    const allowed = await harness.authed(member, {
      method: 'POST',
      url: '/api/threads',
      payload: { subject: 'Unblocked', body: 'The key came back' },
    });
    assert.equal(allowed.statusCode, 201, allowed.body);
  });

  it('refuses a broadcast with CONFLICT and writes nothing', async () => {
    const key = broadcastLockKey(founder.user.id);
    await plant(key);
    try {
      const threadsBefore = (await harness.store.threads.list({}, { limit: 50 })).total;
      const auditBefore = (await harness.auditRows('god.broadcast')).length;

      const refused = await harness.authed(founder, {
        method: 'POST',
        url: '/api/admin/god/broadcast',
        payload: {
          subject: 'Blocked announcement',
          body: 'The other instance still holds the key',
          audience: { scope: 'all' },
        },
      });

      assert.equal(refused.statusCode, 409, refused.body);
      const failure = errorBody(refused.body);
      assert.equal(failure.code, 'CONFLICT');
      assert.equal(failure.message, SEND_LOCK_CONFLICT_MESSAGE);
      assert.equal((await harness.store.threads.list({}, { limit: 50 })).total, threadsBefore);
      assert.equal(
        (await harness.auditRows('god.broadcast')).length,
        auditBefore,
        'a refused broadcast is not charged against the daily ceiling',
      );
    } finally {
      await harness.store.leases.release(key, FOREIGN_OWNER);
    }

    const allowed = await harness.authed(founder, {
      method: 'POST',
      url: '/api/admin/god/broadcast',
      payload: {
        subject: 'Unblocked announcement',
        body: 'The key came back',
        audience: { scope: 'all' },
      },
    });
    assert.equal(allowed.statusCode, 200, allowed.body);
  });

  it('leaves an unrelated account free while one key is held', async () => {
    const key = messageBudgetLockKey(member.user.id);
    await plant(key);
    try {
      const allowed = await harness.authed(founder, {
        method: 'POST',
        url: '/api/threads',
        payload: { subject: 'Unrelated', body: 'A different sender entirely' },
      });
      assert.equal(allowed.statusCode, 201, allowed.body);
    } finally {
      await harness.store.leases.release(key, FOREIGN_OWNER);
    }
  });
});
