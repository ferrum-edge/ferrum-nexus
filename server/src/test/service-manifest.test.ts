import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, it } from 'node:test';
import { validatedManifest } from '../service-manifest/service.js';
import { manifestValidator } from '../service-manifest/schema.js';
import { buildTestApp } from './helpers.js';

const CHECKSUM_LINE = /^([a-f0-9]{64})  (.+)$/;
const MANIFEST_FILE = /service-manifest\/|^fixtures\/invalid-expectations\.json$/;

const CLEARTEXT_REFUSED = /must use https unless its host is a loopback IP literal/;
const RESOURCE_REFERENCE = /resource reference exceeds the limit/;

const root = new URL('../../../contracts/ferrum-contracts/', import.meta.url);
function fixture(path: string): unknown {
  return JSON.parse(readFileSync(new URL(path, root), 'utf8'));
}

type Manifest = Record<string, Record<string, unknown>>;

/** `valid/orders-api.json`, whose exporter is `https://` since `contracts-edge-0.9.21`. */
function ordersApi(): Manifest {
  return fixture('fixtures/service-manifest/valid/orders-api.json') as Manifest;
}

describe('published immutable service-manifest consumer', () => {
  // The manifest files are rows of the one vendored `PIN` (ferrum-contracts
  // `docs/consumer-pins.md`), selected by path. `shared/src/ferrum-contracts.test.ts`
  // parses that file strictly and checks it against the whole vendored tree.
  it('verifies the exact commit, schema, shared fixtures and invalid-expectation integrity pins', () => {
    const pin = readFileSync(new URL('PIN', root), 'utf8');
    assert.deepEqual(pin.split('\n').slice(0, 2), [
      'tag contracts-edge-0.9.21',
      'commit 92d8da5be93ea1ece9f47729b1f7aa10ae8a7c3f',
    ]);
    const schema = fixture('schemas/service-manifest/v1.schema.json') as {
      'x-contract': { status: string; provenance: { commit: string; availability?: string }[] };
    };
    assert.equal(schema['x-contract'].status, 'implemented');
    assert.equal(
      schema['x-contract'].provenance[0]?.commit,
      '81cbb410d34ff5fba1f3d54cfd2e7ebccaed397e',
    );
    assert.equal(schema['x-contract'].provenance[0]?.availability, 'unreleased');
    const manifestRows = pin
      .split('\n')
      .map((line) => CHECKSUM_LINE.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .filter(([, , path]) => MANIFEST_FILE.test(path ?? ''));
    // The schema, the shared invalid expectations, and 5 valid and 27 invalid
    // fixtures (contracts-edge-0.9.21 added `edge-limits.json`,
    // `unicode-host.json` and 18 invalid fixtures for Edge's field limits,
    // control characters, reserved path characters and cleartext telemetry).
    assert.equal(manifestRows.length, 34);
    for (const [, digest, path] of manifestRows) {
      assert.ok(path);
      assert.equal(
        createHash('sha256')
          .update(readFileSync(new URL(path, root)))
          .digest('hex'),
        digest,
      );
    }
  });

  it('accepts every shared valid fixture and rejects every shared invalid fixture', () => {
    const expectations = fixture('fixtures/invalid-expectations.json') as Record<string, unknown>;
    const pin = readFileSync(new URL('PIN', root), 'utf8');
    for (const kind of ['valid', 'invalid']) {
      const base = `fixtures/service-manifest/${kind}/`;
      for (const name of readdirSync(new URL(base, root))) {
        assert.ok(pin.includes(`  ${base}${name}\n`), 'every shared fixture must be pinned');
        const value = fixture(base + name);
        assert.equal(manifestValidator.safeParse(value).success, kind === 'valid', name);
        if (kind === 'valid') assert.doesNotThrow(() => validatedManifest(value), name);
        else {
          assert.ok(expectations[`service-manifest/invalid/${name}`], name);
          assert.throws(() => validatedManifest(value), name);
        }
      }
    }
  });

  it('rejects explicit nulls, unknown nested keys, unsupported schemas/protocols and unbounded references', () => {
    const original = ordersApi();
    assert.doesNotThrow(() => validatedManifest(original));
    for (const [key, value] of Object.entries(original)) {
      assert.throws(() => validatedManifest({ ...original, [key]: null }));
      if (value && typeof value === 'object') {
        for (const field of Object.keys(value)) {
          assert.throws(() =>
            validatedManifest({ ...original, [key]: { ...value, [field]: null } }),
          );
        }
        assert.throws(() => validatedManifest({ ...original, [key]: { ...value, unknown: true } }));
      }
    }
    for (const patch of [
      { schema: 'other' },
      { schema_version: '2.0' },
      { method: 'POST' },
      { additionalFields: true },
      { agents: { endpoint_path: '/orders-sibling/mcp' } },
      { upstream: { ...original.upstream, protocols: ['http3'] } },
      { api: { ...original.api, openapi: 'x'.repeat(2049) } },
      { gateway: { namespace: 'nexus', otel_endpoint: 'https://otel.test/?token=secret' } },
    ]) {
      assert.throws(() => validatedManifest({ ...original, ...patch }));
    }
    let deep: unknown = {};
    for (let i = 0; i < 10; i += 1) deep = { nested: deep };
    assert.throws(() => validatedManifest(deep));
  });

  it('admits cleartext telemetry only to a canonical loopback IP literal, as Ferrum Edge does', () => {
    const original = ordersApi();
    const withEndpoint = (otel_endpoint: string): Manifest => ({
      ...original,
      gateway: { ...original.gateway, otel_endpoint },
    });
    for (const accepted of [
      'https://otel-collector:4318/v1/traces',
      'https://otel.example.com/v1/traces',
      'http://127.0.0.1:4318/v1/traces',
      'http://127.10.20.30/v1/traces',
      'http://[::1]:4318/v1/traces',
      'http://[::1]',
      // Edge trims the configured endpoint (Unicode White_Space) first.
      'http://127.0.0.1:4318 ',
      'http://127.0.0.1:4318\u00a0',
      'http://127.0.0.1:4318\u0085',
    ]) {
      assert.doesNotThrow(() => validatedManifest(withEndpoint(accepted)), accepted);
    }
    for (const refused of [
      'http://otel-collector:4318/v1/traces',
      'http://localhost:4318/v1/traces',
      'http://otel.localhost:4318/v1/traces',
      'http://127.1:4318/v1/traces',
      'http://[0:0:0:0:0:0:0:1]:4318/v1/traces',
      'http://10.0.0.5:4318/v1/traces',
      'http://[::2]:4318/v1/traces',
      'http://128.0.0.1:4318/v1/traces',
      // Not White_Space, so Edge keeps it in the written authority.
      'http://127.0.0.1\ufeff',
    ]) {
      assert.throws(() => validatedManifest(withEndpoint(refused)), CLEARTEXT_REFUSED, refused);
    }
    // The pinned schema pattern runs first: `.` stops at a line terminator, so
    // a separator after a path is refused before Edge's trim could apply.
    for (const separator of ['\u2028', '\u2029']) {
      const endpoint = `http://127.0.0.1:4318/v1/traces${separator}`;
      assert.equal(manifestValidator.safeParse(withEndpoint(endpoint)).success, false);
      assert.throws(() => validatedManifest(withEndpoint(endpoint)));
    }
  });

  it('bounds the tracing resource ID Alloy derives for every export, with or without an exporter', () => {
    // plain-http.json with no exporter, no health check and correlation off:
    // Alloy still writes `<proxy_id>-otel-tracing` (13 characters), and Edge
    // caps resource IDs at 254, so a 241-character proxy ID is the longest.
    const plain = fixture('fixtures/service-manifest/valid/plain-http.json') as Manifest;
    const {
      otel_endpoint: _endpoint,
      otel_root_sampling_ratio: _ratio,
      ...gateway
    } = plain.gateway ?? {};
    const bare: Manifest = { ...plain, gateway: { ...gateway, correlation_id: false } };
    assert.equal('health' in bare, false);
    const withId = (proxy_id: string): Manifest => ({
      ...bare,
      gateway: { ...bare.gateway, proxy_id },
    });
    for (const length of [8, 241]) {
      assert.doesNotThrow(() => validatedManifest(withId('p'.repeat(length))), String(length));
    }
    assert.throws(() => validatedManifest(withId('p'.repeat(242))), RESOURCE_REFERENCE);
    // With an exporter the bound is the same.
    const exporting = (proxy_id: string): Manifest => ({
      ...bare,
      gateway: { ...bare.gateway, proxy_id, otel_endpoint: 'http://127.0.0.1:4318/v1/traces' },
    });
    assert.doesNotThrow(() => validatedManifest(exporting('p'.repeat(241))));
    assert.throws(() => validatedManifest(exporting('p'.repeat(242))), RESOURCE_REFERENCE);
    // Correlation's `-correlation-id` (15) is the longest suffix when enabled.
    const correlated = (proxy_id: string): Manifest => ({
      ...bare,
      gateway: { ...bare.gateway, proxy_id, correlation_id: true },
    });
    assert.doesNotThrow(() => validatedManifest(correlated('p'.repeat(239))));
    assert.throws(() => validatedManifest(correlated('p'.repeat(240))), RESOURCE_REFERENCE);
    // A defaulted proxy ID is service.name, which the schema caps at 63
    // characters, so it always fits.
    const { proxy_id: _proxyId, ...unnamed } = bare.gateway ?? {};
    const defaulted: Manifest = {
      ...bare,
      service: { ...bare.service, name: `a${'b'.repeat(62)}` },
      gateway: unnamed,
    };
    assert.doesNotThrow(() => validatedManifest(defaulted));
    assert.throws(() =>
      validatedManifest({ ...defaulted, service: { name: `a${'b'.repeat(63)}` } }),
    );
  });

  it("enforces the pinned schema's Ferrum Edge bounds on exported fields, service_base_path's 2049 included", () => {
    const original = ordersApi();
    const patched = (section: string, field: string, value: unknown): Manifest => ({
      ...original,
      [section]: { ...(original[section] ?? {}), [field]: value },
    });
    const health = { path: '/healthz', interval_seconds: 10, timeout_ms: 2000 };
    const withHealth = (field: string, value: unknown): Manifest => ({
      ...original,
      health: { ...health, [field]: value },
    });
    const cases: [string, Manifest, Manifest][] = [
      [
        'api.public_path (500)',
        patched('api', 'public_path', `/${'o'.repeat(499)}`),
        patched('api', 'public_path', `/${'o'.repeat(500)}`),
      ],
      [
        'api.service_base_path (2049 with the trailing /)',
        patched('api', 'service_base_path', `/${'b'.repeat(2047)}/`),
        patched('api', 'service_base_path', `/${'b'.repeat(2048)}/`),
      ],
      [
        'upstream.host (255)',
        patched('upstream', 'host', `${'h'.repeat(251)}.net`),
        patched('upstream', 'host', `${'h'.repeat(252)}.net`),
      ],
      [
        'health.path (2048)',
        withHealth('path', `/${'r'.repeat(2047)}`),
        withHealth('path', `/${'r'.repeat(2048)}`),
      ],
      [
        'health.interval_seconds (3600)',
        withHealth('interval_seconds', 3600),
        withHealth('interval_seconds', 3601),
      ],
      [
        'health.timeout_ms (86400000)',
        withHealth('timeout_ms', 86_400_000),
        withHealth('timeout_ms', 86_400_001),
      ],
      ...(['connect_ms', 'read_ms', 'write_ms'] as const).map(
        (field): [string, Manifest, Manifest] => [
          `timeouts.${field} (86400000)`,
          patched('timeouts', field, 86_400_000),
          patched('timeouts', field, 86_400_001),
        ],
      ),
    ];
    for (const [label, atLimit, overLimit] of cases) {
      assert.doesNotThrow(() => validatedManifest(atLimit), label);
      assert.equal(manifestValidator.safeParse(overLimit).success, false, label);
      assert.throws(() => validatedManifest(overLimit), label);
    }
    // Control characters stay refused in every string, the host included.
    assert.throws(() => validatedManifest(patched('upstream', 'host', 'orders\u0001.internal')));
    // Characters, not UTF-16 code units, are what a length counts.
    assert.doesNotThrow(() =>
      validatedManifest(patched('api', 'public_path', `/${'\u{1F600}'.repeat(499)}`)),
    );
  });

  it('requires a session, provider role, CSRF and the configured namespace; returns only redacted preview data', async () => {
    const harness = await buildTestApp();
    try {
      await harness.registerUser();
      const provider = await harness.registerUser({ role: 'provider' });
      const client = await harness.registerUser({ role: 'client' });
      const manifest = ordersApi();
      manifest.gateway = { ...manifest.gateway, namespace: 'nexus' };
      const payload = { namespace: 'nexus', manifest };
      const before = harness.edge.requests.length;
      const url = '/api/service-manifests/preview';
      assert.equal((await harness.app.inject({ method: 'POST', url, payload })).statusCode, 401);
      assert.equal(
        (await harness.authed(client, { method: 'POST', url, payload })).statusCode,
        403,
      );
      assert.equal(
        (
          await harness.app.inject({
            method: 'POST',
            url,
            payload,
            headers: { cookie: provider.cookieHeader },
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await harness.authed(provider, {
            method: 'POST',
            url,
            payload: { ...payload, namespace: 'foreign' },
          })
        ).statusCode,
        403,
      );
      const response = await harness.authed(provider, { method: 'POST', url, payload });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().preview_only, true);
      assert.equal(response.json().contract_status, 'implemented');
      assert.equal(response.json().contract_commit, '92d8da5be93ea1ece9f47729b1f7aa10ae8a7c3f');
      assert.equal(response.json().references.values, '[REDACTED]');
      for (const secret of [
        'edge-client',
        'alloy-ca',
        'orders.internal',
        'otel-collector',
        'openapi.json',
        'Orders service built',
      ]) {
        assert.equal(response.body.includes(secret), false, secret);
      }
      assert.ok(Buffer.byteLength(response.body) < 16 * 1024);
      assert.equal(harness.edge.requests.length, before, 'preview never contacts Edge');
      const oversized = await harness.authed(provider, {
        method: 'POST',
        url,
        payload: { ...payload, padding: 'x'.repeat(33 * 1024) },
      });
      assert.equal(oversized.statusCode, 400, oversized.body);
      assert.deepEqual(oversized.json(), {
        error: { code: 'VALIDATION_FAILED', message: 'Request body is too large' },
      });
      assert.equal(harness.edge.requests.length, before, 'oversized preview never contacts Edge');
      for (const suffix of ['apply', 'publish', 'diagnostics']) {
        assert.equal(
          (
            await harness.authed(provider, {
              method: 'POST',
              url: `/api/service-manifests/${suffix}`,
              payload,
            })
          ).statusCode,
          404,
        );
      }
    } finally {
      await harness.close();
    }
  });
});
