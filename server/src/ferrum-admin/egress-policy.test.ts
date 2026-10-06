import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, it } from 'node:test';

import type { ApiErrorBody, PublishApiResponse } from '@ferrum-nexus/shared';

import { buildTestApp, SAMPLE_SPEC_YAML } from '../test/helpers.js';
import { publicEgressPolicy } from '../test/mock-ferrum-edge.js';
import {
  admitBackendEgress,
  isUnsupportedEgressPolicySchema,
  parseBackendEgressPolicy,
  provesLocalPublicEgress,
} from './egress-policy.js';

/** A public-mode control plane: schema 2 never reports it as guaranteed. */
function controlPlanePolicy(): Record<string, unknown> {
  return {
    ...publicEgressPolicy(),
    enforcement_scope: 'admission-only',
    public_only_guaranteed: false,
  };
}

describe('closed owner egress contract', () => {
  const root = new URL('../../../contracts/ferrum-contracts/', import.meta.url);

  it('preserves every field of the published canonical fixtures and rejects all invalid cases', () => {
    const pin = readFileSync(new URL('PIN', root), 'utf8');
    const schema = JSON.parse(
      readFileSync(new URL('schemas/backend-egress-policy/v2.schema.json', root), 'utf8'),
    ) as { required: string[]; properties: Record<string, unknown>; additionalProperties: boolean };
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required.sort(), Object.keys(publicEgressPolicy()).sort());
    assert.deepEqual(Object.keys(schema.properties).sort(), schema.required);
    for (const kind of ['valid', 'invalid']) {
      const base = `fixtures/backend-egress-policy/v2/${kind}/`;
      for (const name of readdirSync(new URL(base, root))) {
        const path = base + name;
        assert.ok(pin.includes(`  ${path}\n`), 'every canonical fixture must be pinned');
        const bytes = readFileSync(new URL(path, root), 'utf8');
        const value = JSON.parse(bytes) as Record<string, unknown>;
        const parsed = parseBackendEgressPolicy(value, String(value.namespace));
        if (kind === 'invalid') {
          assert.equal(parsed, null, name);
          continue;
        }
        assert.deepEqual(parsed, value, `${name}: no field may be omitted or inferred`);
        assert.equal(
          provesLocalPublicEgress(parsed!),
          value.enforcement_scope === 'local-data-plane' && value.public_only_guaranteed === true,
          name,
        );
        // Schema 2 never guarantees anything but local enforcement.
        if (value.public_only_guaranteed === true) {
          assert.equal(value.enforcement_scope, 'local-data-plane', name);
        }
        for (const key of schema.required) {
          const incomplete = { ...value };
          delete incomplete[key];
          assert.equal(parseBackendEgressPolicy(incomplete, String(value.namespace)), null, key);
        }
      }
    }
  });

  it('refuses every Edge v0.9.12 (schema 1) policy as an unsupported schema', () => {
    let schemaOne = 0;
    for (const kind of ['valid', 'invalid']) {
      const base = `fixtures/backend-egress-policy/v1/${kind}/`;
      for (const name of readdirSync(new URL(base, root))) {
        const bytes = readFileSync(new URL(base + name, root), 'utf8');
        const value = JSON.parse(bytes) as Record<string, unknown>;
        if (value.schema_version !== 1) {
          // The v1 set's "unknown" version is schema 2, which this pairing supports: it is
          // asserted on the v2 path below, never silently skipped.
          assert.equal(`${kind}/${name}`, 'invalid/unknown-version.json');
          assert.equal(value.schema_version, 2, name);
          const parsed = parseBackendEgressPolicy(value, String(value.namespace));
          assert.deepEqual(parsed, value, name);
          assert.equal(provesLocalPublicEgress(parsed!), false, name);
          assert.equal(isUnsupportedEgressPolicySchema(value), false, name);
          continue;
        }
        schemaOne += 1;
        assert.equal(parseBackendEgressPolicy(value, String(value.namespace)), null, name);
        assert.equal(isUnsupportedEgressPolicySchema(value), true, name);
      }
    }
    assert.ok(schemaOne >= 12, 'every published schema 1 fixture is exercised');
  });

  it('refuses a genuinely unknown schema version as unsupported', () => {
    for (const name of ['unknown-version.json', 'previous-version.json']) {
      const path = `fixtures/backend-egress-policy/v2/invalid/${name}`;
      const bytes = readFileSync(new URL(path, root), 'utf8');
      const value = JSON.parse(bytes) as Record<string, unknown>;
      assert.notEqual(value.schema_version, 2, name);
      assert.equal(parseBackendEgressPolicy(value, String(value.namespace)), null, name);
      assert.equal(isUnsupportedEgressPolicySchema(value), true, name);
    }
  });

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
      { schema_version: 1 },
      { schema_version: 3 },
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
      // Schema 1's policy-only reading: a guarantee without local enforcement.
      { enforcement_scope: 'admission-only' },
      { enforcement_scope: 'unserved-namespace' },
      { enforcement_scope: 'no-data-plane' },
    ]) {
      assert.equal(parseBackendEgressPolicy({ ...valid, ...patch }, 'nexus'), null);
    }
    for (const value of [null, [], 'public', 1]) {
      assert.equal(parseBackendEgressPolicy(value, 'nexus'), null);
    }
  });

  it('tells another schema apart from a malformed policy, and refuses both', () => {
    for (const schema_version of [1, 3]) {
      const other = { ...publicEgressPolicy(), schema_version };
      assert.equal(parseBackendEgressPolicy(other, 'nexus'), null);
      assert.equal(isUnsupportedEgressPolicySchema(other), true);
    }
    for (const value of [
      publicEgressPolicy(),
      { ...publicEgressPolicy(), schema_version: '2' },
      { ...publicEgressPolicy(), schema_version: 1.5 },
      null,
      [],
    ]) {
      assert.equal(isUnsupportedEgressPolicySchema(value), false);
    }
  });

  it('keeps the two opt-outs independent of each other and of the guarantee', () => {
    const local = parseBackendEgressPolicy(publicEgressPolicy(), 'nexus')!;
    const controlPlane = parseBackendEgressPolicy(controlPlanePolicy(), 'nexus')!;
    const localBoth = parseBackendEgressPolicy(
      {
        ...publicEgressPolicy(),
        mode: 'both',
        mode_allowed_ip_classes: ['public', 'private-reserved'],
        mode_blocked_ip_classes: [],
        public_only_guaranteed: false,
      },
      'nexus',
    )!;
    const controlPlaneWithAllowOverrides = parseBackendEgressPolicy(
      {
        ...publicEgressPolicy(),
        enforcement_scope: 'admission-only',
        allow_cidr_overrides_present: true,
        public_only_guaranteed: false,
      },
      'nexus',
    )!;
    const guaranteed = {
      egress_profile: 'public-guaranteed',
      enforcement_scope: 'local-data-plane',
    };
    assert.deepEqual(admitBackendEgress(local, {}), guaranteed);
    assert.deepEqual(
      admitBackendEgress(local, { allowPrivateUpstreams: true, allowUnattestedEdgeEgress: true }),
      guaranteed,
    );
    assert.equal(admitBackendEgress(controlPlane, {}), null);
    // The unattested opt-in still needs public_only_guaranteed=true, which schema 2
    // reports only for local enforcement: a control plane is never admitted by it.
    assert.equal(admitBackendEgress(controlPlane, { allowUnattestedEdgeEgress: true }), null);
    assert.equal(admitBackendEgress(localBoth, { allowUnattestedEdgeEgress: true }), null);
    assert.equal(
      admitBackendEgress(controlPlaneWithAllowOverrides, { allowUnattestedEdgeEgress: true }),
      null,
    );
    assert.deepEqual(admitBackendEgress(controlPlane, { allowPrivateUpstreams: true }), {
      egress_profile: 'private-upstreams-opt-in',
      enforcement_scope: 'admission-only',
    });
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
        { ...publicEgressPolicy(), enforcement_scope, public_only_guaranteed: false },
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
      { enforcement_scope: 'admission-only', public_only_guaranteed: false },
      { enforcement_scope: 'unserved-namespace', public_only_guaranteed: false },
      { enforcement_scope: 'no-data-plane', public_only_guaranteed: false },
      { enforcement_scope: 'admission-only' },
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
      ...controlPlanePolicy(),
      mode: 'both',
      mode_allowed_ip_classes: ['public', 'private-reserved'],
      mode_blocked_ip_classes: [],
      public_only_guaranteed: false,
    });
    await harness.edgeClient.assertBackendEgress();
    harness.edge.setBackendEgressPolicy(null);
    await assert.rejects(harness.edgeClient.assertBackendEgress());
  });

  it('unattested opt-in keeps screening and admits no schema 2 control plane', async (t) => {
    const logLines: string[] = [];
    const harness = await buildTestApp({
      env: { NEXUS_ALLOW_UNATTESTED_EDGE_EGRESS: 'true' },
      deps: {
        logger: { level: 'warn', stream: { write: (line: string) => logLines.push(line) } },
      },
    });
    t.after(() => harness.close());
    assert.ok(logLines.some((line) => line.includes('NEXUS_ALLOW_UNATTESTED_EDGE_EGRESS=true')));
    assert.ok(!logLines.some((line) => line.includes('NEXUS_ALLOW_PRIVATE_UPSTREAMS=true')));
    await harness.registerUser();
    const provider = await harness.registerUser({ role: 'provider' });
    const payload = (slug: string): Record<string, unknown> => ({
      name: `API ${slug}`,
      slug,
      version: '1.0.0',
      spec: SAMPLE_SPEC_YAML,
      auth_plugin: 'key_auth',
      requestable: true,
      visibility: 'public',
    });

    // Nexus's own screening still refuses a private upstream.
    const refused = await harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: { ...payload('unattested-ssrf'), upstream_url: 'http://169.254.169.254/latest' },
    });
    assert.equal(refused.statusCode, 400, refused.body);
    const error = refused.json<ApiErrorBody>().error;
    assert.equal(error.code, 'SPEC_INVALID');
    assert.equal((error.details as { reason?: string }).reason, 'private_upstream');
    assert.equal(harness.edge.proxies.size, 0, 'nothing reached the gateway');

    // Edge v0.9.13 reports a public-mode control plane as not guaranteed, and
    // the opt-in never reinterprets that as the schema 1 policy-only value.
    harness.edge.setBackendEgressPolicy(controlPlanePolicy());
    const controlPlane = await harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: payload('unattested-control-plane'),
    });
    assert.notEqual(controlPlane.statusCode, 201, controlPlane.body);
    assert.equal(harness.edge.proxies.size, 0, 'nothing reached the gateway');

    // A local public-only data plane publishes under the guarantee itself.
    harness.edge.setBackendEgressPolicy(publicEgressPolicy());
    const published = await harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: payload('unattested'),
    });
    assert.equal(published.statusCode, 201, published.body);
    const apiId = published.json<PublishApiResponse>().api.id;
    const row = (await harness.auditRows('api.publish')).find((entry) => entry.target_id === apiId);
    assert.equal(row?.details.egress_profile, 'public-guaranteed');
    assert.equal(row?.details.enforcement_scope, 'local-data-plane');
  });

  it('warns at startup for each opt-out that is set, and only for those', async (t) => {
    for (const [env, expected] of [
      [{}, []],
      [{ NEXUS_ALLOW_PRIVATE_UPSTREAMS: 'true' }, ['NEXUS_ALLOW_PRIVATE_UPSTREAMS=true']],
      [{ NEXUS_ALLOW_UNATTESTED_EDGE_EGRESS: 'true' }, ['NEXUS_ALLOW_UNATTESTED_EDGE_EGRESS=true']],
    ] as const) {
      const logLines: string[] = [];
      const harness = await buildTestApp({
        env,
        deps: {
          logger: { level: 'warn', stream: { write: (line: string) => logLines.push(line) } },
        },
      });
      t.after(() => harness.close());
      const warned = logLines
        .filter((line) => line.includes('BACKEND EGRESS NOT GUARANTEED'))
        .map((line) => /NEXUS_ALLOW_[A-Z_]+=true/.exec(line)?.[0]);
      assert.deepEqual(warned, expected);
    }
  });
});
