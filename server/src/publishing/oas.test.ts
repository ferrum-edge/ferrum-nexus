import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  MAX_OPENAPI_PARAMETER_IN_LENGTH,
  MAX_OPENAPI_PARAMETER_NAME_LENGTH,
  MAX_OPENAPI_REF_LENGTH,
  MAX_SPEC_BYTES,
  MAX_SPEC_DEPTH,
  MAX_SPEC_OPERATIONS,
  MAX_SPEC_PATHS,
  MAX_SPEC_RENDER_UNITS,
  MAX_UPSTREAM_URL_LENGTH,
  OPENAPI_OPERATION_METHODS,
} from '@ferrum-nexus/shared';

import { isNexusError } from '../lib/errors.js';
import {
  assertRenderCost,
  assertUpstreamAllowed,
  isPublicUpstreamHost,
  parseOpenApiSpec,
  parseUpstreamUrl,
  resolveUpstream,
  schemaRenderUnits,
  slugify,
  type ResolvedAddress,
  type UpstreamResolver,
} from './oas.js';

/** A minimal, structurally valid operation object. */
const OPERATION = { responses: { '200': { description: 'OK' } } };

/** A document declaring exactly `count` paths, one `get` operation each. */
function specWithPaths(count: number): string {
  const paths: Record<string, unknown> = {};
  for (let index = 0; index < count; index += 1) paths[`/p${index}`] = { get: OPERATION };
  return JSON.stringify({
    openapi: '3.1.0',
    info: { title: 'Generated', version: '1.0.0' },
    paths,
  });
}

/**
 * A document with one operation whose render cost comes from all four counted
 * dimensions: six parameters, one response, its six media types, and a schema
 * of `schemaCount` empty properties in the first of them. Its total is
 * `schemaCount * 2 + 14` render units.
 */
function renderCostSpec(schemaCount: number): string {
  const properties: Record<string, unknown> = {};
  for (let index = 0; index < schemaCount; index += 1) properties[`p${index}`] = {};
  const content: Record<string, unknown> = {};
  for (let index = 0; index < 6; index += 1) content[`application/vnd.x${index}+json`] = {};
  content['application/vnd.x0+json'] = { schema: { type: 'object', properties } };
  return JSON.stringify({
    openapi: '3.1.0',
    info: { title: 'Wide', version: '1.0.0' },
    paths: {
      '/a': {
        get: {
          parameters: Array.from({ length: 6 }, (_, index) => ({
            name: `q${index}`,
            in: 'query',
          })),
          responses: { '200': { description: 'OK', content } },
        },
      },
    },
  });
}

/**
 * A document whose one operation responds with `schema`, next to `schemas` as
 * its components. The response entry and its media type cost two units.
 */
function respondingWith(
  schema: unknown,
  schemas: Record<string, unknown> = {},
): { document: Record<string, unknown>; paths: Record<string, unknown> } {
  const paths = {
    '/a': {
      get: {
        responses: { '200': { description: 'OK', content: { 'application/json': { schema } } } },
      },
    },
  };
  return { document: { paths, components: { schemas } }, paths };
}

/** A response whose one media type is `schema`. */
function jsonResponse(schema: unknown): Record<string, unknown> {
  return { description: 'OK', content: { 'application/json': { schema } } };
}

/** The table `web/src/components/openapi/SchemaView.test.tsx` renders. */
interface RenderUnitsFixture {
  document: Record<string, unknown>;
  cases: Array<{ name: string; schema: unknown; units: number }>;
  divergences: Array<{ name: string; schema: unknown; server: number; viewer: number }>;
}

const fixturePath = join(
  import.meta.dirname,
  '../../../shared/test-fixtures/openapi-schema-render-units.json',
);
const renderUnits = JSON.parse(readFileSync(fixturePath, 'utf8')) as RenderUnitsFixture;

/** A document declaring exactly `count` operations, packed 8 to a path item. */
function specWithOperations(count: number): string {
  const paths: Record<string, Record<string, unknown>> = {};
  for (let index = 0; index < count; index += 1) {
    const key = `/p${Math.floor(index / OPENAPI_OPERATION_METHODS.length)}`;
    const item = paths[key] ?? {};
    item[OPENAPI_OPERATION_METHODS[index % OPENAPI_OPERATION_METHODS.length] as string] = OPERATION;
    paths[key] = item;
  }
  return JSON.stringify({
    openapi: '3.1.0',
    info: { title: 'Generated', version: '1.0.0' },
    paths,
  });
}

/** A resolver that answers `addresses` for any hostname. */
function resolvesTo(addresses: ResolvedAddress[]): UpstreamResolver {
  return async () => addresses;
}

/**
 * A resolver that must never be called.
 *
 * The policy is expected to answer from the literal/suffix checks or from the
 * `allowPrivate` opt-out before it reaches DNS; calling this proves it did not.
 */
const neverResolve: UpstreamResolver = () => {
  throw new Error('the resolver must not be consulted here');
};

/** {@link expectSpecInvalid} for the async policy check. */
async function expectSpecInvalidAsync(
  fn: () => Promise<unknown>,
): Promise<{ message: string; details: unknown }> {
  try {
    await fn();
  } catch (error) {
    assert.ok(isNexusError(error), `expected a NexusError, got ${String(error)}`);
    assert.equal(error.code, 'SPEC_INVALID');
    assert.equal(error.statusCode, 400);
    return { message: error.message, details: error.details };
  }
  throw new assert.AssertionError({ message: 'expected the call to throw SPEC_INVALID' });
}

/** Assert that `fn` throws `SPEC_INVALID`, returning the error for inspection. */
function expectSpecInvalid(fn: () => unknown): { message: string; details: unknown } {
  try {
    fn();
  } catch (error) {
    assert.ok(isNexusError(error), `expected a NexusError, got ${String(error)}`);
    assert.equal(error.code, 'SPEC_INVALID');
    assert.equal(error.statusCode, 400);
    return { message: error.message, details: error.details };
  }
  throw new assert.AssertionError({ message: 'expected the call to throw SPEC_INVALID' });
}

const VALID_YAML = [
  'openapi: 3.1.0',
  'info:',
  '  title: Billing API',
  '  version: 2.4.0',
  '  description: "  Invoices and payments.  "',
  'servers:',
  '  - url: https://billing.example.com:8443/v2',
  '  - url: https://billing.example.net',
  'paths:',
  '  /invoices:',
  '    get:',
  '      responses:',
  "        '200': { description: OK }",
  '  /payments:',
  '    post:',
  '      responses:',
  "        '201': { description: Created }",
].join('\n');

describe('OpenAPI parsing', () => {
  it('bounds object and array nesting before serialization, including YAML aliases', () => {
    const document = (levels: number): string => {
      const nested = `${'['.repeat(levels)}0${']'.repeat(levels)}`;
      return `{"openapi":"3.1.0","info":{"title":"Depth","version":"1"},"paths":{},"x-deep":${nested}}`;
    };
    assert.doesNotThrow(() => parseOpenApiSpec(document(MAX_SPEC_DEPTH - 1)));
    for (const levels of [MAX_SPEC_DEPTH, 7_000]) {
      const failure = expectSpecInvalid(() => parseOpenApiSpec(document(levels)));
      assert.deepEqual(failure.details, { reason: 'nesting_too_deep', limit: MAX_SPEC_DEPTH });
    }
    const cycle = `${VALID_YAML}\nx-cycle: &cycle\n  child: *cycle\n`;
    const cycleFailure = expectSpecInvalid(() => parseOpenApiSpec(cycle));
    assert.deepEqual(cycleFailure.details, { reason: 'cyclic_alias' });
  });

  it('bounds literal and expanded server URLs using the typed upstream limit', () => {
    const document = (server: Record<string, unknown>): string =>
      JSON.stringify({
        openapi: '3.1.0',
        info: { title: 'URL bounds', version: '1' },
        paths: {},
        servers: [server],
      });
    const prefix = 'https://backend.example.com/';
    const boundary = prefix + 'x'.repeat(MAX_UPSTREAM_URL_LENGTH - prefix.length);
    assert.ok(parseOpenApiSpec(document({ url: boundary })).defaultUpstream);
    for (const server of [
      { url: `${boundary}x` },
      { url: `${prefix}${'x'.repeat(3_000)}` },
      {
        url: `${prefix}{base}{base}`,
        variables: { base: { default: 'x'.repeat(1_000) } },
      },
    ]) {
      const failure = expectSpecInvalid(() => parseOpenApiSpec(document(server)));
      assert.match(failure.message, /servers\[0\]\.url/);
      assert.deepEqual(failure.details, {
        field: 'servers[0].url',
        limit: MAX_UPSTREAM_URL_LENGTH,
      });
    }
  });

  it('reads title, version, description and path count out of YAML', () => {
    const spec = parseOpenApiSpec(VALID_YAML);
    assert.equal(spec.title, 'Billing API');
    assert.equal(spec.version, '2.4.0');
    assert.equal(spec.description, 'Invoices and payments.');
    assert.equal(spec.openapiVersion, '3.1.0');
    assert.equal(spec.pathCount, 2);
    assert.equal(spec.contentType, 'application/yaml');
    assert.equal(spec.raw, VALID_YAML.trim());
  });

  it('parses the same document as JSON and labels the content type', () => {
    const spec = parseOpenApiSpec(
      JSON.stringify({
        openapi: '3.0.3',
        info: { title: 'Shipping API', version: '1.0.0' },
        paths: { '/shipments': {} },
      }),
    );
    assert.equal(spec.contentType, 'application/json');
    assert.equal(spec.title, 'Shipping API');
    assert.equal(spec.description, null);
    assert.equal(spec.pathCount, 1);
  });

  it('splits servers[0] into the Edge backend fields, port and base path included', () => {
    const spec = parseOpenApiSpec(VALID_YAML);
    assert.deepEqual(spec.defaultUpstream, {
      url: 'https://billing.example.com:8443/v2',
      scheme: 'https',
      host: 'billing.example.com',
      port: 8443,
      basePath: '/v2',
    });
  });

  it('defaults the port from the scheme when the server URL omits one', () => {
    const spec = parseOpenApiSpec(
      JSON.stringify({
        openapi: '3.1.0',
        info: { title: 'A', version: '1' },
        servers: [{ url: 'http://plain.example.com' }],
        paths: {},
      }),
    );
    assert.equal(spec.defaultUpstream?.port, 80);
    assert.equal(spec.defaultUpstream?.scheme, 'http');
    assert.equal(spec.defaultUpstream?.basePath, null);
  });

  it('skips a relative server URL and falls through to the next absolute one', () => {
    const spec = parseOpenApiSpec(
      JSON.stringify({
        openapi: '3.1.0',
        info: { title: 'A', version: '1' },
        servers: [{ url: '/v1' }, { url: 'https://real.example.com' }],
        paths: {},
      }),
    );
    assert.equal(spec.defaultUpstream?.host, 'real.example.com');
  });

  it('yields no upstream when every server URL is relative', () => {
    const spec = parseOpenApiSpec(
      JSON.stringify({
        openapi: '3.1.0',
        info: { title: 'A', version: '1' },
        servers: [{ url: '/v1' }, { url: './api' }],
        paths: {},
      }),
    );
    assert.equal(spec.defaultUpstream, null);
    // …and the publishing service then demands an explicit one.
    const failure = expectSpecInvalid(() => resolveUpstream(spec));
    assert.match(failure.message, /No upstream could be determined/);
  });

  it('rejects a Swagger 2.0 document by name', () => {
    const failure = expectSpecInvalid(() =>
      parseOpenApiSpec(JSON.stringify({ swagger: '2.0', info: { title: 'A', version: '1' } })),
    );
    assert.match(failure.message, /Swagger 2\.0/);
    assert.deepEqual(failure.details, { field: 'swagger', value: '2.0' });
  });

  it('rejects an OpenAPI major version other than 3', () => {
    const failure = expectSpecInvalid(() =>
      parseOpenApiSpec(
        JSON.stringify({ openapi: '4.0.0', info: { title: 'A', version: '1' }, paths: {} }),
      ),
    );
    assert.match(failure.message, /Only OpenAPI 3\.x/);
  });

  it('names the missing field for info.title, info.version and paths', () => {
    const noTitle = expectSpecInvalid(() =>
      parseOpenApiSpec(JSON.stringify({ openapi: '3.1.0', info: { version: '1' }, paths: {} })),
    );
    assert.deepEqual(noTitle.details, { field: 'info.title' });

    const noVersion = expectSpecInvalid(() =>
      parseOpenApiSpec(JSON.stringify({ openapi: '3.1.0', info: { title: 'A' }, paths: {} })),
    );
    assert.deepEqual(noVersion.details, { field: 'info.version' });

    const noPaths = expectSpecInvalid(() =>
      parseOpenApiSpec(JSON.stringify({ openapi: '3.1.0', info: { title: 'A', version: '1' } })),
    );
    assert.deepEqual(noPaths.details, { field: 'paths' });
  });

  it('rejects a document that is not an object', () => {
    expectSpecInvalid(() => parseOpenApiSpec('[1, 2, 3]'));
    expectSpecInvalid(() => parseOpenApiSpec('   '));
  });

  it('rejects malformed JSON and malformed YAML with distinguishable messages', () => {
    const badJson = expectSpecInvalid(() => parseOpenApiSpec('{"openapi": '));
    assert.match(badJson.message, /not valid JSON/);
    const badYaml = expectSpecInvalid(() => parseOpenApiSpec('foo:\n  - bar\n - baz'));
    assert.match(badYaml.message, /not valid YAML/);
  });

  it('rejects a document over MAX_SPEC_BYTES before trying to parse it', () => {
    const oversized = `openapi: 3.1.0\n#${'x'.repeat(MAX_SPEC_BYTES)}`;
    const failure = expectSpecInvalid(() => parseOpenApiSpec(oversized));
    assert.match(failure.message, /larger than/);
    assert.equal((failure.details as { limit: number }).limit, MAX_SPEC_BYTES);
  });

  it('counts operations rather than paths, ignoring path-item metadata', () => {
    const spec = parseOpenApiSpec(
      JSON.stringify({
        openapi: '3.1.0',
        info: { title: 'Multi', version: '1.0.0' },
        paths: {
          '/a': {
            summary: 'not an operation',
            parameters: [],
            'x-internal': true,
            get: { responses: { '200': { description: 'OK' } } },
            post: { responses: { '201': { description: 'Created' } } },
          },
          '/b': { delete: { responses: { '204': { description: 'No content' } } } },
        },
      }),
    );
    assert.equal(spec.pathCount, 2);
    assert.equal(spec.operationCount, 3);
  });

  it('exposes the declared paths and their methods, uppercased', () => {
    const spec = parseOpenApiSpec(
      JSON.stringify({
        openapi: '3.1.0',
        info: { title: 'Multi', version: '1.0.0' },
        paths: {
          '/a': {
            summary: 'not an operation',
            parameters: [],
            'x-internal': true,
            post: { responses: { '201': { description: 'Created' } } },
            get: { responses: { '200': { description: 'OK' } } },
          },
          '/b': { delete: { responses: { '204': { description: 'No content' } } } },
          // A path item that declares nothing to call contributes no entry, and
          // a non-object one is skipped rather than failing the document.
          '/c': { summary: 'metadata only' },
          '/d': 'not an object',
        },
      }),
    );
    // Methods come out in OPENAPI_OPERATION_METHODS order, not document order,
    // so the same document always generates the same enforcement config.
    assert.deepEqual(spec.paths, [
      { path: '/a', methods: ['GET', 'POST'] },
      { path: '/b', methods: ['DELETE'] },
    ]);
    // `pathCount` still counts every key, including the two with no operations.
    assert.equal(spec.pathCount, 4);
  });

  it('accepts a document at the operation limit and rejects one just over it', () => {
    assert.equal(parseOpenApiSpec(specWithOperations(MAX_SPEC_OPERATIONS)).operationCount, 3_000);

    const failure = expectSpecInvalid(() =>
      parseOpenApiSpec(specWithOperations(MAX_SPEC_OPERATIONS + 1)),
    );
    assert.match(failure.message, /3001 operations, more than the 3000 operation limit/);
    assert.deepEqual(failure.details, {
      field: 'paths',
      operations: MAX_SPEC_OPERATIONS + 1,
      limit: MAX_SPEC_OPERATIONS,
    });
  });

  it('accepts a document at the path limit and rejects one just over it', () => {
    // One operation per path, so only the path ceiling can be the one that trips.
    assert.equal(parseOpenApiSpec(specWithPaths(MAX_SPEC_PATHS)).pathCount, 2_000);

    const failure = expectSpecInvalid(() => parseOpenApiSpec(specWithPaths(MAX_SPEC_PATHS + 1)));
    assert.match(failure.message, /2001 paths, more than the 2000 path limit/);
    assert.deepEqual(failure.details, {
      field: 'paths',
      paths: MAX_SPEC_PATHS + 1,
      limit: MAX_SPEC_PATHS,
    });
  });

  it('accepts a document at the render ceiling and rejects one just over it', () => {
    // Everything the viewer walks and neither the path nor the operation count
    // sees: one operation, one path, and a response schema whose expansion is
    // what a reader actually pays for.
    const atLimit = renderCostSpec((MAX_SPEC_RENDER_UNITS - 14) / 2);
    assert.ok(Buffer.byteLength(atLimit, 'utf8') < MAX_SPEC_BYTES);
    assert.equal(parseOpenApiSpec(atLimit).operationCount, 1);

    const overLimit = renderCostSpec((MAX_SPEC_RENDER_UNITS - 14) / 2 + 1);
    assert.ok(Buffer.byteLength(overLimit, 'utf8') < MAX_SPEC_BYTES);
    const failure = expectSpecInvalid(() => parseOpenApiSpec(overLimit));
    assert.match(
      failure.message,
      /99989 schema nodes, 6 parameters, 5 media types and 1 responses/,
    );
    assert.match(failure.message, /more than the 100000 the documentation viewer can render/);
    assert.deepEqual(failure.details, {
      field: 'paths',
      reason: 'too_much_to_render',
      schema_nodes: MAX_SPEC_RENDER_UNITS - 11,
      parameters: 6,
      media_types: 5,
      responses: 1,
      units: MAX_SPEC_RENDER_UNITS + 1,
      limit: MAX_SPEC_RENDER_UNITS,
    });
  });

  it('charges primitive schema entries to the render ceiling', () => {
    // The response entry and its media type, the schema node, and a wrapper and
    // a primitive schema per entry: 3 + 2N.
    const booleans = (count: number): unknown[] => Array.from({ length: count }, () => true);
    const atLimit = respondingWith({ oneOf: booleans(49_998) });
    assertRenderCost(atLimit.document, atLimit.paths);

    const overLimit = respondingWith({ oneOf: booleans(49_999) });
    const failure = expectSpecInvalid(() => assertRenderCost(overLimit.document, overLimit.paths));
    assert.deepEqual(failure.details, {
      field: 'paths',
      reason: 'too_much_to_render',
      schema_nodes: MAX_SPEC_RENDER_UNITS - 1,
      parameters: 0,
      media_types: 1,
      responses: 1,
      units: MAX_SPEC_RENDER_UNITS + 1,
      limit: MAX_SPEC_RENDER_UNITS,
    });

    // A component no operation reaches is never rendered, so it costs nothing.
    const unreached = { components: { schemas: { Wide: { oneOf: booleans(60_000) } } } };
    assertRenderCost(unreached, {});
  });

  it('charges anyOf and allOf entries when no earlier composition keyword is declared', () => {
    const document = { components: { schemas: {} } };
    assert.equal(schemaRenderUnits({ anyOf: [{ type: 'string' }, false] }, document), 5);
    assert.equal(schemaRenderUnits({ allOf: [{ type: 'object' }, true, {}] }, document), 7);
    assert.equal(schemaRenderUnits({ oneOf: [{}], anyOf: [{}, {}], allOf: [{}] }, document), 3);

    // The same ceiling as oneOf: 3 + 2N units.
    for (const keyword of ['anyOf', 'allOf']) {
      const entries = (count: number): unknown[] => Array.from({ length: count }, () => true);
      const atLimit = respondingWith({ [keyword]: entries(49_998) });
      assertRenderCost(atLimit.document, atLimit.paths);
      const overLimit = respondingWith({ [keyword]: entries(49_999) });
      expectSpecInvalid(() => assertRenderCost(overLimit.document, overLimit.paths));
    }
  });

  it('charges a schema reference, its resolved schema and enum chips', () => {
    // Each reference costs its row and its target's, and each target the rest
    // of itself once: the response entry and media type (2), the schema node
    // (1), the wrapper and the reference (3), `Referenced` resolving `Target`
    // (1), `Target`'s enum chip (1), and a wrapper and a primitive per entry.
    const schemas = {
      Referenced: { $ref: '#/components/schemas/Target' },
      Target: { type: 'string', enum: ['active'] },
    };
    const oneOf = (entryCount: number): unknown[] => [
      { $ref: '#/components/schemas/Referenced' },
      ...Array.from({ length: entryCount }, () => true),
    ];

    const atLimit = respondingWith({ oneOf: oneOf(49_996) }, schemas);
    assertRenderCost(atLimit.document, atLimit.paths);
    const overLimit = respondingWith({ oneOf: oneOf(49_997) }, schemas);
    const failure = expectSpecInvalid(() => assertRenderCost(overLimit.document, overLimit.paths));
    assert.deepEqual(failure.details, {
      field: 'paths',
      reason: 'too_much_to_render',
      schema_nodes: MAX_SPEC_RENDER_UNITS - 1,
      parameters: 0,
      media_types: 1,
      responses: 1,
      units: MAX_SPEC_RENDER_UNITS + 1,
      limit: MAX_SPEC_RENDER_UNITS,
    });
  });

  it('counts primitive property, item, parameter and media schemas', () => {
    // A parameter row and its primitive schema (2), the response entry (1),
    // two media types (2), a primitive media schema (1), and a composition
    // whose first entry has a primitive property and a null `items` (7) ahead
    // of N primitive entries (2N): 13 + 2N.
    const paths = (wideCount: number): Record<string, unknown> => ({
      '/a': {
        get: {
          parameters: [{ name: 'filter', in: 'query', schema: false }],
          responses: {
            '200': {
              description: 'OK',
              content: {
                'application/json': {
                  schema: {
                    oneOf: [
                      { properties: { primitive: false }, items: null },
                      ...Array.from({ length: wideCount }, () => false),
                    ],
                  },
                },
                'text/plain': { schema: true },
              },
            },
          },
        },
      },
    });

    const atLimit = paths(49_993);
    assertRenderCost({ paths: atLimit }, atLimit);
    const overLimit = paths(49_994);
    const failure = expectSpecInvalid(() => assertRenderCost({ paths: overLimit }, overLimit));
    assert.deepEqual(failure.details, {
      field: 'paths',
      reason: 'too_much_to_render',
      schema_nodes: MAX_SPEC_RENDER_UNITS - 3,
      parameters: 1,
      media_types: 2,
      responses: 1,
      units: MAX_SPEC_RENDER_UNITS + 1,
      limit: MAX_SPEC_RENDER_UNITS,
    });
  });

  it('stops reading schema siblings as soon as their cost exceeds the ceiling', () => {
    const propertyCount = MAX_SPEC_RENDER_UNITS + 10;
    const properties = Object.fromEntries(
      Array.from({ length: propertyCount }, (_, index) => [`p${index}`, {}]),
    );
    let reads = 0;
    const guardedProperties = new Proxy(properties, {
      get(target, property, receiver) {
        if (typeof property === 'string') reads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const { document, paths } = respondingWith({ properties: guardedProperties });

    expectSpecInvalid(() => assertRenderCost(document, paths));
    // The response entry, its media type and the schema node leave room for
    // 49,998 properties at two units each; the next one is the last read.
    assert.equal(reads, 49_999);
    assert.ok(reads < propertyCount);
  });

  it('accepts hundreds of operations with ordinary schemas under the render ceiling', () => {
    const properties: Record<string, unknown> = {};
    for (let index = 0; index < 12; index += 1) {
      properties[`field${index}`] = {
        type: index % 2 === 0 ? 'string' : 'integer',
        description: `A typical field ${index}`,
        enum: index % 2 === 0 ? ['open', 'closed'] : undefined,
      };
    }
    const paths: Record<string, unknown> = {};
    for (let index = 0; index < 300; index += 1) {
      paths[`/records/${index}`] = {
        get: {
          parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer' } }],
          responses: {
            '200': {
              description: 'OK',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Record' } } },
            },
          },
        },
      };
    }
    const spec = {
      openapi: '3.1.0',
      info: { title: 'Records', version: '1.0.0' },
      paths,
      components: { schemas: { Record: { type: 'object', properties } } },
    };

    assert.equal(parseOpenApiSpec(JSON.stringify(spec)).operationCount, 300);
  });

  it('accepts a connected component graph that five hundred operations reference', () => {
    // Every component names others, several of them in both directions, so the
    // viewer expands the graph under every operation that reaches it. Charged
    // in full at every reference, to the viewer's depth limit, this document
    // would be many times over the ceiling; each schema object is walked once
    // instead, and each target charged once.
    const ref = (name: string): Record<string, unknown> => ({
      $ref: `#/components/schemas/${name}`,
    });
    const list = (name: string): Record<string, unknown> => ({ type: 'array', items: ref(name) });
    const object = (properties: Record<string, unknown>): Record<string, unknown> => ({
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'integer', format: 'int64', description: 'Unique identifier' },
        created_at: { type: 'string', format: 'date-time' },
        ...properties,
      },
    });
    const text = { type: 'string', description: 'Free text' };
    const schemas = {
      User: object({
        login: text,
        email: { type: 'string', format: 'email' },
        role: { type: 'string', enum: ['admin', 'member', 'guest'] },
        organization: ref('Organization'),
        repositories: list('Repository'),
      }),
      Organization: object({
        name: text,
        owner: ref('User'),
        members: list('User'),
        repositories: list('Repository'),
      }),
      Repository: object({
        name: text,
        visibility: { type: 'string', enum: ['public', 'private', 'internal'] },
        owner: ref('User'),
        organization: ref('Organization'),
        issues: list('Issue'),
        milestones: list('Milestone'),
      }),
      Issue: object({
        title: text,
        state: { type: 'string', enum: ['open', 'closed'] },
        repository: ref('Repository'),
        author: ref('User'),
        assignees: list('User'),
        milestone: ref('Milestone'),
        labels: list('Label'),
        comments: list('Comment'),
      }),
      Milestone: object({ title: text, creator: ref('User'), issues: list('Issue') }),
      Label: object({ name: text, color: { type: 'string', pattern: '^[0-9a-f]{6}$' } }),
      Comment: object({ body: text, author: ref('User'), issue: ref('Issue') }),
      Error: {
        type: 'object',
        properties: { code: { type: 'string' }, message: text },
      },
    };
    const names = ['User', 'Organization', 'Repository', 'Issue', 'Milestone'];
    const page = [
      { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 } },
      { name: 'per_page', in: 'query', schema: { type: 'integer', maximum: 100 } },
    ];
    const paths: Record<string, unknown> = {};
    for (let version = 0; version < 25; version += 1) {
      for (const name of names) {
        const collection = `/v${version}/${name.toLowerCase()}s`;
        paths[collection] = {
          get: {
            parameters: page,
            responses: { '200': jsonResponse(list(name)), default: jsonResponse(ref('Error')) },
          },
          post: {
            requestBody: { content: { 'application/json': { schema: ref(name) } } },
            responses: { '201': jsonResponse(ref(name)), default: jsonResponse(ref('Error')) },
          },
        };
        paths[`${collection}/{id}`] = {
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          get: {
            responses: { '200': jsonResponse(ref(name)), '404': jsonResponse(ref('Error')) },
          },
          patch: {
            requestBody: { content: { 'application/json': { schema: ref(name) } } },
            responses: { '200': jsonResponse(ref(name)), '404': jsonResponse(ref('Error')) },
          },
        };
      }
    }
    const spec = {
      openapi: '3.1.0',
      info: { title: 'Connected', version: '1.0.0' },
      paths,
      components: { schemas },
    };

    assert.equal(parseOpenApiSpec(JSON.stringify(spec)).operationCount, 500);
    const stats = { contentWalks: 0, schemaWalks: 0, schemaRefLookups: 0 };
    assertRenderCost(spec, paths, stats);
    // One lookup per distinct reference string, whichever operation uses it.
    assert.equal(stats.schemaRefLookups, Object.keys(schemas).length);
  });

  it('resolves each schema reference string once, however many schemas use it', () => {
    const properties: Record<string, unknown> = {};
    for (let index = 0; index < 5_000; index += 1) {
      properties[`p${index}`] = { $ref: '#/components/schemas/Target' };
    }
    const target = { Target: { type: 'object', properties: { id: { type: 'string' } } } };
    const { document, paths } = respondingWith({ type: 'object', properties }, target);

    const stats = { contentWalks: 0, schemaWalks: 0, schemaRefLookups: 0 };
    assertRenderCost(document, paths, stats);
    assert.equal(stats.schemaRefLookups, 1);
    // The root, five thousand references, and the target and its property:
    // each walked once, the target's subtree not at every reference to it.
    assert.equal(stats.schemaWalks, 5_003);
  });

  it('refuses a $ref longer than the reference length limit before resolving it', () => {
    const prefix = '#/components/schemas/';
    const key = 'k'.repeat(MAX_OPENAPI_REF_LENGTH - prefix.length);
    const schemas = { [key]: { type: 'string' }, [`${key}k`]: { type: 'string' } };
    const longest = `${prefix}${key}`;
    assert.equal(longest.length, MAX_OPENAPI_REF_LENGTH);
    assert.equal(schemaRenderUnits({ $ref: longest }, { components: { schemas } }), 2);

    const tooLong = `${longest}k`;
    const expected = {
      field: 'paths',
      reason: 'ref_too_long',
      length: MAX_OPENAPI_REF_LENGTH + 1,
      limit: MAX_OPENAPI_REF_LENGTH,
    };
    const inSchema = respondingWith({ $ref: tooLong }, schemas);
    const failure = expectSpecInvalid(() => assertRenderCost(inSchema.document, inSchema.paths));
    assert.match(failure.message, /2049 characters long, more than the 2048/);
    assert.deepEqual(failure.details, expected);

    const inParameter = { '/a': { get: { parameters: [{ $ref: tooLong }], responses: {} } } };
    assert.deepEqual(
      expectSpecInvalid(() => assertRenderCost({ paths: inParameter }, inParameter)).details,
      expected,
    );
  });

  it('refuses a parameter name longer than the limit, wherever it is listed', () => {
    const limit = MAX_OPENAPI_PARAMETER_NAME_LENGTH;
    const atLimit = 'n'.repeat(limit);
    const tooLong = `${atLimit}n`;
    const components = { parameters: { Long: { name: tooLong, in: 'header' } } };
    const accepted = { '/a': { get: { parameters: [{ name: atLimit, in: 'query' }] } } };
    assertRenderCost({ paths: accepted, components }, accepted);

    // In an operation's list, behind a reference, and on a path item with no
    // operation beneath it.
    const refused: Record<string, unknown>[] = [
      { '/a': { get: { parameters: [{ name: tooLong, in: 'query' }] } } },
      { '/a': { get: { parameters: [{ $ref: '#/components/parameters/Long' }] } } },
      { '/a': { parameters: [{ name: tooLong, in: 'query' }] } },
    ];
    for (const paths of refused) {
      const failure = expectSpecInvalid(() => assertRenderCost({ paths, components }, paths));
      assert.match(failure.message, /1025 characters long, more than the 1024/);
      assert.deepEqual(failure.details, {
        field: 'paths',
        reason: 'parameter_name_too_long',
        length: limit + 1,
        limit,
      });
    }
  });

  it('refuses a parameter `in` longer than the limit, wherever it is listed', () => {
    const limit = MAX_OPENAPI_PARAMETER_IN_LENGTH;
    const atLimit = 'q'.repeat(limit);
    const tooLong = `${atLimit}q`;
    const components = { parameters: { Odd: { name: 'id', in: tooLong } } };
    const accepted = { '/a': { get: { parameters: [{ name: 'id', in: atLimit }] } } };
    assertRenderCost({ paths: accepted, components }, accepted);

    const refused: Record<string, unknown>[] = [
      { '/a': { get: { parameters: [{ name: 'id', in: tooLong }] } } },
      { '/a': { get: { parameters: [{ $ref: '#/components/parameters/Odd' }] } } },
      { '/a': { parameters: [{ name: 'id', in: tooLong }] } },
    ];
    for (const paths of refused) {
      const failure = expectSpecInvalid(() => assertRenderCost({ paths, components }, paths));
      assert.match(failure.message, /'in' is 65 characters long, more than the 64/);
      assert.deepEqual(failure.details, {
        field: 'paths',
        reason: 'parameter_in_too_long',
        length: limit + 1,
        limit,
      });
    }
  });

  it('charges path-item parameter rows under every operation and their schemas once', () => {
    // Three operations list the one path-item parameter: three rows, and its
    // schema of N empty properties (1 + 2N) charged once: 4 + 2N.
    const paths = (propertyCount: number): Record<string, unknown> => {
      const properties: Record<string, unknown> = {};
      for (let index = 0; index < propertyCount; index += 1) properties[`p${index}`] = {};
      const schema = { type: 'object', properties };
      return {
        '/a': {
          parameters: [{ name: 'filter', in: 'query', schema }],
          get: { responses: {} },
          put: { responses: {} },
          delete: { responses: {} },
        },
      };
    };

    const atLimit = paths(49_998);
    assertRenderCost({ paths: atLimit }, atLimit);
    // The schema is charged under the first operation, which fills the
    // allowance; the second operation's row is the unit past it.
    const overLimit = paths(49_999);
    const failure = expectSpecInvalid(() => assertRenderCost({ paths: overLimit }, overLimit));
    assert.deepEqual(failure.details, {
      field: 'paths',
      reason: 'too_much_to_render',
      schema_nodes: MAX_SPEC_RENDER_UNITS - 1,
      parameters: 2,
      media_types: 0,
      responses: 0,
      units: MAX_SPEC_RENDER_UNITS + 1,
      limit: MAX_SPEC_RENDER_UNITS,
    });
  });

  it('charges a referenced parameter for the object it names, once', () => {
    // Twenty references to one wide component parameter, with nothing inline
    // and no `components.schemas`: the target's schema is charged at the first
    // reference and every entry costs one parameter. Charging each reference in
    // full would put even the accepted document twenty times over the ceiling.
    const referencing = (propertyCount: number): string => {
      const properties: Record<string, unknown> = {};
      for (let index = 0; index < propertyCount; index += 1) properties[`p${index}`] = {};
      return JSON.stringify({
        openapi: '3.1.0',
        info: { title: 'Referenced', version: '1.0.0' },
        paths: {
          '/a': {
            get: {
              parameters: Array.from({ length: 20 }, () => ({
                $ref: '#/components/parameters/Wide',
              })),
              responses: { '200': { description: 'OK' } },
            },
          },
        },
        components: {
          parameters: {
            Wide: { name: 'filter', in: 'query', schema: { type: 'object', properties } },
          },
        },
      });
    };

    // The schema object and each property wrapper/value: 2N + 1, plus twenty
    // parameters and the one response.
    const atLimit = referencing((MAX_SPEC_RENDER_UNITS - 22) / 2);
    assert.ok(Buffer.byteLength(atLimit, 'utf8') < MAX_SPEC_BYTES);
    assert.equal(parseOpenApiSpec(atLimit).operationCount, 1);

    const failure = expectSpecInvalid(() =>
      parseOpenApiSpec(referencing((MAX_SPEC_RENDER_UNITS - 22) / 2 + 1)),
    );
    assert.deepEqual(failure.details, {
      field: 'paths',
      reason: 'too_much_to_render',
      schema_nodes: MAX_SPEC_RENDER_UNITS - 19,
      parameters: 20,
      media_types: 0,
      responses: 0,
      units: MAX_SPEC_RENDER_UNITS + 1,
      limit: MAX_SPEC_RENDER_UNITS,
    });
  });

  it('enumerates a referenced response once however many responses name it', () => {
    // One response with a thousand media types, named by five thousand
    // responses: charged in full at every reference this would be five million
    // units, and enumerating it at every reference would be five million steps.
    // Each reference still costs its own response entry: ten thousand in all.
    const content: Record<string, unknown> = {};
    for (let index = 0; index < 1_000; index += 1) {
      content[`application/vnd.x${index}+json`] = { schema: { type: 'string' } };
    }
    const responses: Record<string, unknown> = {};
    for (let index = 0; index < 5_000; index += 1) {
      responses[`x-${index}`] = { $ref: '#/components/responses/Wide' };
    }
    const document = {
      openapi: '3.1.0',
      info: { title: 'Referenced', version: '1.0.0' },
      paths: {
        '/a': { get: { responses } },
        '/b': { post: { requestBody: { $ref: '#/components/responses/Wide' }, responses } },
      },
      components: { responses: { Wide: { description: 'Wide', content } } },
    };

    const stats = { contentWalks: 0, schemaWalks: 0, schemaRefLookups: 0 };
    assertRenderCost(document, document.paths, stats);
    assert.equal(stats.contentWalks, 1);

    // Request bodies and responses share one charged set: the same object
    // named as both is charged once, at its first reference, and the request
    // body that names it again costs nothing more.
    assert.equal(parseOpenApiSpec(JSON.stringify(document)).operationCount, 2);
  });

  it('stops counting at the first charge past the ceiling', () => {
    // Every operation carries its own inline wide body, so the document is far
    // over the ceiling; the count stops at the operation that crosses it, the
    // hundredth, whose response entry and thousand media types make 1,001 each.
    const content: Record<string, unknown> = {};
    for (let index = 0; index < 1_000; index += 1) content[`application/vnd.x${index}+json`] = {};
    const paths: Record<string, unknown> = {};
    for (let index = 0; index < 1_000; index += 1) {
      paths[`/p${index}`] = { get: { responses: { '200': { description: 'OK', content } } } };
    }
    const document = { openapi: '3.1.0', info: { title: 'Wide', version: '1.0.0' }, paths };

    const stats = { contentWalks: 0, schemaWalks: 0, schemaRefLookups: 0 };
    const failure = expectSpecInvalid(() => assertRenderCost(document, paths, stats));
    assert.deepEqual(failure.details, {
      field: 'paths',
      reason: 'too_much_to_render',
      schema_nodes: 0,
      parameters: 0,
      media_types: 100_000,
      responses: 100,
      units: 100_100,
      limit: MAX_SPEC_RENDER_UNITS,
    });
    // One `content` map shared by every body, as a YAML anchor would share it:
    // each inline occurrence is charged, but the map is enumerated only once.
    assert.equal(stats.contentWalks, 1);
  });

  it('charges response entries that declare nothing, so an aliased map cannot repeat free', () => {
    // One anchored `responses` map of empty entries, aliased by three more
    // operations: no content, no schema, and nothing but entries to walk. Free
    // entries would let a 2 MiB document repeat a map this size a hundred times.
    const entries = Array.from({ length: 30_000 }, (_, index) => `        r${index}: {}`);
    const operation = (path: string, responses: string): string[] => [
      `  ${path}:`,
      '    get:',
      `      responses: ${responses}`,
    ];
    const yaml = [
      'openapi: 3.1.0',
      'info:',
      '  title: Aliased',
      '  version: 1.0.0',
      'paths:',
      ...operation('/a', '&r'),
      ...entries,
      ...operation('/b', '*r'),
      ...operation('/c', '*r'),
      ...operation('/d', '*r'),
    ].join('\n');
    assert.ok(Buffer.byteLength(yaml, 'utf8') < MAX_SPEC_BYTES);

    const failure = expectSpecInvalid(() => parseOpenApiSpec(yaml));
    // Counting stops at the entry that crosses the ceiling, in the fourth map.
    assert.deepEqual(failure.details, {
      field: 'paths',
      reason: 'too_much_to_render',
      schema_nodes: 0,
      parameters: 0,
      media_types: 0,
      responses: MAX_SPEC_RENDER_UNITS + 1,
      units: MAX_SPEC_RENDER_UNITS + 1,
      limit: MAX_SPEC_RENDER_UNITS,
    });
  });

  it('rejects an operation flood that is well inside MAX_SPEC_BYTES', () => {
    // The shape the size cap alone does not stop: a server-valid document with
    // tens of thousands of minimal operations, which the SPA renders one card
    // at a time.
    const flood = specWithOperations(30_000);
    assert.ok(Buffer.byteLength(flood, 'utf8') < MAX_SPEC_BYTES);
    assert.match(expectSpecInvalid(() => parseOpenApiSpec(flood)).message, /more than the/);
  });
});

describe('schema render units', () => {
  // The same table SchemaView.test.tsx renders, so the server's count and the
  // viewer's spend are checked against one set of numbers.
  it('counts every shared fixture schema as the viewer spends on it', () => {
    for (const { name, schema, units } of renderUnits.cases) {
      assert.equal(schemaRenderUnits(schema, renderUnits.document), units, name);
    }
  });

  it('counts what the shared fixture records where the viewer spends differently', () => {
    for (const { name, schema, server } of renderUnits.divergences) {
      assert.equal(schemaRenderUnits(schema, renderUnits.document), server, name);
    }
  });
});

describe('upstream URL parsing', () => {
  it('accepts absolute http and https URLs only', () => {
    assert.equal(parseUpstreamUrl('https://example.com')?.scheme, 'https');
    assert.equal(parseUpstreamUrl('http://example.com:9000')?.port, 9000);
    assert.equal(parseUpstreamUrl('ftp://example.com'), null);
    assert.equal(parseUpstreamUrl('/relative'), null);
    assert.equal(parseUpstreamUrl(''), null);
  });

  it('strips the brackets from an IPv6 literal, which Edge does not accept', () => {
    assert.equal(parseUpstreamUrl('https://[::1]:8443')?.host, '::1');
    assert.equal(parseUpstreamUrl('https://[2606:4700:4700::1111]')?.host, '2606:4700:4700::1111');
  });

  it('rejects embedded credentials and lower-cases the host', () => {
    assert.equal(parseUpstreamUrl('https://user:pw@example.com'), null);
    assert.equal(parseUpstreamUrl('https://API.Example.COM/v1')?.host, 'api.example.com');
  });

  it('parses private destinations; policy is applied separately', () => {
    // The parser is policy-free so a pinned API can still store a document
    // whose servers[0] is internal. `assertUpstreamAllowed` is the gate.
    assert.equal(parseUpstreamUrl('http://10.0.0.1')?.host, '10.0.0.1');
    assert.equal(parseUpstreamUrl('http://host.docker.internal:8081')?.port, 8081);
  });
});

describe('upstream destination policy', () => {
  const PRIVATE_HOSTS = [
    '127.0.0.1',
    '127.8.8.8',
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.254',
    '192.0.0.1',
    '192.168.0.1',
    '198.18.0.1',
    '224.0.0.1',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fd12::1',
    'fe80::1',
    'ff02::1',
    // Site-local fec0::/10 (deprecated, never global).
    'fec0::1',
    'feff::1',
    // NAT64 well-known prefix carrying a private IPv4 address, in both spellings.
    '64:ff9b::a00:1',
    '64:ff9b::10.0.0.1',
    '64:ff9b::7f00:1',
    '64:ff9b::a9fe:a9fe',
    // Local-use NAT64 and the rest of 64:ff9b::/32, whatever they embed.
    '64:ff9b:1::a00:1',
    '64:ff9b:1::5db8:d822',
    '64:ff9b:0:0:1::5db8:d822',
    // 6to4 relaying to a private IPv4 address.
    '2002:a00:1::1',
    '2002:c0a8:101::',
    '2002:7f00:1::1',
    '2002::1',
    // IPv4-mapped in its uncompressed and hex spellings.
    '0:0:0:0:0:ffff:a00:1',
    '::ffff:a00:1',
    // Deprecated IPv4-compatible and SIIT-translated forms, even of a public address.
    '::10.0.0.1',
    '::93.184.216.34',
    '::ffff:0:5db8:d822',
    'localhost',
    'app.localhost',
    'service.internal',
    'host.docker.internal',
    'printer.local',
    'router.home.arpa',
    // DNS-equivalent spellings: a trailing root label or letter case must not
    // slip a name past the suffix list.
    'x.internal.',
    'X.INTERNAL',
    'localhost.',
  ];
  const PUBLIC_HOSTS = [
    '93.184.216.34',
    '172.32.0.1',
    '100.128.0.1',
    '2606:4700:4700::1111',
    // Transition addresses are judged by the IPv4 address they deliver to.
    '::ffff:93.184.216.34',
    '0:0:0:0:0:ffff:5db8:d822',
    '64:ff9b::5db8:d822',
    '64:ff9b::93.184.216.34',
    '2002:5db8:d822::1',
    'example.com',
    'api.internal.example.com',
    // The same normalisation must not over-refuse a genuinely public name.
    'API.EXAMPLE.COM.',
    'api.internal.example.com.',
  ];

  it('classifies loopback, private, link-local, multicast and internal names as private', () => {
    for (const host of PRIVATE_HOSTS) assert.equal(isPublicUpstreamHost(host), false, host);
    for (const host of PUBLIC_HOSTS) assert.equal(isPublicUpstreamHost(host), true, host);
  });

  it('refuses a private upstream unless the deployment allows them', async () => {
    const upstream = parseUpstreamUrl('http://169.254.169.254/latest/meta-data');
    assert.ok(upstream);
    const error = await expectSpecInvalidAsync(() =>
      assertUpstreamAllowed(upstream, { allowPrivate: false, resolve: neverResolve }),
    );
    assert.match(error.message, /NEXUS_ALLOW_PRIVATE_UPSTREAMS/);
    assert.deepEqual(error.details, {
      field: 'upstream_url',
      host: '169.254.169.254',
      reason: 'private_upstream',
    });
    await assertUpstreamAllowed(upstream, { allowPrivate: true, resolve: neverResolve });
  });

  it('always passes a public upstream', async () => {
    const upstream = parseUpstreamUrl('https://api.example.com');
    assert.ok(upstream);
    await assertUpstreamAllowed(upstream, {
      allowPrivate: false,
      resolve: resolvesTo([{ address: '93.184.216.34', family: 4 }]),
    });
  });

  it('refuses a fully-qualified or mixed-case denylisted name before any lookup', async () => {
    for (const [url, host] of [
      ['https://x.internal./v1', 'x.internal.'],
      ['https://X.INTERNAL', 'x.internal'],
      ['http://localhost.', 'localhost.'],
    ] as const) {
      const upstream = parseUpstreamUrl(url);
      assert.ok(upstream, url);
      const error = await expectSpecInvalidAsync(() =>
        assertUpstreamAllowed(upstream, { allowPrivate: false, resolve: neverResolve }),
      );
      assert.deepEqual(error.details, { field: 'upstream_url', host, reason: 'private_upstream' });
    }
  });
});

describe('upstream destination policy — DNS resolution', () => {
  /** `assertUpstreamAllowed` against a canned answer for `api.example.com`. */
  async function check(
    answers: ResolvedAddress[],
    host = 'https://api.example.com',
  ): Promise<void> {
    const upstream = parseUpstreamUrl(host);
    assert.ok(upstream);
    await assertUpstreamAllowed(upstream, { allowPrivate: false, resolve: resolvesTo(answers) });
  }

  /** The `SPEC_INVALID` `check` throws for `answers`. */
  async function refusal(
    answers: ResolvedAddress[],
  ): Promise<{ message: string; details: unknown }> {
    return expectSpecInvalidAsync(() => check(answers));
  }

  it('refuses a name whose A record is loopback — the nip.io bypass', async () => {
    const error = await refusal([{ address: '127.0.0.1', family: 4 }]);
    assert.deepEqual(error.details, {
      field: 'upstream_url',
      host: 'api.example.com',
      reason: 'private_upstream',
      resolved: ['127.0.0.1'],
    });
    assert.match(error.message, /127\.0\.0\.1/);
    assert.match(error.message, /NEXUS_ALLOW_PRIVATE_UPSTREAMS/);
  });

  it('refuses RFC 1918 and cloud-metadata answers', async () => {
    for (const address of ['10.0.0.5', '169.254.169.254', '192.168.1.10', '172.16.4.4']) {
      const error = await refusal([{ address, family: 4 }]);
      assert.deepEqual(
        (error.details as { resolved: string[] }).resolved,
        [address],
        `${address} must be refused`,
      );
    }
  });

  it('refuses IPv6 unique-local, link-local and IPv4-mapped answers', async () => {
    for (const address of ['fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
      const error = await refusal([{ address, family: 6 }]);
      assert.deepEqual(
        (error.details as { resolved: string[] }).resolved,
        [address],
        `${address} must be refused`,
      );
    }
  });

  it('accepts an IPv4-mapped answer whose IPv4 address is public', async () => {
    await check([{ address: '::ffff:93.184.216.34', family: 6 }]);
  });

  it('refuses NAT64, 6to4 and site-local answers that reach private space', async () => {
    // On a DNS64/NAT64 network an AAAA-only name answers inside 64:ff9b::/96,
    // and the translator delivers to the IPv4 address in its low 32 bits.
    for (const address of [
      '64:ff9b::a00:1',
      '64:ff9b::169.254.169.254',
      '64:ff9b:1::a00:1',
      '2002:a00:1::1',
      '2002:c0a8:10a::1',
      'fec0::1',
    ]) {
      const error = await refusal([{ address, family: 6 }]);
      assert.deepEqual(
        (error.details as { resolved: string[] }).resolved,
        [address],
        `${address} must be refused`,
      );
    }
  });

  it('accepts NAT64 and 6to4 answers whose IPv4 address is public', async () => {
    await check([
      { address: '64:ff9b::5db8:d822', family: 6 },
      { address: '2002:5db8:d822::1', family: 6 },
    ]);
  });

  it('refuses a mixed answer set: one private address is enough', async () => {
    const error = await refusal([
      { address: '93.184.216.34', family: 4 },
      { address: '192.168.1.10', family: 4 },
    ]);
    assert.deepEqual((error.details as { resolved: string[] }).resolved, [
      '93.184.216.34',
      '192.168.1.10',
    ]);
  });

  it('refuses an empty answer set as unresolvable', async () => {
    const error = await refusal([]);
    assert.deepEqual(error.details, {
      field: 'upstream_url',
      host: 'api.example.com',
      reason: 'unresolvable_upstream',
    });
  });

  it('refuses when the lookup fails (NXDOMAIN) — fail closed', async () => {
    const upstream = parseUpstreamUrl('https://api.example.com');
    assert.ok(upstream);
    const error = await expectSpecInvalidAsync(() =>
      assertUpstreamAllowed(upstream, {
        allowPrivate: false,
        resolve: () => Promise.reject(Object.assign(new Error('nope'), { code: 'ENOTFOUND' })),
      }),
    );
    assert.deepEqual(error.details, {
      field: 'upstream_url',
      host: 'api.example.com',
      reason: 'unresolvable_upstream',
    });
  });

  it('refuses when the resolver times out — fail closed', async () => {
    const upstream = parseUpstreamUrl('https://api.example.com');
    assert.ok(upstream);
    const error = await expectSpecInvalidAsync(() =>
      assertUpstreamAllowed(upstream, {
        allowPrivate: false,
        resolve: () => Promise.reject(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })),
      }),
    );
    assert.equal((error.details as { reason: string }).reason, 'unresolvable_upstream');
  });

  it('accepts a name whose every answer is public', async () => {
    await check([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ]);
  });

  it('never resolves when the deployment allows private upstreams', async () => {
    const upstream = parseUpstreamUrl('http://internal-service.example.com:8080');
    assert.ok(upstream);
    await assertUpstreamAllowed(upstream, { allowPrivate: true, resolve: neverResolve });
  });

  it('never resolves an IP literal: it is already the destination', async () => {
    const publicLiteral = parseUpstreamUrl('https://93.184.216.34');
    assert.ok(publicLiteral);
    await assertUpstreamAllowed(publicLiteral, { allowPrivate: false, resolve: neverResolve });

    const v6 = parseUpstreamUrl('https://[2606:4700:4700::1111]');
    assert.ok(v6);
    await assertUpstreamAllowed(v6, { allowPrivate: false, resolve: neverResolve });

    // And a private literal is still refused without asking DNS anything.
    const privateLiteral = parseUpstreamUrl('http://10.0.0.5');
    assert.ok(privateLiteral);
    await expectSpecInvalidAsync(() =>
      assertUpstreamAllowed(privateLiteral, { allowPrivate: false, resolve: neverResolve }),
    );
  });

  it('never resolves a denylisted name suffix', async () => {
    const upstream = parseUpstreamUrl('http://host.docker.internal:8081');
    assert.ok(upstream);
    const error = await expectSpecInvalidAsync(() =>
      assertUpstreamAllowed(upstream, { allowPrivate: false, resolve: neverResolve }),
    );
    assert.deepEqual(error.details, {
      field: 'upstream_url',
      host: 'host.docker.internal',
      reason: 'private_upstream',
    });
  });
});

describe('upstream resolution', () => {
  it('prefers an explicit upstream over the document', () => {
    const spec = parseOpenApiSpec(VALID_YAML);
    const upstream = resolveUpstream(spec, 'http://override.example.com:8080/base');
    assert.equal(upstream.host, 'override.example.com');
    assert.equal(upstream.port, 8080);
    assert.equal(upstream.basePath, '/base');
  });

  it('rejects an explicit upstream that is not absolute', () => {
    const spec = parseOpenApiSpec(VALID_YAML);
    const failure = expectSpecInvalid(() => resolveUpstream(spec, '/nope'));
    assert.deepEqual(failure.details, { field: 'upstream_url', value: '/nope' });
  });

  it('falls back to the document when the explicit upstream is blank', () => {
    const spec = parseOpenApiSpec(VALID_YAML);
    assert.equal(resolveUpstream(spec, '   ').host, 'billing.example.com');
    assert.equal(resolveUpstream(spec, null).host, 'billing.example.com');
  });
});

describe('slugify', () => {
  it('produces a URL-safe, hyphen-separated, bounded slug', () => {
    assert.equal(slugify('Billing API v2'), 'billing-api-v2');
    assert.equal(slugify('  --Payments!!--  '), 'payments');
    assert.equal(slugify('Café Ordering'), 'cafe-ordering');
    assert.equal(slugify('!!!'), '');
    assert.ok(slugify('x'.repeat(200)).length <= 60);
  });
});

describe('OpenAPI server variables', () => {
  function withServers(servers: unknown[]) {
    return parseOpenApiSpec(
      JSON.stringify({
        openapi: '3.1.0',
        info: { title: 'Templated API', version: '1' },
        paths: {},
        servers,
      }),
    );
  }

  it('expands host, port and repeated path variables before applying destination policy', async () => {
    const spec = withServers([
      {
        url: 'https://{environment}.api.example.com:{port}/{version}/{version}',
        variables: {
          environment: { default: 'prod' },
          port: { default: '8443', enum: ['443', '8443'] },
          version: { default: 'v1' },
        },
      },
    ]);
    const upstream = resolveUpstream(spec);
    assert.equal(upstream.host, 'prod.api.example.com');
    assert.equal(upstream.port, 8443);
    assert.equal(upstream.basePath, '/v1/v1');
    const queried: string[] = [];
    await assertUpstreamAllowed(upstream, {
      allowPrivate: false,
      resolve: async (host) => {
        queried.push(host);
        return [{ address: '93.184.216.34', family: 4 }];
      },
    });
    assert.deepEqual(queried, ['prod.api.example.com']);
  });

  it('allows an empty string default in a path', () => {
    const spec = withServers([
      { url: 'https://api.example.com/{base}', variables: { base: { default: '' } } },
    ]);
    assert.equal(resolveUpstream(spec).basePath, null);
  });

  it('skips unresolved entries and preserves explicit override precedence', () => {
    const unresolved = { url: 'https://{environment}.example.com' };
    const fallback = withServers([unresolved, { url: 'https://fallback.example.com' }]);
    assert.equal(resolveUpstream(fallback).host, 'fallback.example.com');
    assert.equal(
      resolveUpstream(withServers([unresolved]), 'https://pinned.example.com').host,
      'pinned.example.com',
    );
  });

  it('names server variables when missing, invalid or recursively templated defaults cannot resolve', () => {
    for (const variable of [undefined, {}, { default: 123 }, { default: '{other}' }]) {
      const spec = withServers([
        { url: 'https://{environment}.example.com', variables: { environment: variable } },
      ]);
      assert.equal(spec.defaultUpstream, null);
      const failure = expectSpecInvalid(() => resolveUpstream(spec));
      assert.match(failure.message, /server variables/);
      assert.deepEqual(failure.details, { field: 'servers', reason: 'invalid_server_variables' });
    }
  });

  it('rejects defaults outside a declared enum and never parses unresolved URL braces', () => {
    const spec = withServers([
      {
        url: 'https://{environment}.example.com',
        variables: { environment: { default: 'prod', enum: ['test'] } },
      },
    ]);
    expectSpecInvalid(() => resolveUpstream(spec));
    assert.equal(parseUpstreamUrl('https://{environment}.example.com'), null);
  });
});
