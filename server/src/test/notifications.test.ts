import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type {
  ListNotificationsResponse,
  MarkNotificationsReadResponse,
} from '@ferrum-nexus/shared';

import { buildTestApp, type TestApp, type TestSession } from './helpers.js';

describe('notifications', () => {
  let harness: TestApp;
  let owner: TestSession;
  let stranger: TestSession;

  before(async () => {
    harness = await buildTestApp();
    owner = await harness.registerUser({ email: 'owner@example.test' });
    stranger = await harness.registerUser({ email: 'stranger@example.test' });

    await harness.services.notifications.notify(
      owner.user.id,
      'access_request_approved',
      'Access approved',
      'Billing API access is live',
      '/catalog/billing',
    );
    await harness.services.notifications.notifyMany(
      [owner.user.id, stranger.user.id],
      'system',
      'Scheduled maintenance',
      'The gateway restarts at 02:00 UTC',
    );
  });

  after(async () => {
    await harness.close();
  });

  it('lists only the caller notifications, newest first, with an unread count', async () => {
    const response = await harness.authed(owner, { method: 'GET', url: '/api/notifications' });
    assert.equal(response.statusCode, 200);
    const body = response.json<ListNotificationsResponse>();

    // Registration adds a welcome notification, so the owner has three.
    assert.equal(body.total, 3);
    assert.equal(body.unread_count, 3);
    assert.ok(body.items.every((item) => item.user_id === owner.user.id));
    assert.deepEqual(body.items.map((item) => item.title).sort(), [
      'Access approved',
      'Scheduled maintenance',
      'Welcome to the portal',
    ]);
  });

  it('filters by unread and by type', async () => {
    const byType = await harness.authed(owner, {
      method: 'GET',
      url: '/api/notifications?type=access_request_approved',
    });
    const typed = byType.json<ListNotificationsResponse>();
    assert.equal(typed.total, 1);
    assert.equal(typed.items[0]?.link, '/catalog/billing');

    const unread = await harness.authed(owner, {
      method: 'GET',
      url: '/api/notifications?unread=true&limit=2',
    });
    const page = unread.json<ListNotificationsResponse>();
    assert.equal(page.total, 3, 'total ignores the page size');
    assert.equal(page.items.length, 2);
  });

  it('marks selected notifications read and ignores ids owned by someone else', async () => {
    const list = await harness.authed(owner, { method: 'GET', url: '/api/notifications' });
    const mine = list.json<ListNotificationsResponse>().items[0]?.id ?? '';

    const strangerList = await harness.authed(stranger, {
      method: 'GET',
      url: '/api/notifications',
    });
    const theirs = strangerList.json<ListNotificationsResponse>().items[0]?.id ?? '';

    const response = await harness.authed(owner, {
      method: 'POST',
      url: '/api/notifications/read',
      payload: { ids: [mine, theirs] },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json<MarkNotificationsReadResponse>();
    assert.equal(body.updated, 1, 'only the caller own notification is marked');
    assert.equal(body.unread_count, 2);

    const stillUnread = await harness.authed(stranger, {
      method: 'GET',
      url: '/api/notifications?unread=true',
    });
    assert.equal(stillUnread.json<ListNotificationsResponse>().total, 2);
  });

  it('marks everything read at once and records an audit row', async () => {
    const response = await harness.authed(owner, {
      method: 'POST',
      url: '/api/notifications/read',
      payload: { all: true },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json<MarkNotificationsReadResponse>().unread_count, 0);

    const audit = await harness.store.auditLogs.list({ action: 'notification.read' });
    assert.ok(audit.total >= 1);
  });

  it('rejects a read request that names neither ids nor all', async () => {
    const response = await harness.authed(owner, {
      method: 'POST',
      url: '/api/notifications/read',
      payload: {},
    });
    assert.equal(response.statusCode, 400);
  });

  it('requires a session', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/api/notifications' });
    assert.equal(response.statusCode, 401);
  });
});
