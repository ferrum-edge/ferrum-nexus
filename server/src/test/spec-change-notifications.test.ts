/**
 * Telling grantees that an API's specification changed — issue #447.
 *
 * A revision that changes something reaches every distinct active grantee
 * once, in the bell and by email through the outbox, and never the account
 * that published it. What these tests pin beyond that is what keeps it from
 * being noise or a hazard:
 *
 * - an identical re-upload tells nobody anything;
 * - a burst of revisions is coalesced: no second notice while the first is
 *   unread, no second email inside the hour;
 * - each channel can be turned off per account;
 * - provider-written names are escaped in the email's HTML;
 * - a notification failure never fails the publish, and a failed publish
 *   notifies nobody;
 * - the fan-out is audited, with its counts.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type {
  ApproveAccessRequestResponse,
  CreateAccessRequestResponse,
  CreateApplicationResponse,
  GetNotificationPreferencesResponse,
  ListApiRevisionsResponse,
  ListNotificationsResponse,
  Notification,
  PublishApiResponse,
} from '@ferrum-nexus/shared';

import { AuditAction } from '../audit/service.js';
import type { EmailOutboxRecord } from '../db/store.js';
import { faultInjectingStore, type FaultInjectingStore } from './fault-injection.js';
import { buildTestApp, type TestApp, type TestSession } from './helpers.js';

const HOUR = 60 * 60 * 1000;

function spec(version: string, paths: Record<string, unknown>): string {
  return JSON.stringify({
    openapi: '3.1.0',
    info: { title: 'Notify Billing', version },
    servers: [{ url: 'https://billing.example.com:8443/v2' }],
    paths,
  });
}

const ok = { responses: { '200': { description: 'OK' } } };

const V1 = spec('1.0.0', { '/invoices': { get: ok, post: ok } });
const V2 = spec('2.0.0', { '/invoices': { get: ok }, '/receipts': { get: ok } });
const V3 = spec('3.0.0', { '/invoices': { get: ok }, '/receipts': { get: ok, put: ok } });

describe('spec change notifications', () => {
  let harness: TestApp;
  let faults: FaultInjectingStore;
  let clock = Date.UTC(2026, 8, 30, 12, 0, 0);
  let admin: TestSession;
  let provider: TestSession;
  let alice: TestSession;
  let bob: TestSession;
  let carol: TestSession;
  let apiId: string;

  async function publish(name: string, slug: string, document: string): Promise<string> {
    const response = await harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: {
        name,
        slug,
        spec: document,
        auth_plugin: 'key_auth',
        requestable: true,
        visibility: 'public',
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<PublishApiResponse>().api.id;
  }

  async function revise(session: TestSession, id: string, document: string): Promise<number> {
    const response = await harness.authed(session, {
      method: 'PUT',
      url: `/api/apis/${id}/spec`,
      payload: { spec: document },
    });
    return response.statusCode;
  }

  /** Request access for one identity, and have the provider approve it. */
  async function grant(session: TestSession, id: string, applicationId?: string): Promise<void> {
    const created = await harness.authed(session, {
      method: 'POST',
      url: '/api/access-requests',
      payload: {
        api_id: id,
        justification: 'Integration.',
        ...(applicationId ? { application_id: applicationId } : {}),
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    const requestId = created.json<CreateAccessRequestResponse>().access_request.id;
    const approved = await harness.authed(provider, {
      method: 'POST',
      url: `/api/access-requests/${requestId}/approve`,
    });
    assert.equal(approved.statusCode, 200, approved.body);
    assert.equal(approved.json<ApproveAccessRequestResponse>().grant.status, 'active');
  }

  async function notices(session: TestSession): Promise<Notification[]> {
    const response = await harness.authed(session, {
      method: 'GET',
      url: '/api/notifications?type=api_spec_updated&limit=100',
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json<ListNotificationsResponse>().items;
  }

  async function mails(session: TestSession): Promise<EmailOutboxRecord[]> {
    return (await harness.outbox()).filter(
      (row) => row.to_email === session.user.email && row.subject.includes(' spec '),
    );
  }

  async function notifyRows(): Promise<Record<string, unknown>[]> {
    return (await harness.auditRows(AuditAction.API_SPEC_NOTIFY)).map((row) => row.details);
  }

  before(async () => {
    harness = await buildTestApp({
      deps: { specChangeClock: () => clock },
      wrapStore: (store) => {
        faults = faultInjectingStore(store);
        return faults.store;
      },
    });
    admin = await harness.registerUser({ email: 'notify-super@example.test' });
    provider = await harness.registerUser({
      email: 'notify-provider@example.test',
      role: 'provider',
    });
    alice = await harness.registerUser({ email: 'notify-alice@example.test' });
    bob = await harness.registerUser({ email: 'notify-bob@example.test' });
    carol = await harness.registerUser({ email: 'notify-carol@example.test' });

    apiId = await publish('Notify Billing', 'notify-billing', V1);
    // Alice holds two grants: her account's and one of her application's.
    await grant(alice, apiId);
    const application = await harness.authed(alice, {
      method: 'POST',
      url: '/api/applications',
      payload: { name: 'Alice worker', description: 'Nightly sync' },
    });
    assert.equal(application.statusCode, 201, application.body);
    await grant(alice, apiId, application.json<CreateApplicationResponse>().application.id);
    await grant(bob, apiId);
    await grant(admin, apiId);

    const optedOut = await harness.authed(bob, {
      method: 'PATCH',
      url: '/api/users/me/notification-preferences',
      payload: { api_spec_updated_email: false },
    });
    assert.equal(optedOut.statusCode, 200, optedOut.body);
  });

  after(async () => {
    await harness.close();
  });

  it('tells every grantee once, by notice and email, and not the publisher', async () => {
    // The administrator publishes, and holds a grant: it is not told.
    assert.equal(await revise(admin, apiId, V2), 200);

    const [notice, ...extra] = await notices(alice);
    assert.ok(notice, 'alice is told');
    assert.deepEqual(extra, [], 'once, however many of her identities hold a grant');
    assert.equal(notice.title, 'Notify Billing spec updated to 2.0.0');
    assert.equal(notice.link, '/catalog/notify-billing?tab=changes');
    assert.match(
      notice.body,
      /Removed: POST \/invoices \(requests to removed operations may now fail\)/,
    );
    assert.equal((await notices(bob)).length, 1);
    assert.equal((await notices(admin)).length, 0, 'the publisher is not told');
    assert.equal((await notices(carol)).length, 0, 'nor is an account with no grant');
    assert.equal((await notices(provider)).length, 0);

    const [mail, ...moreMail] = await mails(alice);
    assert.ok(mail);
    assert.deepEqual(moreMail, []);
    assert.equal(mail.subject, 'Notify Billing spec updated to 2.0.0');
    const history = `${harness.config.publicUrl}/catalog/notify-billing?tab=changes`;
    assert.ok(mail.body_text.includes(history), 'it links to the change history');
    assert.match(mail.body_text, /Removed: POST \/invoices/);
    assert.deepEqual(await mails(bob), [], 'bob turned email off');
    assert.deepEqual(await mails(admin), []);

    const rows = await notifyRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.recipients, 2);
    assert.equal(rows[0]?.notified, 2);
    assert.equal(rows[0]?.emailed, 1);
    assert.equal(rows[0]?.opted_out_email, 1);
    assert.equal(rows[0]?.kind, 'update');
  });

  it('coalesces a burst of revisions', async () => {
    // Same hour, and alice and bob have not read their notices yet.
    assert.equal(await revise(provider, apiId, V3), 200);
    assert.equal((await notices(alice)).length, 1, 'no second notice while the first is unread');
    assert.equal((await notices(bob)).length, 1);
    assert.equal((await mails(alice)).length, 1, 'no second email inside the hour');
    // The administrator did not publish this one, so it is told now.
    assert.equal((await notices(admin)).length, 1);
    assert.equal((await mails(admin)).length, 1);

    const row = (await notifyRows()).at(-1);
    assert.equal(row?.recipients, 3);
    assert.equal(row?.notified, 1);
    assert.equal(row?.already_notified, 2);
    assert.equal(row?.emailed, 1);
    assert.equal(row?.email_coalesced, 1);
  });

  it('tells a grantee again once it read the last notice, and emails hourly', async () => {
    const read = await harness.authed(alice, {
      method: 'POST',
      url: '/api/notifications/read',
      payload: { all: true },
    });
    assert.equal(read.statusCode, 200, read.body);
    clock += HOUR;

    const revisions = await harness.authed(provider, {
      method: 'GET',
      url: `/api/apis/${apiId}/revisions`,
    });
    const listed = revisions.json<ListApiRevisionsResponse>().items;
    const original = listed.find((item) => item.parsed_version === '1.0.0');
    assert.ok(original);
    const rolledBack = await harness.authed(provider, {
      method: 'POST',
      url: `/api/apis/${apiId}/revisions/${original.id}/rollback`,
      payload: {},
    });
    assert.equal(rolledBack.statusCode, 200, rolledBack.body);

    const [newest] = await notices(alice);
    assert.equal(newest?.title, 'Notify Billing spec rolled back to 1.0.0');
    assert.equal(newest?.read_at, null);
    assert.equal((await notices(alice)).length, 2);
    assert.equal((await notices(bob)).length, 1, 'bob has still not read his');
    assert.equal((await mails(alice)).length, 2, 'a new hour, a new email');
    assert.equal((await notifyRows()).at(-1)?.kind, 'rollback');
  });

  it('says nothing about an identical re-upload', async () => {
    const before = (await notifyRows()).length;
    const aliceNotices = (await notices(alice)).length;
    // The rollback made V1's document current again.
    assert.equal(await revise(provider, apiId, V1), 200);
    assert.equal((await notifyRows()).length, before);
    assert.equal((await notices(alice)).length, aliceNotices);
  });

  it('escapes what the provider wrote in the email', async () => {
    const escaped = await publish(
      'Esc <b>API</b> & co',
      'notify-escape',
      spec('1.0.0', { '/items': { get: ok } }),
    );
    await grant(carol, escaped);
    const hostile = '/<img src=x onerror=alert(1)>';
    const next = spec('2.0.0', { '/items': { get: ok }, [hostile]: { get: ok } });
    assert.equal(await revise(provider, escaped, next), 200);
    const [mail] = await mails(carol);
    assert.ok(mail);
    assert.equal(mail.subject, 'Esc <b>API</b> & co spec updated to 2.0.0');
    assert.ok(!mail.body_html.includes('<img src=x'), 'the path is not markup');
    assert.ok(mail.body_html.includes('&lt;img src=x onerror=alert(1)&gt;'));
    assert.ok(mail.body_html.includes('Esc &lt;b&gt;API&lt;/b&gt; &amp; co'));
    assert.ok(mail.body_text.includes(hostile), 'the text body is plain text');
  });

  it('never fails the publish when notifying fails', async () => {
    const before = (await notifyRows()).length;
    const bobNotices = (await notices(bob)).length;
    await harness.authed(bob, {
      method: 'POST',
      url: '/api/notifications/read',
      payload: { all: true },
    });
    faults.failNext('notificationPreferences', 'findManyByUsers', new Error('store down'));
    assert.equal(await revise(provider, apiId, V2), 200, 'the revision is published');
    assert.deepEqual(faults.pending(), [], 'the fault fired');
    const current = await harness.store.apiSpecs.findCurrentByApi(apiId);
    assert.equal(current?.parsed_version, '2.0.0');
    assert.equal((await notifyRows()).length, before, 'nothing was recorded as sent');
    assert.equal((await notices(bob)).length, bobNotices, 'and nothing was sent');
  });

  it('notifies nobody about a publish that failed', async () => {
    const before = (await notifyRows()).length;
    harness.edge.queueFailure(503, { error: 'unavailable' }, '/proxies/', 'GET');
    assert.ok((await revise(provider, apiId, V3)) >= 400);
    assert.equal((await notifyRows()).length, before);
  });

  it('keeps preferences per account, and audits a change', async () => {
    const read = await harness.authed(carol, {
      method: 'GET',
      url: '/api/users/me/notification-preferences',
    });
    assert.equal(read.statusCode, 200, read.body);
    assert.deepEqual(read.json<GetNotificationPreferencesResponse>().preferences, {
      api_spec_updated_in_app: true,
      api_spec_updated_email: true,
    });

    const change = async (payload: Record<string, unknown>): Promise<number> => {
      const response = await harness.authed(carol, {
        method: 'PATCH',
        url: '/api/users/me/notification-preferences',
        payload,
      });
      return response.statusCode;
    };
    assert.equal(await change({ api_spec_updated_in_app: false }), 200);
    assert.equal(await change({ api_spec_updated_in_app: false }), 200, 'a no-op is fine');
    assert.equal(await change({ unknown: true }), 400);

    const after = await harness.authed(carol, {
      method: 'GET',
      url: '/api/users/me/notification-preferences',
    });
    assert.deepEqual(after.json<GetNotificationPreferencesResponse>().preferences, {
      api_spec_updated_in_app: false,
      api_spec_updated_email: true,
    });
    const audited = await harness.auditRows(AuditAction.USER_NOTIFICATION_PREFERENCES_UPDATE);
    const rows = audited.filter((row) => row.target_id === carol.user.id);
    assert.equal(rows.length, 1, 'only the change is audited');
    assert.deepEqual(rows[0]?.details.changed, ['api_spec_updated_in_app']);
  });
});
