import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_API_SLUG_LENGTH,
  firstUsableSpecServerUrl,
  isValidApiSlug,
  slugify,
} from './publishing.js';
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
