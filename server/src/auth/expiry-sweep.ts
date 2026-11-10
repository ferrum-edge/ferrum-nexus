/**
 * The expiry sweep — housekeeping for the two tables sign-in fills up, and for
 * the lease table every gateway write fills up.
 *
 * Every sign-in writes a `sessions` row, and every registration, re-sent
 * verification and password-reset request writes an `email_verification_tokens`
 * row. Both carry an `expires_at` that every read already honours, so an expired
 * row is harmless to correctness — but nothing ever deleted one, and the
 * `deleteExpired` methods the store has always had for exactly this were never
 * called (issue #338). Both tables therefore grew without bound, a copy of every
 * session token hash and single-use link hash ever issued, long after either
 * could be used.
 *
 * `edge_leases` has the same shape of problem (issue #675). A lease row is
 * deleted on release, but one whose holder crashed, or whose release failed,
 * stays until its key is acquired again, and the keys of deleted consumers,
 * proxies and applications never are. An expired lease is one any waiter may
 * already take over, and the fence (`lib/lease-fence.ts`) already treats a
 * swept row like a taken-over one, so deleting it changes nothing else.
 *
 * This worker runs all three deletes once at start and then every
 * {@link EXPIRY_SWEEP_INTERVAL_MS}. Each is one indexed `DELETE … WHERE
 * expires_at <= ?`, idempotent, and safe to run from every instance at once, so
 * there is no claim or lease: two instances sweeping together just find less to
 * delete. A failure is logged and the next pass tries again — nothing here is
 * ever fatal, because an unswept row costs space, not safety.
 *
 * `tick()` is exported on the worker so tests can drive exactly one pass with
 * no timers involved.
 */

import type { NexusStore } from '../db/store.js';

/**
 * How often the sweep runs.
 *
 * Hourly: sessions live for days and links for hours, so a row outliving its
 * expiry by up to an hour changes nothing, and the delete stays small.
 */
export const EXPIRY_SWEEP_INTERVAL_MS = 60 * 60_000;

/** What one {@link ExpirySweepWorker.tick} deleted. */
export interface ExpirySweepResult {
  /** Expired `sessions` rows removed. */
  sessions: number;
  /** Expired `email_verification_tokens` rows removed, spent or not. */
  verificationTokens: number;
  /** Expired `edge_leases` rows removed. */
  leases: number;
}

/** The background expiry sweeper. */
export interface ExpirySweepWorker {
  /** Begin sweeping. Idempotent. */
  start(): void;
  /** Stop sweeping and wait for an in-flight pass. Idempotent. */
  stop(): Promise<void>;
  /** Run exactly one pass. Exposed for deterministic tests. */
  tick(): Promise<ExpirySweepResult>;
  /** Whether the sweep timer is currently installed. */
  isRunning(): boolean;
}

/** Dependencies of {@link createExpirySweepWorker}. */
export interface ExpirySweepWorkerDeps {
  store: NexusStore;
  log?: (obj: Record<string, unknown>, message: string) => void;
  /** Sweep interval; defaults to {@link EXPIRY_SWEEP_INTERVAL_MS}. */
  intervalMs?: number;
  /** Injectable clock so tests can place rows either side of the cut-off. */
  now?: () => Date;
}

/** Build the expiry sweep worker. The caller owns `start()`/`stop()`. */
export function createExpirySweepWorker(deps: ExpirySweepWorkerDeps): ExpirySweepWorker {
  const { store } = deps;
  const log = deps.log ?? ((): void => {});
  const intervalMs = deps.intervalMs ?? EXPIRY_SWEEP_INTERVAL_MS;
  const now = deps.now ?? ((): Date => new Date());

  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<ExpirySweepResult> | null = null;

  /** Run one delete; a failure is logged and counted as nothing deleted. */
  async function sweep(table: string, run: () => Promise<number>): Promise<number> {
    try {
      return await run();
    } catch (error) {
      // One table failing must not stop the others from being swept.
      log(
        { table, error: error instanceof Error ? error.message : String(error) },
        'Could not delete expired rows; the next sweep will retry',
      );
      return 0;
    }
  }

  async function runTick(): Promise<ExpirySweepResult> {
    const cutoff = now().toISOString();
    return {
      sessions: await sweep('sessions', () => store.sessions.deleteExpired(cutoff)),
      verificationTokens: await sweep('email_verification_tokens', () =>
        store.verificationTokens.deleteExpired(cutoff),
      ),
      leases: await sweep('edge_leases', () => store.leases.deleteExpired(cutoff)),
    };
  }

  async function tick(): Promise<ExpirySweepResult> {
    // Never overlap passes: a slow database would otherwise stack them up.
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
      timer = setInterval(() => void tick(), intervalMs);
      // Do not hold the event loop open just for the sweeper.
      timer.unref?.();
      // A process that restarts more often than hourly would otherwise never
      // sweep at all.
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
          // `tick()` never rejects — each delete logs its own failure.
        }
      }
    },
  };
}
