/**
 * Abuse controls on `/api/access-requests` — GHSA-pxq8-x5j3-qfvh (surface B).
 *
 * The limiter is forced off under `NEXUS_ENV=test`, so the limiter suite boots
 * a `development` app with `NEXUS_RATE_LIMIT_ENABLED=true`.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type {
  ApiErrorBody,
  CreateAccessRequestResponse,
  PublishApiResponse,
} from '@ferrum-nexus/shared';

import { SAMPLE_SPEC_YAML, buildTestApp, type TestApp, type TestSession } from './helpers.js';

function error(body: string): ApiErrorBody['error'] {
  return (JSON.parse(body) as ApiErrorBody).error;
}

async function publish(
  harness: TestApp,
  owner: TestSession,
  slug: string,
): Promise<string> {
  const response = await harness.authed(owner, {
    method: 'POST',
    url: '/api/apis',
    payload: {
      name: `API ${slug}`,
      slug,
      spec: SAMPLE_SPEC_YAML,
      auth_plugin: 'key_auth',
      requestable: true,
      visibility: 'public',
    },
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json<PublishApiResponse>().api.id;
}

describe('access-request rate limits', () => {
  let harness: TestApp;
  let provider: TestSession;
  let alice: TestSession;
  let bob: TestSession;
  let apiIds: string[];

  before(async () => {
    harness = await buildTestApp({
      env: {
        NEXUS_ENV: 'development',
        NEXUS_RATE_LIMIT_ENABLED: 'true',
        NEXUS_MAX_ACCESS_REQUESTS_PER_USER_PER_DAY: '0',
      },
      deps: { startOutboxWorker: false },
    });
    await harness.registerUser({ email: 'ar-limit-founder@example.test' });
    provider = await harness.registerUser({
      email: 'ar-limit-provider@example.test',
      role: 'provider',
    });
    alice = await harness.registerUser({ email: 'ar-limit-alice@example.test', role: 'client' });
    bob = await harness.registerUser({ email: 'ar-limit-bob@example.test', role: 'client' });
    apiIds = [];
    for (let index = 0; index < 12; index += 1) {
      apiIds.push(await publish(harness, provider, `ar-limit-${index}`));
    }
  });

  after(async () => {
    await harness.close();
  });

  it('caps creation at 10 a minute per account', async () => {
    const statuses: number[] = [];
    let refusal = '';
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await harness.authed(alice, {
        method: 'POST',
        url: '/api/access-requests',
        payload: { api_id: apiIds[attempt], justification: `Need ${attempt}` },
      });
      statuses.push(response.statusCode);
      if (response.statusCode === 429) refusal = response.body;
    }

    assert.equal(statuses.filter((status) => status === 201).length, 10);
    assert.equal(statuses.filter((status) => status === 429).length, 2);
    assert.equal(error(refusal).code, 'RATE_LIMITED');
  });

  it('gives a second account its own bucket rather than the first account’s', async () => {
    const response = await harness.authed(bob, {
      method: 'POST',
      url: '/api/access-requests',
      payload: { api_id: apiIds[11], justification: 'A fresh account' },
    });
    assert.equal(response.statusCode, 201, response.body);
  });
});

describe('daily access-request budget', () => {
  let harness: TestApp;
  let provider: TestSession;
  let client: TestSession;
  let apiIds: string[];

  before(async () => {
    harness = await buildTestApp({
      env: { NEXUS_MAX_ACCESS_REQUESTS_PER_USER_PER_DAY: '2' },
      deps: { startOutboxWorker: false },
    });
    await harness.registerUser({ email: 'ar-budget-founder@example.test' });
    provider = await harness.registerUser({
      email: 'ar-budget-provider@example.test',
      role: 'provider',
    });
    client = await harness.registerUser({ email: 'ar-budget-client@example.test', role: 'client' });
    apiIds = [
      await publish(harness, provider, 'ar-budget-a'),
      await publish(harness, provider, 'ar-budget-b'),
      await publish(harness, provider, 'ar-budget-c'),
    ];
  });

  after(async () => {
    await harness.close();
  });

  async function create(apiId: string): Promise<string> {
    const response = await harness.authed(client, {
      method: 'POST',
      url: '/api/access-requests',
      payload: { api_id: apiId, justification: 'Need access for testing.' },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<CreateAccessRequestResponse>().access_request.id;
  }

  async function cancel(requestId: string): Promise<void> {
    const response = await harness.authed(client, {
      method: 'POST',
      url: `/api/access-requests/${requestId}/cancel`,
    });
    assert.equal(response.statusCode, 200, response.body);
  }

  it('counts cancelled requests toward the ceiling', async () => {
    const first = await create(apiIds[0]);
    await cancel(first);
    const second = await create(apiIds[1]);
    await cancel(second);

    const refused = await harness.authed(client, {
      method: 'POST',
      url: '/api/access-requests',
      payload: { api_id: apiIds[2], justification: 'Should be refused.' },
    });
    assert.equal(refused.statusCode, 429, refused.body);
    const body = error(refused.body);
    assert.equal(body.code, 'QUOTA_EXCEEDED');
    assert.equal(body.details?.setting, 'NEXUS_MAX_ACCESS_REQUESTS_PER_USER_PER_DAY');
  });

  it('writes nothing when the budget refuses', async () => {
    const beforeAudit = (await harness.store.auditLogs.list({}, { limit: 1 })).total;
    const beforeNotifications = (
      await harness.store.notifications.list({ user_id: provider.user.id })
    ).total;

    const refused = await harness.authed(client, {
      method: 'POST',
      url: '/api/access-requests',
      payload: { api_id: apiIds[2], justification: 'Still refused.' },
    });
    assert.equal(refused.statusCode, 429, refused.body);

    assert.equal((await harness.store.auditLogs.list({}, { limit: 1 })).total, beforeAudit);
    assert.equal(
      (await harness.store.notifications.list({ user_id: provider.user.id })).total,
      beforeNotifications,
    );
  });
});
