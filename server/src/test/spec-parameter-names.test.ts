/**
 * A parameter's name is bounded at upload and whenever a stored document is
 * read back (GHSA-qw45-p9g8-rprj).
 *
 * Every reader of a document — the documentation viewer, the review
 * comparison, the consumer-facing change summary — keys each parameter by its
 * name wherever it is listed, so a name of unbounded length made every listing
 * of it cost that length. Uploads past the limit are refused; a revision stored
 * before it is refused when read back, as any stored document past a limit is.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { MAX_OPENAPI_PARAMETER_NAME_LENGTH, type ApiErrorBody } from '@ferrum-nexus/shared';

import {
  createCatalogService,
  type CatalogService,
  type CatalogSpecRendering,
} from '../catalog/service.js';
import type { UserRecord } from '../db/store.js';
import { isNexusError } from '../lib/errors.js';
import { LruCache } from '../lib/lru-cache.js';
import { buildTestApp, type TestApp, type TestSession } from './helpers.js';

/** A one-operation document whose operation takes a header named `name`. */
function specWithParameter(name: string): string {
  return JSON.stringify({
    openapi: '3.0.3',
    info: { title: 'Shipping API', version: '1.0.0' },
    servers: [{ url: 'https://shipping.example.com/api' }],
    paths: {
      '/shipments': {
        get: {
          parameters: [{ name, in: 'header', schema: { type: 'string' } }],
          responses: { '200': { description: 'OK' } },
        },
      },
    },
  });
}

const LIMIT = MAX_OPENAPI_PARAMETER_NAME_LENGTH;

describe('parameter name length', () => {
  let harness: TestApp;
  let provider: TestSession;
  let owner: UserRecord;

  before(async () => {
    harness = await buildTestApp({
      env: { FERRUM_GATEWAY_PUBLIC_URL: 'https://gateway.example.test' },
    });
    await harness.registerUser({ email: 'names-founder@example.test' });
    provider = await harness.registerUser({
      email: 'names-provider@example.test',
      role: 'provider',
    });
    const ownerRecord = await harness.store.users.findById(provider.user.id);
    assert.ok(ownerRecord);
    owner = ownerRecord;
  });

  after(async () => {
    await harness.close();
  });

  function catalog(): CatalogService {
    return createCatalogService({
      store: harness.store,
      settings: { getGatewayPublicUrl: async () => 'https://gateway.example.test' },
      specCache: new LruCache<CatalogSpecRendering>({ maxEntries: 16, maxBytes: 1024 * 1024 }),
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

  it('accepts a name at the limit and refuses one past it', async () => {
    const accepted = await publish('names-at-limit', specWithParameter('n'.repeat(LIMIT)));
    assert.equal(accepted.statusCode, 201, accepted.body);

    const refused = await publish('names-past-limit', specWithParameter('n'.repeat(LIMIT + 1)));
    assert.equal(refused.statusCode, 400, refused.body);
    const body = JSON.parse(refused.body) as ApiErrorBody;
    assert.equal(body.error.code, 'SPEC_INVALID');
    assert.deepEqual(body.error.details, {
      field: 'paths',
      reason: 'parameter_name_too_long',
      length: LIMIT + 1,
      limit: LIMIT,
    });
    assert.equal(await harness.store.apis.findBySlug('names-past-limit'), null);
  });

  it('refuses to serve a stored revision that gives a longer name', async (t) => {
    const api = await harness.store.apis.findBySlug('names-at-limit');
    assert.ok(api);
    const record = await harness.store.apiSpecs.findCurrentByApi(api.id);
    assert.ok(record);
    const served = await catalog().spec(owner, 'names-at-limit');
    assert.ok(served.raw_spec.includes('n'.repeat(LIMIT)));

    // A revision accepted before the limit existed: the row holds the text the
    // publish path refuses today.
    t.mock.method(harness.store.apiSpecs, 'findCurrentByApi', async () => ({
      ...record,
      id: '00000000-0000-4000-8000-00000000a7e5',
      raw_spec: specWithParameter('n'.repeat(LIMIT + 1)),
    }));
    await assert.rejects(
      () => catalog().spec(owner, 'names-at-limit'),
      (error: unknown) => isNexusError(error) && error.code === 'SPEC_INVALID',
    );
  });
});
