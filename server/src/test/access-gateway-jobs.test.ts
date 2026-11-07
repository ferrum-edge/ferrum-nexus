/**
 * Grant revocations and access approvals that stop between their claim and
 * the Edge write (issue #651).
 *
 * Both are two-step sagas: the claim commits (`active → revoked` with its
 * `access.revoke` row, or `pending → approved`), then the consumer's ACL group
 * is written. The claim now commits an `access_gateway_jobs` row too, and the
 * access gateway worker finishes whatever a stopped process left behind.
 *
 * The crash is modelled with {@link crashingStore}: at the chosen point the
 * app's store stops answering, so nothing after it — no Edge write, no
 * compensation, no settling of the job — reaches the database. A second app
 * over the same database and gateway is the restarted process; its worker is
 * driven by hand against an injectable clock, as `worker-claim-recovery.test.ts`
 * does for the other workers.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  aclGroupForApi,
  consumerUsernameForUser,
  type ApproveAccessRequestResponse,
  type CreateAccessRequestResponse,
  type PublishApiResponse,
} from '@ferrum-nexus/shared';

import {
  ACCESS_GATEWAY_STALE_AFTER_MS,
  createAccessGatewayWorker,
  type AccessGatewayWorker,
} from '../access/gateway-job-worker.js';
import type { NexusStore } from '../db/store.js';
import { crashingStore, type CrashingStore } from './fault-injection.js';
import { SAMPLE_SPEC_YAML, buildTestApp, type TestApp, type TestSession } from './helpers.js';

/** A clock the test advances by hand, starting from the real one. */
function testClock(): { now(): Date; advance(ms: number): void } {
  let ms = Date.now();
  return {
    now: () => new Date(ms),
    advance: (delta) => {
      ms += delta;
    },
  };
}

describe('access gateway jobs survive a crash between the claim and the Edge write', () => {
  let crashed: TestApp;
  let restarted: TestApp;
  let crash: CrashingStore;
  let database: NexusStore;
  let provider: TestSession;
  let slugs = 0;

  before(async () => {
    crashed = await buildTestApp({
      wrapStore: (store) => {
        database = store;
        crash = crashingStore(store);
        return crash.store;
      },
    });
    // Same rows, same gateway, new services and lock owner: the restarted
    // process.
    restarted = await buildTestApp({ store: database, edge: crashed.edge });
    await crashed.registerUser({ email: 'jobs-founder@example.test' });
    provider = await crashed.registerUser({
      email: 'jobs-provider@example.test',
      role: 'provider',
    });
  });

  after(async () => {
    crash.revive();
    await restarted.close();
    await crashed.close();
  });

  function worker(clock: { now(): Date }): AccessGatewayWorker {
    return createAccessGatewayWorker({
      store: restarted.store,
      access: restarted.services.access,
      now: () => clock.now(),
    });
  }

  function groupsOf(userId: string): string[] {
    return crashed.edge.consumerByUsername(consumerUsernameForUser(userId))?.acl_groups ?? [];
  }

  async function publish(app: TestApp): Promise<string> {
    slugs += 1;
    const response = await app.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: {
        name: `Jobs ${slugs}`,
        slug: `jobs-${slugs}`,
        spec: SAMPLE_SPEC_YAML,
        auth_plugin: 'key_auth',
        requestable: true,
        visibility: 'public',
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<PublishApiResponse>().api.id;
  }

  async function request(app: TestApp, client: TestSession, apiId: string): Promise<string> {
    const response = await app.authed(client, {
      method: 'POST',
      url: '/api/access-requests',
      payload: { api_id: apiId, justification: 'Integration access' },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<CreateAccessRequestResponse>().access_request.id;
  }

  async function approve(app: TestApp, requestId: string): Promise<string> {
    const response = await app.authed(provider, {
      method: 'POST',
      url: `/api/access-requests/${requestId}/approve`,
      payload: {},
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json<ApproveAccessRequestResponse>().grant.id;
  }

  function revoke(app: TestApp, grantId: string) {
    return app.authed(provider, {
      method: 'POST',
      url: `/api/grants/${grantId}/revoke`,
      payload: { reason: 'Contract ended.' },
    });
  }

  /** A client holding an active grant whose group is on its consumer. */
  async function grantee(): Promise<{
    client: TestSession;
    apiId: string;
    requestId: string;
    grantId: string;
  }> {
    const client = await crashed.registerUser({ role: 'client' });
    const apiId = await publish(crashed);
    const requestId = await request(crashed, client, apiId);
    const grantId = await approve(crashed, requestId);
    assert.deepEqual(groupsOf(client.user.id), [aclGroupForApi(apiId)]);
    return { client, apiId, requestId, grantId };
  }

  it('settles its own jobs when nothing goes wrong', async () => {
    const { client, requestId, grantId } = await grantee();
    assert.equal(await database.accessGatewayJobs.findBySubject(requestId), null);

    const revoked = await revoke(crashed, grantId);
    assert.equal(revoked.statusCode, 200, revoked.body);
    assert.equal(await database.accessGatewayJobs.findBySubject(grantId), null);
    assert.deepEqual(groupsOf(client.user.id), []);
    assert.equal((await database.grants.findById(grantId))?.status, 'revoked');
  });

  it('deletes a revocation job with the rollback that puts its grant back', async () => {
    const { client, apiId, grantId } = await grantee();
    crashed.edge.queueFailure(503, { error: 'gateway unavailable' }, '/consumers/', 'PUT');

    const refused = await revoke(crashed, grantId);
    assert.ok(refused.statusCode >= 500, refused.body);
    assert.equal((await database.grants.findById(grantId))?.status, 'active');
    assert.equal(
      await database.accessGatewayJobs.findBySubject(grantId),
      null,
      'an active grant owes no removal, so the worker can never strip it',
    );
    assert.deepEqual(groupsOf(client.user.id), [aclGroupForApi(apiId)]);
  });

  it('finishes the ACL removal of a revocation that stopped before the Edge write', async () => {
    const { client, apiId, grantId } = await grantee();
    const group = aclGroupForApi(apiId);

    crash.crashAfterCommitOf('accessGatewayJobs', 'upsertClaimed');
    const stopped = await revoke(crashed, grantId);
    assert.ok(crash.crashed(), 'the process stopped right after the claim committed');
    assert.ok(stopped.statusCode >= 500, stopped.body);
    crash.revive();

    // The durable state the crash left: revoked and audited, but the group
    // still opens the door — and now a job says it must come off.
    assert.equal((await database.grants.findById(grantId))?.status, 'revoked');
    assert.deepEqual(groupsOf(client.user.id), [group], 'the Edge write never happened');
    const job = await database.accessGatewayJobs.findBySubject(grantId);
    assert.equal(job?.kind, 'revoke');
    assert.equal(job?.status, 'sending');
    assert.equal(job?.user_id, client.user.id);
    assert.equal(job?.requested_by, provider.user.id);

    const clock = testClock();
    clock.advance(60_000);
    const replacement = worker(clock);
    const tooSoon = await replacement.tick();
    assert.equal(tooSoon.claimed, 0, 'a fresh claim may still have a live owner');
    assert.deepEqual(groupsOf(client.user.id), [group]);

    clock.advance(2 * ACCESS_GATEWAY_STALE_AFTER_MS);
    const recovered = await replacement.tick();
    assert.equal(recovered.released, 1);
    assert.equal(recovered.claimed, 1);
    assert.equal(recovered.completed, 1);
    assert.deepEqual(groupsOf(client.user.id), [], 'the worker took the group off');
    assert.equal(await database.accessGatewayJobs.findBySubject(grantId), null);
    assert.equal((await database.grants.findById(grantId))?.status, 'revoked');
    const completion = (await restarted.auditRows('access.revoke_complete')).find(
      (row) => row.target_id === grantId,
    );
    assert.ok(completion, 'the completion is audited');
    assert.equal(completion.actor_user_id, null, 'by the system');
    assert.equal(completion.details.acl_group, group);
    assert.equal(completion.details.revoked_by, provider.user.id);

    // Idempotent: nothing is left to claim.
    const idle = await replacement.tick();
    assert.equal(idle.claimed, 0);
  });

  it('leaves the group alone when a newer grant owns it by the time the worker runs', async () => {
    const { client, apiId, grantId } = await grantee();
    const group = aclGroupForApi(apiId);

    crash.crashAfterCommitOf('accessGatewayJobs', 'upsertClaimed');
    const stopped = await revoke(crashed, grantId);
    assert.ok(stopped.statusCode >= 500, stopped.body);
    crash.revive();

    // The restarted process re-grants the same identity before the stale
    // claim is recovered.
    const again = await request(restarted, client, apiId);
    const regranted = await approve(restarted, again);
    assert.deepEqual(groupsOf(client.user.id), [group]);

    const clock = testClock();
    clock.advance(2 * ACCESS_GATEWAY_STALE_AFTER_MS);
    const tick = await worker(clock).tick();
    assert.equal(tick.claimed, 1);
    assert.equal(tick.obsolete, 1, 'nothing is owed: an active grant holds the group');
    assert.deepEqual(groupsOf(client.user.id), [group], 'the newer grant keeps its access');
    assert.equal((await database.grants.findById(regranted))?.status, 'active');
    assert.equal(await database.accessGatewayJobs.findBySubject(grantId), null);
  });

  for (const point of ['after the claim', 'after the Edge write'] as const) {
    it(`compensates an approval that stopped ${point}`, async () => {
      const client = await crashed.registerUser({ role: 'client' });
      const apiId = await publish(crashed);
      const requestId = await request(crashed, client, apiId);
      const group = aclGroupForApi(apiId);

      if (point === 'after the claim') {
        crash.crashAfterCommitOf('accessGatewayJobs', 'upsertClaimed');
      } else {
        // The group has landed; the grant row is the write that never comes.
        crash.crashAt('grants', 'create');
      }
      const stopped = await crashed.authed(provider, {
        method: 'POST',
        url: `/api/access-requests/${requestId}/approve`,
        payload: {},
      });
      assert.ok(crash.crashed());
      assert.ok(stopped.statusCode >= 500, stopped.body);
      crash.revive();

      // `approved`, no grant, no approve audit row — and, past the Edge
      // write, a group no grant stands behind. The job is what remembers it.
      assert.equal((await database.accessRequests.findById(requestId))?.status, 'approved');
      assert.equal(await database.grants.findActiveByApiAndUser(apiId, client.user.id), null);
      assert.deepEqual(groupsOf(client.user.id), point === 'after the claim' ? [] : [group]);
      const job = await database.accessGatewayJobs.findBySubject(requestId);
      assert.equal(job?.kind, 'approve');
      assert.equal(job?.status, 'sending');

      const clock = testClock();
      clock.advance(2 * ACCESS_GATEWAY_STALE_AFTER_MS);
      const tick = await worker(clock).tick();
      assert.equal(tick.claimed, 1);
      assert.equal(tick.completed, 1);
      assert.deepEqual(groupsOf(client.user.id), [], 'no access without a grant');
      const released = await database.accessRequests.findById(requestId);
      assert.equal(released?.status, 'pending', 'back in the provider’s inbox');
      assert.equal(released?.decided_by, null);
      assert.equal(released?.decided_at, null);
      assert.equal(await database.accessGatewayJobs.findBySubject(requestId), null);
      const rollback = (await restarted.auditRows('access.approve_rollback')).find(
        (row) => row.target_id === requestId && row.details.recovered === true,
      );
      assert.ok(rollback, 'the compensation is audited');
      assert.equal(rollback.actor_user_id, null);
      assert.equal(rollback.details.request_released, true);
      assert.deepEqual(
        rollback.details.acl_groups_removed,
        point === 'after the claim' ? [] : [group],
      );

      // And the provider can simply approve again.
      const grantId = await approve(restarted, requestId);
      assert.deepEqual(groupsOf(client.user.id), [group]);
      assert.equal((await database.grants.findById(grantId))?.status, 'active');
      assert.equal(await database.accessGatewayJobs.findBySubject(requestId), null);
    });
  }

  it('retries an approval compensation the gateway refused', async () => {
    const client = await crashed.registerUser({ role: 'client' });
    const apiId = await publish(crashed);
    const requestId = await request(crashed, client, apiId);
    const group = aclGroupForApi(apiId);

    // The group lands but its acknowledgement is lost, so the approval fails;
    // then the gateway refuses the compensation that would take it back. The
    // consumer exists first, so the approval's write is the first consumer PUT.
    await crashed.services.credentials.provisioner.ensureConsumer(client.user);
    crashed.edge.queueLostAck(502, { error: 'Acknowledgement lost' }, '/consumers/', 'PUT');
    crashed.edge.queueFailure(503, { error: 'gateway unavailable' }, '/consumers/', 'PUT', 1);
    const failed = await crashed.authed(provider, {
      method: 'POST',
      url: `/api/access-requests/${requestId}/approve`,
      payload: {},
    });
    assert.equal(failed.statusCode, 502, failed.body);
    assert.deepEqual(groupsOf(client.user.id), [group], 'the compensation could not land');
    const job = await database.accessGatewayJobs.findBySubject(requestId);
    assert.equal(job?.status, 'pending', 'handed to the worker');

    const tick = await worker(testClock()).tick();
    assert.equal(tick.claimed, 1);
    assert.equal(tick.completed, 1);
    assert.deepEqual(groupsOf(client.user.id), []);
    assert.equal((await database.accessRequests.findById(requestId))?.status, 'pending');
    assert.equal(await database.accessGatewayJobs.findBySubject(requestId), null);
  });
});
