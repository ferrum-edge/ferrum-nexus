import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type { MassEmailResponse } from '@ferrum-nexus/shared';

import { buildTestApp, type TestApp, type TestSession } from './helpers.js';

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
    assert.deepEqual(response.json<MassEmailResponse>(), { enqueued: 2, recipients: 2 });

    assert.equal(await outboxTo('client-a@example.test'), 1);
    assert.equal(await outboxTo('client-b@example.test'), 1);
    assert.equal(await outboxTo('provider@example.test'), 0);
    assert.equal(await outboxTo('founder@example.test'), 0);

    const row = (await harness.outbox()).find((r) => r.to_email === 'client-a@example.test');
    assert.equal(row?.subject, 'Scheduled maintenance');
    assert.ok(row?.body_html.includes('<b>02:00 UTC</b>'), 'admin html is not escaped');
    assert.ok(row?.idempotency_key?.startsWith('mass:'));
    assert.ok(row?.idempotency_key?.endsWith(`:${clientA.user.id}`));
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
    assert.deepEqual(first.json<MassEmailResponse>(), { enqueued: 2, recipients: 2 });

    const replay = await harness.authed(founder, {
      method: 'POST',
      url: '/api/admin/mass-email',
      payload,
    });
    assert.deepEqual(
      replay.json<MassEmailResponse>(),
      { enqueued: 0, recipients: 2 },
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
    assert.deepEqual(explicit.json<MassEmailResponse>(), { enqueued: 1, recipients: 1 });

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
});
