import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type {
  ApiErrorBody,
  CreateThreadResponse,
  ListNotificationsResponse,
  ListThreadsResponse,
  MessageThreadDetail,
  SendMessageResponse,
} from '@ferrum-nexus/shared';

import { buildTestApp, type TestApp, type TestSession } from './helpers.js';

function errorCode(body: string): string {
  return (JSON.parse(body) as ApiErrorBody).error.code;
}

describe('messaging', () => {
  let harness: TestApp;
  let founder: TestSession;
  let provider: TestSession;
  let client: TestSession;
  let outsider: TestSession;
  let threadId: string;

  before(async () => {
    harness = await buildTestApp();
    founder = await harness.registerUser({ email: 'founder@example.test' });
    provider = await harness.registerUser({ email: 'provider@example.test', role: 'provider' });
    client = await harness.registerUser({ email: 'client@example.test', role: 'client' });
    outsider = await harness.registerUser({ email: 'outsider@example.test', role: 'client' });
  });

  after(async () => {
    await harness.close();
  });

  it('opens a client to provider thread and notifies the counterparty', async () => {
    const response = await harness.authed(client, {
      method: 'POST',
      url: '/api/threads',
      payload: {
        subject: 'Rate limit on the billing API',
        recipient_user_id: provider.user.id,
        body: 'Could we raise the burst limit?',
      },
    });
    assert.equal(response.statusCode, 201);
    const body = response.json<CreateThreadResponse>();
    threadId = body.thread.id;

    // The client takes seat A and the provider seat B, whoever opened it.
    assert.equal(body.thread.participant_a, client.user.id);
    assert.equal(body.thread.participant_b, provider.user.id);
    assert.equal(body.message.sender?.email, 'client@example.test');
    assert.equal(body.thread.last_message_preview, 'Could we raise the burst limit?');

    const notifications = await harness.authed(provider, {
      method: 'GET',
      url: '/api/notifications?type=message_received',
    });
    const notified = notifications.json<ListNotificationsResponse>();
    assert.equal(notified.total, 1);
    assert.equal(notified.items[0]?.link, `/messages/${threadId}`);

    const queued = (await harness.outbox()).filter(
      (row) => row.to_email === 'provider@example.test',
    );
    assert.equal(queued.length, 1);
    assert.ok(queued[0]?.subject.includes('Rate limit on the billing API'));
    // The mail announces activity and links to the thread; it deliberately does
    // not quote the body, because it is coalesced — later messages in the same
    // window send no mail at all, so a quoted transcript would be a lie.
    assert.ok(!queued[0]?.body_text.includes('Could we raise the burst limit?'));
    assert.ok(queued[0]?.body_text.includes(`/messages/${threadId}`));
  });

  it('continues the existing conversation instead of opening a duplicate', async () => {
    const response = await harness.authed(client, {
      method: 'POST',
      url: '/api/threads',
      payload: {
        subject: 'Rate limit on the billing API',
        recipient_user_id: provider.user.id,
        body: 'Following up on this.',
      },
    });
    assert.equal(response.statusCode, 201);
    assert.equal(response.json<CreateThreadResponse>().thread.id, threadId);

    const threads = await harness.authed(client, { method: 'GET', url: '/api/threads' });
    assert.equal(threads.json<ListThreadsResponse>().total, 1);
  });

  it('shows the thread with its messages to both participants', async () => {
    const response = await harness.authed(provider, {
      method: 'GET',
      url: `/api/threads/${threadId}`,
    });
    assert.equal(response.statusCode, 200);
    const detail = response.json<MessageThreadDetail>();
    assert.equal(detail.messages.items.length, 2);
    assert.equal(detail.messages.total, 2);
    assert.equal(detail.messages.has_more, false);
    assert.equal(detail.messages.next_before, null);
    assert.equal(detail.messages.items[0]?.body, 'Could we raise the burst limit?');
    assert.equal(detail.participants?.length, 2);
  });

  it('refuses a non-participant', async () => {
    const read = await harness.authed(outsider, {
      method: 'GET',
      url: `/api/threads/${threadId}`,
    });
    assert.equal(read.statusCode, 403);
    assert.equal(errorCode(read.body), 'FORBIDDEN');

    const post = await harness.authed(outsider, {
      method: 'POST',
      url: `/api/threads/${threadId}/messages`,
      payload: { body: 'Let me in' },
    });
    assert.equal(post.statusCode, 403);

    const threads = await harness.authed(outsider, { method: 'GET', url: '/api/threads' });
    assert.equal(threads.json<ListThreadsResponse>().total, 0);
  });

  it('lets the provider reply, which notifies the client', async () => {
    const response = await harness.authed(provider, {
      method: 'POST',
      url: `/api/threads/${threadId}/messages`,
      payload: { body: 'Raised it to 200 rps.' },
    });
    assert.equal(response.statusCode, 201);
    assert.equal(response.json<SendMessageResponse>().message.sender?.role, 'provider');

    const notifications = await harness.authed(client, {
      method: 'GET',
      url: '/api/notifications?type=message_received',
    });
    assert.equal(notifications.json<ListNotificationsResponse>().total, 1);

    const audit = await harness.store.auditLogs.list({ action: 'message.send' });
    assert.equal(audit.total, 3);
  });

  it('routes a thread with no recipient to the platform inbox', async () => {
    const response = await harness.authed(client, {
      method: 'POST',
      url: '/api/threads',
      payload: { subject: 'Billing question', body: 'Who do I talk to about invoices?' },
    });
    assert.equal(response.statusCode, 201);
    const platform = response.json<CreateThreadResponse>().thread;
    assert.equal(platform.participant_b, null);

    // Any admin sees the platform inbox and may answer it.
    const inbox = await harness.authed(founder, { method: 'GET', url: '/api/threads' });
    const listed = inbox.json<ListThreadsResponse>();
    assert.ok(listed.items.some((thread) => thread.id === platform.id));

    const reply = await harness.authed(founder, {
      method: 'POST',
      url: `/api/threads/${platform.id}/messages`,
      payload: { body: 'Billing is handled by finance@example.test.' },
    });
    assert.equal(reply.statusCode, 201);

    const clientNotifications = await harness.authed(client, {
      method: 'GET',
      url: '/api/notifications?type=message_received',
    });
    assert.equal(clientNotifications.json<ListNotificationsResponse>().total, 2);

    // The provider is not an admin, so the platform thread stays out of its list.
    const providerThreads = await harness.authed(provider, { method: 'GET', url: '/api/threads' });
    assert.ok(!providerThreads.json<ListThreadsResponse>().items.some((t) => t.id === platform.id));
  });

  it('rejects an empty body, an unknown recipient and self-messaging', async () => {
    const empty = await harness.authed(client, {
      method: 'POST',
      url: '/api/threads',
      payload: { subject: 'Hi', recipient_user_id: provider.user.id, body: '   ' },
    });
    assert.equal(empty.statusCode, 400);

    const unknown = await harness.authed(client, {
      method: 'POST',
      url: '/api/threads',
      payload: { subject: 'Hi', recipient_user_id: 'nobody', body: 'Hello?' },
    });
    assert.equal(unknown.statusCode, 404);

    const self = await harness.authed(client, {
      method: 'POST',
      url: '/api/threads',
      payload: { subject: 'Hi', recipient_user_id: client.user.id, body: 'Hello me' },
    });
    assert.equal(self.statusCode, 400);
  });
});

/**
 * A platform thread seats only its recipient. Whoever opened it — a god-mode
 * broadcaster — holds no seat, so their access has to come from their *current*
 * admin role and has to disappear when that role does.
 */
describe('messaging access follows the current role, not the thread’s creator', () => {
  let harness: TestApp;
  let founder: TestSession;
  let broadcaster: TestSession;
  let recipient: TestSession;
  let provider: TestSession;
  let platformThreadId: string;

  before(async () => {
    harness = await buildTestApp();
    founder = await harness.registerUser({ email: 'seat-founder@example.test' });
    recipient = await harness.registerUser({ email: 'seat-recipient@example.test' });
    provider = await harness.registerUser({
      email: 'seat-provider@example.test',
      role: 'provider',
    });
    broadcaster = await harness.registerUser({ email: 'seat-broadcaster@example.test' });
    const promoted = await harness.authed(founder, {
      method: 'PATCH',
      url: `/api/users/${broadcaster.user.id}`,
      payload: { role: 'super_admin' },
    });
    assert.equal(promoted.statusCode, 200, promoted.body);

    const broadcast = await harness.authed(broadcaster, {
      method: 'POST',
      url: '/api/admin/god/broadcast',
      payload: {
        subject: 'Maintenance window',
        body: 'The gateway is unavailable on Sunday.',
        audience: { scope: 'all' },
        reason: 'Maintenance window',
      },
    });
    assert.equal(broadcast.statusCode, 200, broadcast.body);

    const thread = await harness.store.threads.findExisting(recipient.user.id, null, null);
    assert.ok(thread, 'the broadcast opened a platform thread for the recipient');
    assert.equal(thread.created_by, broadcaster.user.id);
    assert.equal(thread.participant_a, recipient.user.id);
    assert.equal(thread.participant_b, null);
    platformThreadId = thread.id;
  });

  after(async () => {
    await harness.close();
  });

  it('lets the broadcaster into the thread while they are still an admin', async () => {
    const read = await harness.authed(broadcaster, {
      method: 'GET',
      url: `/api/threads/${platformThreadId}`,
    });
    assert.equal(read.statusCode, 200, read.body);
  });

  it('shuts the broadcaster out of every recipient’s thread once they are demoted', async () => {
    const demoted = await harness.authed(founder, {
      method: 'PATCH',
      url: `/api/users/${broadcaster.user.id}`,
      payload: { role: 'client' },
    });
    assert.equal(demoted.statusCode, 200, demoted.body);

    const read = await harness.authed(broadcaster, {
      method: 'GET',
      url: `/api/threads/${platformThreadId}`,
    });
    assert.equal(read.statusCode, 403, read.body);
    assert.equal(errorCode(read.body), 'FORBIDDEN');

    const posted = await harness.authed(broadcaster, {
      method: 'POST',
      url: `/api/threads/${platformThreadId}/messages`,
      payload: { body: 'Still here.' },
    });
    assert.equal(posted.statusCode, 403, posted.body);

    const listed = await harness.authed(broadcaster, { method: 'GET', url: '/api/threads' });
    assert.equal(
      listed.json<ListThreadsResponse>().items.some((thread) => thread.id === platformThreadId),
      false,
      'nor does it show up in their own thread list',
    );

    // The seat holder is unaffected — this is the recipient's conversation.
    const owner = await harness.authed(recipient, {
      method: 'GET',
      url: `/api/threads/${platformThreadId}`,
    });
    assert.equal(owner.statusCode, 200, owner.body);
  });

  it('leaves a 1:1 thread its creator genuinely sits in alone', async () => {
    const opened = await harness.authed(broadcaster, {
      method: 'POST',
      url: '/api/threads',
      payload: {
        subject: 'About your API',
        recipient_user_id: provider.user.id,
        body: 'Do you support webhooks?',
      },
    });
    assert.equal(opened.statusCode, 201, opened.body);
    const thread = opened.json<CreateThreadResponse>().thread;
    assert.equal(thread.created_by, broadcaster.user.id);

    const read = await harness.authed(broadcaster, {
      method: 'GET',
      url: `/api/threads/${thread.id}`,
    });
    assert.equal(read.statusCode, 200, read.body);

    const replied = await harness.authed(broadcaster, {
      method: 'POST',
      url: `/api/threads/${thread.id}/messages`,
      payload: { body: 'Any update?' },
    });
    assert.equal(replied.statusCode, 201, replied.body);

    const listed = await harness.authed(broadcaster, { method: 'GET', url: '/api/threads' });
    assert.ok(
      listed.json<ListThreadsResponse>().items.some((entry) => entry.id === thread.id),
      'a thread they actually sit in is still theirs',
    );
  });
});
