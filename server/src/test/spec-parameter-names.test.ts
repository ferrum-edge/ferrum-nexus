/**
 * A parameter's identity, its `name` and its `in`, is bounded at upload and
 * whenever a stored document is read back (GHSA-qw45-p9g8-rprj).
 *
 * Every reader of a document — the documentation viewer, the review
 * comparison, the consumer-facing change summary — keys each parameter by its
 * name wherever it is listed, so a name of unbounded length made every listing
 * of it cost that length. Uploads past the limit are refused; a revision stored
 * before it is refused when read back, as any stored document past a limit is,
 * and a review comparison with such a revision on either side says it is
 * incomplete rather than comparing against nothing.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  MAX_OPENAPI_PARAMETER_IN_LENGTH,
  MAX_OPENAPI_PARAMETER_NAME_LENGTH,
  type ApiErrorBody,
  type DiffApiSpecResponse,
  type GetApiRevisionDiffResponse,
  type PublishApiResponse,
} from '@ferrum-nexus/shared';

import {
  createCatalogService,
  type CatalogService,
  type CatalogSpecRendering,
} from '../catalog/service.js';
import type { UserRecord } from '../db/store.js';
import { isNexusError } from '../lib/errors.js';
import { LruCache } from '../lib/lru-cache.js';
import { buildTestApp, type TestApp, type TestSession } from './helpers.js';

const OK = { responses: { '200': { description: 'OK' } } };

/**
 * A document whose one operation takes a parameter named `name` in `location`,
 * plus `GET /legacy` when `legacy` is set.
 */
function specWithParameter(name: string, location = 'header', legacy = false): string {
  return JSON.stringify({
    openapi: '3.0.3',
    info: { title: 'Shipping API', version: '1.0.0' },
    servers: [{ url: 'https://shipping.example.com/api' }],
    paths: {
      '/shipments': {
        get: { parameters: [{ name, in: location, schema: { type: 'string' } }], ...OK },
      },
      ...(legacy ? { '/legacy': { get: OK } } : {}),
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

  it('accepts an `in` at its limit and refuses one past it', async () => {
    const inLimit = MAX_OPENAPI_PARAMETER_IN_LENGTH;
    const accepted = await publish('in-at-limit', specWithParameter('id', 'q'.repeat(inLimit)));
    assert.equal(accepted.statusCode, 201, accepted.body);

    const refused = await publish(
      'in-past-limit',
      specWithParameter('id', 'q'.repeat(inLimit + 1)),
    );
    assert.equal(refused.statusCode, 400, refused.body);
    const body = JSON.parse(refused.body) as ApiErrorBody;
    assert.equal(body.error.code, 'SPEC_INVALID');
    assert.deepEqual(body.error.details, {
      field: 'paths',
      reason: 'parameter_in_too_long',
      length: inLimit + 1,
      limit: inLimit,
    });
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

  it('reports a review against an unreadable stored revision as incomplete', async () => {
    const published = await publish('names-review', specWithParameter('X-Trace'));
    assert.equal(published.statusCode, 201, published.body);
    const apiId = published.json<PublishApiResponse>().api.id;
    const current = await harness.store.apiSpecs.findCurrentByApi(apiId);
    assert.ok(current);
    // Stored before the limit: it declares one more operation than the
    // current revision, and a name the upload checks now refuse.
    const legacy = await harness.store.apiSpecs.create({
      api_id: apiId,
      version: 'legacy-long-name',
      raw_spec: specWithParameter('n'.repeat(LIMIT + 1), 'header', true),
      parsed_title: current.parsed_title,
      parsed_version: current.parsed_version,
      is_current: false,
    });
    const legacyOperation = [{ method: 'GET', path: '/legacy' }];

    // Rolling back to it: the target cannot be checked.
    const toLegacy = await harness.authed(provider, {
      method: 'GET',
      url: `/api/apis/${apiId}/revisions/${legacy.id}/diff`,
    });
    assert.equal(toLegacy.statusCode, 200, toLegacy.body);
    const rollback = toLegacy.json<GetApiRevisionDiffResponse>().diff;
    assert.equal(rollback.complete, false);
    assert.equal(rollback.changed, true);
    assert.deepEqual(rollback.added_operations, legacyOperation);
    assert.deepEqual(rollback.removed_operations, []);
    assert.deepEqual(rollback.changed_operations, []);

    // Replacing it while it is current: the source cannot be checked.
    await harness.store.apiSpecs.setCurrent(apiId, legacy.id);
    try {
      const fromLegacy = await harness.authed(provider, {
        method: 'POST',
        url: `/api/apis/${apiId}/spec/diff`,
        payload: { spec: specWithParameter('X-Trace') },
      });
      assert.equal(fromLegacy.statusCode, 200, fromLegacy.body);
      const upload = fromLegacy.json<DiffApiSpecResponse>().diff;
      assert.equal(upload.complete, false);
      assert.equal(upload.changed, true);
      assert.deepEqual(upload.removed_operations, legacyOperation);
      assert.deepEqual(upload.potentially_breaking, legacyOperation);
      assert.deepEqual(upload.added_operations, []);
    } finally {
      await harness.store.apiSpecs.setCurrent(apiId, current.id);
    }
  });
});
