/**
 * Fencing for the cross-instance leases `createKeyedSerializer` takes.
 *
 * A lease expires. An instance that stalls inside its critical section for
 * longer than the TTL — a long GC pause, a hung upstream, a renewal that kept
 * failing — can resume after another instance has taken the same key and acted
 * on it, and without a fence its later writes still commit: the API row delete
 * that follows a test-consumer teardown, a count-then-insert behind a budget,
 * a status flip behind the last-super-admin guard (issue #384).
 *
 * The fence is the lease row itself. Every acquisition writes a fresh token as
 * the row's `owner`, so the row names one acquisition and never a process, and
 * a token that has been replaced never comes back. While a section runs, the
 * leases it holds are recorded in an {@link AsyncLocalStorage}; every
 * `store.transaction` opened from inside the section captures them and, as the
 * last statement of its body, asks the lease table whether each token still
 * holds its key ({@link LeaseRepo.verify}). A stale holder's transaction fails
 * with `CONFLICT` and rolls back, so what it wrote never commits.
 *
 * The check is made **at commit**, not at the start, and that is enough: a
 * token that still holds its key at the end of the body held it throughout,
 * because nothing hands a key back to a replaced token. On the pooled adapters
 * the check is an `UPDATE` of the lease row (a write, on MongoDB), so the row
 * stays locked until the transaction commits and a takeover waits for the
 * holder's writes rather than overlapping them. Verifying last also keeps that
 * lock as short as possible — a body that probes or renews the lease from
 * another connection is never left waiting on its own transaction.
 *
 * What it cannot fence is Ferrum Edge: Edge's whole-resource `PUT`s carry no
 * concurrency token, so a stale holder's gateway write still lands. The fence
 * closes the database half; `docs/operations.md` §8 describes the rest.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import type { LeaseRepo } from '../db/store.js';
import { conflict, type NexusError } from './errors.js';

/** One lease a critical section holds: its key, and the acquisition's token. */
export interface LeaseFence {
  readonly key: string;
  readonly token: string;
}

/** A held lease, plus whether the section that took it is still running. */
interface HeldLease extends LeaseFence {
  live: boolean;
}

/** `CONFLICT` text for a transaction whose lease changed hands before it could commit. */
export const LEASE_LOST_MESSAGE =
  'This change took too long and another portal instance has taken it over — please retry';

const held = new AsyncLocalStorage<readonly HeldLease[]>();

/** Every `CONFLICT` the fence raised, so {@link isLeaseLost} can tell them apart. */
const refusals = new WeakSet<object>();

/** A fence refusal carrying `message`. */
function leaseLost(message: string): NexusError {
  const error = conflict(message);
  refusals.add(error);
  return error;
}

/** Whether `error` is the fence refusing a transaction whose lease changed hands. */
export function isLeaseLost(error: unknown): boolean {
  return typeof error === 'object' && error !== null && refusals.has(error);
}

/**
 * Run `fn`, answering a fence refusal with `message` instead of
 * {@link LEASE_LOST_MESSAGE} — for a caller whose user is owed something more
 * precise than "this change took too long", such as a sign-in, or a password
 * change whose new password committed before the refusal.
 */
export async function rewordLeaseLost<T>(message: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (isLeaseLost(error)) throw leaseLost(message);
    throw error;
  }
}

/**
 * Run `fn` as the holder of `key` under `token`.
 *
 * Nested sections stack: a transaction opened inside both an outer and an
 * inner key verifies both. The record is marked dead when the section ends, so
 * work the section merely started — a detached promise that outlives it —
 * does not claim a lease nobody holds any more; its transactions are simply
 * unfenced, exactly as they would be had they been started outside.
 */
export async function holdingLease<T>(
  key: string,
  token: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lease: HeldLease = { key, token, live: true };
  try {
    return await held.run([...(held.getStore() ?? []), lease], fn);
  } finally {
    lease.live = false;
  }
}

/** The leases the calling async context holds right now, ordered by key. */
export function heldLeaseFences(): readonly LeaseFence[] {
  const stack = held.getStore();
  if (!stack) return [];
  return stack
    .filter((lease) => lease.live)
    .map(({ key, token }) => ({ key, token }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * Refuse with `CONFLICT` unless every fence still holds its key.
 *
 * `leases` must be the transaction-scoped repository, so that on the pooled
 * adapters the check runs — and locks the row — inside the transaction it
 * guards. Keys are checked in a fixed order, so two transactions that fence
 * the same pair can never lock the rows in opposite orders.
 */
export async function assertLeaseFences(
  leases: LeaseRepo,
  fences: readonly LeaseFence[],
): Promise<void> {
  for (const fence of fences) {
    if (!(await leases.verify(fence.key, fence.token))) throw leaseLost(LEASE_LOST_MESSAGE);
  }
}

/**
 * Wrap a `store.transaction` body so it is fenced by the leases held where the
 * transaction was *opened*.
 *
 * Call it synchronously from `transaction()` itself, before any queueing, so
 * the capture sees the caller's context rather than whatever the adapter's
 * queue resumes in. With no lease held it returns `fn` unchanged and costs
 * nothing. `when: 'begin'` is for MongoDB's standalone degradation, which has
 * no atomic commit to protect: there a stale body is refused before it writes
 * anything rather than after it already has.
 */
export function fenceTransactionBody<S extends { readonly leases: LeaseRepo }, T>(
  fn: (tx: S) => Promise<T>,
  when: 'commit' | 'begin' = 'commit',
): (tx: S) => Promise<T> {
  const fences = heldLeaseFences();
  if (fences.length === 0) return fn;
  if (when === 'begin') {
    return async (tx) => {
      await assertLeaseFences(tx.leases, fences);
      return fn(tx);
    };
  }
  return async (tx) => {
    const result = await fn(tx);
    await assertLeaseFences(tx.leases, fences);
    return result;
  };
}
