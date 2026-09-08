/**
 * Retrying a transaction body the engine rolled back for contention.
 *
 * Every engine Nexus supports has a class of failure that means "your
 * transaction was rolled back through no fault of its own, run it again":
 * InnoDB picks a deadlock victim (`ER_LOCK_DEADLOCK`, SQLSTATE `40001`),
 * PostgreSQL reports a serialization failure or a detected deadlock (`40001`,
 * `40P01`), MongoDB labels a write conflict `TransientTransactionError` and
 * says so in the message. All three expect the *application* to run the body
 * again; none of the adapters did, so an ordinary concurrent write turned a
 * `store.transaction` body into work silently lost behind a `500` carrying a
 * raw driver error.
 *
 * This module is the one place that decides what "retryable" means, how long
 * to keep trying, and what a caller sees when the budget runs out. The adapters
 * supply the driver-specific classification — the error shapes are the only
 * part of this that is engine knowledge — and the store shells drive the loop.
 *
 * ## The contract this creates
 *
 * **A transaction body may run more than once, so it must be re-runnable.**
 * Everything a body does must either go through the transaction-scoped store —
 * where the rollback that precedes a retry undoes it — or be idempotent. A
 * gateway call, an email enqueued outside the outbox, a counter kept in memory:
 * none of those belong inside a body, and the architecture already said so
 * before retries made it load-bearing. A body that genuinely cannot honour it
 * passes `{ retry: false }` to `store.transaction`, which runs it exactly once
 * and translates a contention failure instead of re-running it.
 *
 * The sqlite adapter has one connection and serialises every body onto it, so
 * it has no contention class to retry and none of this applies to it.
 */

import type { DbDriver } from '@ferrum-nexus/shared';

import { NexusError } from '../../lib/errors.js';

/**
 * Attempts a contended body gets on the SQL engines before the caller is told
 * to try again. MongoDB is bounded by {@link MONGO_CONTENTION_BUDGET_MS}
 * instead, for the reason given there.
 */
export const TRANSACTION_RETRY_ATTEMPTS = 5;

/** First backoff step; doubles per attempt up to {@link TRANSACTION_RETRY_MAX_DELAY_MS}. */
export const TRANSACTION_RETRY_BASE_DELAY_MS = 10;

/** Ceiling on one backoff step, so a hot row still fails fast enough for HTTP. */
export const TRANSACTION_RETRY_MAX_DELAY_MS = 200;

/** Wall-clock budget for MongoDB's own retry envelope; see the adapter. */
export const MONGO_TRANSACTION_BUDGET_MS = 15_000;

/**
 * How long MongoDB goes on re-running a body that keeps losing the document.
 *
 * MongoDB does not queue on a lock inside a transaction: the loser of a
 * contended document is failed with a write conflict straight away rather than
 * made to wait for the winner, so on this engine the retry loop *is* the wait.
 * A budget counted in attempts is therefore spent in microseconds, while the
 * transaction that won is still working — which is why this one is counted in
 * wall clock, from the first re-run. It stays well below
 * {@link MONGO_TRANSACTION_BUDGET_MS}, which bounds the whole transaction
 * including this wait, and well below what a caller holding an HTTP request
 * open will tolerate.
 */
export const MONGO_CONTENTION_BUDGET_MS = 5_000;

/**
 * Backoff before re-running a body, in milliseconds.
 *
 * Exponential from {@link TRANSACTION_RETRY_BASE_DELAY_MS}, capped, and
 * jittered across the top half of each step: two transactions that deadlocked
 * against each other must not wake up together and do it again.
 *
 * @param attempt Number of the attempt that just failed, counting from 1.
 */
export function transactionRetryDelayMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, Math.min(attempt - 1, 16));
  const step = Math.min(
    TRANSACTION_RETRY_BASE_DELAY_MS * 2 ** exponent,
    TRANSACTION_RETRY_MAX_DELAY_MS,
  );
  return Math.round(step / 2 + (step / 2) * random());
}

/**
 * The `CONFLICT` a caller gets when the body could not be committed.
 *
 * A contention failure is not an internal error: the transaction rolled back
 * cleanly, nothing was applied, and trying again is a reasonable thing for the
 * caller to do. It is also the only thing a service or a route ever sees of a
 * driver's deadlock or write-conflict error — `cause` keeps the original for
 * the log without putting it in the response body.
 */
export function transactionContentionError(
  driver: DbDriver,
  attempts: number,
  cause: unknown,
): NexusError {
  return new NexusError(
    'CONFLICT',
    'Another change to the same data was committed first, so this one was rolled back and not ' +
      'applied. Nothing was saved — please try again.',
    { reason: 'transaction_contention', driver, attempts },
    { cause },
  );
}

/** How {@link runWithTransactionRetry} should treat one transaction. */
export interface TransactionRetryOptions {
  /** Reported in the terminal error's details. */
  driver: DbDriver;
  /** The adapter's classification of "rolled back for contention, run it again". */
  retryable: (error: unknown) => boolean;
  /** `false` runs the body exactly once; see the module docblock. */
  retry?: boolean;
  /** Attempt budget; defaults to {@link TRANSACTION_RETRY_ATTEMPTS}. */
  attempts?: number;
  /** Injectable jitter source, for tests. */
  random?: () => number;
  /** Injectable backoff, for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Sleep between attempts.
 *
 * Deliberately not `unref`ed, for the same reason the keyed serializer's is
 * not: a caller is holding an `await` that has to resolve, and an
 * unreferenced timer lets the event loop drain out from under it.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run one transaction, re-running it while the engine says it was rolled back
 * for contention.
 *
 * `run` must open, execute and commit or roll back a *whole* transaction: by
 * the time it rejects, the engine has already discarded the failed attempt, so
 * the next call starts from a clean state. A failure the adapter does not
 * classify as contention propagates untouched — a `CONFLICT` from a uniqueness
 * violation, a `NOT_FOUND` a body threw on purpose, a lost connection.
 */
export async function runWithTransactionRetry<T>(
  run: () => Promise<T>,
  options: TransactionRetryOptions,
): Promise<T> {
  const maxAttempts =
    options.retry === false ? 1 : Math.max(1, options.attempts ?? TRANSACTION_RETRY_ATTEMPTS);
  const wait = options.sleep ?? sleep;
  const random = options.random ?? Math.random;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (!options.retryable(error)) throw error;
      if (attempt >= maxAttempts) {
        throw transactionContentionError(options.driver, attempt, error);
      }
      await wait(transactionRetryDelayMs(attempt, random));
    }
  }
}

/* ── MongoDB's envelope ─────────────────────────────────────────────────── */

/** How {@link createMongoContentionGate} should treat one transaction. */
export interface MongoContentionGateOptions {
  /** `false` runs the body exactly once; see the module docblock. */
  retry?: boolean;
  /** Contention budget; defaults to {@link MONGO_CONTENTION_BUDGET_MS}. */
  budgetMs?: number;
  /** Injectable clock, for tests. */
  now?: () => number;
  /** Injectable jitter source, for tests. */
  random?: () => number;
  /** Injectable backoff, for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** The per-attempt gate {@link createMongoContentionGate} hands the adapter. */
export interface MongoContentionGate {
  /** How many times the body has been started. */
  readonly attempts: number;
  /**
   * Called at the top of every run of the `withTransaction` callback.
   *
   * The first run returns immediately. A re-run backs off first, and once the
   * budget is spent throws the terminal `CONFLICT`, carrying `lastError` — the
   * driver error the previous run failed with — as its cause. Throwing
   * something that is not a `MongoError` is also what stops the driver
   * retrying: it aborts and rethrows rather than looping on by itself.
   */
  beforeAttempt(lastError: unknown): Promise<void>;
}

/**
 * The wait MongoDB's retry envelope does not do for itself.
 *
 * `session.withTransaction()` re-runs its callback the instant the server
 * reports a `TransientTransactionError`, with no pause in between. That suits
 * the driver, whose own envelope runs for two minutes, and breaks a bounded
 * one: with no pause, a handful of runs are spent in microseconds and the body
 * that lost the document is failed while the body that won it is still
 * committing. This puts the SQL adapters' backoff, and a wall-clock budget,
 * in front of every re-run so that the envelope actually waits.
 *
 * Nothing is held while it does. `startTransaction` is client-side
 * bookkeeping — the server-side transaction begins with the body's first
 * operation — and the driver has already aborted the failed attempt by the
 * time it enters the callback again.
 */
export function createMongoContentionGate(
  options: MongoContentionGateOptions = {},
): MongoContentionGate {
  const budget = options.budgetMs ?? MONGO_CONTENTION_BUDGET_MS;
  const budgetMs = options.retry === false ? 0 : budget;
  const now = options.now ?? Date.now;
  const wait = options.sleep ?? sleep;
  const random = options.random ?? Math.random;

  let attempts = 0;
  let deadline = 0;

  return {
    get attempts(): number {
      return attempts;
    },
    async beforeAttempt(lastError: unknown): Promise<void> {
      if (attempts > 0) {
        // Started at the first re-run, so a body that spent a while working
        // before anything contended is not charged for that time.
        if (attempts === 1) deadline = now() + budgetMs;
        if (now() >= deadline) throw transactionContentionError('mongodb', attempts, lastError);
        await wait(transactionRetryDelayMs(attempts, random));
      }
      attempts += 1;
    },
  };
}

/* ── Driver classification ──────────────────────────────────────────────── */

/** Read a property off a driver error without trusting its type. */
function errorField(error: unknown, field: string): unknown {
  if (typeof error !== 'object' || error === null) return undefined;
  return (error as Record<string, unknown>)[field];
}

/** MongoDB error labels, through `hasErrorLabel` or the raw `errorLabels` array. */
function hasErrorLabel(error: unknown, label: string): boolean {
  const method = errorField(error, 'hasErrorLabel');
  if (typeof method === 'function') {
    return (method as (name: string) => unknown).call(error, label) === true;
  }
  const labels = errorField(error, 'errorLabels');
  return Array.isArray(labels) && labels.includes(label);
}

/** `ER_LOCK_DEADLOCK` (1213) and `ER_LOCK_WAIT_TIMEOUT` (1205), plus SQLSTATE `40001`. */
const MYSQL_RETRYABLE_CODES = new Set(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT']);
const MYSQL_RETRYABLE_ERRNOS = new Set([1213, 1205]);

/**
 * Is this mysql2 error InnoDB asking for the transaction to be run again?
 *
 * A deadlock victim's transaction is rolled back entirely by the server. A lock
 * wait timeout rolls back only the statement by default, which is why the
 * adapter still issues its own `ROLLBACK` before this is consulted — by the
 * time a retry starts, either way, nothing of the attempt survives.
 */
export function isMysqlRetryableTransactionError(error: unknown): boolean {
  if (errorField(error, 'sqlState') === '40001') return true;
  const code = errorField(error, 'code');
  if (typeof code === 'string' && MYSQL_RETRYABLE_CODES.has(code)) return true;
  const errno = errorField(error, 'errno');
  return typeof errno === 'number' && MYSQL_RETRYABLE_ERRNOS.has(errno);
}

/** `serialization_failure` and `deadlock_detected`, the two PostgreSQL class-40 codes. */
const POSTGRES_RETRYABLE_CODES = new Set(['40001', '40P01']);

/** Is this `pg` error PostgreSQL asking for the transaction to be run again? */
export function isPostgresRetryableTransactionError(error: unknown): boolean {
  const code = errorField(error, 'code');
  return typeof code === 'string' && POSTGRES_RETRYABLE_CODES.has(code);
}

/** `WriteConflict`, the server code behind a `TransientTransactionError` label. */
const MONGO_WRITE_CONFLICT_CODE = 112;

/**
 * Is this MongoDB error a contention failure the driver has given up on?
 *
 * Unlike the SQL predicates this is a *translation* predicate, not a retry one:
 * `session.withTransaction()` does the retrying, so an error that still reaches
 * the adapter has already exhausted the envelope. `MongoOperationTimeoutError`
 * is included because that is how the budget in
 * {@link MONGO_TRANSACTION_BUDGET_MS} expires — a body that could not commit in
 * time is contention, not an internal fault.
 */
export function isMongoTransactionContentionError(error: unknown): boolean {
  if (hasErrorLabel(error, 'TransientTransactionError')) return true;
  if (hasErrorLabel(error, 'UnknownTransactionCommitResult')) return true;
  if (errorField(error, 'code') === MONGO_WRITE_CONFLICT_CODE) return true;
  return errorField(error, 'name') === 'MongoOperationTimeoutError';
}
