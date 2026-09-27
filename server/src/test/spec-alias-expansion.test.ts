/**
 * An OpenAPI document is bounded by what its YAML aliases resolve to, not only
 * by its upload size (issue #421).
 *
 * `MAX_SPEC_BYTES` bounds the text a provider sends, but a YAML alias repeats
 * its anchor at every use and the parsed document does not remember that it was
 * an alias: one large anchored scalar named a hundred times re-serializes as a
 * hundred copies. Publishing refuses such a document, and the catalog refuses
 * to render a stored revision that was accepted before the limit existed.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  MAX_SPEC_BYTES,
  MAX_SPEC_EXPANDED_BYTES,
  type ApiErrorBody,
  type PublishApiResponse,
} from '@ferrum-nexus/shared';

import {
  createCatalogService,
  type CatalogService,
  type CatalogSpecRendering,
} from '../catalog/service.js';
import type { UserRecord } from '../db/store.js';
import { isNexusError, type NexusError } from '../lib/errors.js';
import { LruCache } from '../lib/lru-cache.js';
import { parseOpenApiSpec, parseUploadedOpenApiSpec } from '../publishing/oas.js';
import { SAMPLE_SPEC_YAML, buildTestApp, type TestApp, type TestSession } from './helpers.js';

/** Size of the anchored scalar the alias fixtures repeat. */
const ANCHOR_BYTES = 64 * 1024;

/**
 * {@link SAMPLE_SPEC_YAML} plus one {@link ANCHOR_BYTES} anchor named `aliases`
 * times — as a bare scalar, or inside a mapping so the repeated occurrence is
 * an already-walked object rather than a string.
 */
function aliasedSpec(aliases: number, shape: 'scalar' | 'mapping' = 'scalar'): string {
  const anchor =
    shape === 'scalar'
      ? [`x-anchor: &big ${'x'.repeat(ANCHOR_BYTES)}`]
      : ['x-anchor: &big', `  text: ${'x'.repeat(ANCHOR_BYTES)}`];
  return [
    SAMPLE_SPEC_YAML.trimEnd(),
    ...anchor,
    'x-copies:',
    ...Array.from({ length: aliases }, () => '  - *big'),
    '',
  ].join('\n');
}

/** Enough aliases of the anchor to resolve past the limit, within yaml's own alias count. */
const OVER_LIMIT_ALIASES = Math.ceil(MAX_SPEC_EXPANDED_BYTES / ANCHOR_BYTES) + 4;

function expectSpecInvalid(fn: () => unknown, details: unknown): NexusError {
  try {
    fn();
  } catch (error) {
    assert.ok(isNexusError(error), `expected a NexusError, got ${String(error)}`);
    assert.equal(error.code, 'SPEC_INVALID');
    assert.deepEqual(error.details, details);
    return error;
  }
  assert.fail('expected SPEC_INVALID');
}

function expectExpandedTooLarge(fn: () => unknown): NexusError {
  return expectSpecInvalid(fn, { reason: 'expanded_too_large', limit: MAX_SPEC_EXPANDED_BYTES });
}

/** {@link SAMPLE_SPEC_YAML} under a `%YAML 1.1` directive, followed by `extra` lines. */
function yaml11Spec(extra: string[]): string {
  return ['%YAML 1.1', '---', SAMPLE_SPEC_YAML.trimEnd(), ...extra, ''].join('\n');
}

/**
 * Minified JSON within `MAX_SPEC_BYTES` whose keys and scalars are well inside
 * the resolved-text limit, but whose pretty-printed form — one indented line
 * per array element — is not.
 */
function minifiedFillerSpec(): string {
  return JSON.stringify({
    openapi: '3.1.0',
    info: { title: 'Filler', version: '1' },
    paths: {},
    'x-filler': new Array<number>(700_000).fill(0),
  });
}

describe('resolved OpenAPI document size', () => {
  it('refuses a YAML document whose aliases resolve past the limit', () => {
    for (const shape of ['scalar', 'mapping'] as const) {
      const spec = aliasedSpec(OVER_LIMIT_ALIASES, shape);
      assert.ok(Buffer.byteLength(spec) < MAX_SPEC_BYTES, 'the upload itself is within limits');
      expectExpandedTooLarge(() => parseOpenApiSpec(spec));
    }
  });

  it('accepts aliases whose resolved text stays within the limit', () => {
    const fits = Math.floor(MAX_SPEC_EXPANDED_BYTES / ANCHOR_BYTES / 2);
    for (const shape of ['scalar', 'mapping'] as const) {
      const parsed = parseOpenApiSpec(aliasedSpec(fits, shape));
      assert.equal((parsed.document['x-copies'] as unknown[]).length, fits);
    }

    const small = [
      SAMPLE_SPEC_YAML.trimEnd(),
      'x-shared: &shared { description: Reused, type: string }',
      'x-uses:',
      ...Array.from({ length: 50 }, () => '  - *shared'),
      '',
    ].join('\n');
    const parsed = parseOpenApiSpec(small);
    assert.deepEqual((parsed.document['x-uses'] as unknown[])[49], {
      description: 'Reused',
      type: 'string',
    });
  });

  it('counts JSON the same way, which cannot alias and so stays within it', () => {
    const json = JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Large JSON', version: '1' },
      paths: {},
      'x-text': 'y'.repeat(MAX_SPEC_BYTES - 1024),
    });
    assert.equal(parseOpenApiSpec(json).contentType, 'application/json');
  });

  it('refuses deeply nested JSON whose indentation exceeds the limit during parsing', () => {
    const scalarCount = 1_000_000;
    const deepArray = '['.repeat(198) + '[' + '0,'.repeat(scalarCount - 1) + '0' + ']'.repeat(199);
    const minified =
      '{"openapi":"3.1.0","info":{"title":"Deep","version":"1"},' +
      `"paths":{},"x-deep":${deepArray}}`;
    assert.ok(Buffer.byteLength(minified) < MAX_SPEC_BYTES);
    expectExpandedTooLarge(() => parseOpenApiSpec(minified));
  });

  it('counts newlines in a deeply nested YAML string as indentation items', () => {
    const nested = '['.repeat(195) + JSON.stringify('\n'.repeat(12_000)) + ']'.repeat(195);
    const spec = [SAMPLE_SPEC_YAML.trimEnd(), `x-deep: ${nested}`, ''].join('\n');
    assert.ok(Buffer.byteLength(spec) < MAX_SPEC_BYTES);
    expectExpandedTooLarge(() => parseOpenApiSpec(spec));
  });
});

describe('YAML read as plain data whatever its directive', () => {
  it('reads !!omap under %YAML 1.1 as a sequence, so its aliases are counted', () => {
    const omap = (entries: number): string[] => [
      `x-anchor: &big ${'x'.repeat(ANCHOR_BYTES)}`,
      'x-omap: !!omap',
      ...Array.from({ length: entries }, (_, i) => `  - k${i}: *big`),
    ];
    const flood = yaml11Spec(omap(OVER_LIMIT_ALIASES));
    assert.ok(Buffer.byteLength(flood) < MAX_SPEC_BYTES, 'the upload itself is within limits');
    expectExpandedTooLarge(() => parseOpenApiSpec(flood));

    const parsed = parseOpenApiSpec(yaml11Spec(omap(2)));
    const entries = parsed.document['x-omap'];
    assert.ok(Array.isArray(entries), 'an ordered map is a plain sequence, not a Map');
    assert.deepEqual(Object.keys(entries[1] as object), ['k1']);
  });

  it('reads !!set under %YAML 1.1 as a plain mapping', () => {
    const parsed = parseOpenApiSpec(yaml11Spec(['x-set: !!set { a, b }']));
    assert.deepEqual(parsed.document['x-set'], { a: null, b: null });
  });

  it('does not apply merge keys under %YAML 1.1', () => {
    const parsed = parseOpenApiSpec(
      yaml11Spec([
        'x-base: &a0 { k0: v }',
        'x-m1: &a1 { <<: *a0, k1: v }',
        'x-m2: { <<: *a1, k2: v }',
      ]),
    );
    // `<<` is an ordinary key whose value is the aliased mapping, counted like
    // any other alias, rather than an instruction to copy that mapping's entries.
    assert.deepEqual(parsed.document['x-m2'], {
      '<<': { '<<': { k0: 'v' }, k1: 'v' },
      k2: 'v',
    });
  });

  it('accepts an ordinary document under a %YAML 1.1 directive', () => {
    const parsed = parseOpenApiSpec(
      yaml11Spec(['x-shared: &shared { description: Reused }', 'x-uses: [*shared, *shared]']),
    );
    assert.equal(parsed.title, 'Billing API');
    assert.equal(parsed.version, '2.4.0');
    assert.equal(parsed.contentType, 'application/yaml');
    assert.deepEqual(parsed.paths, [
      { path: '/invoices', methods: ['GET'] },
      { path: '/invoices/{id}', methods: ['GET'] },
    ]);
    assert.deepEqual(parsed.document['x-uses'], [
      { description: 'Reused' },
      { description: 'Reused' },
    ]);
  });

  it('refuses a mapping key that is not a scalar', () => {
    const cases = [
      ['x-complex:', '  ? [a, b]', '  : value'],
      ['x-complex:', '  ? { a: 1 }', '  : value'],
      ['x-anchor: &m { a: 1 }', 'x-complex: { *m : value }'],
    ];
    for (const extra of cases) {
      const spec = [SAMPLE_SPEC_YAML.trimEnd(), ...extra, ''].join('\n');
      expectSpecInvalid(() => parseOpenApiSpec(spec), { reason: 'non_scalar_key' });
    }
  });

  it('accepts an alias key that names a scalar', () => {
    const spec = [
      SAMPLE_SPEC_YAML.trimEnd(),
      'x-name: &n name',
      'x-keyed: { *n : value }',
      '',
    ].join('\n');
    assert.deepEqual(parseOpenApiSpec(spec).document['x-keyed'], { name: 'value' });
  });
});

describe('an upload measured as the catalog will serve it', () => {
  it('refuses minified JSON whose expanded form outgrows the limit during parsing', () => {
    const minified = minifiedFillerSpec();
    assert.ok(Buffer.byteLength(minified) < MAX_SPEC_BYTES);
    expectExpandedTooLarge(() => parseOpenApiSpec(minified));
    expectSpecInvalid(() => parseUploadedOpenApiSpec(minified), {
      reason: 'expanded_too_large',
      limit: MAX_SPEC_EXPANDED_BYTES,
    });
  });

  it('accepts a document whose formatted form fits', () => {
    assert.equal(parseUploadedOpenApiSpec(SAMPLE_SPEC_YAML).title, 'Billing API');
  });
});

describe('publishing and serving an alias-expanded document', () => {
  let harness: TestApp;
  let provider: TestSession;
  let owner: UserRecord;
  let cache: LruCache<CatalogSpecRendering>;
  let catalog: CatalogService;

  before(async () => {
    harness = await buildTestApp({
      env: { FERRUM_GATEWAY_PUBLIC_URL: 'https://gateway.example.test' },
    });
    await harness.registerUser({ email: 'alias-founder@example.test' });
    provider = await harness.registerUser({
      email: 'alias-provider@example.test',
      role: 'provider',
    });
    const ownerRecord = await harness.store.users.findById(provider.user.id);
    assert.ok(ownerRecord);
    owner = ownerRecord;
  });

  after(async () => {
    await harness.close();
  });

  function fresh(): void {
    cache = new LruCache<CatalogSpecRendering>({
      maxEntries: 16,
      maxBytes: 4 * MAX_SPEC_EXPANDED_BYTES,
    });
    catalog = createCatalogService({
      store: harness.store,
      settings: { getGatewayPublicUrl: async () => 'https://gateway.example.test' },
      specCache: cache,
    });
  }

  function publish(slug: string, spec: string): ReturnType<TestApp['authed']> {
    return harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: {
        name: `API ${slug}`,
        slug,
        spec,
        auth_plugin: 'key_auth',
        requestable: true,
        visibility: 'public',
      },
    });
  }

  it('refuses to publish a YAML spec whose aliases expand past the limit', async () => {
    const response = await publish('alias-flood', aliasedSpec(OVER_LIMIT_ALIASES));
    assert.equal(response.statusCode, 400, response.body);
    const body = JSON.parse(response.body) as ApiErrorBody;
    assert.equal(body.error.code, 'SPEC_INVALID');
    assert.deepEqual(body.error.details, {
      reason: 'expanded_too_large',
      limit: MAX_SPEC_EXPANDED_BYTES,
    });
    assert.equal(await harness.store.apis.findBySlug('alias-flood'), null);
  });

  it('refuses to publish or revise minified JSON that formats past the limit', async () => {
    const minified = minifiedFillerSpec();
    const response = await publish('filler-json', minified);
    assert.equal(response.statusCode, 400, response.body);
    const body = JSON.parse(response.body) as ApiErrorBody;
    assert.equal(body.error.code, 'SPEC_INVALID');
    assert.deepEqual(body.error.details, {
      reason: 'expanded_too_large',
      limit: MAX_SPEC_EXPANDED_BYTES,
    });
    assert.equal(await harness.store.apis.findBySlug('filler-json'), null);

    const published = await publish('filler-revise', SAMPLE_SPEC_YAML);
    assert.equal(published.statusCode, 201, published.body);
    const apiId = published.json<PublishApiResponse>().api.id;
    const revised = await harness.authed(provider, {
      method: 'PUT',
      url: `/api/apis/${apiId}/spec`,
      payload: { spec: minified },
    });
    assert.equal(revised.statusCode, 400, revised.body);
    const revisedBody = JSON.parse(revised.body) as ApiErrorBody;
    assert.equal(revisedBody.error.code, 'SPEC_INVALID');
    assert.deepEqual(revisedBody.error.details, {
      reason: 'expanded_too_large',
      limit: MAX_SPEC_EXPANDED_BYTES,
    });
    const current = await harness.store.apiSpecs.findCurrentByApi(apiId);
    assert.equal(current?.raw_spec, SAMPLE_SPEC_YAML.trim());
  });

  it('publishes and serves a spec that reuses small fragments through aliases', async () => {
    const spec = [
      SAMPLE_SPEC_YAML.trimEnd().replace(
        '  description: Invoices and payments.',
        '  description: |\n    Invoices and\n    payments.',
      ),
      'x-shared: &shared Shared prose',
      'x-uses: [*shared, *shared, *shared]',
      '',
    ].join('\n');
    const response = await publish('alias-small', spec);
    assert.equal(response.statusCode, 201, response.body);
    assert.ok(response.json<PublishApiResponse>().api.id);

    fresh();
    const served = await catalog.spec(owner, 'alias-small');
    assert.equal(parseOpenApiSpec(served.raw_spec).description, 'Invoices and\npayments.');
    assert.match(served.raw_spec, /x-uses:\n {2}- Shared prose\n {2}- Shared prose\n/);
  });

  it('refuses to render a stored revision whose aliases expand past the limit', async (t) => {
    const published = await publish('alias-stored', SAMPLE_SPEC_YAML);
    assert.equal(published.statusCode, 201, published.body);
    const api = await harness.store.apis.findBySlug('alias-stored');
    assert.ok(api);
    const record = await harness.store.apiSpecs.findCurrentByApi(api.id);
    assert.ok(record);

    // A revision accepted before the limit existed: the row holds the text the
    // publish path would refuse today.
    fresh();
    t.mock.method(harness.store.apiSpecs, 'findCurrentByApi', async () => ({
      ...record,
      id: '00000000-0000-4000-8000-0000000a11a5',
      raw_spec: aliasedSpec(OVER_LIMIT_ALIASES),
    }));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(
        () => catalog.spec(owner, 'alias-stored'),
        (error: unknown) => isNexusError(error) && error.code === 'SPEC_INVALID',
      );
    }
    const stats = cache.stats();
    assert.equal(stats.misses, 1);
    assert.equal(stats.hits, 1, 'the refusal is cached, not re-parsed');
    assert.ok(stats.bytes < 1024, 'no expanded document was cached');
  });

  it('refuses to serve a stored document whose serialization outgrows the limit', async () => {
    const api = await harness.store.apis.findBySlug('alias-stored');
    assert.ok(api);
    const record = await harness.store.apiSpecs.findCurrentByApi(api.id);
    assert.ok(record);

    // Stored before uploads were measured by their formatted form.
    const minified = minifiedFillerSpec();
    assert.ok(Buffer.byteLength(minified) < MAX_SPEC_BYTES);
    await harness.store.apiSpecs.create({
      api_id: api.id,
      version: 'legacy-oversized',
      raw_spec: minified,
      parsed_title: record.parsed_title,
      parsed_version: record.parsed_version,
      is_current: true,
    });

    fresh();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(
        () => catalog.spec(owner, 'alias-stored'),
        (error: unknown) => isNexusError(error) && error.code === 'SPEC_INVALID',
      );
    }
    const stats = cache.stats();
    assert.equal(stats.misses, 1);
    assert.equal(stats.hits, 1, 'the refusal is cached, not re-parsed');
    assert.ok(stats.bytes < 1024, 'the oversized rendering was not cached');
  });
});
