import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MAX_SPEC_BYTES } from '@ferrum-nexus/shared';

import { isNexusError } from '../lib/errors.js';
import { parseOpenApiSpec, parseUpstreamUrl, resolveUpstream, slugify } from './oas.js';

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
  '  - url: https://billing.internal:8443/v2',
  '  - url: https://billing.eu.internal',
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
      url: 'https://billing.internal:8443/v2',
      scheme: 'https',
      host: 'billing.internal',
      port: 8443,
      basePath: '/v2',
    });
  });

  it('defaults the port from the scheme when the server URL omits one', () => {
    const spec = parseOpenApiSpec(
      JSON.stringify({
        openapi: '3.1.0',
        info: { title: 'A', version: '1' },
        servers: [{ url: 'http://plain.internal' }],
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
        servers: [{ url: '/v1' }, { url: 'https://real.internal' }],
        paths: {},
      }),
    );
    assert.equal(spec.defaultUpstream?.host, 'real.internal');
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
});

describe('upstream URL parsing', () => {
  it('accepts absolute http and https URLs only', () => {
    assert.equal(parseUpstreamUrl('https://a.internal')?.scheme, 'https');
    assert.equal(parseUpstreamUrl('http://a.internal:9000')?.port, 9000);
    assert.equal(parseUpstreamUrl('ftp://a.internal'), null);
    assert.equal(parseUpstreamUrl('/relative'), null);
    assert.equal(parseUpstreamUrl(''), null);
  });

  it('strips the brackets from an IPv6 literal, which Edge does not accept', () => {
    assert.equal(parseUpstreamUrl('https://[::1]:8443')?.host, '::1');
  });

  it('prefers an explicit upstream over the document', () => {
    const spec = parseOpenApiSpec(VALID_YAML);
    const upstream = resolveUpstream(spec, 'http://override.internal:8080/base');
    assert.equal(upstream.host, 'override.internal');
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
    assert.equal(resolveUpstream(spec, '   ').host, 'billing.internal');
    assert.equal(resolveUpstream(spec, null).host, 'billing.internal');
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
