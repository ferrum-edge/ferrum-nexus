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
 * **Two apps over one store is what "two instances" means here**, as it does in
 * the password-change and teardown contracts: each `buildTestApp` composes its
 * own keyed serializer and therefore contends for the lease under its own
 * owner. A genuinely separate second store is not available on every adapter —
 * a second SQLite `:memory:` store is a different database, not the same one —
 * and the property under test is about the two lease owners, not the two pools.
 * On the pooled adapters the two transactions really do overlap, which is what
 * makes the boundary case able to fail if the lease is removed.
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

/** The real messaging routes, on two instances over one database. */
export function runMessageBudgetContract(
  label: string,
  makeStore: () => Promise<{ store: NexusStore; teardown: () => Promise<void> }>,
): void {
  describe(`message budget contract — ${label}`, () => {
    let target: Awaited<ReturnType<typeof makeStore>>;
    let harness: TestApp;
    let other: TestApp;

    before(async () => {
      target = await makeStore();
      harness = await buildTestApp({
        store: target.store,
        env: ENV,
        deps: { startOutboxWorker: false },
      });
      other = await buildTestApp({
        store: target.store,
        edge: harness.edge,
        env: ENV,
        deps: { startOutboxWorker: false },
      });
      await harness.registerUser();
    });

    after(async () => {
      await other?.close();
      await harness?.close();
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

    it('accepts exactly one of two instances contending for the last slot', async () => {
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

    it('lets a different account through while one is contended', async () => {
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
