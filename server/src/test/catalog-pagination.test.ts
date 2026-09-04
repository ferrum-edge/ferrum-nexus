/**
 * Catalog pagination over a catalog larger than one page.
 *
 * The catalog used to read a single `MAX_PAGE_SIZE` page from the store, apply
 * the viewer's visibility rule to *that* array and then slice the caller's
 * window out of what survived. Anything past row 200 in `created_at DESC` order
 * was therefore invisible however the caller paged, and `total` reported the
 * size of the truncated remainder rather than the real filtered set.
 *
 * These tests seed one public API followed by more than `MAX_PAGE_SIZE` newer
 * internal ones — the exact shape that hid the public entry — and page the
 * whole catalog to prove every permitted row is reachable exactly once.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { MAX_PAGE_SIZE, type CatalogListResponse } from '@ferrum-nexus/shared';

import type { ApiRecord } from '../db/store.js';
import { buildTestApp, type TestApp, type TestSession } from './helpers.js';

/** Rows newer than the public API, so it sits past the first scanned page. */
const NEWER_INTERNAL = MAX_PAGE_SIZE + 10;

describe('catalog pagination beyond one scan window', () => {
  let harness: TestApp;
  let founder: TestSession;
  let provider: TestSession;
  let client: TestSession;
  let grantee: TestSession;

  let oldestPublic: ApiRecord;
  let oldestRetired: ApiRecord;
  let grantedInternal: ApiRecord;
  let internalIds: string[] = [];

  /** Seed an API straight into the store — no gateway round trip per row. */
  async function seedApi(
    ownerId: string,
    slug: string,
    overrides: { visibility?: 'public' | 'internal'; status?: 'published' | 'retired' } & {
      created_at: string;
      name?: string;
    },
  ): Promise<ApiRecord> {
    return harness.store.apis.create({
      name: overrides.name ?? `API ${slug}`,
      slug,
      owner_user_id: ownerId,
      namespace: 'nexus',
      version: '1.0.0',
      spec_format: 'openapi',
      requestable: true,
      auth_plugin: 'key_auth',
      status: overrides.status ?? 'published',
      visibility: overrides.visibility ?? 'public',
      created_at: overrides.created_at,
    });
  }

  /** Every id a session can reach by paging the catalog `pageSize` at a time. */
  async function pageAll(
    session: TestSession,
    pageSize: number,
    query = '',
  ): Promise<{ ids: string[]; total: number }> {
    const ids: string[] = [];
    let total = 0;
    for (let offset = 0; ; offset += pageSize) {
      const response = await harness.authed(session, {
        method: 'GET',
        url: `/api/catalog?limit=${pageSize}&offset=${offset}${query}`,
      });
      assert.equal(response.statusCode, 200, response.body);
      const body = response.json<CatalogListResponse>();
      total = body.total;
      ids.push(...body.items.map((api) => api.id));
      if (body.items.length < pageSize) break;
      if (offset > 10 * MAX_PAGE_SIZE) throw new Error('catalog paging did not terminate');
    }
    return { ids, total };
  }

  before(async () => {
    harness = await buildTestApp();
    founder = await harness.registerUser({ email: 'page-founder@example.test' });
    provider = await harness.registerUser({
      email: 'page-provider@example.test',
      role: 'provider',
    });
    client = await harness.registerUser({ email: 'page-client@example.test', role: 'client' });
    grantee = await harness.registerUser({ email: 'page-grantee@example.test', role: 'client' });

    // The oldest rows: one browsable public API, one retired one, one internal
    // API the grantee holds an active grant on. All three sort *below* the
    // newer internal bulk, which is what put them outside the old scan.
    const base = Date.parse('2024-01-01T00:00:00.000Z');
    const at = (index: number): string => new Date(base + index * 1000).toISOString();

    oldestPublic = await seedApi(provider.user.id, 'page-public', {
      created_at: at(0),
      name: 'Ledger reconciliation',
    });
    oldestRetired = await seedApi(provider.user.id, 'page-retired', {
      created_at: at(1),
      status: 'retired',
    });
    grantedInternal = await seedApi(provider.user.id, 'page-granted', {
      created_at: at(2),
      visibility: 'internal',
    });
    await harness.store.grants.create({
      api_id: grantedInternal.id,
      user_id: grantee.user.id,
      access_request_id: null,
      acl_group: `nexus:api:${grantedInternal.id}:approved`,
      status: 'active',
      granted_by: founder.user.id,
      revoked_by: null,
      revoked_at: null,
    });

    // …then more than a full page of newer internal APIs on top of them.
    internalIds = [];
    for (let index = 0; index < NEWER_INTERNAL; index += 1) {
      const api = await seedApi(provider.user.id, `page-internal-${index}`, {
        created_at: at(100 + index),
        visibility: 'internal',
      });
      internalIds.push(api.id);
    }
  });

  after(async () => {
    await harness.close();
  });

  it('shows a client a public API buried under a full page of newer internal ones', async () => {
    const response = await harness.authed(client, {
      method: 'GET',
      url: `/api/catalog?limit=${MAX_PAGE_SIZE}`,
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json<CatalogListResponse>();
    assert.equal(body.total, 1, 'the client may browse exactly one API');
    assert.deepEqual(
      body.items.map((api) => api.id),
      [oldestPublic.id],
      'the public API is reachable however deep in the table it sits',
    );
  });

  it('pages a provider through every one of their own APIs exactly once', async () => {
    const owned = new Set([oldestPublic.id, oldestRetired.id, grantedInternal.id, ...internalIds]);
    const { ids, total } = await pageAll(provider, 50);
    assert.equal(total, owned.size, 'total counts the whole filtered set, not one scan window');
    assert.equal(ids.length, new Set(ids).size, 'no row is served twice across pages');
    assert.deepEqual(new Set(ids), owned, 'every owned row is reachable');
  });

  it('reaches every API for an admin and keeps hidden rows hidden from a client', async () => {
    const admin = await pageAll(founder, 100);
    assert.equal(admin.total, NEWER_INTERNAL + 3, 'an admin browses everything');
    assert.equal(admin.ids.length, admin.total);

    const asClient = await pageAll(client, 25);
    assert.deepEqual(asClient.ids, [oldestPublic.id]);
    assert.equal(asClient.total, 1);
    for (const hidden of [oldestRetired.id, grantedInternal.id, ...internalIds]) {
      assert.ok(!asClient.ids.includes(hidden), 'internal and retired rows stay unlisted');
    }
  });

  it('lists a grantee their granted internal API and nothing else internal', async () => {
    const { ids, total } = await pageAll(grantee, 100);
    assert.equal(total, 2);
    assert.deepEqual(new Set(ids), new Set([oldestPublic.id, grantedInternal.id]));
  });

  it('composes the search filter with the viewer rule', async () => {
    const found = await pageAll(client, 50, '&q=reconciliation');
    assert.deepEqual(found.ids, [oldestPublic.id]);
    assert.equal(found.total, 1);

    const denied = await pageAll(client, 50, '&q=page-internal-0');
    assert.deepEqual(denied.ids, [], 'search never widens what a viewer may browse');
    assert.equal(denied.total, 0);

    const asProvider = await pageAll(provider, 50, '&q=page-internal-0');
    assert.ok(asProvider.total >= 1, 'the owner still finds their own internal API by name');
  });
});
