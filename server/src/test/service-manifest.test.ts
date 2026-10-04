import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, it } from 'node:test';
import { validatedManifest } from '../service-manifest/service.js';
import { manifestValidator } from '../service-manifest/schema.js';
import { buildTestApp } from './helpers.js';

const root = new URL('../../../contracts/ferrum-contracts/', import.meta.url);
function fixture(path: string): unknown {
  return JSON.parse(readFileSync(new URL(path, root), 'utf8'));
}

describe('proposed immutable service-manifest consumer', () => {
  it('verifies the exact commit, schema, shared fixtures and invalid-expectation integrity pins', () => {
    const pin = readFileSync(new URL('SERVICE-MANIFEST-PIN', root), 'utf8');
    assert.match(pin, /commit: 591c73a3f965fdab440c3a76b2707accdf491ba5/);
    for (const line of pin.split('\n').filter((entry) => entry.startsWith('sha256: '))) {
      const [, digest, path] = /^sha256: ([a-f0-9]{64})  (.+)$/.exec(line) ?? [];
      assert.ok(path);
      assert.equal(
        createHash('sha256').update(readFileSync(new URL(path, root))).digest('hex'),
        digest,
      );
    }
  });

  it('accepts every shared valid fixture and rejects every shared invalid fixture', () => {
    const expectations = fixture('fixtures/invalid-expectations.json') as Record<string, unknown>;
    const pin = readFileSync(new URL('SERVICE-MANIFEST-PIN', root), 'utf8');
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
    const original = fixture('fixtures/service-manifest/valid/orders-api.json') as Record<
      string,
      Record<string, unknown>
    >;
    for (const [key, value] of Object.entries(original)) {
      assert.throws(() => validatedManifest({ ...original, [key]: null }));
      if (value && typeof value === 'object') {
        for (const field of Object.keys(value)) {
          assert.throws(() => validatedManifest({ ...original, [key]: { ...value, [field]: null } }));
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

  it('requires a session, provider role, CSRF and the configured namespace; returns only redacted preview data', async () => {
    const harness = await buildTestApp();
    try {
      await harness.registerUser();
      const provider = await harness.registerUser({ role: 'provider' });
      const client = await harness.registerUser({ role: 'client' });
      const manifest = fixture('fixtures/service-manifest/valid/orders-api.json') as Record<
        string,
        unknown
      >;
      manifest.gateway = { ...(manifest.gateway as Record<string, unknown>), namespace: 'nexus' };
      const payload = { namespace: 'nexus', manifest };
      const before = harness.edge.requests.length;
      const url = '/api/service-manifests/preview';
      assert.equal((await harness.app.inject({ method: 'POST', url, payload })).statusCode, 401);
      assert.equal((await harness.authed(client, { method: 'POST', url, payload })).statusCode, 403);
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
      assert.equal(response.json().contract_status, 'proposed');
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
      assert.equal(oversized.statusCode, 413, oversized.body);
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
