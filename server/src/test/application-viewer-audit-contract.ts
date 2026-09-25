import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type {
  CreateApplicationResponse,
  PublishApiResponse,
  UpdateApplicationResponse,
} from '@ferrum-nexus/shared';

import { AuditAction } from '../audit/service.js';
import type { NexusStore } from '../db/store.js';
import { faultInjectingStore, type FaultInjectingStore } from './fault-injection.js';
import { buildTestApp, SAMPLE_SPEC_YAML, type TestApp, type TestSession } from './helpers.js';

/**
 * Application and private-viewer mutations commit with their audit rows on
 * every adapter (issue #362).
 *
 * Each case fails the audit insert that follows the mutation and checks that
 * nothing of the mutation survived, then retries and checks that the retry
 * lands cleanly with exactly one audit row — the leftover row an unwrapped
 * write used to leave would make it collide or count against the quota.
 */
export function runApplicationViewerAuditContract(
  label: string,
  makeStore: () => Promise<{ store: NexusStore; teardown: () => Promise<void> }>,
): void {
  describe(`application and viewer audit contract — ${label}`, () => {
    let target: Awaited<ReturnType<typeof makeStore>>;
    let faults: FaultInjectingStore;
    let harness: TestApp;
    let provider: TestSession;
    let privateId: string;
    const privateSlug = 'audited-private';

    before(async () => {
      target = await makeStore();
      faults = faultInjectingStore(target.store);
      harness = await buildTestApp({
        store: faults.store,
        // One application per owner, so a row a failed create left behind
        // would also refuse the retry on quota, not only on its name.
        env: { NEXUS_MAX_APPLICATIONS_PER_OWNER: '1' },
      });
      await harness.registerUser();
      provider = await harness.registerUser({ role: 'provider' });
      const published = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: {
          name: 'Audited private API',
          slug: privateSlug,
          spec: SAMPLE_SPEC_YAML,
          auth_plugin: 'key_auth',
          requestable: true,
          visibility: 'private',
        },
      });
      assert.equal(published.statusCode, 201, published.body);
      privateId = published.json<PublishApiResponse>().api.id;
    });

    after(async () => {
      await harness?.close();
      await target?.teardown();
    });

    function countAudit(
      action: string,
      filter: { actor?: string; target?: string },
    ): Promise<number> {
      return target.store.auditLogs.count({
        action,
        ...(filter.actor !== undefined ? { actor_user_id: filter.actor } : {}),
        ...(filter.target !== undefined ? { target_id: filter.target } : {}),
      });
    }

    async function viewerAudits(action: string, viewerUserId: string): Promise<number> {
      const rows = await harness.auditRows(action);
      return rows.filter(
        (row) => row.target_id === privateId && row.details.viewer_user_id === viewerUserId,
      ).length;
    }

    it('rolls back an application create when its audit row fails', async () => {
      const owner = await harness.registerUser();
      faults.failNext('auditLogs', 'create');
      const failed = await harness.authed(owner, {
        method: 'POST',
        url: '/api/applications',
        payload: { name: 'Billing sync' },
      });
      assert.equal(failed.statusCode, 500, failed.body);
      assert.deepEqual(faults.pending(), [], 'the intended failure was reached');
      assert.equal(await target.store.applications.count({ owner_user_id: owner.user.id }), 0);
      assert.equal(await countAudit(AuditAction.APPLICATION_CREATE, { actor: owner.user.id }), 0);

      // The same name, under a one-application quota: both would refuse a
      // retry if the failed attempt had left its row behind.
      const retried = await harness.authed(owner, {
        method: 'POST',
        url: '/api/applications',
        payload: { name: 'Billing sync' },
      });
      assert.equal(retried.statusCode, 201, retried.body);
      const created = retried.json<CreateApplicationResponse>().application;
      assert.equal(await target.store.applications.count({ owner_user_id: owner.user.id }), 1);
      assert.equal(await countAudit(AuditAction.APPLICATION_CREATE, { actor: owner.user.id }), 1);
      assert.equal(await countAudit(AuditAction.APPLICATION_CREATE, { target: created.id }), 1);
    });

    it('rolls back an application rename and disable when its audit row fails', async () => {
      const owner = await harness.registerUser();
      const createdResponse = await harness.authed(owner, {
        method: 'POST',
        url: '/api/applications',
        payload: { name: 'Before rename' },
      });
      assert.equal(createdResponse.statusCode, 201, createdResponse.body);
      const applicationId = createdResponse.json<CreateApplicationResponse>().application.id;
      const beforeRow = await target.store.applications.findById(applicationId);

      faults.failNext('auditLogs', 'create');
      const failed = await harness.authed(owner, {
        method: 'PATCH',
        url: `/api/applications/${applicationId}`,
        payload: { name: 'After rename', status: 'disabled' },
      });
      assert.equal(failed.statusCode, 500, failed.body);
      assert.deepEqual(faults.pending(), [], 'the intended failure was reached');
      assert.deepEqual(await target.store.applications.findById(applicationId), beforeRow);
      assert.equal(await countAudit(AuditAction.APPLICATION_UPDATE, { target: applicationId }), 0);

      const retried = await harness.authed(owner, {
        method: 'PATCH',
        url: `/api/applications/${applicationId}`,
        payload: { name: 'After rename', status: 'disabled' },
      });
      assert.equal(retried.statusCode, 200, retried.body);
      const updated = retried.json<UpdateApplicationResponse>().application;
      assert.equal(updated.name, 'After rename');
      assert.equal(updated.status, 'disabled');
      assert.equal(await countAudit(AuditAction.APPLICATION_UPDATE, { target: applicationId }), 1);
    });

    it('rolls back a viewer authorization, and sends nothing, when its audit fails', async () => {
      const partner = await harness.registerUser();
      const notifications = async (): Promise<number> =>
        (await target.store.notifications.list({ user_id: partner.user.id })).total;
      const beforeNotifications = await notifications();
      faults.failNext('auditLogs', 'create');
      const failed = await harness.authed(provider, {
        method: 'POST',
        url: `/api/apis/${privateId}/viewers`,
        payload: { user_id: partner.user.id },
      });
      assert.equal(failed.statusCode, 500, failed.body);
      assert.deepEqual(faults.pending(), [], 'the intended failure was reached');
      assert.equal(await target.store.apiViewers.find(privateId, partner.user.id), null);
      assert.equal(await viewerAudits(AuditAction.API_VIEWER_AUTHORIZE, partner.user.id), 0);
      assert.equal(
        await notifications(),
        beforeNotifications,
        'a failed authorization announces nothing',
      );
      const hidden = await harness.authed(partner, {
        method: 'GET',
        url: `/api/catalog/${privateSlug}`,
      });
      assert.equal(hidden.statusCode, 404, 'the private API is still unreadable');

      const retried = await harness.authed(provider, {
        method: 'POST',
        url: `/api/apis/${privateId}/viewers`,
        payload: { user_id: partner.user.id },
      });
      assert.equal(retried.statusCode, 201, retried.body);
      assert.ok(await target.store.apiViewers.find(privateId, partner.user.id));
      assert.equal(await viewerAudits(AuditAction.API_VIEWER_AUTHORIZE, partner.user.id), 1);
      assert.equal(await notifications(), beforeNotifications + 1);
    });

    it('rolls back a viewer revocation when its audit row fails', async () => {
      const partner = await harness.registerUser();
      const authorized = await harness.authed(provider, {
        method: 'POST',
        url: `/api/apis/${privateId}/viewers`,
        payload: { user_id: partner.user.id },
      });
      assert.equal(authorized.statusCode, 201, authorized.body);

      faults.failNext('auditLogs', 'create');
      const failed = await harness.authed(provider, {
        method: 'DELETE',
        url: `/api/apis/${privateId}/viewers/${partner.user.id}`,
      });
      assert.equal(failed.statusCode, 500, failed.body);
      assert.deepEqual(faults.pending(), [], 'the intended failure was reached');
      assert.ok(
        await target.store.apiViewers.find(privateId, partner.user.id),
        'the authorization is still in place',
      );
      assert.equal(await viewerAudits(AuditAction.API_VIEWER_REVOKE, partner.user.id), 0);

      // The retry completes the original action rather than finding it gone.
      const retried = await harness.authed(provider, {
        method: 'DELETE',
        url: `/api/apis/${privateId}/viewers/${partner.user.id}`,
      });
      assert.equal(retried.statusCode, 200, retried.body);
      assert.equal(await target.store.apiViewers.find(privateId, partner.user.id), null);
      assert.equal(await viewerAudits(AuditAction.API_VIEWER_REVOKE, partner.user.id), 1);
    });
  });
}
