/**
 * Independent reads on hot request paths go out together.
 *
 * Each of these routes used to await reads that depend only on ids already in
 * hand one after another, so every page view or poll paid one database round
 * trip per join. The overlap probe holds the first read of each group until the
 * others have started: on a path that still awaits them in sequence the held
 * read times out, the request fails, and so does the test.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type {
  BrandingResponse,
  CatalogListResponse,
  CreateThreadResponse,
  ListAccessRequestsResponse,
  ListGrantsResponse,
  ListNotificationsResponse,
  ListThreadsResponse,
  MessageThreadDetail,
} from '@ferrum-nexus/shared';

import { buildTestApp, type TestApp, type TestSession } from './helpers.js';
import { overlapProbe, type OverlapProbe } from './overlap-probe.js';

describe('hot-path reads overlap', () => {
  let harness: TestApp;
  let probe: OverlapProbe;
  let founder: TestSession;
  let provider: TestSession;
  let client: TestSession;
  let threadId: string;

  before(async () => {
    harness = await buildTestApp({
      // Assemble branding on every request so the branding case is not served
      // from the memo.
      env: { NEXUS_BRANDING_CACHE_MS: '0' },
      wrapStore: (store) => {
        probe = overlapProbe(store);
        return probe.store;
      },
    });
    founder = await harness.registerUser({ email: 'overlap-founder@example.test' });
    provider = await harness.registerUser({
      email: 'overlap-provider@example.test',
      role: 'provider',
    });
    client = await harness.registerUser({ email: 'overlap-client@example.test', role: 'client' });

    const api = await harness.store.apis.create({
      name: 'Overlap API',
      slug: 'overlap-api',
      owner_user_id: provider.user.id,
      namespace: 'nexus',
      version: '1.0.0',
      spec_format: 'openapi',
      requestable: true,
      auth_plugin: 'key_auth',
      status: 'published',
      visibility: 'public',
    });
    await harness.store.accessRequests.create({
      api_id: api.id,
      user_id: client.user.id,
      status: 'pending',
      justification: 'Overlap probe',
    });
    await harness.store.grants.create({
      api_id: api.id,
      user_id: client.user.id,
      status: 'active',
      acl_group: `nexus:api:${api.id}:approved`,
      granted_by: founder.user.id,
    });

    const opened = await harness.authed(client, {
      method: 'POST',
      url: '/api/threads',
      payload: {
        subject: 'Overlap probe',
        recipient_user_id: provider.user.id,
        body: 'the opening message',
      },
    });
    assert.equal(opened.statusCode, 201, opened.body);
    threadId = opened.json<CreateThreadResponse>().thread.id;
  });

  after(async () => {
    await harness.close();
  });

  it('reads the notification page and the unread count together', async () => {
    const overlap = probe.expectOverlap([
      { repo: 'notifications', method: 'list' },
      { repo: 'notifications', method: 'countUnread' },
    ]);
    const response = await harness.authed(client, { method: 'GET', url: '/api/notifications' });
    await overlap;
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json<ListNotificationsResponse>();
    assert.ok(body.unread_count >= 1);
  });

  it('joins APIs and requesters onto access requests together', async () => {
    const overlap = probe.expectOverlap([
      { repo: 'apis', method: 'findManyByIds' },
      { repo: 'users', method: 'findManyByIds' },
    ]);
    const response = await harness.authed(client, { method: 'GET', url: '/api/access-requests' });
    await overlap;
    assert.equal(response.statusCode, 200, response.body);
    const [request] = response.json<ListAccessRequestsResponse>().items;
    assert.equal(request?.api?.slug, 'overlap-api');
    assert.equal(request?.requester?.id, client.user.id);
  });

  it('joins APIs and grantees onto grants together', async () => {
    const overlap = probe.expectOverlap([
      { repo: 'apis', method: 'findManyByIds' },
      { repo: 'users', method: 'findManyByIds' },
    ]);
    const response = await harness.authed(client, { method: 'GET', url: '/api/grants' });
    await overlap;
    assert.equal(response.statusCode, 200, response.body);
    const [grant] = response.json<ListGrantsResponse>().items;
    assert.equal(grant?.api?.slug, 'overlap-api');
    assert.equal(grant?.user?.id, client.user.id);
  });

  it('joins participants and latest messages onto the thread list together', async () => {
    const overlap = probe.expectOverlap([
      { repo: 'users', method: 'findManyByIds' },
      { repo: 'messages', method: 'findLatestByThreads' },
    ]);
    const response = await harness.authed(client, { method: 'GET', url: '/api/threads' });
    await overlap;
    assert.equal(response.statusCode, 200, response.body);
    const [thread] = response.json<ListThreadsResponse>().items;
    assert.equal(thread?.id, threadId);
  });

  it('counts a thread transcript alongside reading its window', async () => {
    const overlap = probe.expectOverlap([
      { repo: 'messages', method: 'listByThread' },
      { repo: 'messages', method: 'countByThread' },
    ]);
    const response = await harness.authed(client, {
      method: 'GET',
      url: `/api/threads/${threadId}`,
    });
    await overlap;
    assert.equal(response.statusCode, 200, response.body);
    const detail = response.json<MessageThreadDetail>();
    assert.equal(detail.messages.total, 1);
    assert.equal(detail.messages.items.length, 1);
  });

  it('reads the catalog visibility lists, then the page joins, in two rounds', async () => {
    const visibility = probe.expectOverlap([
      { repo: 'grants', method: 'listActiveByUser' },
      { repo: 'apiViewers', method: 'listApiIdsByUser' },
    ]);
    const joins = probe.expectOverlap([
      { repo: 'users', method: 'findManyByIds' },
      { repo: 'accessRequests', method: 'listLatestForUser' },
    ]);
    const response = await harness.authed(client, { method: 'GET', url: '/api/catalog' });
    await visibility;
    await joins;
    assert.equal(response.statusCode, 200, response.body);
    const [entry] = response.json<CatalogListResponse>().items;
    assert.equal(entry?.slug, 'overlap-api');
  });

  it('reads the three public branding settings rows together', async () => {
    const key = (name: string) => (args: readonly unknown[]) => args[0] === name;
    const overlap = probe.expectOverlap([
      { repo: 'settings', method: 'get', match: key('branding') },
      { repo: 'settings', method: 'get', match: key('registration') },
      { repo: 'settings', method: 'get', match: key('captcha') },
    ]);
    const response = await harness.app.inject({ method: 'GET', url: '/api/branding' });
    await overlap;
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json<BrandingResponse>();
    assert.equal(typeof body.registration.open_registration, 'boolean');
  });
});
