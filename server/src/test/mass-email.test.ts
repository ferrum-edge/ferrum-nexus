import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { after, before, describe, it } from 'node:test';

import type { ApiErrorBody, MassEmailResponse } from '@ferrum-nexus/shared';

import { DEFAULT_MAX_MASS_EMAIL_BYTES, DEFAULT_MAX_MASS_EMAILS_PER_DAY } from '../config/index.js';
import type { NexusStore, TransactionOptions } from '../db/store.js';
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
    // This suite starts more campaigns from one administrator than the default
    // daily budget allows; the budget has its own suite below.
    harness = await buildTestApp({ env: { NEXUS_MAX_MASS_EMAILS_PER_DAY: '20' } });
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

    // One `admin.mass_email` row per campaign — the replay of
    // `campaign-2026-08` is the same campaign and is not recorded or charged
    // again — and one `admin.mass_email_complete` row per attempt.
    const audit = await harness.store.auditLogs.list({ action: 'admin.mass_email' });
    assert.equal(audit.total, 5);
    const details = audit.items[0]?.details as { recipients?: number; audience_scope?: string };
    assert.ok(typeof details.recipients === 'number');
    assert.ok(typeof details.audience_scope === 'string');
    const outcomes = await harness.store.auditLogs.list({ action: 'admin.mass_email_complete' });
    assert.equal(outcomes.total, 6);
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
      // The narrower send below must match real accounts: an audience that
      // resolves to nobody is refused before the ceiling is even consulted.
      await harness.registerUser({
        email: 'ceiling-provider@example.test',
        role: 'provider',
      });
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

/**
 * The aggregate ceiling — `NEXUS_MAX_MASS_EMAIL_BYTES` (GHSA-rqrj-7g3f-c6ww).
 *
 * The recipient ceiling and the two 100 000-character body limits are each
 * reasonable alone; their product — a full rendered copy per recipient — is
 * what the outbox has to store and drain ahead of every later verification and
 * password-reset message. This bounds the product, before anything is written.
 */
describe('mass email aggregate size ceiling', () => {
  it('refuses a campaign whose rendered size times its audience is too large', async () => {
    const harness = await buildTestApp({
      env: { NEXUS_MAX_MASS_EMAIL_BYTES: '4000' },
      deps: { startOutboxWorker: false },
    });
    try {
      const admin = await harness.registerUser({ email: 'bytes-admin@example.test' });
      for (const index of [1, 2, 3]) {
        await harness.registerUser({ email: `bytes-client-${index}@example.test`, role: 'client' });
      }
      const outboxBefore = (await harness.outbox()).length;
      const auditBefore = (await harness.auditRows('admin.mass_email')).length;

      // About 2 KB per message: under the limit for one recipient, over it
      // for three.
      const large = 'x'.repeat(1_000);
      const refused = await harness.authed(admin, {
        method: 'POST',
        url: '/api/admin/mass-email',
        payload: {
          subject: 'Large',
          body_html: `<p>${large}</p>`,
          body_text: large,
          audience: { scope: 'filtered', roles: ['client'] },
        },
      });
      assert.equal(refused.statusCode, 429, refused.body);
      const failure = errorBody(refused.body);
      assert.equal(failure.code, 'QUOTA_EXCEEDED');
      const details = failure.details as {
        limit: number;
        bytes: number;
        message_bytes: number;
        recipients: number;
        setting: string;
      };
      assert.equal(details.limit, 4000);
      assert.equal(details.recipients, 3);
      assert.equal(details.setting, 'NEXUS_MAX_MASS_EMAIL_BYTES');
      assert.ok(details.message_bytes > 2_000, 'both bodies count');
      assert.equal(details.bytes, details.message_bytes * 3);
      assert.ok(details.bytes > details.limit);
      assert.equal((await harness.outbox()).length, outboxBefore, 'nothing was queued');
      assert.equal(
        (await harness.auditRows('admin.mass_email')).length,
        auditBefore,
        'and nothing was recorded or charged',
      );

      // The same message to one recipient fits.
      const allowed = await harness.authed(admin, {
        method: 'POST',
        url: '/api/admin/mass-email',
        payload: {
          subject: 'Large',
          body_html: `<p>${large}</p>`,
          body_text: large,
          audience: { scope: 'filtered', roles: ['super_admin'] },
        },
      });
      assert.equal(allowed.statusCode, 200, allowed.body);
      assert.equal(allowed.json<MassEmailResponse>().enqueued, 1);
    } finally {
      await harness.close();
    }
  });

  it('treats 0 as no ceiling and ships the documented defaults', async () => {
    const defaults = await buildTestApp({ deps: { startOutboxWorker: false } });
    try {
      assert.equal(defaults.config.maxMassEmailBytes, DEFAULT_MAX_MASS_EMAIL_BYTES);
      assert.equal(DEFAULT_MAX_MASS_EMAIL_BYTES, 64 * 1024 * 1024);
      assert.equal(defaults.config.maxMassEmailsPerDay, DEFAULT_MAX_MASS_EMAILS_PER_DAY);
      // Low until security mail gets its own outbox lane (issue #500).
      assert.equal(DEFAULT_MAX_MASS_EMAILS_PER_DAY, 5);
    } finally {
      await defaults.close();
    }

    const harness = await buildTestApp({
      env: { NEXUS_MAX_MASS_EMAIL_BYTES: '0' },
      deps: { startOutboxWorker: false },
    });
    try {
      assert.equal(harness.config.maxMassEmailBytes, 0);
      const admin = await harness.registerUser({ email: 'unsized-admin@example.test' });
      await harness.registerUser({ email: 'unsized-client@example.test', role: 'client' });
      const large = 'y'.repeat(100_000);
      const response = await harness.authed(admin, {
        method: 'POST',
        url: '/api/admin/mass-email',
        payload: { subject: 'Big', body_html: large, body_text: large, audience: { scope: 'all' } },
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json<MassEmailResponse>().enqueued, 2);
    } finally {
      await harness.close();
    }
  });
});

/**
 * The per-message size is an upper bound, not a sample.
 *
 * `body_html` HTML-escapes the recipient variables, so a display name of `"`
 * characters takes six times its raw size there, while the subject and text
 * take every name verbatim; and an overridden template may repeat either
 * variable any number of times. Sizing the campaign from the longest *raw*
 * name under-counted exactly that recipient's copy, and with it the aggregate
 * ceiling and the chunk size.
 */
describe('mass email per-message size estimate', () => {
  /** Bytes of one queued row's rendered content, as the estimate counts them. */
  function rowBytes(row: { subject: string; body_html: string; body_text: string }): number {
    return (
      Buffer.byteLength(row.subject, 'utf8') +
      Buffer.byteLength(row.body_html, 'utf8') +
      Buffer.byteLength(row.body_text, 'utf8')
    );
  }

  it('bounds every copy, HTML escaping and template repetition included', async () => {
    const harness = await buildTestApp({
      env: { NEXUS_MAX_MASS_EMAIL_BYTES: '60000' },
      deps: { startOutboxWorker: false },
    });
    try {
      const admin = await harness.registerUser({ email: 'escape-admin@example.test' });
      const quoted = await harness.registerUser({ email: 'escape-quoted@example.test' });
      const plain = await harness.registerUser({ email: 'escape-plain@example.test' });
      // 150 raw bytes that escape to 900, and 200 raw bytes that escape to 200:
      // the longest raw name is not the largest HTML copy.
      await harness.store.users.update(quoted.user.id, { display_name: '"'.repeat(150) });
      await harness.store.users.update(plain.user.id, { display_name: 'a'.repeat(200) });
      const template = await harness.authed(admin, {
        method: 'PUT',
        url: '/api/admin/email-templates/mass',
        payload: {
          subject: '{{subject}}',
          body_html: `${'<p>{{recipient_name}}</p>'.repeat(50)}{{body_html}}`,
          body_text: `${'{{recipient_name}} '.repeat(50)}{{body_text}}`,
        },
      });
      assert.equal(template.statusCode, 200, template.body);

      const campaign = (userIds: string[]) => ({
        method: 'POST' as const,
        url: '/api/admin/mass-email',
        payload: {
          subject: 'Escaped',
          body_html: '<p>Hello</p>',
          body_text: 'Hello',
          audience: { scope: 'explicit', user_ids: userIds },
        },
      });

      // Both together: about 45 KB of HTML for the quoted name and 10 KB of
      // text for the plain one, per copy. Sized from the plain name alone it
      // was about 20 KB a copy, and the pair fit under 60 000.
      const refused = await harness.authed(admin, campaign([quoted.user.id, plain.user.id]));
      assert.equal(refused.statusCode, 429, refused.body);
      const details = errorBody(refused.body).details as { message_bytes: number; bytes: number };
      assert.ok(details.message_bytes > 50_000, `escaping counted: ${details.message_bytes}`);
      assert.equal(details.bytes, details.message_bytes * 2);

      // Each alone fits, and what each actually queued is within the bound
      // the pair was refused on.
      for (const recipient of [quoted, plain]) {
        const sent = await harness.authed(admin, campaign([recipient.user.id]));
        assert.equal(sent.statusCode, 200, sent.body);
        const rows = (await harness.outbox()).filter(
          (row) =>
            row.to_email === recipient.user.email && row.idempotency_key?.startsWith('mass:'),
        );
        assert.equal(rows.length, 1);
        const row = rows[0];
        assert.ok(row);
        assert.ok(
          rowBytes(row) <= details.message_bytes,
          `${recipient.user.email} queued ${rowBytes(row)} bytes, over the ` +
            `${details.message_bytes} estimated`,
        );
      }
    } finally {
      await harness.close();
    }
  });

  it('refuses a message too large for a fan-out transaction of its own', async () => {
    const harness = await buildTestApp({
      env: { NEXUS_MAX_MASS_EMAIL_BYTES: '0' },
      deps: { startOutboxWorker: false },
    });
    try {
      const admin = await harness.registerUser({ email: 'oversize-admin@example.test' });
      const template = await harness.authed(admin, {
        method: 'PUT',
        url: '/api/admin/email-templates/mass',
        payload: {
          subject: '{{subject}}',
          body_html: '{{body_html}}'.repeat(50),
          body_text: '{{body_text}}',
        },
      });
      assert.equal(template.statusCode, 200, template.body);
      const outboxBefore = (await harness.outbox()).length;
      const auditBefore = (await harness.auditRows('admin.mass_email')).length;

      // 100 000 characters, repeated 50 times by the template: about 5 MB in
      // one copy, past the 4 MiB a chunk transaction holds, with no aggregate
      // ceiling to stop it first.
      const refused = await harness.authed(admin, {
        method: 'POST',
        url: '/api/admin/mass-email',
        payload: {
          subject: 'Oversized',
          body_html: 'z'.repeat(100_000),
          body_text: 'Oversized',
          audience: { scope: 'all' },
        },
      });
      assert.equal(refused.statusCode, 400, refused.body);
      assert.equal(errorBody(refused.body).code, 'VALIDATION_FAILED');
      assert.equal((await harness.outbox()).length, outboxBefore, 'nothing was queued');
      assert.equal((await harness.auditRows('admin.mass_email')).length, auditBefore);
    } finally {
      await harness.close();
    }
  });
});

/**
 * The campaign budget — `NEXUS_MAX_MASS_EMAILS_PER_DAY`.
 *
 * The per-campaign ceilings bound one campaign; this bounds a loop of them.
 * It counts the administrator's own `admin.mass_email` rows, one per campaign,
 * written before anything is queued — so a retry of the same campaign is free
 * and a refused one costs nothing.
 */
describe('mass email daily campaign budget', () => {
  it('refuses a campaign past the daily count but not a retry of a started one', async () => {
    const harness = await buildTestApp({
      env: { NEXUS_MAX_MASS_EMAILS_PER_DAY: '2' },
      deps: { startOutboxWorker: false },
    });
    try {
      const admin = await harness.registerUser({ email: 'budget-admin@example.test' });
      const other = await harness.registerUser({ email: 'budget-other@example.test' });
      await harness.registerUser({ email: 'budget-client@example.test', role: 'client' });
      const promoted = await harness.authed(admin, {
        method: 'PATCH',
        url: `/api/users/${other.user.id}`,
        payload: { role: 'admin' },
      });
      assert.equal(promoted.statusCode, 200, promoted.body);
      const otherAdmin = await harness.loginUser('budget-other@example.test');

      const send = (session: TestSession, key: string) =>
        harness.authed(session, {
          method: 'POST',
          url: '/api/admin/mass-email',
          payload: {
            subject: `Campaign ${key}`,
            body_text: 'Hello',
            audience: { scope: 'filtered', roles: ['client'] },
            idempotency_key: key,
          },
        });

      assert.equal((await send(admin, 'budget-one')).statusCode, 200);
      assert.equal((await send(admin, 'budget-two')).statusCode, 200);
      // A retry of a campaign already started is the same campaign.
      const retry = await send(admin, 'budget-two');
      assert.equal(retry.statusCode, 200, retry.body);
      assert.equal(retry.json<MassEmailResponse>().enqueued, 0);

      const outboxBefore = (await harness.outbox()).length;
      const auditBefore = (await harness.auditRows('admin.mass_email')).length;
      const refused = await send(admin, 'budget-three');
      assert.equal(refused.statusCode, 429, refused.body);
      const failure = errorBody(refused.body);
      assert.equal(failure.code, 'QUOTA_EXCEEDED');
      assert.deepEqual(failure.details, {
        limit: 2,
        used: 2,
        recipients: 1,
        window: '24h',
        setting: 'NEXUS_MAX_MASS_EMAILS_PER_DAY',
      });
      assert.equal((await harness.outbox()).length, outboxBefore, 'nothing was queued');
      assert.equal(
        (await harness.auditRows('admin.mass_email')).length,
        auditBefore,
        'a refused campaign writes no row of its own',
      );

      // The budget is per administrator.
      const theirs = await send(otherAdmin, 'budget-other-one');
      assert.equal(theirs.statusCode, 200, theirs.body);
    } finally {
      await harness.close();
    }
  });

  it('refuses a reused key with other content or audience, and charges nothing', async () => {
    const harness = await buildTestApp({
      env: { NEXUS_MAX_MASS_EMAILS_PER_DAY: '2' },
      deps: { startOutboxWorker: false },
    });
    try {
      const admin = await harness.registerUser({ email: 'reuse-admin@example.test' });
      const first = await harness.registerUser({ email: 'reuse-first@example.test' });
      const second = await harness.registerUser({ email: 'reuse-second@example.test' });
      const campaign = {
        subject: 'Campaign A',
        body_html: '<p>Hello</p>',
        body_text: 'Hello',
        audience: { scope: 'explicit', user_ids: [first.user.id] },
        idempotency_key: 'reused-key',
      };
      const send = (payload: Record<string, unknown>) =>
        harness.authed(admin, { method: 'POST', url: '/api/admin/mass-email', payload });

      const sent = await send(campaign);
      assert.equal(sent.statusCode, 200, sent.body);
      assert.equal(sent.json<MassEmailResponse>().enqueued, 1);

      const outboxBefore = (await harness.outbox()).length;
      const auditBefore = (await harness.auditRows('admin.mass_email')).length;
      // The bypass: the same key with a new message, or a new audience, used to
      // be an uncharged campaign of its own.
      for (const variant of [
        { ...campaign, subject: 'Campaign B' },
        { ...campaign, body_html: '<p>Something else</p>' },
        { ...campaign, body_text: 'Something else' },
        { ...campaign, audience: { scope: 'explicit', user_ids: [second.user.id] } },
        { ...campaign, audience: { scope: 'all' } },
      ]) {
        const refused = await send(variant);
        assert.equal(refused.statusCode, 409, refused.body);
        const failure = errorBody(refused.body);
        assert.equal(failure.code, 'CONFLICT');
        assert.deepEqual(failure.details, {
          batch_id: 'reused-key',
          reason: 'idempotency_key_reused',
        });
      }
      assert.equal((await harness.outbox()).length, outboxBefore, 'nothing was queued');
      assert.equal(
        (await harness.auditRows('admin.mass_email')).length,
        auditBefore,
        'and nothing was recorded or charged',
      );
      assert.equal(
        (await harness.outbox()).filter((row) => row.to_email === second.user.email).length,
        0,
      );

      // A genuine retry still is one, however its audience is spelled.
      const retry = await send({
        ...campaign,
        audience: { scope: 'explicit', user_ids: [first.user.id, first.user.id] },
      });
      assert.equal(retry.statusCode, 200, retry.body);
      assert.equal(retry.json<MassEmailResponse>().enqueued, 0);

      // The refusals spent no slot: the second of two still goes through.
      const next = await send({ ...campaign, subject: 'Campaign C', idempotency_key: 'next-key' });
      assert.equal(next.statusCode, 200, next.body);
    } finally {
      await harness.close();
    }
  });

  it('refuses an audience that resolves to nobody without charging it', async () => {
    const harness = await buildTestApp({
      env: { NEXUS_MAX_MASS_EMAILS_PER_DAY: '1' },
      deps: { startOutboxWorker: false },
    });
    try {
      const admin = await harness.registerUser({ email: 'nobody-admin@example.test' });
      await harness.registerUser({ email: 'nobody-client@example.test', role: 'client' });
      const send = (roles: string[]) =>
        harness.authed(admin, {
          method: 'POST',
          url: '/api/admin/mass-email',
          payload: {
            subject: 'Providers only',
            body_text: 'Hello',
            audience: { scope: 'filtered', roles },
          },
        });

      const refused = await send(['provider']);
      assert.equal(refused.statusCode, 400, refused.body);
      assert.equal(errorBody(refused.body).code, 'VALIDATION_FAILED');
      assert.equal((await harness.auditRows('admin.mass_email')).length, 0);

      // The one slot is still there.
      const sent = await send(['client']);
      assert.equal(sent.statusCode, 200, sent.body);
      assert.equal(sent.json<MassEmailResponse>().enqueued, 1);
    } finally {
      await harness.close();
    }
  });

  it('treats 0 as no budget', async () => {
    const harness = await buildTestApp({
      env: { NEXUS_MAX_MASS_EMAILS_PER_DAY: '0' },
      deps: { startOutboxWorker: false },
    });
    try {
      assert.equal(harness.config.maxMassEmailsPerDay, 0);
      const admin = await harness.registerUser({ email: 'unbudgeted-admin@example.test' });
      for (const subject of ['One', 'Two', 'Three']) {
        const response = await harness.authed(admin, {
          method: 'POST',
          url: '/api/admin/mass-email',
          payload: { subject, body_text: subject, audience: { scope: 'all' } },
        });
        assert.equal(response.statusCode, 200, response.body);
      }
    } finally {
      await harness.close();
    }
  });
});

/**
 * Chunked fan-out. One transaction per campaign held every other write on the
 * instance — the password-reset and verification enqueues included — for as
 * long as the whole audience took to insert; now each transaction holds at
 * most a chunk, and other writers get their turn between chunks.
 */
describe('mass email chunked fan-out', () => {
  it('queues a campaign in transactions of at most one chunk each', async (t) => {
    const harness = await buildTestApp({
      deps: { startOutboxWorker: false, massEmailChunkRecipients: 2 },
    });
    try {
      const admin = await harness.registerUser({ email: 'chunk-admin@example.test' });
      for (const index of [1, 2, 3, 4]) {
        await harness.registerUser({ email: `chunk-client-${index}@example.test`, role: 'client' });
      }
      const recipients = await harness.store.users.listRecipients({ status: 'active' });
      interface TransactionObservation {
        emails: string[];
        fences: { id: string; email: string }[];
        committed: boolean;
      }
      const context = new AsyncLocalStorage<TransactionObservation>();
      const observations: TransactionObservation[] = [];
      const events: string[] = [];
      const transact = harness.store.transaction.bind(harness.store);
      // Register the continuation outside the store's transaction context too:
      // clearing only this test's AsyncLocalStorage would still join SQLite's
      // active transaction and falsely call that an independent writer.
      let startIndependent!: () => void;
      let writerStarted = false;
      const independent = new Promise<void>((resolve) => {
        startIndependent = resolve;
      }).then(() =>
        transact(async (tx) => {
          await tx.settings.set('chunk-writer', 'ran');
          events.push('independent-writer');
        }),
      );
      const transactions = t.mock.method(
        harness.store,
        'transaction',
        async <T>(
          body: (tx: NexusStore) => Promise<T>,
          options?: TransactionOptions,
        ): Promise<T> => {
          // Nested recipient fencing joins the current transaction. Observe
          // committed outer bodies, rather than counting wrapper invocations.
          if (context.getStore()) return transact(body, options);
          const observation: TransactionObservation = { emails: [], fences: [], committed: false };
          observations.push(observation);
          const result = await transact((tx) => context.run(observation, () => body(tx)), options);
          observation.committed = true;
          return result;
        },
      );
      const enqueue = harness.store.emailOutbox.enqueue.bind(harness.store.emailOutbox);
      const observeEnqueue: typeof enqueue = async (input) => {
        const transaction = context.getStore();
        assert.ok(transaction, 'fan-out inserts belong to a transaction');
        transaction.emails.push(input.to_email);
        events.push(`enqueue:${input.to_email}`);
        const started = await harness.store.auditLogs.count({
          action: 'admin.mass_email',
          target_id: 'chunked-five',
        });
        assert.equal(started, 1, 'the campaign was charged before its first recipient');
        if (!writerStarted) {
          // Queue a writer from an unrelated context while the first chunk is
          // open. It must get its turn before the next fan-out transaction.
          writerStarted = true;
          startIndependent();
        }
        return enqueue(input);
      };
      const enqueues = t.mock.method(harness.store.emailOutbox, 'enqueue', observeEnqueue);
      const lockRecipient = harness.store.users.lockEmailRecipient.bind(harness.store.users);
      const observeFence: typeof lockRecipient = async (id, email) => {
        const transaction = context.getStore();
        assert.ok(transaction, 'the recipient fence shares the insert transaction');
        transaction.fences.push({ id, email });
        return lockRecipient(id, email);
      };
      const fences = t.mock.method(harness.store.users, 'lockEmailRecipient', observeFence);
      const response = await harness.authed(admin, {
        method: 'POST',
        url: '/api/admin/mass-email',
        payload: {
          subject: 'Chunked',
          body_text: 'Five recipients, two per transaction',
          audience: { scope: 'all' },
          idempotency_key: 'chunked-five',
        },
      });
      startIndependent();
      await independent;
      fences.mock.restore();
      enqueues.mock.restore();
      transactions.mock.restore();
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json<MassEmailResponse>(), {
        enqueued: 5,
        recipients: 5,
        batch_id: 'chunked-five',
      });
      const fanOut = observations.filter((transaction) => transaction.emails.length > 0);
      assert.ok(fanOut.length > 1, 'the audience spans several committed transactions');
      for (const transaction of fanOut) {
        assert.equal(transaction.committed, true);
        assert.ok(transaction.emails.length <= 2, 'one transaction never exceeds one chunk');
        assert.deepEqual(
          transaction.fences.map((fence) => fence.email),
          transaction.emails,
          'each recipient gets its own address fence inside the chunk',
        );
      }
      const byId = (a: { id: string }, b: { id: string }): number => a.id.localeCompare(b.id);
      const observedRecipients = fanOut.flatMap((transaction) => transaction.fences);
      assert.deepEqual(
        observedRecipients.sort(byId),
        recipients.map(({ id, email }) => ({ id, email })).sort(byId),
      );
      const turn = events.indexOf('independent-writer');
      assert.ok(turn > 0, 'another writer ran after fan-out began');
      assert.ok(turn < events.length - 1, 'another writer ran before fan-out finished');
      const outcome = (await harness.auditRows('admin.mass_email_complete'))[0];
      assert.equal(outcome?.details.chunks, fanOut.length);
      assert.equal(outcome?.details.enqueued, 5);
    } finally {
      await harness.close();
    }
  });
});
