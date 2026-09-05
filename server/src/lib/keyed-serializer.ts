/**
 * A per-key critical section that holds across processes.
 *
 * Two serializers built from this factory over the same `leases` repository
 * take turns even when they live in separate Nexus instances against one
 * database. There are two users of it, and they must share one implementation
 * because they share the `leases` table:
 *
 * - the **Ferrum Edge client**, where `PUT /consumers/{id}` and
 *   `PUT /proxies/{id}` are whole-resource replaces with no concurrency token,
 *   so two overlapping GET→edit→PUT round trips silently lose one edit;
 * - the composition root's **store-level locks**, which hold the invariants a
 *   single database transaction cannot hold across instances — the
 *   last-super-admin count-then-write above all, where two instances each count
 *   one *other* active super admin and both demote.
 *
 * It lives in `lib/` rather than in `ferrum-admin/` because the second user has
 * nothing to do with the gateway; `ferrum-admin/index.ts` re-exports it so the
 * Edge client's callers still import it from there.
 */

import { randomUUID } from 'node:crypto';

import type { LeaseRepo } from '../db/store.js';
import { conflict } from './errors.js';

/** Runs work serially per key; independent keys still run concurrently. */
export type KeyedSerializer = <T>(key: string, fn: () => Promise<T>) => Promise<T>;

/** How long a freshly taken lease is valid before another instance may steal it. */
export const LEASE_TTL_MS = 60_000;

/** How long a caller waits for a lease another instance is holding. */
export const LEASE_WAIT_MS = 30_000;

/** Base interval between attempts while waiting; jittered on every retry. */
export const LEASE_POLL_MS = 100;

/** What a caller that waited out `waitMs` is told. */
export const LEASE_CONFLICT_MESSAGE =
  'Another portal instance is updating this gateway resource right now — please retry';

/**
 * The one key every transition that can shrink the active `super_admin` set is
 * taken under: a role change away from `super_admin`, a `status: 'disabled'`,
 * and god mode's `disable-user`.
 *
 * It is deliberately a single canonical key rather than one per user. The
 * invariant is a property of the *set*, and two requests demoting two different
 * accounts are exactly the race that empties it, so per-user keys would let both
 * through. One key also means there is no lock order to get wrong.
 */
export const SUPER_ADMIN_LOCK_KEY = 'users:super-admins';

/** `CONFLICT` text for a caller that could not get {@link SUPER_ADMIN_LOCK_KEY}. */
export const SUPER_ADMIN_LOCK_CONFLICT_MESSAGE =
  'Another administrator change is in flight right now — please retry';

/**
 * The per-account **lifecycle** key: every `status` transition of one account
 * (`PATCH /api/users/:id`, god mode's `disable-user`) and every registration
 * of a new gateway identity for it are taken under this key.
 *
 * The two have to be ordered against each other, not merely against other
 * writes to the same Edge consumer. A provider's first test consumer has no
 * consumer id and no credential row until its issuance is well under way, so
 * a disable that lands in between finds nothing to tear down — unless the
 * identity was registered durably *before* the gateway was touched, and that
 * registration was atomic with respect to the status flip. This key is what
 * makes it atomic: the registration checks the account is still active and
 * writes its row inside the section, and the disable flips the status inside
 * it too, so whichever wins, the teardown that follows the flip sees every
 * identity the account got as far as registering.
 *
 * Per account rather than portal-wide: the invariant is a property of one
 * account, and two different accounts never need to wait for each other. It is
 * always taken **inside** {@link SUPER_ADMIN_LOCK_KEY} when both are needed,
 * and a caller that holds a gateway consumer key may take it — never the
 * reverse — which is what keeps the three keys free of lock-order inversion.
 */
export function userLifecycleLockKey(userId: string): string {
  return `users:lifecycle:${userId}`;
}

/** Options for {@link createKeyedSerializer}. */
export interface KeyedSerializerOptions {
  /**
   * Cross-instance lock table. Without it the serializer degrades to the
   * in-process queue it has always been — correct for a single writer, and the
   * shape the client's own unit tests use.
   */
  leases?: LeaseRepo;
  /** Identity written into the lease row. Defaults to a per-process random id. */
  owner?: string;
  /** Lease lifetime. Defaults to {@link LEASE_TTL_MS}. */
  ttlMs?: number;
  /** How long to wait for a contended lease. Defaults to {@link LEASE_WAIT_MS}. */
  waitMs?: number;
  /** Base poll interval while waiting. Defaults to {@link LEASE_POLL_MS}. */
  pollMs?: number;
  /**
   * `CONFLICT` message for a caller that waited out `waitMs`. Defaults to
   * {@link LEASE_CONFLICT_MESSAGE}, which is worded for the gateway; a
   * store-level lock should pass something that describes what it guards.
   */
  conflictMessage?: string;
}

/**
 * Sleep between lease attempts.
 *
 * Deliberately **not** `unref`ed: a waiting caller is holding an `await` that
 * has to resolve, and an unreferenced timer lets the event loop drain out from
 * under it — the promise then never settles at all. The wait is bounded by
 * `waitMs`, so the worst it can do to a shutdown is delay it by that much.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build a per-key critical section.
 *
 * Two layers, in this order:
 *
 * 1. **An in-process promise queue.** The fast path, and the re-entrancy
 *    contract callers already rely on: work queued for the same key from the
 *    same process never overlaps, and nesting the *same* key deadlocks.
 * 2. **A database lease**, taken *inside* the queued section when a
 *    {@link LeaseRepo} is supplied. This is what orders instances against each
 *    other: only one process in the deployment holds `key` at a time. The lease
 *    expires on its own ({@link LEASE_TTL_MS}), so an instance that crashes
 *    mid-section blocks the key for at most that long rather than forever, and
 *    a section that outlives the TTL renews at half of it.
 *
 * A caller that cannot get the lease within `waitMs` gets a `CONFLICT`, not a
 * silent overwrite.
 *
 * **Never take one of these inside a store transaction.** The lease repository
 * issues statements of its own, and on the SQLite adapter — one connection,
 * bodies drained by a promise queue — that deadlocks. Measured on the adapter:
 * a caller that opens a transaction and *then* waits for a key held by another
 * owner holds `BEGIN` and the transaction queue while it spins, so the holder
 * cannot run the transaction it needs in order to finish and release. Nothing
 * breaks the cycle except the waiter's own `waitMs` ({@link LEASE_WAIT_MS}, 30
 * seconds), after which it fails with `CONFLICT` and the holder completes
 * immediately. Acquire the key first, then open the transaction inside the
 * section.
 */
export function createKeyedSerializer(options: KeyedSerializerOptions = {}): KeyedSerializer {
  const queues = new Map<string, Promise<unknown>>();
  const leases = options.leases;
  const owner = options.owner ?? randomUUID();
  const ttlMs = options.ttlMs ?? LEASE_TTL_MS;
  const waitMs = options.waitMs ?? LEASE_WAIT_MS;
  const pollMs = options.pollMs ?? LEASE_POLL_MS;
  const conflictMessage = options.conflictMessage ?? LEASE_CONFLICT_MESSAGE;

  /** Block until this process owns `key`, or `waitMs` has passed. */
  async function takeLease(key: string, repo: LeaseRepo): Promise<void> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const now = Date.now();
      if (
        await repo.acquire(
          key,
          owner,
          new Date(now + ttlMs).toISOString(),
          new Date(now).toISOString(),
        )
      ) {
        return;
      }
      if (Date.now() >= deadline) {
        // Deliberately vague about which instance and which key: this reaches a
        // browser, and "retry" is the whole of the useful advice.
        throw conflict(conflictMessage);
      }
      // Jitter, so several waiters do not retry in lockstep for ever.
      await sleep(pollMs + Math.floor(Math.random() * pollMs));
    }
  }

  /** Run `fn` while holding the database lease for `key`. */
  async function underLease<T>(key: string, repo: LeaseRepo, fn: () => Promise<T>): Promise<T> {
    await takeLease(key, repo);
    // A long section (a teardown walking every credential type, say) must not
    // let its own lease lapse under a waiter. Renewing at half the TTL leaves a
    // full half-TTL of slack for a slow round trip.
    const renewal = setInterval(
      () => {
        void repo
          .renew(key, owner, new Date(Date.now() + ttlMs).toISOString())
          .catch(() => undefined);
      },
      Math.max(1, Math.floor(ttlMs / 2)),
    );
    // Unreferenced, unlike the wait above: this timer only ever accompanies a
    // running critical section, which keeps the loop alive by itself, and it
    // must not be what holds a shutting-down process open.
    renewal.unref?.();
    try {
      return await fn();
    } finally {
      clearInterval(renewal);
      // Best effort: a lease we failed to delete simply expires. Never let a
      // release failure mask the outcome of the critical section.
      await repo.release(key, owner).catch(() => undefined);
    }
  }

  return function serializePerKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const guarded = leases ? (): Promise<T> => underLease(key, leases, fn) : fn;
    const previous = queues.get(key) ?? Promise.resolve();
    const result = previous.then(guarded, guarded);
    const guard: Promise<void> = result
      .then(
        () => undefined,
        () => undefined,
      )
      .then(() => {
        if (queues.get(key) === guard) queues.delete(key);
      });
    queues.set(key, guard);
    return result;
  };
}
