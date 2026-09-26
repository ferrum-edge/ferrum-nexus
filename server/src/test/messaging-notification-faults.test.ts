/**
 * A committed message is never reported as unsent.
 *
 * Working out who to notify of a message — `users.findById` for the other seat
 * of a direct thread or the owner of a platform thread, `users.listRecipients`
 * for the admins behind a platform thread — ran after the message and its audit
 * row had committed, outside the guard that already swallowed notification and
 * email failures. A read failure there answered `500` for a durable message,
 * and the sender's natural retry stored a second copy. These tests fail exactly
 * that read, on every path that reaches it, and require a `201` for the one
 * message that was stored.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type {
  CreateThreadResponse,
  ListThreadMessagesResponse,
  SendMessageResponse,
  Uuid,
} from '@ferrum-nexus/shared';

import type { NexusStore } from '../db/store.js';
import { buildTestApp, type TestApp, type TestSession } from './helpers.js';

/** A fault armed against one repository read. */
interface ArmedRead {
  /** Only calls whose first argument is this id count; `undefined` matches any call. */
  id?: Uuid;
  /** Matching calls to let through before the one that fails. */
  skip: number;
}

/**
 * Wrap the store so a `users` read can be failed for one id.
 *
 * `faultInjectingStore` counts every call to a method, and the session lookup
 * of the request itself reads `users.findById`, so it cannot aim at "the
 * recipient's lookup" without counting the auth path. Keying the fault on the
 * id read does: nothing else in a send reads the recipient's row.
 */
function recipientFaults(base: NexusStore): {
  store: NexusStore;
  arm(method: 'findById' | 'listRecipients', fault: ArmedRead): void;
  pending(): string[];
} {
  const armed = new Map<string, ArmedRead>();
  const users = new Proxy(base.users, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof property !== 'string' || typeof value !== 'function') return value;
      return (...args: unknown[]): unknown => {
        const fault = armed.get(property);
        if (fault && (fault.id === undefined || args[0] === fault.id)) {
          if (fault.skip === 0) {
            armed.delete(property);
            return Promise.reject(new Error(`injected ${property} failure`));
          }
          fault.skip -= 1;
        }
        return Reflect.apply(value, target, args);
      };
    },
  });
  const store = new Proxy(base, {
    get(target, property, receiver) {
      if (property === 'users') return users;
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return {
    store,
    arm: (method, fault) => armed.set(method, { ...fault }),
    pending: () => [...armed.keys()],
  };
}

describe('messaging survives a failed recipient lookup after commit', () => {
  let harness: TestApp;
  let faults: ReturnType<typeof recipientFaults>;
  const logLines: string[] = [];
  let founder: TestSession;
  let provider: TestSession;
  let client: TestSession;

  before(async () => {
    harness = await buildTestApp({
      deps: {
        startOutboxWorker: false,
        logger: {
          level: 'warn',
          stream: {
            write(line: string): void {
              logLines.push(line);
            },
          },
        },
      },
      wrapStore: (store) => {
        faults = recipientFaults(store);
        return faults.store;
      },
    });
    founder = await harness.registerUser({ email: 'lookup-founder@example.test' });
    provider = await harness.registerUser({
      email: 'lookup-provider@example.test',
      role: 'provider',
    });
    client = await harness.registerUser({ email: 'lookup-client@example.test', role: 'client' });
  });

  after(async () => {
    await harness.close();
  });

  /** Messages `reader` can see in `threadId`. */
  async function messagesIn(reader: TestSession, threadId: Uuid): Promise<string[]> {
    const page = await harness.authed(reader, {
      method: 'GET',
      url: `/api/threads/${threadId}/messages?limit=200`,
    });
    assert.equal(page.statusCode, 200, page.body);
    return page.json<ListThreadMessagesResponse>().items.map((item) => item.body);
  }

  /** In-app notifications pointing at `threadId` for `userId`. */
  async function notificationsFor(userId: Uuid, threadId: Uuid): Promise<number> {
    const page = await harness.store.notifications.list({ user_id: userId }, { limit: 200 });
    return page.items.filter((row) => row.link === `/messages/${threadId}`).length;
  }

  function loggedLookupFailure(): boolean {
    return logLines.some((line) => line.includes('Could not resolve who to notify'));
  }

  it('opens a direct thread when the counterparty lookup for the notification fails', async () => {
    const sendRows = (await harness.auditRows('message.send')).length;
    logLines.length = 0;

    // The first read of the provider is the counterpart check before the
    // transaction; the second is the post-commit notification lookup.
    faults.arm('findById', { id: provider.user.id, skip: 1 });
    const opened = await harness.authed(client, {
      method: 'POST',
      url: '/api/threads',
      payload: {
        subject: 'Direct lookup fault',
        recipient_user_id: provider.user.id,
        body: 'Opening message',
      },
    });

    assert.equal(opened.statusCode, 201, opened.body);
    assert.deepEqual(faults.pending(), [], 'the intended failure was reached');
    const { thread, message } = opened.json<CreateThreadResponse>();
    assert.equal(message.body, 'Opening message');
    assert.deepEqual(await messagesIn(client, thread.id), ['Opening message']);
    assert.equal((await harness.auditRows('message.send')).length, sendRows + 1);
    assert.equal(await notificationsFor(provider.user.id, thread.id), 0);
    assert.ok(loggedLookupFailure(), 'the skipped notification is logged');
  });

  it('accepts a direct reply when the counterparty lookup for the notification fails', async () => {
    const opened = await harness.authed(client, {
      method: 'POST',
      url: '/api/threads',
      payload: {
        subject: 'Direct reply fault',
        recipient_user_id: provider.user.id,
        body: 'Question',
      },
    });
    assert.equal(opened.statusCode, 201, opened.body);
    const threadId = opened.json<CreateThreadResponse>().thread.id;
    const history = await messagesIn(provider, threadId);
    const notifiedBefore = await notificationsFor(client.user.id, threadId);
    const sendRows = (await harness.auditRows('message.send')).length;
    logLines.length = 0;

    faults.arm('findById', { id: client.user.id, skip: 0 });
    const reply = await harness.authed(provider, {
      method: 'POST',
      url: `/api/threads/${threadId}/messages`,
      payload: { body: 'Answer' },
    });

    assert.equal(reply.statusCode, 201, reply.body);
    assert.deepEqual(faults.pending(), []);
    assert.equal(reply.json<SendMessageResponse>().message.body, 'Answer');
    assert.deepEqual(await messagesIn(provider, threadId), [...history, 'Answer']);
    assert.equal((await harness.auditRows('message.send')).length, sendRows + 1);
    assert.equal(await notificationsFor(client.user.id, threadId), notifiedBefore);
    assert.ok(loggedLookupFailure());
  });

  it('opens a platform thread when the admin recipient listing fails', async () => {
    const sendRows = (await harness.auditRows('message.send')).length;
    logLines.length = 0;

    faults.arm('listRecipients', { skip: 0 });
    const opened = await harness.authed(client, {
      method: 'POST',
      url: '/api/threads',
      payload: { subject: 'Platform lookup fault', body: 'Hello support' },
    });

    assert.equal(opened.statusCode, 201, opened.body);
    assert.deepEqual(faults.pending(), []);
    const { thread } = opened.json<CreateThreadResponse>();
    assert.equal(thread.participant_b, null);
    assert.deepEqual(await messagesIn(client, thread.id), ['Hello support']);
    assert.equal((await harness.auditRows('message.send')).length, sendRows + 1);
    assert.equal(await notificationsFor(founder.user.id, thread.id), 0);
    assert.ok(loggedLookupFailure());

    // A follow-up with the store healthy again notifies the admins as usual:
    // the failure skipped one courtesy fan-out, it did not wedge the thread.
    const followUp = await harness.authed(client, {
      method: 'POST',
      url: `/api/threads/${thread.id}/messages`,
      payload: { body: 'Still there?' },
    });
    assert.equal(followUp.statusCode, 201, followUp.body);
    assert.equal(await notificationsFor(founder.user.id, thread.id), 1);
  });

  it('accepts a platform reply when the owner lookup for the notification fails', async () => {
    const opened = await harness.authed(client, {
      method: 'POST',
      url: '/api/threads',
      payload: { subject: 'Platform reply fault', body: 'Need help' },
    });
    assert.equal(opened.statusCode, 201, opened.body);
    const threadId = opened.json<CreateThreadResponse>().thread.id;
    const history = await messagesIn(client, threadId);
    const notifiedBefore = await notificationsFor(client.user.id, threadId);
    const sendRows = (await harness.auditRows('message.send')).length;
    logLines.length = 0;

    faults.arm('findById', { id: client.user.id, skip: 0 });
    const reply = await harness.authed(founder, {
      method: 'POST',
      url: `/api/threads/${threadId}/messages`,
      payload: { body: 'Here to help' },
    });

    assert.equal(reply.statusCode, 201, reply.body);
    assert.deepEqual(faults.pending(), []);
    assert.deepEqual(await messagesIn(client, threadId), [...history, 'Here to help']);
    assert.equal((await harness.auditRows('message.send')).length, sendRows + 1);
    assert.equal(await notificationsFor(client.user.id, threadId), notifiedBefore);
    assert.ok(loggedLookupFailure());
  });
});
