/**
 * The outbox worker — the only thing in Nexus that actually talks to SMTP.
 *
 * It polls `email_outbox` every {@link OUTBOX_POLL_INTERVAL_MS}. Each tick
 * first returns rows a crashed worker left `sending` for more than
 * {@link OUTBOX_STALE_AFTER_MS} to `pending` — recovery belongs to whichever
 * worker is running, not to the next process boot — and then claims up to
 * {@link OUTBOX_BATCH_SIZE} due rows one at a time (an atomic `pending →
 * sending` flip that also increments `attempts`, so two workers never claim the
 * same row), and delivers them:
 *
 * - success → `markSent`;
 * - failure with retries left → `reschedule` at `30s · 2^attempts` plus jitter;
 * - failure on attempt {@link OUTBOX_MAX_ATTEMPTS} → `markFailed`.
 *
 * ## SMTP delivery is at-least-once, and the seam is the acknowledgement
 *
 * `transport.send` resolving and `markSent` committing are two writes to two
 * systems with no transaction between them, so they are handled as two distinct
 * failures:
 *
 * - **the transport rejected before the message was fully written** — nothing
 *   was delivered, retry on the backoff;
 * - **the transport accepted but the acknowledgement failed**, or the attempt
 *   was cut off *after* the whole body reached the relay (a socket timeout, a
 *   reset, or the enforced {@link OUTBOX_SEND_BUDGET_MS} deadline) — the relay
 *   may already have the message, and a retry would deliver a second copy. The
 *   row is taken out of the retry loop and parked as `failed` with
 *   {@link OUTBOX_DELIVERED_UNACKNOWLEDGED} at the front of `last_error`, so an
 *   operator can tell it apart from mail that never left.
 *
 * Only the second write failing *and* the parking write failing too leaves the
 * row `sending`, where `releaseStale` will eventually return it to `pending` and
 * a duplicate goes out. That residual duplicate is the reason delivery is
 * documented as at-least-once rather than exactly-once: exact deduplication
 * needs the relay to honour a `Message-ID`, which Nexus cannot assume.
 *
 * ## A claim is owned, not just taken
 *
 * `claimDue` stamps an opaque generation on the row, and every settling write
 * matches on `id + generation + status = 'sending'`. A worker whose claim was
 * reclaimed by another instance's `releaseStale` therefore cannot overwrite the
 * new owner's outcome — it loses the write, counts it in `lost` and logs it,
 * rather than resurrecting a row that has already been settled.
 *
 * Two operational rules:
 *
 * 1. **It never crashes the process.** Every tick is wrapped; a transport or
 *    database error is logged and the next tick tries again.
 * 2. **It does nothing while SMTP is unconfigured.** The transport factory
 *    returns `null`, the tick claims nothing, and queued mail waits in
 *    `pending` until an admin fills in the settings — rather than being burned
 *    through five retries and marked `failed`.
 *
 * `tick()` is exported on the worker so tests can drive exactly one cycle with
 * no timers involved.
 */

import { OUTBOX_MAX_ATTEMPTS, OUTBOX_POLL_INTERVAL_MS } from '@ferrum-nexus/shared';

import type { EmailOutboxRecord, NexusStore } from '../db/store.js';
import {
  isDeliveredUnacknowledged,
  SMTP_SEND_BUDGET_MS,
  type MailTransport,
  type MailTransportFactory,
} from './service.js';

/** Rows claimed per poll. Small enough that one slow relay cannot stall a tick. */
export const OUTBOX_BATCH_SIZE = 20;

/** First retry delay; each further attempt doubles it. */
export const OUTBOX_BASE_BACKOFF_MS = 30_000;

/** Upper bound on a single backoff, so a long outage still retries hourly. */
export const OUTBOX_MAX_BACKOFF_MS = 60 * 60_000;

/**
 * A `sending` row untouched for this long is assumed to be a crashed worker's
 * and is released back to `pending`.
 *
 * Five minutes against an *enforced* per-message ceiling of
 * {@link OUTBOX_SEND_BUDGET_MS}, and rows are claimed one at a time, so a row a
 * live worker is actually delivering is never anywhere near it. Should a
 * reclaim still race a live attempt, the claim's generation is what stops the
 * loser from overwriting the winner's outcome.
 */
export const OUTBOX_STALE_AFTER_MS = 5 * 60_000;

/**
 * Hard ceiling on one delivery attempt.
 *
 * `createSmtpTransport` races every `send` against this deadline, so the number
 * is a bound rather than an estimate. Pinning nodemailer's three timeouts
 * (10 s to connect, 10 s for the greeting, 30 s of socket inactivity) is worth
 * doing but is *not* a total: `socketTimeout` measures inactivity between
 * reads, so a relay that answers every command just inside it — or dribbles
 * legal multi-line continuations — can hold one `send` open indefinitely. That
 * is what used to let an attempt outlive {@link OUTBOX_STALE_AFTER_MS} and have
 * its claim reclaimed while the message was still in flight.
 *
 * An attempt cut off by the deadline is *not* an ordinary failure: if the body
 * had already reached the relay it may well be queued there, so the row is
 * parked as {@link OUTBOX_DELIVERED_UNACKNOWLEDGED} instead of being retried
 * into a duplicate.
 */
export const OUTBOX_SEND_BUDGET_MS = SMTP_SEND_BUDGET_MS;

/**
 * Prefix written to `last_error` when SMTP accepted a message but the
 * acknowledgement could not be persisted.
 *
 * The row is `failed` only in the sense that Nexus lost track of it — the mail
 * *was* handed to the relay. Parking it there is what stops the retry loop from
 * delivering a second copy. Recognising the prefix is how an operator (and the
 * admin outbox view) tells the two apart without a schema change.
 */
export const OUTBOX_DELIVERED_UNACKNOWLEDGED = 'delivered-unacknowledged';

/** What one {@link OutboxWorker.tick} did. */
export interface OutboxTickResult {
  /** `sending` rows older than the stale threshold returned to `pending`. */
  released: number;
  /** Rows claimed from the queue. */
  claimed: number;
  sent: number;
  rescheduled: number;
  failed: number;
  /** Delivered by SMTP, but the acknowledgement could not be persisted. */
  unacknowledged: number;
  /** Settling writes refused because the claim had been reclaimed meanwhile. */
  lost: number;
  /** Rows whose handling threw; recovered by a later tick's stale sweep. */
  abandoned: number;
  /** True when the tick delivered nothing because SMTP is not configured. */
  skipped: boolean;
}

const EMPTY_TICK: Omit<OutboxTickResult, 'released'> = {
  claimed: 0,
  sent: 0,
  rescheduled: 0,
  failed: 0,
  unacknowledged: 0,
  lost: 0,
  abandoned: 0,
  skipped: true,
};

/** The background email sender. */
export interface OutboxWorker {
  /** Begin polling. Idempotent. */
  start(): void;
  /** Stop polling and wait for an in-flight tick. Idempotent. */
  stop(): Promise<void>;
  /** Run exactly one poll cycle. Exposed for deterministic tests. */
  tick(): Promise<OutboxTickResult>;
  /** Whether the poll timer is currently installed. */
  isRunning(): boolean;
}

/** Dependencies of {@link createOutboxWorker}. */
export interface OutboxWorkerDeps {
  store: NexusStore;
  /** Builds the transport for a tick, or returns `null` when unconfigured. */
  transportFactory: MailTransportFactory;
  log?: (obj: Record<string, unknown>, message: string) => void;
  /** Poll interval; defaults to the shared `OUTBOX_POLL_INTERVAL_MS`. */
  pollIntervalMs?: number;
  batchSize?: number;
  /** Injectable clock so tests can assert exact backoff stamps. */
  now?: () => Date;
  /** Injectable jitter source; defaults to `Math.random`. */
  random?: () => number;
}

/**
 * Delay before the next attempt: `30s · 2^attempts`, capped, plus up to 10%
 * jitter so a fleet of workers does not retry in lockstep.
 *
 * `attempts` is the post-claim count, so the first failure waits ~60 seconds.
 */
export function backoffDelayMs(attempts: number, random: () => number = Math.random): number {
  const exponent = Math.max(0, Math.min(attempts, 16));
  const base = Math.min(OUTBOX_BASE_BACKOFF_MS * 2 ** exponent, OUTBOX_MAX_BACKOFF_MS);
  return Math.round(base + base * 0.1 * random());
}

/** Build the outbox worker. The caller owns `start()`/`stop()`. */
export function createOutboxWorker(deps: OutboxWorkerDeps): OutboxWorker {
  const { store, transportFactory } = deps;
  const log = deps.log ?? ((): void => {});
  const pollIntervalMs = deps.pollIntervalMs ?? OUTBOX_POLL_INTERVAL_MS;
  const batchSize = deps.batchSize ?? OUTBOX_BATCH_SIZE;
  const now = deps.now ?? ((): Date => new Date());
  const random = deps.random ?? Math.random;

  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<OutboxTickResult> | null = null;

  async function deliver(
    transport: MailTransport,
    result: OutboxTickResult,
    entry: EmailOutboxRecord,
  ): Promise<void> {
    try {
      await transport.send({
        to: entry.to_email,
        subject: entry.subject,
        html: entry.body_html,
        text: entry.body_text,
      });
    } catch (error) {
      if (isDeliveredUnacknowledged(error)) {
        // The attempt was cut off after the relay had the whole message — a
        // socket timeout past end-of-data, or the send budget. Retrying it is
        // exactly how the same password reset arrives five times.
        await parkUnacknowledged(result, entry, error);
        return;
      }
      // Nothing was delivered: the retry loop is safe.
      const message = error instanceof Error ? error.message : String(error);
      if (entry.attempts >= OUTBOX_MAX_ATTEMPTS) {
        if (!(await store.emailOutbox.markFailed(entry, message))) {
          lostClaim(result, entry, 'markFailed');
          return;
        }
        result.failed += 1;
        log(
          { id: entry.id, attempts: entry.attempts, error: message },
          'Outbox message failed permanently',
        );
        return;
      }
      const nextAt = new Date(now().getTime() + backoffDelayMs(entry.attempts, random));
      if (!(await store.emailOutbox.reschedule(entry, nextAt.toISOString(), message))) {
        lostClaim(result, entry, 'reschedule');
        return;
      }
      result.rescheduled += 1;
      log(
        { id: entry.id, attempts: entry.attempts, next_attempt_at: nextAt.toISOString() },
        'Outbox message delivery failed, retrying later',
      );
      return;
    }

    // Past this point the relay has the message. Anything that fails now is an
    // acknowledgement problem, and rescheduling would deliver a second copy.
    try {
      if (await store.emailOutbox.markSent(entry, now().toISOString())) {
        result.sent += 1;
      } else {
        lostClaim(result, entry, 'markSent');
      }
    } catch (error) {
      await parkUnacknowledged(result, entry, error);
    }
  }

  /**
   * Record a settling write that was refused because the claim moved on.
   *
   * The row now belongs to whichever worker reclaimed it after the stale sweep,
   * so this attempt has no say in its outcome. Overwriting it anyway is what
   * used to resurrect an already-`sent` row into another delivery.
   */
  function lostClaim(
    result: OutboxTickResult,
    entry: EmailOutboxRecord,
    write: 'markSent' | 'markFailed' | 'reschedule',
  ): void {
    result.lost += 1;
    log(
      { id: entry.id, to: entry.to_email, attempts: entry.attempts, write },
      'Outbox claim was reclaimed by another worker; this attempt did not settle the row',
    );
  }

  /**
   * Take a delivered-but-unacknowledged row out of the retry loop.
   *
   * `markFailed` is the only terminal status the schema offers, so the row is
   * parked there with {@link OUTBOX_DELIVERED_UNACKNOWLEDGED} leading
   * `last_error`. If even that write fails the row stays `sending` and
   * `releaseStale` will eventually re-queue it — the one path on which a
   * duplicate is delivered.
   */
  async function parkUnacknowledged(
    result: OutboxTickResult,
    entry: EmailOutboxRecord,
    cause: unknown,
  ): Promise<void> {
    const message = cause instanceof Error ? cause.message : String(cause);
    result.unacknowledged += 1;
    try {
      const parked = await store.emailOutbox.markFailed(
        entry,
        `${OUTBOX_DELIVERED_UNACKNOWLEDGED}: ${message}`,
      );
      if (!parked) {
        lostClaim(result, entry, 'markFailed');
        return;
      }
      log(
        { id: entry.id, to: entry.to_email, error: message },
        'Outbox message was delivered but could not be marked sent; parked to avoid a duplicate',
      );
    } catch (parkError) {
      log(
        {
          id: entry.id,
          to: entry.to_email,
          error: message,
          park_error: parkError instanceof Error ? parkError.message : String(parkError),
        },
        'Outbox message was delivered but its row could not be updated at all; a retry may duplicate it',
      );
    }
  }

  /**
   * Return rows a crashed worker left `sending` to the queue.
   *
   * Runs on **every** tick, before anything is claimed — and before the SMTP
   * check, so a backlog stranded while the settings were being fixed is
   * recovered too. A sweep that only happens at `start()` recovers nothing from
   * the ordinary crash: the rows are younger than the threshold when that one
   * sweep runs, and no later tick ever looks at them again. It is one indexed
   * `UPDATE … WHERE status = 'sending' AND updated_at <= ?` per poll.
   */
  async function releaseStale(result: OutboxTickResult): Promise<void> {
    const staleBefore = new Date(now().getTime() - OUTBOX_STALE_AFTER_MS).toISOString();
    result.released = await store.emailOutbox.releaseStale(staleBefore);
    if (result.released > 0) log({ released: result.released }, 'Released stale outbox claims');
  }

  async function runTick(): Promise<OutboxTickResult> {
    const result: OutboxTickResult = {
      released: 0,
      claimed: 0,
      sent: 0,
      rescheduled: 0,
      failed: 0,
      unacknowledged: 0,
      lost: 0,
      abandoned: 0,
      skipped: false,
    };
    try {
      await releaseStale(result);
    } catch (error) {
      // Recovery failing must not stop this tick from delivering.
      log(
        { error: error instanceof Error ? error.message : String(error) },
        'Could not release stale outbox claims',
      );
    }

    let transport: MailTransport | null = null;
    try {
      transport = await transportFactory();
      if (!transport) return { ...EMPTY_TICK, released: result.released };

      // Claimed one at a time rather than as a batch: the last row of a batch
      // sits `sending` for as long as every row before it takes, which would
      // put the stale threshold at batch size × OUTBOX_SEND_BUDGET_MS. Claiming
      // singly keeps a claim's lifetime equal to one delivery's.
      for (let taken = 0; taken < batchSize; taken += 1) {
        const [entry] = await store.emailOutbox.claimDue(now().toISOString(), 1);
        if (!entry) break;
        result.claimed += 1;
        try {
          await deliver(transport, result, entry);
        } catch (error) {
          // One row's bookkeeping write failed after the claim. It stays
          // `sending` and the stale sweep re-queues it; the rest of the backlog
          // must not be stranded behind it.
          result.abandoned += 1;
          log(
            {
              id: entry.id,
              attempts: entry.attempts,
              error: error instanceof Error ? error.message : String(error),
            },
            'Outbox message was abandoned mid-flight; it is recovered by the stale sweep',
          );
        }
      }
      return result;
    } catch (error) {
      // A failure here is the store or the transport factory, not one message.
      log({ error: error instanceof Error ? error.message : String(error) }, 'Outbox tick failed');
      return result;
    } finally {
      try {
        await transport?.close?.();
      } catch {
        // Closing a pool must never mask the tick's outcome.
      }
    }
  }

  async function tick(): Promise<OutboxTickResult> {
    // Never overlap ticks: a slow relay would otherwise stack up claims.
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
      // No separate startup sweep: the first tick does one, and so does every
      // tick after it.
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
