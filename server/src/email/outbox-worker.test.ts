import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { OUTBOX_MAX_ATTEMPTS } from '@ferrum-nexus/shared';

import { buildTestApp, type TestApp } from '../test/helpers.js';
import { backoffDelayMs, OUTBOX_BASE_BACKOFF_MS } from './outbox-worker.js';

/** Push a row's next attempt into the past so the next tick claims it again. */
async function makeDue(harness: TestApp, id: string): Promise<void> {
  await harness.store.emailOutbox.reschedule(id, new Date(Date.now() - 1000).toISOString(), 'due');
}

describe('outbox backoff', () => {
  it('doubles per attempt and stays within the jitter window', () => {
    assert.equal(
      backoffDelayMs(1, () => 0),
      OUTBOX_BASE_BACKOFF_MS * 2,
    );
    assert.equal(
      backoffDelayMs(2, () => 0),
      OUTBOX_BASE_BACKOFF_MS * 4,
    );
    const jittered = backoffDelayMs(1, () => 1);
    assert.ok(jittered > OUTBOX_BASE_BACKOFF_MS * 2);
    assert.ok(jittered <= OUTBOX_BASE_BACKOFF_MS * 2 * 1.1);
  });
});

describe('outbox worker', () => {
  let harness: TestApp;

  before(async () => {
    harness = await buildTestApp();
  });

  after(async () => {
    await harness.close();
  });

  // Each case owns the queue: anything a previous case left pending is retired
  // so a tick only ever claims the row under test.
  beforeEach(async () => {
    harness.mailbox.clear();
    harness.mailbox.unconfigured = false;
    for (const row of await harness.outbox()) {
      if (row.status === 'pending' || row.status === 'sending') {
        await harness.store.emailOutbox.markSent(row.id, new Date().toISOString());
      }
    }
  });

  it('does not auto-start under NEXUS_ENV=test', () => {
    assert.equal(harness.services.outbox.isRunning(), false);
  });

  it('delivers a queued message and marks it sent', async () => {
    const { entry, created } = await harness.services.email.enqueue({
      to: 'ada@example.test',
      templateKey: 'verification',
      vars: { recipient_name: 'Ada', verification_url: 'https://portal.test/v?token=x' },
      idempotencyKey: 'worker:happy',
    });
    assert.equal(created, true);
    assert.equal(entry.status, 'pending');

    const result = await harness.tick();
    assert.equal(result.claimed, 1);
    assert.equal(result.sent, 1);

    const stored = await harness.store.emailOutbox.findById(entry.id);
    assert.equal(stored?.status, 'sent');
    assert.equal(stored?.next_attempt_at, null);
    assert.equal(harness.mailbox.sent.length, 1);
    assert.equal(harness.mailbox.sent[0]?.to, 'ada@example.test');
    assert.ok(harness.mailbox.sent[0]?.html.includes('portal.test'));
  });

  it('suppresses a duplicate enqueue with the same idempotency key', async () => {
    const first = await harness.services.email.enqueue({
      to: 'dupe@example.test',
      templateKey: 'mass',
      vars: { subject: 'Hi', body_html: '<p>Hi</p>', body_text: 'Hi' },
      idempotencyKey: 'worker:dupe',
    });
    const second = await harness.services.email.enqueue({
      to: 'dupe@example.test',
      templateKey: 'mass',
      vars: { subject: 'Hi again', body_html: '<p>Hi</p>', body_text: 'Hi' },
      idempotencyKey: 'worker:dupe',
    });

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.entry.id, first.entry.id);
    assert.equal(second.entry.subject, 'Hi', 'the first render wins');

    const rows = (await harness.outbox()).filter((row) => row.idempotency_key === 'worker:dupe');
    assert.equal(rows.length, 1);
  });

  it('reschedules with exponential backoff when delivery fails', async () => {
    const { entry } = await harness.services.email.enqueue({
      to: 'retry@example.test',
      templateKey: 'mass',
      vars: { subject: 'Retry', body_html: '<p>x</p>', body_text: 'x' },
      idempotencyKey: 'worker:retry',
    });
    harness.mailbox.failure = new Error('relay refused the connection');

    const sentAt = Date.now();
    const result = await harness.tick();
    assert.equal(result.rescheduled, 1);
    assert.equal(result.sent, 0);

    const stored = await harness.store.emailOutbox.findById(entry.id);
    assert.equal(stored?.status, 'pending');
    assert.equal(stored?.attempts, 1);
    assert.equal(stored?.last_error, 'relay refused the connection');

    const delay = Date.parse(stored?.next_attempt_at ?? '') - sentAt;
    assert.ok(delay >= OUTBOX_BASE_BACKOFF_MS * 2 - 1_000, `first retry waits ~60s (got ${delay})`);
    assert.ok(delay <= OUTBOX_BASE_BACKOFF_MS * 2 * 1.1 + 1_000);
  });

  it('marks a message failed once the attempts are exhausted', async () => {
    const { entry } = await harness.services.email.enqueue({
      to: 'doomed@example.test',
      templateKey: 'mass',
      vars: { subject: 'Doomed', body_html: '<p>x</p>', body_text: 'x' },
      idempotencyKey: 'worker:doomed',
    });
    harness.mailbox.failure = new Error('mailbox does not exist');

    for (let attempt = 1; attempt <= OUTBOX_MAX_ATTEMPTS; attempt += 1) {
      await makeDue(harness, entry.id);
      const result = await harness.tick();
      assert.equal(result.claimed, 1, `attempt ${attempt} claims the row`);
    }

    const stored = await harness.store.emailOutbox.findById(entry.id);
    assert.equal(stored?.status, 'failed');
    assert.equal(stored?.attempts, OUTBOX_MAX_ATTEMPTS);
    assert.equal(stored?.next_attempt_at, null);
    assert.equal(stored?.last_error, 'mailbox does not exist');

    // A failed row is never claimed again.
    harness.mailbox.failure = null;
    const quiet = await harness.tick();
    assert.equal(quiet.claimed, 0);
  });

  it('claims nothing while SMTP is unconfigured', async () => {
    const { entry } = await harness.services.email.enqueue({
      to: 'waiting@example.test',
      templateKey: 'mass',
      vars: { subject: 'Waiting', body_html: '<p>x</p>', body_text: 'x' },
      idempotencyKey: 'worker:unconfigured',
    });
    harness.mailbox.unconfigured = true;

    const result = await harness.tick();
    assert.equal(result.skipped, true);
    assert.equal(result.claimed, 0);

    const stored = await harness.store.emailOutbox.findById(entry.id);
    assert.equal(stored?.status, 'pending', 'queued mail waits for configuration');
    assert.equal(stored?.attempts, 0);
  });
});
