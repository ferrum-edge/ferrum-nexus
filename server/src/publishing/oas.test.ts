import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_SPEC_BYTES,
  MAX_SPEC_OPERATIONS,
  MAX_SPEC_PATHS,
  OPENAPI_OPERATION_METHODS,
} from '@ferrum-nexus/shared';

import { isNexusError } from '../lib/errors.js';
import {
  assertUpstreamAllowed,
  isPublicUpstreamHost,
  parseOpenApiSpec,
  parseUpstreamUrl,
  resolveUpstream,
  slugify,
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

  it('rejects an operation flood that is well inside MAX_SPEC_BYTES', () => {
    // The shape the size cap alone does not stop: a server-valid document with
    // tens of thousands of minimal operations, which the SPA renders one card
    // at a time.
    const flood = specWithOperations(30_000);
    assert.ok(Buffer.byteLength(flood, 'utf8') < MAX_SPEC_BYTES);
    assert.match(expectSpecInvalid(() => parseOpenApiSpec(flood)).message, /more than the/);
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
    'localhost',
    'app.localhost',
    'service.internal',
    'host.docker.internal',
    'printer.local',
    'router.home.arpa',
  ];
  const PUBLIC_HOSTS = [
    '93.184.216.34',
    '172.32.0.1',
    '100.128.0.1',
    '2606:4700:4700::1111',
    'example.com',
    'api.internal.example.com',
  ];

  it('classifies loopback, private, link-local, multicast and internal names as private', () => {
    for (const host of PRIVATE_HOSTS) assert.equal(isPublicUpstreamHost(host), false, host);
    for (const host of PUBLIC_HOSTS) assert.equal(isPublicUpstreamHost(host), true, host);
  });

  it('refuses a private upstream unless the deployment allows them', () => {
    const upstream = parseUpstreamUrl('http://169.254.169.254/latest/meta-data');
    assert.ok(upstream);
    const error = expectSpecInvalid(() => assertUpstreamAllowed(upstream, { allowPrivate: false }));
    assert.match(error.message, /NEXUS_ALLOW_PRIVATE_UPSTREAMS/);
    assert.deepEqual(error.details, {
      field: 'upstream_url',
      host: '169.254.169.254',
      reason: 'private_upstream',
    });
    assert.doesNotThrow(() => assertUpstreamAllowed(upstream, { allowPrivate: true }));
  });

  it('always passes a public upstream', () => {
    const upstream = parseUpstreamUrl('https://api.example.com');
    assert.ok(upstream);
    assert.doesNotThrow(() => assertUpstreamAllowed(upstream, { allowPrivate: false }));
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
