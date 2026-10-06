import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';

import { aclGroupForApi } from '@ferrum-nexus/shared';

import { AuditAction } from '../audit/service.js';
import { loadConfig } from '../config/index.js';
import { createStore } from '../db/index.js';
import type { NexusStore, UserRecord } from '../db/store.js';
import type { EdgeDeploymentSnapshot } from '../ferrum-admin/types.js';
import { isNexusError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { parseOpenApiSpec } from '../publishing/oas.js';
import {
  deleteRecoveryJournal,
  readRecoveryJournal,
  writeRecoveryJournal,
} from '../publishing/recovery-storage.js';
import { faultInjectingStore, type FaultInjectingStore } from './fault-injection.js';
import { buildTestApp, SAMPLE_SPEC_YAML, TEST_SECRET_KEY, type TestApp } from './helpers.js';

/** Actual native atomic stores and opted-in standalone MongoDB, never a simulated transaction. */
export function runGatewayRecoveryAtomicityContract(
  label: string,
  makeStore: () => Promise<{ store: NexusStore; teardown: () => Promise<void> }>,
  atomic = true,
): void {
  describe(`gateway recovery atomic admission — ${label}`, () => {
    let target: Awaited<ReturnType<typeof makeStore>>;
    let harness: TestApp;
    let faults: FaultInjectingStore;
    let actor: UserRecord;
    let client: UserRecord;
    let custody: NexusStore;

    before(async () => {
      target = await makeStore();
      faults = faultInjectingStore(target.store);
      harness = await buildTestApp({
        store: faults.store,
        env: { NEXUS_SPEC_HISTORY_LIMIT: '1' },
      });
      await harness.registerUser();
      const provider = await harness.registerUser({ role: 'provider' });
      actor = (await harness.store.users.findById(provider.user.id))!;
      const grantee = await harness.registerUser();
      client = (await harness.store.users.findById(grantee.user.id))!;
      // Model custody retained from an atomic deployment before its database
      // was restored onto standalone MongoDB. The production storage helper
      // creates the real encrypted format; the tested service uses MongoDB.
      custody = createStore(
        loadConfig({
          NEXUS_ENV: 'test',
          NEXUS_SECRET_KEY: TEST_SECRET_KEY,
          FERRUM_ADMIN_JWT_SECRET: TEST_SECRET_KEY,
          NEXUS_SQLITE_PATH: ':memory:',
        }),
      );
      await custody.init();
      await custody.migrate();
    });

    afterEach(() => {
      harness.edge.clearInjections();
      assert.deepEqual(faults.pending(), [], 'every native store fault was reached');
    });

    after(async () => {
      await harness?.close();
      await custody?.close();
      await target?.teardown();
    });

    async function publish(level: 'docs_only' | 'routes' = 'docs_only'): Promise<string> {
      const published = await harness.services.publishing.publish(actor, {
        name: 'Atomic recovery',
        slug: `atomic-${newId().slice(0, 12)}`,
        version: '2.4.0',
        spec: SAMPLE_SPEC_YAML,
        auth_plugin: 'key_auth',
        requestable: true,
        visibility: 'public',
        spec_enforcement: level,
      });
      const apiId = published.api.id;
      // Two non-current revisions make a corrected upload exercise retention,
      // not just insertion. Neither changes the gateway's original deployment.
      for (const version of ['1.0.0', '2.0.0']) {
        await harness.store.apiSpecs.create({
          api_id: apiId,
          version,
          raw_spec: SAMPLE_SPEC_YAML,
          is_current: false,
          created_by: actor.id,
        });
      }
      await harness.store.grants.create({
        api_id: apiId,
        user_id: client.id,
        status: 'active',
        acl_group: aclGroupForApi(apiId),
        granted_by: actor.id,
      });
      await harness.store.accessRequests.create({
        api_id: apiId,
        user_id: client.id,
        status: 'approved',
        justification: 'Retained access',
      });
      await harness.services.apiPlugins.set(actor, apiId, 'ip_restriction', {
        enabled: false,
        config: { allow: ['203.0.113.0/24'], mode: 'allow_first' },
        trigger: null,
      });
      await harness.services.publishing.createTestConsumer(actor, apiId);
      return apiId;
    }

    function recoveryKey(apiId: string): string {
      return `gateway_recovery:nexus:${apiId}`;
    }

    async function journalRows(
      store: NexusStore,
      key: string,
    ): Promise<Awaited<ReturnType<NexusStore['settings']['all']>>> {
      return (await store.settings.all()).filter((row) => {
        if (row.key === key) return true;
        if (!row.key.startsWith('gateway_recovery_chunk:')) return false;
        assert.ok(row.encrypted && typeof row.value === 'string');
        return harness.app.nexus.crypto.decryptJson<{ key: string }>(row.value).key === key;
      });
    }

    async function retainJournal(
      apiId: string,
      format: 'inline' | 'chunks',
      amend?: (journal: Record<string, unknown>) => Record<string, unknown>,
      key = recoveryKey(apiId),
    ): Promise<void> {
      const api = await harness.store.apis.findById(apiId);
      const spec = await harness.store.apiSpecs.findCurrentByApi(apiId);
      assert.ok(api && spec && api.ferrum_proxy_id);
      const proxy = await harness.edgeClient.proxies.get(api.ferrum_proxy_id);
      assert.ok(proxy);
      const shape = {
        slug: api.slug,
        namespace: api.namespace,
        upstream_url: api.upstream_url,
        auth_plugin: api.auth_plugin,
        requestable: api.requestable,
        rate_limit: api.rate_limit,
        cors: api.cors,
        allowed_methods: api.allowed_methods,
        timeouts: api.timeouts,
        circuit_breaker: api.circuit_breaker,
        spec_enforcement: api.spec_enforcement,
        agents: api.agents ?? null,
      };
      const journal = {
        apiId,
        namespace: 'nexus',
        shape,
        catalogShape: shape,
        originalSpecId: spec.id,
        catalogSpecId: spec.id,
        originalSpecDocument: await harness.edgeClient.apiSpecs.documentByProxy(proxy.id),
        proxy,
        plugins: await harness.edgeClient.pluginConfigs.listByProxy(proxy.id),
        document: parseOpenApiSpec(spec.raw_spec).document,
        originalAuthority: await harness.edgeClient.deployments.snapshot(actor.id),
        attempt: null,
        ...(format === 'chunks'
          ? { retainedEvidence: 'custody-canary-' + 'q'.repeat(600_000) }
          : {}),
      };
      const crypto = harness.app.nexus.crypto;
      await writeRecoveryJournal(custody, crypto, key, amend ? amend(journal) : journal);
      const rows = await journalRows(custody, key);
      assert.equal(rows.length > 1, format === 'chunks');
      for (const row of rows) await harness.store.settings.set(row.key, row.value, row.encrypted);
      await deleteRecoveryJournal(custody, crypto, key);
      await harness.store.apis.update(apiId, { gateway_state: 'repair_required' });
    }

    async function catalog(apiId: string) {
      return {
        api: await harness.store.apis.findById(apiId),
        current: await harness.store.apiSpecs.findCurrentByApi(apiId),
        revisions: await harness.store.apiSpecs.list({ api_id: apiId }),
        changes: await harness.store.apiSpecChanges.listByApi(apiId),
        grants: await harness.store.grants.list({ api_id: apiId }),
        requests: await harness.store.accessRequests.list({ api_id: apiId }),
        palette: await harness.store.apiPlugins.listByApi(apiId),
        ownership: await harness.store.apiGatewayPlugins.listByApi(apiId),
        settings: (await harness.store.settings.all()).sort((a, b) => a.key.localeCompare(b.key)),
        audit: await harness.store.auditLogs.list({}),
        identities: await harness.store.gatewayIdentities.findByUsername(
          'nexus',
          `nexus-test-${apiId}`,
        ),
        credentials: await harness.store.credentials.list({ user_id: actor.id }),
      };
    }

    function gateway(): unknown {
      return structuredClone({
        proxies: [...harness.edge.proxies],
        plugins: [...harness.edge.pluginConfigs],
        specs: [...harness.edge.apiSpecs],
        upstreams: [...harness.edge.upstreams],
        consumers: [...harness.edge.consumers],
      });
    }

    async function refusesWithoutEffects(
      apiId: string,
      operation: () => Promise<unknown>,
      message = /replica set/,
    ): Promise<void> {
      const beforeCatalog = await catalog(apiId);
      const beforeGateway = gateway();
      const offset = harness.edge.requests.length;
      await assert.rejects(
        operation(),
        (error: unknown) =>
          isNexusError(error) && error.code === 'CONFLICT' && message.test(error.message),
      );
      assert.deepEqual(await catalog(apiId), beforeCatalog);
      assert.deepEqual(gateway(), beforeGateway);
      assert.ok(harness.edge.requests.slice(offset).every((call) => call.method === 'GET'));
    }

    for (const format of ['inline', 'chunks'] as const) {
      for (const condition of [
        'pending-mutation',
        'invalid-acknowledgement',
        'missing-acknowledgement',
        'staging-create',
      ] as const) {
        it(`${format}: deletion retains ${condition} custody before effects`, async () => {
          const apiId = await publish();
          await retainJournal(apiId, format, (journal) => ({
            ...journal,
            ...(condition === 'staging-create'
              ? {
                  attempt: {
                    level: 'routes',
                    agents: null,
                    proxy: journal.proxy,
                    documentDigests: [],
                    specId: null,
                  },
                }
              : {
                  mutations: [
                    {
                      kind: 'remove',
                      id: (journal.proxy as { id: string }).id,
                      original: journal.originalAuthority,
                      ...(condition === 'missing-acknowledgement'
                        ? {}
                        : { acknowledged: condition === 'pending-mutation' ? false : 'true' }),
                    },
                  ],
                }),
          }));
          await refusesWithoutEffects(
            apiId,
            () => harness.services.publishing.remove(actor, apiId),
            atomic ? /unconfirmed|journal/ : /replica set/,
          );
        });
      }

      for (const phase of ['cleanup', 'cutover'] as const) {
        it(`${format}: deletion retains unresolved restore ${phase} custody`, async () => {
          const apiId = await publish('routes');
          if (atomic && phase === 'cutover') await retainJournal(apiId, format);
          await retainJournal(
            apiId,
            format,
            (journal) => ({
              original: journal.originalAuthority,
              proxyId: (journal.proxy as { id: string }).id,
              acknowledged: phase === 'cutover',
              ...(phase === 'cutover'
                ? {
                    phase,
                    apiId,
                    catalogSpecId: journal.catalogSpecId,
                    catalogShape: journal.catalogShape,
                    specId: (journal.proxy as { api_spec_id: string }).api_spec_id,
                    document: journal.originalSpecDocument,
                  }
                : { cutover: null }),
              ...(format === 'chunks' ? { retainedEvidence: journal.retainedEvidence } : {}),
            }),
            `gateway_restore_cleanup:nexus:${apiId}`,
          );
          await refusesWithoutEffects(
            apiId,
            () => harness.services.publishing.remove(actor, apiId),
            atomic ? /unresolved deployment cleanup/ : /replica set/,
          );
        });
      }

      if (!atomic) {
        for (const operation of [
          'upload',
          'rollback',
          'restore-live',
          'restore-absent',
          'delete',
        ] as const) {
          it(`${format}: standalone ${operation} refuses before effects`, async () => {
            const apiId = await publish();
            await retainJournal(apiId, format);
            const revision = (await harness.store.apiSpecs.list({ api_id: apiId })).items.find(
              (row) => !row.is_current,
            );
            assert.ok(revision);
            if (operation === 'restore-absent') {
              const api = await harness.store.apis.findById(apiId);
              await harness.edgeClient.proxies.delete(api!.ferrum_proxy_id!, actor.id);
            }
            await refusesWithoutEffects(apiId, () => {
              if (operation === 'upload') {
                return harness.services.publishing.updateSpec(
                  actor,
                  apiId,
                  SAMPLE_SPEC_YAML,
                  '3.0.0',
                );
              }
              if (operation === 'rollback') {
                return harness.services.publishing.rollbackSpec(actor, apiId, revision.id);
              }
              if (operation === 'delete') return harness.services.publishing.remove(actor, apiId);
              return harness.services.publishing.restoreGateway(actor, apiId);
            });
          });
        }
        continue;
      }

      it(`${format}: native upload rolls back and commits custody`, async () => {
        const apiId = await publish();
        await retainJournal(apiId, format);
        const crypto = harness.app.nexus.crypto;
        const key = recoveryKey(apiId);
        const original = await readRecoveryJournal<Record<string, unknown>>(
          harness.store,
          crypto,
          key,
        );
        assert.ok(original);
        for (const repo of ['settings', 'auditLogs'] as const) {
          const beforeCatalog = await catalog(apiId);
          const beforeGateway = gateway();
          faults.failNext(
            repo,
            repo === 'settings' ? 'set' : 'create',
            new Error('atomic upload fault'),
          );
          await assert.rejects(
            harness.services.publishing.updateSpec(actor, apiId, SAMPLE_SPEC_YAML, '3.0.0'),
            /atomic upload fault/,
          );
          assert.deepEqual(await catalog(apiId), beforeCatalog);
          assert.deepEqual(gateway(), beforeGateway);
        }
        await harness.services.publishing.updateSpec(actor, apiId, SAMPLE_SPEC_YAML, '3.0.0');
        const revised = await harness.store.apiSpecs.findCurrentByApi(apiId);
        assert.ok(revised && revised.id !== original.originalSpecId);
        const next = await readRecoveryJournal<Record<string, unknown>>(harness.store, crypto, key);
        assert.deepEqual(next, { ...original, catalogSpecId: revised.id });
        assert.equal((await harness.store.apis.findById(apiId))?.version, '3.0.0');
        assert.equal((await harness.store.apiSpecs.list({ api_id: apiId })).total, 2);
        await harness.services.publishing.restoreGateway(actor, apiId);
        assert.deepEqual(await journalRows(harness.store, key), []);
        assert.equal((await harness.store.apis.findById(apiId))?.gateway_state, 'deployed');
      });

      it(`${format}: native recovery rolls back completion faults`, async () => {
        const apiId = await publish();
        await retainJournal(apiId, format);
        const key = recoveryKey(apiId);
        const before = await catalog(apiId);
        const beforeGateway = gateway();
        const offset = harness.edge.requests.length;
        // The intent commits first. The next audit follows the actual catalog,
        // ownership and journal deletion inside the completion transaction.
        faults.failAfter('auditLogs', 'create', 1, new Error('atomic recovery completion fault'));
        await assert.rejects(
          harness.services.publishing.restoreGateway(actor, apiId),
          /atomic recovery completion fault/,
        );
        const after = await catalog(apiId);
        assert.ok(before.api && after.api);
        assert.deepEqual(after.api, { ...before.api, updated_at: after.api.updated_at });
        assert.deepEqual(after.ownership, before.ownership);
        assert.deepEqual(after.revisions, before.revisions);
        assert.deepEqual(after.settings, before.settings);
        assert.deepEqual(gateway(), beforeGateway);
        assert.ok(harness.edge.requests.slice(offset).every((call) => call.method === 'GET'));
        for (const action of [
          AuditAction.API_GATEWAY_CONVERSION_ROLLBACK,
          AuditAction.API_GATEWAY_RESTORE,
        ]) {
          assert.equal(
            (await harness.auditRows(action)).filter((row) => row.target_id === apiId).length,
            0,
          );
        }
        await harness.services.publishing.restoreGateway(actor, apiId);
        assert.deepEqual(await journalRows(harness.store, key), []);
        assert.equal((await harness.store.apis.findById(apiId))?.gateway_state, 'deployed');
        assert.equal(
          (await harness.auditRows(AuditAction.API_GATEWAY_CONVERSION_ROLLBACK)).filter(
            (row) => row.target_id === apiId,
          ).length,
          1,
        );
      });

      it(`${format}: native deletion rolls back catalog and chunks`, async () => {
        const apiId = await publish();
        await retainJournal(apiId, format, (journal) => ({
          ...journal,
          mutations: [
            {
              kind: 'remove',
              id: (journal.proxy as { id: string }).id,
              original: journal.originalAuthority,
              acknowledged: false,
            },
          ],
        }));
        const key = recoveryKey(apiId);
        const recovery = await readRecoveryJournal<{
          proxy: { id: string };
          originalAuthority: EdgeDeploymentSnapshot;
          mutations: { acknowledged: boolean }[];
        }>(harness.store, harness.app.nexus.crypto, key);
        assert.ok(recovery && recovery.mutations[0]);
        // Only the real released client acknowledgement authorizes this update;
        // no lost reply or failed persistence is defaulted to acknowledged.
        await harness.edgeClient.deployments.remove(
          recovery.proxy.id,
          recovery.originalAuthority,
          actor.id,
        );
        recovery.mutations[0].acknowledged = true;
        await writeRecoveryJournal(harness.store, harness.app.nexus.crypto, key, recovery);
        const before = await catalog(apiId);
        let reached = false;
        await assert.rejects(
          harness.services.publishing.remove(actor, apiId, null, async (tx) => {
            assert.equal(await tx.apis.findById(apiId), null);
            assert.equal(await tx.settings.get(recoveryKey(apiId)), null);
            reached = true;
            throw new Error('atomic delete completion fault');
          }),
          /atomic delete completion fault/,
        );
        assert.ok(reached, 'the fault follows actual catalog and custody deletion');
        // Teardown's intent audit and test credential revocation precede the
        // catalog transaction. Compare the rows that transaction owns exactly.
        const after = await catalog(apiId);
        const {
          audit: beforeAudit,
          identities: beforeIdentity,
          credentials: beforeCredentials,
          ...beforeRows
        } = before;
        const {
          audit: afterAudit,
          identities: afterIdentity,
          credentials: afterCredentials,
          ...afterRows
        } = after;
        assert.deepEqual(afterRows, beforeRows);
        assert.ok(beforeAudit && afterAudit && beforeIdentity && afterIdentity);
        assert.ok(beforeCredentials && afterCredentials);
        assert.equal(
          (await harness.auditRows(AuditAction.API_DELETE)).filter((row) => row.target_id === apiId)
            .length,
          0,
        );
        await harness.services.publishing.remove(actor, apiId);
        assert.equal(await harness.store.apis.findById(apiId), null);
        assert.deepEqual(await journalRows(harness.store, recoveryKey(apiId)), []);
      });
    }

    if (!atomic) {
      for (const level of ['docs_only', 'routes'] as const) {
        it(`${level}: standalone conversion and rebuild refuse before effects`, async () => {
          const apiId = await publish(level);
          await refusesWithoutEffects(apiId, () =>
            harness.services.publishing.update(actor, apiId, {
              spec_enforcement: level === 'routes' ? 'docs_only' : 'routes',
            }),
          );
          const api = await harness.store.apis.findById(apiId);
          await harness.edgeClient.proxies.delete(api!.ferrum_proxy_id!, actor.id);
          await refusesWithoutEffects(apiId, () =>
            harness.services.publishing.restoreGateway(actor, apiId),
          );
          await harness.store.apis.update(apiId, {
            ferrum_proxy_id: null,
            gateway_state: 'repair_required',
          });
          await refusesWithoutEffects(apiId, () =>
            harness.services.publishing.restoreGateway(actor, apiId),
          );
        });
      }

      it('standalone ordinary operations work without a journal', async () => {
        const apiId = await publish();
        await harness.services.publishing.updateSpec(actor, apiId, SAMPLE_SPEC_YAML, '3.0.0');
        await harness.store.apis.update(apiId, { gateway_state: 'repair_required' });
        await harness.services.publishing.restoreGateway(actor, apiId);
        await harness.services.publishing.remove(actor, apiId);
        assert.equal(await harness.store.apis.findById(apiId), null);
      });
    }
  });
}
