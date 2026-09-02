import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  aclGroupForApi,
  consumerUsernameForUser,
  type ApiErrorBody,
  type ApproveAccessRequestResponse,
  type CreateAccessRequestResponse,
  type GodBroadcastResponse,
  type GodDeleteApiResponse,
  type GodDisableUserResponse,
  type GodRevokeGrantResponse,
  type IssueCredentialResponse,
  type ListNotificationsResponse,
  type ListThreadsResponse,
  type PublishApiResponse,
} from '@ferrum-nexus/shared';

import { SAMPLE_SPEC_YAML, buildTestApp, type TestApp, type TestSession } from './helpers.js';

function errorCode(body: string): string {
  return (JSON.parse(body) as ApiErrorBody).error.code;
}

describe('API deletion and god mode', () => {
  let harness: TestApp;
  /** The first registered account, which is always the founding super_admin. */
  let superAdmin: TestSession;
  let admin: TestSession;
  let provider: TestSession;
  let client: TestSession;

  async function publish(owner: TestSession, slug: string): Promise<string> {
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

  /** Request access as `actor` and have `owner` approve it; returns the grant id. */
  async function grantAccess(
    actor: TestSession,
    owner: TestSession,
    apiId: string,
  ): Promise<string> {
    const created = await harness.authed(actor, {
      method: 'POST',
      url: '/api/access-requests',
      payload: { api_id: apiId, justification: 'Needed.' },
    });
    assert.equal(created.statusCode, 201, created.body);
    const requestId = created.json<CreateAccessRequestResponse>().access_request.id;
    const approved = await harness.authed(owner, {
      method: 'POST',
      url: `/api/access-requests/${requestId}/approve`,
    });
    assert.equal(approved.statusCode, 200, approved.body);
    return approved.json<ApproveAccessRequestResponse>().grant.id;
  }

  function groupsOf(userId: string): string[] {
    return harness.edge.consumerByUsername(consumerUsernameForUser(userId))?.acl_groups ?? [];
  }

  before(async () => {
    harness = await buildTestApp();
    superAdmin = await harness.registerUser({ email: 'god-super@example.test' });
    assert.equal(superAdmin.user.role, 'super_admin');

    const promoted = await harness.registerUser({
      email: 'god-admin@example.test',
      role: 'provider',
    });
    const patch = await harness.authed(superAdmin, {
      method: 'PATCH',
      url: `/api/users/${promoted.user.id}`,
      payload: { role: 'admin' },
    });
    assert.equal(patch.statusCode, 200, patch.body);
    admin = await harness.loginUser('god-admin@example.test');
    assert.equal(admin.user.role, 'admin');

    provider = await harness.registerUser({ email: 'god-provider@example.test', role: 'provider' });
    client = await harness.registerUser({ email: 'god-client@example.test', role: 'client' });
  });

  after(async () => {
    await harness.close();
  });

  describe('DELETE /api/apis/:id', () => {
    it('tears down the Edge objects, revokes every grant and notifies the grantees', async () => {
      const apiId = await publish(provider, 'delete-me');
      const proxyId = String(harness.edge.proxyByName('nexus-delete-me')?.id);
      await grantAccess(client, provider, apiId);
      assert.ok(groupsOf(client.user.id).includes(aclGroupForApi(apiId)));

      const response = await harness.authed(provider, {
        method: 'DELETE',
        url: `/api/apis/${apiId}`,
      });
      assert.equal(response.statusCode, 200);

      assert.equal(harness.edge.proxyByName('nexus-delete-me'), undefined);
      assert.equal(harness.edge.pluginsForProxy(proxyId).length, 0);
      assert.ok(
        !groupsOf(client.user.id).includes(aclGroupForApi(apiId)),
        'the ACL group is stripped from every grantee',
      );

      // Rows are cascaded, so the slug becomes reusable.
      assert.equal(await harness.store.apis.findById(apiId), null);
      assert.equal((await harness.store.grants.list({ api_id: apiId })).total, 0);
      assert.equal((await harness.store.accessRequests.list({ api_id: apiId })).total, 0);
      assert.equal((await harness.store.apiSpecs.list({ api_id: apiId })).total, 0);

      const bell = await harness.authed(client, {
        method: 'GET',
        url: '/api/notifications?type=access_revoked',
      });
      assert.ok(bell.json<ListNotificationsResponse>().total >= 1);

      const row = (await harness.auditRows('api.delete')).find((e) => e.target_id === apiId);
      assert.equal(row?.details.revoked_grants, 1);
    });

    it('refuses deletion by a provider who does not own the API', async () => {
      const apiId = await publish(provider, 'delete-guard');
      const stranger = await harness.registerUser({
        email: 'god-stranger@example.test',
        role: 'provider',
      });
      const response = await harness.authed(stranger, {
        method: 'DELETE',
        url: `/api/apis/${apiId}`,
      });
      assert.equal(response.statusCode, 403);
      assert.ok(harness.edge.proxyByName('nexus-delete-guard'));
    });
  });

  describe('authorization', () => {
    it('refuses every god endpoint to an ordinary admin', async () => {
      const calls: [string, Record<string, unknown>][] = [
        ['/api/admin/god/revoke-grant', { grant_id: 'x', reason: 'because' }],
        ['/api/admin/god/delete-api', { api_id: 'x', reason: 'because' }],
        ['/api/admin/god/disable-user', { user_id: 'x', reason: 'because' }],
        ['/api/admin/god/broadcast', { subject: 'Hi', body: 'There', audience: { scope: 'all' } }],
      ];
      for (const [url, payload] of calls) {
        const response = await harness.authed(admin, { method: 'POST', url, payload });
        assert.equal(response.statusCode, 403, url);
        assert.equal(errorCode(response.body), 'FORBIDDEN', url);
      }
    });

    it('refuses every god endpoint to a provider, before the admin hook even matters', async () => {
      const response = await harness.authed(provider, {
        method: 'POST',
        url: '/api/admin/god/broadcast',
        payload: { subject: 'Hi', body: 'There', audience: { scope: 'all' } },
      });
      assert.equal(response.statusCode, 403);
    });

    it('requires a non-empty reason on each destructive endpoint', async () => {
      for (const [url, payload] of [
        ['/api/admin/god/revoke-grant', { grant_id: 'x', reason: '   ' }],
        ['/api/admin/god/delete-api', { api_id: 'x' }],
        ['/api/admin/god/disable-user', { user_id: 'x', reason: '' }],
      ] as [string, Record<string, unknown>][]) {
        const response = await harness.authed(superAdmin, { method: 'POST', url, payload });
        assert.equal(response.statusCode, 400, url);
        assert.equal(errorCode(response.body), 'VALIDATION_FAILED', url);
      }
    });
  });

  describe('god/revoke-grant', () => {
    it('revokes a grant on an API the super_admin does not own', async () => {
      const apiId = await publish(provider, 'god-revoke');
      const grantId = await grantAccess(client, provider, apiId);
      assert.ok(groupsOf(client.user.id).includes(aclGroupForApi(apiId)));

      const response = await harness.authed(superAdmin, {
        method: 'POST',
        url: '/api/admin/god/revoke-grant',
        payload: { grant_id: grantId, reason: 'Credential leak reported.' },
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json<GodRevokeGrantResponse>().grant.status, 'revoked');
      assert.ok(!groupsOf(client.user.id).includes(aclGroupForApi(apiId)));

      // Two rows: the ordinary revocation, and the god-mode record with the reason.
      const godRow = (await harness.auditRows('god.revoke_grant')).find(
        (row) => row.target_id === grantId,
      );
      assert.equal(godRow?.details.reason, 'Credential leak reported.');
      assert.equal(godRow?.actor_role, 'super_admin');
      assert.ok(
        (await harness.auditRows('access.revoke')).some((row) => row.target_id === grantId),
      );
    });
  });

  describe('god/delete-api', () => {
    it('deletes another provider’s API and records each revocation individually', async () => {
      const apiId = await publish(provider, 'god-delete');
      await grantAccess(client, provider, apiId);

      const response = await harness.authed(superAdmin, {
        method: 'POST',
        url: '/api/admin/god/delete-api',
        payload: { api_id: apiId, reason: 'Exposes customer PII.', revoke_grants: true },
      });
      assert.equal(response.statusCode, 200, response.body);
      const body = response.json<GodDeleteApiResponse>();
      assert.equal(body.deleted_api_id, apiId);
      assert.equal(body.revoked_grants, 1);

      assert.equal(harness.edge.proxyByName('nexus-god-delete'), undefined);
      assert.equal(await harness.store.apis.findById(apiId), null);
      assert.ok(!groupsOf(client.user.id).includes(aclGroupForApi(apiId)));

      const godRow = (await harness.auditRows('god.delete_api')).find(
        (row) => row.target_id === apiId,
      );
      assert.equal(godRow?.details.reason, 'Exposes customer PII.');
      assert.equal(godRow?.details.owner_user_id, provider.user.id);
    });

    it('404s for an API that does not exist', async () => {
      const response = await harness.authed(superAdmin, {
        method: 'POST',
        url: '/api/admin/god/delete-api',
        payload: { api_id: 'no-such-api', reason: 'Cleanup.' },
      });
      assert.equal(response.statusCode, 404);
    });
  });

  describe('god/disable-user', () => {
    it('disables the account, kills its sessions and revokes its grants', async () => {
      const victim = await harness.registerUser({
        email: 'god-victim@example.test',
        role: 'client',
      });
      const apiId = await publish(provider, 'god-disable');
      await grantAccess(victim, provider, apiId);
      assert.ok(groupsOf(victim.user.id).includes(aclGroupForApi(apiId)));

      const response = await harness.authed(superAdmin, {
        method: 'POST',
        url: '/api/admin/god/disable-user',
        payload: { user_id: victim.user.id, reason: 'Account compromised.', revoke_grants: true },
      });
      assert.equal(response.statusCode, 200, response.body);
      const body = response.json<GodDisableUserResponse>();
      assert.equal(body.user.status, 'disabled');
      assert.equal(body.revoked_grants, 1);
      assert.ok(body.terminated_sessions >= 1);

      assert.ok(
        !groupsOf(victim.user.id).includes(aclGroupForApi(apiId)),
        'a disabled account keeps no gateway authorization',
      );

      // The victim's session no longer authenticates anything.
      const afterwards = await harness.authed(victim, { method: 'GET', url: '/api/catalog' });
      assert.equal(afterwards.statusCode, 401);

      const godRow = (await harness.auditRows('god.disable_user')).find(
        (row) => row.target_id === victim.user.id,
      );
      assert.equal(godRow?.details.reason, 'Account compromised.');
      assert.equal(godRow?.details.revoked_grants, 1);
    });

    it('deletes the gateway credentials of the account it disables', async () => {
      const victim = await harness.registerUser({
        email: 'god-credential-victim@example.test',
        role: 'client',
      });
      const issued = await harness.authed(victim, {
        method: 'POST',
        url: '/api/credentials',
        payload: { credential_type: 'keyauth' },
      });
      assert.equal(issued.statusCode, 201, issued.body);
      const credentialId = issued.json<IssueCredentialResponse>().credential.id;

      const username = consumerUsernameForUser(victim.user.id);
      assert.equal(harness.edge.consumerByUsername(username)?.credentials.keyauth?.length, 1);

      const response = await harness.authed(superAdmin, {
        method: 'POST',
        url: '/api/admin/god/disable-user',
        payload: { user_id: victim.user.id, reason: 'Key posted to a public repo.' },
      });
      assert.equal(response.statusCode, 200, response.body);

      // Sessions were never what kept the API key working.
      const consumer = harness.edge.consumerByUsername(username);
      assert.deepEqual(consumer?.credentials, {});
      assert.deepEqual(consumer?.acl_groups, []);
      assert.equal((await harness.store.credentials.findById(credentialId))?.status, 'revoked');

      const godRow = (await harness.auditRows('god.disable_user')).find(
        (row) => row.target_id === victim.user.id,
      );
      assert.equal(godRow?.details.gateway_teardown, 'ok');
      assert.equal(godRow?.details.revoked_credentials, 1);
    });

    it('refuses to disable the last active super_admin', async () => {
      const response = await harness.authed(superAdmin, {
        method: 'POST',
        url: '/api/admin/god/disable-user',
        payload: { user_id: superAdmin.user.id, reason: 'Testing the guard.' },
      });
      // Being the last super admin is why this is refused, and it is the
      // message that says how to fix it — promote someone else first. The
      // self-disable rule is the weaker one and must not mask it.
      assert.equal(response.statusCode, 409);
      assert.equal(errorCode(response.body), 'LAST_SUPER_ADMIN');

      const stillActive = await harness.store.users.findById(superAdmin.user.id);
      assert.equal(stillActive?.status, 'active');
    });

    it('still refuses an ordinary self-disable with CONFLICT', async () => {
      // A second seat, so the caller below is not the last super admin and the
      // self-disable rule is the only one left standing.
      const peer = await harness.registerUser({ email: 'god-self-disable@example.test' });
      const promoted = await harness.authed(superAdmin, {
        method: 'PATCH',
        url: `/api/users/${peer.user.id}`,
        payload: { role: 'super_admin' },
      });
      assert.equal(promoted.statusCode, 200, promoted.body);
      const peerSession = await harness.loginUser('god-self-disable@example.test');

      const response = await harness.authed(peerSession, {
        method: 'POST',
        url: '/api/admin/god/disable-user',
        payload: { user_id: peerSession.user.id, reason: 'Testing the guard.' },
      });
      assert.equal(response.statusCode, 409);
      assert.equal(errorCode(response.body), 'CONFLICT');

      const stillActive = await harness.store.users.findById(peerSession.user.id);
      assert.equal(stillActive?.status, 'active');
    });
  });

  describe('god/broadcast', () => {
    it('notifies every active account, opens a platform thread and skips email by default', async () => {
      const outboxBefore = (await harness.outbox()).length;

      const response = await harness.authed(superAdmin, {
        method: 'POST',
        url: '/api/admin/god/broadcast',
        payload: {
          subject: 'Scheduled gateway maintenance',
          body: 'The gateway is unavailable on Sunday 02:00–03:00 UTC.',
          audience: { scope: 'all' },
        },
      });
      assert.equal(response.statusCode, 200, response.body);
      const body = response.json<GodBroadcastResponse>();
      assert.ok(body.notified >= 3);
      assert.equal(body.threads_created, body.notified);
      assert.equal(body.emails_enqueued, 0);
      assert.equal((await harness.outbox()).length, outboxBefore, 'no email unless asked');

      const bell = await harness.authed(client, {
        method: 'GET',
        url: '/api/notifications?type=system',
      });
      const items = bell.json<ListNotificationsResponse>().items;
      assert.ok(items.some((item) => item.title === 'Scheduled gateway maintenance'));

      // It also lands in the recipient's platform inbox, so it survives the bell.
      const threads = await harness.authed(client, { method: 'GET', url: '/api/threads' });
      const thread = threads
        .json<ListThreadsResponse>()
        .items.find((entry) => entry.subject === 'Scheduled gateway maintenance');
      assert.ok(thread, 'the broadcast opens a platform thread for the recipient');
      assert.equal(thread.participant_b, null);
      assert.equal(thread.participant_a, client.user.id);

      const row = (await harness.auditRows('god.broadcast'))[0];
      assert.equal(row?.details.audience_scope, 'all');
      assert.equal(row?.details.threads_created, body.threads_created);
    });

    it('enqueues one email per recipient when send_email is set', async () => {
      const response = await harness.authed(superAdmin, {
        method: 'POST',
        url: '/api/admin/god/broadcast',
        payload: {
          subject: 'Security advisory',
          body: 'Rotate your gateway credentials before Friday.',
          audience: { scope: 'explicit', user_ids: [client.user.id, provider.user.id] },
          send_email: true,
        },
      });
      assert.equal(response.statusCode, 200, response.body);
      const body = response.json<GodBroadcastResponse>();
      assert.equal(body.notified, 2);
      assert.equal(body.emails_enqueued, 2);

      const queued = (await harness.outbox()).filter((row) =>
        row.subject.includes('Security advisory'),
      );
      assert.equal(queued.length, 2);
      assert.ok(queued.every((row) => row.body_text.includes('Rotate your gateway credentials')));
    });

    it('never sends the broadcasting super_admin their own announcement', async () => {
      const response = await harness.authed(superAdmin, {
        method: 'POST',
        url: '/api/admin/god/broadcast',
        payload: {
          subject: 'Not for me',
          body: 'Only the others should see this.',
          audience: { scope: 'all' },
        },
      });
      assert.equal(response.statusCode, 200);

      const bell = await harness.authed(superAdmin, {
        method: 'GET',
        url: '/api/notifications?limit=200',
      });
      assert.ok(
        !bell.json<ListNotificationsResponse>().items.some((item) => item.title === 'Not for me'),
      );
    });
  });
});
