/**
 * The outbox worker — the only thing in Nexus that actually talks to SMTP.
 *
 * It polls `email_outbox` every {@link OUTBOX_POLL_INTERVAL_MS}, claims a batch
 * of due rows (an atomic `pending → sending` flip that also increments
 * `attempts`, so two workers never claim the same row), and delivers them:
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
 * - **the transport rejected** — nothing was delivered, retry on the backoff;
 * - **the transport accepted but the acknowledgement failed** — the relay
 *   already has the message, and a retry would deliver a second copy. The row
 *   is taken out of the retry loop and parked as `failed` with
 *   {@link OUTBOX_DELIVERED_UNACKNOWLEDGED} at the front of `last_error`, so an
 *   operator can tell it apart from mail that never left.
 *
 * Only the second write failing *and* the parking write failing too leaves the
 * row `sending`, where `releaseStale` will eventually return it to `pending` and
 * a duplicate goes out. That residual duplicate is the reason delivery is
 * documented as at-least-once rather than exactly-once: exact deduplication
 * needs the relay to honour a `Message-ID`, which Nexus cannot assume.
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
import type { MailTransport, MailTransportFactory } from './service.js';

/** Rows claimed per poll. Small enough that one slow relay cannot stall a tick. */
export const OUTBOX_BATCH_SIZE = 20;

/** First retry delay; each further attempt doubles it. */
export const OUTBOX_BASE_BACKOFF_MS = 30_000;

/** Upper bound on a single backoff, so a long outage still retries hourly. */
export const OUTBOX_MAX_BACKOFF_MS = 60 * 60_000;

/** A `sending` row untouched for this long is assumed to be a crashed worker's. */
export const OUTBOX_STALE_AFTER_MS = 5 * 60_000;

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
  /** Rows claimed from the queue. */
  claimed: number;
  sent: number;
  rescheduled: number;
  failed: number;
  /** Delivered by SMTP, but the `markSent` write did not land. */
  unacknowledged: number;
  /** True when the tick did nothing because SMTP is not configured. */
  skipped: boolean;
}

const EMPTY_TICK: OutboxTickResult = {
  claimed: 0,
  sent: 0,
  rescheduled: 0,
  failed: 0,
  unacknowledged: 0,
  skipped: true,
};

/** The background email sender. */
export interface OutboxWorker {
  /** Release stale claims and begin polling. Idempotent. */
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
      // Nothing was delivered: the retry loop is safe.
      const message = error instanceof Error ? error.message : String(error);
      if (entry.attempts >= OUTBOX_MAX_ATTEMPTS) {
        await store.emailOutbox.markFailed(entry.id, message);
        result.failed += 1;
        log(
          { id: entry.id, attempts: entry.attempts, error: message },
          'Outbox message failed permanently',
        );
        return;
      }
      const nextAt = new Date(now().getTime() + backoffDelayMs(entry.attempts, random));
      await store.emailOutbox.reschedule(entry.id, nextAt.toISOString(), message);
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
      await store.emailOutbox.markSent(entry.id, now().toISOString());
      result.sent += 1;
    } catch (error) {
      await parkUnacknowledged(result, entry, error);
    }
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
      await store.emailOutbox.markFailed(
        entry.id,
        `${OUTBOX_DELIVERED_UNACKNOWLEDGED}: ${message}`,
      );
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

  async function runTick(): Promise<OutboxTickResult> {
    const result: OutboxTickResult = {
      claimed: 0,
      sent: 0,
      rescheduled: 0,
      failed: 0,
      unacknowledged: 0,
      skipped: false,
    };
    let transport: MailTransport | null = null;
    try {
      transport = await transportFactory();
      if (!transport) return { ...EMPTY_TICK };

      const entries = await store.emailOutbox.claimDue(now().toISOString(), batchSize);
      result.claimed = entries.length;
      for (const entry of entries) {
        await deliver(transport, result, entry);
      }
      return result;
    } catch (error) {
      // A failure here is the store or the transport factory, not one message.
      // Claimed rows (if any) are recovered by `releaseStale` on the next start.
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
      const staleBefore = new Date(now().getTime() - OUTBOX_STALE_AFTER_MS).toISOString();
      void store.emailOutbox
        .releaseStale(staleBefore)
        .then((released) => {
          if (released > 0) log({ released }, 'Released stale outbox claims');
        })
        .catch((error: unknown) => {
          log(
            { error: error instanceof Error ? error.message : String(error) },
            'Could not release stale outbox claims',
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
