/**
 * The god-mode broadcast's relationship with the messaging budget — issue #156.
 *
 * The control used to have its sign backwards. A broadcast writes one `messages`
 * row **per recipient** with the acting super admin as the sender, and was never
 * budget-checked at all; the rolling daily budget then counted exactly those
 * rows against that administrator. So the operation that costs hundreds of rows
 * was unbounded, and the rows it wrote disabled the one that costs one:
 *
 * ```
 * 1:1 message before broadcast : 201
 * broadcast                    : 200      ← not budget-checked
 * 1:1 message after broadcast  : 429 QUOTA_EXCEEDED
 * second broadcast             : 200      ← still allowed
 * ```
 *
 * Both halves are fixed here: broadcast rows are marked and excluded from the
 * sender's budget, and the broadcast path carries two ceilings of its own,
 * enforced before a single row is written.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type { ApiErrorBody, GodBroadcastResponse } from '@ferrum-nexus/shared';

import type { MessageRecord } from '../db/store.js';
import { buildTestApp, type TestApp, type TestSession } from './helpers.js';

function errorBody(body: string): ApiErrorBody['error'] {
  return (JSON.parse(body) as ApiErrorBody).error;
}

describe('a broadcast does not spend the sender’s message budget', () => {
  let harness: TestApp;
  let founder: TestSession;

  before(async () => {
    harness = await buildTestApp({
      // Small enough that one broadcast to this portal would exhaust it — the
      // production shape at 251 accounts against the shipped limit of 200.
      env: { NEXUS_MAX_MESSAGES_PER_USER_PER_DAY: '5' },
      deps: { startOutboxWorker: false },
    });
    founder = await harness.registerUser({ email: 'broadcast-founder@example.test' });
    for (const index of [1, 2, 3, 4, 5, 6, 7]) {
      await harness.registerUser({ email: `broadcast-member-${index}@example.test` });
    }
    assert.equal(founder.user.role, 'super_admin');
  });

  after(async () => {
    await harness.close();
  });

  it('leaves the admin’s ordinary messaging working after broadcasting', async () => {
    const first = await harness.authed(founder, {
      method: 'POST',
      url: '/api/threads',
      payload: { subject: 'Before', body: 'An ordinary message' },
    });
    assert.equal(first.statusCode, 201, first.body);

    const broadcast = await harness.authed(founder, {
      method: 'POST',
      url: '/api/admin/god/broadcast',
      payload: {
        subject: 'Scheduled maintenance',
        body: 'The gateway restarts at 02:00 UTC.',
        audience: { scope: 'all' },
      },
    });
    assert.equal(broadcast.statusCode, 200, broadcast.body);
    // Seven recipients, seven message rows — more than the whole budget.
    const sent = broadcast.json<GodBroadcastResponse>();
    assert.equal(sent.notified, 7);
    assert.equal(sent.delivered, 7);
    assert.equal(sent.failed, 0);

    const later = await harness.authed(founder, {
      method: 'POST',
      url: '/api/threads',
      payload: { subject: 'After', body: 'The support follow-up' },
    });
    assert.equal(later.statusCode, 201, `the broadcast rows are not the admin's: ${later.body}`);
  });

  it('marks the rows it wrote and keeps them out of the budget count', async () => {
    const since = new Date(0).toISOString();
    const counted = await harness.store.messages.countBySenderSince(founder.user.id, since);
    assert.equal(counted, 2, 'only the two 1:1 messages count');

    const threads = await harness.store.threads.list({}, { limit: 100 });
    const rows: MessageRecord[] = [];
    for (const thread of threads.items) {
      const page = await harness.store.messages.listByThread(thread.id, { limit: 100 });
      rows.push(...page.items);
    }
    const flagged = rows.filter((row) => row.broadcast);
    assert.equal(flagged.length, 7, 'one flagged row per broadcast recipient');
    assert.ok(
      flagged.every((row) => row.sender_user_id === founder.user.id),
      'the sender is still the administrator, so the trail names who broadcast',
    );
    assert.ok(
      rows.every((row) => typeof row.broadcast === 'boolean'),
      'every adapter answers a real boolean, never an undefined field',
    );
  });

  it('still bounds ordinary messaging exactly as before', async () => {
    // Three left of five. The fourth ordinary message is refused, and the
    // broadcast rows are not what refused it.
    for (const body of ['Three', 'Four', 'Five']) {
      const response = await harness.authed(founder, {
        method: 'POST',
        url: '/api/threads',
        payload: { subject: body, body },
      });
      assert.equal(response.statusCode, 201, response.body);
    }
    const refused = await harness.authed(founder, {
      method: 'POST',
      url: '/api/threads',
      payload: { subject: 'Six', body: 'Six' },
    });
    assert.equal(refused.statusCode, 429, refused.body);
    assert.equal(errorBody(refused.body).code, 'QUOTA_EXCEEDED');
  });
});

describe('broadcast ceilings', () => {
  it('refuses an audience larger than the recipient ceiling before writing a row', async () => {
    const harness = await buildTestApp({
      env: { NEXUS_MAX_BROADCAST_RECIPIENTS: '2' },
      deps: { startOutboxWorker: false },
    });
    try {
      const founder = await harness.registerUser({ email: 'ceiling-founder@example.test' });
      const members: string[] = [];
      for (const index of [1, 2, 3]) {
        const member = await harness.registerUser({
          email: `ceiling-member-${index}@example.test`,
        });
        members.push(member.user.id);
      }
      const threadsBefore = (await harness.store.threads.list({}, { limit: 50 })).total;
      const auditBefore = (await harness.auditRows('god.broadcast')).length;

      const refused = await harness.authed(founder, {
        method: 'POST',
        url: '/api/admin/god/broadcast',
        payload: {
          subject: 'Too many',
          body: 'Three recipients against a ceiling of two.',
          audience: { scope: 'all' },
        },
      });
      assert.equal(refused.statusCode, 429, refused.body);
      const failure = errorBody(refused.body);
      assert.equal(failure.code, 'QUOTA_EXCEEDED');
      assert.deepEqual(failure.details, {
        limit: 2,
        recipients: 3,
        setting: 'NEXUS_MAX_BROADCAST_RECIPIENTS',
      });
      assert.ok(failure.message.includes('3'), 'the message names the audience size');
      assert.ok(failure.message.includes('2'), 'and the limit');

      assert.equal((await harness.store.threads.list({}, { limit: 50 })).total, threadsBefore);
      assert.equal((await harness.auditRows('god.broadcast')).length, auditBefore);

      // A narrower audience still goes out, which is the point of naming the
      // size in the refusal.
      const allowed = await harness.authed(founder, {
        method: 'POST',
        url: '/api/admin/god/broadcast',
        payload: {
          subject: 'Few enough',
          body: 'Two recipients against a ceiling of two.',
          audience: { scope: 'explicit', user_ids: members.slice(0, 2) },
        },
      });
      assert.equal(allowed.statusCode, 200, allowed.body);
    } finally {
      await harness.close();
    }
  });

  it('refuses a broadcast past the daily count and names the setting', async () => {
    const harness = await buildTestApp({
      env: { NEXUS_MAX_BROADCASTS_PER_DAY: '2' },
      deps: { startOutboxWorker: false },
    });
    try {
      const founder = await harness.registerUser({ email: 'daily-founder@example.test' });
      await harness.registerUser({ email: 'daily-member@example.test' });

      const send = (subject: string) =>
        harness.authed(founder, {
          method: 'POST',
          url: '/api/admin/god/broadcast',
          payload: { subject, body: 'Announcement', audience: { scope: 'all' } },
        });

      assert.equal((await send('One')).statusCode, 200);
      assert.equal((await send('Two')).statusCode, 200);

      const auditBefore = (await harness.auditRows('god.broadcast')).length;
      const refused = await send('Three');
      assert.equal(refused.statusCode, 429, refused.body);
      const failure = errorBody(refused.body);
      assert.equal(failure.code, 'QUOTA_EXCEEDED');
      assert.deepEqual(failure.details, {
        limit: 2,
        used: 2,
        recipients: 1,
        window: '24h',
        setting: 'NEXUS_MAX_BROADCASTS_PER_DAY',
      });
      assert.equal(
        (await harness.auditRows('god.broadcast')).length,
        auditBefore,
        'a refused broadcast writes no audit row of its own',
      );
    } finally {
      await harness.close();
    }
  });

  it('treats 0 as no ceiling on either bound', async () => {
    const harness = await buildTestApp({
      env: { NEXUS_MAX_BROADCAST_RECIPIENTS: '0', NEXUS_MAX_BROADCASTS_PER_DAY: '0' },
      deps: { startOutboxWorker: false },
    });
    try {
      assert.equal(harness.config.maxBroadcastRecipients, 0);
      assert.equal(harness.config.maxBroadcastsPerDay, 0);
      const founder = await harness.registerUser({ email: 'uncapped-founder@example.test' });
      await harness.registerUser({ email: 'uncapped-member@example.test' });

      for (const subject of ['One', 'Two', 'Three', 'Four']) {
        const response = await harness.authed(founder, {
          method: 'POST',
          url: '/api/admin/god/broadcast',
          payload: { subject, body: 'Announcement', audience: { scope: 'all' } },
        });
        assert.equal(response.statusCode, 200, response.body);
      }
    } finally {
      await harness.close();
    }
  });

  it('ships the documented defaults', async () => {
    const harness = await buildTestApp({ deps: { startOutboxWorker: false } });
    try {
      assert.equal(harness.config.maxBroadcastRecipients, 5_000);
      assert.equal(harness.config.maxBroadcastsPerDay, 20);
      // The mass-email fan-out is one transaction too, and needs the same
      // ceiling for the same reason — see `mass-email.test.ts`.
      assert.equal(harness.config.maxMassEmailRecipients, 5_000);
    } finally {
      await harness.close();
    }
  });
});
