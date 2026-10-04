import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';

import type { PublishApiResponse } from '@ferrum-nexus/shared';

import type { NexusStore, UserRecord } from '../db/store.js';
import { isNexusError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { faultInjectingStore, type FaultInjectingStore } from './fault-injection.js';
import { buildTestApp, SAMPLE_SPEC_YAML, specWithServer, type TestApp } from './helpers.js';
import { publicEgressPolicy } from './mock-ferrum-edge.js';

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
    const restoreMethods: (() => void)[] = [];

    before(async () => {
      target = await makeStore();
      faults = faultInjectingStore(target.store);
      harness = await buildTestApp({ store: faults.store });
      await harness.registerUser();
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
      const stored = harness.edge.consumers.get(`nexus/${id}`)!;
      stored.labels = { operator: 'retained' };
      stored.credentials = {
        keyauth: [{ key: 'complete-key', future: { nested: ['kept'] } }],
        jwt: [{ secret: 'complete-jwt-secret-' + 'b'.repeat(32), issuer: 'operator' }],
        basicauth: [
          { username: 'legacy', password_hash: 'hmac_sha256:' + 'a'.repeat(64), future: true },
        ],
        custom: [{ opaque: { secret: 'hidden-custom' } }],
      };
      const expected = structuredClone(stored.credentials);
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
        await assert.rejects(operation, (error: unknown) => {
          assert.ok(isNexusError(error));
          assert.equal(error.code, 'CONFLICT');
          assert.equal((error.details as { status: number }).status, 412);
          return true;
        });
      }
      harness.edgeClient.consumers.verification = verification;
      const beforeDisable = structuredClone(stored.credentials);
      await harness.services.credentials.disableGatewayAccess(user.id, actor.id);
      const put = harness.edge.callsTo('PUT', `/consumers/${id}`).at(-1)!;
      assert.deepEqual((put.body as { credentials: unknown }).credentials, beforeDisable);
      assert.deepEqual(stored.labels, { operator: 'retained' });
      assert.ok(put.ifMatch);
      assert.ok(!JSON.stringify(put.body).includes('[REDACTED]'));
      const audit = JSON.stringify(await harness.auditRows());
      for (const secret of ['complete-key', 'complete-jwt-secret-', 'hidden-custom', 'hmac_sha256:']) {
        assert.ok(!audit.includes(secret), 'complete credential material must never enter audits');
      }
    });
  });
}
