import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  consumerUsernameForApplication,
  consumerUsernameForUser,
  type CreateApplicationResponse,
  type PublishApiResponse,
} from '@ferrum-nexus/shared';

import { AuditAction } from '../audit/service.js';
import type { NexusStore } from '../db/store.js';
import { faultInjectingStore, type FaultInjectingStore } from './fault-injection.js';
import { buildTestApp, SAMPLE_SPEC_YAML, type TestApp, type TestSession } from './helpers.js';

/**
 * Privileged account transitions and destructive deletions commit with their
 * audit rows on every adapter.
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

    async function publish(): Promise<{ id: string; slug: string }> {
      slugs += 1;
      const slug = `audited-delete-${slugs}`;
      const response = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: {
          name: `Audited delete ${slugs}`,
          slug,
          spec: SAMPLE_SPEC_YAML,
          auth_plugin: 'key_auth',
          requestable: true,
          visibility: 'public',
        },
      });
      assert.equal(response.statusCode, 201, response.body);
      return { id: response.json<PublishApiResponse>().api.id, slug };
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
  });
}
