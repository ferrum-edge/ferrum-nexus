import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_API_SLUG_LENGTH,
  describeSpecChange,
  emptySpecChangeReport,
  firstUsableSpecServerUrl,
  isValidApiSlug,
  slugify,
} from './publishing.js';
import type { SpecChange } from './entities.js';
import { MAX_UPSTREAM_URL_LENGTH } from './constants.js';

describe('API slug contract', () => {
  it('bounds a long name and keeps the generated slug valid', () => {
    const slug = slugify('a'.repeat(MAX_API_SLUG_LENGTH + 1));
    assert.equal(slug, 'a'.repeat(MAX_API_SLUG_LENGTH));
    assert.equal(isValidApiSlug(slug), true);
    assert.equal(isValidApiSlug('a'.repeat(MAX_API_SLUG_LENGTH + 1)), false);
    assert.equal(isValidApiSlug('a'.repeat(MAX_API_SLUG_LENGTH - 1) + '-'), false);
  });

  it('strips combining marks before replacing separators', () => {
    assert.equal(slugify('Café'), 'cafe');
    assert.equal(slugify('Caféine API'), 'cafeine-api');
    assert.equal(isValidApiSlug(slugify('Caféine API')), true);
  });

  it('rejects invalid custom slugs', () => {
    for (const slug of ['', 'Bad-Slug', 'bad slug', 'bad--slug', '-bad', 'bad-']) {
      assert.equal(isValidApiSlug(slug), false);
    }
  });
});

describe('OpenAPI root server selection', () => {
  it('skips relative and unresolved entries, expanding the first usable absolute URL', () => {
    assert.deepEqual(
      firstUsableSpecServerUrl([
        { url: '/relative' },
        { url: 'https://{missing}.example.com' },
        {
          url: 'https://{environment}.example.com/v1',
          variables: { environment: { default: 'prod', enum: ['prod', 'test'] } },
        },
      ]),
      { url: 'https://prod.example.com/v1', oversizedField: null },
    );
  });

  it('reports an oversized expanded entry even when a later entry is usable', () => {
    assert.deepEqual(
      firstUsableSpecServerUrl([
        { url: `https://example.com/${'a'.repeat(MAX_UPSTREAM_URL_LENGTH)}` },
        { url: 'https://later.example.com' },
      ]),
      { url: null, oversizedField: 'servers[0].url' },
    );
  });
});

describe('specification change sentences', () => {
  const change = (overrides: Partial<SpecChange>): SpecChange => ({
    kind: 'operation_added',
    severity: 'non_breaking',
    operation: { method: 'GET', path: '/invoices' },
    section: 'operation',
    location: null,
    schema_path: null,
    from: null,
    to: null,
    ...overrides,
  });

  it('names where each change is', () => {
    assert.equal(
      describeSpecChange(change({ kind: 'operation_removed', severity: 'breaking' })),
      'Operation removed: requests to it may now fail',
    );
    assert.equal(
      describeSpecChange(
        change({
          kind: 'parameter_added',
          section: 'parameter',
          location: 'query limit',
          to: 'required',
        }),
      ),
      'Parameter query limit added (required)',
    );
    assert.equal(
      describeSpecChange(
        change({
          kind: 'schema_type_changed',
          section: 'response',
          location: '200 application/json',
          schema_path: 'lines[].total',
          from: 'integer',
          to: 'number',
        }),
      ),
      'Response 200 application/json, field lines[].total: type changed from integer to number',
    );
    assert.equal(
      describeSpecChange(
        change({
          kind: 'schema_property_removed',
          operation: null,
          section: 'request',
          location: '#/components/schemas/Order',
          schema_path: 'note',
        }),
      ),
      'Schema #/components/schemas/Order (in requests), field note: removed',
    );
    assert.equal(
      describeSpecChange(
        change({
          kind: 'schema_enum_values_added',
          section: 'request',
          location: 'application/json',
          schema_path: 'mode',
          from: 'any value',
          to: '"a", "b"',
        }),
      ),
      'Request body application/json, field mode: now restricted to "a", "b"',
    );
  });

  it('starts every report empty and complete unless told otherwise', () => {
    assert.equal(emptySpecChangeReport().complete, true);
    assert.equal(emptySpecChangeReport(false).complete, false);
    assert.deepEqual(emptySpecChangeReport().changes, []);
  });
});
