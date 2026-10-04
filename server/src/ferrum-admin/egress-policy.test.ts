import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildTestApp } from '../test/helpers.js';
import { publicEgressPolicy } from '../test/mock-ferrum-edge.js';
import { parseBackendEgressPolicy, provesLocalPublicEgress } from './egress-policy.js';

describe('closed owner egress contract', () => {
  it('rejects every missing field, unknown key and inconsistent vocabulary', () => {
    const valid = publicEgressPolicy();
    assert.ok(provesLocalPublicEgress(parseBackendEgressPolicy(valid, 'nexus')!));
    for (const key of Object.keys(valid)) {
      const incomplete = { ...valid };
      delete incomplete[key];
      assert.equal(parseBackendEgressPolicy(incomplete, 'nexus'), null, key);
    }
    for (const patch of [
      { extra: 'opaque-canary' },
      { schema_version: 2 },
      { ip_classification: 'future' },
      { namespace: 'another' },
      { policy_scope: 'fleet' },
      { enforcement_scope: 'fleet' },
      { mode: 'future' },
      { mode: {} },
      { dangerous_ranges_blocked: 1 },
      { allow_cidr_overrides_present: 'false' },
      { deny_cidr_overrides_present: null },
      { mode_allowed_ip_classes: ['public', 'public'] },
      { mode_blocked_ip_classes: [] },
      { evaluation_order: ['deny-cidrs', 'allow-cidrs', 'dangerous-ranges', 'ip-mode'] },
      { public_only_guaranteed: false },
      { allow_cidr_overrides_present: true },
    ]) {
      assert.equal(parseBackendEgressPolicy({ ...valid, ...patch }, 'nexus'), null);
    }
    for (const value of [null, [], 'public', 1]) {
      assert.equal(parseBackendEgressPolicy(value, 'nexus'), null);
    }
  });

  it('recognizes modes and requires local serving without allow overlays', () => {
    for (const mode of ['both', 'public', 'private']) {
      const policy = parseBackendEgressPolicy(
        {
          ...publicEgressPolicy(),
          mode,
          mode_allowed_ip_classes:
            mode === 'both'
              ? ['public', 'private-reserved']
              : mode === 'public'
                ? ['public']
                : ['private-reserved'],
          mode_blocked_ip_classes:
            mode === 'both' ? [] : mode === 'public' ? ['private-reserved'] : ['public'],
          public_only_guaranteed: mode === 'public',
        },
        'nexus',
      );
      assert.ok(policy);
      assert.equal(provesLocalPublicEgress(policy), mode === 'public');
    }
    for (const enforcement_scope of ['unserved-namespace', 'admission-only', 'no-data-plane']) {
      const policy = parseBackendEgressPolicy(
        { ...publicEgressPolicy(), enforcement_scope },
        'nexus',
      );
      assert.ok(policy);
      assert.equal(provesLocalPublicEgress(policy), false);
    }
    const denyOnly = parseBackendEgressPolicy(
      {
        ...publicEgressPolicy(),
        deny_cidr_overrides_present: true,
        dangerous_ranges_blocked: false,
      },
      'nexus',
    );
    assert.ok(denyOnly && provesLocalPublicEgress(denyOnly));
  });

  it('checks all backend boundaries after a successful sampled probe', async (t) => {
    const harness = await buildTestApp();
    t.after(() => harness.close());
    const edge = harness.edgeClient;
    const proxy = await edge.proxies.create({
      id: 'egress-proxy',
      listen_path: '/nexus/egress',
      backend_host: 'example.test',
      backend_port: 80,
    });
    assert.equal((await edge.probe()).backendEgressVerified, true);
    harness.edge.setBackendEgressPolicy({
      ...publicEgressPolicy(),
      allow_cidr_overrides_present: true,
      public_only_guaranteed: false,
    });
    const before = harness.edge.requests.length;
    for (const write of [
      () =>
        edge.proxies.create({
          listen_path: '/nexus/another',
          backend_host: 'example.test',
          backend_port: 80,
        }),
      () => edge.proxies.replace(proxy.id, { ...proxy }),
      () => edge.apiSpecs.create({}),
      () => edge.apiSpecs.replace('spec', {}),
    ]) {
      await assert.rejects(write, /required local public egress policy/);
    }
    const requests = harness.edge.requests.slice(before);
    assert.equal(requests.length, 4);
    assert.ok(requests.every((request) => request.path === '/backend-egress-policy'));
    for (const request of requests) {
      assert.equal(request.method, 'GET');
      assert.equal(request.namespace, 'nexus');
      assert.equal(request.claims?.ns, 'nexus');
      assert.equal(request.claims?.role, 'admin');
    }
  });

  it('refuses weaker serving policies and inconsistent metadata', async (t) => {
    const harness = await buildTestApp();
    t.after(() => harness.close());
    for (const patch of [
      { enforcement_scope: 'admission-only' },
      { enforcement_scope: 'unserved-namespace' },
      { enforcement_scope: 'no-data-plane' },
      { allow_cidr_overrides_present: true, public_only_guaranteed: false },
      {
        mode: 'both',
        mode_allowed_ip_classes: ['public', 'private-reserved'],
        mode_blocked_ip_classes: [],
        public_only_guaranteed: false,
      },
      { namespace: 'wrong' },
      { mode: 'future' },
      { public_only_guaranteed: false },
    ]) {
      harness.edge.setBackendEgressPolicy({ ...publicEgressPolicy(), ...patch });
      await assert.rejects(harness.edgeClient.assertBackendEgress());
    }
  });

  it('keeps missing, refused, oversized and timed-out policy errors opaque', async (t) => {
    const logs: unknown[] = [];
    const harness = await buildTestApp({
      env: { FERRUM_ADMIN_TIMEOUT_MS: '250' },
      edgeLogger: {
        debug: (value) => logs.push(value),
        warn: (value) => logs.push(value),
        error: (value) => logs.push(value),
      },
    });
    t.after(() => harness.close());
    for (const status of [400, 401, 403, 404, 409, 503]) {
      harness.edge.queueFailure(
        status,
        { error: 'secret-policy-canary' },
        '/backend-egress-policy',
      );
      await assert.rejects(harness.edgeClient.assertBackendEgress(), (error: Error) => {
        assert.ok(!JSON.stringify(error).includes('secret-policy-canary'));
        assert.ok(!error.message.includes('secret-policy-canary'));
        return true;
      });
    }
    harness.edge.setBackendEgressPolicy({ ...publicEgressPolicy(), extra: 'x'.repeat(5_000) });
    await assert.rejects(harness.edgeClient.assertBackendEgress(), /invalid protocol/);
    harness.edge.setBackendEgressPolicy(publicEgressPolicy());
    harness.edge.delay('/backend-egress-policy', 500, 'GET');
    await assert.rejects(harness.edgeClient.assertBackendEgress());
    assert.ok(!JSON.stringify(logs).includes('secret-policy-canary'));
  });

  it('private opt-in accepts weaker policies but requires valid metadata', async (t) => {
    const harness = await buildTestApp({ env: { NEXUS_ALLOW_PRIVATE_UPSTREAMS: 'true' } });
    t.after(() => harness.close());
    harness.edge.setBackendEgressPolicy({
      ...publicEgressPolicy(),
      enforcement_scope: 'admission-only',
      mode: 'both',
      mode_allowed_ip_classes: ['public', 'private-reserved'],
      mode_blocked_ip_classes: [],
      public_only_guaranteed: false,
    });
    await harness.edgeClient.assertBackendEgress();
    harness.edge.setBackendEgressPolicy(null);
    await assert.rejects(harness.edgeClient.assertBackendEgress());
  });
});
