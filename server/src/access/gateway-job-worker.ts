/**
 * The access gateway worker — the retry loop behind a grant revocation or an
 * access approval whose gateway step never finished (issue #651).
 *
 * Both are two-step sagas. A targeted revocation commits `active → revoked`
 * with its `access.revoke` row, then takes the ACL group off the consumer; an
 * approval commits `pending → approved`, writes the group, then commits the
 * grant. Between the steps the only record of what the gateway still owes used
 * to be the JS stack, and the Edge write can take up to
 * `FERRUM_ADMIN_TIMEOUT_MS` plus the 30 s lease wait. A process that stopped
 * there left a revoked grant whose group still opened the door, or an
 * approved request with no grant, possibly with a group no grant stood behind
 * — and nothing retried either.
 *
 * ## Contract
 *
 * Each claim now writes an `access_gateway_jobs` row in its own transaction,
 * already `sending` and owned by the request that made it. That request
 * deletes the row once the gateway matches the portal — the removal landed,
 * the grant committed, or the compensation left nothing behind — and hands
 * anything else back as `pending`. This worker polls every
 * {@link ACCESS_GATEWAY_POLL_INTERVAL_MS}, claims due rows one at a time (an
 * atomic `pending → sending` flip that increments `attempts`), and asks the
 * access service to finish each ({@link AccessService.recoverGatewayJob}):
 *
 * - **done** → the service deleted the row, with `access.revoke_complete` for
 *   a revocation or a rollback row (`recovered: true`) for an approval;
 * - **failure** → `reschedule` on an exponential backoff capped at
 *   {@link ACCESS_GATEWAY_MAX_BACKOFF_MS}, and a `warn` line naming the job,
 *   the attempt count and the error. That line is the one to alert on.
 *
 * Recovery never adds access. A revocation's removal is skipped when its grant
 * is active again or a newer grant owns the group; an approval is compensated,
 * not completed.
 *
 * ## Recovering abandoned claims
 *
 * A `sending` row is a job some request or worker took and never finished.
 * **Every** tick begins by returning rows untouched for
 * {@link ACCESS_GATEWAY_STALE_AFTER_MS} to `pending`, before it claims
 * anything — which is also how a row whose owner crashed between the claim and
 * the Edge write reaches this worker at all. A claim is replaced on every
 * worker claim, so a delayed owner can no longer settle a row taken over from
 * it, and the service re-checks the claim under the keys it acts in.
 *
 * ## Why there is no `failed` state
 *
 * As for the gateway teardown: access that outlives its grant is not something
 * to give up on, so retries are unbounded and the backoff flattens at five
 * minutes. The only exits are success and the work no longer being owed.
 *
 * `tick()` is exported on the worker so tests can drive exactly one cycle with
 * no timers involved.
 */

import type { AccessGatewayJobRecord, NexusStore } from '../db/store.js';
import type { AccessGatewayJobOutcome, AccessService } from './service.js';

/** Poll interval, matching the teardown worker's. */
export const ACCESS_GATEWAY_POLL_INTERVAL_MS = 5_000;

/** Jobs claimed per poll. */
export const ACCESS_GATEWAY_BATCH_SIZE = 10;

/** First retry delay; each further attempt doubles it. */
export const ACCESS_GATEWAY_BASE_BACKOFF_MS = 10_000;

/** Upper bound on a single backoff: live access, so a recovered gateway is noticed quickly. */
export const ACCESS_GATEWAY_MAX_BACKOFF_MS = 5 * 60_000;

/**
 * A `sending` job untouched for this long is assumed to be an abandoned
 * claim — a request that stopped before settling it, or a crashed worker's —
 * and is returned to `pending`.
 *
 * Five minutes, as for the teardown jobs. The request that owns a fresh row
 * holds it for one Edge write and its compensation: a few Edge round trips
 * bounded by `FERRUM_ADMIN_TIMEOUT_MS`, plus lease waits of up to
 * `LEASE_WAIT_MS` (30 s), a revocation rollback waiting out a crashed key
 * holder for up to `LEASE_TTL_MS` (60 s) more. Jobs are claimed one at a time,
 * so a worker's claim lasts one job.
 */
export const ACCESS_GATEWAY_STALE_AFTER_MS = 5 * 60_000;

/** What one {@link AccessGatewayWorker.tick} did. */
export interface AccessGatewayTickResult {
  /** `sending` rows older than the stale threshold returned to `pending`. */
  released: number;
  /** Jobs claimed from the queue. */
  claimed: number;
  /** Jobs whose gateway work was finished. */
  completed: number;
  /** Jobs dropped because nothing was owed any more. */
  obsolete: number;
  /** Jobs another owner had taken over; left alone. */
  superseded: number;
  /** Attempts that failed and were rescheduled. */
  rescheduled: number;
  /** Jobs whose processing threw past the reschedule; recovered by a later tick's stale sweep. */
  abandoned: number;
}

/** The background access-gateway retrier. */
export interface AccessGatewayWorker {
  /** Begin polling. Idempotent. */
  start(): void;
  /** Stop polling and wait for an in-flight tick. Idempotent. */
  stop(): Promise<void>;
  /** Run exactly one poll cycle. Exposed for deterministic tests. */
  tick(): Promise<AccessGatewayTickResult>;
  /** Whether the poll timer is currently installed. */
  isRunning(): boolean;
}

/** Dependencies of {@link createAccessGatewayWorker}. */
export interface AccessGatewayWorkerDeps {
  store: NexusStore;
  access: Pick<AccessService, 'recoverGatewayJob'>;
  log?: (obj: Record<string, unknown>, message: string) => void;
  /** Poll interval; defaults to {@link ACCESS_GATEWAY_POLL_INTERVAL_MS}. */
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
 */
export function accessGatewayBackoffMs(
  attempts: number,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, Math.min(attempts, 16));
  const base = Math.min(
    ACCESS_GATEWAY_BASE_BACKOFF_MS * 2 ** exponent,
    ACCESS_GATEWAY_MAX_BACKOFF_MS,
  );
  return Math.round(base + base * 0.1 * random());
}

/** Build the access gateway worker. The caller owns `start()`/`stop()`. */
export function createAccessGatewayWorker(deps: AccessGatewayWorkerDeps): AccessGatewayWorker {
  const { store, access } = deps;
  const log = deps.log ?? ((): void => {});
  const pollIntervalMs = deps.pollIntervalMs ?? ACCESS_GATEWAY_POLL_INTERVAL_MS;
  const batchSize = deps.batchSize ?? ACCESS_GATEWAY_BATCH_SIZE;
  const now = deps.now ?? ((): Date => new Date());
  const random = deps.random ?? Math.random;

  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<AccessGatewayTickResult> | null = null;

  function describe(job: AccessGatewayJobRecord): Record<string, unknown> {
    return {
      job_id: job.id,
      kind: job.kind,
      subject_id: job.subject_id,
      api_id: job.api_id,
      user_id: job.user_id,
      application_id: job.application_id,
      attempts: job.attempts,
    };
  }

  async function runJob(
    result: AccessGatewayTickResult,
    job: AccessGatewayJobRecord,
  ): Promise<void> {
    let outcome: AccessGatewayJobOutcome;
    try {
      outcome = await access.recoverGatewayJob(job);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const nextAt = new Date(now().getTime() + accessGatewayBackoffMs(job.attempts, random));
      // A failed write here leaves SENDING for the stale sweep.
      if (!(await store.accessGatewayJobs.reschedule(job, nextAt.toISOString(), message))) {
        result.superseded += 1;
        return;
      }
      result.rescheduled += 1;
      log(
        { ...describe(job), error: message, next_attempt_at: nextAt.toISOString() },
        job.kind === 'revoke'
          ? 'Access gateway retry failed; a revoked grant may still hold its ACL group'
          : 'Access gateway retry failed; an approval that never committed may still hold its ACL group',
      );
      return;
    }
    result[outcome] += 1;
  }

  /** Return claims nobody settled to the queue. Runs on every tick. */
  async function releaseStale(result: AccessGatewayTickResult): Promise<void> {
    const staleBefore = new Date(now().getTime() - ACCESS_GATEWAY_STALE_AFTER_MS).toISOString();
    result.released = await store.accessGatewayJobs.releaseStale(staleBefore);
    if (result.released > 0) {
      log({ released: result.released }, 'Released stale access gateway claims');
    }
  }

  async function runTick(): Promise<AccessGatewayTickResult> {
    const result: AccessGatewayTickResult = {
      released: 0,
      claimed: 0,
      completed: 0,
      obsolete: 0,
      superseded: 0,
      rescheduled: 0,
      abandoned: 0,
    };
    try {
      await releaseStale(result);
    } catch (error) {
      // Recovery failing must not stop this tick from doing its ordinary work.
      log(
        { error: error instanceof Error ? error.message : String(error) },
        'Could not release stale access gateway claims',
      );
    }

    // Claimed one at a time, so a claim's lifetime is one job's, which is what
    // keeps the stale threshold both safe and quick.
    for (let taken = 0; taken < batchSize; taken += 1) {
      let job: AccessGatewayJobRecord | undefined;
      try {
        [job] = await store.accessGatewayJobs.claimDue(now().toISOString(), 1);
      } catch (error) {
        log(
          { error: error instanceof Error ? error.message : String(error) },
          'Access gateway tick failed',
        );
        return result;
      }
      if (!job) return result;
      result.claimed += 1;
      try {
        await runJob(result, job);
      } catch (error) {
        // The row stays `sending` and the stale sweep brings it back;
        // abandoning the rest of the tick would strand the backlog behind it.
        result.abandoned += 1;
        log(
          { ...describe(job), error: error instanceof Error ? error.message : String(error) },
          'Access gateway job was abandoned mid-flight; the stale sweep recovers it',
        );
      }
    }
    return result;
  }

  async function tick(): Promise<AccessGatewayTickResult> {
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
