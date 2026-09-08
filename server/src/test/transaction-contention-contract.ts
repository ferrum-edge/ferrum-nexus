/**
 * Two Nexus instances, one database, one row: what the store contract promises
 * when transactions contend.
 *
 * These cases need a **second store over the same database** — two pools, two
 * transaction queues, the shape a multi-instance deployment has. Serialising
 * bodies orders one store object's transactions and nothing else, so this is
 * the only way to reach the engine behaviour the adapters have to survive:
 *
 * - **MySQL** ([#152](https://github.com/ferrum-edge/ferrum-nexus/issues/152)):
 *   two transactions that each insert a child row and then update its parent
 *   take the foreign key's shared lock before the row's exclusive lock and
 *   deadlock. InnoDB rolls one of them back and expects it to be run again.
 * - **MongoDB** ([#143](https://github.com/ferrum-edge/ferrum-nexus/issues/143)):
 *   a body that reads a document, and *then* has an ordinary non-transactional
 *   write land on it, cannot commit its own write — the server reports a write
 *   conflict labelled `TransientTransactionError` and asks to be retried.
 *
 * Both used to end as a `500` carrying a driver error, with the body's work
 * lost. The assertions here are the same on every adapter: the work commits,
 * exactly once, and nothing driver-shaped ever reaches the caller.
 *
 * The sqlite target has no peer — one connection, one body at a time, no
 * contention class to survive — so these are skipped there.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type { NexusStore, UserRecord } from '../db/store.js';
import { isNexusError } from '../lib/errors.js';
import { newId, nowIso } from '../lib/ids.js';

/** What a target must offer for these cases to run. */
export interface ContentionTarget {
  store: NexusStore;
  teardown: () => Promise<void>;
  /** A second store over the same database, or absent when there cannot be one. */
  peer?: () => Promise<NexusStore>;
}

/** A promise plus the handle that settles it. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/**
 * A two-party latch that gives up waiting.
 *
 * Widening the window is the point — a barrier makes a race that is otherwise
 * a few microseconds wide reproducible. Giving up is what keeps the test
 * honest once the lock order is fixed: the second writer then blocks on the
 * *engine* instead of reaching the barrier, so a barrier that insisted on both
 * parties would hang rather than pass.
 */
function latch(parties: number, timeoutMs: number): () => Promise<void> {
  let waiting = 0;
  const opened = deferred();
  let timer: NodeJS.Timeout | null = null;
  const open = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    opened.resolve();
  };
  return async (): Promise<void> => {
    waiting += 1;
    if (waiting >= parties) open();
    else if (timer === null) timer = setTimeout(open, timeoutMs);
    await opened.promise;
  };
}

export function runTransactionContentionContract(
  label: string,
  makeStore: () => Promise<ContentionTarget>,
): void {
  describe(`transaction contention — ${label}`, () => {
    let target: ContentionTarget;
    let store: NexusStore;
    let peer: NexusStore | null = null;

    before(async () => {
      target = await makeStore();
      store = target.store;
      peer = target.peer ? await target.peer() : null;
    });

    after(async () => {
      if (peer) await peer.close();
      await target.teardown();
    });

    async function makeUser(): Promise<UserRecord> {
      return store.users.create({
        email: `${newId()}@example.test`,
        password_hash: 'scrypt:16384:8:1:c2FsdA==:aGFzaA==',
        display_name: 'Contender',
        role: 'client',
        status: 'active',
        email_verified: true,
      });
    }

    /** A thread with one opening message, and the two people in it. */
    async function makeThread(): Promise<{ threadId: string; a: UserRecord; b: UserRecord }> {
      const a = await makeUser();
      const b = await makeUser();
      const thread = await store.threads.create({
        subject: `Contention ${newId().slice(0, 6)}`,
        created_by: a.id,
        participant_a: a.id,
        participant_b: b.id,
      });
      await store.messages.create({
        thread_id: thread.id,
        sender_user_id: a.id,
        body: 'Opening message',
      });
      await store.threads.touchLastMessage(thread.id, nowIso());
      return { threadId: thread.id, a, b };
    }

    it('two replies that deadlock on the thread row both still commit', async (t) => {
      if (!peer) return t.skip('one connection: two bodies cannot contend');
      const { threadId, a, b } = await makeThread();
      const both = latch(2, 500);

      // Deliberately the *wrong* lock order — insert the child, then update the
      // parent — because that is the shape InnoDB deadlocks on, and the shape
      // the adapter's retry has to survive. `messaging/service.ts` takes the
      // thread row first so the cycle cannot form in the first place.
      const reply = (from: NexusStore, sender: string): Promise<void> =>
        from.transaction(async (tx) => {
          await tx.messages.create({
            thread_id: threadId,
            sender_user_id: sender,
            body: `Reply from ${sender}`,
          });
          await both();
          await tx.threads.touchLastMessage(threadId, nowIso());
        });

      await Promise.all([reply(store, a.id), reply(peer, b.id)]);

      assert.equal(
        await store.messages.countByThread(threadId),
        3,
        'the opener and both replies are stored — no reply was lost, none duplicated',
      );
    });

    it('the messaging lock order does not deadlock, so nothing has to be retried', async (t) => {
      if (!peer) return t.skip('one connection: two bodies cannot contend');
      const { threadId, a, b } = await makeThread();
      const both = latch(2, 500);
      const runs = new Map<string, number>();

      // The order `messaging/service.ts` uses: the thread row is taken first,
      // so the second writer waits for the first instead of cycling with it.
      const reply = (from: NexusStore, sender: string): Promise<void> =>
        from.transaction(async (tx) => {
          runs.set(sender, (runs.get(sender) ?? 0) + 1);
          await tx.threads.touchLastMessage(threadId, nowIso());
          await both();
          await tx.messages.create({
            thread_id: threadId,
            sender_user_id: sender,
            body: `Reply from ${sender}`,
          });
        });

      await Promise.all([reply(store, a.id), reply(peer, b.id)]);

      assert.equal(await store.messages.countByThread(threadId), 3);
      if (store.driver !== 'mongodb') {
        // MongoDB has no row locks to take in order — two updates to one
        // document conflict and one body is legitimately re-run. Every engine
        // that does have them must not need the retry here.
        assert.deepEqual(
          [runs.get(a.id), runs.get(b.id)],
          [1, 1],
          'neither body was rolled back, so neither was run twice',
        );
      }
    });

    it('a body writing a row an outside write already moved still commits', async (t) => {
      if (!peer) return t.skip('one connection: an outside write cannot interleave');
      const user = await makeUser();
      const read = deferred();
      const outsideWrite = deferred();

      const body = store.transaction(async (tx) => {
        // Establishes this transaction's snapshot of the row…
        await tx.users.findById(user.id);
        read.resolve();
        // …which the write below then has to be reconciled with.
        await outsideWrite.promise;
        const updated = await tx.users.update(user.id, {
          display_name: 'From inside the transaction',
        });
        assert.ok(updated, 'the row is still there');
      });

      await read.promise;
      await peer.users.touchLastLogin(user.id, nowIso());
      outsideWrite.resolve();
      await body;

      const after = await store.users.findById(user.id);
      assert.equal(
        after?.display_name,
        'From inside the transaction',
        "the transaction's write survived the race rather than being dropped",
      );
      assert.notEqual(after?.last_login_at, null, 'and the outside write is still there too');
    });

    it('a terminal conflict reaches the caller as CONFLICT, never as a driver error', async (t) => {
      if (!peer) return t.skip('one connection: an outside write cannot interleave');
      const user = await makeUser();
      const read = deferred();
      const outsideWrite = deferred();

      // The same race, with the retry deliberately switched off: whatever the
      // engine does with it, the caller must not see a driver error type.
      const body = store.transaction(
        async (tx) => {
          await tx.users.findById(user.id);
          read.resolve();
          await outsideWrite.promise;
          await tx.users.update(user.id, { display_name: 'Unretried' });
        },
        { retry: false },
      );

      await read.promise;
      await peer.users.touchLastLogin(user.id, nowIso());
      outsideWrite.resolve();

      const outcome = await body.then(
        () => null,
        (error: unknown) => error,
      );
      if (outcome !== null) {
        assert.ok(
          isNexusError(outcome),
          `expected a NexusError, got ${String((outcome as Error)?.name ?? outcome)}`,
        );
        assert.equal(outcome.code, 'CONFLICT');
        assert.deepEqual(
          (outcome.details as { reason?: string } | undefined)?.reason,
          'transaction_contention',
        );
        const after = await store.users.findById(user.id);
        assert.notEqual(after?.display_name, 'Unretried', 'a rolled-back body wrote nothing');
      }
    });
  });
}
