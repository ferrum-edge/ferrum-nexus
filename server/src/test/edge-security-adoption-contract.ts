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
          faults.failNext('apis', 'update', new Error('catalog refusal'));
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
      harness.edgeClient.consumers.verification = async (...args) => {
        const snapshot = await verification(...args);
        stored.credentials.keyauth![0]!.key = `concurrent-${newId()}`;
        return snapshot;
      };
      restoreMethods.push(() => {
        harness.edgeClient.consumers.verification = verification;
      });
      for (const operation of [
        () => provisioner.mutateAclGroups(id, () => ['new-group']),
        async () => {
          stored.acl_groups = ['operator-group', 'nexus:api:stray:approved'];
          await harness.services.credentials.restoreGatewayAccess(user.id, actor.id);
        },
        async () => {
          await harness.store.users.update(user.id, { status: 'disabled' });
          await harness.services.credentials.disableGatewayAccess(user.id, actor.id);
        },
      ]) {
        const groupsBefore = [...stored.acl_groups];
        const offset = harness.edge.requests.length;
        await assert.rejects(operation, (error: unknown) => {
          assert.ok(isNexusError(error));
          assert.equal(error.code, 'CONFLICT');
          assert.equal((error.details as { status: number }).status, 412);
          return true;
        });
        assert.deepEqual(stored.acl_groups, groupsBefore);
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
        {},
        'teardown removes hidden/custom types through dedicated endpoints',
      );
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
