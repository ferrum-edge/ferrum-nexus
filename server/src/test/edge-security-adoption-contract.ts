import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';

import type { PublishApiResponse } from '@ferrum-nexus/shared';

import type { NexusStore, UserRecord } from '../db/store.js';
import { isNexusError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { faultInjectingStore, type FaultInjectingStore } from './fault-injection.js';
import { buildTestApp, SAMPLE_SPEC_YAML, specWithServer, type TestApp } from './helpers.js';
import { mockBasicPasswordHash, publicEgressPolicy } from './mock-ferrum-edge.js';

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

    it('keeps original agent replay coherent through repaired upload and restore', async () => {
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
      harness.edgeClient.proxies.create = async (...args) => {
        const result = await createProxy(...args);
        refusePolicy();
        return result;
      };
      restoreMethods.push(() => {
        harness.edgeClient.proxies.create = createProxy;
      });
      await assert.rejects(
        harness.services.publishing.update(actor, apiId, {
          spec_enforcement: 'docs_only',
          agents: null,
        }),
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
      faults.failNext('settings', 'set', new Error('repaired metadata refused'));
      await assert.rejects(
        harness.services.publishing.updateSpec(
          actor,
          apiId,
          SAMPLE_SPEC_YAML.replace('2.4.0', '2.5.0'),
        ),
        /repaired metadata refused/,
      );
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

    for (const resource of ['proxy', 'plugin', 'spec'] as const) {
      it(`preserves a concurrent Admin ${resource} change at the recovery boundary`, async () => {
        const published = await publish('docs_only');
        const apiId = published.api.id;
        const proxyId = published.api.ferrum_proxy_id!;
        const createSpec = harness.edgeClient.apiSpecs.create;
        harness.edgeClient.apiSpecs.create = async (...args) => {
          const result = await createSpec(...args);
          refusePolicy();
          return result;
        };
        restoreMethods.push(() => {
          harness.edgeClient.apiSpecs.create = createSpec;
        });
        await assert.rejects(
          harness.services.publishing.update(actor, apiId, { spec_enforcement: 'routes' }),
        );
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
      assert.deepEqual(stored.acl_groups, ['operator-group']);
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
