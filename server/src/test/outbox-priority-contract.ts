/** Priority at the transactional claim boundary, exercised by all four stores. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadConfig } from '../config/index.js';
import {
  OUTBOX_PRIORITY,
  type EmailOutboxRecord,
  type EnqueueEmailInput,
  type NexusStore,
} from '../db/store.js';
import { createOutboxWorker, type OutboxTickResult } from '../email/outbox-worker.js';
import { createEmailService } from '../email/service.js';
import { createCrypto } from '../lib/crypto.js';
import { nowIso } from '../lib/ids.js';
import { TEST_SECRET_KEY } from './helpers.js';

const EARLY = '2000-01-01T00:00:00.000Z';
const LATER = '2001-01-01T00:00:00.000Z';
const FUTURE = '2999-01-01T00:00:00.000Z';

function message(subject: string, extra: Partial<EnqueueEmailInput> = {}): EnqueueEmailInput {
  return {
    to_email: 'priority@example.test',
    subject,
    body_html: `<p>${subject}</p>`,
    body_text: subject,
    ...extra,
  };
}

function emailOver(store: NexusStore): ReturnType<typeof createEmailService> {
  return createEmailService({
    store,
    crypto: createCrypto(TEST_SECRET_KEY),
    config: loadConfig({
      NEXUS_ENV: 'test',
      NEXUS_PUBLIC_URL: 'https://portal.example.test',
      NEXUS_SECRET_KEY: TEST_SECRET_KEY,
      FERRUM_ADMIN_JWT_SECRET: TEST_SECRET_KEY,
    }),
  });
}

function barrier(): { reached: Promise<void>; release: () => void } {
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { reached, release };
}

export function runOutboxPriorityContract(
  label: string,
  makeStore: () => Promise<{
    store: NexusStore;
    teardown: () => Promise<void>;
    peer?: () => Promise<NexusStore>;
  }>,
): void {
  describe(`outbox priority contract — ${label}`, { timeout: 30_000 }, () => {
    it('claims later security ahead of older campaigns, then ordered fallback', async () => {
      const target = await makeStore();
      const { store } = target;
      try {
        const first = await store.emailOutbox.enqueue(
          message('Campaign first', { priority: OUTBOX_PRIORITY.low, next_attempt_at: EARLY }),
        );
        const second = await store.emailOutbox.enqueue(
          message('Campaign second', { priority: OUTBOX_PRIORITY.low, next_attempt_at: LATER }),
        );
        const legacy = await store.emailOutbox.enqueue(
          message('Legacy campaign', { idempotency_key: 'mass:legacy', next_attempt_at: EARLY }),
        );
        assert.equal(legacy.entry.priority, OUTBOX_PRIORITY.normal, 'omitted priority is normal');
        const email = emailOver(store);
        const routine = await email.enqueue({ to: 'routine@example.test', templateKey: 'mass' });
        assert.equal(routine.entry.priority, OUTBOX_PRIORITY.low);
        const notification = await email.enqueue({
          to: 'notification@example.test',
          templateKey: 'access_approved',
          vars: { api_url: 'https://portal.example.test/apis/priority' },
        });
        assert.equal(notification.entry.priority, OUTBOX_PRIORITY.normal);
        const security: EmailOutboxRecord[] = [];
        for (const templateKey of ['password_reset', 'verification'] as const) {
          // No idempotency key: the template itself must choose the high lane.
          const { entry } = await email.enqueue({
            to: 'security@example.test',
            templateKey,
            vars: {
              reset_url: 'https://portal.example.test/reset-password?token=priority',
              verification_url: 'https://portal.example.test/verify-email?token=priority',
            },
          });
          assert.equal(entry.priority, OUTBOX_PRIORITY.high);
          security.push(entry);
        }
        const future = await store.emailOutbox.enqueue(
          message('Future security', { priority: OUTBOX_PRIORITY.high, next_attempt_at: FUTURE }),
        );

        const claimed = await store.emailOutbox.claimDue(nowIso(), 2);
        assert.deepEqual(
          claimed.map((entry) => entry.id).sort(),
          security.map((entry) => entry.id).sort(),
        );
        const fallback = await store.emailOutbox.claimDue(nowIso(), 10);
        assert.deepEqual(
          fallback.map((entry) => entry.id),
          [
            legacy.entry.id,
            notification.entry.id,
            first.entry.id,
            second.entry.id,
            routine.entry.id,
          ],
        );
        assert.equal((await store.emailOutbox.findById(future.entry.id))?.attempts, 0);

        const duplicate = await store.emailOutbox.enqueue(
          message('Duplicate', { idempotency_key: 'mass:legacy', priority: OUTBOX_PRIORITY.high }),
        );
        assert.equal(duplicate.created, false);
        assert.equal(duplicate.entry.priority, OUTBOX_PRIORITY.normal, 'replay keeps the lane');
      } finally {
        await target.teardown();
      }
    });

    it('keeps priority and ownership across retries and stale claims', async () => {
      const target = await makeStore();
      const { store } = target;
      try {
        const campaign = await store.emailOutbox.enqueue(message('Campaign'));
        const security = await store.emailOutbox.enqueue(
          message('Security', { priority: OUTBOX_PRIORITY.high }),
        );
        const [first] = await store.emailOutbox.claimDue(nowIso(), 1);
        assert.ok(first);
        assert.equal(first.id, security.entry.id);
        assert.equal(await store.emailOutbox.reschedule(first, FUTURE, 'relay down'), true);
        const [fallback] = await store.emailOutbox.claimDue(nowIso(), 1);
        assert.ok(fallback);
        assert.equal(fallback.id, campaign.entry.id, 'backoff security does not block due mail');
        assert.equal(await store.emailOutbox.markSent(fallback, nowIso()), true);

        const [retry] = await store.emailOutbox.claimDue(FUTURE, 1);
        assert.ok(retry);
        assert.equal(retry.id, first.id);
        assert.equal(retry.priority, OUTBOX_PRIORITY.high);
        assert.equal(retry.attempts, 2);
        assert.notEqual(retry.generation, first.generation);
        assert.equal(await store.emailOutbox.markSent(first, nowIso()), false);
        assert.equal(await store.emailOutbox.releaseStale(FUTURE), 1);
        const [reclaimed] = await store.emailOutbox.claimDue(FUTURE, 1);
        assert.ok(reclaimed);
        assert.equal(reclaimed.priority, OUTBOX_PRIORITY.high);
        assert.equal(reclaimed.attempts, 3);
        assert.notEqual(reclaimed.generation, retry.generation);
        assert.equal(await store.emailOutbox.markFailed(retry, 'stale owner'), false);
        assert.equal(await store.emailOutbox.markSent(reclaimed, nowIso()), true);
        assert.deepEqual(await store.emailOutbox.claimDue(FUTURE, 10), [], 'sent stays terminal');
      } finally {
        await target.teardown();
      }
    });

    it('gives concurrent workers distinct claims with recipient fencing intact', async () => {
      const target = await makeStore();
      const { store } = target;
      let peer: NexusStore | undefined;
      try {
        peer = await target.peer?.();
        const recipient = await store.users.create({
          email: 'concurrent-priority@example.test',
          display_name: 'Recipient',
          password_hash: 'unused',
          role: 'client',
          status: 'active',
          email_verified: true,
        });
        const entries: EmailOutboxRecord[] = [];
        for (const priority of [0, 1, 2, 0, 1, 2] as const) {
          const { entry } = await store.emailOutbox.enqueue(
            message(`Lane ${priority}`, {
              to_email: recipient.email,
              recipient_user_id: recipient.id,
              priority,
            }),
          );
          entries.push(entry);
        }
        const concurrent = await Promise.all([
          store.emailOutbox.claimDue(nowIso(), 2),
          (peer ?? store).emailOutbox.claimDue(nowIso(), 2),
        ]);
        const claimed = concurrent.flat();
        for (const batch of concurrent) {
          assert.deepEqual(
            batch.map((entry) => entry.priority),
            batch.map((entry) => entry.priority).sort((a, b) => b - a),
          );
        }
        assert.equal(claimed.filter((entry) => entry.priority === OUTBOX_PRIORITY.high).length, 2);
        claimed.push(...(await store.emailOutbox.claimDue(nowIso(), 10)));
        assert.equal(new Set(claimed.map((entry) => entry.id)).size, entries.length);
        assert.equal(claimed.length, entries.length, 'no concurrent duplicate claim');
        for (const claim of claimed) {
          assert.equal(claim.attempts, 1);
          assert.ok(claim.generation);
          assert.equal(claim.recipient_user_id, recipient.id);
          assert.equal(await store.emailOutbox.markSent(claim, nowIso()), true);
        }
      } finally {
        await peer?.close();
        await target.teardown();
      }
    });

    it('finishes active SMTP, then chooses new security before the next campaign', async () => {
      const target = await makeStore();
      const { store } = target;
      const reached = barrier();
      const resume = barrier();
      let ticking: Promise<OutboxTickResult> | undefined;
      try {
        await store.emailOutbox.enqueue(
          message('Active campaign', { priority: OUTBOX_PRIORITY.low, next_attempt_at: EARLY }),
        );
        await store.emailOutbox.enqueue(
          message('Waiting campaign', { priority: OUTBOX_PRIORITY.low, next_attempt_at: LATER }),
        );
        const subjects: string[] = [];
        const worker = createOutboxWorker({
          store,
          crypto: createCrypto(TEST_SECRET_KEY),
          batchSize: 3,
          transportFactory: async () => ({
            async send(mail) {
              subjects.push(mail.subject);
              if (subjects.length === 1) {
                reached.release();
                await resume.reached;
              }
            },
          }),
        });
        ticking = worker.tick();
        await Promise.race([
          reached.reached,
          ticking.then(() => assert.fail('the active campaign missed its SMTP barrier')),
        ]);
        const { entry } = await emailOver(store).enqueue({
          to: 'recovery@example.test',
          templateKey: 'password_reset',
          vars: { reset_url: 'https://portal.example.test/reset-password?token=priority' },
        });
        assert.deepEqual(subjects, ['Active campaign'], 'priority cannot interrupt active SMTP');
        resume.release();
        assert.equal((await ticking).sent, 3);
        assert.equal(subjects.length, 3);
        assert.equal(subjects[0], 'Active campaign');
        assert.equal(subjects[2], 'Waiting campaign');
        assert.equal((await store.emailOutbox.findById(entry.id))?.status, 'sent');
      } finally {
        resume.release();
        await ticking?.catch(() => undefined);
        await target.teardown();
      }
    });
  });
}
