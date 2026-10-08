import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';

import {
  aclGroupForApi,
  mcpAllGroupForApi,
  mcpToolGroupForApi,
  type Api,
  type ApiErrorBody,
  type ApproveAccessRequestResponse,
  type CreateAccessRequestResponse,
  type CreateApplicationResponse,
  type Grant,
  type IssueCredentialResponse,
  type PublishApiResponse,
  type RepairGatewayReferencesResponse,
  type RequestGrantToolsResponse,
} from '@ferrum-nexus/shared';

import { AuditAction } from '../audit/service.js';
import { canonicalConsumerLockKey } from '../credentials/consumers.js';
import type {
  AccessRequestRecord,
  ConsumerRecord,
  GrantRecord,
  NexusStore,
  TransactionOptions,
} from '../db/store.js';
import { isoInSeconds, newId, nowIso } from '../lib/ids.js';
import { userLifecycleLockKey } from '../lib/keyed-serializer.js';
import { heldLeaseFences, outsideHeldLeases } from '../lib/lease-fence.js';
import { faultInjectingStore, type FaultInjectingStore } from './fault-injection.js';
import { buildTestApp, SAMPLE_SPEC_YAML, type TestApp, type TestSession } from './helpers.js';

/** Production revocation and consumer repair, with native transactions on every store. */
export function runMcpMembershipContract(
  label: string,
  makeStore: () => Promise<{
    store: NexusStore;
    teardown: () => Promise<void>;
    peer?: () => Promise<NexusStore>;
  }>,
): void {
  describe(`MCP membership recovery — ${label}`, () => {
    let target: Awaited<ReturnType<typeof makeStore>>;
    let faults: FaultInjectingStore;
    let harness: TestApp;
    let peer: TestApp;
    let peerStore: NexusStore | undefined;
    let founder: TestSession;
    let provider: TestSession;
    const patches: (() => void)[] = [];

    before(async () => {
      target = await makeStore();
      faults = faultInjectingStore(target.store);
      // Each test gets its own fault queue, including transaction-scoped calls.
      // An unreached fault still fails cleanup, but cannot poison the next fixture.
      const store = new Proxy(target.store, {
        get(_store, property): unknown {
          return Reflect.get(faults.store, property);
        },
      });
      harness = await buildTestApp({ store });
      peerStore = await target.peer?.();
      peer = await buildTestApp({ store: peerStore ?? target.store, edge: harness.edge });
      founder = await harness.registerUser();
      provider = await harness.registerUser({ role: 'provider' });
    });

    afterEach(() => {
      const pending = faults.pending();
      const failures: unknown[] = [];
      for (const restore of patches.splice(0).reverse()) {
        try {
          restore();
        } catch (error) {
          failures.push(error);
        }
      }
      harness.edge.clearInjections();
      faults = faultInjectingStore(target.store);
      assert.deepEqual(pending, [], 'every armed store fault was reached');
      if (failures.length > 0) throw new AggregateError(failures, 'fixture patch cleanup failed');
    });

    after(async () => {
      await peer?.close();
      await peerStore?.close();
      await harness?.close();
      await target?.teardown();
    });

    async function publish(): Promise<Api> {
      const response = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: {
          name: 'Membership recovery',
          slug: `membership-${newId().slice(0, 8)}`,
          spec: SAMPLE_SPEC_YAML,
          auth_plugin: 'key_auth',
          requestable: true,
          visibility: 'public',
          spec_enforcement: 'routes',
          agents: {
            operations: [
              { path: '/invoices', method: 'GET', name: 'list', description: 'List invoices' },
              { path: '/invoices/{id}', method: 'GET', name: 'get', description: 'Get invoice' },
            ],
          },
        },
      });
      assert.equal(response.statusCode, 201, response.body);
      const api = response.json<PublishApiResponse>().api;
      assert.ok(api.agents?.operations.every((tool) => tool.id));
      return api;
    }

    /** Expire every exposure id: a renamed tool is a new tool, a spec revision is not. */
    function renameTools(api: Api) {
      return {
        method: 'PATCH' as const,
        url: `/api/apis/${api.id}`,
        payload: {
          agents: {
            operations: api.agents!.operations.map(({ id: _id, ...tool }) => ({
              ...tool,
              name: `new_${tool.name}`,
            })),
          },
        },
      };
    }

    function toolIds(api: Api): string[] {
      const ids = api.agents?.operations.map((tool) => tool.id) ?? [];
      assert.equal(ids.length, 2);
      assert.ok(ids.every((id): id is string => typeof id === 'string'));
      return ids as string[];
    }

    async function identity(application: boolean) {
      const client = await harness.registerUser();
      let applicationId: string | null = null;
      if (application) {
        const created = await harness.authed(client, {
          method: 'POST',
          url: '/api/applications',
          payload: { name: 'Recovery integration' },
        });
        assert.equal(created.statusCode, 201, created.body);
        applicationId = created.json<CreateApplicationResponse>().application.id;
      }
      return { client, applicationId };
    }

    async function approve(
      client: TestSession,
      applicationId: string | null,
      api: Api,
      approvedTools: string[] | null | undefined,
    ): Promise<Grant> {
      const requested = await harness.authed(client, {
        method: 'POST',
        url: '/api/access-requests',
        // A broader request proves that repair uses the provider's approval.
        payload: { api_id: api.id, application_id: applicationId, justification: 'Recovery' },
      });
      assert.equal(requested.statusCode, 201, requested.body);
      const requestId = requested.json<CreateAccessRequestResponse>().access_request.id;
      const approved = await harness.authed(provider, {
        method: 'POST',
        url: `/api/access-requests/${requestId}/approve`,
        payload: approvedTools === undefined ? {} : { approved_tools: approvedTools },
      });
      assert.equal(approved.statusCode, 200, approved.body);
      return approved.json<ApproveAccessRequestResponse>().grant;
    }

    async function fixture(application: boolean, all = false) {
      const who = await identity(application);
      const api = await publish();
      const ids = toolIds(api);
      const grant = await approve(who.client, who.applicationId, api, all ? null : ids);
      const row = await target.store.consumers.findByUserAndNamespace(
        who.client.user.id,
        'nexus',
        who.applicationId,
      );
      assert.ok(row);
      const live = harness.edge.consumerByUsername(row.ferrum_username);
      assert.ok(live);
      return { ...who, api, ids, grant, row, live };
    }

    function revoke(grantId: string, app = harness) {
      return app.authed(provider, {
        method: 'POST',
        url: `/api/grants/${grantId}/revoke`,
        payload: { reason: 'Withdraw integration' },
      });
    }

    async function repair(userId: string) {
      const response = await harness.authed(founder, {
        method: 'POST',
        url: '/api/admin/gateway/repair',
        payload: { user_ids: [userId], reason: 'Rebuilt consumer' },
      });
      assert.equal(response.statusCode, 200, response.body);
      const result = response.json<RepairGatewayReferencesResponse>();
      for (const repaired of result.consumers) {
        assert.equal(repaired.user_id, userId);
        if (repaired.error !== null) continue;
        const row = await target.store.consumers.findByUserAndNamespace(
          userId,
          'nexus',
          repaired.application_id,
        );
        assert.ok(row);
        assert.equal(row.ferrum_consumer_id, repaired.ferrum_consumer_id);
        assert.ok(
          result.report.orphaned_consumers.some(
            (orphan) =>
              orphan.user_id === userId &&
              orphan.application_id === row.application_id &&
              orphan.ferrum_consumer_id === repaired.previous_ferrum_consumer_id &&
              orphan.ferrum_username === row.ferrum_username,
          ),
          'the production scan detected the exact repaired identity',
        );
        const live = await harness.edgeClient.consumers.get(row.ferrum_consumer_id);
        assert.equal(live?.username, row.ferrum_username);
        assert.equal(live?.custom_id, row.application_id ?? userId);
        const audit = await target.store.auditLogs.list({
          action: AuditAction.GATEWAY_CONSUMER_REPAIR,
          target_id: userId,
        });
        const entries = audit.items.filter(
          (entry) => entry.details.ferrum_username === row.ferrum_username,
        );
        assert.equal(entries.length, 1, 'successful recreation committed its membership audit');
        assert.equal(entries[0]?.details.consumer_id, row.ferrum_consumer_id);
        assert.equal(entries[0]?.details.restored_groups, repaired.restored_groups);
      }
      return result.consumers;
    }

    /** Lose only this gateway identity, retaining the mapping production repair scans. */
    async function orphanConsumer(row: ConsumerRecord): Promise<void> {
      const key = `${row.namespace}/${row.ferrum_consumer_id}`;
      const live = harness.edge.consumers.get(key);
      assert.equal(live?.username, row.ferrum_username);
      assert.equal(live?.custom_id, row.application_id ?? row.user_id);
      assert.ok(harness.edge.consumers.delete(key), 'the namespaced consumer was removed');
      assert.equal(await harness.edgeClient.consumers.get(row.ferrum_consumer_id), null);
      assert.equal(harness.edge.consumerByUsername(row.ferrum_username, row.namespace), undefined);
      assert.deepEqual(
        await target.store.consumers.findByUserAndNamespace(
          row.user_id,
          row.namespace,
          row.application_id,
        ),
        row,
        'the orphan retains its identity-scoped Nexus mapping',
      );
    }

    function countAudit(action: string, targetId: string): Promise<number> {
      return target.store.auditLogs.count({ action, target_id: targetId });
    }

    async function requestStatus(grant: Grant): Promise<string | undefined> {
      assert.ok(grant.access_request_id);
      return (await target.store.accessRequests.findById(grant.access_request_id))?.status;
    }

    async function details(action: string, targetId: string) {
      const rows = await target.store.auditLogs.list({ action, target_id: targetId });
      assert.equal(rows.total, 1);
      return rows.items[0]?.details;
    }

    /** Interleave a real store/gateway transition after the revoke claim, before its failed PUT. */
    function beforeFailedRemoval(consumerId: string, work: () => Promise<void>): void {
      const consumers = harness.edgeClient.consumers;
      const replace = consumers.replace.bind(consumers);
      let reached = false;
      consumers.replace = async (...args) => {
        if (!reached && args[0] === consumerId) {
          reached = true;
          await work();
          harness.edge.queueFailure(
            503,
            { error: 'removal refused' },
            `/consumers/${consumerId}`,
            'PUT',
          );
        }
        return replace(...args);
      };
      patches.push(() => {
        consumers.replace = replace;
        assert.ok(reached, 'the claimed revocation reached its gateway PUT');
      });
    }

    /** Simulate takeover of only the proxy lease, leaving inner keys intact. */
    async function loseProxyLease(key: string): Promise<void> {
      const fence = heldLeaseFences().find((lease) => lease.key === key);
      assert.ok(fence, 'the caller holds the proxy acquisition being expired');
      assert.ok(await target.store.leases.release(key, fence.token));
      assert.ok(
        await target.store.leases.acquire(key, 'newer-publisher', isoInSeconds(600), nowIso()),
      );
      assert.ok(await target.store.leases.release(key, 'newer-publisher'));
    }

    for (const application of [false, true]) {
      const scope = application ? 'application' : 'account';

      for (const remaining of ['rest', 'tool', 'partial', 'all'] as const) {
        it(`${scope}: retries and audits ${remaining} membership`, async () => {
          const f = await fixture(application, remaining === 'all');
          const rest = aclGroupForApi(f.api.id);
          const tool = mcpToolGroupForApi(f.api.id, f.ids[0]!);
          const all = mcpAllGroupForApi(f.api.id);
          const kept =
            remaining === 'rest'
              ? [rest]
              : remaining === 'partial'
                ? [rest, tool]
                : remaining === 'all'
                  ? [all]
                  : [tool];
          f.live.acl_groups = ['operator-kept', ...kept];
          harness.edge.queueFailure(503, { error: 'refused' }, `/consumers/${f.live.id}`, 'PUT');

          const failed = await revoke(f.grant.id);
          assert.equal(failed.statusCode, 502, failed.body);
          assert.equal((await target.store.grants.findById(f.grant.id))?.status, 'active');
          const request = await target.store.accessRequests.findById(f.grant.access_request_id!);
          assert.equal(request?.status, 'approved');
          assert.deepEqual(request?.approved_tools, remaining === 'all' ? null : f.ids);
          assert.deepEqual(harness.edge.consumerByUsername(f.row.ferrum_username)?.acl_groups, [
            'operator-kept',
            ...kept,
          ]);
          assert.equal(
            (await details(AuditAction.ACCESS_REVOKE_ROLLBACK, f.grant.id))?.grant_restored,
            true,
          );

          const retried = await revoke(f.grant.id, peer);
          assert.equal(retried.statusCode, 200, retried.body);
          assert.equal((await target.store.grants.findById(f.grant.id))?.status, 'revoked');
          assert.equal(await requestStatus(f.grant), 'revoked');
          assert.deepEqual(harness.edge.consumerByUsername(f.row.ferrum_username)?.acl_groups, [
            'operator-kept',
          ]);
          assert.equal(await countAudit(AuditAction.ACCESS_REVOKE, f.grant.id), 2);
          const writes = harness.edge.requests.length;
          assert.equal((await revoke(f.grant.id)).statusCode, 409);
          assert.equal(
            harness.edge.requests.length,
            writes,
            'a settled repeat performs no gateway write',
          );
        });
      }

      for (const missing of ['groups', 'consumer', 'exposure'] as const) {
        it(`${scope}: does not restore with no ${missing} remaining`, async () => {
          const f = await fixture(application);
          if (missing === 'exposure') {
            const changed = await harness.authed(provider, renameTools(f.api));
            assert.equal(changed.statusCode, 200, changed.body);
          }
          if (missing === 'consumer') await orphanConsumer(f.row);
          else {
            f.live.acl_groups = [
              'operator-kept',
              mcpToolGroupForApi(f.api.id, missing === 'exposure' ? f.ids[0]! : newId()),
            ];
            harness.edge.queueFailure(503, { error: 'refused' }, `/consumers/${f.live.id}`, 'PUT');
          }
          const writes = harness.edge.callsTo('PUT', `/consumers/${f.live.id}`).length;
          const creations = harness.edge.callsTo('POST', '/consumers').length;
          const revoked = await revoke(f.grant.id);
          assert.equal(revoked.statusCode, 502, revoked.body);
          assert.equal((await target.store.grants.findById(f.grant.id))?.status, 'revoked');
          assert.equal(await requestStatus(f.grant), 'revoked');
          assert.equal(await countAudit(AuditAction.ACCESS_REVOKE, f.grant.id), 1);
          assert.equal(await countAudit(AuditAction.ACCESS_REVOKE_ROLLBACK, f.grant.id), 1);
          const rollback = await details(AuditAction.ACCESS_REVOKE_ROLLBACK, f.grant.id);
          assert.equal(rollback?.grant_restored, false);
          assert.equal(rollback?.restore_skipped_reason, 'group_absent');
          if (missing === 'consumer') {
            assert.deepEqual(revoked.json<ApiErrorBody>(), {
              error: {
                code: 'EDGE_ERROR',
                message: 'The gateway consumer for this account no longer exists',
                details: { consumer_id: f.row.ferrum_consumer_id },
              },
            });
            assert.equal(
              harness.edge.consumerByUsername(f.row.ferrum_username, f.row.namespace),
              undefined,
            );
            assert.equal(await harness.edgeClient.consumers.get(f.row.ferrum_consumer_id), null);
            assert.deepEqual(await target.store.consumers.findById(f.row.id), f.row);
            assert.equal(harness.edge.callsTo('PUT', `/consumers/${f.live.id}`).length, writes);
            assert.equal(harness.edge.callsTo('POST', '/consumers').length, creations);
          }
        });
      }

      it(`${scope}: keeps conservative rollback when the gateway cannot be read`, async () => {
        const f = await fixture(application);
        f.live.acl_groups = [mcpToolGroupForApi(f.api.id, f.ids[0]!)];
        beforeFailedRemoval(f.live.id, async () => {
          harness.edge.queueFailure(503, { error: 'unreadable' }, `/consumers/${f.live.id}`, 'GET');
        });
        assert.equal((await revoke(f.grant.id)).statusCode, 502);
        assert.equal((await target.store.grants.findById(f.grant.id))?.status, 'active');
        assert.equal(
          (await details(AuditAction.ACCESS_REVOKE_ROLLBACK, f.grant.id))?.grant_restored,
          true,
        );
      });

      it(`${scope}: retries an audit-failed restore`, async () => {
        const f = await fixture(application);
        f.live.acl_groups = [mcpToolGroupForApi(f.api.id, f.ids[0]!)];
        faults.failAfter('auditLogs', 'create', 1);
        harness.edge.queueFailure(503, { error: 'refused' }, `/consumers/${f.live.id}`, 'PUT');
        assert.equal((await revoke(f.grant.id)).statusCode, 502);
        assert.equal((await target.store.grants.findById(f.grant.id))?.status, 'active');
        assert.equal(await requestStatus(f.grant), 'approved');
        assert.equal(
          (await details(AuditAction.ACCESS_REVOKE_ROLLBACK, f.grant.id))?.grant_restored,
          true,
        );
        assert.equal((await revoke(f.grant.id)).statusCode, 200);
      });

      for (const slot of ['free', 'taken'] as const) {
        it(`${scope}: restores the tool request it cancelled (slot ${slot})`, async () => {
          const who = await identity(application);
          const api = await publish();
          const ids = toolIds(api);
          const grant = await approve(who.client, who.applicationId, api, [ids[0]!]);
          const row = await target.store.consumers.findByUserAndNamespace(
            who.client.user.id,
            'nexus',
            who.applicationId,
          );
          assert.ok(row);
          const asked = await harness.authed(who.client, {
            method: 'POST',
            url: `/api/grants/${grant.id}/tool-requests`,
            payload: { requested_tools: [ids[1]!], justification: 'More tools' },
          });
          assert.equal(asked.statusCode, 201, asked.body);
          const pending = asked.json<RequestGrantToolsResponse>().access_request;
          const before = await target.store.accessRequests.findById(pending.id);
          assert.ok(before);
          const taken: { request?: AccessRequestRecord } = {};
          beforeFailedRemoval(row.ferrum_consumer_id, async () => {
            const cancelled = await target.store.accessRequests.findById(pending.id);
            assert.equal(cancelled?.status, 'cancelled');
            // The claim freed the identity's one pending slot; a newer request
            // that took it must not be displaced by the rollback.
            if (slot === 'taken') {
              taken.request = await target.store.accessRequests.create({
                api_id: api.id,
                user_id: who.client.user.id,
                application_id: who.applicationId,
                justification: 'Asked again',
                requested_tools: [ids[0]!],
                status: 'pending',
              });
            }
          });

          const failed = await revoke(grant.id);
          assert.equal(failed.statusCode, 502, failed.body);
          assert.equal((await target.store.grants.findById(grant.id))?.status, 'active');
          assert.equal(await requestStatus(grant), 'approved');
          assert.equal(await countAudit(AuditAction.ACCESS_CANCEL, pending.id), 1);
          const rollback = await details(AuditAction.ACCESS_REVOKE_ROLLBACK, grant.id);
          assert.equal(rollback?.grant_restored, true);
          const after = await target.store.accessRequests.findById(pending.id);
          if (slot === 'taken') {
            assert.equal(rollback?.tool_request_restored, undefined);
            assert.equal(after?.status, 'cancelled');
            const held = await target.store.accessRequests.findPendingByApiAndUser(
              api.id,
              who.client.user.id,
              who.applicationId,
            );
            assert.ok(taken.request);
            assert.equal(held?.id, taken.request.id);
            return;
          }
          assert.equal(rollback?.tool_request_restored, pending.id);
          assert.equal(after?.status, 'pending');
          assert.equal(after?.grant_id, grant.id);
          assert.deepEqual(after?.requested_tools, before.requested_tools);
          assert.equal(after?.justification, before.justification);
          assert.equal(after?.decided_by, before.decided_by);
          assert.equal(after?.decided_at, before.decided_at);
          assert.equal(after?.decision_note, before.decision_note);

          // The restored request is the provider's to decide, as it was before.
          const approved = await harness.authed(provider, {
            method: 'POST',
            url: `/api/access-requests/${pending.id}/approve`,
            payload: {},
          });
          assert.equal(approved.statusCode, 200, approved.body);
          assert.deepEqual((await target.store.grants.findById(grant.id))?.approved_tools, ids);
        });
      }

      for (const unreadable of [false, true]) {
        it(`${scope}: preserves a committed rollback (unreadable=${unreadable})`, async () => {
          const f = await fixture(application);
          f.live.acl_groups = [mcpToolGroupForApi(f.api.id, f.ids[0]!)];
          const before = await target.store.accessRequests.findById(f.grant.access_request_id!);
          assert.ok(before);
          const transaction = target.store.transaction.bind(target.store);
          let dropped = false;
          target.store.transaction = async <T>(
            body: (tx: NexusStore) => Promise<T>,
            options?: TransactionOptions,
          ): Promise<T> => {
            const rows = await countAudit(AuditAction.ACCESS_REVOKE_ROLLBACK, f.grant.id);
            const result = await transaction(body, options);
            if (
              !dropped &&
              (await countAudit(AuditAction.ACCESS_REVOKE_ROLLBACK, f.grant.id)) > rows
            ) {
              dropped = true;
              if (unreadable) faults.failNext('auditLogs', 'list');
              throw new Error('the rollback committed but its acknowledgement was lost');
            }
            return result;
          };
          patches.push(() => {
            target.store.transaction = transaction;
          });
          harness.edge.queueFailure(503, { error: 'refused' }, `/consumers/${f.live.id}`, 'PUT');
          const failed = await revoke(f.grant.id);
          assert.equal(failed.statusCode, 502, failed.body);
          assert.ok(dropped);
          assert.equal((await target.store.grants.findById(f.grant.id))?.status, 'active');
          const request = await target.store.accessRequests.findById(f.grant.access_request_id!);
          assert.equal(request?.status, before.status);
          assert.equal(request?.decided_by, before.decided_by);
          assert.equal(request?.decided_at, before.decided_at);
          assert.equal(request?.decision_note, before.decision_note);
          assert.deepEqual(request?.approved_tools, before.approved_tools);
          assert.deepEqual(request?.requested_tools, before.requested_tools);
          assert.deepEqual(f.live.acl_groups, [mcpToolGroupForApi(f.api.id, f.ids[0]!)]);
          const rows = await target.store.auditLogs.list({
            action: AuditAction.ACCESS_REVOKE_ROLLBACK,
            target_id: f.grant.id,
          });
          assert.equal(rows.total, unreadable ? 2 : 1);
          assert.ok(rows.items.every((row) => row.details.grant_restored === true));
          assert.equal(await countAudit(AuditAction.ACCESS_REVOKE, f.grant.id), 1);
        });
      }

      for (const timing of ['before-read', 'after-read'] as const) {
        it(
          `${scope}: expires exposure ${timing} during fallback`,
          { timeout: 10_000 },
          async () => {
            const f = await fixture(application);
            const groups = ['operator-kept', mcpToolGroupForApi(f.api.id, f.ids[0]!)];
            f.live.acl_groups = [...groups];
            assert.ok(f.api.ferrum_proxy_id);
            const key = `proxy:${f.api.ferrum_proxy_id}`;
            const claimed: { grant?: GrantRecord; request?: AccessRequestRecord } = {};
            let failedRemoval = false;
            beforeFailedRemoval(f.live.id, async () => {
              const grant = await target.store.grants.findById(f.grant.id);
              assert.ok(grant?.access_request_id);
              claimed.grant = grant;
              const request = await target.store.accessRequests.findById(grant.access_request_id);
              assert.ok(request);
              claimed.request = request;
              assert.equal(grant.status, 'revoked');
              assert.equal(request.status, 'revoked');
              await loseProxyLease(key);
              failedRemoval = true;
            });

            let rotated = false;
            const rotate = async (): Promise<void> => {
              const writes = harness.edge.callsTo('PUT', `/consumers/${f.live.id}`).length;
              // A separate process does not inherit the revoker's stale fences.
              const changed = await outsideHeldLeases(() =>
                peer.authed(provider, renameTools(f.api)),
              );
              assert.equal(changed.statusCode, 200, changed.body);
              const current = await target.store.apis.findById(f.api.id);
              assert.ok(current?.agents);
              assert.ok(
                current.agents.operations.every((tool) => tool.id && !f.ids.includes(tool.id)),
              );
              assert.equal(harness.edge.callsTo('PUT', `/consumers/${f.live.id}`).length, writes);
              const gateway = harness.edge
                .effectivePluginsForProxy(current.ferrum_proxy_id ?? '')
                .find((plugin) => plugin.plugin_name === 'mcp_gateway');
              assert.ok(gateway);
              const policy = (
                gateway.config as {
                  policy: { tools: Record<string, { allowed_groups: string[] }> };
                }
              ).policy;
              for (const tool of current.agents.operations) {
                const allowed: string[] | undefined =
                  policy.tools[`${current.slug}.${tool.name}`]?.allowed_groups;
                assert.ok(allowed);
                assert.equal(
                  allowed.some((group) => groups.includes(group)),
                  false,
                );
              }
              assert.deepEqual(
                f.live.acl_groups,
                groups,
                'the expired group remains inert on Edge',
              );
              rotated = true;
            };
            const serialize = harness.edgeClient.serializePerKey.bind(harness.edgeClient);
            let proxyPasses = 0;
            harness.edgeClient.serializePerKey = async (requested, work) => {
              if (requested === key && ++proxyPasses === 2) {
                assert.deepEqual(
                  heldLeaseFences(),
                  [],
                  'all stale keys exited before reacquisition',
                );
                if (timing === 'before-read') await rotate();
              }
              return serialize(requested, work);
            };
            patches.push(() => {
              harness.edgeClient.serializePerKey = serialize;
            });
            const consumers = harness.edgeClient.consumers;
            const get = consumers.get.bind(consumers);
            let rollbackReads = 0;
            let lateRead = false;
            let rotationError: unknown;
            consumers.get = async (...args) => {
              const live = await get(...args);
              if (args[0] === f.live.id && failedRemoval) {
                rollbackReads += 1;
                if (proxyPasses === 2 && timing === 'after-read' && !lateRead) {
                  lateRead = true;
                  // Publishing expires the exposure after fallback read its IDs
                  // and membership. Only the fresh proxy fence can refuse the
                  // restore: an explicit subset publisher needs no consumer key.
                  try {
                    assert.ok(heldLeaseFences().some((lease) => lease.key === key));
                    assert.deepEqual(live?.acl_groups, groups);
                    const eligible = await target.store.apis.findById(f.api.id);
                    assert.deepEqual(
                      eligible?.agents?.operations.map((tool) => tool.id),
                      f.ids,
                    );
                    await loseProxyLease(key);
                    await rotate();
                  } catch (error) {
                    // groupStillOn intentionally catches unreadable-gateway errors;
                    // retain fixture failures so they cannot masquerade as that path.
                    rotationError = error;
                    throw error;
                  }
                }
              }
              return live;
            };
            patches.push(() => {
              consumers.get = get;
            });

            const failed = await revoke(f.grant.id);
            assert.equal(failed.statusCode, 502, failed.body);
            if (rotationError) throw rotationError;
            assert.ok(rotated, 'a production publisher actually replaced the exposure');
            assert.equal(lateRead, timing === 'after-read');
            assert.deepEqual(await target.store.grants.findById(f.grant.id), claimed.grant);
            assert.deepEqual(
              await target.store.accessRequests.findById(f.grant.access_request_id!),
              claimed.request,
            );
            assert.equal(proxyPasses, 2, 'fallback reacquired the proxy before its inner keys');
            assert.equal(rollbackReads, 2);
            assert.equal(await countAudit(AuditAction.ACCESS_REVOKE, f.grant.id), 1);
            const rollback = await details(AuditAction.ACCESS_REVOKE_ROLLBACK, f.grant.id);
            assert.equal(rollback?.grant_restored, false);
            assert.equal(
              rollback?.restore_skipped_reason,
              timing === 'before-read' ? 'group_absent' : undefined,
            );
            assert.deepEqual(f.live.acl_groups, groups);

            await orphanConsumer(f.row);
            const [repaired] = await repair(f.client.user.id);
            assert.equal(repaired?.error, null);
            assert.equal(repaired?.restored_groups, 0);
            for (const status of ['disabled', 'active']) {
              const response = await peer.authed(founder, {
                method: 'PATCH',
                url: `/api/users/${f.client.user.id}`,
                payload: { status },
              });
              assert.equal(response.statusCode, 200, response.body);
            }
            assert.deepEqual(
              harness.edge.consumerByUsername(f.row.ferrum_username)?.acl_groups,
              [],
            );
            assert.deepEqual(await target.store.grants.findById(f.grant.id), claimed.grant);
            assert.equal(await requestStatus(f.grant), 'revoked');
          },
        );
      }

      it(`${scope}: preserves a newer revoked claim`, async () => {
        const f = await fixture(application);
        f.live.acl_groups = [mcpToolGroupForApi(f.api.id, f.ids[0]!)];
        const newerAt = isoInSeconds(60);
        beforeFailedRemoval(f.live.id, async () => {
          await peer.store.transaction(async (tx) => {
            assert.ok(await tx.grants.updateIfStatus(f.grant.id, 'revoked', { status: 'active' }));
            assert.ok(
              await tx.grants.updateIfStatus(f.grant.id, 'active', {
                status: 'revoked',
                revoked_by: founder.user.id,
                revoked_at: newerAt,
              }),
            );
          });
        });
        assert.equal((await revoke(f.grant.id)).statusCode, 502);
        const current = await target.store.grants.findById(f.grant.id);
        assert.equal(current?.status, 'revoked');
        assert.equal(current?.revoked_at, newerAt);
        assert.equal(
          (await details(AuditAction.ACCESS_REVOKE_ROLLBACK, f.grant.id))?.grant_restored,
          false,
        );
      });

      for (const reenable of [false, true]) {
        it(`${scope}: respects disable (re-enable=${reenable})`, async () => {
          const f = await fixture(application);
          f.live.acl_groups = [mcpToolGroupForApi(f.api.id, f.ids[0]!)];
          const provisioner = harness.services.credentials.provisioner;
          const mutate = provisioner.mutateAclGroups.bind(provisioner);
          let changed = false;
          provisioner.mutateAclGroups = async (...args) => {
            if (!changed && args[0] === f.live.id) {
              changed = true;
              for (const status of reenable ? ['disabled', 'active'] : ['disabled']) {
                const response = await peer.authed(founder, {
                  method: 'PATCH',
                  url: `/api/users/${f.client.user.id}`,
                  payload: { status },
                });
                assert.equal(response.statusCode, 200, response.body);
              }
              harness.edge.queueFailure(
                503,
                { error: 'refused' },
                `/consumers/${f.live.id}`,
                'PUT',
              );
            }
            return mutate(...args);
          };
          patches.push(() => {
            provisioner.mutateAclGroups = mutate;
          });
          assert.equal((await revoke(f.grant.id)).statusCode, 502);
          assert.ok(changed);
          assert.equal((await target.store.grants.findById(f.grant.id))?.status, 'revoked');
          const rollback = await details(AuditAction.ACCESS_REVOKE_ROLLBACK, f.grant.id);
          assert.equal(rollback?.grant_restored, false);
          assert.equal(
            rollback?.restore_skipped_reason,
            reenable ? 'group_absent' : 'grantee_disabled',
          );
          assert.deepEqual(harness.edge.consumerByUsername(f.row.ferrum_username)?.acl_groups, []);
        });
      }

      for (const change of ['rename', 'spec', 'off'] as const) {
        it(`${scope}: repair respects ${change} exposure`, async () => {
          const f = await fixture(application);
          const updated = await harness.authed(
            provider,
            change === 'spec'
              ? {
                  method: 'PUT',
                  url: `/api/apis/${f.api.id}/spec`,
                  payload: { spec: SAMPLE_SPEC_YAML.replace('version: 2.4.0', 'version: 2.4.1') },
                }
              : {
                  method: 'PATCH',
                  url: `/api/apis/${f.api.id}`,
                  payload: {
                    agents:
                      change === 'off'
                        ? null
                        : {
                            operations: f.api.agents!.operations.map(({ id: _id, ...tool }) => ({
                              ...tool,
                              name: `new_${tool.name}`,
                            })),
                          },
                  },
                },
          );
          assert.equal(updated.statusCode, 200, updated.body);
          // A spec revision keeps exposure ids, so the subset carries; a rename
          // or disable removes them from the subset in the edit's transaction.
          const carried = change === 'spec';
          const approved = carried ? f.ids : [];
          await orphanConsumer(f.row);
          const [repaired] = await repair(f.client.user.id);
          assert.equal(repaired?.error, null);
          const groups = harness.edge.consumerByUsername(f.row.ferrum_username)?.acl_groups;
          assert.ok(groups);
          assert.equal(repaired?.restored_groups, groups.length);
          assert.deepEqual(groups, [
            aclGroupForApi(f.api.id),
            ...approved.map((id) => mcpToolGroupForApi(f.api.id, id)),
          ]);
          assert.ok(groups.includes(aclGroupForApi(f.api.id)));
          assert.equal(groups.includes(mcpAllGroupForApi(f.api.id)), false);
          const current = await target.store.apis.findById(f.api.id);
          if (change === 'off') {
            assert.deepEqual(groups, [aclGroupForApi(f.api.id)]);
          } else {
            assert.ok(current?.agents);
            const gateway = harness.edge
              .effectivePluginsForProxy(current.ferrum_proxy_id ?? '')
              .find((plugin) => plugin.plugin_name === 'mcp_gateway');
            assert.ok(gateway);
            const policy = (
              gateway.config as {
                policy: { tools: Record<string, { allowed_groups: string[] }> };
              }
            ).policy;
            for (const tool of current.agents.operations) {
              assert.ok(tool.id);
              assert.equal(f.ids.includes(tool.id), carried);
              assert.equal(groups.includes(mcpToolGroupForApi(f.api.id, tool.id)), carried);
              const allowed: string[] | undefined =
                policy.tools[`${current.slug}.${tool.name}`]?.allowed_groups;
              assert.ok(allowed);
              assert.deepEqual(allowed, [
                mcpAllGroupForApi(f.api.id),
                mcpToolGroupForApi(f.api.id, tool.id),
              ]);
              assert.equal(
                allowed.some((group) => groups.includes(group)),
                carried,
              );
            }
          }
          assert.deepEqual(
            (await target.store.grants.findById(f.grant.id))?.approved_tools,
            approved,
          );
          assert.equal(
            await countAudit(AuditAction.ACCESS_TOOLS_PRUNE, f.grant.id),
            carried ? 0 : 1,
          );
          if (!carried) {
            assert.deepEqual(
              (await details(AuditAction.ACCESS_TOOLS_PRUNE, f.grant.id))?.removed_tools,
              f.ids,
            );
          }
        });
      }

      it(`${scope}: repairs every approved subset within its identity`, async () => {
        const who = await identity(application);
        const expected: string[] = [];
        for (const kind of ['default', 'null', 'empty', 'subset'] as const) {
          const api = await publish();
          const ids = toolIds(api);
          const approved =
            kind === 'default'
              ? undefined
              : kind === 'null'
                ? null
                : kind === 'empty'
                  ? []
                  : [ids[0]!];
          await approve(who.client, who.applicationId, api, approved);
          expected.push(aclGroupForApi(api.id));
          if (kind === 'default' || kind === 'null') expected.push(mcpAllGroupForApi(api.id));
          if (kind === 'subset') expected.push(mcpToolGroupForApi(api.id, ids[0]!));
        }
        const sibling = await harness.authed(who.client, {
          method: 'POST',
          url: '/api/applications',
          payload: { name: 'Separate scope' },
        });
        assert.equal(sibling.statusCode, 201, sibling.body);
        const siblingId = sibling.json<CreateApplicationResponse>().application.id;
        const otherApi = await publish();
        await approve(who.client, siblingId, otherApi, null);
        if (application) await approve(who.client, null, await publish(), null);
        const issued = await harness.authed(who.client, {
          method: 'POST',
          url: '/api/credentials',
          payload: { credential_type: 'keyauth', application_id: who.applicationId },
        });
        assert.equal(issued.statusCode, 201, issued.body);
        const credential = issued.json<IssueCredentialResponse>().credential;
        const row = await target.store.consumers.findByUserAndNamespace(
          who.client.user.id,
          'nexus',
          who.applicationId,
        );
        assert.ok(row);
        await orphanConsumer(row);
        const [repaired] = await repair(who.client.user.id);
        assert.equal(repaired?.error, null);
        assert.equal(repaired?.application_id, who.applicationId);
        assert.equal(repaired?.restored_groups, expected.length);
        assert.equal(repaired?.credentials_requiring_reissue, 1);
        assert.equal((await target.store.credentials.findById(credential.id))?.status, 'revoked');
        const live = harness.edge.consumerByUsername(row.ferrum_username);
        assert.ok(live);
        assert.deepEqual([...live.acl_groups].sort(), expected.sort());
        assert.deepEqual(live.credentials, {}, 'repair never mints replacement secrets');
        const audit = await details(AuditAction.GATEWAY_CONSUMER_REPAIR, who.client.user.id);
        assert.equal(audit?.restored_groups, expected.length);
        assert.deepEqual(audit?.revoked_credential_ids, [credential.id]);
        live.acl_groups.push('operator-kept');
        const repeated = await repair(who.client.user.id);
        assert.ok(repeated[0]?.error);
        assert.ok(live.acl_groups.includes('operator-kept'));
        assert.equal(await countAudit(AuditAction.GATEWAY_CONSUMER_REPAIR, who.client.user.id), 1);
      });

      for (const transition of ['revoke', 'disable'] as const) {
        it(`${scope}: repair re-reads after ${transition}`, async () => {
          const f = await fixture(application);
          await orphanConsumer(f.row);
          const writes = harness.edge.callsTo('PUT', `/consumers/${f.live.id}`).length;
          const creations = harness.edge.callsTo('POST', '/consumers').length;
          const key = canonicalConsumerLockKey('nexus', f.row.ferrum_username);
          const serialize = harness.edgeClient.serializePerKey.bind(harness.edgeClient);
          let interleaved = false;
          harness.edgeClient.serializePerKey = async (requested, work) => {
            if (requested === key && !interleaved) {
              interleaved = true;
              const response =
                transition === 'revoke'
                  ? await revoke(f.grant.id, peer)
                  : await peer.authed(founder, {
                      method: 'PATCH',
                      url: `/api/users/${f.client.user.id}`,
                      payload: { status: 'disabled' },
                    });
              assert.equal(response.statusCode, transition === 'revoke' ? 502 : 200, response.body);
              if (transition === 'revoke') {
                assert.deepEqual(response.json<ApiErrorBody>(), {
                  error: {
                    code: 'EDGE_ERROR',
                    message: 'The gateway consumer for this account no longer exists',
                    details: { consumer_id: f.row.ferrum_consumer_id },
                  },
                });
                assert.equal(
                  harness.edge.consumerByUsername(f.row.ferrum_username, f.row.namespace),
                  undefined,
                );
                assert.equal(
                  await harness.edgeClient.consumers.get(f.row.ferrum_consumer_id),
                  null,
                );
                assert.deepEqual(await target.store.consumers.findById(f.row.id), f.row);
                assert.equal(harness.edge.callsTo('PUT', `/consumers/${f.live.id}`).length, writes);
                assert.equal(harness.edge.callsTo('POST', '/consumers').length, creations);
              }
            }
            return serialize(requested, work);
          };
          patches.push(() => {
            harness.edgeClient.serializePerKey = serialize;
          });
          const [repaired] = await repair(f.client.user.id);
          assert.ok(interleaved);
          assert.equal(repaired?.error, null);
          assert.equal(repaired?.restored_groups, 0);
          assert.deepEqual(harness.edge.consumerByUsername(f.row.ferrum_username)?.acl_groups, []);
          if (transition === 'revoke') {
            assert.equal((await target.store.grants.findById(f.grant.id))?.status, 'revoked');
            assert.equal(await requestStatus(f.grant), 'revoked');
            assert.equal(await countAudit(AuditAction.ACCESS_REVOKE, f.grant.id), 1);
            assert.equal(await countAudit(AuditAction.ACCESS_REVOKE_ROLLBACK, f.grant.id), 1);
            const rollback = await details(AuditAction.ACCESS_REVOKE_ROLLBACK, f.grant.id);
            assert.equal(rollback?.grant_restored, false);
            assert.equal(rollback?.restore_skipped_reason, 'group_absent');
          } else {
            assert.equal((await target.store.users.findById(f.client.user.id))?.status, 'disabled');
            assert.equal((await target.store.grants.findById(f.grant.id))?.status, 'active');
            assert.equal(await requestStatus(f.grant), 'approved');
            assert.equal(await countAudit(AuditAction.USER_DISABLE, f.client.user.id), 1);
          }
        });
      }

      it(`${scope}: retries an audit-failed repair`, async () => {
        const f = await fixture(application);
        const issued = await harness.authed(f.client, {
          method: 'POST',
          url: '/api/credentials',
          payload: { credential_type: 'keyauth', application_id: f.applicationId },
        });
        assert.equal(issued.statusCode, 201, issued.body);
        const credential = issued.json<IssueCredentialResponse>().credential;
        await orphanConsumer(f.row);
        const cause = new Error('membership repair audit refused');
        faults.failNext('auditLogs', 'create', cause);
        const [failed] = await repair(f.client.user.id);
        assert.deepEqual(faults.pending(), [], 'the repair consumed its audit fault');
        assert.equal(failed?.error, cause.message);
        assert.equal(harness.edge.consumerByUsername(f.row.ferrum_username), undefined);
        assert.equal((await target.store.credentials.findById(credential.id))?.status, 'active');
        assert.deepEqual(await target.store.consumers.findById(f.row.id), f.row);
        assert.equal(await countAudit(AuditAction.GATEWAY_CONSUMER_REPAIR, f.client.user.id), 0);
        const [retried] = await repair(f.client.user.id);
        assert.equal(retried?.error, null);
        assert.equal(retried?.credentials_requiring_reissue, 1);
        assert.equal((await target.store.credentials.findById(credential.id))?.status, 'revoked');
        assert.equal((await target.store.grants.findById(f.grant.id))?.status, 'active');
        assert.equal(await requestStatus(f.grant), 'approved');
        assert.deepEqual(harness.edge.consumerByUsername(f.row.ferrum_username)?.acl_groups, [
          aclGroupForApi(f.api.id),
          ...f.ids.map((id) => mcpToolGroupForApi(f.api.id, id)),
        ]);
        assert.deepEqual(harness.edge.consumerByUsername(f.row.ferrum_username)?.credentials, {});
      });
    }

    it('a disabled application retains only its own previously approved subset', async () => {
      const f = await fixture(true);
      beforeFailedRemoval(f.live.id, async () => {
        const disabled = await peer.authed(f.client, {
          method: 'PATCH',
          url: `/api/applications/${f.applicationId}`,
          payload: { status: 'disabled' },
        });
        assert.equal(disabled.statusCode, 200, disabled.body);
      });
      f.live.acl_groups = [mcpToolGroupForApi(f.api.id, f.ids[0]!)];
      assert.equal((await revoke(f.grant.id)).statusCode, 502);
      assert.equal((await target.store.grants.findById(f.grant.id))?.status, 'active');
      await orphanConsumer(f.row);
      const [repaired] = await repair(f.client.user.id);
      assert.equal(repaired?.error, null);
      assert.deepEqual(harness.edge.consumerByUsername(f.row.ferrum_username)?.acl_groups, [
        aclGroupForApi(f.api.id),
        ...f.ids.map((id) => mcpToolGroupForApi(f.api.id, id)),
      ]);
    });

    it('recovery refuses mismatched application ownership', async () => {
      const f = await fixture(true);
      const other = await harness.registerUser();
      // Native retained rows, rather than an application lookup stub: the
      // database foreign keys alone do not establish application ownership.
      assert.ok(await target.store.consumers.delete(f.row.id));
      const mismatched = await target.store.consumers.create({
        user_id: other.user.id,
        application_id: f.applicationId,
        namespace: 'nexus',
        ferrum_consumer_id: f.live.id,
        ferrum_username: f.row.ferrum_username,
      });
      const grant = await target.store.grants.create({
        api_id: f.api.id,
        user_id: other.user.id,
        application_id: f.applicationId,
        acl_group: aclGroupForApi(f.api.id),
        status: 'active',
        granted_by: provider.user.id,
        approved_tools: f.ids,
      });
      f.live.acl_groups = [mcpToolGroupForApi(f.api.id, f.ids[0]!)];
      harness.edge.queueFailure(503, { error: 'refused' }, `/consumers/${f.live.id}`, 'PUT');
      assert.equal((await revoke(grant.id)).statusCode, 502);
      assert.equal((await target.store.grants.findById(grant.id))?.status, 'revoked');
      const rollback = await details(AuditAction.ACCESS_REVOKE_ROLLBACK, grant.id);
      assert.equal(rollback?.grant_restored, false);
      assert.equal(rollback?.restore_skipped_reason, 'application_missing');

      const active = await target.store.grants.create({
        api_id: f.api.id,
        user_id: other.user.id,
        application_id: f.applicationId,
        acl_group: aclGroupForApi(f.api.id),
        status: 'active',
        granted_by: provider.user.id,
        approved_tools: null,
      });
      await orphanConsumer(mismatched);
      const [repaired] = await repair(other.user.id);
      assert.equal(repaired?.error, null);
      assert.equal(repaired?.restored_groups, 0);
      assert.equal((await target.store.grants.findById(active.id))?.status, 'active');
      assert.deepEqual(harness.edge.consumerByUsername(f.row.ferrum_username)?.acl_groups, []);
    });

    it('repair ignores grants from a different API namespace', async () => {
      const f = await fixture(false);
      await target.store.apis.update(f.api.id, { namespace: 'another-namespace' });
      await orphanConsumer(f.row);
      const [repaired] = await repair(f.client.user.id);
      assert.equal(repaired?.error, null);
      assert.equal(repaired?.restored_groups, 0);
      assert.deepEqual(harness.edge.consumerByUsername(f.row.ferrum_username)?.acl_groups, []);
    });

    it('repair records before a competing disable', { timeout: 10_000 }, async () => {
      const f = await fixture(true);
      await orphanConsumer(f.row);
      const key = userLifecycleLockKey(f.client.user.id);
      let signal!: () => void;
      const attempted = new Promise<void>((resolve) => {
        signal = resolve;
      });
      const acquire = peer.store.leases.acquire.bind(peer.store.leases);
      let competing = false;
      let blocked = false;
      peer.store.leases.acquire = async (...args) => {
        const acquired = await acquire(...args);
        if (competing && args[0] === key && !blocked) {
          assert.equal(acquired, false, 'repair still owns the lifecycle lease');
          blocked = true;
          signal();
        }
        return acquired;
      };
      patches.push(() => {
        peer.store.leases.acquire = acquire;
      });
      let disabled: ReturnType<TestApp['authed']> | undefined;
      const consumers = harness.edgeClient.consumers;
      const ensure = consumers.ensure.bind(consumers);
      consumers.ensure = async (...args) => {
        const result = await ensure(...args);
        if (result.created) {
          competing = true;
          disabled = peer.authed(founder, {
            method: 'PATCH',
            url: `/api/users/${f.client.user.id}`,
            payload: { status: 'disabled' },
          });
          await attempted;
          assert.equal((await target.store.users.findById(f.client.user.id))?.status, 'active');
          assert.equal(await countAudit(AuditAction.USER_DISABLE, f.client.user.id), 0);
        }
        return result;
      };
      patches.push(() => {
        consumers.ensure = ensure;
      });
      const [repaired] = await repair(f.client.user.id);
      assert.equal(repaired?.error, null);
      assert.ok(blocked, 'the real lease acquisition refused the competing disable');
      assert.ok(disabled, 'the peer attempted a disable while recreation held the keys');
      const response = await disabled;
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(await countAudit(AuditAction.GATEWAY_CONSUMER_REPAIR, f.client.user.id), 1);
      assert.deepEqual(harness.edge.consumerByUsername(f.row.ferrum_username)?.acl_groups, []);
    });

    for (const auditFailure of [false, true]) {
      it(`partial fallback retakes the proxy (audit failure=${auditFailure})`, async () => {
        const f = await fixture(true);
        f.live.acl_groups = [mcpToolGroupForApi(f.api.id, f.ids[0]!)];
        assert.ok(f.api.ferrum_proxy_id);
        const key = `proxy:${f.api.ferrum_proxy_id}`;
        beforeFailedRemoval(f.live.id, async () => {
          await loseProxyLease(key);
        });
        if (auditFailure) faults.failAfter('auditLogs', 'create', 1);
        assert.equal((await revoke(f.grant.id)).statusCode, 502);
        assert.equal((await target.store.grants.findById(f.grant.id))?.status, 'active');
        assert.equal(await requestStatus(f.grant), 'approved');
        assert.equal(
          (await details(AuditAction.ACCESS_REVOKE_ROLLBACK, f.grant.id))?.grant_restored,
          true,
        );
        assert.equal((await revoke(f.grant.id)).statusCode, 200);
      });
    }

    it('fenced repair keeps newer operator membership', async () => {
      const f = await fixture(true);
      const issued = await harness.authed(f.client, {
        method: 'POST',
        url: '/api/credentials',
        payload: { credential_type: 'keyauth', application_id: f.applicationId },
      });
      assert.equal(issued.statusCode, 201, issued.body);
      const credential = issued.json<IssueCredentialResponse>().credential;
      await orphanConsumer(f.row);
      const consumers = harness.edgeClient.consumers;
      const ensure = consumers.ensure.bind(consumers);
      let newerCredentialId: string | undefined;
      consumers.ensure = async (...args) => {
        const result = await ensure(...args);
        if (result.created) {
          await target.store.leases.deleteExpired('9999-01-01T00:00:00.000Z');
          assert.ok(
            await target.store.leases.acquire(
              f.live.id,
              'newer-holder',
              isoInSeconds(600),
              nowIso(),
            ),
          );
          const rebuilt = harness.edge.consumerByUsername(f.row.ferrum_username);
          assert.ok(rebuilt);
          rebuilt.acl_groups.push('operator-kept');
          rebuilt.credentials.jwt = [{ key: 'newer-jwt', secret: 'newer-secret' }];
          const newer = await target.store.credentials.create({
            user_id: f.client.user.id,
            application_id: f.applicationId,
            ferrum_consumer_id: f.live.id,
            ferrum_credential_id: `${f.live.id}/credentials/jwt`,
            credential_type: 'jwt',
            fingerprint: `newer-${newId()}`,
            last4: 'cret',
            status: 'active',
          });
          newerCredentialId = newer.id;
        }
        return result;
      };
      patches.push(() => {
        consumers.ensure = ensure;
      });
      const serialize = harness.edgeClient.serializePerKey.bind(harness.edgeClient);
      let passes = 0;
      harness.edgeClient.serializePerKey = async (key, work) => {
        if (key === f.live.id && ++passes === 2) {
          assert.ok(await target.store.leases.release(key, 'newer-holder'));
        }
        return serialize(key, work);
      };
      patches.push(() => {
        harness.edgeClient.serializePerKey = serialize;
      });
      const [repaired] = await repair(f.client.user.id);
      assert.equal(passes, 2);
      assert.equal(repaired?.error, null);
      assert.equal((await target.store.credentials.findById(credential.id))?.status, 'revoked');
      assert.ok(newerCredentialId);
      assert.equal((await target.store.credentials.findById(newerCredentialId))?.status, 'active');
      assert.equal(
        harness.edge.consumerByUsername(f.row.ferrum_username)?.credentials.jwt?.length,
        1,
      );
      assert.deepEqual(harness.edge.consumerByUsername(f.row.ferrum_username)?.acl_groups, [
        aclGroupForApi(f.api.id),
        ...f.ids.map((id) => mcpToolGroupForApi(f.api.id, id)),
        'operator-kept',
      ]);
      const audit = await details(AuditAction.GATEWAY_CONSUMER_REPAIR, f.client.user.id);
      assert.equal(audit?.resumed, true);
      assert.equal(audit?.restored_groups, 3);
    });
  });
}
