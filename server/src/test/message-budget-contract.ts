/**
 * The rolling daily message budget, exercised against every adapter — issue
 * #168.
 *
 * `docs/operations.md` used to tell a multi-instance operator that "the daily
 * budget counts durable rows, so it is correct on every instance regardless".
 * It was not. Counting durable rows does not make a check atomic: the count and
 * the insert were still separate statements in separate transactions on
 * separate connections, and two instances over one PostgreSQL at `quota - 1`
 * both committed. What ordered them on a single instance was the store's
 * in-process transaction queue, which is exactly why the existing regression
 * tests — one process, SQLite — could never fail.
 *
 * The fix is the mechanism the last-super-admin count already uses: the whole
 * count-then-insert runs inside a per-sender lease held in the `edge_leases`
 * table, so it is one step across processes too.
 *
 * **Two instances means two store objects**, and here that is load-bearing
 * rather than a formality. Every adapter drains transaction bodies through a
 * promise queue that belongs to one store object — `sql-repos.ts` for
 * PostgreSQL and MySQL, the Mongo adapter's own, SQLite's single-connection
 * mediator — so two apps sharing one store object are ordered by that queue
 * whatever the lease does, and the contention case would pass with the lease
 * deleted. The second app is therefore built over the {@link BudgetTarget.peer}
 * store: a second pool against the same database, with a transaction queue of
 * its own. `peer` is absent for SQLite, whose `:memory:` database cannot have a
 * second connection at all, and the contention case is skipped there rather
 * than run in a shape that cannot fail.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type { LightMyRequestResponse } from 'fastify';

import type { ApiErrorBody } from '@ferrum-nexus/shared';

import type { NexusStore } from '../db/store.js';
import { isoInSeconds } from '../lib/ids.js';
import { messageBudgetLockKey } from '../lib/keyed-serializer.js';
import { buildTestApp, type TestApp, type TestSession } from './helpers.js';

/** The budget every app in this contract runs with. */
const QUOTA = '3';

/** Environment both instances are built with, so neither is the lenient one. */
const ENV = { NEXUS_MAX_MESSAGES_PER_USER_PER_DAY: QUOTA };

/** What a target must offer for this contract to run. */
export interface BudgetTarget {
  store: NexusStore;
  teardown: () => Promise<void>;
  /**
   * A second store over the same database — two pools, two transaction queues,
   * the shape a multi-instance deployment has. Absent when there cannot be one.
   */
  peer?: () => Promise<NexusStore>;
}

/** The real messaging routes, on two instances over one database. */
export function runMessageBudgetContract(
  label: string,
  makeStore: () => Promise<BudgetTarget>,
): void {
  describe(`message budget contract — ${label}`, () => {
    let target: BudgetTarget;
    let harness: TestApp;
    /** The second instance. Over `peer` when the adapter has one. */
    let other: TestApp;
    /** The peer store, when one was opened — closed after both apps. */
    let peer: NexusStore | null = null;

    before(async () => {
      target = await makeStore();
      harness = await buildTestApp({
        store: target.store,
        env: ENV,
        deps: { startOutboxWorker: false },
      });
      peer = target.peer ? await target.peer() : null;
      other = await buildTestApp({
        store: peer ?? target.store,
        edge: harness.edge,
        env: ENV,
        deps: { startOutboxWorker: false },
      });
      await harness.registerUser();
    });

    after(async () => {
      await other?.close();
      await harness?.close();
      if (peer) await peer.close();
      await target?.teardown();
    });

    /** Open a platform thread as `session` through `app`. */
    function open(
      app: TestApp,
      session: TestSession,
      subject: string,
    ): Promise<LightMyRequestResponse> {
      return app.authed(session, {
        method: 'POST',
        url: '/api/threads',
        payload: { subject, body: subject },
      });
    }

    it('holds the per-sender key for the whole write, not merely the count', async (t) => {
      const sender = await harness.registerUser();
      const key = messageBudgetLockKey(sender.user.id);
      let observedHeld = false;

      // Every transaction the app opens during the send is probed from outside
      // the section, the way another instance would probe it. A competitor that
      // cannot take the key is the whole of the guarantee; one that can take it
      // gets it back immediately, so a failing run leaves no wedged lease.
      const original = target.store.transaction.bind(target.store);
      t.mock.method(
        target.store,
        'transaction',
        async <T>(fn: (tx: NexusStore) => Promise<T>): Promise<T> =>
          original(async (tx) => {
            const result = await fn(tx);
            const stolen = await target.store.leases.acquire(
              key,
              'competing-instance',
              isoInSeconds(60),
              new Date().toISOString(),
            );
            if (stolen) await target.store.leases.release(key, 'competing-instance');
            else observedHeld = true;
            return result;
          }),
      );

      const response = await open(harness, sender, 'Held');
      assert.equal(response.statusCode, 201, response.body);
      assert.equal(
        observedHeld,
        true,
        'the budget key is held across the transaction that writes the message',
      );
    });

    it('accepts exactly one of two instances contending for the last slot', async (t) => {
      // Without a second store the two apps share one transaction queue, which
      // orders the requests whatever the lease does — the case would pass with
      // `spendBudget` deleted, so it is skipped rather than faked.
      if (!peer) return t.skip('one connection: two transaction queues cannot contend');

      const sender = await harness.registerUser();
      // Spend two of three through one instance, so both requests below see
      // `used = quota - 1` if they are allowed to read it independently.
      for (const subject of ['One', 'Two']) {
        const spent = await open(harness, sender, subject);
        assert.equal(spent.statusCode, 201, spent.body);
      }

      const [first, second] = await Promise.all([
        open(harness, sender, 'Instance A'),
        open(other, sender, 'Instance B'),
      ]);

      const statuses = [first.statusCode, second.statusCode].sort((a, b) => a - b);
      assert.deepEqual(statuses, [201, 429], `${first.body} / ${second.body}`);
      const refused = first.statusCode === 429 ? first : second;
      assert.equal((JSON.parse(refused.body) as ApiErrorBody).error.code, 'QUOTA_EXCEEDED');
      assert.equal(
        await target.store.messages.countBySenderSince(sender.user.id, new Date(0).toISOString()),
        3,
        'the quota is the quota, whichever instance the request reached',
      );
    });

    it('keys the budget per sender, so an exhausted account blocks only itself', async () => {
      const spender = await harness.registerUser();
      const bystander = await harness.registerUser();
      for (const subject of ['One', 'Two', 'Three']) {
        assert.equal((await open(harness, spender, subject)).statusCode, 201);
      }
      assert.equal((await open(other, spender, 'Four')).statusCode, 429);
      assert.equal(
        (await open(other, bystander, 'Unrelated')).statusCode,
        201,
        'the key is per sender, so one exhausted account never blocks another',
      );
    });
  });
}
