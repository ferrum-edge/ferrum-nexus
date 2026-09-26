import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  aclGroupForApi,
  consumerUsernameForApplication,
  consumerUsernameForUser,
  testConsumerUsername,
  type ApproveAccessRequestResponse,
  type CreateAccessRequestResponse,
  type CreateApplicationResponse,
  type CreateOrganizationResponse,
  type IssueCredentialResponse,
  type PublishApiResponse,
} from '@ferrum-nexus/shared';

import { AuditAction } from '../audit/service.js';
import type { NexusStore } from '../db/store.js';
import { faultInjectingStore, type FaultInjectingStore } from './fault-injection.js';
import { buildTestApp, SAMPLE_SPEC_YAML, type TestApp, type TestSession } from './helpers.js';

/**
 * Privileged account transitions, destructive deletions, access decisions and
 * credential and plugin changes commit with their audit rows on every adapter.
 *
 * Each case fails an audit insert the operation makes and checks that nothing
 * of the change survived — or, for a deletion whose gateway work had already
 * run, that the recorded intent survived and the portal rows are still there
 * for the retry. It then repeats the request and checks that the retry
 * completes the change with exactly one audit row: a repeat of a change that
 * had committed unaudited used to find nothing left to do and record nothing.
 */
export function runPrivilegedAuditContract(
  label: string,
  makeStore: () => Promise<{ store: NexusStore; teardown: () => Promise<void> }>,
): void {
  describe(`privileged mutation audit contract — ${label}`, () => {
    let target: Awaited<ReturnType<typeof makeStore>>;
    let faults: FaultInjectingStore;
    let harness: TestApp;
    let founder: TestSession;
    let provider: TestSession;
    let slugs = 0;

    before(async () => {
      target = await makeStore();
      faults = faultInjectingStore(target.store);
      harness = await buildTestApp({ store: faults.store });
      founder = await harness.registerUser();
      provider = await harness.registerUser({ role: 'provider' });
    });

    after(async () => {
      await harness?.close();
      await target?.teardown();
    });

    function countAudit(action: string, targetId: string): Promise<number> {
      return target.store.auditLogs.count({ action, target_id: targetId });
    }

    async function signedIn(session: TestSession): Promise<boolean> {
      const response = await harness.authed(session, { method: 'GET', url: '/api/users/me' });
      return response.statusCode === 200;
    }

    /** An account holding a live API key on its own gateway consumer. */
    async function accountWithKey(role: 'client' | 'provider' = 'client'): Promise<TestSession> {
      const session = await harness.registerUser({ role });
      const issued = await harness.authed(session, {
        method: 'POST',
        url: '/api/credentials',
        payload: { credential_type: 'keyauth' },
      });
      assert.equal(issued.statusCode, 201, issued.body);
      assert.equal(keysOf(consumerUsernameForUser(session.user.id)), 1);
      return session;
    }

    function keysOf(username: string): number {
      return harness.edge.consumerByUsername(username)?.credentials.keyauth?.length ?? 0;
    }

    function patchUser(userId: string, payload: Record<string, unknown>) {
      return harness.authed(founder, { method: 'PATCH', url: `/api/users/${userId}`, payload });
    }

    function publishAs(slug: string) {
      return harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: {
          name: `Audited ${slug}`,
          slug,
          spec: SAMPLE_SPEC_YAML,
          auth_plugin: 'key_auth',
          requestable: true,
          visibility: 'public',
        },
      });
    }

    async function publish(): Promise<{ id: string; slug: string }> {
      slugs += 1;
      const slug = `audited-delete-${slugs}`;
      const response = await publishAs(slug);
      assert.equal(response.statusCode, 201, response.body);
      return { id: response.json<PublishApiResponse>().api.id, slug };
    }

    async function detailsOf(action: string, targetId: string): Promise<Record<string, unknown>> {
      const page = await target.store.auditLogs.list({ action, target_id: targetId }, { limit: 1 });
      const row = page.items[0];
      assert.ok(row, `an ${action} row for ${targetId}`);
      return row.details;
    }

    /* ── Account transitions ─────────────────────────────────────────────── */

    it('rolls back a promotion when its audit row fails', async () => {
      const account = await harness.registerUser();
      faults.failNext('auditLogs', 'create');
      const failed = await patchUser(account.user.id, { role: 'admin' });
      assert.equal(failed.statusCode, 500, failed.body);
      assert.deepEqual(faults.pending(), [], 'the intended failure was reached');
      assert.equal((await target.store.users.findById(account.user.id))?.role, 'client');
      assert.equal(await countAudit(AuditAction.USER_ROLE_CHANGE, account.user.id), 0);

      // The repeat is a real change again, so it is made and recorded.
      const retried = await patchUser(account.user.id, { role: 'admin' });
      assert.equal(retried.statusCode, 200, retried.body);
      assert.equal((await target.store.users.findById(account.user.id))?.role, 'admin');
      assert.equal(await countAudit(AuditAction.USER_ROLE_CHANGE, account.user.id), 1);
    });

    it('rolls back a demotion and disable when its second audit row fails', async () => {
      const account = await accountWithKey('provider');
      const username = consumerUsernameForUser(account.user.id);
      // The role-change row goes in; the disable row after it fails.
      faults.failAfter('auditLogs', 'create', 1);
      const failed = await patchUser(account.user.id, { role: 'client', status: 'disabled' });
      assert.equal(failed.statusCode, 500, failed.body);
      assert.deepEqual(faults.pending(), [], 'the intended failure was reached');
      const stored = await target.store.users.findById(account.user.id);
      assert.equal(stored?.role, 'provider');
      assert.equal(stored?.status, 'active');
      assert.equal(await target.store.gatewayTeardownJobs.findByUser(account.user.id), null);
      assert.ok(await signedIn(account), 'no session was terminated');
      assert.equal(keysOf(username), 1, 'the gateway was not touched');
      assert.equal(await countAudit(AuditAction.USER_ROLE_CHANGE, account.user.id), 0);
      assert.equal(await countAudit(AuditAction.USER_DISABLE, account.user.id), 0);

      const retried = await patchUser(account.user.id, { role: 'client', status: 'disabled' });
      assert.equal(retried.statusCode, 200, retried.body);
      const changed = await target.store.users.findById(account.user.id);
      assert.equal(changed?.role, 'client');
      assert.equal(changed?.status, 'disabled');
      assert.equal(await signedIn(account), false);
      assert.equal(keysOf(username), 0);
      assert.equal(await countAudit(AuditAction.USER_ROLE_CHANGE, account.user.id), 1);
      assert.equal(await countAudit(AuditAction.USER_DISABLE, account.user.id), 1);
      assert.equal(
        await countAudit(AuditAction.USER_GATEWAY_TEARDOWN_COMPLETE, account.user.id),
        1,
      );
    });

    it('rolls back a re-enable when its audit row fails', async () => {
      const account = await accountWithKey();
      assert.equal((await patchUser(account.user.id, { status: 'disabled' })).statusCode, 200);
      const job = await target.store.gatewayTeardownJobs.findByUser(account.user.id);
      assert.ok(job, 'the disable left its revocation record');
      const consumerWrites = harness.edge.callsTo('PUT', '/consumers/').length;

      faults.failNext('auditLogs', 'create');
      const failed = await patchUser(account.user.id, { status: 'active' });
      assert.equal(failed.statusCode, 500, failed.body);
      assert.deepEqual(faults.pending(), [], 'the intended failure was reached');
      assert.equal((await target.store.users.findById(account.user.id))?.status, 'disabled');
      assert.deepEqual(await target.store.gatewayTeardownJobs.findByUser(account.user.id), job);
      assert.equal(harness.edge.callsTo('PUT', '/consumers/').length, consumerWrites);
      assert.equal(await countAudit(AuditAction.USER_ENABLE, account.user.id), 0);

      const retried = await patchUser(account.user.id, { status: 'active' });
      assert.equal(retried.statusCode, 200, retried.body);
      assert.equal((await target.store.users.findById(account.user.id))?.status, 'active');
      assert.equal(await target.store.gatewayTeardownJobs.findByUser(account.user.id), null);
      assert.equal(await countAudit(AuditAction.USER_ENABLE, account.user.id), 1);
    });

    it('records a gateway-restore retry before touching the gateway', async () => {
      const account = await accountWithKey();
      const consumerWrites = harness.edge.callsTo('PUT', '/consumers/').length;
      faults.failNext('auditLogs', 'create');
      const failed = await patchUser(account.user.id, { status: 'active' });
      assert.equal(failed.statusCode, 500, failed.body);
      assert.deepEqual(faults.pending(), [], 'the intended failure was reached');
      assert.equal(harness.edge.callsTo('PUT', '/consumers/').length, consumerWrites);
      assert.equal(await countAudit(AuditAction.USER_ENABLE, account.user.id), 0);

      const retried = await patchUser(account.user.id, { status: 'active' });
      assert.equal(retried.statusCode, 200, retried.body);
      assert.equal(await countAudit(AuditAction.USER_ENABLE, account.user.id), 1);
    });

    it('rolls back an administrative profile edit when its audit row fails', async () => {
      const account = await harness.registerUser();
      faults.failNext('auditLogs', 'create');
      const failed = await patchUser(account.user.id, { display_name: 'Renamed by an admin' });
      assert.equal(failed.statusCode, 500, failed.body);
      assert.deepEqual(faults.pending(), [], 'the intended failure was reached');
      assert.equal(
        (await target.store.users.findById(account.user.id))?.display_name,
        account.user.display_name,
      );
      assert.equal(await countAudit(AuditAction.USER_UPDATE, account.user.id), 0);

      const retried = await patchUser(account.user.id, { display_name: 'Renamed by an admin' });
      assert.equal(retried.statusCode, 200, retried.body);
      assert.equal(await countAudit(AuditAction.USER_UPDATE, account.user.id), 1);
    });

    it('re-queues nothing and touches no gateway when a teardown retry cannot be recorded', async () => {
      const account = await accountWithKey();
      const username = consumerUsernameForUser(account.user.id);
      harness.edge.queueFailure(500, { error: 'gateway exploded' }, '/consumers');
      assert.equal((await patchUser(account.user.id, { status: 'disabled' })).statusCode, 200);
      const pending = await target.store.gatewayTeardownJobs.findByUser(account.user.id);
      assert.equal(pending?.status, 'pending');
      assert.equal(keysOf(username), 1, 'the key is still live, owed to the worker');

      const retry = () =>
        harness.authed(founder, {
          method: 'POST',
          url: `/api/users/${account.user.id}/gateway-teardown/retry`,
        });
      faults.failNext('auditLogs', 'create');
      const failed = await retry();
      assert.equal(failed.statusCode, 500, failed.body);
      assert.deepEqual(faults.pending(), [], 'the intended failure was reached');
      assert.deepEqual(await target.store.gatewayTeardownJobs.findByUser(account.user.id), pending);
      assert.equal(keysOf(username), 1, 'no unrecorded attempt reached the gateway');
      assert.equal(await countAudit(AuditAction.USER_GATEWAY_TEARDOWN_RETRY, account.user.id), 0);

      const retried = await retry();
      assert.equal(retried.statusCode, 200, retried.body);
      assert.equal(keysOf(username), 0);
      assert.equal(await countAudit(AuditAction.USER_GATEWAY_TEARDOWN_RETRY, account.user.id), 1);
      assert.equal(
        await countAudit(AuditAction.USER_GATEWAY_TEARDOWN_COMPLETE, account.user.id),
        1,
      );
    });

    it('rolls back a god-mode disable when its second audit row fails', async () => {
      const account = await accountWithKey();
      const username = consumerUsernameForUser(account.user.id);
      const disable = () =>
        harness.authed(founder, {
          method: 'POST',
          url: '/api/admin/god/disable-user',
          payload: { user_id: account.user.id, reason: 'Audit contract', revoke_grants: false },
        });
      // `user.disable` goes in; `god.disable_user` after it fails.
      faults.failAfter('auditLogs', 'create', 1);
      const failed = await disable();
      assert.equal(failed.statusCode, 500, failed.body);
      assert.deepEqual(faults.pending(), [], 'the intended failure was reached');
      assert.equal((await target.store.users.findById(account.user.id))?.status, 'active');
      assert.equal(await target.store.gatewayTeardownJobs.findByUser(account.user.id), null);
      assert.ok(await signedIn(account), 'no session was terminated');
      assert.equal(keysOf(username), 1, 'the gateway was not touched');
      assert.equal(await countAudit(AuditAction.USER_DISABLE, account.user.id), 0);
      assert.equal(await countAudit(AuditAction.GOD_DISABLE_USER, account.user.id), 0);

      const retried = await disable();
      assert.equal(retried.statusCode, 200, retried.body);
      assert.equal((await target.store.users.findById(account.user.id))?.status, 'disabled');
      assert.equal(keysOf(username), 0);
      assert.equal(await countAudit(AuditAction.USER_DISABLE, account.user.id), 1);
      assert.equal(await countAudit(AuditAction.GOD_DISABLE_USER, account.user.id), 1);
      assert.equal(await countAudit(AuditAction.GOD_DISABLE_USER_COMPLETE, account.user.id), 1);
    });

    /* ── Deletions ───────────────────────────────────────────────────────── */

    async function applicationWithKey(owner: TestSession): Promise<string> {
      const created = await harness.authed(owner, {
        method: 'POST',
        url: '/api/applications',
        payload: { name: `Audited application ${slugs++}` },
      });
      assert.equal(created.statusCode, 201, created.body);
      const applicationId = created.json<CreateApplicationResponse>().application.id;
      const issued = await harness.authed(owner, {
        method: 'POST',
        url: '/api/credentials',
        payload: { credential_type: 'keyauth', application_id: applicationId },
      });
      assert.equal(issued.statusCode, 201, issued.body);
      assert.ok(harness.edge.consumerByUsername(consumerUsernameForApplication(applicationId)));
      return applicationId;
    }

    it('deletes no application, and no gateway identity, when the intent cannot be recorded', async () => {
      const owner = await harness.registerUser();
      const applicationId = await applicationWithKey(owner);
      faults.failNext('auditLogs', 'create');
      const failed = await harness.authed(owner, {
        method: 'DELETE',
        url: `/api/applications/${applicationId}`,
      });
      assert.equal(failed.statusCode, 500, failed.body);
      assert.deepEqual(faults.pending(), [], 'the intended failure was reached');
      assert.ok(await target.store.applications.findById(applicationId));
      assert.ok(harness.edge.consumerByUsername(consumerUsernameForApplication(applicationId)));
      assert.equal(await countAudit(AuditAction.APPLICATION_DELETE_START, applicationId), 0);
      assert.equal(await countAudit(AuditAction.APPLICATION_DELETE, applicationId), 0);
    });

    it('keeps the application for the retry when its delete cannot be recorded', async () => {
      const owner = await harness.registerUser();
      const applicationId = await applicationWithKey(owner);
      const remove = () =>
        harness.authed(owner, { method: 'DELETE', url: `/api/applications/${applicationId}` });
      // The intent row goes in and the consumer comes down; the delete's own
      // row then fails, and takes the row deletion back with it.
      faults.failAfter('auditLogs', 'create', 1);
      const failed = await remove();
      assert.equal(failed.statusCode, 500, failed.body);
      assert.deepEqual(faults.pending(), [], 'the intended failure was reached');
      assert.ok(
        await target.store.applications.findById(applicationId),
        'the application survives for the retry',
      );
      assert.equal(
        harness.edge.consumerByUsername(consumerUsernameForApplication(applicationId)),
        undefined,
      );
      assert.equal(await countAudit(AuditAction.APPLICATION_DELETE_START, applicationId), 1);
      assert.equal(await countAudit(AuditAction.APPLICATION_DELETE, applicationId), 0);

      const retried = await remove();
      assert.equal(retried.statusCode, 200, retried.body);
      assert.equal(await target.store.applications.findById(applicationId), null);
      assert.equal(await countAudit(AuditAction.APPLICATION_DELETE, applicationId), 1);
    });

    it('deletes no API, and leaves its proxy serving, when the intent cannot be recorded', async () => {
      const api = await publish();
      faults.failNext('auditLogs', 'create');
      const failed = await harness.authed(provider, {
        method: 'DELETE',
        url: `/api/apis/${api.id}`,
      });
      assert.equal(failed.statusCode, 500, failed.body);
      assert.deepEqual(faults.pending(), [], 'the intended failure was reached');
      assert.ok(await target.store.apis.findById(api.id));
      assert.ok(harness.edge.proxyServing(`/nexus/${api.slug}`), 'the proxy is still up');
      assert.equal(await countAudit(AuditAction.API_DELETE_START, api.id), 0);
      assert.equal(await countAudit(AuditAction.API_DELETE, api.id), 0);
    });

    it('keeps the API for the retry when its delete cannot be recorded', async () => {
      const api = await publish();
      const remove = () =>
        harness.authed(provider, { method: 'DELETE', url: `/api/apis/${api.id}` });
      faults.failAfter('auditLogs', 'create', 1);
      const failed = await remove();
      assert.equal(failed.statusCode, 500, failed.body);
      assert.deepEqual(faults.pending(), [], 'the intended failure was reached');
      assert.ok(await target.store.apis.findById(api.id), 'the API survives for the retry');
      assert.equal(harness.edge.proxyServing(`/nexus/${api.slug}`), undefined);
      assert.equal(await countAudit(AuditAction.API_DELETE_START, api.id), 1);
      assert.equal(await countAudit(AuditAction.API_DELETE, api.id), 0);

      const retried = await remove();
      assert.equal(retried.statusCode, 200, retried.body);
      assert.equal(await target.store.apis.findById(api.id), null);
      assert.equal(await countAudit(AuditAction.API_DELETE, api.id), 1);
    });

    it('commits a god-mode API delete with both of its rows or with neither', async () => {
      const api = await publish();
      const remove = () =>
        harness.authed(founder, {
          method: 'POST',
          url: '/api/admin/god/delete-api',
          payload: { api_id: api.id, reason: 'Audit contract', revoke_grants: false },
        });
      // Intent, then `api.delete`; the god-mode row after it fails.
      faults.failAfter('auditLogs', 'create', 2);
      const failed = await remove();
      assert.equal(failed.statusCode, 500, failed.body);
      assert.deepEqual(faults.pending(), [], 'the intended failure was reached');
      assert.ok(await target.store.apis.findById(api.id), 'the API survives for the retry');
      assert.equal(await countAudit(AuditAction.API_DELETE, api.id), 0);
      assert.equal(await countAudit(AuditAction.GOD_DELETE_API, api.id), 0);

      const retried = await remove();
      assert.equal(retried.statusCode, 200, retried.body);
      assert.equal(await target.store.apis.findById(api.id), null);
      assert.equal(await countAudit(AuditAction.API_DELETE, api.id), 1);
      assert.equal(await countAudit(AuditAction.GOD_DELETE_API, api.id), 1);
    });

    /* ── Access decisions ────────────────────────────────────────────────── */

    function groupsOf(userId: string): string[] {
      return harness.edge.consumerByUsername(consumerUsernameForUser(userId))?.acl_groups ?? [];
    }

    async function requestAccess(client: TestSession, apiId: string): Promise<string> {
      const response = await harness.authed(client, {
        method: 'POST',
        url: '/api/access-requests',
        payload: { api_id: apiId, justification: 'Audit contract' },
      });
      assert.equal(response.statusCode, 201, response.body);
      return response.json<CreateAccessRequestResponse>().access_request.id;
    }

    function approve(requestId: string) {
      return harness.authed(provider, {
        method: 'POST',
        url: `/api/access-requests/${requestId}/approve`,
        payload: {},
      });
    }

    /** A client with a live key, holding an approved grant for a fresh API. */
    async function grantee(): Promise<{ client: TestSession; apiId: string; grantId: string }> {
      const client = await accountWithKey();
      const api = await publish();
      const approved = await approve(await requestAccess(client, api.id));
      assert.equal(approved.statusCode, 200, approved.body);
      const grantId = approved.json<ApproveAccessRequestResponse>().grant.id;
      assert.deepEqual(groupsOf(client.user.id), [aclGroupForApi(api.id)]);
      return { client, apiId: api.id, grantId };
    }

    it('grants no access, and leaves no group, when an approval cannot be recorded', async () => {
      const client = await accountWithKey();
      const api = await publish();
      const requestId = await requestAccess(client, api.id);
      faults.failNext('auditLogs', 'create');
      const failed = await approve(requestId);
      assert.equal(failed.statusCode, 500, failed.body);
      assert.deepEqual(faults.pending(), [], 'the intended failure was reached');
      assert.equal(
        await target.store.grants.findActiveByApiAndUser(api.id, client.user.id, null),
        null,
      );
      assert.equal((await target.store.accessRequests.findById(requestId))?.status, 'pending');
      assert.deepEqual(groupsOf(client.user.id), [], 'the ACL group came back off');
      assert.equal(await countAudit(AuditAction.ACCESS_APPROVE, requestId), 0);

      const retried = await approve(requestId);
      assert.equal(retried.statusCode, 200, retried.body);
      assert.deepEqual(groupsOf(client.user.id), [aclGroupForApi(api.id)]);
      assert.equal(await countAudit(AuditAction.ACCESS_APPROVE, requestId), 1);
    });

    it('leaves a grant active, and its group on, when its revocation cannot be recorded', async () => {
      const { client, apiId, grantId } = await grantee();
      const revoke = () =>
        harness.authed(provider, {
          method: 'POST',
          url: `/api/grants/${grantId}/revoke`,
          payload: { reason: 'Audit contract' },
        });
      faults.failNext('auditLogs', 'create');
      const failed = await revoke();
      assert.equal(failed.statusCode, 500, failed.body);
      assert.deepEqual(faults.pending(), [], 'the intended failure was reached');
      assert.equal((await target.store.grants.findById(grantId))?.status, 'active');
      assert.deepEqual(groupsOf(client.user.id), [aclGroupForApi(apiId)], 'the gateway untouched');
      assert.equal(await countAudit(AuditAction.ACCESS_REVOKE, grantId), 0);

      const retried = await revoke();
      assert.equal(retried.statusCode, 200, retried.body);
      assert.equal((await target.store.grants.findById(grantId))?.status, 'revoked');
      assert.deepEqual(groupsOf(client.user.id), []);
      assert.equal(await countAudit(AuditAction.ACCESS_REVOKE, grantId), 1);
    });

    it('commits a god-mode revocation with both of its rows or with neither', async () => {
      const { client, apiId, grantId } = await grantee();
      const revoke = () =>
        harness.authed(founder, {
          method: 'POST',
          url: '/api/admin/god/revoke-grant',
          payload: { grant_id: grantId, reason: 'Audit contract' },
        });
      // `access.revoke` goes in; `god.revoke_grant` after it fails.
      faults.failAfter('auditLogs', 'create', 1);
      const failed = await revoke();
      assert.equal(failed.statusCode, 500, failed.body);
      assert.deepEqual(faults.pending(), [], 'the intended failure was reached');
      assert.equal((await target.store.grants.findById(grantId))?.status, 'active');
      assert.deepEqual(groupsOf(client.user.id), [aclGroupForApi(apiId)]);
      assert.equal(await countAudit(AuditAction.ACCESS_REVOKE, grantId), 0);
      assert.equal(await countAudit(AuditAction.GOD_REVOKE_GRANT, grantId), 0);

      const retried = await revoke();
      assert.equal(retried.statusCode, 200, retried.body);
      assert.equal((await target.store.grants.findById(grantId))?.status, 'revoked');
      assert.equal(await countAudit(AuditAction.ACCESS_REVOKE, grantId), 1);
      assert.equal(await countAudit(AuditAction.GOD_REVOKE_GRANT, grantId), 1);
    });

    it('leaves a request pending when its denial cannot be recorded', async () => {
      const client = await harness.registerUser();
      const api = await publish();
      const requestId = await requestAccess(client, api.id);
      const deny = () =>
        harness.authed(provider, {
          method: 'POST',
          url: `/api/access-requests/${requestId}/deny`,
          payload: {},
        });
      faults.failNext('auditLogs', 'create');
      const failed = await deny();
      assert.equal(failed.statusCode, 500, failed.body);
      assert.deepEqual(faults.pending(), [], 'the intended failure was reached');
      assert.equal((await target.store.accessRequests.findById(requestId))?.status, 'pending');

      const retried = await deny();
      assert.equal(retried.statusCode, 200, retried.body);
      assert.equal((await target.store.accessRequests.findById(requestId))?.status, 'denied');
      assert.equal(await countAudit(AuditAction.ACCESS_DENY, requestId), 1);
    });

    /* ── Credentials ─────────────────────────────────────────────────────── */

    function issueKey(session: TestSession) {
      return harness.authed(session, {
        method: 'POST',
        url: '/api/credentials',
        payload: { credential_type: 'keyauth' },
      });
    }

    it('withdraws the key it appended when an issue cannot be recorded', async () => {
      const account = await harness.registerUser();
      const username = consumerUsernameForUser(account.user.id);
      const issued = () =>
        target.store.auditLogs.count({
          action: AuditAction.CREDENTIAL_ISSUE,
          actor_user_id: account.user.id,
        });
      faults.failNext('auditLogs', 'create');
      const failed = await issueKey(account);
      assert.equal(failed.statusCode, 500, failed.body);
      assert.deepEqual(faults.pending(), [], 'the intended failure was reached');
      assert.equal(keysOf(username), 0, 'no live key that nobody was handed');
      const rows = await target.store.credentials.list({ user_id: account.user.id });
      assert.equal(rows.total, 0);
      assert.equal(await issued(), 0);

      const retried = await issueKey(account);
      assert.equal(retried.statusCode, 201, retried.body);
      assert.equal(keysOf(username), 1);
      assert.equal(await issued(), 1);
    });

    it('revokes nothing when a revocation cannot record its start', async () => {
      const account = await harness.registerUser();
      const response = await issueKey(account);
      assert.equal(response.statusCode, 201, response.body);
      const credentialId = response.json<IssueCredentialResponse>().credential.id;
      faults.failNext('auditLogs', 'create');
      const failed = await harness.authed(account, {
        method: 'DELETE',
        url: `/api/credentials/${credentialId}`,
      });
      assert.equal(failed.statusCode, 500, failed.body);
      assert.deepEqual(faults.pending(), [], 'the intended failure was reached');
      assert.equal((await target.store.credentials.findById(credentialId))?.status, 'active');
      assert.equal(keysOf(consumerUsernameForUser(account.user.id)), 1, 'the key still works');
      assert.equal(await countAudit(AuditAction.CREDENTIAL_REVOKE_START, credentialId), 0);
      assert.equal(await countAudit(AuditAction.CREDENTIAL_REVOKE, credentialId), 0);
    });

    it('records a revocation on the repeat when its completion cannot be recorded', async () => {
      const account = await harness.registerUser();
      const response = await issueKey(account);
      assert.equal(response.statusCode, 201, response.body);
      const credentialId = response.json<IssueCredentialResponse>().credential.id;
      const username = consumerUsernameForUser(account.user.id);
      const revoke = () =>
        harness.authed(account, { method: 'DELETE', url: `/api/credentials/${credentialId}` });
      // The start row goes in and the key comes off; the completion fails.
      faults.failAfter('auditLogs', 'create', 1);
      const failed = await revoke();
      assert.equal(failed.statusCode, 500, failed.body);
      assert.deepEqual(faults.pending(), [], 'the intended failure was reached');
      assert.equal(keysOf(username), 0, 'the key is gone from the gateway');
      assert.equal((await target.store.credentials.findById(credentialId))?.status, 'retiring');
      assert.equal(await countAudit(AuditAction.CREDENTIAL_REVOKE_START, credentialId), 1);
      assert.equal(await countAudit(AuditAction.CREDENTIAL_REVOKE, credentialId), 0);

      const retried = await revoke();
      assert.equal(retried.statusCode, 200, retried.body);
      assert.equal((await target.store.credentials.findById(credentialId))?.status, 'revoked');
      assert.equal(await countAudit(AuditAction.CREDENTIAL_REVOKE, credentialId), 1);
    });

    /* ── Plugins ─────────────────────────────────────────────────────────── */

    async function proxyOf(apiId: string): Promise<string> {
      const proxyId = (await target.store.apis.findById(apiId))?.ferrum_proxy_id;
      assert.ok(proxyId);
      return proxyId;
    }

    function setCompression(apiId: string) {
      return harness.authed(provider, {
        method: 'PUT',
        url: `/api/apis/${apiId}/plugins/compression`,
        payload: { config: {} },
      });
    }

    function removeCompression(apiId: string) {
      return harness.authed(provider, {
        method: 'DELETE',
        url: `/api/apis/${apiId}/plugins/compression`,
      });
    }

    it('leaves no plugin on the gateway when setting it cannot be recorded', async () => {
      const api = await publish();
      const proxyId = await proxyOf(api.id);
      faults.failNext('auditLogs', 'create');
      const failed = await setCompression(api.id);
      assert.equal(failed.statusCode, 500, failed.body);
      assert.deepEqual(faults.pending(), [], 'the intended failure was reached');
      assert.equal(await target.store.apiPlugins.find(api.id, 'compression'), null);
      assert.equal(harness.edge.pluginForProxy(proxyId, 'compression'), undefined);
      assert.equal(await countAudit(AuditAction.API_PLUGIN_SET, api.id), 0);

      const retried = await setCompression(api.id);
      assert.equal(retried.statusCode, 200, retried.body);
      assert.ok(harness.edge.pluginForProxy(proxyId, 'compression'));
      assert.equal(await countAudit(AuditAction.API_PLUGIN_SET, api.id), 1);
    });

    it('removes no plugin when a removal cannot record its start', async () => {
      const api = await publish();
      const proxyId = await proxyOf(api.id);
      assert.equal((await setCompression(api.id)).statusCode, 200);
      faults.failNext('auditLogs', 'create');
      const failed = await removeCompression(api.id);
      assert.equal(failed.statusCode, 500, failed.body);
      assert.deepEqual(faults.pending(), [], 'the intended failure was reached');
      assert.ok(await target.store.apiPlugins.find(api.id, 'compression'));
      assert.ok(harness.edge.pluginForProxy(proxyId, 'compression'), 'the config is untouched');
      assert.equal(await countAudit(AuditAction.API_PLUGIN_REMOVE_START, api.id), 0);
      assert.equal(await countAudit(AuditAction.API_PLUGIN_REMOVE, api.id), 0);
    });

    it('puts the config back when a plugin removal cannot be recorded', async () => {
      const api = await publish();
      const proxyId = await proxyOf(api.id);
      assert.equal((await setCompression(api.id)).statusCode, 200);
      const plugin = await target.store.apiPlugins.find(api.id, 'compression');
      const owned = plugin?.ferrum_plugin_config_id;
      assert.ok(owned);
      // The intent row goes in and the config comes off; the removal's own
      // row then fails, and takes the row deletion back with it.
      faults.failAfter('auditLogs', 'create', 1);
      const failed = await removeCompression(api.id);
      assert.equal(failed.statusCode, 500, failed.body);
      assert.deepEqual(faults.pending(), [], 'the intended failure was reached');
      assert.ok(await target.store.apiPlugins.find(api.id, 'compression'), 'the row survives');
      assert.equal(
        harness.edge.pluginForProxy(proxyId, 'compression')?.id,
        owned,
        'the config is back under the id the row records',
      );
      assert.equal(await countAudit(AuditAction.API_PLUGIN_REMOVE_START, api.id), 1);
      assert.equal(await countAudit(AuditAction.API_PLUGIN_REMOVE, api.id), 0);

      const retried = await removeCompression(api.id);
      assert.equal(retried.statusCode, 200, retried.body);
      assert.equal(await target.store.apiPlugins.find(api.id, 'compression'), null);
      assert.equal(harness.edge.pluginForProxy(proxyId, 'compression'), undefined);
      assert.equal(await countAudit(AuditAction.API_PLUGIN_REMOVE, api.id), 1);
      const details = await detailsOf(AuditAction.API_PLUGIN_REMOVE, api.id);
      assert.equal(details.was_attached, true);
      assert.equal(details.plugin_config_id, owned);
    });

    it('names the config an earlier removal deleted when its undo could not restore it', async () => {
      const api = await publish();
      const proxyId = await proxyOf(api.id);
      assert.equal((await setCompression(api.id)).statusCode, 200);
      const plugin = await target.store.apiPlugins.find(api.id, 'compression');
      const owned = plugin?.ferrum_plugin_config_id;
      assert.ok(owned);
      faults.failAfter('auditLogs', 'create', 1);
      // …and the gateway refuses the recreate that would have undone it.
      harness.edge.queueFailure(500, { error: 'refused' }, '/plugins/config', 'POST');
      const failed = await removeCompression(api.id);
      assert.equal(failed.statusCode, 500, failed.body);
      assert.deepEqual(faults.pending(), [], 'the intended failure was reached');
      assert.ok(await target.store.apiPlugins.find(api.id, 'compression'), 'the row survives');
      assert.equal(harness.edge.pluginForProxy(proxyId, 'compression'), undefined);

      const retried = await removeCompression(api.id);
      assert.equal(retried.statusCode, 200, retried.body);
      assert.equal(await target.store.apiPlugins.find(api.id, 'compression'), null);
      // The repeat found the config already gone, and still names it.
      const details = await detailsOf(AuditAction.API_PLUGIN_REMOVE, api.id);
      assert.equal(details.was_attached, true);
      assert.equal(details.plugin_config_id, owned);
      assert.equal(details.resumed, true);
    });

    /* ── Publishing and organizations ────────────────────────────────────── */

    it('takes a new API back off the gateway when its publish cannot be recorded', async () => {
      slugs += 1;
      const slug = `audited-publish-${slugs}`;
      faults.failNext('auditLogs', 'create');
      const failed = await publishAs(slug);
      assert.equal(failed.statusCode, 500, failed.body);
      assert.deepEqual(faults.pending(), [], 'the intended failure was reached');
      assert.equal(await target.store.apis.findBySlug(slug), null);
      assert.equal(harness.edge.proxyServing(`/nexus/${slug}`), undefined);

      const retried = await publishAs(slug);
      assert.equal(retried.statusCode, 201, retried.body);
      const apiId = retried.json<PublishApiResponse>().api.id;
      assert.equal(await countAudit(AuditAction.API_PUBLISH, apiId), 1);
    });

    it('rolls back an API edit when its audit row fails', async () => {
      const api = await publish();
      const edit = () =>
        harness.authed(provider, {
          method: 'PATCH',
          url: `/api/apis/${api.id}`,
          payload: { description: 'Edited under audit' },
        });
      faults.failNext('auditLogs', 'create');
      const failed = await edit();
      assert.equal(failed.statusCode, 500, failed.body);
      assert.deepEqual(faults.pending(), [], 'the intended failure was reached');
      assert.notEqual(
        (await target.store.apis.findById(api.id))?.description,
        'Edited under audit',
      );
      assert.equal(await countAudit(AuditAction.API_UPDATE, api.id), 0);

      const retried = await edit();
      assert.equal(retried.statusCode, 200, retried.body);
      assert.equal((await target.store.apis.findById(api.id))?.description, 'Edited under audit');
      assert.equal(await countAudit(AuditAction.API_UPDATE, api.id), 1);
    });

    it('tears a new test consumer back down when its creation cannot be recorded', async () => {
      const api = await publish();
      const username = testConsumerUsername(api.id);
      const create = () =>
        harness.authed(provider, {
          method: 'POST',
          url: `/api/apis/${api.id}/test-consumer`,
          payload: {},
        });
      faults.failNext('auditLogs', 'create');
      const failed = await create();
      assert.equal(failed.statusCode, 500, failed.body);
      assert.deepEqual(faults.pending(), [], 'the intended failure was reached');
      assert.equal(harness.edge.consumerByUsername(username), undefined);
      assert.equal(await countAudit(AuditAction.TEST_CONSUMER_CREATE, api.id), 0);

      const retried = await create();
      assert.equal(retried.statusCode, 201, retried.body);
      assert.ok(harness.edge.consumerByUsername(username));
      assert.equal(await countAudit(AuditAction.TEST_CONSUMER_CREATE, api.id), 1);
    });

    it('creates and edits no organization when its audit row fails', async () => {
      const name = `Audited organization ${slugs++}`;
      const create = () =>
        harness.authed(founder, { method: 'POST', url: '/api/organizations', payload: { name } });
      async function named(value: string): Promise<boolean> {
        const page = await target.store.organizations.list({ limit: 200 });
        return page.items.some((organization) => organization.name === value);
      }
      faults.failNext('auditLogs', 'create');
      const failed = await create();
      assert.equal(failed.statusCode, 500, failed.body);
      assert.deepEqual(faults.pending(), [], 'the intended failure was reached');
      assert.equal(await named(name), false);

      const created = await create();
      assert.equal(created.statusCode, 201, created.body);
      const organizationId = created.json<CreateOrganizationResponse>().organization.id;
      assert.equal(await countAudit(AuditAction.ORG_CREATE, organizationId), 1);

      const rename = () =>
        harness.authed(founder, {
          method: 'PATCH',
          url: `/api/organizations/${organizationId}`,
          payload: { name: `${name} renamed` },
        });
      faults.failNext('auditLogs', 'create');
      const failedRename = await rename();
      assert.equal(failedRename.statusCode, 500, failedRename.body);
      assert.deepEqual(faults.pending(), [], 'the intended failure was reached');
      assert.equal((await target.store.organizations.findById(organizationId))?.name, name);

      const renamed = await rename();
      assert.equal(renamed.statusCode, 200, renamed.body);
      assert.equal(await countAudit(AuditAction.ORG_UPDATE, organizationId), 1);
    });

    /* ── What a repeated deletion reports ────────────────────────────────── */

    it('names the test identity an earlier attempt of an API delete collected', async () => {
      const api = await publish();
      const created = await harness.authed(provider, {
        method: 'POST',
        url: `/api/apis/${api.id}/test-consumer`,
        payload: {},
      });
      assert.equal(created.statusCode, 201, created.body);
      const consumerId = harness.edge.consumerByUsername(testConsumerUsername(api.id))?.id;
      assert.ok(consumerId);
      const remove = () =>
        harness.authed(provider, { method: 'DELETE', url: `/api/apis/${api.id}` });
      faults.failAfter('auditLogs', 'create', 1);
      const failed = await remove();
      assert.equal(failed.statusCode, 500, failed.body);
      assert.deepEqual(faults.pending(), [], 'the intended failure was reached');
      assert.equal(harness.edge.consumerByUsername(testConsumerUsername(api.id)), undefined);

      const retried = await remove();
      assert.equal(retried.statusCode, 200, retried.body);
      const details = await detailsOf(AuditAction.API_DELETE, api.id);
      assert.equal(details.test_consumer_id, consumerId);
      assert.equal(details.test_consumer_revoked_credentials, 1);
      assert.equal(details.resumed, true);
    });

    it('names the unmapped consumer an earlier attempt of an application delete collected', async () => {
      const owner = await harness.registerUser();
      const created = await harness.authed(owner, {
        method: 'POST',
        url: '/api/applications',
        payload: { name: `Unmapped application ${slugs++}` },
      });
      assert.equal(created.statusCode, 201, created.body);
      const applicationId = created.json<CreateApplicationResponse>().application.id;
      // What a provisioning whose mapping insert failed leaves behind: a
      // consumer only its derived id leads to.
      const { consumer } = await harness.edgeClient.consumers.ensure({
        username: consumerUsernameForApplication(applicationId),
        custom_id: applicationId,
        acl_groups: [],
      });
      const remove = () =>
        harness.authed(owner, { method: 'DELETE', url: `/api/applications/${applicationId}` });
      faults.failAfter('auditLogs', 'create', 1);
      const failed = await remove();
      assert.equal(failed.statusCode, 500, failed.body);
      assert.deepEqual(faults.pending(), [], 'the intended failure was reached');
      assert.equal(
        harness.edge.consumerByUsername(consumerUsernameForApplication(applicationId)),
        undefined,
      );

      const retried = await remove();
      assert.equal(retried.statusCode, 200, retried.body);
      const details = await detailsOf(AuditAction.APPLICATION_DELETE, applicationId);
      assert.equal(details.consumer_id, consumer.id);
      assert.equal(details.unmapped_consumer, true);
      assert.equal(details.resumed, true);
    });

    /* ── Outcome rows ────────────────────────────────────────────────────── */

    it('still records a god-mode disable outcome when the teardown row fails', async () => {
      const account = await accountWithKey();
      // `user.disable` and `god.disable_user` go in with the disable; the
      // inline teardown's own row after them fails.
      faults.failAfter('auditLogs', 'create', 2);
      const failed = await harness.authed(founder, {
        method: 'POST',
        url: '/api/admin/god/disable-user',
        payload: { user_id: account.user.id, reason: 'Audit contract', revoke_grants: false },
      });
      assert.equal(failed.statusCode, 500, failed.body);
      assert.deepEqual(faults.pending(), [], 'the intended failure was reached');
      assert.equal((await target.store.users.findById(account.user.id))?.status, 'disabled');
      assert.equal(keysOf(consumerUsernameForUser(account.user.id)), 0);
      assert.equal(
        await countAudit(AuditAction.USER_GATEWAY_TEARDOWN_COMPLETE, account.user.id),
        0,
      );
      const outcome = await detailsOf(AuditAction.GOD_DISABLE_USER_COMPLETE, account.user.id);
      assert.deepEqual(outcome.failed_steps, ['record_gateway_teardown']);
    });
  });
}
