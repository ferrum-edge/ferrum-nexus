/**
 * What happens to a job a worker claimed and never finished.
 *
 * Both background workers flip a row `pending → sending` to claim it, and both
 * used to sweep abandoned claims exactly once, inside `start()`. That recovers
 * nothing from the ordinary failure: a process that crashes and comes back
 * inside the five-minute window finds its own rows too young for the single
 * sweep, and no later tick ever revisits them. A disabled account's gateway
 * credentials then stay live for good, and a verification email is never sent.
 *
 * Every case here drives ticks by hand against an injectable clock, so "time
 * passed" is an assertion rather than a wait. The shape is always the same:
 *
 *   1. claim a due row, then walk away from it, as a crash does;
 *   2. run a replacement worker 60 seconds later — too soon to recover;
 *   3. run ordinary ticks past the stale threshold, with no restart in between,
 *      and watch the row come back and complete.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { consumerUsernameForUser, type IssueCredentialResponse } from '@ferrum-nexus/shared';

import {
  createTeardownWorker,
  TEARDOWN_STALE_AFTER_MS,
  type TeardownWorker,
} from '../credentials/teardown-worker.js';
import {
  createOutboxWorker,
  OUTBOX_STALE_AFTER_MS,
  type OutboxWorker,
} from '../email/outbox-worker.js';
import type { MailTransport, MailTransportFactory, OutboundMail } from '../email/service.js';
import { buildTestApp, type TestApp, type TestSession } from './helpers.js';

/** A clock the test advances by hand. */
interface TestClock {
  now(): Date;
  advance(ms: number): void;
}

/**
 * Start from the real wall clock.
 *
 * The store stamps `next_attempt_at` and `updated_at` with the real clock, so
 * an injected clock has to start at or after those stamps for a queued row to
 * look due — which is why every case here seeds its rows *first* and takes the
 * clock afterwards.
 */
function testClock(): TestClock {
  let ms = Date.now();
  return {
    now: () => new Date(ms),
    advance: (delta) => {
      ms += delta;
    },
  };
}

/** A transport that records recipients, plus per-address failures. */
interface RecordingMail {
  factory: MailTransportFactory;
  delivered: string[];
  /** Addresses whose next `send` rejects. */
  reject: Set<string>;
}

function recordingMail(): RecordingMail {
  const delivered: string[] = [];
  const reject = new Set<string>();
  const transport: MailTransport = {
    async send(mail: OutboundMail): Promise<void> {
      // Yield, so two workers ticking concurrently really do interleave.
      await new Promise((resolve) => setImmediate(resolve));
      if (reject.has(mail.to)) {
        reject.delete(mail.to);
        throw new Error(`relay refused ${mail.to}`);
      }
      delivered.push(mail.to);
    },
  };
  return { factory: async () => transport, delivered, reject };
}

/** Replace one repo method for the duration of `fn`. */
async function withPatched<T, K extends keyof T>(
  target: T,
  key: K,
  replacement: T[K],
  fn: () => Promise<void>,
): Promise<void> {
  const real = target[key];
  target[key] = replacement;
  try {
    await fn();
  } finally {
    target[key] = real;
  }
}

describe('outbox claims are recovered without a restart', () => {
  let harness: TestApp;
  let mail: RecordingMail;
  let clock: TestClock;

  function worker(): OutboxWorker {
    return createOutboxWorker({
      store: harness.store,
      transportFactory: mail.factory,
      now: () => clock.now(),
    });
  }

  /** Queue one message and return its row id and recipient. */
  async function queue(to: string): Promise<string> {
    const { entry } = await harness.services.email.enqueue({
      to,
      templateKey: 'verification',
      vars: { recipient_name: 'Ada', verification_url: 'https://portal.test/v?token=x' },
      idempotencyKey: `claim-recovery:${to}`,
    });
    return entry.id;
  }

  before(async () => {
    harness = await buildTestApp();
  });

  after(async () => {
    await harness.close();
  });

  it('recovers a crashed worker’s claim on an ordinary tick', async () => {
    mail = recordingMail();
    const id = await queue('crashed@example.test');
    clock = testClock();

    // The crash: a worker claimed the row and never came back.
    const claimed = await harness.store.emailOutbox.claimDue(clock.now().toISOString(), 10);
    assert.equal(claimed.length, 1);
    assert.equal((await harness.store.emailOutbox.findById(id))?.status, 'sending');

    // A replacement worker 60 seconds later. The row is far too young to be
    // treated as debris, and it must not be stolen from a worker that might
    // still be delivering it.
    clock.advance(60_000);
    const replacement = worker();
    const tooSoon = await replacement.tick();
    assert.equal(tooSoon.claimed, 0);
    assert.equal((await harness.store.emailOutbox.findById(id))?.status, 'sending');

    // Ordinary ticks, no restart: past the threshold the same worker recovers
    // the row and delivers it in the same cycle.
    clock.advance(2 * OUTBOX_STALE_AFTER_MS);
    const recovered = await replacement.tick();
    assert.equal(recovered.claimed, 1, 'the abandoned row was re-queued and claimed');
    assert.equal(recovered.sent, 1);
    assert.deepEqual(mail.delivered, ['crashed@example.test']);
    assert.equal((await harness.store.emailOutbox.findById(id))?.status, 'sent');
    assert.equal(recovered.released, 1);
  });

  it('keeps draining the queue when one row’s store write fails', async () => {
    mail = recordingMail();
    const first = await queue('batch-first@example.test');
    const stranded = await queue('batch-stranded@example.test');
    const last = await queue('batch-last@example.test');
    clock = testClock();

    // The middle message fails to send, and the write that would reschedule it
    // fails too — the row is claimed, unfinished, and nothing recorded why.
    mail.reject.add('batch-stranded@example.test');
    const only = worker();
    await withPatched(
      harness.store.emailOutbox,
      'reschedule',
      async () => {
        throw new Error('store went away');
      },
      async () => {
        const tick = await only.tick();
        assert.equal(tick.claimed, 3);
        assert.equal(tick.sent, 2, 'the rows after the failure were still delivered');
        assert.equal(tick.abandoned, 1, 'exactly one row was abandoned');
      },
    );
    assert.deepEqual(mail.delivered.sort(), [
      'batch-first@example.test',
      'batch-last@example.test',
    ]);
    assert.equal((await harness.store.emailOutbox.findById(first))?.status, 'sent');
    assert.equal((await harness.store.emailOutbox.findById(last))?.status, 'sent');
    assert.equal((await harness.store.emailOutbox.findById(stranded))?.status, 'sending');

    // And the abandoned row comes back on a later tick of the same worker.
    clock.advance(2 * OUTBOX_STALE_AFTER_MS);
    const recovery = await only.tick();
    assert.equal(recovery.sent, 1);
    assert.equal((await harness.store.emailOutbox.findById(stranded))?.status, 'sent');
    assert.ok(mail.delivered.includes('batch-stranded@example.test'));
    assert.equal(recovery.released, 1);
  });

  it('never lets two workers deliver the same claim', async () => {
    mail = recordingMail();
    const addresses = Array.from({ length: 6 }, (_, i) => `two-workers-${i}@example.test`);
    for (const to of addresses) await queue(to);
    clock = testClock();

    const [a, b] = await Promise.all([worker().tick(), worker().tick()]);
    assert.equal(a.claimed + b.claimed, addresses.length, 'every row was claimed exactly once');
    assert.equal(a.sent + b.sent, addresses.length);
    assert.equal(
      new Set(mail.delivered).size,
      mail.delivered.length,
      'no address was delivered twice',
    );
    assert.deepEqual([...mail.delivered].sort(), [...addresses].sort());
  });
});

describe('gateway teardown claims are recovered without a restart', () => {
  let harness: TestApp;
  let founder: TestSession;
  let clock: TestClock;

  function worker(): TeardownWorker {
    return createTeardownWorker({
      store: harness.store,
      credentials: harness.services.credentials,
      audit: harness.services.audit,
      now: () => clock.now(),
    });
  }

  /**
   * Disable an account while the gateway is refusing, leaving a `pending` job
   * and a consumer that still holds live credentials.
   */
  async function disableWithGatewayDown(email: string): Promise<{ id: string; username: string }> {
    const target = await harness.registerUser({ email });
    const issued = await harness.authed(target, {
      method: 'POST',
      url: '/api/credentials',
      payload: { credential_type: 'keyauth', label: 'CI' },
    });
    assert.equal(issued.statusCode, 201, issued.body);
    issued.json<IssueCredentialResponse>();

    harness.edge.queueFailure(500, { error: 'gateway exploded' }, '/consumers');
    const disabled = await harness.authed(founder, {
      method: 'PATCH',
      url: `/api/users/${target.user.id}`,
      payload: { status: 'disabled' },
    });
    assert.equal(disabled.statusCode, 200, disabled.body);
    assert.equal(
      (await harness.store.gatewayTeardownJobs.findByUser(target.user.id))?.status,
      'pending',
    );
    return { id: target.user.id, username: consumerUsernameForUser(target.user.id) };
  }

  before(async () => {
    harness = await buildTestApp();
    founder = await harness.registerUser({ email: 'recovery-founder@example.test' });
    assert.equal(founder.user.role, 'super_admin');
  });

  after(async () => {
    await harness.close();
  });

  it('recovers a crashed worker’s claim on an ordinary tick', async () => {
    const target = await disableWithGatewayDown('recovery-crashed@example.test');
    clock = testClock();

    // The crash: claimed, never finished. The account is off and its API key
    // still authenticates.
    const claimed = await harness.store.gatewayTeardownJobs.claimDue(clock.now().toISOString(), 10);
    assert.equal(claimed.length, 1);
    assert.equal(
      (await harness.store.gatewayTeardownJobs.findByUser(target.id))?.status,
      'sending',
    );

    clock.advance(60_000);
    const replacement = worker();
    const tooSoon = await replacement.tick();
    assert.equal(tooSoon.claimed, 0);
    assert.equal(
      (await harness.store.gatewayTeardownJobs.findByUser(target.id))?.status,
      'sending',
    );

    clock.advance(2 * TEARDOWN_STALE_AFTER_MS);
    const recovered = await replacement.tick();
    assert.equal(recovered.claimed, 1, 'the abandoned job was re-queued and claimed');
    assert.equal(recovered.completed, 1);
    assert.equal(recovered.released, 1);
    assert.equal((await harness.store.gatewayTeardownJobs.findByUser(target.id))?.status, 'done');
    assert.deepEqual(
      harness.edge.consumerByUsername(target.username)?.credentials,
      {},
      'the disabled account has no gateway credentials left',
    );
  });

  it('keeps working through the backlog when one job’s store write fails', async () => {
    const stranded = await disableWithGatewayDown('recovery-stranded@example.test');
    const following = await disableWithGatewayDown('recovery-following@example.test');
    clock = testClock();

    // The gateway refuses the first job, and the write that records the retry
    // fails as well. The second job must still be attempted.
    harness.edge.queueFailure(500, { error: 'gateway exploded' }, '/consumers');
    const only = worker();
    await withPatched(
      harness.store.gatewayTeardownJobs,
      'reschedule',
      async () => {
        throw new Error('store went away');
      },
      async () => {
        const tick = await only.tick();
        assert.equal(tick.claimed, 2);
        assert.equal(tick.completed, 1, 'the job behind the abandoned one still ran');
        assert.equal(tick.abandoned, 1);
      },
    );
    assert.equal(
      (await harness.store.gatewayTeardownJobs.findByUser(following.id))?.status,
      'done',
    );
    assert.equal(
      (await harness.store.gatewayTeardownJobs.findByUser(stranded.id))?.status,
      'sending',
    );

    clock.advance(2 * TEARDOWN_STALE_AFTER_MS);
    const recovery = await only.tick();
    assert.equal(recovery.completed, 1);
    assert.equal((await harness.store.gatewayTeardownJobs.findByUser(stranded.id))?.status, 'done');
    assert.equal(recovery.released, 1);
  });

  it('never lets two workers run the same revocation', async () => {
    const first = await disableWithGatewayDown('recovery-race-a@example.test');
    const second = await disableWithGatewayDown('recovery-race-b@example.test');
    clock = testClock();

    const [a, b] = await Promise.all([worker().tick(), worker().tick()]);
    assert.equal(a.claimed + b.claimed, 2, 'each job was claimed exactly once');
    assert.equal(a.completed + b.completed, 2);

    // One completion audit row per account is the observable proof that no job
    // was run twice.
    const completions = await harness.auditRows('user.gateway_teardown_complete');
    for (const id of [first.id, second.id]) {
      assert.equal(
        completions.filter((row) => row.target_id === id).length,
        1,
        'exactly one completion was recorded',
      );
    }
  });
});
