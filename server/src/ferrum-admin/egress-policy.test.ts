import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, it } from 'node:test';

import type { ApiErrorBody, PublishApiResponse } from '@ferrum-nexus/shared';

import {
  attestedControlPlanePolicy,
  type DataPlaneReport,
} from '../test/edge-egress-attestation-fixtures.js';
import type { NexusError } from '../lib/errors.js';
import { buildTestApp, SAMPLE_SPEC_YAML } from '../test/helpers.js';
import { publicEgressPolicy } from '../test/mock-ferrum-edge.js';
import { EGRESS_POLICY_MAX_BYTES, gatewayDateMillis } from './client.js';
import {
  admitBackendEgress,
  assessBackendEgress,
  CLOCK_SKEW_ALLOWANCE_MS,
  createDataPlaneSightings,
  DATA_PLANE_SETTLE_MS,
  dataPlaneAttestationVerdict,
  describeDataPlaneAttestation,
  isUnsupportedEgressPolicySchema,
  parseBackendEgressPolicy,
  provesDataPlanePublicEgress,
  provesLocalPublicEgress,
  provesPublicEgress,
  readBackendEgressPolicy,
  type BackendEgressPolicy,
  type DataPlaneAttestationProblem,
  type DataPlaneAttestationVerdict,
  type DataPlaneEgressAttestation,
  type DataPlaneEgressPolicy,
  type DataPlaneFreshness,
} from './egress-policy.js';

/** The vendored canonical `backend-egress-policy` v2 fixtures (contracts-edge-0.9.14). */
const EGRESS_FIXTURES = new URL(
  '../../../contracts/ferrum-contracts/fixtures/backend-egress-policy/v2/',
  import.meta.url,
);

/** A read an hour after the canonical fixtures' streams connected: every one has settled. */
const FIXTURE_READ: DataPlaneFreshness = { readAt: Date.parse('2026-10-06T13:00:00Z') };

/** One canonical fixture, e.g. `valid/public-serving.json`. */
function egressFixture(path: string): Record<string, unknown> {
  const bytes = readFileSync(new URL(path, EGRESS_FIXTURES), 'utf8');
  return JSON.parse(bytes) as Record<string, unknown>;
}

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
    // Edge v0.9.14's control-plane attestation is the only optional member.
    assert.deepEqual(
      Object.keys(schema.properties).sort(),
      [...schema.required, 'data_plane_attestation'].sort(),
    );
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
    harness.edge.setBackendEgressPolicy({
      ...publicEgressPolicy(),
      extra: 'x'.repeat(EGRESS_POLICY_MAX_BYTES),
    });
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

describe('control-plane data-plane attestation (Edge v0.9.14)', () => {
  const PUBLIC: DataPlaneReport = { mode: 'public' };

  /** Deep copy of a fixture's attestation, for building inconsistent answers. */
  function attestationOf(policy: Record<string, unknown>): Record<string, unknown> {
    return structuredClone(policy.data_plane_attestation) as Record<string, unknown>;
  }

  function withAttestation(
    policy: Record<string, unknown>,
    patch: (attestation: Record<string, unknown>) => void,
  ): Record<string, unknown> {
    const attestation = attestationOf(policy);
    patch(attestation);
    return { ...policy, data_plane_attestation: attestation };
  }

  it('reads the owner examples without omitting or inferring a field', () => {
    // contracts-edge-0.9.14 transcribes the owner's two control-plane examples.
    const emptyExample = egressFixture('valid/control-plane-attestation-empty.json');
    const attestedExample = egressFixture('valid/control-plane-attestation-reported.json');
    for (const example of [emptyExample, attestedExample]) {
      const parsed = parseBackendEgressPolicy(example, 'ferrum');
      assert.ok(parsed);
      assert.deepEqual(parsed, example);
      assert.equal(provesLocalPublicEgress(parsed), false);
    }
    const empty = parseBackendEgressPolicy(emptyExample, 'ferrum')!;
    assert.equal(provesPublicEgress(empty, 1, FIXTURE_READ), false);
    assert.equal(
      dataPlaneAttestationVerdict(empty, 1, FIXTURE_READ),
      'data_planes_not_public_only',
    );
    const attested = parseBackendEgressPolicy(attestedExample, 'ferrum')!;
    // Without the operator's inventory, the connected set is not known to be the fleet.
    assert.equal(provesDataPlanePublicEgress(attested, undefined, FIXTURE_READ), false);
    assert.equal(
      dataPlaneAttestationVerdict(attested, undefined, FIXTURE_READ),
      'expected_data_planes_unset',
    );
    assert.equal(admitBackendEgress(attested, {}, FIXTURE_READ), null);
    assert.equal(provesDataPlanePublicEgress(attested, 2, FIXTURE_READ), true);
    assert.equal(provesPublicEgress(attested, 2, FIXTURE_READ), true);
    // The CP's own policy is `both` and not guaranteed; only the data planes count.
    assert.equal(attested.public_only_guaranteed, false);
    assert.deepEqual(admitBackendEgress(attested, { expectedDataPlanes: 2 }, FIXTURE_READ), {
      egress_profile: 'public-guaranteed',
      enforcement_scope: 'admission-only',
    });
    // Another namespace's answer is never read, attestation or not.
    assert.equal(parseBackendEgressPolicy(attestedExample, 'nexus'), null);
  });

  it('gives every canonical valid fixture the verdict Nexus intends', () => {
    const every = (verdict: DataPlaneAttestationVerdict): DataPlaneAttestationVerdict[] =>
      Array.from({ length: 4 }, () => verdict);
    const notPublicOnly = every('data_planes_not_public_only');
    // The verdict with NEXUS_EXPECTED_DATA_PLANES unset, then set to 1, 2 and 3.
    const expectations: Record<string, DataPlaneAttestationVerdict[]> = {
      // Two public-only data planes with distinct node_ids.
      'control-plane-attestation-reported.json': [
        'expected_data_planes_unset',
        'more_data_planes_than_expected',
        'guaranteed',
        'fewer_data_planes_than_expected',
      ],
      'control-plane-attestation-empty.json': notPublicOnly,
      // An unknown data plane, an allow overlay, and two streams of one node_id
      // of which one is `both`: each leaves the set short of public-only.
      'control-plane-attestation-unknown.json': notPublicOnly,
      'control-plane-attestation-allow-overlay.json': notPublicOnly,
      'control-plane-attestation-shared-node-id.json': notPublicOnly,
      // Control planes without the object, as Edge v0.9.13 answers.
      'default-control-plane.json': every('attestation_absent'),
      'private-control-plane.json': every('attestation_absent'),
      'public-control-plane.json': every('attestation_absent'),
      'public-no-data-plane.json': every('not_control_plane'),
      'public-serving.json': every('not_control_plane'),
      'public-unserved-namespace.json': every('not_control_plane'),
      'public-with-allow-overrides.json': every('not_control_plane'),
    };
    const names = readdirSync(new URL('valid/', EGRESS_FIXTURES)).sort();
    assert.deepEqual(names, Object.keys(expectations).sort(), 'every valid fixture has a verdict');
    for (const name of names) {
      const value = egressFixture(`valid/${name}`);
      const reading = readBackendEgressPolicy(value, String(value.namespace));
      assert.ok(reading, name);
      assert.equal(reading.attestationProblem, null, name);
      assert.deepEqual(reading.policy, value, name);
      const local = provesLocalPublicEgress(reading.policy);
      [undefined, 1, 2, 3].forEach((expectedDataPlanes, index) => {
        const verdict = expectations[name]![index];
        assert.equal(
          dataPlaneAttestationVerdict(reading.policy, expectedDataPlanes, FIXTURE_READ),
          verdict,
          name,
        );
        const assessment = assessBackendEgress(reading, { expectedDataPlanes }, FIXTURE_READ);
        const guaranteed = local || verdict === 'guaranteed';
        assert.equal(assessment.publicEgressGuaranteed, guaranteed, name);
        assert.equal(assessment.dataPlaneAttestation, verdict, name);
        assert.deepEqual(
          assessment.admission,
          guaranteed
            ? { egress_profile: 'public-guaranteed', enforcement_scope: value.enforcement_scope }
            : null,
          name,
        );
      });
    }
  });

  it('sets aside or refuses every canonical invalid fixture, and never grants on one', () => {
    // How each attestation case is set aside; every other invalid fixture is a
    // top-level refusal.
    const problems: Record<string, DataPlaneAttestationProblem> = {
      'attestation-on-local-data-plane.json': 'out_of_scope',
      'attestation-unknown-source.json': 'malformed',
      'attestation-leaked-cidr-field.json': 'malformed',
      'attestation-negative-count.json': 'malformed',
      'attestation-missing-data-planes.json': 'malformed',
      'weakest-policy-unknown-mode.json': 'malformed',
      'entry-build-version.json': 'malformed',
      'entry-unknown-attestation.json': 'malformed',
      'entry-reported-without-policy.json': 'malformed',
      'entry-unknown-with-policy.json': 'malformed',
      'entry-connected-at-without-offset.json': 'malformed',
      'entry-policy-leaked-cidr-field.json': 'malformed',
      'entry-policy-mode-class-mismatch.json': 'malformed',
      'entry-policy-false-public-guarantee.json': 'malformed',
      'entry-policy-allow-overlay-guarantee.json': 'malformed',
      'weakest-policy-without-reports.json': 'inconsistent',
      'reports-without-weakest-policy.json': 'inconsistent',
      'empty-set-complete.json': 'inconsistent',
      'guarantee-with-unknown-data-plane.json': 'inconsistent',
      'guarantee-with-allow-overlay.json': 'inconsistent',
      'public-only-not-aggregated.json': 'inconsistent',
    };
    let attestationCases = 0;
    for (const name of readdirSync(new URL('invalid/', EGRESS_FIXTURES))) {
      const value = egressFixture(`invalid/${name}`);
      const namespace = String(value.namespace);
      assert.equal(parseBackendEgressPolicy(value, namespace), null, name);
      const reading = readBackendEgressPolicy(value, namespace);
      if (!Object.hasOwn(value, 'data_plane_attestation')) {
        assert.equal(reading, null, name);
        assert.equal(problems[name], undefined, name);
        continue;
      }
      attestationCases += 1;
      assert.ok(reading, name);
      assert.equal(reading.attestationProblem, problems[name], name);
      assert.equal(Object.hasOwn(reading.policy, 'data_plane_attestation'), false, name);
      for (const expectedDataPlanes of [undefined, 1, 2]) {
        const strict = assessBackendEgress(reading, { expectedDataPlanes });
        assert.equal(strict.publicEgressGuaranteed, false, name);
        assert.equal(strict.admission, null, name);
        assert.equal(strict.dataPlaneAttestation, 'attestation_unreadable', name);
      }
      const optedOut = assessBackendEgress(reading, {
        expectedDataPlanes: 2,
        allowPrivateUpstreams: true,
      });
      assert.equal(optedOut.admission?.egress_profile, 'private-upstreams-opt-in', name);
    }
    assert.equal(attestationCases, Object.keys(problems).length, 'every case is exercised');
  });

  it('builds the canonical control-plane answers exactly as Edge aggregates them', () => {
    const reportOf = (policy: DataPlaneEgressPolicy | null): DataPlaneReport | null =>
      policy === null
        ? null
        : {
            mode: policy.mode,
            dangerous_ranges_blocked: policy.dangerous_ranges_blocked,
            allow_cidr_overrides_present: policy.allow_cidr_overrides_present,
            deny_cidr_overrides_present: policy.deny_cidr_overrides_present,
          };
    let built = 0;
    for (const name of readdirSync(new URL('valid/', EGRESS_FIXTURES))) {
      const value = egressFixture(`valid/${name}`);
      const attestation = (value as unknown as BackendEgressPolicy).data_plane_attestation;
      if (attestation === undefined) continue;
      const reports = attestation.data_planes.map(({ policy }) => reportOf(policy));
      const answer = attestedControlPlanePolicy(reports, String(value.namespace));
      const generated = answer.data_plane_attestation as DataPlaneEgressAttestation;
      // Stream identities and times are illustrative in both; take the fixture's.
      generated.data_planes.forEach((plane, index) => {
        plane.node_id = attestation.data_planes[index]!.node_id;
        plane.connected_at = attestation.data_planes[index]!.connected_at;
      });
      assert.deepEqual(answer, value, name);
      built += 1;
    }
    assert.equal(built, 5, 'every canonical attestation fixture is rebuilt');
  });

  it('requires connected_at to be an RFC 3339 date-time', () => {
    const attested = attestedControlPlanePolicy([PUBLIC]);
    const problemFor = (connectedAt: unknown): DataPlaneAttestationProblem | null | undefined =>
      readBackendEgressPolicy(
        withAttestation(attested, (a) => {
          (a.data_planes as Record<string, unknown>[])[0]!.connected_at = connectedAt;
        }),
        'nexus',
      )?.attestationProblem;
    for (const accepted of [
      '2026-10-06T12:00:00+00:00',
      '2026-10-06T12:00:00.123456789+00:00',
      '2026-10-06T12:00:00Z',
      '2024-02-29T23:59:60-05:30',
    ]) {
      assert.equal(problemFor(accepted), null, accepted);
    }
    for (const refused of [
      '2026-10-06T12:00:00',
      '2026-10-06 12:00:00+00:00',
      '2026-10-06',
      '2025-02-29T12:00:00Z',
      '2026-13-01T12:00:00Z',
      '2026-10-06T24:00:00Z',
      '2026-10-06T12:00:00+24:00',
      '',
      1_791_288_000,
      null,
    ]) {
      assert.equal(problemFor(refused), 'malformed', String(refused));
    }
  });

  it('grants the guarantee when every connected data plane reports public-only', () => {
    const fleets: DataPlaneReport[][] = [
      [PUBLIC],
      [PUBLIC, PUBLIC, PUBLIC],
      // Deny overlays only restrict, and the dangerous baseline is not the rule.
      [PUBLIC, { mode: 'public', deny_cidr_overrides_present: true }],
      [{ mode: 'public', dangerous_ranges_blocked: false }],
    ];
    for (const reports of fleets) {
      const policy = parseBackendEgressPolicy(attestedControlPlanePolicy(reports), 'nexus');
      assert.ok(policy, JSON.stringify(reports));
      assert.equal(provesPublicEgress(policy, reports.length), true, JSON.stringify(reports));
    }
  });

  it('fails closed on an empty, partial or weaker data-plane set', () => {
    const cases: [string, (DataPlaneReport | null)[]][] = [
      ['no connected data plane', []],
      ['one unknown data plane', [null]],
      ['an unknown data plane among public ones', [PUBLIC, null, PUBLIC]],
      ['a data plane in both mode', [PUBLIC, { mode: 'both' }]],
      ['a data plane in private mode', [PUBLIC, { mode: 'private' }]],
      ['an allow overlay', [PUBLIC, { mode: 'public', allow_cidr_overrides_present: true }]],
    ];
    for (const [name, reports] of cases) {
      const policy = parseBackendEgressPolicy(attestedControlPlanePolicy(reports), 'nexus');
      assert.ok(policy, name);
      // Even an inventory the connected set meets does not cover a weaker fleet.
      const expectedDataPlanes = Math.max(reports.length, 1);
      assert.equal(provesDataPlanePublicEgress(policy, expectedDataPlanes), false, name);
      assert.equal(provesPublicEgress(policy, expectedDataPlanes), false, name);
      assert.equal(
        dataPlaneAttestationVerdict(policy, expectedDataPlanes),
        'data_planes_not_public_only',
        name,
      );
      assert.equal(admitBackendEgress(policy, { expectedDataPlanes }), null, name);
      // The unattested opt-in still needs the CP's own guarantee, which is never set.
      assert.equal(
        admitBackendEgress(policy, { expectedDataPlanes, allowUnattestedEdgeEgress: true }),
        null,
        name,
      );
      assert.deepEqual(
        admitBackendEgress(policy, { expectedDataPlanes, allowPrivateUpstreams: true }),
        { egress_profile: 'private-upstreams-opt-in', enforcement_scope: 'admission-only' },
        name,
      );
    }
  });

  it('keeps an Edge v0.9.13 control plane, without attestation, not guaranteed', () => {
    const older = { ...attestedControlPlanePolicy([PUBLIC]) };
    delete older.data_plane_attestation;
    const policy = parseBackendEgressPolicy(older, 'nexus');
    assert.ok(policy);
    assert.equal(provesPublicEgress(policy, 1), false);
    assert.equal(dataPlaneAttestationVerdict(policy, 1), 'attestation_absent');
    assert.equal(admitBackendEgress(policy, { expectedDataPlanes: 1 }), null);
  });

  it('grants the guarantee only when the distinct data planes equal the expected count', () => {
    const policy = parseBackendEgressPolicy(
      attestedControlPlanePolicy([PUBLIC, PUBLIC, PUBLIC]),
      'nexus',
    )!;
    const cases: [string, number | undefined, string][] = [
      ['unset', undefined, 'expected_data_planes_unset'],
      ['above the connected count', 4, 'fewer_data_planes_than_expected'],
      ['equal to the connected count', 3, 'guaranteed'],
      // More data planes than the inventory: it is not the fleet, so it proves nothing.
      ['below the connected count', 2, 'more_data_planes_than_expected'],
      // Anything but a positive integer is no inventory at all.
      ['zero', 0, 'expected_data_planes_unset'],
      ['negative', -3, 'expected_data_planes_unset'],
      ['fractional', 2.5, 'expected_data_planes_unset'],
      ['not a number', Number.NaN, 'expected_data_planes_unset'],
    ];
    for (const [name, expectedDataPlanes, verdict] of cases) {
      assert.equal(dataPlaneAttestationVerdict(policy, expectedDataPlanes), verdict, name);
      const guaranteed = verdict === 'guaranteed';
      assert.equal(provesPublicEgress(policy, expectedDataPlanes), guaranteed, name);
      const options = expectedDataPlanes === undefined ? {} : { expectedDataPlanes };
      assert.deepEqual(
        admitBackendEgress(policy, options),
        guaranteed
          ? { egress_profile: 'public-guaranteed', enforcement_scope: 'admission-only' }
          : null,
        name,
      );
      // An opt-out still admits a control plane the count leaves unproven.
      assert.equal(
        admitBackendEgress(policy, { ...options, allowPrivateUpstreams: true })?.egress_profile,
        guaranteed ? 'public-guaranteed' : 'private-upstreams-opt-in',
        name,
      );
    }
    // The count never reaches a local data plane, whose own process proves it.
    const local = parseBackendEgressPolicy(publicEgressPolicy(), 'nexus')!;
    assert.equal(dataPlaneAttestationVerdict(local, 5), 'not_control_plane');
    assert.equal(provesPublicEgress(local), true);
  });

  it('counts distinct node_ids, so a duplicated stream never stands in for a missing one', () => {
    // A reconnect overlap: Edge lists one stream per Subscribe, so dp-0 appears twice.
    const streams = attestedControlPlanePolicy([PUBLIC, PUBLIC, PUBLIC]);
    const overlap = withAttestation(streams, (a) => {
      (a.data_planes as Record<string, unknown>[])[2]!.node_id = 'dp-0';
    });
    const policy = parseBackendEgressPolicy(overlap, 'nexus');
    assert.ok(policy);
    assert.equal(policy.data_plane_attestation?.connected_data_planes, 3);
    assert.equal(dataPlaneAttestationVerdict(policy, 3), 'fewer_data_planes_than_expected');
    assert.equal(provesPublicEgress(policy, 3), false);
    assert.equal(admitBackendEgress(policy, { expectedDataPlanes: 3 }), null);
    assert.equal(dataPlaneAttestationVerdict(policy, 2), 'guaranteed');
    assert.deepEqual(admitBackendEgress(policy, { expectedDataPlanes: 2 }), {
      egress_profile: 'public-guaranteed',
      enforcement_scope: 'admission-only',
    });
  });

  describe('stream age: a restarted data plane never stands in for a missing one (#540)', () => {
    const READ_AT = Date.parse('2026-10-08T12:00:00Z');
    /** Nexus's read and the gateway's `Date`, on agreeing clocks. */
    const AGREED: DataPlaneFreshness = { readAt: READ_AT, gatewayDate: READ_AT };
    const SETTLED_S = (DATA_PLANE_SETTLE_MS + CLOCK_SKEW_ALLOWANCE_MS) / 1000;

    /** Public-only streams, each a node_id and how many seconds before READ_AT it connected. */
    function streams(connected: [string, number][]): BackendEgressPolicy {
      const answer = attestedControlPlanePolicy(connected.map(() => PUBLIC));
      const planes = (answer.data_plane_attestation as DataPlaneEgressAttestation).data_planes;
      connected.forEach(([nodeId, secondsAgo], index) => {
        planes[index]!.node_id = nodeId;
        planes[index]!.connected_at = new Date(READ_AT - secondsAgo * 1000).toISOString();
      });
      const policy = parseBackendEgressPolicy(answer, 'nexus');
      assert.ok(policy);
      return policy;
    }

    it('withholds the guarantee while a restarted data plane may still count twice', () => {
      // The fleet is A and B; B streams from another control plane. A crashed
      // and restarted under a new node_id while its stale stream is still listed.
      const restart = streams([
        ['dp-a-old', 3_600],
        ['dp-a-new', 5],
      ]);
      assert.equal(
        dataPlaneAttestationVerdict(restart, 2, AGREED),
        'data_plane_recently_connected',
      );
      assert.equal(provesPublicEgress(restart, 2, AGREED), false);
      assert.equal(admitBackendEgress(restart, { expectedDataPlanes: 2 }, AGREED), null);
      const reading = { policy: restart, attestationProblem: null };
      assert.deepEqual(assessBackendEgress(reading, { expectedDataPlanes: 2 }, AGREED), {
        publicEgressGuaranteed: false,
        admission: null,
        dataPlaneAttestation: 'data_plane_recently_connected',
      });
      // Right up to the bound, and on Nexus's clock alone.
      const late = streams([
        ['dp-a-old', 3_600],
        ['dp-a-new', SETTLED_S - 1],
      ]);
      assert.equal(dataPlaneAttestationVerdict(late, 2, AGREED), 'data_plane_recently_connected');
      assert.equal(
        dataPlaneAttestationVerdict(restart, 2, { readAt: READ_AT }),
        'data_plane_recently_connected',
      );
      // Once Edge drops the stale stream the count is short, so it stays refused.
      const reaped = streams([['dp-a-new', SETTLED_S]]);
      assert.equal(
        dataPlaneAttestationVerdict(reaped, 2, AGREED),
        'fewer_data_planes_than_expected',
      );
      // An opt-out still admits it, never as guaranteed.
      const optedOut = { expectedDataPlanes: 2, allowPrivateUpstreams: true };
      assert.equal(
        admitBackendEgress(restart, optedOut, AGREED)?.egress_profile,
        'private-upstreams-opt-in',
      );
      assert.match(
        describeDataPlaneAttestation('data_plane_recently_connected') ?? '',
        /connected too recently/,
      );
    });

    it('withholds it while any listed data plane is new, even with the count met', () => {
      // A new node_id may be the replacement of any other listed one, whose
      // stream would then be stale: none of the older entries can be trusted.
      const surge = streams([
        ['dp-a', 3_600],
        ['dp-b', 3_600],
        ['dp-c', 10],
      ]);
      assert.equal(dataPlaneAttestationVerdict(surge, 3, AGREED), 'data_plane_recently_connected');
      assert.equal(dataPlaneAttestationVerdict(surge, 2, AGREED), 'more_data_planes_than_expected');
    });

    it('grants a genuine fleet of N data planes once every one has settled', () => {
      for (const size of [1, 2, 5]) {
        const nodeIds = Array.from({ length: size }, (_, index) => `dp-${index}`);
        const fleet = streams(nodeIds.map((nodeId): [string, number] => [nodeId, 600]));
        assert.equal(dataPlaneAttestationVerdict(fleet, size, AGREED), 'guaranteed', String(size));
        assert.equal(dataPlaneAttestationVerdict(fleet, size, { readAt: READ_AT }), 'guaranteed');
        assert.deepEqual(admitBackendEgress(fleet, { expectedDataPlanes: size }, AGREED), {
          egress_profile: 'public-guaranteed',
          enforcement_scope: 'admission-only',
        });
        assert.equal(
          dataPlaneAttestationVerdict(fleet, size + 1, AGREED),
          'fewer_data_planes_than_expected',
        );
      }
      // Exactly at the bound it counts.
      const bound = streams([
        ['dp-a', SETTLED_S],
        ['dp-b', 3_600],
      ]);
      assert.equal(dataPlaneAttestationVerdict(bound, 2, AGREED), 'guaranteed');
      // A reconnect overlap keeps the process's first stream, so it stays settled.
      const overlap = streams([
        ['dp-a', 3_600],
        ['dp-a', 2],
        ['dp-b', 3_600],
      ]);
      assert.equal(dataPlaneAttestationVerdict(overlap, 2, AGREED), 'guaranteed');
    });

    it('keeps a routine reconnect settled through node_ids this process already saw', () => {
      // Edge renews every stream within the hour; afterwards only the new one is listed.
      const reconnected = streams([
        ['dp-a', 3_600],
        ['dp-b', 3],
      ]);
      assert.equal(
        dataPlaneAttestationVerdict(reconnected, 2, AGREED),
        'data_plane_recently_connected',
      );
      const seen = { ...AGREED, settledNodeIds: new Set(['dp-b']) };
      assert.equal(dataPlaneAttestationVerdict(reconnected, 2, seen), 'guaranteed');
      // A sighting covers only its own node_id.
      const other = { ...AGREED, settledNodeIds: new Set(['dp-a']) };
      assert.equal(
        dataPlaneAttestationVerdict(reconnected, 2, other),
        'data_plane_recently_connected',
      );
    });

    it('fails closed on clock skew it can see, and tolerates what it allows', () => {
      const fleet = streams([
        ['dp-a', 3_600],
        ['dp-b', 600],
      ]);
      const skewed = (freshness: DataPlaneFreshness): DataPlaneAttestationVerdict =>
        dataPlaneAttestationVerdict(fleet, 2, freshness);
      const allowance = CLOCK_SKEW_ALLOWANCE_MS;
      // Nexus's clock behind the control plane's: dp-b connected "in the future".
      assert.equal(skewed({ readAt: READ_AT - 600_000 - allowance - 1 }), 'data_plane_clock_skew');
      // Within the allowance, a stream is merely too new.
      assert.equal(
        skewed({ readAt: READ_AT - 600_000 - allowance }),
        'data_plane_recently_connected',
      );
      // Nexus's clock ahead: the gateway's own Date still shows dp-b too new.
      const ahead = { readAt: READ_AT + 3_600_000, gatewayDate: READ_AT - 600_000 + 10_000 };
      assert.equal(skewed(ahead), 'data_plane_recently_connected');
      // Either clock seeing a stream older than Edge lets one live is skew too.
      assert.equal(skewed({ readAt: READ_AT + 2 * 86_400_000 }), 'data_plane_clock_skew');
      assert.equal(
        skewed({ readAt: READ_AT, gatewayDate: READ_AT - 3_600_000 }),
        'data_plane_clock_skew',
      );
      assert.equal(skewed({ readAt: Number.NaN }), 'data_plane_clock_skew');
      // Sightings are on this process's monotonic clock, which no skew moves.
      const sighted = new Set(['dp-a', 'dp-b']);
      assert.equal(skewed({ readAt: READ_AT - 3_600_000, settledNodeIds: sighted }), 'guaranteed');
      // But a skewed clock never settles an unsighted data plane.
      assert.equal(
        skewed({ readAt: READ_AT - 3_600_000, settledNodeIds: new Set(['dp-a']) }),
        'data_plane_clock_skew',
      );
      assert.match(describeDataPlaneAttestation('data_plane_clock_skew') ?? '', /clock/);
    });
  });

  it('remembers when this process first saw each node_id, on its own clock', () => {
    let now = 1_000;
    const sightings = createDataPlaneSightings(() => now);
    const fleet = (nodeIds: string[]): BackendEgressPolicy => {
      const answer = attestedControlPlanePolicy(nodeIds.map(() => PUBLIC));
      const planes = (answer.data_plane_attestation as DataPlaneEgressAttestation).data_planes;
      nodeIds.forEach((nodeId, index) => (planes[index]!.node_id = nodeId));
      return parseBackendEgressPolicy(answer, 'nexus')!;
    };
    // A request sent at `startedAt` whose answer arrives 50 ms later.
    const read = (nodeIds: string[], startedAt: number): string[] => {
      now = startedAt + 50;
      return [...sightings.observe(fleet(nodeIds), startedAt)].sort();
    };
    assert.deepEqual(read(['dp-a', 'dp-b'], 1_000), []);
    // First seen when the answer arrived (1 050), measured from when the next was sent.
    assert.deepEqual(read(['dp-a', 'dp-b'], 1_050 + DATA_PLANE_SETTLE_MS - 1), []);
    assert.deepEqual(read(['dp-a', 'dp-b', 'dp-c'], 1_050 + DATA_PLANE_SETTLE_MS), [
      'dp-a',
      'dp-b',
    ]);
    // dp-b reconnects after a short gap and is still known.
    assert.deepEqual(read(['dp-a'], 200_000), ['dp-a']);
    assert.deepEqual(read(['dp-a', 'dp-b'], 210_000), ['dp-a', 'dp-b']);
    // A node_id unlisted for longer than the retention is forgotten.
    assert.deepEqual(read(['dp-a'], 3_000_000), ['dp-a']);
    assert.deepEqual(read(['dp-a', 'dp-b'], 3_010_000), ['dp-a']);
    // A local data plane's answer lists nothing.
    now = 4_000_000;
    const local = parseBackendEgressPolicy(publicEgressPolicy(), 'nexus')!;
    assert.deepEqual([...sightings.observe(local, now)], []);
  });

  it('reads the gateway clock only from a well-formed Date header', () => {
    assert.equal(
      gatewayDateMillis('Thu, 08 Oct 2026 12:00:00 GMT'),
      Date.parse('2026-10-08T12:00:00Z'),
    );
    for (const value of [
      undefined,
      '',
      ['Thu, 08 Oct 2026 12:00:00 GMT'],
      '2026-10-08T12:00:00Z',
      'Thursday, 08-Oct-26 12:00:00 GMT',
      'Thu, 08 Oct 2026 12:00:00 +0000',
    ]) {
      assert.equal(gatewayDateMillis(value), undefined, String(value));
    }
  });

  it('re-checks every stream rather than trusting the summary flags', () => {
    // Hand-built: the parser would refuse this summary, so only the verdict's own
    // per-stream check stands between a lying summary and the guarantee.
    const publicPolicy: DataPlaneEgressPolicy = {
      mode: 'public',
      mode_allowed_ip_classes: ['public'],
      mode_blocked_ip_classes: ['private-reserved'],
      dangerous_ranges_blocked: true,
      allow_cidr_overrides_present: false,
      deny_cidr_overrides_present: false,
      public_only_guaranteed: true,
    };
    const base = parseBackendEgressPolicy(attestedControlPlanePolicy([PUBLIC, PUBLIC]), 'nexus')!;
    const lying = (patch: (policy: BackendEgressPolicy) => void): BackendEgressPolicy => {
      const policy = structuredClone(base);
      patch(policy);
      return policy;
    };
    const cases: [string, BackendEgressPolicy][] = [
      [
        'a stream in both mode',
        lying((p) => {
          p.data_plane_attestation!.data_planes[1]!.policy = {
            ...publicPolicy,
            mode: 'both',
            mode_allowed_ip_classes: ['public', 'private-reserved'],
            mode_blocked_ip_classes: [],
            public_only_guaranteed: false,
          };
        }),
      ],
      [
        'a stream with an allow overlay',
        lying((p) => {
          p.data_plane_attestation!.data_planes[0]!.policy = {
            ...publicPolicy,
            allow_cidr_overrides_present: true,
          };
        }),
      ],
      [
        'a stream that did not report',
        lying((p) => {
          const plane = p.data_plane_attestation!.data_planes[0]!;
          plane.attestation = 'unknown';
          plane.policy = null;
        }),
      ],
      [
        'a stream missing from the list',
        lying((p) => {
          p.data_plane_attestation!.data_planes.pop();
        }),
      ],
      [
        'an unknown count beside a public summary',
        lying((p) => {
          p.data_plane_attestation!.unknown_data_planes = 1;
        }),
      ],
    ];
    assert.equal(dataPlaneAttestationVerdict(base, 2), 'guaranteed');
    for (const [name, policy] of cases) {
      // Every summary flag still claims the whole fleet is public-only.
      assert.equal(policy.data_plane_attestation!.all_connected_public_only_guaranteed, true);
      assert.equal(policy.data_plane_attestation!.weakest_policy_complete, true);
      assert.equal(dataPlaneAttestationVerdict(policy, 1), 'data_planes_not_public_only', name);
      assert.equal(provesPublicEgress(policy, 1), false, name);
      assert.equal(admitBackendEgress(policy, { expectedDataPlanes: 1 }), null, name);
    }
  });

  it('sets aside an attestation that is malformed or disagrees with its own streams', () => {
    const attested = attestedControlPlanePolicy([PUBLIC, PUBLIC]);
    const mixed = attestedControlPlanePolicy([PUBLIC, null]);
    const weaker = attestedControlPlanePolicy([PUBLIC, { mode: 'both' }]);
    const empty = attestedControlPlanePolicy([]);
    const outOfScope: [string, Record<string, unknown>][] = [
      ['on a local data plane', { ...publicEgressPolicy(), data_plane_attestation: {} }],
      [
        'on a local data plane, even a valid one',
        { ...publicEgressPolicy(), data_plane_attestation: attestationOf(attested) },
      ],
    ];
    const malformed: [string, Record<string, unknown>][] = [
      ['null', { ...attested, data_plane_attestation: null }],
      ['not an object', { ...attested, data_plane_attestation: [] }],
      ['an unknown key', withAttestation(attested, (a) => (a.extra = 'opaque-canary'))],
      ['a missing key', withAttestation(attested, (a) => delete a.weakest_policy_complete)],
      ['another source', withAttestation(attested, (a) => (a.source = 'cluster'))],
      ['a negative count', withAttestation(empty, (a) => (a.connected_data_planes = -1))],
      ['a fractional count', withAttestation(attested, (a) => (a.connected_data_planes = 1.5))],
      [
        'an unknown stream that carries a policy',
        withAttestation(attested, (a) => {
          (a.data_planes as Record<string, unknown>[])[0]!.attestation = 'unknown';
        }),
      ],
      [
        'a reported stream without a policy',
        withAttestation(mixed, (a) => {
          (a.data_planes as Record<string, unknown>[])[1]!.attestation = 'reported';
        }),
      ],
      [
        'an unrecognised stream status',
        withAttestation(attested, (a) => {
          (a.data_planes as Record<string, unknown>[])[0]!.attestation = 'attested';
        }),
      ],
      [
        'a stream with an unknown key',
        withAttestation(attested, (a) => {
          (a.data_planes as Record<string, unknown>[])[0]!.build = '0.9.14';
        }),
      ],
      [
        'a stream without a node id',
        withAttestation(attested, (a) => {
          (a.data_planes as Record<string, unknown>[])[0]!.node_id = '';
        }),
      ],
      [
        'a stream policy claiming a guarantee its mode denies',
        withAttestation(weaker, (a) => {
          const plane = (a.data_planes as Record<string, unknown>[])[1]!;
          (plane.policy as Record<string, unknown>).public_only_guaranteed = true;
        }),
      ],
      [
        'a stream policy with mismatched class lists',
        withAttestation(attested, (a) => {
          const plane = (a.data_planes as Record<string, unknown>[])[0]!;
          (plane.policy as Record<string, unknown>).mode_blocked_ip_classes = [];
        }),
      ],
      [
        'a stream policy in an unknown mode',
        withAttestation(attested, (a) => {
          const plane = (a.data_planes as Record<string, unknown>[])[0]!;
          (plane.policy as Record<string, unknown>).mode = 'future';
        }),
      ],
    ];
    const inconsistent: [string, Record<string, unknown>][] = [
      ['a count above the list', withAttestation(attested, (a) => (a.connected_data_planes = 3))],
      [
        'a stream missing from the list',
        withAttestation(attested, (a) => (a.data_planes as unknown[]).pop()),
      ],
      ['a wrong reporting count', withAttestation(mixed, (a) => (a.reporting_data_planes = 2))],
      ['a wrong unknown count', withAttestation(mixed, (a) => (a.unknown_data_planes = 0))],
      [
        'an aggregate claiming an unknown data plane is public-only',
        withAttestation(mixed, (a) => {
          a.weakest_policy_complete = true;
          a.all_connected_public_only_guaranteed = true;
        }),
      ],
      [
        'an aggregate flag over a weaker data plane',
        withAttestation(weaker, (a) => (a.all_connected_public_only_guaranteed = true)),
      ],
      [
        'a weakest policy stronger than its streams',
        withAttestation(weaker, (a) => {
          a.weakest_policy = attestationOf(attested).weakest_policy;
          a.all_connected_public_only_guaranteed = true;
        }),
      ],
      ['a missing weakest policy', withAttestation(attested, (a) => (a.weakest_policy = null))],
      [
        'a complete flag over an empty set',
        withAttestation(empty, (a) => (a.weakest_policy_complete = true)),
      ],
    ];
    const groups: [DataPlaneAttestationProblem, [string, Record<string, unknown>][]][] = [
      ['out_of_scope', outOfScope],
      ['malformed', malformed],
      ['inconsistent', inconsistent],
    ];
    for (const [problem, cases] of groups) {
      for (const [name, value] of cases) {
        // Not the exact owner shape, and not another schema either.
        assert.equal(parseBackendEgressPolicy(value, 'nexus'), null, name);
        assert.equal(isUnsupportedEgressPolicySchema(value), false, name);
        // The rest of the answer is still read; only the attestation is set aside.
        const reading = readBackendEgressPolicy(value, 'nexus');
        assert.ok(reading, name);
        assert.equal(reading.attestationProblem, problem, name);
        assert.equal(Object.hasOwn(reading.policy, 'data_plane_attestation'), false, name);
        const strict = assessBackendEgress(reading, { expectedDataPlanes: 1 });
        assert.equal(strict.publicEgressGuaranteed, false, name);
        assert.equal(strict.admission, null, name);
        assert.equal(strict.dataPlaneAttestation, 'attestation_unreadable', name);
        // The opt-out keeps working, still without the guarantee.
        const optedOut = assessBackendEgress(reading, {
          expectedDataPlanes: 1,
          allowPrivateUpstreams: true,
        });
        assert.equal(optedOut.publicEgressGuaranteed, false, name);
        assert.equal(optedOut.admission?.egress_profile, 'private-upstreams-opt-in', name);
      }
    }
    // A known top-level field stays strict in every profile.
    const brokenTopLevel = { ...attested, mode: 'future' };
    assert.equal(readBackendEgressPolicy(brokenTopLevel, 'nexus'), null);
  });

  it('admits a set-aside attestation through the opt-out, never as guaranteed', async (t) => {
    const warnings: Record<string, unknown>[] = [];
    const harness = await buildTestApp({
      env: { NEXUS_ALLOW_PRIVATE_UPSTREAMS: 'true', NEXUS_EXPECTED_DATA_PLANES: '1' },
      edgeLogger: {
        debug: () => undefined,
        warn: (value) => warnings.push(value),
        error: () => undefined,
      },
    });
    t.after(() => harness.close());
    // A future additive key inside an otherwise all-public attestation.
    const attested = attestedControlPlanePolicy([PUBLIC]);
    const future = withAttestation(attested, (a) => (a.future_field = 'opaque-canary'));
    harness.edge.setBackendEgressPolicy(future);
    assert.deepEqual(await harness.edgeClient.assertBackendEgress(), {
      egress_profile: 'private-upstreams-opt-in',
      enforcement_scope: 'admission-only',
    });
    const probe = await harness.edgeClient.probe();
    assert.equal(probe.publicEgressGuaranteed, false);
    assert.equal(probe.backendEgressVerified, true);
    assert.equal(probe.backendEgressSchemaUnsupported, false);
    assert.ok(warnings.some((warning) => warning.reason === 'malformed'));
    assert.ok(!JSON.stringify(warnings).includes('opaque-canary'));
  });

  it('refuses a set-aside attestation in the public profile without a protocol error', async (t) => {
    const harness = await buildTestApp({ env: { NEXUS_EXPECTED_DATA_PLANES: '1' } });
    t.after(() => harness.close());
    const attested = attestedControlPlanePolicy([PUBLIC]);
    harness.edge.setBackendEgressPolicy(
      withAttestation(attested, (a) => (a.all_connected_public_only_guaranteed = false)),
    );
    await assert.rejects(harness.edgeClient.assertBackendEgress(), (error: NexusError) => {
      assert.equal(error.code, 'EDGE_ERROR');
      assert.match(error.message, /attestation is unreadable/);
      assert.deepEqual(error.details, {
        kind: 'backend_egress_unverified',
        data_plane_attestation: 'attestation_unreadable',
      });
      return true;
    });
    const probe = await harness.edgeClient.probe();
    assert.equal(probe.publicEgressGuaranteed, false);
    assert.equal(probe.backendEgressVerified, false);
    assert.match(probe.backendEgressDetail ?? '', /attestation is unreadable/);
    // The same answer, consistent again, is guaranteed on the very next read.
    harness.edge.setBackendEgressPolicy(attested);
    assert.equal((await harness.edgeClient.probe()).publicEgressGuaranteed, true);
  });

  it('re-reads the attestation for every write and health probe, with no grace', async (t) => {
    const harness = await buildTestApp({ env: { NEXUS_EXPECTED_DATA_PLANES: '2' } });
    t.after(() => harness.close());
    const edge = harness.edgeClient;
    harness.edge.setBackendEgressPolicy(attestedControlPlanePolicy([PUBLIC, PUBLIC]));
    assert.deepEqual(await edge.assertBackendEgress(), {
      egress_profile: 'public-guaranteed',
      enforcement_scope: 'admission-only',
    });
    const probe = await edge.probe();
    assert.equal(probe.publicEgressGuaranteed, true);
    assert.equal(probe.backendEgressVerified, true);

    // A data plane that connects without a report, or with a weaker policy, ends
    // the guarantee on the very next read; so does the last one disconnecting.
    const unproven: (DataPlaneReport | null)[][] = [[PUBLIC, null], [PUBLIC, { mode: 'both' }], []];
    for (const reports of unproven) {
      harness.edge.setBackendEgressPolicy(attestedControlPlanePolicy(reports));
      await assert.rejects(edge.assertBackendEgress(), /not every connected data plane attests/);
      const degraded = await edge.probe();
      assert.equal(degraded.publicEgressGuaranteed, false);
      assert.equal(degraded.backendEgressVerified, false);
    }
    // And it is restored as soon as every connected data plane attests again.
    harness.edge.setBackendEgressPolicy(attestedControlPlanePolicy([PUBLIC, PUBLIC]));
    await edge.assertBackendEgress();
    assert.equal((await edge.probe()).publicEgressGuaranteed, true);
  });

  it('reads a large data-plane fleet within the response bound', async (t) => {
    // Edge's default FERRUM_XDS_MAX_TOTAL_STREAMS.
    const harness = await buildTestApp({ env: { NEXUS_EXPECTED_DATA_PLANES: '8192' } });
    t.after(() => harness.close());
    const fleet = attestedControlPlanePolicy(Array.from({ length: 8_192 }, () => PUBLIC));
    assert.ok(JSON.stringify(fleet).length < EGRESS_POLICY_MAX_BYTES);
    // The expected count is met by distinct node_ids, not by stream entries alone.
    const entries = attestationOf(fleet).data_planes as { node_id: string }[];
    assert.equal(new Set(entries.map((entry) => entry.node_id)).size, 8_192);
    harness.edge.setBackendEgressPolicy(fleet);
    assert.deepEqual(await harness.edgeClient.assertBackendEgress(), {
      egress_profile: 'public-guaranteed',
      enforcement_scope: 'admission-only',
    });
  });

  it('publishes on an attested control plane and records how it was admitted', async (t) => {
    const harness = await buildTestApp({ env: { NEXUS_EXPECTED_DATA_PLANES: '2' } });
    t.after(() => harness.close());
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

    harness.edge.setBackendEgressPolicy(attestedControlPlanePolicy([PUBLIC, null]));
    const refused = await harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: payload('partially-attested'),
    });
    assert.notEqual(refused.statusCode, 201, refused.body);
    assert.equal(harness.edge.proxies.size, 0, 'nothing reached the gateway');

    harness.edge.setBackendEgressPolicy(attestedControlPlanePolicy([PUBLIC, PUBLIC]));
    const published = await harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: payload('attested'),
    });
    assert.equal(published.statusCode, 201, published.body);
    const apiId = published.json<PublishApiResponse>().api.id;
    const row = (await harness.auditRows('api.publish')).find((entry) => entry.target_id === apiId);
    assert.equal(row?.details.egress_profile, 'public-guaranteed');
    assert.equal(row?.details.enforcement_scope, 'admission-only');
  });
});
