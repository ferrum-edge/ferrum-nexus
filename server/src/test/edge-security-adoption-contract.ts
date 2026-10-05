import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';

import type { PublishApiResponse } from '@ferrum-nexus/shared';

import { AuditAction } from '../audit/service.js';
import {
  API_GATEWAY_PLUGIN_ROLES,
  type ApiGatewayPluginRecord,
  type NexusStore,
  type UserRecord,
} from '../db/store.js';
import { isNexusError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { faultInjectingStore, type FaultInjectingStore } from './fault-injection.js';
import { buildTestApp, SAMPLE_SPEC_YAML, specWithServer, type TestApp } from './helpers.js';
import { mockBasicPasswordHash, publicEgressPolicy } from './mock-ferrum-edge.js';

/** Ownership replacement preserves every field except its intentional update stamp. */
function assertRefreshedOwnership(
  actual: ApiGatewayPluginRecord[],
  original: ApiGatewayPluginRecord[],
  startedAt: number,
  finishedAt: number,
): void {
  assert.deepEqual(
    original.map((row) => row.role),
    API_GATEWAY_PLUGIN_ROLES,
    'the baseline records all four ownership roles, including null ownership',
  );
  assert.equal(actual.length, original.length, 'no ownership row is added or omitted');
  for (const [index, row] of original.entries()) {
    const refreshed = actual[index];
    assert.ok(refreshed);
    assert.deepEqual(refreshed, { ...row, updated_at: refreshed.updated_at });
    const updatedAt = Date.parse(refreshed.updated_at);
    assert.ok(Number.isFinite(updatedAt), 'the refreshed ownership stamp is a valid timestamp');
    assert.equal(new Date(updatedAt).toISOString(), refreshed.updated_at);
    assert.ok(updatedAt >= Date.parse(row.updated_at), 'the ownership stamp never moves backward');
    assert.ok(
      updatedAt >= startedAt && updatedAt <= finishedAt,
      'ownership is refreshed within the restore attempt, allowing the same millisecond',
    );
  }
}

/** Runs production service paths with native store transactions on all four adapters. */
export function runEdgeSecurityAdoptionContract(
  label: string,
  makeStore: () => Promise<{ store: NexusStore; teardown: () => Promise<void> }>,
): void {
  describe(`Edge security adoption — ${label}`, () => {
    let target: Awaited<ReturnType<typeof makeStore>>;
    let faults: FaultInjectingStore;
    let harness: TestApp;
    let actor: UserRecord;
    let founder: UserRecord;
    const restoreMethods: (() => void)[] = [];

    before(async () => {
      target = await makeStore();
      faults = faultInjectingStore(target.store);
      harness = await buildTestApp({ store: faults.store });
      const founding = await harness.registerUser();
      founder = (await harness.store.users.findById(founding.user.id))!;
      const provider = await harness.registerUser({ role: 'provider' });
      actor = (await harness.store.users.findById(provider.user.id))!;
    });

    afterEach(() => {
      for (const restore of restoreMethods.splice(0).reverse()) restore();
      harness.edge.setBackendEgressPolicy(publicEgressPolicy());
      harness.edge.clearInjections();
      assert.deepEqual(faults.pending(), []);
    });

    after(async () => {
      await harness?.close();
      await target?.teardown();
    });

    async function publish(level: 'docs_only' | 'routes'): Promise<PublishApiResponse> {
      return harness.services.publishing.publish(actor, {
        name: 'Egress contract',
        slug: `egress-${newId().slice(0, 12)}`,
        version: '2.4.0',
        spec: SAMPLE_SPEC_YAML,
        auth_plugin: 'key_auth',
        requestable: true,
        visibility: 'public',
        spec_enforcement: level,
        rate_limit: { limit: 120, window_seconds: 60 },
      });
    }

    function gatewayState(): unknown {
      return structuredClone({
        proxies: [...harness.edge.proxies],
        plugins: [...harness.edge.pluginConfigs],
        specs: [...harness.edge.apiSpecs],
        upstreams: [...harness.edge.upstreams],
      });
    }

    async function completionRows(apiId: string): Promise<{
      restore: Awaited<ReturnType<TestApp['auditRows']>>;
      rollback: Awaited<ReturnType<TestApp['auditRows']>>;
    }> {
      return {
        restore: (await harness.auditRows(AuditAction.API_GATEWAY_RESTORE)).filter(
          (row) => row.target_id === apiId,
        ),
        rollback: (await harness.auditRows(AuditAction.API_GATEWAY_CONVERSION_ROLLBACK)).filter(
          (row) => row.target_id === apiId,
        ),
      };
    }

    /** A real admitted Admin write, returning the exact path for its HTTP witness. */
    async function mutateAdminResource(
      resource: 'proxy' | 'plugin' | 'spec',
      proxyId: string,
    ): Promise<string> {
      await harness.edgeClient.assertBackendEgress();
      if (resource === 'proxy') {
        const live = await harness.edgeClient.proxies.get(proxyId);
        assert.ok(live);
        await harness.edgeClient.proxies.replace(
          proxyId,
          { ...live, hosts: ['recovery.operator.example.test'] },
          actor.id,
        );
        return `/proxies/${proxyId}`;
      }
      if (resource === 'plugin') {
        const plugin = (await harness.edgeClient.pluginConfigs.listByProxy(proxyId)).find(
          (row) => !row.api_spec_id,
        );
        assert.ok(plugin);
        await harness.edgeClient.pluginConfigs.replace(
          plugin.id,
          {
            plugin_name: plugin.plugin_name,
            scope: plugin.scope,
            proxy_id: proxyId,
            enabled: plugin.enabled,
            config: plugin.config,
            ...(plugin.priority_override != null
              ? { priority_override: plugin.priority_override }
              : {}),
            ...(plugin.trigger ? { trigger: plugin.trigger } : {}),
            labels: { ...plugin.labels, operator: 'concurrent' },
          },
          actor.id,
        );
        return `/plugins/config/${plugin.id}`;
      }
      const spec = await harness.edgeClient.apiSpecs.findByProxy(proxyId);
      const document = await harness.edgeClient.apiSpecs.documentByProxy(proxyId);
      assert.ok(spec && document);
      await harness.edgeClient.apiSpecs.replace(
        spec.id,
        {
          ...document,
          info: {
            ...(document.info as Record<string, unknown>),
            title: 'Operator revision',
          },
        },
        actor.id,
      );
      return `/api-specs/${spec.id}`;
    }

    function refusePolicy(): void {
      harness.edge.setBackendEgressPolicy({
        ...publicEgressPolicy(),
        enforcement_scope: 'admission-only',
      });
    }

    for (const level of ['docs_only', 'routes'] as const) {
      it(`${level}: refuses forward and rebuild operations before effects`, async () => {
        const published = await publish(level);
        await harness.services.publishing.updateSpec(
          actor,
          published.api.id,
          specWithServer('https://changed.example.test/v3'),
        );
        const beforeRow = await harness.store.apis.findById(published.api.id);
        const beforeSpec = await harness.store.apiSpecs.findCurrentByApi(published.api.id);
        const beforeProxies = JSON.stringify([...harness.edge.proxies]);
        const beforePlugins = JSON.stringify([...harness.edge.pluginConfigs]);
        refusePolicy();
        const offset = harness.edge.requests.length;
        for (const operation of [
          () => publish(level),
          () =>
            harness.services.publishing.update(actor, published.api.id, {
              upstream_url: 'https://another.example.test',
            }),
          () =>
            harness.services.publishing.update(actor, published.api.id, {
              spec_enforcement: level === 'routes' ? 'docs_only' : 'routes',
            }),
          () => harness.services.publishing.update(actor, published.api.id, { agents: null }),
          () =>
            harness.services.publishing.updateSpec(
              actor,
              published.api.id,
              specWithServer('https://next.example.test'),
            ),
          () =>
            harness.services.publishing.rollbackSpec(actor, published.api.id, published.spec.id),
          () => harness.services.publishing.restoreGateway(actor, published.api.id),
        ]) {
          await assert.rejects(operation, /required local public egress policy/);
        }
        assert.ok(harness.edge.requests.slice(offset).every((request) => request.method === 'GET'));
        assert.equal(JSON.stringify([...harness.edge.proxies]), beforeProxies);
        assert.equal(JSON.stringify([...harness.edge.pluginConfigs]), beforePlugins);
        assert.deepEqual(await harness.store.apis.findById(published.api.id), beforeRow);
        assert.deepEqual(
          await harness.store.apiSpecs.findCurrentByApi(published.api.id),
          beforeSpec,
        );
      });

      it(`${level}: rebuilds missing resources only with fresh policy`, async () => {
        const published = await publish(level);
        await harness.edgeClient.proxies.delete(published.api.ferrum_proxy_id!);
        const before = await harness.store.apis.findById(published.api.id);
        refusePolicy();
        await assert.rejects(harness.services.publishing.restoreGateway(actor, published.api.id));
        assert.deepEqual(await harness.store.apis.findById(published.api.id), before);
        harness.edge.setBackendEgressPolicy(publicEgressPolicy());
        const restored = await harness.services.publishing.restoreGateway(actor, published.api.id);
        assert.equal(restored.api.gateway_state, 'deployed');
        assert.ok(harness.edge.proxyServing(`/nexus/${published.api.slug}`));
      });

      it(`${level}: never clears repair based on proxy existence alone`, async () => {
        const published = await publish(level);
        const id = published.api.ferrum_proxy_id!;
        const proxy = harness.edge.proxies.get(`nexus/${id}`)!;
        const original = structuredClone(proxy);
        await harness.store.apis.update(published.api.id, { gateway_state: 'repair_required' });
        const changes: Record<string, unknown>[] = [
          { listen_path: `/nexus/.staging/${newId()}` },
          { backend_host: 'incorrect.example.test' },
          { plugins: [] },
          { api_spec_id: 'unrecorded-spec' },
        ];
        for (const change of changes) {
          Object.assign(proxy, change);
          const offset = harness.edge.requests.length;
          await assert.rejects(
            harness.services.publishing.restoreGateway(actor, published.api.id),
            /does not match the API deployment/,
          );
          assert.equal(
            (await harness.store.apis.findById(published.api.id))?.gateway_state,
            'repair_required',
          );
          assert.ok(
            harness.edge.requests.slice(offset).every((request) => request.method === 'GET'),
          );
          Object.assign(proxy, original);
          if (!('api_spec_id' in original)) delete proxy.api_spec_id;
          harness.edge.proxies.set(`nexus/${id}`, proxy);
        }
        if (level === 'routes') {
          const validator = [...harness.edge.pluginConfigs.values()].find(
            (plugin) => plugin.proxy_id === id && plugin.plugin_name === 'openapi_validator',
          )!;
          const config = validator.config as Record<string, unknown>;
          const operations = config.operations;
          config.operations = [{ method: 'GET', path_template: '/wrong', path_regex: '^/wrong$' }];
          const offset = harness.edge.requests.length;
          await assert.rejects(
            harness.services.publishing.restoreGateway(actor, published.api.id),
            /does not match the API deployment/,
          );
          assert.ok(
            harness.edge.requests.slice(offset).every((request) => request.method === 'GET'),
          );
          assert.equal(
            (await harness.store.apis.findById(published.api.id))?.gateway_state,
            'repair_required',
          );
          config.operations = operations;
        }
        const restored = await harness.services.publishing.restoreGateway(actor, published.api.id);
        assert.equal(restored.api.gateway_state, 'deployed');
      });

      it(`${level}: recovers an owned conversion after staging policy refusal`, async () => {
        const published = await publish(level);
        const proxyId = published.api.ferrum_proxy_id!;
        const proxy = (await harness.edgeClient.proxies.get(proxyId))!;
        const operator = await harness.edgeClient.pluginConfigs.create({
          id: newId(),
          plugin_name: 'key_auth',
          scope: 'proxy',
          proxy_id: proxyId,
          enabled: true,
          config: { hide_credentials: false },
        });
        await harness.edgeClient.proxies.replace(proxyId, {
          ...proxy,
          hosts: ['operator.example.test'],
          plugins: [...proxy.plugins, { plugin_config_id: operator.id }],
        });
        const unrelated = await publish('docs_only');
        const untouched = structuredClone(
          harness.edge.proxies.get(`nexus/${unrelated.api.ferrum_proxy_id}`),
        );
        const originalPlugins = [...harness.edge.pluginConfigs.values()]
          .filter((plugin) => plugin.proxy_id === proxyId && !plugin.api_spec_id)
          .map((plugin) => plugin.id);
        const createProxy = harness.edgeClient.proxies.create;
        const createSpec = harness.edgeClient.apiSpecs.create;
        const reset = () => {
          harness.edgeClient.proxies.create = createProxy;
          harness.edgeClient.apiSpecs.create = createSpec;
        };
        restoreMethods.push(reset);
        if (level === 'routes') {
          harness.edgeClient.proxies.create = async (...args) => {
            const written = await createProxy(...args);
            refusePolicy();
            return written;
          };
        } else {
          harness.edgeClient.apiSpecs.create = async (...args) => {
            const written = await createSpec(...args);
            refusePolicy();
            return written;
          };
        }
        await assert.rejects(
          harness.services.publishing.update(actor, published.api.id, {
            spec_enforcement: level === 'routes' ? 'docs_only' : 'routes',
          }),
          /required local public egress policy/,
        );
        const failed = (await harness.store.apis.findById(published.api.id))!;
        assert.equal(failed.gateway_state, 'repair_required');
        assert.equal(failed.ferrum_proxy_id, proxyId, 'the owned partial identity remains tracked');
        const report = await harness.services.reconciliation.scan();
        assert.ok(report.awaiting_restore > 0);
        assert.equal(report.status, 'orphaned');
        const partial = harness.edge.proxies.get(`nexus/${proxyId}`)!;
        assert.ok(String(partial.listen_path).includes('/.staging/'));
        assert.equal(harness.edge.proxyServing(`/nexus/${published.api.slug}`), undefined);
        const sealed = await harness.store.settings.get(
          `gateway_recovery:nexus:${published.api.id}`,
        );
        assert.equal(sealed?.encrypted, true);
        assert.ok(!JSON.stringify(sealed).includes('operator.example.test'));
        const offset = harness.edge.requests.length;
        await assert.rejects(harness.services.publishing.restoreGateway(actor, published.api.id));
        assert.ok(harness.edge.requests.slice(offset).every((request) => request.method === 'GET'));
        assert.equal(
          (await harness.store.apis.findById(published.api.id))?.gateway_state,
          'repair_required',
        );
        reset();
        harness.edge.setBackendEgressPolicy(publicEgressPolicy());
        const readDocument = harness.edgeClient.apiSpecs.documentByProxy;
        harness.edgeClient.apiSpecs.documentByProxy = async (...args) => {
          const document = await readDocument(...args);
          return document ? Object.fromEntries(Object.entries(document).reverse()) : null;
        };
        restoreMethods.push(() => {
          harness.edgeClient.apiSpecs.documentByProxy = readDocument;
        });
        // An unknown config on the partial proxy must stop recovery before any deletion.
        const unknown = await harness.edgeClient.pluginConfigs.create({
          id: newId(),
          plugin_name: 'key_auth',
          scope: 'proxy',
          proxy_id: proxyId,
          enabled: true,
          config: {},
        });
        const deletes = harness.edge.callsTo('DELETE', `/proxies/${proxyId}`).length;
        await assert.rejects(
          harness.services.publishing.restoreGateway(actor, published.api.id),
          /unknown or changed plugin state/,
        );
        assert.equal(harness.edge.callsTo('DELETE', `/proxies/${proxyId}`).length, deletes);
        assert.ok(harness.edge.pluginConfigs.has(`nexus/${unknown.id}`));
        await harness.edgeClient.pluginConfigs.delete(unknown.id);
        const revisionOffset = harness.edge.requests.length;
        await harness.services.publishing.updateSpec(
          actor,
          published.api.id,
          SAMPLE_SPEC_YAML.replace('2.4.0', '2.5.0'),
        );
        assert.ok(
          harness.edge.requests.slice(revisionOffset).every((request) => request.method === 'GET'),
          'a corrected catalog revision never writes to a partial gateway deployment',
        );
        await assert.rejects(
          harness.services.publishing.restoreGateway(actor, published.api.id),
          /Atomic removal of a partial conversion is unavailable/,
        );
        assert.equal(harness.edge.callsTo('DELETE', `/proxies/${proxyId}`).length, deletes);
        // Explicit operator reconciliation, not a Nexus recovery fallback.
        await harness.edgeClient.proxies.delete(proxyId, actor.id, {
          cleanupOrphanedUpstream: false,
        });
        const restored = await harness.services.publishing.restoreGateway(actor, published.api.id);
        assert.equal(restored.api.gateway_state, 'deployed');
        assert.equal(restored.api.ferrum_proxy_id, proxyId);
        assert.equal(restored.api.spec_enforcement, level);
        assert.equal(restored.spec.parsed_version, '2.5.0');
        const live = harness.edge.proxyServing(`/nexus/${published.api.slug}`)!;
        assert.deepEqual(live.hosts, ['operator.example.test']);
        for (const id of originalPlugins) {
          assert.ok(harness.edge.pluginConfigs.has(`nexus/${id}`));
          assert.ok(
            (live.plugins as { plugin_config_id: string }[]).some(
              (entry) => entry.plugin_config_id === id,
            ),
          );
        }
        const operatorConfig = harness.edge.pluginConfigs.get(`nexus/${operator.id}`)?.config;
        assert.equal((operatorConfig as Record<string, unknown>).hide_credentials, false);
        assert.equal(Boolean(harness.edge.apiSpecForProxy(proxyId)), level === 'routes');
        assert.deepEqual(
          harness.edge.proxies.get(`nexus/${unrelated.api.ferrum_proxy_id}`),
          untouched,
        );
        assert.equal(
          await harness.store.settings.get(`gateway_recovery:nexus:${published.api.id}`),
          null,
        );
        assert.equal(
          [...harness.edge.proxies.values()].filter((entry) => entry.id === proxyId).length,
          1,
        );
      });

      for (const checkpoint of [
        'before-teardown',
        'after-teardown',
        'staging',
        'cutover',
      ] as const) {
        it(`${level}: retains a truthful journal at ${checkpoint}`, async () => {
          const published = await publish(level);
          const apiId = published.api.id;
          const proxyId = published.api.ferrum_proxy_id!;
          const key = `gateway_recovery:nexus:${apiId}`;
          const remove = harness.edgeClient.proxies.delete;
          const createProxy = harness.edgeClient.proxies.create;
          const createSpec = harness.edgeClient.apiSpecs.create;
          const replaceProxy = harness.edgeClient.proxies.replace;
          const replaceSpec = harness.edgeClient.apiSpecs.replace;
          let interrupted = false;
          const interrupt = async (): Promise<void> => {
            const row = await harness.store.apis.findById(apiId);
            const journal = await harness.store.settings.get(key);
            assert.equal(row?.gateway_state, 'repair_required');
            assert.equal(row?.ferrum_proxy_id, proxyId);
            assert.equal(journal?.encrypted, true);
            interrupted = true;
            refusePolicy();
            throw new Error('injected interruption');
          };
          harness.edgeClient.proxies.delete = async (...args) => {
            assert.deepEqual(args[2], { cleanupOrphanedUpstream: false });
            if (checkpoint === 'before-teardown') await interrupt();
            await remove(...args);
            if (checkpoint === 'after-teardown') await interrupt();
          };
          harness.edgeClient.proxies.create = async (...args) => {
            const result = await createProxy(...args);
            if (checkpoint === 'staging') await interrupt();
            return result;
          };
          harness.edgeClient.apiSpecs.create = async (...args) => {
            const result = await createSpec(...args);
            if (checkpoint === 'staging') await interrupt();
            return result;
          };
          harness.edgeClient.proxies.replace = async (...args) => {
            const result = await replaceProxy(...args);
            if (checkpoint === 'cutover') await interrupt();
            return result;
          };
          harness.edgeClient.apiSpecs.replace = async (...args) => {
            const result = await replaceSpec(...args);
            if (checkpoint === 'cutover') await interrupt();
            return result;
          };
          const reset = (): void => {
            harness.edgeClient.proxies.delete = remove;
            harness.edgeClient.proxies.create = createProxy;
            harness.edgeClient.apiSpecs.create = createSpec;
            harness.edgeClient.proxies.replace = replaceProxy;
            harness.edgeClient.apiSpecs.replace = replaceSpec;
          };
          restoreMethods.push(reset);
          await assert.rejects(
            harness.services.publishing.update(actor, apiId, {
              spec_enforcement: level === 'routes' ? 'docs_only' : 'routes',
            }),
            /injected interruption/,
          );
          assert.ok(interrupted);
          assert.equal(
            (await harness.store.apis.findById(apiId))?.gateway_state,
            'repair_required',
          );
          assert.ok(await harness.store.settings.get(key));
          reset();
          harness.edge.setBackendEgressPolicy(publicEgressPolicy());
          if (checkpoint === 'before-teardown' || checkpoint === 'after-teardown') {
            const restored = await harness.services.publishing.restoreGateway(actor, apiId);
            assert.equal(restored.api.gateway_state, 'deployed');
            assert.equal(await harness.store.settings.get(key), null);
          } else {
            const live = structuredClone(harness.edge.proxies.get(`nexus/${proxyId}`));
            const offset = harness.edge.requests.length;
            await assert.rejects(harness.services.publishing.restoreGateway(actor, apiId));
            assert.deepEqual(harness.edge.proxies.get(`nexus/${proxyId}`), live);
            assert.ok(harness.edge.requests.slice(offset).every((call) => call.method === 'GET'));
          }
        });
      }

      for (const refusal of ['catalog', 'audit'] as const) {
        it(`${level}: keeps the journal through ${refusal} commit refusal`, async () => {
          const published = await publish(level);
          const key = `gateway_recovery:nexus:${published.api.id}`;
          faults.failAfter(
            refusal === 'catalog' ? 'apis' : 'auditLogs',
            refusal === 'catalog' ? 'update' : 'create',
            1,
            new Error('catalog completion refused'),
          );
          await assert.rejects(
            harness.services.publishing.update(actor, published.api.id, {
              spec_enforcement: level === 'routes' ? 'docs_only' : 'routes',
            }),
            /catalog completion refused/,
          );
          const row = await harness.store.apis.findById(published.api.id);
          assert.equal(row?.gateway_state, 'repair_required');
          assert.equal(row?.spec_enforcement, level);
          assert.equal(row?.ferrum_proxy_id, published.api.ferrum_proxy_id);
          assert.equal((await harness.store.settings.get(key))?.encrypted, true);
          assert.ok(harness.edge.proxyServing(`/nexus/${published.api.slug}`));
        });
      }

      it(`${level}: reconciles rollback and completion atomically`, async () => {
        const published = await publish(level);
        const key = `gateway_recovery:nexus:${published.api.id}`;
        harness.edge.queueFailure(
          503,
          { error: 'creation refused' },
          level === 'routes' ? '/proxies' : '/api-specs',
          'POST',
        );
        await assert.rejects(
          harness.services.publishing.update(actor, published.api.id, {
            spec_enforcement: level === 'routes' ? 'docs_only' : 'routes',
          }),
        );
        assert.equal(
          (await harness.store.apis.findById(published.api.id))?.gateway_state,
          'deployed',
        );
        assert.equal(await harness.store.settings.get(key), null);
        assert.ok(
          (await harness.auditRows('api.gateway_conversion_rollback')).some(
            (row) => row.target_id === published.api.id,
          ),
        );
        const updated = await harness.services.publishing.update(actor, published.api.id, {
          spec_enforcement: level === 'routes' ? 'docs_only' : 'routes',
        });
        assert.equal(updated.api.gateway_state, 'deployed');
        assert.equal(await harness.store.settings.get(key), null);
        assert.equal(
          (await harness.store.apis.findById(published.api.id))?.spec_enforcement,
          updated.api.spec_enforcement,
        );
      });

      it(`${level}: retains combined PATCH baseline and operator upstream`, async () => {
        const published = await publish(level);
        const proxyId = published.api.ferrum_proxy_id!;
        const proxy = harness.edge.proxies.get(`nexus/${proxyId}`)!;
        const upstreamId = newId();
        const upstream = {
          id: upstreamId,
          namespace: 'nexus',
          name: 'operator-upstream',
          targets: [{ host: 'operator.example.test', port: 443, weight: 7 }],
          labels: { operator: 'preserve' },
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-02T00:00:00Z',
        };
        const upstreamBytes = JSON.stringify(upstream);
        harness.edge.upstreams.set(`nexus/${upstreamId}`, structuredClone(upstream));
        proxy.upstream_id = upstreamId;
        proxy.hosts = ['operator.example.test'];
        const beforeProxy = structuredClone(proxy);
        const beforePlugins = [...harness.edge.pluginConfigs.values()]
          .filter((plugin) => plugin.proxy_id === proxyId)
          .map((plugin) => structuredClone(plugin));
        const createProxy = harness.edgeClient.proxies.create;
        const createSpec = harness.edgeClient.apiSpecs.create;
        harness.edgeClient.proxies.create = async (...args) => {
          const result = await createProxy(...args);
          refusePolicy();
          return result;
        };
        harness.edgeClient.apiSpecs.create = async (...args) => {
          const result = await createSpec(...args);
          refusePolicy();
          return result;
        };
        const reset = (): void => {
          harness.edgeClient.proxies.create = createProxy;
          harness.edgeClient.apiSpecs.create = createSpec;
        };
        restoreMethods.push(reset);
        await assert.rejects(
          harness.services.publishing.update(actor, published.api.id, {
            upstream_url: 'https://changed.example.test/v2',
            auth_plugin: 'basic_auth',
            cors: { allowed_origins: ['https://client.example.test'], allow_credentials: false },
            rate_limit: { limit: 30, window_seconds: 60 },
            allowed_methods: ['GET', 'POST'],
            spec_enforcement: level === 'routes' ? 'docs_only' : 'routes',
          }),
        );
        const sealed = await harness.store.settings.get(
          `gateway_recovery:nexus:${published.api.id}`,
        );
        assert.ok(sealed?.encrypted && typeof sealed.value === 'string');
        const journal = harness.app.nexus.crypto.decryptJson<{
          proxy: unknown;
          plugins: unknown;
          shape: { upstream_url: string; auth_plugin: string; cors: unknown };
        }>(sealed.value);
        assert.deepEqual(journal.proxy, beforeProxy);
        assert.deepEqual(journal.plugins, beforePlugins);
        assert.equal(journal.shape.upstream_url, published.api.upstream_url);
        assert.equal(journal.shape.auth_plugin, 'key_auth');
        assert.equal(journal.shape.cors, null);
        assert.equal(JSON.stringify(harness.edge.upstreams.get(`nexus/${upstreamId}`)), upstreamBytes);
        reset();
        harness.edge.setBackendEgressPolicy(publicEgressPolicy());
        await harness.edgeClient.proxies.delete(proxyId, actor.id, {
          cleanupOrphanedUpstream: false,
        });
        const restored = await harness.services.publishing.restoreGateway(actor, published.api.id);
        assert.equal(restored.api.gateway_state, 'deployed');
        assert.equal(harness.edge.proxies.get(`nexus/${proxyId}`)?.upstream_id, upstreamId);
        assert.equal(JSON.stringify(harness.edge.upstreams.get(`nexus/${upstreamId}`)), upstreamBytes);
      });

      it(`${level}: records repair when policy changes after conversion deletion`, async () => {
        const published = await publish(level);
        const remove = harness.edgeClient.proxies.delete;
        harness.edgeClient.proxies.delete = async (...args) => {
          await remove(...args);
          refusePolicy();
        };
        restoreMethods.push(() => {
          harness.edgeClient.proxies.delete = remove;
        });
        await assert.rejects(
          harness.services.publishing.update(actor, published.api.id, {
            spec_enforcement: level === 'routes' ? 'docs_only' : 'routes',
          }),
        );
        assert.ok(
          (await harness.auditRows('api.gateway_repair_required')).some(
            (row) => row.target_id === published.api.id,
          ),
        );
        assert.equal(harness.edge.proxyServing(`/nexus/${published.api.slug}`), undefined);
        const repair = await harness.services.reconciliation.repair(founder, {
          apiIds: [published.api.id],
        });
        assert.ok(repair.apis.some((entry) => entry.error?.includes('owned conversion')));
        const retained = await harness.store.apis.findById(published.api.id);
        assert.equal(retained?.gateway_state, 'repair_required');
        assert.equal(retained?.ferrum_proxy_id, published.api.ferrum_proxy_id);
      });

      for (const operation of ['backend', 'revision', 'conversion', 'plugin-config'] as const) {
        it(`${level}: records repair for refused ${operation} compensation`, async () => {
          const published = await publish(level);
          const proxyId = published.api.ferrum_proxy_id!;
          const replaceProxy = harness.edgeClient.proxies.replace;
          const replaceSpec = harness.edgeClient.apiSpecs.replace;
          const replacePlugin = harness.edgeClient.pluginConfigs.replace;
          harness.edgeClient.proxies.replace = async (...args) => {
            const result = await replaceProxy(...args);
            // Only after a real admitted write, never substitute a production guard.
            if (!String(args[1].listen_path).includes('/.staging/')) refusePolicy();
            return result;
          };
          harness.edgeClient.apiSpecs.replace = async (...args) => {
            const result = await replaceSpec(...args);
            refusePolicy();
            return result;
          };
          harness.edgeClient.pluginConfigs.replace = async (...args) => {
            const result = await replacePlugin(...args);
            if (operation === 'plugin-config') refusePolicy();
            return result;
          };
          restoreMethods.push(() => {
            harness.edgeClient.proxies.replace = replaceProxy;
            harness.edgeClient.apiSpecs.replace = replaceSpec;
            harness.edgeClient.pluginConfigs.replace = replacePlugin;
          });
          faults.failAfter(
            'apis',
            'update',
            operation === 'conversion' ? 1 : 0,
            new Error('catalog refusal'),
          );
          const service = harness.services.publishing;
          if (operation === 'backend') {
            await assert.rejects(
              service.update(actor, published.api.id, {
                upstream_url: 'https://changed.example.test',
              }),
            );
          } else if (operation === 'revision') {
            await assert.rejects(
              service.updateSpec(
                actor,
                published.api.id,
                specWithServer('https://changed.example.test'),
              ),
            );
          } else if (operation === 'conversion') {
            await assert.rejects(
              service.update(actor, published.api.id, {
                spec_enforcement: level === 'routes' ? 'docs_only' : 'routes',
              }),
            );
          } else {
            await assert.rejects(
              service.update(actor, published.api.id, {
                rate_limit: { limit: 60, window_seconds: 60 },
              }),
            );
          }
          const repairs = (await harness.auditRows('api.gateway_repair_required')).filter(
            (row) => row.target_id === published.api.id,
          );
          assert.ok(repairs.length > 0, 'a refused compensation remains visible to operators');
          assert.equal(
            (await harness.store.apis.findById(published.api.id))?.spec_enforcement,
            level,
          );
          assert.ok(harness.edge.callsTo('GET', '/backend-egress-policy').length > 0);
          assert.ok(proxyId);
        });
      }
    }

    it('unreleased cascade: replays agents after staging creation', async () => {
      const published = await publish('routes');
      const apiId = published.api.id;
      const proxyId = published.api.ferrum_proxy_id!;
      const enabled = await harness.services.publishing.update(actor, apiId, {
        agents: {
          operations: [
            { path: '/invoices', method: 'GET', name: 'list', description: 'List invoices' },
          ],
        },
      });
      const originalAgents = structuredClone(enabled.api.agents);
      const createProxy = harness.edgeClient.proxies.create;
      let stagingCreates = 0;
      let stagingAcknowledgements = 0;
      harness.edgeClient.proxies.create = async (...args) => {
        assert.equal(args[0].id, proxyId);
        assert.ok(String(args[0].listen_path).includes('/.staging/'));
        stagingCreates += 1;
        const result = await createProxy(...args);
        stagingAcknowledgements += 1;
        refusePolicy();
        return result;
      };
      restoreMethods.push(() => {
        harness.edgeClient.proxies.create = createProxy;
      });
      // This strict control requires the owner teardown API. An earlier refusal
      // cannot stand in for the intended post-creation policy failure.
      const conversionOffset = harness.edge.requests.length;
      await assert.rejects(
        harness.services.publishing.update(actor, apiId, {
          spec_enforcement: 'docs_only',
          agents: null,
        }),
        /required local public egress policy/,
      );
      assert.equal(stagingCreates, 1, 'the intended staging-create method was reached once');
      assert.equal(stagingAcknowledgements, 1, 'the real staging creation was acknowledged');
      assert.equal(
        harness.edge.requests
          .slice(conversionOffset)
          .filter((call) => call.method === 'POST' && call.path === '/proxies').length,
        1,
      );
      harness.edgeClient.proxies.create = createProxy;
      harness.edge.setBackendEgressPolicy(publicEgressPolicy());
      const key = `gateway_recovery:nexus:${apiId}`;
      const originalSealed = await harness.store.settings.get(key);
      assert.ok(originalSealed?.encrypted && typeof originalSealed.value === 'string');
      const original = harness.app.nexus.crypto.decryptJson<Record<string, unknown>>(
        originalSealed.value,
      );
      const beforeRevision = await harness.store.apiSpecs.findCurrentByApi(apiId);
      const metadataError = new Error('repaired metadata refused');
      faults.failNext('settings', 'set', metadataError);
      await assert.rejects(
        harness.services.publishing.updateSpec(
          actor,
          apiId,
          SAMPLE_SPEC_YAML.replace('2.4.0', '2.5.0'),
        ),
        (error: unknown) => {
          assert.equal(error, metadataError, 'the intended settings.set fault was reached');
          return true;
        },
      );
      assert.deepEqual(faults.pending(), [], 'the transaction consumed the metadata fault');
      assert.deepEqual((await harness.store.apis.findById(apiId))?.agents, originalAgents);
      assert.deepEqual(await harness.store.apiSpecs.findCurrentByApi(apiId), beforeRevision);
      assert.deepEqual(await harness.store.settings.get(key), originalSealed);
      const uploaded = await harness.services.publishing.updateSpec(
        actor,
        apiId,
        SAMPLE_SPEC_YAML.replace('2.4.0', '2.5.0'),
      );
      assert.notDeepEqual(uploaded.api.agents, originalAgents);
      const revisedSealed = await harness.store.settings.get(key);
      assert.ok(revisedSealed?.encrypted && typeof revisedSealed.value === 'string');
      const revised = harness.app.nexus.crypto.decryptJson<Record<string, unknown>>(
        revisedSealed.value,
      );
      for (const field of [
        'shape',
        'proxy',
        'plugins',
        'document',
        'originalSpecDocument',
        'originalSpecId',
        'attempt',
      ]) {
        assert.deepEqual(revised[field], original[field], `${field} retains the original baseline`);
      }
      assert.deepEqual((revised.catalogShape as { agents: unknown }).agents, uploaded.api.agents);
      await assert.rejects(
        harness.services.publishing.restoreGateway(actor, apiId),
        /Atomic removal of a partial conversion is unavailable/,
      );
      await harness.edgeClient.proxies.delete(proxyId, actor.id, {
        cleanupOrphanedUpstream: false,
      });
      const restored = await harness.services.publishing.restoreGateway(actor, apiId);
      assert.equal(restored.api.gateway_state, 'deployed');
      assert.deepEqual(restored.api.agents, uploaded.api.agents);
      assert.equal(restored.spec.parsed_version, '2.5.0');
      assert.equal(await harness.store.settings.get(key), null);
    });

    it('replays original agents after teardown refusal and corrected upload', async () => {
      const published = await publish('routes');
      const apiId = published.api.id;
      const proxyId = published.api.ferrum_proxy_id!;
      const key = `gateway_recovery:nexus:${apiId}`;
      const enabled = await harness.services.publishing.update(actor, apiId, {
        agents: {
          operations: [
            { path: '/invoices', method: 'GET', name: 'list', description: 'List invoices' },
          ],
        },
      });
      const originalAgents = structuredClone(enabled.api.agents);
      const originalGateway = gatewayState();
      const originalCatalog = await harness.store.apis.findById(apiId);
      const originalRevision = await harness.store.apiSpecs.findCurrentByApi(apiId);
      const ownership = await harness.store.apiGatewayPlugins.listByApi(apiId);
      assert.ok(originalCatalog && originalRevision);
      assert.equal(await harness.store.settings.get(key), null);
      const createProxy = harness.edgeClient.proxies.create;
      const createSpec = harness.edgeClient.apiSpecs.create;
      let proxyCreates = 0;
      let specCreates = 0;
      let specAcknowledgements = 0;
      const replayDocuments: Record<string, unknown>[] = [];
      harness.edgeClient.proxies.create = async (...args) => {
        proxyCreates += 1;
        return createProxy(...args);
      };
      harness.edgeClient.apiSpecs.create = async (...args) => {
        specCreates += 1;
        replayDocuments.push(structuredClone(args[0]));
        const result = await createSpec(...args);
        specAcknowledgements += 1;
        return result;
      };
      restoreMethods.push(() => {
        harness.edgeClient.proxies.create = createProxy;
        harness.edgeClient.apiSpecs.create = createSpec;
      });
      const conversionOffset = harness.edge.requests.length;
      await assert.rejects(
        harness.services.publishing.update(actor, apiId, {
          spec_enforcement: 'docs_only',
          agents: null,
        }),
        (error: unknown) => {
          assert.ok(isNexusError(error));
          assert.equal(error.code, 'CONFLICT');
          assert.match(error.message, /Atomic conversion teardown is unavailable/);
          assert.deepEqual(error.details, {
            proxy_id: proxyId,
            capability: 'conditional_proxy_cascade',
          });
          return true;
        },
      );
      assert.equal(proxyCreates, 0, 'initial teardown refusal never reaches staging creation');
      assert.equal(specCreates, 0, 'initial teardown refusal never reaches spec creation');
      assert.equal(specAcknowledgements, 0);
      assert.ok(
        harness.edge.requests.slice(conversionOffset).every((call) => call.method === 'GET'),
      );
      assert.deepEqual(gatewayState(), originalGateway);
      assert.deepEqual(await harness.store.apiSpecs.findCurrentByApi(apiId), originalRevision);
      assert.deepEqual(await harness.store.apiGatewayPlugins.listByApi(apiId), ownership);
      const refusedCatalog = await harness.store.apis.findById(apiId);
      assert.ok(refusedCatalog);
      assert.deepEqual(refusedCatalog, {
        ...originalCatalog,
        gateway_state: 'repair_required',
        updated_at: refusedCatalog.updated_at,
      });
      assert.deepEqual(refusedCatalog.agents, originalAgents);
      assert.deepEqual(await completionRows(apiId), { restore: [], rollback: [] });
      const originalSealed = await harness.store.settings.get(key);
      assert.ok(originalSealed?.encrypted && typeof originalSealed.value === 'string');
      const original = harness.app.nexus.crypto.decryptJson<Record<string, unknown>>(
        originalSealed.value,
      );
      assert.equal(original.attempt, null);
      assert.equal(original.originalSpecId, originalRevision.id);
      assert.deepEqual((original.shape as { agents: unknown }).agents, originalAgents);

      const metadataError = new Error('repaired metadata refused');
      faults.failNext('settings', 'set', metadataError);
      const failedUploadOffset = harness.edge.requests.length;
      let metadataRefusals = 0;
      await assert.rejects(
        harness.services.publishing.updateSpec(
          actor,
          apiId,
          SAMPLE_SPEC_YAML.replace('2.4.0', '2.5.0'),
        ),
        (error: unknown) => {
          assert.equal(error, metadataError, 'the intended settings.set fault was reached');
          metadataRefusals += 1;
          return true;
        },
      );
      assert.equal(metadataRefusals, 1);
      assert.deepEqual(faults.pending(), [], 'the transaction consumed the metadata fault');
      assert.deepEqual(await harness.store.apis.findById(apiId), refusedCatalog);
      assert.deepEqual(await harness.store.apiSpecs.findCurrentByApi(apiId), originalRevision);
      assert.deepEqual(await harness.store.settings.get(key), originalSealed);
      assert.deepEqual(await harness.store.apiGatewayPlugins.listByApi(apiId), ownership);
      assert.deepEqual(gatewayState(), originalGateway);
      assert.ok(
        harness.edge.requests.slice(failedUploadOffset).every((call) => call.method === 'GET'),
      );
      assert.deepEqual(await completionRows(apiId), { restore: [], rollback: [] });

      const uploadOffset = harness.edge.requests.length;
      const uploaded = await harness.services.publishing.updateSpec(
        actor,
        apiId,
        SAMPLE_SPEC_YAML.replace('2.4.0', '2.5.0'),
      );
      assert.notDeepEqual(uploaded.api.agents, originalAgents);
      assert.equal(uploaded.spec.parsed_version, '2.5.0');
      const catalog = await harness.store.apis.findById(apiId);
      const revision = await harness.store.apiSpecs.findCurrentByApi(apiId);
      assert.ok(catalog && revision);
      assert.deepEqual(catalog, {
        ...refusedCatalog,
        agents: uploaded.api.agents,
        version: '2.5.0',
        updated_at: catalog.updated_at,
      });
      assert.notEqual(revision.id, originalRevision.id);
      assert.equal(revision.parsed_version, '2.5.0');
      const revisedSealed = await harness.store.settings.get(key);
      assert.ok(revisedSealed?.encrypted && typeof revisedSealed.value === 'string');
      const revised = harness.app.nexus.crypto.decryptJson<Record<string, unknown>>(
        revisedSealed.value,
      );
      assert.deepEqual(revised, {
        ...original,
        catalogShape: {
          ...(original.shape as Record<string, unknown>),
          agents: uploaded.api.agents,
        },
      });
      assert.deepEqual(gatewayState(), originalGateway);
      assert.deepEqual(await harness.store.apiGatewayPlugins.listByApi(apiId), ownership);
      assert.ok(harness.edge.requests.slice(uploadOffset).every((call) => call.method === 'GET'));
      assert.equal(proxyCreates, 0);
      assert.equal(specCreates, 0);
      assert.deepEqual(await completionRows(apiId), { restore: [], rollback: [] });

      const restoreOffset = harness.edge.requests.length;
      await assert.rejects(
        harness.services.publishing.restoreGateway(actor, apiId),
        (error: unknown) => {
          assert.ok(isNexusError(error));
          assert.equal(error.code, 'CONFLICT');
          assert.match(
            error.message,
            /Atomic replacement of a conversion specification is unavailable/,
          );
          assert.deepEqual(error.details, {
            proxy_id: proxyId,
            capability: 'conditional_api_spec_replace',
          });
          return true;
        },
      );
      assert.equal(proxyCreates, 0);
      assert.equal(specCreates, 0, 'live baseline recovery never attempts reconstruction');
      assert.ok(harness.edge.requests.slice(restoreOffset).every((call) => call.method === 'GET'));
      assert.deepEqual(gatewayState(), originalGateway);
      assert.deepEqual(await harness.store.settings.get(key), revisedSealed);
      const afterRefusal = await harness.store.apis.findById(apiId);
      assert.ok(afterRefusal);
      assert.deepEqual(afterRefusal, { ...catalog, updated_at: afterRefusal.updated_at });
      assert.deepEqual(await harness.store.apiSpecs.findCurrentByApi(apiId), revision);
      assert.deepEqual(await harness.store.apiGatewayPlugins.listByApi(apiId), ownership);
      assert.deepEqual(await completionRows(apiId), { restore: [], rollback: [] });

      // A real operator deletion supplies absence. Production can reconstruct
      // the immutable original on staging, but applying the correction and
      // completing routes recovery still requires the internal owner API adoption.
      const deletionOffset = harness.edge.requests.length;
      await harness.edgeClient.proxies.delete(proxyId, actor.id, {
        cleanupOrphanedUpstream: false,
      });
      assert.deepEqual(
        harness.edge.requests
          .slice(deletionOffset)
          .filter((call) => call.method !== 'GET')
          .map(({ method, path }) => ({ method, path })),
        [{ method: 'DELETE', path: `/proxies/${proxyId}` }],
      );
      const getProxy = harness.edgeClient.proxies.get;
      const handOwnedIds = (original.plugins as { id: string; api_spec_id?: string | null }[])
        .filter((plugin) => !plugin.api_spec_id)
        .map((plugin) => plugin.id);
      assert.ok(handOwnedIds.length > 0);
      const replacement: {
        reads: number;
        offset: number;
        gateway?: unknown;
        journal: Awaited<ReturnType<NexusStore['settings']['get']>>;
      } = { reads: 0, offset: 0, journal: null };
      harness.edgeClient.proxies.get = async (...args) => {
        const live = await getProxy(...args);
        if (
          args[0] === proxyId &&
          live &&
          String(live.listen_path).includes('/.staging/') &&
          handOwnedIds.every((id) => live.plugins?.some((entry) => entry.plugin_config_id === id))
        ) {
          replacement.reads += 1;
          replacement.offset = harness.edge.requests.length;
          replacement.gateway = gatewayState();
          replacement.journal = await harness.store.settings.get(key);
        }
        return live;
      };
      restoreMethods.push(() => {
        harness.edgeClient.proxies.get = getProxy;
      });
      const replayOffset = harness.edge.requests.length;
      await assert.rejects(
        harness.services.publishing.restoreGateway(actor, apiId),
        /Atomic replacement of a conversion specification is unavailable/,
      );
      assert.equal(proxyCreates, 0, 'routes reconstruction uses the real spec importer');
      assert.equal(specCreates, 1, 'exactly one original reconstruction was attempted');
      assert.equal(specAcknowledgements, 1, 'the original staging reconstruction was acknowledged');
      assert.equal(
        replacement.reads,
        1,
        'the fully associated staging replacement boundary was reached',
      );
      assert.equal(
        harness.edge.requests
          .slice(replayOffset)
          .filter((call) => call.method === 'POST' && call.path === '/api-specs').length,
        1,
      );
      const replayDocument = replayDocuments[0];
      assert.ok(replayDocument);
      assert.equal((replayDocument.info as { version: string }).version, '2.4.0');
      const replayPlugins = replayDocument['x-ferrum-plugins'] as {
        id: string;
        plugin_name: string;
        config: { policy?: unknown };
      }[];
      const replayMcp = replayPlugins.find((plugin) => plugin.plugin_name === 'mcp_gateway');
      const originalMcp = (
        original.plugins as { id: string; plugin_name: string; config: { policy?: unknown } }[]
      ).find((plugin) => plugin.plugin_name === 'mcp_gateway');
      assert.ok(replayMcp && originalMcp);
      assert.equal(replayMcp.id, originalMcp.id);
      assert.deepEqual(
        replayMcp.config.policy,
        originalMcp.config.policy,
        'the real replay submits the original tool ids and access policy',
      );
      assert.deepEqual(
        gatewayState(),
        replacement.gateway,
        'refusal preserves the entire staged graph',
      );
      assert.ok(
        harness.edge.requests.slice(replacement.offset).every((call) => call.method === 'GET'),
      );
      assert.ok(
        harness.edge.requests
          .slice(replayOffset)
          .every(
            (call) =>
              call.method !== 'DELETE' &&
              !(call.method === 'PUT' && call.path.startsWith('/api-specs/')),
          ),
      );
      assert.ok(replacement.journal?.encrypted && typeof replacement.journal.value === 'string');
      assert.deepEqual(await harness.store.settings.get(key), replacement.journal);
      const replayed = harness.app.nexus.crypto.decryptJson<Record<string, unknown>>(
        replacement.journal.value,
      );
      const attempt = replayed.attempt as {
        level: string;
        agents: unknown;
        proxy: { id: string; listen_path: string };
        specId: string;
        documentDigests: string[];
      };
      assert.deepEqual(replayed, { ...revised, attempt: replayed.attempt });
      assert.equal(attempt.level, 'routes');
      assert.deepEqual(attempt.agents, originalAgents);
      assert.equal(attempt.proxy.id, proxyId);
      assert.ok(attempt.proxy.listen_path.includes('/.staging/'));
      assert.equal(attempt.documentDigests.length, 1);
      assert.match(attempt.documentDigests[0]!, /^[a-f0-9]{64}$/);
      const stagedSpec = await harness.edgeClient.apiSpecs.findByProxy(proxyId);
      assert.ok(stagedSpec);
      assert.equal(attempt.specId, stagedSpec.id);
      assert.equal(harness.edge.proxyServing(`/nexus/${published.api.slug}`), undefined);
      const replayCatalog = await harness.store.apis.findById(apiId);
      assert.ok(replayCatalog);
      assert.deepEqual(replayCatalog, { ...afterRefusal, updated_at: replayCatalog.updated_at });
      assert.deepEqual(await harness.store.apiSpecs.findCurrentByApi(apiId), revision);
      assert.deepEqual(await harness.store.apiGatewayPlugins.listByApi(apiId), ownership);
      assert.deepEqual(await completionRows(apiId), { restore: [], rollback: [] });
      const failures = (await harness.auditRows(AuditAction.API_GATEWAY_RESTORE_FAILED)).filter(
        (row) => row.target_id === apiId,
      );
      assert.equal(failures.length, 2);
      for (const failure of failures) {
        assert.equal(failure.details.withdrawn, false);
        assert.equal(failure.details.proxy_id, proxyId);
        assert.match(
          String(failure.details.error),
          /Atomic replacement of a conversion specification/,
        );
      }
    });

    for (const resource of ['proxy', 'plugin', 'spec'] as const) {
      it(`unreleased cascade: preserves Admin ${resource} edits after conversion`, async () => {
        const published = await publish('docs_only');
        const apiId = published.api.id;
        const proxyId = published.api.ferrum_proxy_id!;
        // This original partial-resource scenario requires the next owner release.
        // Keep it strict; the reachable refusal controls below qualify current behavior.
        let created = false;
        const createSpec = harness.edgeClient.apiSpecs.create;
        harness.edgeClient.apiSpecs.create = async (...args) => {
          const result = await createSpec(...args);
          created = true;
          refusePolicy();
          return result;
        };
        restoreMethods.push(() => {
          harness.edgeClient.apiSpecs.create = createSpec;
        });
        await assert.rejects(
          harness.services.publishing.update(actor, apiId, { spec_enforcement: 'routes' }),
          /required local public egress policy/,
        );
        assert.ok(created, 'conversion actually created the partial spec-owned deployment');
        harness.edgeClient.apiSpecs.create = createSpec;
        harness.edge.setBackendEgressPolicy(publicEgressPolicy());
        const listPlugins = harness.edgeClient.pluginConfigs.listByProxy;
        const admit = harness.edgeClient.assertBackendEgress;
        let armed = false;
        let changed = false;
        let operatorState = '';
        const state = (): string =>
          JSON.stringify({
            proxies: [...harness.edge.proxies],
            plugins: [...harness.edge.pluginConfigs],
            specs: [...harness.edge.apiSpecs],
          });
        harness.edgeClient.pluginConfigs.listByProxy = async (...args) => {
          const result = await listPlugins(...args);
          if (args[0] === proxyId && !changed) armed = true;
          return result;
        };
        harness.edgeClient.assertBackendEgress = async () => {
          await admit();
          if (!armed || changed) return;
          changed = true;
          // A real admitted HTTP mutation interleaves after recovery's validation.
          if (resource === 'proxy') {
            const live = (await harness.edgeClient.proxies.get(proxyId))!;
            await harness.edgeClient.proxies.replace(proxyId, {
              ...live,
              hosts: ['concurrent.operator.example.test'],
            });
          } else if (resource === 'plugin') {
            const plugin = (await listPlugins(proxyId))[0]!;
            await harness.edgeClient.pluginConfigs.replace(plugin.id, {
              plugin_name: plugin.plugin_name,
              scope: plugin.scope,
              proxy_id: proxyId,
              enabled: plugin.enabled,
              config: plugin.config,
              labels: { operator: 'concurrent' },
            });
          } else {
            const spec = harness.edge.apiSpecForProxy(proxyId)!;
            await harness.edgeClient.apiSpecs.replace(spec.id, {
              ...spec.document,
              info: {
                ...(spec.document.info as Record<string, unknown>),
                title: 'Operator revision',
              },
            });
          }
          operatorState = state();
        };
        restoreMethods.push(() => {
          harness.edgeClient.pluginConfigs.listByProxy = listPlugins;
          harness.edgeClient.assertBackendEgress = admit;
        });
        const offset = harness.edge.requests.length;
        await assert.rejects(harness.services.publishing.restoreGateway(actor, apiId));
        assert.ok(changed);
        assert.equal(state(), operatorState);
        assert.ok(!harness.edge.requests.slice(offset).some((call) => call.method === 'DELETE'));
        assert.ok(await harness.store.settings.get(`gateway_recovery:nexus:${apiId}`));
        assert.equal((await harness.store.apis.findById(apiId))?.gateway_state, 'repair_required');
      });
    }

    for (const level of ['docs_only', 'routes'] as const) {
      it(`${level}: preserves read-only reconciliation after conversion refusal`, async () => {
        const published = await publish(level);
        const apiId = published.api.id;
        const proxyId = published.api.ferrum_proxy_id!;
        const key = `gateway_recovery:nexus:${apiId}`;
        const target = level === 'routes' ? 'docs_only' : 'routes';
        const originalGateway = gatewayState();
        const originalCatalog = await harness.store.apis.findById(apiId);
        const originalSpec = await harness.store.apiSpecs.findCurrentByApi(apiId);
        const originalOwnership = await harness.store.apiGatewayPlugins.listByApi(apiId);
        await assert.rejects(
          harness.services.publishing.update(actor, apiId, { spec_enforcement: target }),
          /Atomic conversion teardown is unavailable/,
        );
        assert.ok((await harness.store.settings.get(key))?.encrypted);
        assert.deepEqual(await completionRows(apiId), { restore: [], rollback: [] });
        assert.deepEqual(gatewayState(), originalGateway);
        const offset = harness.edge.requests.length;
        const restoreStartedAt = Date.now();
        const reconciled = await harness.services.publishing.restoreGateway(actor, apiId);
        const restoreFinishedAt = Date.now();
        assert.equal(reconciled.api.gateway_state, 'deployed');
        assert.equal(reconciled.api.ferrum_proxy_id, proxyId);
        assert.ok(harness.edge.requests.slice(offset).every((call) => call.method === 'GET'));
        assert.equal(await harness.store.settings.get(key), null);
        assert.deepEqual(gatewayState(), originalGateway, 'reconciliation sends no gateway write');
        const completedCatalog = await harness.store.apis.findById(apiId);
        assert.ok(completedCatalog);
        assert.deepEqual(completedCatalog, {
          ...originalCatalog,
          updated_at: completedCatalog.updated_at,
        });
        assert.deepEqual(await harness.store.apiSpecs.findCurrentByApi(apiId), originalSpec);
        assertRefreshedOwnership(
          await harness.store.apiGatewayPlugins.listByApi(apiId),
          originalOwnership,
          restoreStartedAt,
          restoreFinishedAt,
        );
        const completed = await completionRows(apiId);
        assert.equal(completed.rollback.length, 1);
        assert.equal(completed.restore.length, 1);
        assert.deepEqual(completed.rollback[0]!.details, {
          proxy_id: proxyId,
          spec_id: published.spec.id,
          recovery: 'original',
        });
        assert.equal(completed.restore[0]!.details.rebuilt, false);
        await assert.rejects(
          harness.services.publishing.update(actor, apiId, { spec_enforcement: target }),
          /Atomic conversion teardown is unavailable/,
        );
        // Explicit operator removal supplies absence; Nexus never performs an
        // unfenced live cleanup to obtain replay authorization.
        await harness.edgeClient.proxies.delete(proxyId, actor.id, {
          cleanupOrphanedUpstream: false,
        });
        if (level === 'routes') {
          await assert.rejects(
            harness.services.publishing.restoreGateway(actor, apiId),
            /Atomic replacement of a conversion specification is unavailable/,
          );
          assert.equal((await harness.store.apis.findById(apiId))?.ferrum_proxy_id, proxyId);
          assert.equal(
            (await harness.store.apis.findById(apiId))?.gateway_state,
            'repair_required',
          );
          assert.ok((await harness.store.settings.get(key))?.encrypted);
          assert.ok(harness.edge.proxies.get(`nexus/${proxyId}`));
          assert.deepEqual(await completionRows(apiId), completed);
          return;
        }
        const rebuilt = await harness.services.publishing.restoreGateway(actor, apiId);
        assert.equal(rebuilt.api.gateway_state, 'deployed');
        assert.equal(rebuilt.api.ferrum_proxy_id, proxyId);
        assert.equal(rebuilt.api.spec_enforcement, level);
        assert.equal(await harness.store.settings.get(key), null);
        assert.ok(harness.edge.proxyServing(`/nexus/${published.api.slug}`));
        const afterRebuild = await completionRows(apiId);
        assert.deepEqual(
          afterRebuild.rollback,
          completed.rollback,
          'a rebuild is not original rollback',
        );
        assert.equal(afterRebuild.restore.length, 2);
      });
    }

    for (const failedAction of [
      AuditAction.API_GATEWAY_CONVERSION_ROLLBACK,
      AuditAction.API_GATEWAY_RESTORE,
    ]) {
      it(`rolls back original reconciliation when ${failedAction} insertion fails`, async () => {
        const published = await publish('routes');
        const apiId = published.api.id;
        const proxyId = published.api.ferrum_proxy_id!;
        const key = `gateway_recovery:nexus:${apiId}`;
        await assert.rejects(
          harness.services.publishing.update(actor, apiId, { spec_enforcement: 'docs_only' }),
          /Atomic conversion teardown is unavailable/,
        );
        const journal = await harness.store.settings.get(key);
        assert.ok(journal?.encrypted);
        const catalog = await harness.store.apis.findById(apiId);
        const revision = await harness.store.apiSpecs.findCurrentByApi(apiId);
        const ownership = await harness.store.apiGatewayPlugins.listByApi(apiId);
        const originalGateway = gatewayState();
        const forStore = harness.services.audit.forStore;
        let witnessed = false;
        harness.services.audit.forStore = (tx) => {
          const auditStore = Object.create(tx) as NexusStore;
          Object.defineProperty(auditStore, 'auditLogs', {
            configurable: true,
            value: {
              async create(input: Parameters<NexusStore['auditLogs']['create']>[0]) {
                if (!witnessed && input.action === failedAction && input.target_id === apiId) {
                  assert.equal(await tx.settings.get(key), null, 'journal deletion was attempted');
                  assert.equal((await tx.apis.findById(apiId))?.gateway_state, 'deployed');
                  assertRefreshedOwnership(
                    await tx.apiGatewayPlugins.listByApi(apiId),
                    ownership,
                    restoreStartedAt,
                    Date.now(),
                  );
                  witnessed = true;
                  throw new Error('original reconciliation audit insert refused');
                }
                return tx.auditLogs.create(input);
              },
              list: tx.auditLogs.list.bind(tx.auditLogs),
              count: tx.auditLogs.count.bind(tx.auditLogs),
            } satisfies NexusStore['auditLogs'],
          });
          return forStore(auditStore);
        };
        restoreMethods.push(() => {
          harness.services.audit.forStore = forStore;
        });
        const offset = harness.edge.requests.length;
        const restoreStartedAt = Date.now();
        await assert.rejects(
          harness.services.publishing.restoreGateway(actor, apiId),
          /original reconciliation audit insert refused/,
        );
        assert.ok(witnessed, 'the actual transactional completion audit insert was reached');
        assert.ok(harness.edge.requests.slice(offset).every((call) => call.method === 'GET'));
        assert.deepEqual(gatewayState(), originalGateway);
        assert.deepEqual(await harness.store.settings.get(key), journal);
        const repaired = await harness.store.apis.findById(apiId);
        assert.ok(repaired);
        assert.deepEqual(repaired, { ...catalog, updated_at: repaired.updated_at });
        assert.equal(repaired.ferrum_proxy_id, proxyId);
        assert.equal(repaired.gateway_state, 'repair_required');
        assert.deepEqual(await harness.store.apiSpecs.findCurrentByApi(apiId), revision);
        assert.deepEqual(await harness.store.apiGatewayPlugins.listByApi(apiId), ownership);
        assert.deepEqual(await completionRows(apiId), { restore: [], rollback: [] });
        const failure = (await harness.auditRows(AuditAction.API_GATEWAY_RESTORE_FAILED)).filter(
          (row) => row.target_id === apiId,
        );
        assert.equal(failure.length, 1);
        assert.equal(failure[0]!.details.withdrawn, false);
        harness.services.audit.forStore = forStore;
        const restored = await harness.services.publishing.restoreGateway(actor, apiId);
        assert.equal(restored.api.gateway_state, 'deployed');
        assert.equal(await harness.store.settings.get(key), null);
        const completed = await completionRows(apiId);
        assert.equal(completed.restore.length, 1);
        assert.equal(completed.rollback.length, 1);
      });
    }

    for (const change of ['corrected-catalog', 'legacy-journal', 'proxy', 'plugin'] as const) {
      it(`does not claim original rollback after a ${change} change`, async () => {
        const published = await publish('docs_only');
        const apiId = published.api.id;
        const proxyId = published.api.ferrum_proxy_id!;
        const key = `gateway_recovery:nexus:${apiId}`;
        await assert.rejects(
          harness.services.publishing.update(actor, apiId, { spec_enforcement: 'routes' }),
          /Atomic conversion teardown is unavailable/,
        );
        if (change === 'corrected-catalog') {
          await harness.services.publishing.updateSpec(actor, apiId, SAMPLE_SPEC_YAML);
          assert.notEqual(
            (await harness.store.apiSpecs.findCurrentByApi(apiId))?.id,
            published.spec.id,
            'even a byte-identical authorized revision has new catalog identity',
          );
        } else if (change === 'legacy-journal') {
          const sealed = await harness.store.settings.get(key);
          assert.ok(sealed?.encrypted && typeof sealed.value === 'string');
          const recovery = harness.app.nexus.crypto.decryptJson<Record<string, unknown>>(
            sealed.value,
          );
          delete recovery.originalSpecId;
          await harness.store.settings.set(
            key,
            harness.app.nexus.crypto.encryptJson(recovery),
            true,
          );
        } else {
          const offset = harness.edge.requests.length;
          const path = await mutateAdminResource(change, proxyId);
          assert.deepEqual(
            harness.edge.requests
              .slice(offset)
              .filter((call) => call.method !== 'GET')
              .map(({ method, path }) => ({ method, path })),
            [{ method: 'PUT', path }],
          );
        }
        const originalGateway = gatewayState();
        const offset = harness.edge.requests.length;
        const restored = await harness.services.publishing.restoreGateway(actor, apiId);
        assert.equal(restored.api.gateway_state, 'deployed');
        assert.equal(await harness.store.settings.get(key), null);
        assert.ok(harness.edge.requests.slice(offset).every((call) => call.method === 'GET'));
        assert.deepEqual(gatewayState(), originalGateway);
        const completed = await completionRows(apiId);
        assert.equal(completed.restore.length, 1);
        assert.deepEqual(completed.rollback, []);
      });
    }

    for (const [boundary, resource] of [
      ['corrected-spec', 'proxy'],
      ['corrected-spec', 'plugin'],
      ['corrected-spec', 'spec'],
      ['cutover', 'proxy'],
    ] as const) {
      it(`refuses ${boundary} recovery after an Admin ${resource} edit`, async () => {
        const published = await publish('routes');
        const apiId = published.api.id;
        const proxyId = published.api.ferrum_proxy_id!;
        const key = `gateway_recovery:nexus:${apiId}`;
        await assert.rejects(
          harness.services.publishing.update(actor, apiId, { spec_enforcement: 'docs_only' }),
          /Atomic conversion teardown is unavailable/,
        );
        if (boundary === 'corrected-spec') {
          await harness.services.publishing.updateSpec(
            actor,
            apiId,
            SAMPLE_SPEC_YAML.replace('2.4.0', '2.5.0'),
          );
        }
        const originalSealed = await harness.store.settings.get(key);
        assert.ok(originalSealed?.encrypted && typeof originalSealed.value === 'string');
        const original = harness.app.nexus.crypto.decryptJson<Record<string, unknown>>(
          originalSealed.value,
        );
        // Only an explicit operator removal supplies absence. Recovery must not
        // delete a live deployment or refresh evidence to obtain replay authority.
        await harness.edgeClient.proxies.delete(proxyId, actor.id, {
          cleanupOrphanedUpstream: false,
        });
        const catalog = await harness.store.apis.findById(apiId);
        assert.ok(catalog);
        const revision = await harness.store.apiSpecs.findCurrentByApi(apiId);
        const ownership = await harness.store.apiGatewayPlugins.listByApi(apiId);
        const successes = await harness.auditRows('api.gateway_restore');
        const rollbacks = await harness.auditRows('api.gateway_conversion_rollback');
        const state = (): unknown =>
          structuredClone({
            proxies: [...harness.edge.proxies],
            plugins: [...harness.edge.pluginConfigs],
            specs: [...harness.edge.apiSpecs],
            upstreams: [...harness.edge.upstreams],
          });
        const originalPlugins = original.plugins as { id: string; api_spec_id?: string | null }[];
        const handOwnedIds = originalPlugins
          .filter((plugin) => !plugin.api_spec_id)
          .map((plugin) => plugin.id);
        assert.ok(handOwnedIds.length > 0);
        const getProxy = harness.edgeClient.proxies.get;
        let completedReads = 0;
        let edited = false;
        let operatorState: unknown;
        let operatorOffset = 0;
        let operatorPath = '';
        let mutationOffset = 0;
        const stagedJournal: {
          value: Awaited<ReturnType<NexusStore['settings']['get']>>;
        } = { value: null };
        harness.edgeClient.proxies.get = async (...args) => {
          const proxy = await getProxy(...args);
          if (
            args[0] !== proxyId ||
            !proxy ||
            edited ||
            typeof proxy.listen_path !== 'string' ||
            !proxy.listen_path.includes('/.staging/') ||
            !handOwnedIds.every((id) =>
              proxy.plugins?.some((entry) => entry.plugin_config_id === id),
            )
          ) {
            return proxy;
          }
          // The first complete read precedes corrected replacement, or unchanged
          // staging validation. The second precedes routes cutover. Return the
          // captured proxy after a real admitted Admin write to expose that race.
          if (++completedReads < (boundary === 'cutover' ? 2 : 1)) return proxy;
          edited = true;
          stagedJournal.value = await harness.store.settings.get(key);
          mutationOffset = harness.edge.requests.length;
          operatorPath = await mutateAdminResource(resource, proxyId);
          operatorState = state();
          operatorOffset = harness.edge.requests.length;
          return proxy;
        };
        restoreMethods.push(() => {
          harness.edgeClient.proxies.get = getProxy;
        });
        const offset = harness.edge.requests.length;
        await assert.rejects(
          harness.services.publishing.restoreGateway(actor, apiId),
          /Atomic replacement of a conversion specification is unavailable/,
        );
        assert.ok(edited, 'the operator edit interleaves at the intended replacement boundary');
        assert.ok(operatorPath, 'the admitted Admin mutation completed');
        assert.deepEqual(
          harness.edge.requests
            .slice(mutationOffset)
            .filter((call) => call.method !== 'GET')
            .map(({ method, path }) => ({ method, path })),
          [{ method: 'PUT', path: operatorPath }],
          'exactly the real operator write was sent at the replacement boundary',
        );
        assert.deepEqual(
          state(),
          operatorState,
          'every staged resource and operator field survives',
        );
        assert.ok(
          harness.edge.requests.slice(operatorOffset).every((call) => call.method === 'GET'),
        );
        assert.ok(
          !harness.edge.requests
            .slice(offset)
            .some(
              (call) =>
                call.method === 'DELETE' ||
                (call.method === 'PUT' &&
                  call.path.startsWith('/api-specs/') &&
                  call.path !== operatorPath),
            ),
        );
        const sealed = await harness.store.settings.get(key);
        assert.ok(sealed?.encrypted && typeof sealed.value === 'string');
        assert.deepEqual(
          sealed,
          stagedJournal.value,
          'refusal retains the acknowledged staging journal',
        );
        const recovery = harness.app.nexus.crypto.decryptJson<Record<string, unknown>>(
          sealed.value,
        );
        for (const field of [
          'shape',
          'catalogShape',
          'proxy',
          'plugins',
          'document',
          'originalSpecDocument',
          'originalSpecId',
        ]) {
          assert.deepEqual(
            recovery[field],
            original[field],
            `${field} retains original replay data`,
          );
        }
        const repaired = await harness.store.apis.findById(apiId);
        assert.ok(repaired);
        assert.deepEqual(repaired, { ...catalog, updated_at: repaired.updated_at });
        assert.equal(repaired.ferrum_proxy_id, proxyId);
        assert.equal(repaired.gateway_state, 'repair_required');
        assert.deepEqual(await harness.store.apiSpecs.findCurrentByApi(apiId), revision);
        assert.deepEqual(await harness.store.apiGatewayPlugins.listByApi(apiId), ownership);
        assert.deepEqual(await harness.auditRows('api.gateway_restore'), successes);
        assert.deepEqual(await harness.auditRows('api.gateway_conversion_rollback'), rollbacks);
        const failure = (await harness.auditRows('api.gateway_restore_failed')).find(
          (row) => row.target_id === apiId,
        );
        assert.ok(failure);
        assert.equal(failure.details.withdrawn, false);
        assert.equal(failure.details.proxy_id, proxyId);
        assert.ok(!harness.edge.proxyServing(`/nexus/${published.api.slug}`));
        const retryOffset = harness.edge.requests.length;
        await assert.rejects(
          harness.services.publishing.restoreGateway(actor, apiId),
          resource === 'proxy'
            ? /partial conversion proxy configuration changed/
            : resource === 'plugin'
              ? /partial conversion has unknown or changed plugin state/
              : /partial conversion specification changed/,
        );
        assert.ok(harness.edge.requests.slice(retryOffset).every((call) => call.method === 'GET'));
        assert.deepEqual(state(), operatorState);
        assert.deepEqual(await harness.store.settings.get(key), sealed);
        assert.deepEqual(await harness.auditRows('api.gateway_restore'), successes);
        assert.deepEqual(await harness.auditRows('api.gateway_conversion_rollback'), rollbacks);
      });
    }

    for (const resource of ['hosts', 'plugin', 'spec'] as const) {
      it(`refuses in-place recovery after a concurrent Admin ${resource} edit`, async () => {
        const published = await publish('routes');
        const apiId = published.api.id;
        const proxyId = published.api.ferrum_proxy_id!;
        const key = `gateway_recovery:nexus:${apiId}`;
        const originalState = (): unknown =>
          structuredClone({
            proxies: [...harness.edge.proxies],
            plugins: [...harness.edge.pluginConfigs],
            specs: [...harness.edge.apiSpecs],
            upstreams: [...harness.edge.upstreams],
          });
        const before = originalState();
        const offset = harness.edge.requests.length;
        await assert.rejects(
          harness.services.publishing.update(actor, apiId, { spec_enforcement: 'docs_only' }),
          /Atomic conversion teardown is unavailable/,
        );
        assert.deepEqual(originalState(), before, 'initial refusal preserves every Edge field');
        assert.ok(harness.edge.requests.slice(offset).every((call) => call.method === 'GET'));
        await harness.services.publishing.updateSpec(
          actor,
          apiId,
          SAMPLE_SPEC_YAML.replace('2.4.0', '2.5.0'),
        );
        const sealed = await harness.store.settings.get(key);
        assert.ok(sealed?.encrypted);
        const catalog = await harness.store.apis.findById(apiId);
        const revision = await harness.store.apiSpecs.findCurrentByApi(apiId);
        const successes = await harness.auditRows('api.gateway_restore');
        const rollbacks = await harness.auditRows('api.gateway_conversion_rollback');
        const readDocument = harness.edgeClient.apiSpecs.documentByProxy;
        let edited = false;
        let baselineReads = 0;
        let operatorState: unknown;
        harness.edgeClient.apiSpecs.documentByProxy = async (...args) => {
          const baseline = await readDocument(...args);
          if (args[0] !== proxyId || edited || ++baselineReads < 2) return baseline;
          edited = true;
          // Return the original baseline after a real Admin write. The caller's
          // separate reads cannot authorize a subsequent importer replacement.
          if (resource === 'hosts') {
            const proxy = (await harness.edgeClient.proxies.get(proxyId))!;
            await harness.edgeClient.proxies.replace(proxyId, {
              ...proxy,
              hosts: ['interleaved.operator.example.test'],
            });
          } else if (resource === 'plugin') {
            const plugin = (await harness.edgeClient.pluginConfigs.listByProxy(proxyId))[0]!;
            await harness.edgeClient.pluginConfigs.replace(plugin.id, {
              plugin_name: plugin.plugin_name,
              scope: plugin.scope,
              proxy_id: proxyId,
              enabled: plugin.enabled,
              config: plugin.config,
              labels: { operator: 'interleaved' },
            });
          } else {
            const spec = harness.edge.apiSpecForProxy(proxyId)!;
            await harness.edgeClient.apiSpecs.replace(spec.id, {
              ...spec.document,
              info: { title: 'Interleaved operator revision', version: 'operator' },
            });
          }
          operatorState = originalState();
          return baseline;
        };
        restoreMethods.push(() => {
          harness.edgeClient.apiSpecs.documentByProxy = readDocument;
        });
        const recoveryOffset = harness.edge.requests.length;
        await assert.rejects(
          harness.services.publishing.restoreGateway(actor, apiId),
          /Atomic replacement of a conversion specification is unavailable/,
        );
        assert.ok(edited, 'the edit interleaves after the captured spec baseline read');
        assert.deepEqual(originalState(), operatorState);
        const writes = harness.edge.requests
          .slice(recoveryOffset)
          .filter((call) => call.method === 'PUT');
        assert.equal(writes.length, 1, 'only the operator mutation is sent');
        assert.ok(
          !harness.edge.requests.slice(recoveryOffset).some((call) => call.method === 'DELETE'),
        );
        assert.deepEqual(await harness.store.settings.get(key), sealed);
        const repaired = await harness.store.apis.findById(apiId);
        assert.ok(repaired);
        assert.deepEqual(repaired, { ...catalog, updated_at: repaired.updated_at });
        assert.deepEqual(await harness.store.apiSpecs.findCurrentByApi(apiId), revision);
        assert.deepEqual(await harness.auditRows('api.gateway_restore'), successes);
        assert.deepEqual(await harness.auditRows('api.gateway_conversion_rollback'), rollbacks);
        assert.ok(
          (await harness.auditRows('api.gateway_restore_failed')).some(
            (row) => row.target_id === apiId,
          ),
        );
      });
    }

    it('retains a failed missing-deployment restore before any unfenced cleanup', async () => {
      const published = await publish('docs_only');
      const apiId = published.api.id;
      await harness.edgeClient.proxies.delete(published.api.ferrum_proxy_id!);
      await harness.store.apis.update(apiId, {
        ferrum_proxy_id: null,
        gateway_state: 'repair_required',
      });
      const replace = harness.edgeClient.proxies.replace;
      let strandedId: string | null = null;
      let operatorState: unknown;
      harness.edgeClient.proxies.replace = async (...args) => {
        const result = await replace(...args);
        if (args[1].listen_path === `/nexus/${published.api.slug}`) {
          strandedId = args[0];
          const proxy = (await harness.edgeClient.proxies.get(strandedId))!;
          await replace(strandedId, { ...proxy, hosts: ['stranded.operator.example.test'] });
          operatorState = structuredClone({
            proxies: [...harness.edge.proxies],
            plugins: [...harness.edge.pluginConfigs],
            specs: [...harness.edge.apiSpecs],
            upstreams: [...harness.edge.upstreams],
          });
        }
        return result;
      };
      restoreMethods.push(() => {
        harness.edgeClient.proxies.replace = replace;
      });
      faults.failNext('apis', 'update', new Error('restore catalog completion refused'));
      const offset = harness.edge.requests.length;
      await assert.rejects(
        harness.services.publishing.restoreGateway(actor, apiId),
        /restore catalog completion refused/,
      );
      assert.ok(strandedId);
      assert.deepEqual(
        structuredClone({
          proxies: [...harness.edge.proxies],
          plugins: [...harness.edge.pluginConfigs],
          specs: [...harness.edge.apiSpecs],
          upstreams: [...harness.edge.upstreams],
        }),
        operatorState,
      );
      assert.ok(!harness.edge.requests.slice(offset).some((call) => call.method === 'DELETE'));
      const row = (await harness.store.apis.findById(apiId))!;
      assert.equal(row.gateway_state, 'repair_required');
      assert.equal(row.ferrum_proxy_id, strandedId, 'retain the uncertain deployment identity');
      assert.ok(
        !(await harness.auditRows('api.gateway_restore')).some(
          (entry) => entry.target_id === apiId,
        ),
      );
      const failure = (await harness.auditRows('api.gateway_restore_failed')).find(
        (entry) => entry.target_id === apiId,
      );
      assert.ok(failure);
      assert.equal(failure.details.withdrawn, false);
    });

    it('refuses agent ACL enrollment before changing an active grant or consumer', async () => {
      const published = await publish('routes');
      const session = await harness.registerUser({ role: 'client' });
      const user = (await harness.store.users.findById(session.user.id))!;
      const provisioner = harness.services.credentials.provisioner;
      const mapping = await provisioner.ensureConsumer(user);
      const group = `nexus:api:${published.api.id}:approved`;
      const grant = await harness.store.grants.create({
        api_id: published.api.id,
        user_id: user.id,
        application_id: null,
        access_request_id: null,
        acl_group: group,
        status: 'active',
        granted_by: actor.id,
        approved_tools: null,
      });
      await provisioner.mutateAclGroups(mapping.ferrum_consumer_id, () => [group]);
      const consumer = harness.edge.consumers.get(`nexus/${mapping.ferrum_consumer_id}`)!;
      const before = structuredClone(consumer);
      const offset = harness.edge.requests.length;
      refusePolicy();
      await assert.rejects(
        harness.services.publishing.update(actor, published.api.id, {
          agents: {
            operations: [
              { path: '/invoices', method: 'GET', name: 'list', description: 'List invoices' },
            ],
          },
        }),
        /required local public egress policy/,
      );
      assert.deepEqual(consumer, before);
      assert.deepEqual(await harness.store.grants.findById(grant.id), grant);
      assert.equal((await harness.store.apis.findById(published.api.id))?.agents, null);
      assert.ok(harness.edge.requests.slice(offset).every((request) => request.method === 'GET'));
    });

    it('three consumer callers preserve data and refuse stale writes', async () => {
      const session = await harness.registerUser({ role: 'client' });
      const user = (await harness.store.users.findById(session.user.id))!;
      const provisioner = harness.services.credentials.provisioner;
      const mapping = await provisioner.ensureConsumer(user);
      const id = mapping.ferrum_consumer_id;
      const issued = await harness.authed(session, {
        method: 'POST',
        url: '/api/credentials',
        payload: { credential_type: 'basicauth' },
      });
      assert.equal(issued.statusCode, 201, issued.body);
      const password = issued.json<{ secret: { password: string } }>().secret.password;
      const stored = harness.edge.consumers.get(`nexus/${id}`)!;
      const basic = structuredClone(stored.credentials.basicauth);
      assert.deepEqual(basic, [{ password_hash: mockBasicPasswordHash(password) }]);
      assert.ok(!JSON.stringify(stored).includes(password));
      stored.labels = { operator: 'retained' };
      stored.credentials = {
        keyauth: [{ key: 'complete-key', future: { nested: ['kept'] } }],
        jwt: [{ secret: 'complete-jwt-secret-' + 'b'.repeat(32), issuer: 'operator' }],
        basicauth: basic!,
        custom: [{ opaque: { secret: 'hidden-custom', marker: '[REDACTED]' } }],
        mtls_auth: [{ identity: 'spiffe://operator/workload' }],
      };
      const expected = structuredClone(stored.credentials);
      expected.jwt = [{ secret: String(stored.credentials.jwt![0]!.secret) }];
      await provisioner.mutateAclGroups(id, () => ['operator-group', 'nexus:api:stray:approved']);
      assert.deepEqual(stored.credentials, expected);
      await harness.services.credentials.restoreGatewayAccess(user.id, actor.id);
      assert.deepEqual(stored.acl_groups, ['operator-group']);
      assert.deepEqual(stored.credentials, expected);
      assert.deepEqual(stored.labels, { operator: 'retained' });

      const verification = harness.edgeClient.consumers.verification;
      let originalTag: string | undefined;
      harness.edgeClient.consumers.verification = async (...args) => {
        const snapshot = await verification(...args);
        originalTag = snapshot?.etag;
        stored.credentials.keyauth![0]!.key = `concurrent-${newId()}`;
        return snapshot;
      };
      restoreMethods.push(() => {
        harness.edgeClient.consumers.verification = verification;
      });
      const operations = [
        () => provisioner.mutateAclGroups(id, () => ['new-group']),
        () => harness.services.credentials.restoreGatewayAccess(user.id, actor.id),
        () => harness.services.credentials.disableGatewayAccess(user.id, actor.id),
      ];
      for (const [index, operation] of operations.entries()) {
        if (index === 1) stored.acl_groups = ['operator-group', 'nexus:api:stray:approved'];
        if (index === 2) await harness.store.users.update(user.id, { status: 'disabled' });
        const groupsBefore = [...stored.acl_groups];
        const offset = harness.edge.requests.length;
        await assert.rejects(operation, (error: unknown) => {
          assert.ok(isNexusError(error));
          assert.equal(error.code, 'CONFLICT');
          assert.equal((error.details as { status: number }).status, 412);
          return true;
        });
        assert.deepEqual(stored.acl_groups, groupsBefore);
        assert.equal(harness.edge.callsTo('PUT', `/consumers/${id}`).at(-1)?.ifMatch, originalTag);
        assert.ok(originalTag?.startsWith('"') && originalTag.endsWith('"'));
        assert.ok(
          !harness.edge.requests.slice(offset).some((request) => request.method === 'DELETE'),
        );
      }
      harness.edgeClient.consumers.verification = verification;
      await harness.services.credentials.disableGatewayAccess(user.id, actor.id);
      const put = harness.edge.callsTo('PUT', `/consumers/${id}`).at(-1)!;
      assert.deepEqual((put.body as { credentials: unknown }).credentials, {
        keyauth: [{ key: '[REDACTED]' }],
        jwt: [{ secret: '[REDACTED]' }],
        mtls_auth: [{ identity: 'spiffe://operator/workload' }],
      });
      assert.deepEqual(
        stored.credentials,
        { custom: expected.custom, mtls_auth: expected.mtls_auth },
        'teardown removes only the three Nexus-supported credential types',
      );
      for (const type of ['keyauth', 'basicauth', 'jwt']) {
        assert.ok(harness.edge.callsTo('DELETE', `/consumers/${id}/credentials/${type}`).length > 0);
      }
      assert.deepEqual(stored.acl_groups, []);
      assert.deepEqual(stored.labels, { operator: 'retained' });
      assert.ok(put.ifMatch);
      assert.ok(!JSON.stringify(put.body).includes(password));
      const audit = JSON.stringify(await harness.auditRows());
      for (const secret of [
        'complete-key',
        'complete-jwt-secret-',
        'hidden-custom',
        'hmac_sha256:',
      ]) {
        assert.ok(!audit.includes(secret), 'complete credential material must never enter audits');
      }
    });
  });
}
