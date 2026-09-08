/**
 * What the stale sweep may and may not do to a claim that is still in flight.
 *
 * `releaseStale` decides on age alone, so a worker that is slow — not crashed —
 * can have its row handed to a second worker mid-`send`. Before the claim
 * carried an ownership token, the slow worker's `markSent`/`reschedule`/
 * `markFailed` then landed on the row the winner had already settled: a `sent`
 * row went back to `pending` and was delivered a third time, and nothing
 * recorded that it had happened.
 *
 * Each case parks one worker inside `send` on a barrier, reclaims its row from
 * underneath it, lets a second worker deliver and settle, and then releases the
 * first. The settling write it was about to make must be refused, counted and
 * logged rather than applied. The suite runs against every adapter because the
 * fence is an adapter-level `WHERE id = ? AND generation = ? AND status =
 * 'sending'`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { OUTBOX_MAX_ATTEMPTS } from '@ferrum-nexus/shared';

import type { NexusStore } from '../db/store.js';
import { createOutboxWorker, type OutboxTickResult } from '../email/outbox-worker.js';
import type { MailTransport } from '../email/service.js';
import { isoInSeconds, nowIso } from '../lib/ids.js';

function barrier(): { reached: Promise<void>; release: () => void } {
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { reached, release };
}

/** Two real workers over one store, with a barrier where the race lives. */
export function runOutboxFencingContract(
  label: string,
  makeStore: () => Promise<{ store: NexusStore; teardown: () => Promise<void> }>,
): void {
  describe(`outbox claim fencing — ${label}`, () => {
    for (const write of ['markSent', 'reschedule', 'markFailed'] as const) {
      it(`a reclaimed row refuses the previous owner's ${write}`, async () => {
        const target = await makeStore();
        const store = target.store;
        const reached = barrier();
        const resume = barrier();
        let stalled: Promise<OutboxTickResult> | undefined;
        try {
          const recipient = 'fenced@example.test';
          const { entry } = await store.emailOutbox.enqueue({
            to_email: recipient,
            subject: 'Fenced',
            body_html: '<p>x</p>',
            body_text: 'x',
          });

          // Burn the retries so the stalled worker's failure is the terminal one.
          if (write === 'markFailed') {
            for (let attempt = 1; attempt < OUTBOX_MAX_ATTEMPTS; attempt += 1) {
              const [spent] = await store.emailOutbox.claimDue(nowIso(), 1);
              assert.ok(spent);
              assert.equal(
                await store.emailOutbox.reschedule(spent, isoInSeconds(-1), 'relay down'),
                true,
              );
            }
          }

          const delivered: string[] = [];
          const stalledTransport: MailTransport = {
            async send(mail) {
              delivered.push(mail.to);
              reached.release();
              await resume.reached;
              if (write !== 'markSent') throw new Error('relay refused the message');
            },
          };
          const slow = createOutboxWorker({
            store,
            transportFactory: async () => stalledTransport,
            batchSize: 1,
          });
          stalled = slow.tick();
          await Promise.race([
            reached.reached,
            stalled.then(() => {
              throw new Error('the attempt missed its barrier');
            }),
          ]);
          assert.equal((await store.emailOutbox.findById(entry.id))?.status, 'sending');

          // Another instance's sweep decides the claim is a crashed worker's.
          assert.equal(await store.emailOutbox.releaseStale(isoInSeconds(60)), 1);
          const promptTransport: MailTransport = {
            async send(mail) {
              delivered.push(mail.to);
            },
          };
          const fast = createOutboxWorker({
            store,
            transportFactory: async () => promptTransport,
            batchSize: 1,
          });
          const won = await fast.tick();
          assert.equal(won.claimed, 1, 'the reclaimed row went to the second worker');
          assert.equal(won.sent, 1);
          assert.equal(won.lost, 0);

          const settled = await store.emailOutbox.findById(entry.id);
          assert.equal(settled?.status, 'sent');
          assert.equal(settled?.last_error, null);

          resume.release();
          const lost = await stalled;
          assert.equal(lost.lost, 1, 'the superseded attempt did not settle the row');
          assert.equal(lost.sent, 0);
          assert.equal(lost.rescheduled, 0);
          assert.equal(lost.failed, 0);
          assert.equal(lost.abandoned, 0);
          assert.deepEqual(
            await store.emailOutbox.findById(entry.id),
            settled,
            'including every timestamp and the ownership token',
          );
          assert.deepEqual(delivered, [recipient, recipient]);
        } finally {
          resume.release();
          await stalled?.catch(() => undefined);
          await target.teardown();
        }
      });
    }
  });
}
