/**
 * Conversations and inboxes larger than one page.
 *
 * Two fixed windows used to hide data here. A thread's detail returned the
 * first `MAX_PAGE_SIZE` messages oldest-first with no continuation, so once a
 * conversation passed 200 messages a fresh reply was stored, acknowledged with
 * a 201 — and then invisible. The admin inbox read the first 200 global threads
 * and only then selected the platform ones, so a support conversation behind a
 * page of unrelated threads could not be reached at any offset.
 *
 * Both are now store predicates, which is what these tests pin down.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { MAX_PAGE_SIZE } from '@ferrum-nexus/shared';
import type {
  ApiErrorBody,
  CreateThreadResponse,
  ListThreadMessagesResponse,
  ListThreadsResponse,
  MessageThreadDetail,
  SendMessageResponse,
} from '@ferrum-nexus/shared';

import { buildTestApp, type TestApp, type TestSession } from './helpers.js';

/** Historical messages seeded behind the one the client posts live. */
const HISTORY = MAX_PAGE_SIZE + 5;

describe('a conversation longer than one page', () => {
  let harness: TestApp;
  let provider: TestSession;
  let client: TestSession;
  let threadId: string;
  let replyId: string;
  let seeded: string[] = [];

  before(async () => {
    harness = await buildTestApp();
    await harness.registerUser({ email: 'mp-founder@example.test' });
    provider = await harness.registerUser({ email: 'mp-provider@example.test', role: 'provider' });
    client = await harness.registerUser({ email: 'mp-client@example.test', role: 'client' });

    const opened = await harness.authed(client, {
      method: 'POST',
      url: '/api/threads',
      payload: {
        subject: 'A very long conversation',
        recipient_user_id: provider.user.id,
        body: 'the opening message',
      },
    });
    assert.equal(opened.statusCode, 201, opened.body);
    threadId = opened.json<CreateThreadResponse>().thread.id;

    // History dated well outside the rolling budget window, so the live reply
    // below exercises pagination rather than the quota. Two messages share each
    // timestamp, which is what makes the id half of the cursor load-bearing.
    const base = Date.parse('2024-01-01T00:00:00.000Z');
    seeded = [];
    for (let index = 0; index < HISTORY; index += 1) {
      const message = await harness.store.messages.create({
        thread_id: threadId,
        sender_user_id: index % 2 === 0 ? provider.user.id : client.user.id,
        body: `history ${index}`,
        created_at: new Date(base + Math.floor(index / 2) * 1000).toISOString(),
      });
      seeded.push(message.id);
    }

    const reply = await harness.authed(client, {
      method: 'POST',
      url: `/api/threads/${threadId}/messages`,
      payload: { body: 'the fresh reply' },
    });
    assert.equal(reply.statusCode, 201, reply.body);
    replyId = reply.json<SendMessageResponse>().message.id;
  });

  after(async () => {
    await harness.close();
  });

  it('shows a reply posted past message 200 straight away', async () => {
    const response = await harness.authed(client, {
      method: 'GET',
      url: `/api/threads/${threadId}`,
    });
    assert.equal(response.statusCode, 200, response.body);
    const detail = response.json<MessageThreadDetail>();

    assert.equal(detail.messages.total, HISTORY + 2, 'the whole transcript is counted');
    assert.equal(
      detail.messages.items.at(-1)?.id,
      replyId,
      'the newest window ends on the message just sent',
    );
    assert.equal(detail.messages.has_more, true, 'and says there is history behind it');
    assert.equal(detail.messages.next_before, detail.messages.items[0]?.id);
    assert.ok(detail.messages.items.length <= MAX_PAGE_SIZE, 'the window stays bounded');
  });

  it('orders a window oldest-first with the id as tie-break', async () => {
    const response = await harness.authed(provider, {
      method: 'GET',
      url: `/api/threads/${threadId}?limit=50`,
    });
    const items = response.json<MessageThreadDetail>().messages.items;
    assert.equal(items.length, 50);
    for (let index = 1; index < items.length; index += 1) {
      const previous = items[index - 1];
      const current = items[index];
      assert.ok(previous && current);
      const ordered =
        previous.created_at < current.created_at ||
        (previous.created_at === current.created_at && previous.id < current.id);
      assert.ok(ordered, `messages ${index - 1} and ${index} are out of order`);
    }
  });

  it('walks the whole history backwards without gaps or repeats', async () => {
    const first = await harness.authed(client, {
      method: 'GET',
      url: `/api/threads/${threadId}?limit=25`,
    });
    const head = first.json<MessageThreadDetail>().messages;
    const seen = head.items.map((message) => message.id);
    let cursor = head.next_before;

    while (cursor) {
      const older = await harness.authed(client, {
        method: 'GET',
        url: `/api/threads/${threadId}/messages?limit=25&before=${cursor}`,
      });
      assert.equal(older.statusCode, 200, older.body);
      const window = older.json<ListThreadMessagesResponse>();
      assert.ok(window.items.length > 0, 'a window that claims more must return some');
      seen.unshift(...window.items.map((message) => message.id));
      cursor = window.next_before;
      if (seen.length > HISTORY + 10) throw new Error('paging backwards did not terminate');
    }

    assert.equal(seen.length, HISTORY + 2, 'every message is reachable');
    assert.equal(new Set(seen).size, seen.length, 'and exactly once');
    assert.equal(seen.at(-1), replyId);
    for (const id of seeded) assert.ok(seen.includes(id));
  });

  it('keeps the reply visible on a later read', async () => {
    const again = await harness.authed(client, {
      method: 'GET',
      url: `/api/threads/${threadId}`,
    });
    const items = again.json<MessageThreadDetail>().messages.items;
    assert.ok(items.some((message) => message.id === replyId));
  });

  it('refuses a cursor from another conversation', async () => {
    // A platform thread: a different conversation, and one this caller may read.
    const other = await harness.authed(client, {
      method: 'POST',
      url: '/api/threads',
      payload: { subject: 'Unrelated', body: 'hello' },
    });
    assert.equal(other.statusCode, 201, other.body);
    const foreign = other.json<CreateThreadResponse>().message.id;

    const response = await harness.authed(client, {
      method: 'GET',
      url: `/api/threads/${threadId}/messages?before=${foreign}`,
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(
      (JSON.parse(response.body) as ApiErrorBody).error.code,
      'VALIDATION_FAILED',
      'a cursor may not point outside the thread being read',
    );
  });

  it('applies the participant rule to the message window too', async () => {
    const outsider = await harness.registerUser({ email: 'mp-outsider@example.test' });
    for (const url of [`/api/threads/${threadId}`, `/api/threads/${threadId}/messages`]) {
      const response = await harness.authed(outsider, { method: 'GET', url });
      assert.equal(response.statusCode, 403, url);
    }
    const anonymous = await harness.app.inject({
      method: 'GET',
      url: `/api/threads/${threadId}/messages`,
    });
    assert.equal(anonymous.statusCode, 401);
  });
});

describe('an admin inbox behind a page of unrelated threads', () => {
  let harness: TestApp;
  let founder: TestSession;
  let provider: TestSession;
  let client: TestSession;
  let platformId: string;

  /** Every thread id `session` reaches by paging its inbox. */
  async function pageAll(session: TestSession): Promise<{ ids: string[]; total: number }> {
    const ids: string[] = [];
    let total = 0;
    for (let offset = 0; ; offset += 100) {
      const response = await harness.authed(session, {
        method: 'GET',
        url: `/api/threads?limit=100&offset=${offset}`,
      });
      assert.equal(response.statusCode, 200, response.body);
      const page = response.json<ListThreadsResponse>();
      total = page.total;
      ids.push(...page.items.map((thread) => thread.id));
      if (page.items.length < 100) break;
      if (offset > 5_000) throw new Error('thread paging did not terminate');
    }
    return { ids, total };
  }

  before(async () => {
    harness = await buildTestApp();
    founder = await harness.registerUser({ email: 'mi-founder@example.test' });
    provider = await harness.registerUser({ email: 'mi-provider@example.test', role: 'provider' });
    client = await harness.registerUser({ email: 'mi-client@example.test', role: 'client' });

    const platform = await harness.authed(client, {
      method: 'POST',
      url: '/api/threads',
      payload: { subject: 'Help please', body: 'is anyone there?' },
    });
    assert.equal(platform.statusCode, 201, platform.body);
    platformId = platform.json<CreateThreadResponse>().thread.id;

    // …then more than a full page of newer, unrelated 1:1 conversations, none
    // of which the founder sits in.
    const bystander = await harness.registerUser({ email: 'mi-bystander@example.test' });
    const now = Date.now();
    for (let index = 0; index < MAX_PAGE_SIZE + 10; index += 1) {
      await harness.store.threads.create({
        subject: `Unrelated ${index}`,
        api_id: null,
        created_by: bystander.user.id,
        participant_a: bystander.user.id,
        participant_b: provider.user.id,
        last_message_at: new Date(now + index * 1000).toISOString(),
      });
    }
  });

  after(async () => {
    await harness.close();
  });

  it('reaches the platform thread and counts only what the admin may see', async () => {
    const { ids, total } = await pageAll(founder);
    assert.ok(ids.includes(platformId), 'the platform thread is reachable');
    assert.equal(total, 1, 'unrelated 1:1 threads are not the admin inbox');
    assert.equal(ids.length, 1);
  });

  it('still shows a non-admin only their own seats', async () => {
    const asClient = await pageAll(client);
    assert.deepEqual(asClient.ids, [platformId]);
    assert.equal(asClient.total, 1);

    const asProvider = await pageAll(provider);
    assert.equal(asProvider.total, MAX_PAGE_SIZE + 10, 'the provider sits in every unrelated one');
    assert.ok(!asProvider.ids.includes(platformId), 'and in none of the platform inbox');
  });

  it('composes the subject filter with the admin rule', async () => {
    const response = await harness.authed(founder, {
      method: 'GET',
      url: '/api/threads?q=Unrelated',
    });
    assert.equal(response.json<ListThreadsResponse>().total, 0);

    const found = await harness.authed(founder, {
      method: 'GET',
      url: '/api/threads?q=Help',
    });
    const page = found.json<ListThreadsResponse>();
    assert.equal(page.total, 1);
    assert.equal(page.items[0]?.id, platformId);
  });
});
