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
  mcpAllGroupForApi,
  mcpToolGroupForApi,
  type ApiAgents,
  type ApproveAccessRequestResponse,
  type CreateAccessRequestResponse,
  type PublishApiResponse,
  type RequestGrantToolsResponse,
} from '@ferrum-nexus/shared';

import {
  ACCESS_GATEWAY_STALE_AFTER_MS,
  accessGatewayBackoffMs,
  createAccessGatewayWorker,
  type AccessGatewayWorker,
} from '../access/gateway-job-worker.js';
import { queueStrandedAccessRepairs } from '../access/stranded-repair.js';
import { canonicalConsumerLockKey } from '../credentials/consumers.js';
import type { AccessRequestRepo, NexusStore } from '../db/store.js';
import { createKeyedSerializer, proxyLockKey } from '../lib/keyed-serializer.js';
import { crashingStore, type CrashingStore } from './fault-injection.js';
import { SAMPLE_SPEC_YAML, buildTestApp, type TestApp, type TestSession } from './helpers.js';

/** The document `agents.test.ts` publishes agents on, with two operations to select. */
const AGENT_DOCUMENT = {
  openapi: '3.1.0',
  info: { title: 'Agent API', version: '1' },
  servers: [{ url: 'https://api.example.com' }],
  'x-ferrum-mcp': { endpoint: { path: '/escape' }, include: { tags: ['all'] } },
  'x-ferrum-plugins': [{ plugin_name: 'ai_transcript_audit', config: { sink: 'provider' } }],
  paths: {
    '/items': {
      get: { operationId: 'items', responses: { '200': { description: 'OK' } } },
      post: { 'x-ferrum-mcp': true, responses: { '200': { description: 'OK' } } },
    },
    '/items/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      delete: { 'x-ferrum-mcp': { expose: true }, responses: { '200': { description: 'OK' } } },
    },
  },
};

const LIST_TOOL = {
  path: '/items',
  method: 'GET' as const,
  name: 'list_items',
  description: 'List',
};
const REMOVE_TOOL = {
  path: '/items/{id}',
  method: 'DELETE' as const,
  name: 'remove',
  description: 'Delete one item',
};
const TWO_TOOLS: ApiAgents = { operations: [LIST_TOOL, REMOVE_TOOL] };

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

  function worker(clock: { now(): Date }, random?: () => number): AccessGatewayWorker {
    return createAccessGatewayWorker({
      store: restarted.store,
      access: restarted.services.access,
      now: () => clock.now(),
      ...(random ? { random } : {}),
    });
  }

  /** Publish an API on `AGENT_DOCUMENT` with `agents`, and return it. */
  async function publishAgents(
    app: TestApp,
    agents: ApiAgents | null,
  ): Promise<PublishApiResponse['api']> {
    slugs += 1;
    const response = await app.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: {
        name: `Jobs agents ${slugs}`,
        slug: `jobs-agents-${slugs}`,
        spec: JSON.stringify(AGENT_DOCUMENT),
        auth_plugin: 'key_auth',
        requestable: true,
        visibility: 'public',
        spec_enforcement: 'routes',
        agents,
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<PublishApiResponse>().api;
  }

  /** Crash an approval of `requestId` right after its claim commits. */
  async function crashApprovalAfterClaim(requestId: string): Promise<void> {
    crash.crashAfterCommitOf('accessGatewayJobs', 'upsertClaimed');
    const stopped = await crashed.authed(provider, {
      method: 'POST',
      url: `/api/access-requests/${requestId}/approve`,
      payload: {},
    });
    assert.ok(crash.crashed());
    assert.ok(stopped.statusCode >= 500, stopped.body);
    crash.revive();
    assert.equal((await database.accessRequests.findById(requestId))?.status, 'approved');
  }

  /** One tick of a worker whose clock is past the stale threshold. */
  async function recoverStale(): Promise<void> {
    const clock = testClock();
    clock.advance(2 * ACCESS_GATEWAY_STALE_AFTER_MS);
    const tick = await worker(clock).tick();
    assert.equal(tick.claimed, 1);
    assert.equal(tick.completed, 1);
  }

  async function rollbackRow(action: string, requestId: string) {
    const row = (await restarted.auditRows(action)).find(
      (entry) => entry.target_id === requestId && entry.details.recovered === true,
    );
    assert.ok(row, `${action} records the recovery`);
    return row;
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

  it('cancels a stranded approval whose pending slot a newer request holds', async () => {
    const client = await crashed.registerUser({ role: 'client' });
    const apiId = await publish(crashed);
    const stranded = await request(crashed, client, apiId);
    await crashApprovalAfterClaim(stranded);

    // The stranded request is `approved`, not pending, so the identity may
    // ask again — and its new request holds the one pending slot a release
    // of the stranded one would need.
    const newer = await request(restarted, client, apiId);

    await recoverStale();
    const cancelled = await database.accessRequests.findById(stranded);
    assert.equal(cancelled?.status, 'cancelled', 'cancelled, not released into a taken slot');
    assert.equal(cancelled?.decided_by, null);
    assert.equal(cancelled?.decided_at, null);
    assert.equal((await database.accessRequests.findById(newer))?.status, 'pending');
    assert.equal(await database.accessGatewayJobs.findBySubject(stranded), null);
    const rollback = await rollbackRow('access.approve_rollback', stranded);
    assert.equal(rollback.details.request_cancelled, true);
    assert.equal(rollback.details.pending_request_id, newer);
    assert.deepEqual(groupsOf(client.user.id), []);
  });

  it('reconciles against the API as publishing left it, not as it read before the lease', async () => {
    const client = await crashed.registerUser({ role: 'client' });
    const api = await publishAgents(crashed, null);
    assert.ok(api.ferrum_proxy_id);
    const stranded = await request(crashed, client, api.id);
    await crashApprovalAfterClaim(stranded);

    // A newer request is approved for every tool while the stranded one waits.
    const grantId = await approve(restarted, await request(restarted, client, api.id));
    assert.deepEqual(groupsOf(client.user.id), [aclGroupForApi(api.id)]);

    // Publishing turns agents on — enrolling that grant in the MCP-all group —
    // after recovery has started but before it holds the proxy lease.
    const edge = restarted.edgeClient;
    const serialize = edge.serializePerKey;
    let armed = true;
    edge.serializePerKey = async (key, work) => {
      if (armed && key === proxyLockKey(api.ferrum_proxy_id ?? '')) {
        armed = false;
        const enabled = await restarted.authed(provider, {
          method: 'PATCH',
          url: `/api/apis/${api.id}`,
          payload: { agents: { operations: [LIST_TOOL] } },
        });
        assert.equal(enabled.statusCode, 200, enabled.body);
        assert.ok(groupsOf(client.user.id).includes(mcpAllGroupForApi(api.id)));
      }
      return serialize(key, work);
    };
    try {
      await recoverStale();
    } finally {
      edge.serializePerKey = serialize;
    }
    assert.equal(armed, false, 'publishing ran inside the window');

    const groups = groupsOf(client.user.id);
    assert.ok(groups.includes(aclGroupForApi(api.id)));
    assert.ok(
      groups.includes(mcpAllGroupForApi(api.id)),
      'the grant keeps the MCP access publishing enrolled it in',
    );
    assert.equal((await database.grants.findById(grantId))?.status, 'active');
    const cancelled = await database.accessRequests.findById(stranded);
    assert.equal(cancelled?.status, 'cancelled');
    assert.equal(cancelled?.decided_by, null);
    assert.equal(await database.accessGatewayJobs.findBySubject(stranded), null);
  });

  /** A grantee approved for `list_items` alone, asking for `remove` too. */
  async function toolRequest(): Promise<{
    client: TestSession;
    api: PublishApiResponse['api'];
    listId: string;
    removeId: string;
    grantId: string;
    requestId: string;
  }> {
    const api = await publishAgents(crashed, TWO_TOOLS);
    const [listId, removeId] = api.agents?.operations.map((tool) => tool.id) ?? [];
    assert.ok(listId && removeId);
    const client = await crashed.registerUser({ role: 'client' });
    const asked = await crashed.authed(client, {
      method: 'POST',
      url: '/api/access-requests',
      payload: { api_id: api.id, justification: 'List items', requested_tools: [listId] },
    });
    assert.equal(asked.statusCode, 201, asked.body);
    const grantId = await approve(
      crashed,
      asked.json<CreateAccessRequestResponse>().access_request.id,
    );
    const more = await crashed.authed(client, {
      method: 'POST',
      url: `/api/grants/${grantId}/tool-requests`,
      payload: { requested_tools: [removeId], justification: 'Remove items too' },
    });
    assert.equal(more.statusCode, 201, more.body);
    const requestId = more.json<RequestGrantToolsResponse>().access_request.id;
    return { client, api, listId, removeId, grantId, requestId };
  }

  for (const point of ['after the claim', 'after the Edge write'] as const) {
    it(`compensates a tool approval that stopped ${point}`, async () => {
      const f = await toolRequest();
      const listGroup = mcpToolGroupForApi(f.api.id, f.listId);
      const removeGroup = mcpToolGroupForApi(f.api.id, f.removeId);

      if (point === 'after the claim') {
        crash.crashAfterCommitOf('accessGatewayJobs', 'upsertClaimed');
      } else {
        // The widened groups have landed; the grant's new subset never commits.
        crash.crashAt('grants', 'updateIfStatus');
      }
      const stopped = await crashed.authed(provider, {
        method: 'POST',
        url: `/api/access-requests/${f.requestId}/approve`,
        payload: {},
      });
      assert.ok(crash.crashed());
      assert.ok(stopped.statusCode >= 500, stopped.body);
      crash.revive();

      assert.equal((await database.accessRequests.findById(f.requestId))?.status, 'approved');
      assert.deepEqual((await database.grants.findById(f.grantId))?.approved_tools, [f.listId]);
      assert.equal(
        groupsOf(f.client.user.id).includes(removeGroup),
        point === 'after the Edge write',
      );
      assert.equal((await database.accessGatewayJobs.findBySubject(f.requestId))?.kind, 'approve');

      await recoverStale();
      const groups = groupsOf(f.client.user.id);
      assert.ok(groups.includes(aclGroupForApi(f.api.id)), 'REST access never lapses');
      assert.ok(groups.includes(listGroup), 'the approved tool stays');
      assert.equal(groups.includes(removeGroup), false, 'the unapproved tool comes off');
      const released = await database.accessRequests.findById(f.requestId);
      assert.equal(released?.status, 'pending');
      assert.equal(released?.decided_by, null);
      assert.equal(released?.decided_at, null);
      assert.equal(released?.approved_tools, null);
      assert.deepEqual((await database.grants.findById(f.grantId))?.approved_tools, [f.listId]);
      assert.equal(await database.accessGatewayJobs.findBySubject(f.requestId), null);
      const rollback = await rollbackRow('access.tools_approve_rollback', f.requestId);
      assert.equal(rollback.details.request_released, true);
      assert.deepEqual(
        rollback.details.acl_groups_removed,
        point === 'after the claim' ? [] : [removeGroup],
      );
    });
  }

  it('cancels a stranded tool approval whose grant was revoked meanwhile', async () => {
    const f = await toolRequest();
    await crashApprovalAfterClaim(f.requestId);

    const revoked = await revoke(restarted, f.grantId);
    assert.equal(revoked.statusCode, 200, revoked.body);

    await recoverStale();
    assert.deepEqual(
      groupsOf(f.client.user.id).filter((group) => group.startsWith(`nexus:api:${f.api.id}:`)),
      [],
    );
    const cancelled = await database.accessRequests.findById(f.requestId);
    assert.equal(cancelled?.status, 'cancelled');
    assert.equal(cancelled?.decided_by, null);
    assert.equal(cancelled?.decided_at, null);
    assert.equal(await database.accessGatewayJobs.findBySubject(f.requestId), null);
    const rollback = await rollbackRow('access.tools_approve_rollback', f.requestId);
    assert.equal(rollback.details.request_cancelled, true);
  });

  it('reschedules a recovery the gateway refuses, on the backoff, then finishes it', async () => {
    const { client, apiId, grantId } = await grantee();
    crash.crashAfterCommitOf('accessGatewayJobs', 'upsertClaimed');
    const stopped = await revoke(crashed, grantId);
    assert.ok(stopped.statusCode >= 500, stopped.body);
    crash.revive();

    const clock = testClock();
    clock.advance(2 * ACCESS_GATEWAY_STALE_AFTER_MS);
    const noJitter = worker(clock, () => 0);
    crashed.edge.queueFailure(503, { error: 'gateway unavailable' }, '/consumers/', 'PUT');
    const refused = await noJitter.tick();
    assert.equal(refused.claimed, 1);
    assert.equal(refused.rescheduled, 1);
    assert.equal(refused.completed, 0);
    const pending = await database.accessGatewayJobs.findBySubject(grantId);
    assert.equal(pending?.status, 'pending');
    assert.equal(pending?.attempts, 1);
    assert.ok(pending?.last_error);
    assert.equal(
      pending?.next_attempt_at,
      new Date(clock.now().getTime() + accessGatewayBackoffMs(1, () => 0)).toISOString(),
    );
    assert.deepEqual(groupsOf(client.user.id), [aclGroupForApi(apiId)], 'still owed');

    const backingOff = await noJitter.tick();
    assert.equal(backingOff.claimed, 0, 'not due until the backoff passes');

    clock.advance(accessGatewayBackoffMs(1, () => 0));
    const retried = await noJitter.tick();
    assert.equal(retried.claimed, 1);
    assert.equal(retried.completed, 1);
    assert.deepEqual(groupsOf(client.user.id), []);
    assert.equal(await database.accessGatewayJobs.findBySubject(grantId), null);
  });

  it('stops a stalled revocation whose job recovery took over from stripping a newer grant', async () => {
    const { client, apiId, grantId } = await grantee();
    const group = aclGroupForApi(apiId);
    const proxyId = (await database.apis.findById(apiId))?.ferrum_proxy_id;
    assert.ok(proxyId);

    // Instance one commits the revocation, then stalls before its Edge write.
    const stalled = crash.stallAt('consumers', 'findByUserAndNamespace');
    const first = revoke(crashed, grantId);
    await stalled.reached;
    assert.equal((await database.grants.findById(grantId))?.status, 'revoked');

    // Its proxy lease lapses and is taken over, as a stall past the TTL does.
    const key = proxyLockKey(proxyId);
    const later = new Date(Date.now() + 10 * 60_000).toISOString();
    assert.equal(await database.leases.acquire(key, 'takeover', later, later), true);
    assert.equal(await database.leases.release(key, 'takeover'), true);

    // Instance two recovers the stale job, then grants the identity again.
    await recoverStale();
    assert.deepEqual(groupsOf(client.user.id), []);
    const regranted = await approve(restarted, await request(restarted, client, apiId));
    assert.deepEqual(groupsOf(client.user.id), [group]);

    // Instance one wakes up and reaches the consumer it meant to strip.
    stalled.resume();
    await first;
    assert.deepEqual(groupsOf(client.user.id), [group], 'the newer grant keeps its group');
    assert.equal((await database.grants.findById(regranted))?.status, 'active');
    assert.equal((await database.grants.findById(grantId))?.status, 'revoked');
    assert.equal(await database.accessGatewayJobs.findBySubject(grantId), null);
  });

  /** Take a lease another instance holds over, then let it go, as a stall past its TTL allows. */
  async function takeOver(key: string): Promise<void> {
    const later = new Date(Date.now() + 10 * 60_000).toISOString();
    assert.equal(await database.leases.acquire(key, 'takeover', later, later), true, key);
    assert.equal(await database.leases.release(key, 'takeover'), true, key);
  }

  async function until(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!condition()) {
      assert.ok(Date.now() < deadline, 'timed out waiting for the condition');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  function approveOn(app: TestApp, requestId: string) {
    return app.authed(provider, {
      method: 'POST',
      url: `/api/access-requests/${requestId}/approve`,
      payload: {},
    });
  }

  it('leaves a newer decision of the same request alone when a superseded approval compensates', async () => {
    const client = await crashed.registerUser({ role: 'client' });
    await crashed.services.credentials.provisioner.ensureConsumer(client.user);
    const apiId = await publish(crashed);
    const proxyId = (await database.apis.findById(apiId))?.ferrum_proxy_id;
    assert.ok(proxyId);
    const requestId = await request(crashed, client, apiId);
    const group = aclGroupForApi(apiId);

    // Approval A claims, then stalls before its consumer write.
    const beforeWrite = crash.stallAt('consumers', 'findByUserAndNamespace');
    const first = approveOn(crashed, requestId);
    await beforeWrite.reached;
    await takeOver(proxyLockKey(proxyId));
    await takeOver(canonicalConsumerLockKey('nexus', consumerUsernameForUser(client.user.id)));

    // Recovery compensates A: the request is pending again.
    await recoverStale();
    assert.equal((await database.accessRequests.findById(requestId))?.status, 'pending');

    // A wakes, its verification read fails before its ownership guard, and
    // its compensation stalls just before it reaches the consumer.
    crashed.edge.queueFailure(503, { error: 'gateway unavailable' }, '/verification', 'GET');
    const beforeUndo = crash.stallAt('consumers', 'findByUserAndNamespace');
    beforeWrite.resume();
    await beforeUndo.reached;

    // Approval B of the same request succeeds on the other instance.
    const approved = await approveOn(restarted, requestId);
    assert.equal(approved.statusCode, 200, approved.body);
    const decision = approved.json<ApproveAccessRequestResponse>();

    beforeUndo.resume();
    const stale = await first;
    assert.ok(stale.statusCode >= 400, stale.body);
    const current = await database.accessRequests.findById(requestId);
    assert.equal(current?.status, 'approved', 'B’s decision stands');
    assert.equal(current?.decided_by, provider.user.id);
    assert.equal(current?.decided_at, decision.access_request.decided_at);
    assert.equal((await database.grants.findById(decision.grant.id))?.status, 'active');
    assert.deepEqual(groupsOf(client.user.id), [group]);
    assert.equal(await database.accessGatewayJobs.findBySubject(requestId), null);
  });

  for (const cleanup of ['lands', 'fails'] as const) {
    it(`refuses a frozen approval's late consumer write after recovery (its cleanup ${cleanup})`, async () => {
      const client = await crashed.registerUser({ role: 'client' });
      const consumer = await crashed.services.credentials.provisioner.ensureConsumer(client.user);
      const apiId = await publish(crashed);
      const proxyId = (await database.apis.findById(apiId))?.ferrum_proxy_id;
      assert.ok(proxyId);
      const requestId = await request(crashed, client, apiId);
      const path = `/consumers/${consumer.ferrum_consumer_id}`;
      const puts = (): number => crashed.edge.callsTo('PUT', path).length;
      const before = puts();

      // Approval A passes its ownership guard; its PUT is then held in flight.
      crashed.edge.delay(path, 2_000, 'PUT');
      const first = approveOn(crashed, requestId);
      await until(() => puts() > before);
      await takeOver(proxyLockKey(proxyId));
      await takeOver(consumer.ferrum_consumer_id);

      // Recovery finds no group to remove, rewrites the consumer anyway, and
      // returns the request to pending.
      await recoverStale();
      assert.equal(puts(), before + 2, 'recovery wrote the consumer although nothing changed');
      assert.equal((await database.accessRequests.findById(requestId))?.status, 'pending');
      assert.equal(await database.accessGatewayJobs.findBySubject(requestId), null);
      // The held PUT is the next one Edge decides; the one after it is A's cleanup.
      if (cleanup === 'fails') {
        crashed.edge.queueFailure(503, { error: 'gateway unavailable' }, path, 'PUT', 1);
      }

      const stale = await first;
      assert.ok(stale.statusCode >= 400, stale.body);
      assert.deepEqual(
        groupsOf(client.user.id),
        [],
        'the late write met a retired tag, so no group stands without a grant',
      );
      const released = await database.accessRequests.findById(requestId);
      assert.equal(released?.status, 'pending');
      assert.equal(released?.decided_by, null);
      assert.equal(await database.grants.findActiveByApiAndUser(apiId, client.user.id), null);
      assert.equal(await database.accessGatewayJobs.findBySubject(requestId), null);
    });
  }

  it('the one-time repair considers every candidate while the worker drains them', async () => {
    const client = await crashed.registerUser({ role: 'client' });
    const apiId = await publish(crashed);
    const stranded = new Set<string>();
    for (let index = 0; index < 5; index += 1) {
      const row = await database.accessRequests.create({
        api_id: apiId,
        user_id: client.user.id,
        application_id: null,
        justification: `Approved before 015 (${index})`,
        status: 'approved',
        decided_by: provider.user.id,
        decided_at: new Date().toISOString(),
        decision_note: null,
      });
      stranded.add(row.id);
    }

    // Each page read is followed by the worker settling what it returned, so
    // the approved set shrinks under the scan — an offset would skip rows.
    const requests = database.accessRequests;
    const draining = new Proxy(requests, {
      get(target, property, receiver): unknown {
        if (property !== 'pageByStatus') {
          const value: unknown = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        }
        const page: AccessRequestRepo['pageByStatus'] = async (status, afterId, limit) => {
          const rows = await target.pageByStatus(status, afterId, limit);
          for (const row of rows) {
            if (stranded.has(row.id)) {
              await target.updateIfStatus(row.id, 'approved', { status: 'cancelled' });
            }
          }
          return rows;
        };
        return page;
      },
    });
    const store = new Proxy(database, {
      get(target, property, receiver): unknown {
        if (property === 'accessRequests') return draining;
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const repair = await queueStrandedAccessRepairs({
      store,
      audit: restarted.services.audit,
      locks: createKeyedSerializer({ leases: database.leases }),
      namespace: 'nexus',
      pageSize: 2,
    });
    assert.equal(repair.alreadyRecorded, false);
    assert.ok(repair.approvals >= stranded.size);
    for (const id of stranded) {
      assert.equal((await database.accessGatewayJobs.findBySubject(id))?.kind, 'approve', id);
      await database.accessGatewayJobs.deleteBySubject(id);
    }
  });
});
