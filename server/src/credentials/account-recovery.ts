/**
 * The account-recovery revocation worker — the retry loop behind a trusted
 * password reset.
 *
 * A reset that establishes an account's first trusted proof of its address
 * (see `auth/service.ts`) owes a revocation of every live credential the
 * account and its applications hold. The reset itself is a database write, but
 * the revocation is an HTTP call to Ferrum Edge; a failed call cannot roll the
 * reset back, and — because the proof has already been upgraded — every later
 * reset would treat the revocation as done and never retry.
 *
 * So the reset writes an `account_recovery_jobs` row in the **same
 * transaction**, making the debt commit with the account state. This worker
 * polls it and runs the revocation, and an inline attempt runs immediately
 * after the reset so the common case settles without waiting for a tick:
 *
 * - **success** → the row is deleted, and the account may issue credentials
 *   again;
 * - **failure** → the row returns to `pending` with exponential backoff, a
 *   `warn` line records it, and credential issuance stays blocked until a
 *   later attempt succeeds.
 *
 * There is deliberately no `failed` state: a credential that still
 * authenticates is not something to give up on.
 */

import type { AccountRecoveryJobRecord, NexusStore } from '../db/store.js';
import type { CredentialsService } from './service.js';

/** Poll interval, matching the teardown worker's. */
export const ACCOUNT_RECOVERY_POLL_INTERVAL_MS = 5_000;

/** Jobs claimed per poll. */
export const ACCOUNT_RECOVERY_BATCH_SIZE = 10;

/** First retry delay; each further attempt doubles it. */
export const ACCOUNT_RECOVERY_BASE_BACKOFF_MS = 10_000;

/** Upper bound on a single backoff. */
export const ACCOUNT_RECOVERY_MAX_BACKOFF_MS = 5 * 60_000;

/** A `sending` job untouched for this long is assumed to be a crashed worker's. */
export const ACCOUNT_RECOVERY_STALE_AFTER_MS = 5 * 60_000;

/** Delay before the next attempt: `10s · 2^attempts`, capped, plus up to 10% jitter. */
export function accountRecoveryBackoffMs(
  attempts: number,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, Math.min(attempts, 16));
  const base = Math.min(
    ACCOUNT_RECOVERY_BASE_BACKOFF_MS * 2 ** exponent,
    ACCOUNT_RECOVERY_MAX_BACKOFF_MS,
  );
  return Math.round(base + base * 0.1 * random());
}

/** The outcome of one attempt at an outstanding recovery revocation. */
export interface AccountRecoveryAttempt {
  /** `ok` when the revocation landed and the job is gone; `pending` when it is owed again. */
  outcome: 'ok' | 'pending';
  /** Credentials revoked this attempt. */
  revoked: number;
  error: string | null;
}

/** Input for {@link runAccountRecovery}. */
export interface RunAccountRecoveryInput {
  credentials: Pick<CredentialsService, 'revokeForAccountRecovery'>;
  store: NexusStore;
  userId: AccountRecoveryJobRecord['user_id'];
  ip?: string | null;
  /** Exact queued generation or worker claim. Never look up a replacement after Edge work. */
  job: AccountRecoveryJobRecord | null;
  log?: (obj: Record<string, unknown>, message: string) => void;
  /** Injectable clock so tests can assert exact backoff stamps. */
  now?: () => Date;
  /** Injectable jitter source; defaults to `Math.random`. */
  random?: () => number;
}

/**
 * Run one recovery revocation and settle the durable job behind it.
 *
 * Success deletes the row; failure returns it to `pending` on a backoff so the
 * next tick retries. A job that is no longer the current generation — a later
 * reset re-queued it, or another worker claimed it — is left alone.
 */
export async function runAccountRecovery(
  input: RunAccountRecoveryInput,
): Promise<AccountRecoveryAttempt> {
  const { credentials, store, userId, ip = null, log } = input;
  const now = input.now ?? ((): Date => new Date());
  const random = input.random ?? Math.random;
  let claimed: AccountRecoveryJobRecord | null = null;
  try {
    if (!input.job || input.job.user_id !== userId) {
      throw new Error('Account recovery has no matching queued generation');
    }
    claimed =
      input.job.status === 'pending'
        ? await store.accountRecoveryJobs.claimPending(input.job)
        : input.job.status === 'sending'
          ? input.job
          : null;
    if (!claimed) throw new Error('Account recovery attempt was superseded');
    const current = await store.accountRecoveryJobs.findByUser(userId);
    if (
      !current ||
      current.id !== claimed.id ||
      current.generation !== claimed.generation ||
      current.status !== 'sending'
    ) {
      throw new Error('Account recovery attempt was superseded');
    }

    const user = await store.users.findById(userId);
    if (!user) {
      // The account was deleted after the reset. The row cascades with it, but
      // drop the claim so a stale generation cannot linger.
      await store.accountRecoveryJobs.deleteClaimed(claimed);
      return { outcome: 'ok', revoked: 0, error: null };
    }

    const revoked = await credentials.revokeForAccountRecovery(user, ip);
    if (!(await store.accountRecoveryJobs.deleteClaimed(claimed))) {
      throw new Error('Account recovery attempt was superseded');
    }
    return { outcome: 'ok', revoked, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (claimed) {
      // An inline attempt returns only its claim to the queue, immediately: the
      // worker applies the backoff to claims it supplies. A failed store write
      // leaves SENDING for the stale sweep, which recovers it on a later tick.
      const delay =
        input.job?.status === 'pending'
          ? 0
          : accountRecoveryBackoffMs(claimed.attempts, random);
      const nextAt = new Date(now().getTime() + delay).toISOString();
      try {
        await store.accountRecoveryJobs.reschedule(claimed, nextAt, message);
      } catch {
        // A failed store write leaves SENDING for the stale sweep, which
        // recovers it on a later tick.
      }
    }
    log?.(
      { user_id: userId, error: message },
      'Account recovery revocation failed; credential issuance stays blocked',
    );
    return { outcome: 'pending', revoked: 0, error: message };
  }
}

/** What one {@link AccountRecoveryWorker.tick} did. */
export interface AccountRecoveryTickResult {
  /** `sending` rows older than the stale threshold returned to `pending`. */
  released: number;
  /** Jobs claimed from the queue. */
  claimed: number;
  /** Revocations Edge confirmed and whose rows were deleted. */
  completed: number;
  /** Credentials revoked across completed jobs. */
  revoked: number;
  /** Attempts that failed and were rescheduled. */
  rescheduled: number;
  /** Jobs whose processing threw; recovered by a later tick's stale sweep. */
  abandoned: number;
}

/** The background recovery-revocation retrier. */
export interface AccountRecoveryWorker {
  /** Begin polling. Idempotent. */
  start(): void;
  /** Stop polling and wait for an in-flight tick. Idempotent. */
  stop(): Promise<void>;
  /** Run exactly one poll cycle. Exposed for deterministic tests. */
  tick(): Promise<AccountRecoveryTickResult>;
  /** Whether the poll timer is currently installed. */
  isRunning(): boolean;
}

/** Dependencies of {@link createAccountRecoveryWorker}. */
export interface AccountRecoveryWorkerDeps {
  store: NexusStore;
  credentials: Pick<CredentialsService, 'revokeForAccountRecovery'>;
  log?: (obj: Record<string, unknown>, message: string) => void;
  /** Poll interval; defaults to {@link ACCOUNT_RECOVERY_POLL_INTERVAL_MS}. */
  pollIntervalMs?: number;
  batchSize?: number;
  /** Injectable clock so tests can assert exact backoff stamps. */
  now?: () => Date;
  /** Injectable jitter source; defaults to `Math.random`. */
  random?: () => number;
}

/** Build the recovery worker. The caller owns `start()`/`stop()`. */
export function createAccountRecoveryWorker(
  deps: AccountRecoveryWorkerDeps,
): AccountRecoveryWorker {
  const { store, credentials } = deps;
  const log = deps.log ?? ((): void => {});
  const pollIntervalMs = deps.pollIntervalMs ?? ACCOUNT_RECOVERY_POLL_INTERVAL_MS;
  const batchSize = deps.batchSize ?? ACCOUNT_RECOVERY_BATCH_SIZE;
  const now = deps.now ?? ((): Date => new Date());
  const random = deps.random ?? Math.random;

  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<AccountRecoveryTickResult> | null = null;

  async function runJob(
    result: AccountRecoveryTickResult,
    job: AccountRecoveryJobRecord,
  ): Promise<void> {
    const attempt = await runAccountRecovery({
      credentials,
      store,
      userId: job.user_id,
      job,
      log: (obj, message) => log({ ...obj, attempts: job.attempts }, message),
      now,
      random,
    });
    if (attempt.outcome === 'pending') {
      result.rescheduled += 1;
      return;
    }
    result.completed += 1;
    result.revoked += attempt.revoked;
    log(
      { user_id: job.user_id, attempts: job.attempts, revoked: attempt.revoked },
      'Account recovery revocation completed',
    );
  }

  async function releaseStale(result: AccountRecoveryTickResult): Promise<void> {
    const staleBefore = new Date(now().getTime() - ACCOUNT_RECOVERY_STALE_AFTER_MS).toISOString();
    result.released = await store.accountRecoveryJobs.releaseStale(staleBefore);
    if (result.released > 0) {
      log({ released: result.released }, 'Released stale account recovery claims');
    }
  }

  async function runTick(): Promise<AccountRecoveryTickResult> {
    const result: AccountRecoveryTickResult = {
      released: 0,
      claimed: 0,
      completed: 0,
      revoked: 0,
      rescheduled: 0,
      abandoned: 0,
    };
    try {
      await releaseStale(result);
    } catch (error) {
      log(
        { error: error instanceof Error ? error.message : String(error) },
        'Could not release stale account recovery claims',
      );
    }

    for (let taken = 0; taken < batchSize; taken += 1) {
      let job: AccountRecoveryJobRecord | undefined;
      try {
        [job] = await store.accountRecoveryJobs.claimDue(now().toISOString(), 1);
      } catch (error) {
        log(
          { error: error instanceof Error ? error.message : String(error) },
          'Account recovery tick failed',
        );
        return result;
      }
      if (!job) return result;
      result.claimed += 1;
      try {
        await runJob(result, job);
      } catch (error) {
        result.abandoned += 1;
        log(
          {
            user_id: job.user_id,
            attempts: job.attempts,
            error: error instanceof Error ? error.message : String(error),
          },
          'Account recovery job was abandoned mid-flight; the stale sweep recovers it',
        );
      }
    }
    return result;
  }

  async function tick(): Promise<AccountRecoveryTickResult> {
    if (inFlight) return inFlight;
    inFlight = runTick();
    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  }

  return {
    tick,
    isRunning: () => timer !== null,

    start(): void {
      if (timer !== null) return;
      timer = setInterval(() => void tick(), pollIntervalMs);
      timer.unref?.();
      void tick();
    },

    async stop(): Promise<void> {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      if (inFlight) {
        try {
          await inFlight;
        } catch {
          // `tick()` already logs; stopping must not throw.
        }
      }
    },
  };
}