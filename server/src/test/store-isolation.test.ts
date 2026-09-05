import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type { User } from '@ferrum-nexus/shared';

import { buildTestApp, type TestApp, type TestSession } from './helpers.js';

/**
 * Same-process isolation of ordinary requests from an open SQLite transaction.
 *
 * The store serialises `transaction()` bodies on one synchronous connection and
 * holds `BEGIN` across the body's `await`s. Before every repository call was
 * gated on transaction ownership, an unrelated request arriving in that window
 * wrote *inside* the open transaction: it answered 200, and its row and audit
 * entry vanished together with the other transaction's rollback. These tests
 * hold a transaction open, drive real HTTP requests through the app from an
 * independent async context, and roll the transaction back underneath them.
 */
describe('store isolation under an open transaction', () => {
  let harness: TestApp;
  let session: TestSession;

  /** Resolve-from-outside promise, the shape every test here needs twice. */
  function latch(): { wait: Promise<void>; open: () => void } {
    let open = (): void => {};
    const wait = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { wait, open };
  }

  before(async () => {
    harness = await buildTestApp();
    session = await harness.registerUser({ email: 'isolation@example.test' });
  });

  after(async () => {
    await harness.close();
  });

  it('answers a profile update only after an unrelated transaction has ended', async () => {
    const userId = session.user.id;
    const gate = latch();
    const started = latch();
    const rowsBefore = await harness.auditRows('user.update');
    const auditBefore = rowsBefore.filter((row) => row.target_id === userId).length;

    // Transaction A dirties the very row the request is about to update, then
    // parks with `BEGIN` held — the window the probe in #81 exploited.
    const a = harness.store.transaction(async (tx) => {
      await tx.users.update(userId, { display_name: 'Dirty from A' });
      started.open();
      await gate.wait;
      throw new Error('A rolls back');
    });
    await started.wait;

    let responded = false;
    const patch = harness
      .authed(session, {
        method: 'PATCH',
        url: '/api/users/me',
        payload: { display_name: 'Renamed by B' },
      })
      .then((response) => {
        responded = true;
        return response;
      });
    // Give the request every chance to run ahead of A's release.
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(responded, false, 'B must not answer while A still holds the connection');

    gate.open();
    await assert.rejects(() => a, /A rolls back/);

    const response = await patch;
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json<{ user: User }>().user.display_name, 'Renamed by B');

    // B's write is durable and untouched by A's rollback, and so is its audit row.
    const stored = await harness.store.users.findById(userId);
    assert.equal(stored?.display_name, 'Renamed by B');
    const rowsAfter = await harness.auditRows('user.update');
    const auditAfter = rowsAfter.filter((row) => row.target_id === userId);
    assert.equal(auditAfter.length, auditBefore + 1, 'the audit row survived the rollback');
    assert.equal(auditAfter[0]?.details.self, true);
  });

  it('never shows an unrelated reader uncommitted data', async () => {
    const userId = session.user.id;
    const clean = await harness.store.users.findById(userId);
    assert.ok(clean);
    const gate = latch();
    const started = latch();

    const a = harness.store.transaction(async (tx) => {
      await tx.users.update(userId, { display_name: 'Only A may see this' });
      started.open();
      await gate.wait;
      throw new Error('A rolls back');
    });
    await started.wait;

    let responded = false;
    const read = harness
      .authed(session, { method: 'GET', url: '/api/users/me' })
      .then((response) => {
        responded = true;
        return response;
      });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(responded, false, 'the read must wait rather than see uncommitted rows');

    gate.open();
    await assert.rejects(() => a, /A rolls back/);

    const response = await read;
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json<{ user: User }>().user.display_name, clean.display_name);
  });

  it('keeps serving requests once the transaction has committed', async () => {
    const userId = session.user.id;
    const gate = latch();
    const started = latch();

    const a = harness.store.transaction(async (tx) => {
      await tx.users.update(userId, { company: 'Committed by A' });
      started.open();
      await gate.wait;
    });
    await started.wait;

    const read = harness.authed(session, { method: 'GET', url: '/api/users/me' });
    gate.open();
    await a;

    const response = await read;
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json<{ user: User }>().user.company, 'Committed by A');
  });
});
