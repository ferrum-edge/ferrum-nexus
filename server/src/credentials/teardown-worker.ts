/**
 * The gateway teardown worker — the retry loop behind a disabled account.
 *
 * Disabling a portal account has two halves that cannot be committed together:
 * the Nexus row (`users.status = 'disabled'`, sessions deleted) and the Ferrum
 * Edge revocation (ACL groups cleared, every credential type deleted). Only the
 * first is a database write. The second is an HTTP call to another system, and
 * an issued API key keeps authenticating against the data plane for as long as
 * it is not made — with no portal session involved and, for an API published
 * `requestable: false`, no `access_control` plugin to stop it either.
 *
 * `GHSA-8vxw-j3wc-w6vm` was exactly that gap: the revocation was attempted
 * once, its failure was recorded on the audit row as `gateway_teardown:
 * "failed"`, and nothing ever tried again. This worker closes it.
 *
 * ## Contract
 *
 * The disable writes a `gateway_teardown_jobs` row inside the same transaction
 * as the status flip, so the debt is committed with the account state. This
 * worker polls every {@link TEARDOWN_POLL_INTERVAL_MS}, claims due rows (an
 * atomic `pending → sending` flip that increments `attempts`, so two workers
 * never claim the same job) and runs the revocation:
 *
 * - **success** → `markDone`, plus a `user.gateway_teardown_complete` audit row
 *   carrying what was actually revoked;
 * - **failure** → `reschedule` on an exponential backoff capped at
 *   {@link TEARDOWN_MAX_BACKOFF_MS}, and a `warn` line naming the user, the
 *   attempt count and the error. That line is the one to alert on;
 * - **the account is no longer disabled, or no longer exists** → the job is
 *   dropped. A revocation must never land on a re-enabled account. That is
 *   checked at claim time *and* again after an attempt that failed, because the
 *   re-enable can land mid-attempt — `disableGatewayAccess` refuses from inside
 *   the per-consumer lock, and there is nothing to retry.
 *
 * ## Why there is no `failed` state
 *
 * The outbox gives up after five attempts, because an undeliverable email is a
 * message nobody reads. A credential that still authenticates is the opposite:
 * giving up leaves a live security hole and reports it as settled. So retries
 * here are unbounded — the backoff flattens at five minutes and keeps going for
 * as long as the account is disabled. The only exits are success and the
 * account being re-enabled.
 *
 * `tick()` is exported on the worker so tests can drive exactly one cycle with
 * no timers involved.
 */

import { AuditAction, SYSTEM_ACTOR, type AuditService } from '../audit/service.js';
import type { GatewayTeardownJobRecord, NexusStore } from '../db/store.js';
import { runGatewayTeardown, type CredentialsService } from './service.js';

/** Poll interval, matching the outbox worker's. */
export const TEARDOWN_POLL_INTERVAL_MS = 5_000;

/** Jobs claimed per poll. */
export const TEARDOWN_BATCH_SIZE = 10;

/** First retry delay; each further attempt doubles it. */
export const TEARDOWN_BASE_BACKOFF_MS = 10_000;

/**
 * Upper bound on a single backoff.
 *
 * Five minutes rather than the outbox's hour: this is live credential exposure,
 * so a recovered gateway should be noticed quickly.
 */
export const TEARDOWN_MAX_BACKOFF_MS = 5 * 60_000;

/** A `sending` job untouched for this long is assumed to be a crashed worker's. */
export const TEARDOWN_STALE_AFTER_MS = 5 * 60_000;

/** What one {@link TeardownWorker.tick} did. */
export interface TeardownTickResult {
  /** Jobs claimed from the queue. */
  claimed: number;
  /** Revocations Edge confirmed. */
  completed: number;
  /** Attempts that failed and were rescheduled. */
  rescheduled: number;
  /** Jobs dropped because the account is active again or gone. */
  cancelled: number;
}

/** The background gateway-revocation retrier. */
export interface TeardownWorker {
  /** Release stale claims and begin polling. Idempotent. */
  start(): void;
  /** Stop polling and wait for an in-flight tick. Idempotent. */
  stop(): Promise<void>;
  /** Run exactly one poll cycle. Exposed for deterministic tests. */
  tick(): Promise<TeardownTickResult>;
  /** Whether the poll timer is currently installed. */
  isRunning(): boolean;
}

/** Dependencies of {@link createTeardownWorker}. */
export interface TeardownWorkerDeps {
  store: NexusStore;
  credentials: Pick<CredentialsService, 'disableGatewayAccess'>;
  audit: AuditService;
  log?: (obj: Record<string, unknown>, message: string) => void;
  /** Poll interval; defaults to {@link TEARDOWN_POLL_INTERVAL_MS}. */
  pollIntervalMs?: number;
  batchSize?: number;
  /** Injectable clock so tests can assert exact backoff stamps. */
  now?: () => Date;
  /** Injectable jitter source; defaults to `Math.random`. */
  random?: () => number;
}

/**
 * Delay before the next attempt: `10s · 2^attempts`, capped, plus up to 10%
 * jitter so a fleet of workers does not retry in lockstep.
 *
 * `attempts` is the post-claim count, so the first retry waits ~20 seconds.
 */
export function teardownBackoffMs(attempts: number, random: () => number = Math.random): number {
  const exponent = Math.max(0, Math.min(attempts, 16));
  const base = Math.min(TEARDOWN_BASE_BACKOFF_MS * 2 ** exponent, TEARDOWN_MAX_BACKOFF_MS);
  return Math.round(base + base * 0.1 * random());
}

/** Build the teardown worker. The caller owns `start()`/`stop()`. */
export function createTeardownWorker(deps: TeardownWorkerDeps): TeardownWorker {
  const { store, credentials, audit } = deps;
  const log = deps.log ?? ((): void => {});
  const pollIntervalMs = deps.pollIntervalMs ?? TEARDOWN_POLL_INTERVAL_MS;
  const batchSize = deps.batchSize ?? TEARDOWN_BATCH_SIZE;
  const now = deps.now ?? ((): Date => new Date());
  const random = deps.random ?? Math.random;

  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<TeardownTickResult> | null = null;

  async function runJob(result: TeardownTickResult, job: GatewayTeardownJobRecord): Promise<void> {
    const user = await store.users.findById(job.user_id);
    if (!user || user.status !== 'disabled') {
      // Re-enabled (or deleted) between the claim and now. Stripping the
      // consumer of a live account would be a fresh outage, not a fix.
      await store.gatewayTeardownJobs.deleteByUser(job.user_id);
      result.cancelled += 1;
      return;
    }

    const attempt = await runGatewayTeardown({
      credentials,
      store,
      userId: job.user_id,
      // No admin is on the other end of a retry, so the Edge write is attributed
      // to the account it is revoking.
      subject: job.requested_by ?? job.user_id,
      jobId: job.id,
      // The per-attempt `warn` line lives in `runGatewayTeardown`; this one adds
      // the attempt count an operator needs to see the retry loop working.
      log: (obj, message) => log({ ...obj, attempts: job.attempts }, message),
    });

    if (attempt.outcome === 'pending') {
      // The claim-time check above is not the last word: a re-enable can land
      // while the attempt is in flight, and `disableGatewayAccess` refuses in
      // that case from inside the per-consumer lock it holds. Rescheduling
      // would only queue another refusal, so re-read and drop the job instead.
      const settled = await store.users.findById(job.user_id);
      if (!settled || settled.status !== 'disabled') {
        await store.gatewayTeardownJobs.deleteByUser(job.user_id);
        result.cancelled += 1;
        return;
      }

      const nextAt = new Date(now().getTime() + teardownBackoffMs(job.attempts, random));
      await store.gatewayTeardownJobs.reschedule(
        job.id,
        nextAt.toISOString(),
        attempt.error ?? 'unknown error',
      );
      result.rescheduled += 1;
      log(
        {
          user_id: job.user_id,
          attempts: job.attempts,
          error: attempt.error,
          next_attempt_at: nextAt.toISOString(),
        },
        'Gateway revocation retry failed; the credentials are still live',
      );
      return;
    }

    // `runGatewayTeardown` already marked the job done.
    result.completed += 1;
    await audit.record(
      SYSTEM_ACTOR,
      AuditAction.USER_GATEWAY_TEARDOWN_COMPLETE,
      {
        type: 'user',
        id: job.user_id,
      },
      {
        attempts: job.attempts,
        ...attempt.details,
      },
    );
    log(
      { user_id: job.user_id, attempts: job.attempts },
      'Gateway revocation for a disabled account completed',
    );
  }

  async function runTick(): Promise<TeardownTickResult> {
    const result: TeardownTickResult = {
      claimed: 0,
      completed: 0,
      rescheduled: 0,
      cancelled: 0,
    };
    try {
      const jobs = await store.gatewayTeardownJobs.claimDue(now().toISOString(), batchSize);
      result.claimed = jobs.length;
      for (const job of jobs) {
        await runJob(result, job);
      }
      return result;
    } catch (error) {
      // A failure here is the store, not one job. Claimed rows are recovered by
      // `releaseStale` on the next start.
      log(
        { error: error instanceof Error ? error.message : String(error) },
        'Gateway teardown tick failed',
      );
      return result;
    }
  }

  async function tick(): Promise<TeardownTickResult> {
    // Never overlap ticks: a slow gateway would otherwise stack up claims.
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
      const staleBefore = new Date(now().getTime() - TEARDOWN_STALE_AFTER_MS).toISOString();
      void store.gatewayTeardownJobs
        .releaseStale(staleBefore)
        .then((released) => {
          if (released > 0) log({ released }, 'Released stale gateway teardown claims');
        })
        .catch((error: unknown) => {
          log(
            { error: error instanceof Error ? error.message : String(error) },
            'Could not release stale gateway teardown claims',
          );
        });

      timer = setInterval(() => void tick(), pollIntervalMs);
      // Do not hold the event loop open just for the poller.
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
