import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type { ApiErrorBody, MassEmailResponse } from '@ferrum-nexus/shared';

import { NexusError } from '../lib/errors.js';
import { buildTestApp, type TestApp, type TestSession } from './helpers.js';

function errorBody(body: string): ApiErrorBody['error'] {
  return (JSON.parse(body) as ApiErrorBody).error;
}

describe('mass email', () => {
  let harness: TestApp;
  let founder: TestSession;
  let clientA: TestSession;
  let clientB: TestSession;
  let provider: TestSession;

  before(async () => {
    harness = await buildTestApp();
    founder = await harness.registerUser({ email: 'founder@example.test' });
    clientA = await harness.registerUser({ email: 'client-a@example.test', role: 'client' });
    clientB = await harness.registerUser({ email: 'client-b@example.test', role: 'client' });
    provider = await harness.registerUser({ email: 'provider@example.test', role: 'provider' });
  });

  after(async () => {
    await harness.close();
  });

  async function outboxTo(email: string): Promise<number> {
    return (await harness.outbox()).filter((row) => row.to_email === email).length;
  }

  it('enqueues one row per recipient of a filtered audience', async () => {
    const response = await harness.authed(founder, {
      method: 'POST',
      url: '/api/admin/mass-email',
      payload: {
        subject: 'Scheduled maintenance',
        body_html: '<p>The gateway restarts at <b>02:00 UTC</b>.</p>',
        body_text: 'The gateway restarts at 02:00 UTC.',
        audience: { scope: 'filtered', roles: ['client'] },
      },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json<MassEmailResponse>();
    assert.equal(body.enqueued, 2);
    assert.equal(body.recipients, 2);
    // No `idempotency_key` was supplied, so the server generated the batch id
    // and echoes it: without that, a retry after a lost response would mint a
    // new one and mail everybody twice.
    assert.ok(body.batch_id.length > 0);

    assert.equal(await outboxTo('client-a@example.test'), 1);
    assert.equal(await outboxTo('client-b@example.test'), 1);
    assert.equal(await outboxTo('provider@example.test'), 0);
    assert.equal(await outboxTo('founder@example.test'), 0);

    const row = (await harness.outbox()).find((r) => r.to_email === 'client-a@example.test');
    assert.equal(row?.subject, 'Scheduled maintenance');
    assert.ok(row?.body_html.includes('<b>02:00 UTC</b>'), 'admin html is not escaped');
    assert.equal(
      row?.idempotency_key,
      `mass:${body.batch_id}:${clientA.user.id}`,
      'the echoed batch id is the one the outbox rows were keyed with',
    );
  });

  it('is idempotent when the same key is replayed', async () => {
    const payload = {
      subject: 'Please re-read the terms',
      body_html: '<p>Updated terms.</p>',
      body_text: 'Updated terms.',
      audience: { scope: 'filtered', roles: ['client'] },
      idempotency_key: 'campaign-2026-08',
    };

    const first = await harness.authed(founder, {
      method: 'POST',
      url: '/api/admin/mass-email',
      payload,
    });
    assert.deepEqual(first.json<MassEmailResponse>(), {
      enqueued: 2,
      recipients: 2,
      batch_id: 'campaign-2026-08',
    });

    const replay = await harness.authed(founder, {
      method: 'POST',
      url: '/api/admin/mass-email',
      payload,
    });
    assert.deepEqual(
      replay.json<MassEmailResponse>(),
      { enqueued: 0, recipients: 2, batch_id: 'campaign-2026-08' },
      'a replay matches the audience but queues nothing',
    );

    const rows = (await harness.outbox()).filter((row) =>
      row.idempotency_key?.startsWith('mass:campaign-2026-08:'),
    );
    assert.equal(rows.length, 2);
    assert.equal(rows.filter((row) => row.to_email === 'client-b@example.test').length, 1);
  });

  it('honours the all and explicit audiences', async () => {
    const all = await harness.authed(founder, {
      method: 'POST',
      url: '/api/admin/mass-email',
      payload: {
        subject: 'Everyone',
        body_text: 'Hello everyone',
        audience: { scope: 'all' },
      },
    });
    assert.equal(all.json<MassEmailResponse>().recipients, 4);

    const explicit = await harness.authed(founder, {
      method: 'POST',
      url: '/api/admin/mass-email',
      payload: {
        subject: 'Just you',
        body_text: 'Hello provider',
        audience: { scope: 'explicit', user_ids: [provider.user.id] },
      },
    });
    const explicitBody = explicit.json<MassEmailResponse>();
    assert.equal(explicitBody.enqueued, 1);
    assert.equal(explicitBody.recipients, 1);

    const empty = await harness.authed(founder, {
      method: 'POST',
      url: '/api/admin/mass-email',
      payload: {
        subject: 'Nobody',
        body_text: 'Hello nobody',
        audience: { scope: 'explicit', user_ids: [] },
      },
    });
    assert.equal(empty.statusCode, 400);
  });

  it('leaves disabled accounts out of the all audience', async () => {
    await harness.store.users.update(clientB.user.id, { status: 'disabled' });
    const response = await harness.authed(founder, {
      method: 'POST',
      url: '/api/admin/mass-email',
      payload: { subject: 'After', body_text: 'After', audience: { scope: 'all' } },
    });
    assert.equal(response.json<MassEmailResponse>().recipients, 3);
    await harness.store.users.update(clientB.user.id, { status: 'active' });
  });

  it('refuses a non-admin sender and audits every send', async () => {
    const denied = await harness.authed(clientA, {
      method: 'POST',
      url: '/api/admin/mass-email',
      payload: { subject: 'Spam', body_text: 'Spam', audience: { scope: 'all' } },
    });
    assert.equal(denied.statusCode, 403);

    const audit = await harness.store.auditLogs.list({ action: 'admin.mass_email' });
    assert.equal(audit.total, 6);
    const details = audit.items[0]?.details as { recipients?: number; audience_scope?: string };
    assert.ok(typeof details.recipients === 'number');
    assert.ok(typeof details.audience_scope === 'string');
  });

  it('delivers the queued campaign on the next worker tick', async () => {
    const pending = (await harness.outbox()).filter((row) => row.status === 'pending').length;
    assert.ok(pending > 0);

    const result = await harness.tick();
    assert.equal(result.claimed, pending);
    assert.equal(result.sent, pending);
    assert.equal(harness.mailbox.sent.length, pending);
    assert.equal((await harness.outbox()).filter((row) => row.status === 'pending').length, 0);
  });

  it('delivers campaigns with 300-character subjects once despite lost responses', async () => {
    const subject = 'S'.repeat(300);
    const campaigns = [
      { id: '0123456789abcdef0123456789abcdef', body: 'First announcement' },
      { id: 'fedcba9876543210fedcba9876543210', body: 'Second announcement' },
    ];
    const sentBefore = harness.mailbox.sent.length;

    for (const campaign of campaigns) {
      const request = {
        method: 'POST' as const,
        url: '/api/admin/mass-email',
        payload: {
          subject,
          body_text: campaign.body,
          body_html: `<p>${campaign.body}</p>`,
          audience: { scope: 'filtered', roles: ['client'] },
          idempotency_key: campaign.id,
        },
      };
      // The server handles the request, but the client loses its response.
      await harness.authed(founder, request);
      const retry = await harness.authed(founder, request);
      assert.equal(retry.statusCode, 200);
      assert.deepEqual(retry.json<MassEmailResponse>(), {
        enqueued: 0,
        recipients: 2,
        batch_id: campaign.id,
      });

      const rows = (await harness.outbox()).filter((row) =>
        row.idempotency_key?.startsWith(`mass:${campaign.id}:`),
      );
      assert.equal(rows.length, 2);
      for (const client of [clientA, clientB]) {
        const recipientRows = rows.filter((row) => row.to_email === client.user.email);
        assert.equal(recipientRows.length, 1);
        assert.equal(recipientRows[0]?.subject, subject);
        assert.ok(recipientRows[0]?.body_text.includes(campaign.body));
      }
    }

    const result = await harness.tick();
    assert.equal(result.sent, 4);
    assert.equal(harness.mailbox.sent.length - sentBefore, 4);
    assert.equal((await harness.tick()).sent, 0);
  });
});

/**
 * The audience ceiling — `NEXUS_MAX_MASS_EMAIL_RECIPIENTS`.
 *
 * The fan-out became one transaction, which is what makes a failed campaign
 * queue nothing; it also means the audience is what that transaction has to
 * hold, and — because every adapter drains transaction bodies through a queue
 * per store object — what the whole instance stops writing for while the
 * inserts run. On MongoDB the 16 MB per-transaction cap turns it into an
 * outright failure at a few hundred recipients with a large body. The broadcast
 * path got a ceiling for exactly this; this is the same ceiling for the same
 * reason, and it refuses before a single row is written.
 */
describe('mass email recipient ceiling', () => {
  it('refuses an audience past the ceiling and queues nothing', async () => {
    const harness = await buildTestApp({
      env: { NEXUS_MAX_MASS_EMAIL_RECIPIENTS: '2' },
      deps: { startOutboxWorker: false },
    });
    try {
      const admin = await harness.registerUser({ email: 'ceiling-admin@example.test' });
      for (const index of [1, 2, 3]) {
        await harness.registerUser({
          email: `ceiling-client-${index}@example.test`,
          role: 'client',
        });
      }
      const outboxBefore = (await harness.outbox()).length;
      const auditBefore = (await harness.auditRows('admin.mass_email')).length;

      const campaign = {
        subject: 'Too many',
        body_html: '<p>Three recipients against a ceiling of two.</p>',
        body_text: 'Three recipients against a ceiling of two.',
      };
      const refused = await harness.authed(admin, {
        method: 'POST',
        url: '/api/admin/mass-email',
        payload: { ...campaign, audience: { scope: 'filtered', roles: ['client'] } },
      });

      assert.equal(refused.statusCode, 429, refused.body);
      const failure = errorBody(refused.body);
      assert.equal(failure.code, 'QUOTA_EXCEEDED');
      assert.deepEqual(failure.details, {
        limit: 2,
        recipients: 3,
        setting: 'NEXUS_MAX_MASS_EMAIL_RECIPIENTS',
      });
      assert.ok(failure.message.includes('3'), 'the message names the audience size');
      assert.ok(failure.message.includes('2'), 'and the limit');
      assert.equal((await harness.outbox()).length, outboxBefore);
      assert.equal((await harness.auditRows('admin.mass_email')).length, auditBefore);

      // A narrower audience still goes out, which is why the refusal names the
      // size it refused.
      const allowed = await harness.authed(admin, {
        method: 'POST',
        url: '/api/admin/mass-email',
        payload: {
          ...campaign,
          subject: 'Few enough',
          audience: { scope: 'filtered', roles: ['provider'] },
        },
      });
      assert.equal(allowed.statusCode, 200, allowed.body);
    } finally {
      await harness.close();
    }
  });

  it('treats 0 as no ceiling', async () => {
    const harness = await buildTestApp({
      env: { NEXUS_MAX_MASS_EMAIL_RECIPIENTS: '0' },
      deps: { startOutboxWorker: false },
    });
    try {
      assert.equal(harness.config.maxMassEmailRecipients, 0);
      const admin = await harness.registerUser({ email: 'uncapped-admin@example.test' });
      for (const index of [1, 2, 3]) {
        await harness.registerUser({
          email: `uncapped-client-${index}@example.test`,
          role: 'client',
        });
      }
      const response = await harness.authed(admin, {
        method: 'POST',
        url: '/api/admin/mass-email',
        payload: {
          subject: 'Everybody',
          body_html: '<p>No ceiling at all.</p>',
          body_text: 'No ceiling at all.',
          audience: { scope: 'all' },
        },
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json<MassEmailResponse>().enqueued, 4);
    } finally {
      await harness.close();
    }
  });
});

/**
 * Contention is a `409`, not a `500`.
 *
 * The pooled adapters re-run a transaction body the engine rolled back for
 * contention and, when the retry budget runs out, raise `NexusError('CONFLICT')`
 * rather than a driver error. The campaign is still queueable and the caller
 * should simply retry it — a different instruction from "this send is broken" —
 * so the `catch` around the fan-out has to let that code through instead of
 * rewriting every failure as `OUTBOX_FAILURE`.
 */
describe('a mass-email campaign that loses to contention', () => {
  it('answers 409 CONFLICT and still carries the batch id', async (t) => {
    const harness = await buildTestApp({ deps: { startOutboxWorker: false } });
    try {
      const admin = await harness.registerUser({ email: 'contended-admin@example.test' });
      await harness.registerUser({ email: 'contended-client@example.test', role: 'client' });
      const outboxBefore = (await harness.outbox()).length;

      const campaign = {
        subject: 'Contended',
        body_html: '<p>Lost to contention.</p>',
        body_text: 'Lost to contention.',
        audience: { scope: 'all' as const },
        idempotency_key: 'contended-campaign',
      };
      // What an adapter raises once contention outlives its retry budget.
      const contention = new NexusError(
        'CONFLICT',
        'The database is too busy to complete that right now — please retry',
      );
      const mocked = t.mock.method(harness.store, 'transaction', <T>(): Promise<T> =>
        Promise.reject(contention),
      );
      const refused = await harness.authed(admin, {
        method: 'POST',
        url: '/api/admin/mass-email',
        payload: campaign,
      });
      mocked.mock.restore();

      assert.equal(refused.statusCode, 409, refused.body);
      const failure = errorBody(refused.body);
      assert.equal(failure.code, 'CONFLICT', 'not rewritten as OUTBOX_FAILURE');
      assert.equal(failure.message, contention.message, 'the adapter’s wording survives');
      assert.deepEqual(failure.details, { batch_id: 'contended-campaign' });
      assert.equal((await harness.outbox()).length, outboxBefore, 'nothing was queued');

      // And the retry with that key goes through, which is the point of
      // answering `CONFLICT` rather than `OUTBOX_FAILURE`.
      const retry = await harness.authed(admin, {
        method: 'POST',
        url: '/api/admin/mass-email',
        payload: campaign,
      });
      assert.equal(retry.statusCode, 200, retry.body);
      assert.equal(retry.json<MassEmailResponse>().batch_id, 'contended-campaign');
      assert.equal(retry.json<MassEmailResponse>().enqueued, 2);
    } finally {
      await harness.close();
    }
  });
});
