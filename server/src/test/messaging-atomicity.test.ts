/**
 * "The state changed and the record did not" — the two messaging paths that
 * used to be able to say it, driven with an injected store failure.
 *
 * 1. **Messaging** recorded its audit row after the transaction committed, so a
 *    failed audit write returned `500` for a message that was durably stored
 *    and visible to both participants, with no `message.send` row — and the
 *    sender's natural retry stored a second copy.
 * 2. **Mass email** enqueued one recipient at a time, each row committing on
 *    its own, and audited after the loop. A failure partway delivered to part
 *    of the audience, recorded nothing, and answered with a bare `500` that did
 *    not carry the batch id, so the retry minted a new one and mailed the
 *    already-queued recipients again.
 *
 * Both now commit their rows and their audit row in one transaction, so the
 * `500` is truthful: nothing happened.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type {
  ApiErrorBody,
  CreateThreadResponse,
  ListThreadMessagesResponse,
  MassEmailResponse,
  SendMessageResponse,
} from '@ferrum-nexus/shared';

import { faultInjectingStore, type FaultInjectingStore } from './fault-injection.js';
import { buildTestApp, type TestApp, type TestSession } from './helpers.js';

function errorBody(body: string): ApiErrorBody['error'] {
  return (JSON.parse(body) as ApiErrorBody).error;
}

describe('messaging audits inside its transaction', () => {
  let harness: TestApp;
  let faults: FaultInjectingStore;
  let founder: TestSession;
  let sender: TestSession;
  let threadId: string;

  before(async () => {
    harness = await buildTestApp({
      deps: { startOutboxWorker: false },
      wrapStore: (store) => {
        faults = faultInjectingStore(store);
        return faults.store;
      },
    });
    founder = await harness.registerUser({ email: 'atomic-audit-founder@example.test' });
    sender = await harness.registerUser({ email: 'atomic-audit-sender@example.test' });

    const opened = await harness.authed(sender, {
      method: 'POST',
      url: '/api/threads',
      payload: { subject: 'Audited', recipient_user_id: founder.user.id, body: 'One' },
    });
    assert.equal(opened.statusCode, 201, opened.body);
    threadId = opened.json<CreateThreadResponse>().thread.id;
  });

  after(async () => {
    await harness.close();
  });

  /** Messages the recipient can actually read in the thread. */
  async function visibleMessages(): Promise<number> {
    const page = await harness.authed(founder, {
      method: 'GET',
      url: `/api/threads/${threadId}/messages?limit=200`,
    });
    assert.equal(page.statusCode, 200, page.body);
    return page.json<ListThreadMessagesResponse>().items.length;
  }

  it('rolls the reply back when its audit row cannot be written', async () => {
    const visible = await visibleMessages();
    const sendRows = (await harness.auditRows('message.send')).length;

    faults.failNext('auditLogs', 'create');
    const refused = await harness.authed(sender, {
      method: 'POST',
      url: `/api/threads/${threadId}/messages`,
      payload: { body: 'This must not survive' },
    });

    assert.equal(refused.statusCode, 500, refused.body);
    assert.deepEqual(faults.pending(), [], 'the intended failure was reached');
    assert.equal(await visibleMessages(), visible, 'the 500 is truthful: nothing was stored');
    assert.equal((await harness.auditRows('message.send')).length, sendRows);
  });

  it('rolls the whole thread creation back when the second audit row fails', async () => {
    const threads = (await harness.store.threads.list({}, { limit: 50 })).total;
    const createRows = (await harness.auditRows('message.thread_create')).length;
    const sendRows = (await harness.auditRows('message.send')).length;

    // `message.thread_create` is written first and `message.send` second, so
    // failing the second one is the case where a partial trail could survive.
    faults.failAfter('auditLogs', 'create', 1);
    const refused = await harness.authed(sender, {
      method: 'POST',
      url: '/api/threads',
      payload: { subject: 'Never opened', body: 'Nor posted' },
    });

    assert.equal(refused.statusCode, 500, refused.body);
    assert.deepEqual(faults.pending(), []);
    assert.equal((await harness.store.threads.list({}, { limit: 50 })).total, threads);
    assert.equal((await harness.auditRows('message.thread_create')).length, createRows);
    assert.equal((await harness.auditRows('message.send')).length, sendRows);
  });

  it('writes exactly one message.send row with the message it describes', async () => {
    const visible = await visibleMessages();
    const sendRows = await harness.auditRows('message.send');

    const response = await harness.authed(sender, {
      method: 'POST',
      url: `/api/threads/${threadId}/messages`,
      payload: { body: 'A message that does survive' },
    });
    assert.equal(response.statusCode, 201, response.body);

    assert.equal(await visibleMessages(), visible + 1);
    const recorded = await harness.auditRows('message.send');
    assert.equal(recorded.length, sendRows.length + 1);
    const newest = recorded.find((row) => !sendRows.some((old) => old.id === row.id));
    assert.equal(newest?.target_id, response.json<SendMessageResponse>().message.id);
  });
});

describe('mass email fan-out is atomic', () => {
  let harness: TestApp;
  let faults: FaultInjectingStore;
  let founder: TestSession;

  before(async () => {
    harness = await buildTestApp({
      deps: { startOutboxWorker: false },
      wrapStore: (store) => {
        faults = faultInjectingStore(store);
        return faults.store;
      },
    });
    founder = await harness.registerUser({ email: 'atomic-mass-founder@example.test' });
    for (const index of [1, 2, 3, 4, 5, 6]) {
      await harness.registerUser({ email: `atomic-mass-${index}@example.test`, role: 'client' });
    }
  });

  after(async () => {
    await harness.close();
  });

  const campaign = {
    subject: 'Scheduled maintenance',
    body_html: '<p>The gateway restarts at <b>02:00 UTC</b>.</p>',
    body_text: 'The gateway restarts at 02:00 UTC.',
    audience: { scope: 'all' as const },
  };

  it('queues nothing and audits nothing when one enqueue fails partway', async () => {
    const outboxBefore = (await harness.outbox()).length;
    const auditBefore = (await harness.auditRows('admin.mass_email')).length;

    faults.failAfter('emailOutbox', 'enqueue', 3);
    const refused = await harness.authed(founder, {
      method: 'POST',
      url: '/api/admin/mass-email',
      payload: campaign,
    });

    assert.equal(refused.statusCode, 500, refused.body);
    assert.deepEqual(faults.pending(), [], 'the intended failure was reached');
    assert.equal(
      (await harness.outbox()).length,
      outboxBefore,
      'the three rows the loop had already written are rolled back with the rest',
    );
    assert.equal((await harness.auditRows('admin.mass_email')).length, auditBefore);
  });

  it('reports the batch id and the counts on the failure, so the retry is safe', async () => {
    faults.failAfter('emailOutbox', 'enqueue', 2);
    const refused = await harness.authed(founder, {
      method: 'POST',
      url: '/api/admin/mass-email',
      payload: campaign,
    });
    assert.equal(refused.statusCode, 500, refused.body);

    const failure = errorBody(refused.body);
    assert.equal(failure.code, 'OUTBOX_FAILURE');
    const details = failure.details as { batch_id: string; recipients: number; enqueued: number };
    assert.equal(typeof details.batch_id, 'string');
    assert.ok(details.batch_id.length > 0, 'the generated batch id is surfaced');
    assert.equal(details.recipients, 7);
    assert.equal(details.enqueued, 0);

    // Retrying with that key is what a second attempt should do, and it works:
    // the failed attempt left no rows, so this one queues the whole audience.
    const retry = await harness.authed(founder, {
      method: 'POST',
      url: '/api/admin/mass-email',
      payload: { ...campaign, idempotency_key: details.batch_id },
    });
    assert.equal(retry.statusCode, 200, retry.body);
    assert.deepEqual(retry.json<MassEmailResponse>(), {
      enqueued: 7,
      recipients: 7,
      batch_id: details.batch_id,
    });

    // And running it a third time with the same key mails nobody again.
    const replay = await harness.authed(founder, {
      method: 'POST',
      url: '/api/admin/mass-email',
      payload: { ...campaign, idempotency_key: details.batch_id },
    });
    assert.equal(replay.json<MassEmailResponse>().enqueued, 0);
    const rows = (await harness.outbox()).filter((row) =>
      row.idempotency_key?.startsWith(`mass:${details.batch_id}:`),
    );
    assert.equal(rows.length, 7, 'one row per recipient, however many times it was retried');
  });

  it('rolls the queued rows back when the audit row itself fails', async () => {
    const outboxBefore = (await harness.outbox()).length;
    const auditBefore = (await harness.auditRows('admin.mass_email')).length;

    faults.failNext('auditLogs', 'create');
    const refused = await harness.authed(founder, {
      method: 'POST',
      url: '/api/admin/mass-email',
      payload: { ...campaign, subject: 'Unaudited', idempotency_key: 'unaudited-campaign' },
    });

    assert.equal(refused.statusCode, 500, refused.body);
    assert.deepEqual(faults.pending(), []);
    assert.equal((await harness.outbox()).length, outboxBefore);
    assert.equal((await harness.auditRows('admin.mass_email')).length, auditBefore);
  });

  it('echoes the batch id of a successful campaign that was given no key', async () => {
    const response = await harness.authed(founder, {
      method: 'POST',
      url: '/api/admin/mass-email',
      payload: { ...campaign, subject: 'Keyless' },
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json<MassEmailResponse>();
    assert.equal(body.recipients, 7);
    assert.equal(body.enqueued, 7);
    assert.ok(body.batch_id.length > 0);

    const audit = (await harness.auditRows('admin.mass_email'))[0];
    assert.equal(audit?.target_id, body.batch_id, 'the audit row names the batch the caller got');
    assert.equal(audit?.details.enqueued, 7);
    assert.equal(audit?.details.recipients, 7);
  });
});
