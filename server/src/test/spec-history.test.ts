/**
 * Specification history, change review and rollback — issue #290.
 *
 * Nexus already stored bounded revision history; what it had no way to do was
 * *look at* it, compare a proposed change against what is live, and put an
 * earlier document back. These tests hold that workflow to the two things that
 * make it safe rather than merely possible:
 *
 * - a rollback is a **new revision carrying an old document**, not a rewrite of
 *   history and not a delete-and-republish, so the API keeps its id, slug,
 *   ownership, grants and gateway URL and the earlier entries stay exactly as
 *   they were;
 * - it goes through the publishing path an upload goes through, so a gateway
 *   failure compensates and reports rather than quietly claiming success.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type {
  DiffApiSpecResponse,
  GetApiRevisionDiffResponse,
  GetApiRevisionResponse,
  GetApiSpecResponse,
  ListApiRevisionsResponse,
  PublishApiResponse,
  RollbackApiSpecResponse,
  UpdateApiSpecResponse,
} from '@ferrum-nexus/shared';

import { AuditAction } from '../audit/service.js';
import { buildTestApp, type TestApp, type TestSession } from './helpers.js';

/** A document with one operation per entry of `operations`. */
function spec(version: string, operations: [string, string][]): string {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [path, method] of operations) {
    paths[path] = {
      ...(paths[path] ?? {}),
      [method]: { summary: `${method} ${path}`, responses: { '200': { description: 'OK' } } },
    };
  }
  return JSON.stringify({
    openapi: '3.1.0',
    info: { title: 'Billing API', version },
    servers: [{ url: 'https://billing.example.com:8443/v2' }],
    paths,
  });
}

const V1 = spec('1.0.0', [
  ['/invoices', 'get'],
  ['/invoices', 'post'],
]);
const V2 = spec('2.0.0', [
  ['/invoices', 'get'],
  ['/receipts', 'get'],
]);

describe('specification history, review and rollback', () => {
  let harness: TestApp;
  let provider: TestSession;
  let other: TestSession;
  let admin: TestSession;
  let apiId: string;

  async function publishRevision(document: string): Promise<UpdateApiSpecResponse> {
    const response = await harness.authed(provider, {
      method: 'PUT',
      url: `/api/apis/${apiId}/spec`,
      payload: { spec: document },
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json<UpdateApiSpecResponse>();
  }

  async function revisions(session = provider): Promise<ListApiRevisionsResponse> {
    const response = await harness.authed(session, {
      method: 'GET',
      url: `/api/apis/${apiId}/revisions`,
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json<ListApiRevisionsResponse>();
  }

  beforeEach(async () => {
    harness = await buildTestApp();
    admin = await harness.registerUser({ email: 'history-super@example.test' });
    provider = await harness.registerUser({
      email: 'history-provider@example.test',
      role: 'provider',
    });
    other = await harness.registerUser({
      email: 'history-other@example.test',
      role: 'provider',
    });

    const published = await harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: {
        name: 'History Billing',
        slug: 'history-billing',
        spec: V1,
        auth_plugin: 'key_auth',
        requestable: true,
        visibility: 'public',
      },
    });
    assert.equal(published.statusCode, 201, published.body);
    apiId = published.json<PublishApiResponse>().api.id;
  });

  afterEach(async () => {
    await harness.close();
  });

  it('lists retained revisions with their author and current marker', async () => {
    await publishRevision(V2);
    const page = await revisions();
    assert.equal(page.total, 2);
    // The current revision leads whatever its position.
    assert.equal(page.items[0]?.is_current, true);
    assert.equal(page.items[0]?.parsed_version, '2.0.0');
    assert.equal(page.items[1]?.is_current, false);
    assert.equal(page.items[1]?.parsed_version, '1.0.0');
    for (const item of page.items) {
      assert.equal(item.created_by, provider.user.id, 'the publisher is recorded');
      assert.equal(item.rolled_back_from_id, null, 'neither of these is a rollback');
      assert.ok(item.created_at);
    }
  });

  it('serves one retained revision’s document', async () => {
    const first = (await revisions()).items[0];
    assert.ok(first);
    await publishRevision(V2);

    const response = await harness.authed(provider, {
      method: 'GET',
      url: `/api/apis/${apiId}/revisions/${first.id}`,
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json<GetApiRevisionResponse>();
    assert.equal(body.raw_spec, V1, 'the original bytes, not a re-serialisation');
    assert.equal(body.content_type, 'application/json');

    // …and the current-spec endpoint still answers with the current one.
    const current = await harness.authed(provider, {
      method: 'GET',
      url: `/api/apis/${apiId}/spec`,
    });
    assert.equal(current.json<GetApiSpecResponse>().raw_spec, V2);
  });

  it('reviews what a rollback would change, in the direction it would go', async () => {
    const original = (await revisions()).items[0];
    assert.ok(original);
    await publishRevision(V2);

    const response = await harness.authed(provider, {
      method: 'GET',
      url: `/api/apis/${apiId}/revisions/${original.id}/diff`,
    });
    assert.equal(response.statusCode, 200, response.body);
    const { diff } = response.json<GetApiRevisionDiffResponse>();

    // From what is live (V2) to what the rollback would restore (V1).
    assert.equal(diff.from?.parsed_version, '2.0.0');
    assert.equal(diff.to?.parsed_version, '1.0.0');
    assert.deepEqual(diff.added_operations, [{ method: 'POST', path: '/invoices' }]);
    assert.deepEqual(diff.removed_operations, [{ method: 'GET', path: '/receipts' }]);
    assert.deepEqual(diff.potentially_breaking, [{ method: 'GET', path: '/receipts' }]);
    assert.deepEqual(diff.removed_paths, ['/receipts']);
    assert.equal(diff.changed, true);
  });

  it('reviews an upload before it replaces anything', async () => {
    const response = await harness.authed(provider, {
      method: 'POST',
      url: `/api/apis/${apiId}/spec/diff`,
      payload: { spec: V2 },
    });
    assert.equal(response.statusCode, 200, response.body);
    const { diff } = response.json<DiffApiSpecResponse>();
    assert.equal(diff.from?.parsed_version, '1.0.0');
    assert.equal(diff.to, null, 'the proposed document is not a stored revision');
    assert.deepEqual(diff.potentially_breaking, [{ method: 'POST', path: '/invoices' }]);

    // Read-only: nothing was stored and the API still serves V1.
    assert.equal((await revisions()).total, 1);
    const current = await harness.authed(provider, {
      method: 'GET',
      url: `/api/apis/${apiId}/spec`,
    });
    assert.equal(current.json<GetApiSpecResponse>().raw_spec, V1);
  });

  it('refuses to review a document it would refuse to publish', async () => {
    const response = await harness.authed(provider, {
      method: 'POST',
      url: `/api/apis/${apiId}/spec/diff`,
      payload: { spec: '{"not":"an openapi document"}' },
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json<{ error: { code: string } }>().error.code, 'SPEC_INVALID');
  });

  it('rolls back by appending a new revision, leaving history intact', async () => {
    const original = (await revisions()).items[0];
    assert.ok(original);
    await publishRevision(V2);

    const before = await harness.store.apis.findById(apiId);
    assert.ok(before);

    const response = await harness.authed(provider, {
      method: 'POST',
      url: `/api/apis/${apiId}/revisions/${original.id}/rollback`,
      payload: {},
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json<RollbackApiSpecResponse>();

    // A *new* revision, carrying the old document.
    assert.notEqual(body.spec.id, original.id);
    assert.equal(body.spec.is_current, true);
    assert.equal(body.spec.rolled_back_from_id, original.id);
    assert.equal(body.spec.parsed_version, '1.0.0');

    const page = await revisions();
    assert.equal(page.total, 3, 'history was appended to, not rewritten');
    const replayed = page.items.find((item) => item.id === original.id);
    assert.ok(replayed, 'the restored revision is still in history');
    assert.equal(replayed.is_current, false);
    assert.equal(replayed.rolled_back_from_id, null, 'its own row was not rewritten');

    // Identity, ownership, grants and gateway address are all untouched.
    const after = await harness.store.apis.findById(apiId);
    assert.equal(after?.id, before.id);
    assert.equal(after?.slug, before.slug);
    assert.equal(after?.owner_user_id, before.owner_user_id);
    assert.equal(after?.ferrum_proxy_id, before.ferrum_proxy_id, 'the same proxy, not a new one');
    assert.equal(body.api.listen_path, `/nexus/${before.slug}`);

    // And the API now serves the restored document.
    const current = await harness.authed(provider, {
      method: 'GET',
      url: `/api/apis/${apiId}/spec`,
    });
    assert.equal(current.json<GetApiSpecResponse>().raw_spec, V1);

    const audited = await harness.auditRows(AuditAction.API_SPEC_ROLLBACK);
    const row = audited.find((entry) => entry.target_id === apiId);
    assert.ok(row, 'a rollback is named as one in the log');
    assert.equal(row.details.restored_from_spec_id, original.id);
    assert.equal(row.details.spec_id, body.spec.id);
  });

  it('rolls a `routes` API back and regenerates its validator', async () => {
    const published = await harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: {
        name: 'History Routed',
        slug: 'history-routed',
        spec: V1,
        auth_plugin: 'key_auth',
        requestable: true,
        visibility: 'public',
        spec_enforcement: 'routes',
      },
    });
    assert.equal(published.statusCode, 201, published.body);
    const routedId = published.json<PublishApiResponse>().api.id;
    const proxyId = (await harness.store.apis.findById(routedId))?.ferrum_proxy_id;
    assert.ok(proxyId);

    const first = (
      await harness
        .authed(provider, { method: 'GET', url: `/api/apis/${routedId}/revisions` })
        .then((response) => response.json<ListApiRevisionsResponse>())
    ).items[0];
    assert.ok(first);

    const revised = await harness.authed(provider, {
      method: 'PUT',
      url: `/api/apis/${routedId}/spec`,
      payload: { spec: V2 },
    });
    assert.equal(revised.statusCode, 200, revised.body);
    const afterUpload = harness.edge.apiSpecForProxy(proxyId, 'nexus');
    assert.ok(afterUpload);
    const uploadedPaths = (afterUpload.document as { paths: Record<string, unknown> }).paths;
    assert.ok('/receipts' in uploadedPaths, 'the gateway took the new document');

    const rolled = await harness.authed(provider, {
      method: 'POST',
      url: `/api/apis/${routedId}/revisions/${first.id}/rollback`,
      payload: {},
    });
    assert.equal(rolled.statusCode, 200, rolled.body);

    // The gateway's operation table follows the catalog, and the proxy is the
    // same one — a rollback never deletes and republishes.
    const afterRollback = harness.edge.apiSpecForProxy(proxyId, 'nexus');
    assert.ok(afterRollback);
    const rolledPaths = (afterRollback.document as { paths: Record<string, unknown> }).paths;
    assert.ok(!('/receipts' in rolledPaths), 'the restored document is what the gateway enforces');
    assert.equal((await harness.store.apis.findById(routedId))?.ferrum_proxy_id, proxyId);
  });

  it('does not claim a rollback the gateway refused', async () => {
    const original = (await revisions()).items[0];
    assert.ok(original);
    await publishRevision(V2);

    // These two revisions declare the same `servers`, so a `docs_only`
    // revision writes nothing to the proxy — the gateway call it *does* make
    // is the existence check, and failing that is what a rollback aimed at an
    // unreachable gateway looks like.
    harness.edge.queueFailure(503, { error: 'unavailable' }, '/proxies/', 'GET');
    const failed = await harness.authed(provider, {
      method: 'POST',
      url: `/api/apis/${apiId}/revisions/${original.id}/rollback`,
      payload: {},
    });
    assert.ok(failed.statusCode >= 400, failed.body);

    // No partial write: the catalog still shows what it showed before.
    const page = await revisions();
    assert.equal(page.total, 2, 'no revision was appended');
    assert.equal(page.items[0]?.parsed_version, '2.0.0', 'the current revision did not move');
    assert.equal(
      (await harness.auditRows(AuditAction.API_SPEC_ROLLBACK)).length,
      0,
      'a failed rollback is not logged as one that happened',
    );
  });

  it('refuses a revision that is not retained, or not this API’s', async () => {
    const missing = await harness.authed(provider, {
      method: 'POST',
      url: `/api/apis/${apiId}/revisions/00000000-0000-4000-8000-000000000000/rollback`,
      payload: {},
    });
    assert.equal(missing.statusCode, 404, missing.body);

    // Another API's revision is absent here, not forbidden — the endpoint must
    // not confirm that an id exists somewhere else.
    const otherApi = await harness.authed(other, {
      method: 'POST',
      url: '/api/apis',
      payload: {
        name: 'Other Billing',
        slug: 'other-billing',
        spec: V1,
        auth_plugin: 'key_auth',
        requestable: true,
        visibility: 'public',
      },
    });
    assert.equal(otherApi.statusCode, 201, otherApi.body);
    const foreign = await harness.authed(other, {
      method: 'GET',
      url: `/api/apis/${otherApi.json<PublishApiResponse>().api.id}/revisions`,
    });
    const foreignRevision = foreign.json<ListApiRevisionsResponse>().items[0];
    assert.ok(foreignRevision);

    const crossed = await harness.authed(provider, {
      method: 'GET',
      url: `/api/apis/${apiId}/revisions/${foreignRevision.id}`,
    });
    assert.equal(crossed.statusCode, 404, crossed.body);
  });

  it('refuses to roll back to the revision that is already current', async () => {
    const current = (await revisions()).items[0];
    assert.ok(current);
    const response = await harness.authed(provider, {
      method: 'POST',
      url: `/api/apis/${apiId}/revisions/${current.id}/rollback`,
      payload: {},
    });
    assert.equal(response.statusCode, 409, response.body);
  });

  it('keeps history endpoints owner-or-admin', async () => {
    const stranger = await harness.authed(other, {
      method: 'GET',
      url: `/api/apis/${apiId}/revisions`,
    });
    assert.equal(stranger.statusCode, 403, stranger.body);

    const asAdmin = await harness.authed(admin, {
      method: 'GET',
      url: `/api/apis/${apiId}/revisions`,
    });
    assert.equal(asAdmin.statusCode, 200, asAdmin.body);
  });

  it('enforces retention, and says so when the target is gone', async () => {
    const limited = await buildTestApp({ env: { NEXUS_SPEC_HISTORY_LIMIT: '1' } });
    try {
      const owner = await limited.registerUser({ email: 'retention@example.test' });
      const published = await limited.authed(owner, {
        method: 'POST',
        url: '/api/apis',
        payload: {
          name: 'Retention Billing',
          slug: 'retention-billing',
          spec: V1,
          auth_plugin: 'key_auth',
          requestable: true,
          visibility: 'public',
        },
      });
      assert.equal(published.statusCode, 201, published.body);
      const id = published.json<PublishApiResponse>().api.id;
      const oldest = (
        await limited
          .authed(owner, { method: 'GET', url: `/api/apis/${id}/revisions` })
          .then((response) => response.json<ListApiRevisionsResponse>())
      ).items[0];
      assert.ok(oldest);

      for (const version of ['2.0.0', '3.0.0']) {
        const revised = await limited.authed(owner, {
          method: 'PUT',
          url: `/api/apis/${id}/spec`,
          payload: { spec: spec(version, [['/invoices', 'get']]) },
        });
        assert.equal(revised.statusCode, 200, revised.body);
      }

      // The current revision plus one historical one: the first is gone.
      const page = await limited
        .authed(owner, { method: 'GET', url: `/api/apis/${id}/revisions` })
        .then((response) => response.json<ListApiRevisionsResponse>());
      assert.equal(page.total, 2);
      assert.ok(!page.items.some((item) => item.id === oldest.id));

      const expired = await limited.authed(owner, {
        method: 'POST',
        url: `/api/apis/${id}/revisions/${oldest.id}/rollback`,
        payload: {},
      });
      assert.equal(expired.statusCode, 404, expired.body);
      assert.equal(
        (
          await limited.authed(owner, { method: 'GET', url: `/api/apis/${id}/revisions` })
        ).json<ListApiRevisionsResponse>().total,
        2,
        'the refusal wrote nothing',
      );
    } finally {
      await limited.close();
    }
  });
});
