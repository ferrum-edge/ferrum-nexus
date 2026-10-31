/**
 * `POST /api/grants/:id/relinquish` — the grantee gives up its own access.
 *
 * Before this route a grantee had no way to shed an approval it no longer
 * needed: revocation was for the API's owner or an admin, and the only thing a
 * client could do was delete a whole application, which also killed every
 * credential and every other approval it held. These tests pin that the
 * account holding a grant can withdraw exactly that grant, that the gateway
 * really loses the ACL group, and that nobody else can use the route.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { LightMyRequestResponse } from 'fastify';

import {
  aclGroupForApi,
  consumerUsernameForApplication,
  consumerUsernameForUser,
  type ApiErrorBody,
  type ApproveAccessRequestResponse,
  type CreateAccessRequestResponse,
  type CreateApplicationResponse,
  type ListNotificationsResponse,
  type PublishApiResponse,
  type RelinquishGrantResponse,
} from '@ferrum-nexus/shared';

import { SAMPLE_SPEC_YAML, buildTestApp, type TestApp, type TestSession } from './helpers.js';

function errorCode(body: string): string {
  return (JSON.parse(body) as ApiErrorBody).error.code;
}

describe('grant relinquish', () => {
  let harness: TestApp;
  let provider: TestSession;
  let client: TestSession;
  let other: TestSession;

  async function publish(slug: string): Promise<string> {
    const response = await harness.authed(provider, {
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

  async function createApplication(session: TestSession, name: string): Promise<string> {
    const response = await harness.authed(session, {
      method: 'POST',
      url: '/api/applications',
      payload: { name },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<CreateApplicationResponse>().application.id;
  }

  /** Request access for one identity, have the provider approve it, return the grant. */
  async function grant(
    session: TestSession,
    apiId: string,
    applicationId: string | null = null,
  ): Promise<{ grantId: string; requestId: string }> {
    const requested = await harness.authed(session, {
      method: 'POST',
      url: '/api/access-requests',
      payload: {
        api_id: apiId,
        justification: 'Nightly reconciliation job.',
        ...(applicationId === null ? {} : { application_id: applicationId }),
      },
    });
    assert.equal(requested.statusCode, 201, requested.body);
    const requestId = requested.json<CreateAccessRequestResponse>().access_request.id;
    const approved = await harness.authed(provider, {
      method: 'POST',
      url: `/api/access-requests/${requestId}/approve`,
      payload: {},
    });
    assert.equal(approved.statusCode, 200, approved.body);
    return { grantId: approved.json<ApproveAccessRequestResponse>().grant.id, requestId };
  }

  function groupsOf(username: string): string[] {
    return harness.edge.consumerByUsername(username)?.acl_groups ?? [];
  }

  async function relinquish(
    session: TestSession,
    grantId: string,
    payload: Record<string, unknown> = {},
  ): Promise<LightMyRequestResponse> {
    return await harness.authed(session, {
      method: 'POST',
      url: `/api/grants/${grantId}/relinquish`,
      payload,
    });
  }

  beforeEach(async () => {
    harness = await buildTestApp();
    await harness.registerUser({ email: 'rel-founder@example.test' });
    provider = await harness.registerUser({ email: 'rel-provider@example.test', role: 'provider' });
    client = await harness.registerUser({ email: 'rel-client@example.test', role: 'client' });
    other = await harness.registerUser({ email: 'rel-other@example.test', role: 'client' });
  });

  afterEach(async () => {
    harness.edge.clearInjections();
    await harness.close();
  });

  it('lets the grantee give up its account grant, and the gateway follows', async () => {
    const apiId = await publish('rel-account');
    const keptApiId = await publish('rel-account-kept');
    const { grantId, requestId } = await grant(client, apiId);
    await grant(client, keptApiId);
    const username = consumerUsernameForUser(client.user.id);
    assert.ok(groupsOf(username).includes(aclGroupForApi(apiId)));

    const response = await relinquish(client, grantId);
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json<RelinquishGrantResponse>();
    assert.equal(body.grant.status, 'revoked');
    assert.equal(body.grant.revoked_by, client.user.id);

    // Only this API's group came off: the account's other approval stands.
    assert.ok(!groupsOf(username).includes(aclGroupForApi(apiId)));
    assert.ok(groupsOf(username).includes(aclGroupForApi(keptApiId)));
    assert.equal((await harness.store.accessRequests.findById(requestId))?.status, 'revoked');

    const audits = (await harness.auditRows('access.revoke')).filter(
      (row) => row.target_id === grantId,
    );
    assert.equal(audits.length, 1, 'one withdrawal, one audit row');
    assert.equal(audits[0]?.actor_user_id, client.user.id);
    assert.equal(audits[0]?.details.relinquished, true);

    // The grantee asked for this; no "somebody revoked your access" notice or mail.
    const bell = await harness.authed(client, {
      method: 'GET',
      url: '/api/notifications?type=access_revoked',
    });
    assert.equal(bell.json<ListNotificationsResponse>().total, 0);
    const mail = (await harness.outbox()).filter(
      (row) => row.to_email === client.user.email && row.subject.includes('Access revoked'),
    );
    assert.equal(mail.length, 0);

    // Giving access up does not burn the bridge: the identity may ask again.
    const again = await harness.authed(client, {
      method: 'POST',
      url: '/api/access-requests',
      payload: { api_id: apiId, justification: 'Back on the integration.' },
    });
    assert.equal(again.statusCode, 201, again.body);
  });

  it('gives up one application grant without touching the account or a sibling', async () => {
    const apiId = await publish('rel-app');
    const appA = await createApplication(client, 'Billing worker');
    const appB = await createApplication(client, 'Reporting worker');
    const { grantId } = await grant(client, apiId, appA);
    await grant(client, apiId, appB);
    await grant(client, apiId, null);
    const group = aclGroupForApi(apiId);

    // Disabled applications acquire nothing new, but may still shed access.
    const disabled = await harness.authed(client, {
      method: 'PATCH',
      url: `/api/applications/${appA}`,
      payload: { status: 'disabled' },
    });
    assert.equal(disabled.statusCode, 200, disabled.body);

    const response = await relinquish(client, grantId);
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(!groupsOf(consumerUsernameForApplication(appA)).includes(group));
    assert.ok(groupsOf(consumerUsernameForApplication(appB)).includes(group));
    assert.ok(groupsOf(consumerUsernameForUser(client.user.id)).includes(group));
  });

  it('refuses everyone but the holder, without saying whether the grant exists', async () => {
    const apiId = await publish('rel-guard');
    const { grantId } = await grant(client, apiId);
    const group = aclGroupForApi(apiId);

    // Another client, and the API's own provider: relinquish is not revoke.
    for (const session of [other, provider]) {
      const refused = await relinquish(session, grantId);
      assert.equal(refused.statusCode, 404, refused.body);
      assert.equal(errorCode(refused.body), 'NOT_FOUND');
    }
    const missing = await relinquish(other, '00000000-0000-4000-8000-000000000000');
    assert.equal(missing.statusCode, 404, missing.body);
    assert.equal((await harness.store.grants.findById(grantId))?.status, 'active');
    assert.ok(groupsOf(consumerUsernameForUser(client.user.id)).includes(group));

    const extra = await relinquish(client, grantId, { reason: 'no body accepted' });
    assert.equal(extra.statusCode, 400, extra.body);
    assert.equal((await harness.store.grants.findById(grantId))?.status, 'active');
  });

  it('is a conflict the second time, and after a provider revoked it', async () => {
    const apiId = await publish('rel-twice');
    const first = await grant(client, apiId);
    assert.equal((await relinquish(client, first.grantId)).statusCode, 200);
    const twice = await relinquish(client, first.grantId);
    assert.equal(twice.statusCode, 409, twice.body);

    const second = await grant(client, apiId);
    const revoked = await harness.authed(provider, {
      method: 'POST',
      url: `/api/grants/${second.grantId}/revoke`,
      payload: {},
    });
    assert.equal(revoked.statusCode, 200, revoked.body);
    const late = await relinquish(client, second.grantId);
    assert.equal(late.statusCode, 409, late.body);
    assert.equal(
      (await harness.auditRows('access.revoke')).filter((row) => row.target_id === second.grantId)
        .length,
      1,
    );
  });

  it('puts the grant back when the gateway refuses the removal', async () => {
    const apiId = await publish('rel-refused');
    const { grantId } = await grant(client, apiId);
    const username = consumerUsernameForUser(client.user.id);
    const consumer = harness.edge.consumerByUsername(username);
    assert.ok(consumer);

    harness.edge.queueFailure(500, { error: 'refused' }, `/consumers/${consumer.id}`, 'PUT');
    const response = await relinquish(client, grantId);
    assert.ok(response.statusCode >= 500, response.body);

    // A withdrawal the gateway did not accept must not stand as one.
    assert.equal((await harness.store.grants.findById(grantId))?.status, 'active');
    assert.ok(groupsOf(username).includes(aclGroupForApi(apiId)));
    assert.ok(
      (await harness.auditRows('access.revoke_rollback')).some((row) => row.target_id === grantId),
    );

    const retried = await relinquish(client, grantId);
    assert.equal(retried.statusCode, 200, retried.body);
    assert.ok(!groupsOf(username).includes(aclGroupForApi(apiId)));
  });
});
