/**
 * `GET /api/catalog/:slug/spec` — the normalized-document cache and the
 * per-account rate limit that bound its cost (issue #343).
 *
 * The cache suites compose their own catalog service over the harness store,
 * so they can hand it a cache whose counters they read; the HTTP assertions go
 * through the real route. The limiter is forced off under `NEXUS_ENV=test`, so
 * its suite boots a `development` app with `NEXUS_RATE_LIMIT_ENABLED=true`.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { parse as parseYaml } from 'yaml';

import type { ApiErrorBody, CatalogSpecResponse, PublishApiResponse } from '@ferrum-nexus/shared';

import {
  createCatalogService,
  type CatalogService,
  type CatalogSpecRendering,
} from '../catalog/service.js';
import type { UserRecord } from '../db/store.js';
import { isNexusError } from '../lib/errors.js';
import { LruCache } from '../lib/lru-cache.js';
import { CATALOG_SPEC_RATE_LIMIT } from '../routes/catalog.js';
import { SAMPLE_SPEC_YAML, buildTestApp, type TestApp, type TestSession } from './helpers.js';

async function publish(
  harness: TestApp,
  owner: TestSession,
  slug: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const response = await harness.authed(owner, {
    method: 'POST',
    url: '/api/apis',
    payload: {
      name: `API ${slug}`,
      slug,
      spec: SAMPLE_SPEC_YAML,
      auth_plugin: 'key_auth',
      requestable: true,
      visibility: 'public',
      ...overrides,
    },
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json<PublishApiResponse>().api.id;
}

function serversOf(body: CatalogSpecResponse): unknown {
  return (parseYaml(body.raw_spec) as { servers?: unknown }).servers;
}

describe('catalog spec cache', () => {
  let harness: TestApp;
  let provider: TestSession;
  let client: TestSession;
  let owner: UserRecord;
  let outsider: UserRecord;
  let publicId: string;
  let gatewayUrl: string | null;
  let cache: LruCache<CatalogSpecRendering>;
  let catalog: CatalogService;

  before(async () => {
    harness = await buildTestApp({
      env: { FERRUM_GATEWAY_PUBLIC_URL: 'https://gateway.example.test' },
    });
    await harness.registerUser({ email: 'spec-cache-founder@example.test' });
    provider = await harness.registerUser({
      email: 'spec-cache-provider@example.test',
      role: 'provider',
    });
    client = await harness.registerUser({
      email: 'spec-cache-client@example.test',
      role: 'client',
    });
    publicId = await publish(harness, provider, 'spec-cache-public');
    await publish(harness, provider, 'spec-cache-private', { visibility: 'private' });

    const ownerRecord = await harness.store.users.findById(provider.user.id);
    const outsiderRecord = await harness.store.users.findById(client.user.id);
    assert.ok(ownerRecord && outsiderRecord);
    owner = ownerRecord;
    outsider = outsiderRecord;
  });

  after(async () => {
    await harness.close();
  });

  /** A fresh service and cache, reading its gateway origin from `gatewayUrl`. */
  function fresh(): void {
    gatewayUrl = 'https://gateway.example.test';
    cache = new LruCache<CatalogSpecRendering>({ maxEntries: 16, maxBytes: 1024 * 1024 });
    catalog = createCatalogService({
      store: harness.store,
      settings: { getGatewayPublicUrl: async () => gatewayUrl },
      specCache: cache,
    });
  }

  it('parses a revision once and serves the same document from the cache', async () => {
    fresh();
    const first = await catalog.spec(outsider, 'spec-cache-public');
    const filled = cache.stats();
    assert.equal(filled.misses, 1);
    assert.equal(filled.hits, 0);
    assert.equal(filled.entries, 1);
    assert.ok(filled.bytes > first.raw_spec.length, 'the entry is sized by its document');

    const second = await catalog.spec(owner, 'spec-cache-public');
    assert.deepEqual(second, first, 'every authorized viewer gets the identical response');
    assert.equal(cache.stats().hits, 1);
    assert.equal(cache.stats().misses, 1);
  });

  it('never consults the cache for a caller who may not open the API', async () => {
    fresh();
    // The owner fills the entry for the private API…
    const document = await catalog.spec(owner, 'spec-cache-private');
    assert.deepEqual(serversOf(document), [
      { url: 'https://gateway.example.test/nexus/spec-cache-private' },
    ]);
    const filled = cache.stats();
    assert.equal(filled.entries, 1);

    // …and an unauthorized account is refused before the cache is reached:
    // no hit, no miss, and the same `404` an uncached read answers.
    await assert.rejects(
      () => catalog.spec(outsider, 'spec-cache-private'),
      (error: unknown) => isNexusError(error) && error.code === 'NOT_FOUND',
    );
    assert.deepEqual(cache.stats(), filled);

    // Through the real route as well.
    const denied = await harness.authed(client, {
      method: 'GET',
      url: '/api/catalog/spec-cache-private/spec',
    });
    assert.equal(denied.statusCode, 404, denied.body);
    assert.equal((JSON.parse(denied.body) as ApiErrorBody).error.code, 'NOT_FOUND');
    assert.ok(!denied.body.includes('Billing API'));
    const allowed = await harness.authed(provider, {
      method: 'GET',
      url: '/api/catalog/spec-cache-private/spec',
    });
    assert.equal(allowed.statusCode, 200, allowed.body);
  });

  it('misses when the gateway origin changes, and serves the new address', async () => {
    fresh();
    const before = await catalog.spec(outsider, 'spec-cache-public');
    assert.deepEqual(serversOf(before), [
      { url: 'https://gateway.example.test/nexus/spec-cache-public' },
    ]);

    gatewayUrl = 'https://edge.example.test';
    const moved = await catalog.spec(outsider, 'spec-cache-public');
    assert.deepEqual(serversOf(moved), [
      { url: 'https://edge.example.test/nexus/spec-cache-public' },
    ]);
    gatewayUrl = null;
    const relative = await catalog.spec(outsider, 'spec-cache-public');
    assert.deepEqual(serversOf(relative), [{ url: '/nexus/spec-cache-public' }]);
    assert.equal(cache.stats().misses, 3, 'each address is its own entry');
    assert.equal(cache.stats().hits, 0);

    gatewayUrl = 'https://gateway.example.test';
    assert.deepEqual(await catalog.spec(outsider, 'spec-cache-public'), before);
    assert.equal(cache.stats().hits, 1, 'the original address is still cached');
  });

  it('serves a new revision as soon as it is current', async () => {
    fresh();
    const original = await catalog.spec(outsider, 'spec-cache-public');
    assert.equal(original.parsed_title, 'Billing API');

    const replaced = await harness.authed(provider, {
      method: 'PUT',
      url: `/api/apis/${publicId}/spec`,
      payload: { spec: SAMPLE_SPEC_YAML.replace('title: Billing API', 'title: Billing API Next') },
    });
    assert.equal(replaced.statusCode, 200, replaced.body);

    const next = await catalog.spec(outsider, 'spec-cache-public');
    assert.equal(next.parsed_title, 'Billing API Next');
    const document = parseYaml(next.raw_spec) as { info: { title: string } };
    assert.equal(document.info.title, 'Billing API Next');
    assert.equal(cache.stats().misses, 2, 'a new revision is a new key');
  });

  it('remembers a document the parser refused without serving anything from it', async (t) => {
    fresh();
    const api = await harness.store.apis.findBySlug('spec-cache-public');
    assert.ok(api);
    const record = await harness.store.apiSpecs.findCurrentByApi(api.id);
    assert.ok(record);
    // A different revision id: revisions are immutable, so a corrupt document
    // is always a row of its own.
    t.mock.method(harness.store.apiSpecs, 'findCurrentByApi', async () => ({
      ...record,
      id: '00000000-0000-4000-8000-00000000c0de',
      raw_spec: '{"servers": [{"url": "https://origin.example.test"}],',
    }));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(
        () => catalog.spec(outsider, 'spec-cache-public'),
        (error: unknown) => isNexusError(error) && error.code === 'SPEC_INVALID',
      );
    }
    assert.equal(cache.stats().misses, 1);
    assert.equal(cache.stats().hits, 1, 'the refusal is cached, not re-parsed');
  });

  it('keeps the entries it holds within the configured bounds', async () => {
    gatewayUrl = 'https://gateway.example.test';
    cache = new LruCache<CatalogSpecRendering>({ maxEntries: 1, maxBytes: 1024 * 1024 });
    catalog = createCatalogService({
      store: harness.store,
      settings: { getGatewayPublicUrl: async () => gatewayUrl },
      specCache: cache,
    });
    await catalog.spec(owner, 'spec-cache-public');
    await catalog.spec(owner, 'spec-cache-private');
    assert.equal(cache.stats().entries, 1);
    await catalog.spec(owner, 'spec-cache-public');
    assert.equal(cache.stats().misses, 3, 'the evicted document is parsed again');
  });
});

describe('catalog spec rate limit', () => {
  let harness: TestApp;
  let alice: TestSession;
  let bob: TestSession;

  before(async () => {
    harness = await buildTestApp({
      env: { NEXUS_ENV: 'development', NEXUS_RATE_LIMIT_ENABLED: 'true' },
      deps: { startOutboxWorker: false },
    });
    await harness.registerUser({ email: 'spec-limit-founder@example.test' });
    const provider = await harness.registerUser({
      email: 'spec-limit-provider@example.test',
      role: 'provider',
    });
    alice = await harness.registerUser({ email: 'spec-limit-alice@example.test', role: 'client' });
    bob = await harness.registerUser({ email: 'spec-limit-bob@example.test', role: 'client' });
    await publish(harness, provider, 'spec-limit');
  });

  after(async () => {
    await harness.close();
  });

  it('caps spec reads per account, and gives a second account its own bucket', async () => {
    const statuses: number[] = [];
    let refusal = '';
    for (let attempt = 0; attempt <= CATALOG_SPEC_RATE_LIMIT.max; attempt += 1) {
      const response = await harness.authed(alice, {
        method: 'GET',
        url: '/api/catalog/spec-limit/spec',
      });
      statuses.push(response.statusCode);
      if (response.statusCode === 429) refusal = response.body;
    }
    assert.equal(statuses.filter((status) => status === 200).length, CATALOG_SPEC_RATE_LIMIT.max);
    assert.equal(statuses.filter((status) => status === 429).length, 1);
    assert.equal((JSON.parse(refusal) as ApiErrorBody).error.code, 'RATE_LIMITED');

    const other = await harness.authed(bob, {
      method: 'GET',
      url: '/api/catalog/spec-limit/spec',
    });
    assert.equal(other.statusCode, 200, other.body);

    // Only the spec route is limited: the rest of the catalog is not.
    const detail = await harness.authed(alice, { method: 'GET', url: '/api/catalog/spec-limit' });
    assert.equal(detail.statusCode, 200, detail.body);
  });
});
