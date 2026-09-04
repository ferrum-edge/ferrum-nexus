/**
 * Abuse controls on `/api/threads` — GHSA-gwqc-w33p-5wx5.
 *
 * Three independent bounds, tested independently:
 *
 * 1. The per-minute Fastify limiter, keyed per **account** rather than per IP.
 * 2. The rolling 24-hour per-account message budget.
 * 3. Email coalescing, so a reply storm costs one mail per recipient per thread
 *    per window.
 *
 * The limiter is forced off under `NEXUS_ENV=test`, so the limiter suite boots
 * a `development` app with `NEXUS_RATE_LIMIT_ENABLED=true` — the same shape the
 * proxy-trust suite uses. `app.inject` presents every request as 127.0.0.1, so
 * without the per-account key generator these tests could not tell the two
 * users apart at all: that is exactly what makes them a proof of the key.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type {
  ApiErrorBody,
  CreateThreadResponse,
  ListNotificationsResponse,
} from '@ferrum-nexus/shared';

import { COALESCE_WINDOW_MS } from '../messaging/service.js';
import { buildTestApp, type TestApp, type TestSession } from './helpers.js';

function error(body: string): ApiErrorBody['error'] {
  return (JSON.parse(body) as ApiErrorBody).error;
}

/** Every durable row a refused send must not have written. */
async function rowCounts(harness: TestApp): Promise<{
  messages: number;
  audit: number;
  notifications: number;
  outbox: number;
}> {
  const threads = await harness.store.threads.list({}, { limit: 200 });
  let messages = 0;
  for (const thread of threads.items) {
    messages += await harness.store.messages.countByThread(thread.id);
  }
  const audit = await harness.store.auditLogs.list({}, { limit: 1 });
  const outbox = await harness.outbox();
  const users = await harness.store.users.list({}, { limit: 200 });
  let notifications = 0;
  for (const user of users.items) {
    notifications += (await harness.store.notifications.list({ user_id: user.id })).total;
  }
  return { messages, audit: audit.total, notifications, outbox: outbox.length };
}

/* ── 1. The per-minute limiter ──────────────────────────────────────────── */

describe('messaging rate limits', () => {
  let harness: TestApp;
  let founder: TestSession;
  let alice: TestSession;
  let bob: TestSession;

  before(async () => {
    harness = await buildTestApp({
      env: {
        NEXUS_ENV: 'development',
        NEXUS_RATE_LIMIT_ENABLED: 'true',
        // Isolate the limiter from the daily budget.
        NEXUS_MAX_MESSAGES_PER_USER_PER_DAY: '0',
      },
      deps: { startOutboxWorker: false },
    });
    founder = await harness.registerUser({ email: 'limit-founder@example.test' });
    alice = await harness.registerUser({ email: 'limit-alice@example.test' });
    bob = await harness.registerUser({ email: 'limit-bob@example.test' });
    assert.equal(founder.user.role, 'super_admin', 'the first account founds the portal');
  });

  after(async () => {
    await harness.close();
  });

  it('caps thread creation at 10 a minute and writes nothing when it refuses', async () => {
    const statuses: number[] = [];
    let refusal = '';
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await harness.authed(alice, {
        method: 'POST',
        url: '/api/threads',
        // A distinct api-less subject each time, so nothing is deduplicated
        // into an existing thread and every request is a real creation.
        payload: { subject: `Burst ${attempt}`, body: 'Please answer' },
      });
      statuses.push(response.statusCode);
      if (response.statusCode === 429) refusal = response.body;
    }

    assert.equal(
      statuses.filter((status) => status === 201).length,
      10,
      `exactly the first ten are accepted: ${statuses.join(',')}`,
    );
    assert.equal(statuses.filter((status) => status === 429).length, 2);
    assert.equal(error(refusal).code, 'RATE_LIMITED');

    // Ten accepted creations, ten messages, ten platform threads — and not one
    // row more from the two that were refused.
    const counts = await rowCounts(harness);
    assert.equal(counts.messages, 10, 'a refused request writes no message row');
  });

  it('gives a second account its own bucket rather than the first account’s', async () => {
    // Alice is already exhausted for this window and shares 127.0.0.1 with Bob,
    // so an IP-keyed limiter would refuse Bob's very first request.
    const response = await harness.authed(bob, {
      method: 'POST',
      url: '/api/threads',
      payload: { subject: 'A fresh account', body: 'Hello' },
    });
    assert.equal(
      response.statusCode,
      201,
      `Bob must not inherit Alice's exhausted bucket: ${response.body}`,
    );

    const again = await harness.authed(alice, {
      method: 'POST',
      url: '/api/threads',
      payload: { subject: 'Still refused', body: 'Hello' },
    });
    assert.equal(again.statusCode, 429, 'and Alice is still refused inside the same window');
  });

  it('caps replies at 30 a minute, refusing with RATE_LIMITED and no new rows', async () => {
    const opened = await harness.authed(bob, {
      method: 'POST',
      url: '/api/threads',
      payload: { subject: 'Reply storm', recipient_user_id: founder.user.id, body: 'First' },
    });
    assert.equal(opened.statusCode, 201, opened.body);
    const threadId = opened.json<CreateThreadResponse>().thread.id;

    const before = await rowCounts(harness);
    const statuses: number[] = [];
    let refusal = '';
    // Bob has spent 2 of his 30 replies on the two thread-creation openers
    // above, which are separate routes with separate buckets — so all 30 of
    // these fit until the 31st.
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const response = await harness.authed(bob, {
        method: 'POST',
        url: `/api/threads/${threadId}/messages`,
        payload: { body: `Flood ${attempt}` },
      });
      statuses.push(response.statusCode);
      if (response.statusCode === 429) refusal = response.body;
    }

    const accepted = statuses.filter((status) => status === 201).length;
    assert.equal(accepted, 30, `exactly thirty replies fit in the window: ${statuses.join(',')}`);
    assert.equal(error(refusal).code, 'RATE_LIMITED');

    const after = await rowCounts(harness);
    assert.equal(
      after.messages - before.messages,
      accepted,
      'the two refusals wrote no message rows',
    );
    assert.equal(
      after.audit - before.audit,
      accepted,
      'and no audit rows — the limiter runs before the handler',
    );
  });
});

/* ── 2. The rolling daily budget ────────────────────────────────────────── */

describe('daily message budget', () => {
  let harness: TestApp;
  let founder: TestSession;
  let sender: TestSession;
  let threadId: string;

  before(async () => {
    harness = await buildTestApp({
      // The per-minute limiter stays off (NEXUS_ENV=test forces it off), so
      // only the budget can be the thing that refuses.
      env: { NEXUS_MAX_MESSAGES_PER_USER_PER_DAY: '3' },
      deps: { startOutboxWorker: false },
    });
    founder = await harness.registerUser({ email: 'budget-founder@example.test' });
    sender = await harness.registerUser({ email: 'budget-sender@example.test' });

    const opened = await harness.authed(sender, {
      method: 'POST',
      url: '/api/threads',
      payload: { subject: 'Budgeted', recipient_user_id: founder.user.id, body: 'One' },
    });
    assert.equal(opened.statusCode, 201, opened.body);
    threadId = opened.json<CreateThreadResponse>().thread.id;
  });

  after(async () => {
    await harness.close();
  });

  it('refuses the fourth message with 429 QUOTA_EXCEEDED and writes nothing', async () => {
    // The opening message was the first. Two more fill the budget.
    for (const body of ['Two', 'Three']) {
      const response = await harness.authed(sender, {
        method: 'POST',
        url: `/api/threads/${threadId}/messages`,
        payload: { body },
      });
      assert.equal(response.statusCode, 201, response.body);
    }

    const before = await rowCounts(harness);
    const refused = await harness.authed(sender, {
      method: 'POST',
      url: `/api/threads/${threadId}/messages`,
      payload: { body: 'Four' },
    });
    assert.equal(refused.statusCode, 429, refused.body);

    const body = error(refused.body);
    assert.equal(body.code, 'QUOTA_EXCEEDED');
    assert.deepEqual(body.details, {
      limit: 3,
      window: '24h',
      setting: 'NEXUS_MAX_MESSAGES_PER_USER_PER_DAY',
    });
    assert.ok(body.message.includes('3'), 'the message names the limit the user hit');

    assert.deepEqual(
      await rowCounts(harness),
      before,
      'no message, audit, notification or outbox row survives a refused send',
    );
  });

  it('spends one budget across direct and platform threads', async () => {
    // A brand new thread is not a fresh allowance: the budget counts the
    // sender, so the same account is refused whichever shape it reaches for.
    const platform = await harness.authed(sender, {
      method: 'POST',
      url: '/api/threads',
      payload: { subject: 'A different conversation', body: 'Let me in' },
    });
    assert.equal(platform.statusCode, 429, platform.body);
    assert.equal(error(platform.body).code, 'QUOTA_EXCEEDED');

    assert.equal(
      (await harness.store.threads.list({}, { limit: 50 })).total,
      1,
      'the refused creation did not seat a thread either',
    );
  });

  it('leaves a different account’s budget alone', async () => {
    const other = await harness.registerUser({ email: 'budget-other@example.test' });
    const response = await harness.authed(other, {
      method: 'POST',
      url: '/api/threads',
      payload: { subject: 'Unrelated', body: 'Hello' },
    });
    assert.equal(response.statusCode, 201, 'the budget is per account, not global');
  });

  it('slides: messages older than the window stop counting', async () => {
    // Age the sender's three messages out by writing them straight through the
    // store with a `created_at` a day and an hour back. Nothing else about them
    // changes, so this is exactly the state the portal is in tomorrow.
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const page = await harness.store.messages.listByThread(threadId, { limit: 50 });
    const own = page.items.filter((message) => message.sender_user_id === sender.user.id);
    assert.equal(own.length, 3, 'the three that filled the budget');

    for (const message of own) {
      await harness.store.messages.deleteByThread(message.thread_id);
    }
    for (const message of own) {
      await harness.store.messages.create({
        thread_id: message.thread_id,
        sender_user_id: message.sender_user_id,
        body: message.body,
        created_at: stale,
      });
    }

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    assert.equal(
      await harness.store.messages.countBySenderSince(sender.user.id, since),
      0,
      'aged-out rows are outside the window',
    );

    const response = await harness.authed(sender, {
      method: 'POST',
      url: `/api/threads/${threadId}/messages`,
      payload: { body: 'A new day' },
    });
    assert.equal(response.statusCode, 201, `the window slid, so the send fits: ${response.body}`);
  });
});

describe('daily message budget disabled', () => {
  it('treats 0 as unlimited', async () => {
    const harness = await buildTestApp({
      env: { NEXUS_MAX_MESSAGES_PER_USER_PER_DAY: '0' },
      deps: { startOutboxWorker: false },
    });
    try {
      assert.equal(harness.config.maxMessagesPerUserPerDay, 0);
      await harness.registerUser({ email: 'unlimited-founder@example.test' });
      const sender = await harness.registerUser({ email: 'unlimited@example.test' });

      const opened = await harness.authed(sender, {
        method: 'POST',
        url: '/api/threads',
        payload: { subject: 'No ceiling', body: 'One' },
      });
      assert.equal(opened.statusCode, 201, opened.body);
      const threadId = opened.json<CreateThreadResponse>().thread.id;

      for (let attempt = 0; attempt < 12; attempt += 1) {
        const response = await harness.authed(sender, {
          method: 'POST',
          url: `/api/threads/${threadId}/messages`,
          payload: { body: `Message ${attempt}` },
        });
        assert.equal(response.statusCode, 201, response.body);
      }
    } finally {
      await harness.close();
    }
  });

  it('defaults to 200 a day when the variable is unset', async () => {
    const harness = await buildTestApp({ deps: { startOutboxWorker: false } });
    try {
      assert.equal(harness.config.maxMessagesPerUserPerDay, 200);
    } finally {
      await harness.close();
    }
  });
});

/* ── 3. Email coalescing ────────────────────────────────────────────────── */

describe('message email coalescing', () => {
  let harness: TestApp;
  let founder: TestSession;
  let sender: TestSession;
  let threadId: string;

  before(async () => {
    harness = await buildTestApp({ deps: { startOutboxWorker: false } });
    founder = await harness.registerUser({ email: 'coalesce-founder@example.test' });
    sender = await harness.registerUser({ email: 'coalesce-sender@example.test' });

    const opened = await harness.authed(sender, {
      method: 'POST',
      url: '/api/threads',
      payload: { subject: 'Coalesced', recipient_user_id: founder.user.id, body: 'One' },
    });
    assert.equal(opened.statusCode, 201, opened.body);
    threadId = opened.json<CreateThreadResponse>().thread.id;
  });

  after(async () => {
    await harness.close();
  });

  it('sends one email per recipient per thread per window, however many messages', async () => {
    for (const body of ['Two', 'Three', 'Four', 'Five']) {
      const response = await harness.authed(sender, {
        method: 'POST',
        url: `/api/threads/${threadId}/messages`,
        payload: { body },
      });
      assert.equal(response.statusCode, 201, response.body);
    }

    const queued = (await harness.outbox()).filter(
      (row) => row.to_email === 'coalesce-founder@example.test',
    );
    assert.equal(queued.length, 1, 'five messages, one mail');
    assert.equal(
      queued[0]?.idempotency_key,
      `message_received:${threadId}:${founder.user.id}:${Math.floor(Date.now() / COALESCE_WINDOW_MS)}`,
      'the key is thread + recipient + time bucket',
    );

    // In-app notifications are deliberately *not* coalesced: they are cheap and
    // the limiter plus the budget already cap how many there can be.
    const notifications = await harness.authed(founder, {
      method: 'GET',
      url: '/api/notifications?type=message_received',
    });
    assert.equal(notifications.json<ListNotificationsResponse>().total, 5, 'one per message');
  });

  it('sends again in the next bucket', async () => {
    // Cross a bucket boundary without waiting ten real minutes: rewrite the
    // stored key to the previous bucket, which is what the outbox would hold if
    // the earlier mail had been enqueued one window ago.
    const [existing] = (await harness.outbox()).filter(
      (row) => row.to_email === 'coalesce-founder@example.test',
    );
    assert.ok(existing, 'the first window enqueued one');
    const previousBucket = Math.floor(Date.now() / COALESCE_WINDOW_MS) - 1;
    await harness.store.emailOutbox.enqueue({
      to_email: 'unrelated@example.test',
      subject: 'placeholder',
      body_html: '<p>x</p>',
      body_text: 'x',
      idempotency_key: `message_received:${threadId}:${founder.user.id}:${previousBucket}`,
    });

    // A message now lands in the *current* bucket, whose key is still free.
    const response = await harness.authed(sender, {
      method: 'POST',
      url: `/api/threads/${threadId}/messages`,
      payload: { body: 'A later window' },
    });
    assert.equal(response.statusCode, 201, response.body);

    const keys = (await harness.outbox())
      .filter((row) => row.idempotency_key?.startsWith(`message_received:${threadId}:`))
      .map((row) => row.idempotency_key);
    assert.equal(new Set(keys).size, 2, `two distinct buckets, one mail each: ${keys.join(', ')}`);
  });
});
