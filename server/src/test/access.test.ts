import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  aclGroupForApi,
  consumerUsernameForUser,
  type ApiErrorBody,
  type ApproveAccessRequestResponse,
  type CreateAccessRequestResponse,
  type DenyAccessRequestResponse,
  type ListAccessRequestsResponse,
  type ListGrantsResponse,
  type ListNotificationsResponse,
  type PublishApiResponse,
  type RevokeGrantResponse,
} from '@ferrum-nexus/shared';

import { SAMPLE_SPEC_YAML, buildTestApp, type TestApp, type TestSession } from './helpers.js';

function errorCode(body: string): string {
  return (JSON.parse(body) as ApiErrorBody).error.code;
}

describe('access workflow', () => {
  let harness: TestApp;
  let founder: TestSession;
  let provider: TestSession;
  let otherProvider: TestSession;
  let client: TestSession;
  let secondClient: TestSession;

  /** Publish an API owned by `owner` and return its id. */
  async function publish(
    owner: TestSession,
    slug: string,
    overrides: Record<string, unknown> = {},
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
        ...overrides,
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<PublishApiResponse>().api.id;
  }

  async function request(
    actor: TestSession,
    apiId: string,
    justification = 'We need it for the integration.',
  ): Promise<string> {
    const response = await harness.authed(actor, {
      method: 'POST',
      url: '/api/access-requests',
      payload: { api_id: apiId, justification },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<CreateAccessRequestResponse>().access_request.id;
  }

  /** ACL groups currently on a user's Edge consumer, as the mock stores them. */
  function groupsOf(userId: string): string[] {
    return harness.edge.consumerByUsername(consumerUsernameForUser(userId))?.acl_groups ?? [];
  }

  before(async () => {
    harness = await buildTestApp();
    founder = await harness.registerUser({ email: 'acc-founder@example.test' });
    provider = await harness.registerUser({ email: 'acc-provider@example.test', role: 'provider' });
    otherProvider = await harness.registerUser({
      email: 'acc-other@example.test',
      role: 'provider',
    });
    client = await harness.registerUser({ email: 'acc-client@example.test', role: 'client' });
    secondClient = await harness.registerUser({
      email: 'acc-client2@example.test',
      role: 'client',
    });
  });

  after(async () => {
    await harness.close();
  });

  it('runs the full request → approve → revoke lifecycle against the gateway', async () => {
    const apiId = await publish(provider, 'lifecycle');
    const group = aclGroupForApi(apiId);

    /* ── request ────────────────────────────────────────────────────────── */
    const requestId = await request(client, apiId, 'Building an invoice reconciler.');

    const providerBell = await harness.authed(provider, {
      method: 'GET',
      url: '/api/notifications?type=access_request_created',
    });
    const notified = providerBell.json<ListNotificationsResponse>();
    assert.equal(notified.total, 1);
    assert.match(notified.items[0]?.title ?? '', /Access requested/);
    assert.equal(
      notified.items[0]?.link,
      `/apis/${apiId}`,
      'the bell links at the provider’s review inbox, which lives on the API page',
    );

    assert.ok(
      (await harness.auditRows('access.request')).some((row) => row.target_id === requestId),
    );
    // Nothing has touched the gateway yet: a request is a portal-side artefact.
    assert.equal(
      harness.edge.consumerByUsername(consumerUsernameForUser(client.user.id)),
      undefined,
    );

    /* ── approve ────────────────────────────────────────────────────────── */
    const approved = await harness.authed(provider, {
      method: 'POST',
      url: `/api/access-requests/${requestId}/approve`,
      payload: { decision_note: 'Looks reasonable.' },
    });
    assert.equal(approved.statusCode, 200);
    const approval = approved.json<ApproveAccessRequestResponse>();
    assert.equal(approval.access_request.status, 'approved');
    assert.equal(approval.access_request.decision_note, 'Looks reasonable.');
    assert.equal(approval.grant.status, 'active');
    assert.equal(approval.grant.acl_group, group);
    assert.equal(approval.grant.granted_by, provider.user.id);

    // The consumer was created on demand and now carries the group.
    const consumer = harness.edge.consumerByUsername(consumerUsernameForUser(client.user.id));
    assert.ok(consumer, 'approval provisions the requester’s Edge consumer');
    assert.equal(consumer.custom_id, client.user.id);
    assert.deepEqual(consumer.acl_groups, [group]);

    // …and Nexus cached the mapping so later calls need no username scan.
    const cached = await harness.store.consumers.findByUserAndNamespace(client.user.id, 'nexus');
    assert.equal(cached?.ferrum_consumer_id, consumer.id);

    const requesterBell = await harness.authed(client, {
      method: 'GET',
      url: '/api/notifications?type=access_request_approved',
    });
    assert.equal(requesterBell.json<ListNotificationsResponse>().total, 1);

    const approvalMail = (await harness.outbox()).filter(
      (row) =>
        row.to_email === 'acc-client@example.test' && row.subject.includes('Access approved'),
    );
    assert.equal(approvalMail.length, 1);
    assert.match(approvalMail[0]?.body_text ?? '', /Looks reasonable\./);

    const approveAudit = (await harness.auditRows('access.approve')).find(
      (row) => row.target_id === requestId,
    );
    assert.equal(approveAudit?.details.acl_group, group);
    assert.equal(approveAudit?.details.grant_id, approval.grant.id);

    /* ── revoke ─────────────────────────────────────────────────────────── */
    const revoked = await harness.authed(provider, {
      method: 'POST',
      url: `/api/grants/${approval.grant.id}/revoke`,
      payload: { reason: 'Contract ended.' },
    });
    assert.equal(revoked.statusCode, 200);
    const revocation = revoked.json<RevokeGrantResponse>();
    assert.equal(revocation.grant.status, 'revoked');
    assert.equal(revocation.grant.revoked_by, provider.user.id);
    assert.ok(revocation.grant.revoked_at);

    assert.deepEqual(groupsOf(client.user.id), [], 'the ACL group is gone from the consumer');

    // The originating request follows the grant into `revoked`, so the
    // requester's history does not still read "approved".
    const history = await harness.store.accessRequests.findById(requestId);
    assert.equal(history?.status, 'revoked');

    const revokeMail = (await harness.outbox()).filter(
      (row) => row.to_email === 'acc-client@example.test' && row.subject.includes('Access revoked'),
    );
    assert.equal(revokeMail.length, 1);
    assert.match(revokeMail[0]?.body_text ?? '', /Contract ended\./);

    const revokeAudit = (await harness.auditRows('access.revoke')).find(
      (row) => row.target_id === approval.grant.id,
    );
    assert.equal(revokeAudit?.details.reason, 'Contract ended.');
  });

  it('denies a request without touching the gateway, and mails the requester', async () => {
    const apiId = await publish(provider, 'deny-path');
    const requestId = await request(secondClient, apiId);

    const response = await harness.authed(provider, {
      method: 'POST',
      url: `/api/access-requests/${requestId}/deny`,
      payload: { decision_note: 'Not a fit for this data set.' },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json<DenyAccessRequestResponse>();
    assert.equal(body.access_request.status, 'denied');
    assert.equal(body.access_request.decided_by, provider.user.id);

    assert.equal(
      await harness.store.grants.findActiveByApiAndUser(apiId, secondClient.user.id),
      null,
    );
    assert.ok(!groupsOf(secondClient.user.id).includes(aclGroupForApi(apiId)));

    const mail = (await harness.outbox()).filter(
      (row) =>
        row.to_email === 'acc-client2@example.test' &&
        row.subject.includes('Access request declined'),
    );
    assert.equal(mail.length, 1);
    assert.match(mail[0]?.body_text ?? '', /Not a fit for this data set\./);

    assert.ok((await harness.auditRows('access.deny')).some((row) => row.target_id === requestId));
  });

  it('lets the requester cancel their own pending request, and nobody else', async () => {
    const apiId = await publish(provider, 'cancel-path');
    const requestId = await request(client, apiId);

    const foreign = await harness.authed(secondClient, {
      method: 'POST',
      url: `/api/access-requests/${requestId}/cancel`,
    });
    assert.equal(foreign.statusCode, 403);

    const response = await harness.authed(client, {
      method: 'POST',
      url: `/api/access-requests/${requestId}/cancel`,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(
      response.json<{ access_request: { status: string } }>().access_request.status,
      'cancelled',
    );

    // A cancelled request is decided, so it can no longer be approved.
    const late = await harness.authed(provider, {
      method: 'POST',
      url: `/api/access-requests/${requestId}/approve`,
    });
    assert.equal(late.statusCode, 409);

    assert.ok(
      (await harness.auditRows('access.cancel')).some((row) => row.target_id === requestId),
    );
  });

  it('refuses a second pending request for the same API', async () => {
    const apiId = await publish(provider, 'duplicate-request');
    await request(client, apiId);

    const response = await harness.authed(client, {
      method: 'POST',
      url: '/api/access-requests',
      payload: { api_id: apiId, justification: 'Asking twice.' },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(errorCode(response.body), 'CONFLICT');
  });

  it('refuses a request once an active grant already exists', async () => {
    const apiId = await publish(provider, 'already-granted');
    const requestId = await request(secondClient, apiId);
    await harness.authed(provider, {
      method: 'POST',
      url: `/api/access-requests/${requestId}/approve`,
    });

    const response = await harness.authed(secondClient, {
      method: 'POST',
      url: '/api/access-requests',
      payload: { api_id: apiId, justification: 'Again please.' },
    });
    assert.equal(response.statusCode, 409);
    assert.match(JSON.parse(response.body).error.message, /already have access/);
  });

  it('refuses a request for an API that does not accept them', async () => {
    const apiId = await publish(provider, 'not-requestable', { requestable: false });
    const response = await harness.authed(client, {
      method: 'POST',
      url: '/api/access-requests',
      payload: { api_id: apiId, justification: 'Please.' },
    });
    assert.equal(response.statusCode, 409);
    assert.match(JSON.parse(response.body).error.message, /does not accept access requests/);
  });

  it('refuses a request for a retired API', async () => {
    const apiId = await publish(provider, 'retired-request');
    await harness.authed(provider, {
      method: 'PATCH',
      url: `/api/apis/${apiId}`,
      payload: { status: 'retired' },
    });
    const response = await harness.authed(client, {
      method: 'POST',
      url: '/api/access-requests',
      payload: { api_id: apiId, justification: 'Please.' },
    });
    assert.equal(response.statusCode, 409);
    assert.match(JSON.parse(response.body).error.message, /retired/);
  });

  it('will not let a provider decide a request on somebody else’s API', async () => {
    const apiId = await publish(provider, 'foreign-decision');
    const requestId = await request(client, apiId);

    const approve = await harness.authed(otherProvider, {
      method: 'POST',
      url: `/api/access-requests/${requestId}/approve`,
    });
    assert.equal(approve.statusCode, 403);
    assert.equal(errorCode(approve.body), 'FORBIDDEN');

    const deny = await harness.authed(otherProvider, {
      method: 'POST',
      url: `/api/access-requests/${requestId}/deny`,
    });
    assert.equal(deny.statusCode, 403);

    // The request is untouched and the owner can still act on it.
    const owned = await harness.authed(provider, {
      method: 'POST',
      url: `/api/access-requests/${requestId}/approve`,
    });
    assert.equal(owned.statusCode, 200);
  });

  it('keeps both ACL groups when two APIs are approved concurrently for one user', async () => {
    // The regression this guards: `PUT /consumers/{id}` is a whole-resource
    // replace with no concurrency token, so two GET→edit→PUT round trips that
    // interleave would drop one group. The Edge client's per-consumer queue is
    // what makes this pass.
    const firstApi = await publish(provider, 'concurrent-a');
    const secondApi = await publish(otherProvider, 'concurrent-b');
    const requestA = await request(secondClient, firstApi);
    const requestB = await request(secondClient, secondApi);

    const [approvalA, approvalB] = await Promise.all([
      harness.authed(provider, {
        method: 'POST',
        url: `/api/access-requests/${requestA}/approve`,
      }),
      harness.authed(otherProvider, {
        method: 'POST',
        url: `/api/access-requests/${requestB}/approve`,
      }),
    ]);
    assert.equal(approvalA.statusCode, 200);
    assert.equal(approvalB.statusCode, 200);

    const groups = groupsOf(secondClient.user.id);
    assert.ok(groups.includes(aclGroupForApi(firstApi)), 'the first group survived');
    assert.ok(groups.includes(aclGroupForApi(secondApi)), 'the second group survived');
    // …and exactly one consumer was created for the user, not two.
    const created = harness.edge.callsTo('POST', '/consumers').filter((call) => {
      const body = call.body as { username?: string } | null;
      return body?.username === consumerUsernameForUser(secondClient.user.id);
    });
    assert.equal(created.length, 1);
  });

  it('revokes idempotently: a second revoke is a conflict, not a double delete', async () => {
    const apiId = await publish(provider, 'double-revoke');
    const requestId = await request(client, apiId);
    const approval = await harness.authed(provider, {
      method: 'POST',
      url: `/api/access-requests/${requestId}/approve`,
    });
    const grantId = approval.json<ApproveAccessRequestResponse>().grant.id;

    const first = await harness.authed(provider, {
      method: 'POST',
      url: `/api/grants/${grantId}/revoke`,
    });
    assert.equal(first.statusCode, 200);
    const second = await harness.authed(provider, {
      method: 'POST',
      url: `/api/grants/${grantId}/revoke`,
    });
    assert.equal(second.statusCode, 409);
  });

  describe('listing scopes', () => {
    it('shows a client only their own requests and grants', async () => {
      const requests = await harness.authed(client, {
        method: 'GET',
        url: '/api/access-requests',
      });
      const rows = requests.json<ListAccessRequestsResponse>();
      assert.ok(rows.total > 0);
      assert.ok(rows.items.every((row) => row.user_id === client.user.id));
      // The joins the SPA renders are attached.
      assert.ok(rows.items[0]?.api?.slug);

      const grants = await harness.authed(client, { method: 'GET', url: '/api/grants' });
      assert.ok(
        grants.json<ListGrantsResponse>().items.every((row) => row.user_id === client.user.id),
      );
    });

    it('scopes a provider’s inbox to the APIs they own', async () => {
      const response = await harness.authed(provider, {
        method: 'GET',
        url: '/api/access-requests',
      });
      const owned = new Set(await harness.store.apis.listIdsByOwner(provider.user.id));
      const rows = response.json<ListAccessRequestsResponse>();
      assert.ok(rows.total > 0);
      assert.ok(rows.items.every((row) => owned.has(row.api_id)));
      assert.ok(rows.items.some((row) => row.user_id !== provider.user.id));
    });

    it('refuses a provider filtering by an API they do not own', async () => {
      const theirs = await harness.store.apis.listIdsByOwner(otherProvider.user.id);
      const response = await harness.authed(provider, {
        method: 'GET',
        url: `/api/access-requests?api_id=${theirs[0]}`,
      });
      assert.equal(response.statusCode, 403);
    });

    it('gives an admin every request and grant in the portal', async () => {
      const response = await harness.authed(founder, {
        method: 'GET',
        url: '/api/access-requests?limit=200',
      });
      const rows = response.json<ListAccessRequestsResponse>();
      const owners = new Set(rows.items.map((row) => row.api?.owner_user_id));
      assert.ok(owners.size > 1, 'an admin sees requests across several providers');

      const mine = await harness.authed(founder, {
        method: 'GET',
        url: '/api/access-requests?mine=true',
      });
      assert.equal(mine.json<ListAccessRequestsResponse>().total, 0);
    });

    it('filters grants by status', async () => {
      const response = await harness.authed(founder, {
        method: 'GET',
        url: '/api/grants?status=revoked&limit=200',
      });
      const rows = response.json<ListGrantsResponse>();
      assert.ok(rows.total > 0);
      assert.ok(rows.items.every((row) => row.status === 'revoked'));
    });
  });
});
