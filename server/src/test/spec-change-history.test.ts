/**
 * The consumer-facing change history of an API's specification — issue #448.
 *
 * Each revision that replaces another records what it changed, and the
 * catalog serves those summaries to whoever may read the API's documentation,
 * under exactly the detail page's visibility rule. What these tests pin:
 *
 * - a summary is recorded for an upload and for a rollback, and an identical
 *   re-upload records one that says nothing changed;
 * - summaries outlive the revision documents retention prunes;
 * - nothing but the summary crosses the endpoint: no document, no servers, no
 *   descriptions;
 * - an account that may not read a private API gets the same `404` as for a
 *   slug that names nothing.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type {
  ApiErrorBody,
  ApproveAccessRequestResponse,
  CatalogDetailResponse,
  CatalogSpecChangeResponse,
  CatalogSpecChangesResponse,
  CreateAccessRequestResponse,
  ListApiRevisionsResponse,
  PublishApiResponse,
} from '@ferrum-nexus/shared';

import { buildTestApp, type TestApp, type TestSession } from './helpers.js';

/** A document whose description and servers the catalog must never echo. */
function spec(version: string, paths: Record<string, unknown>): string {
  return JSON.stringify({
    openapi: '3.1.0',
    info: { title: 'Billing API', version, description: 'PROVIDER-ONLY-DESCRIPTION' },
    servers: [{ url: 'https://billing.example.com:8443/v2' }],
    paths,
  });
}

const invoice = (total: string, required: string[]): Record<string, unknown> => ({
  description: 'OK',
  content: {
    'application/json': {
      schema: {
        type: 'object',
        required,
        properties: { id: { type: 'string' }, total: { type: total } },
      },
    },
  },
});

const V1 = spec('1.0.0', {
  '/invoices': {
    get: { responses: { '200': invoice('integer', ['id', 'total']) } },
    post: { responses: { '201': { description: 'Created' } } },
  },
});

const V2 = spec('2.0.0', {
  '/invoices': {
    get: {
      parameters: [{ name: 'limit', in: 'query', required: true, schema: { type: 'integer' } }],
      responses: { '200': invoice('number', ['id']) },
    },
  },
  '/receipts': { get: { responses: { '200': { description: 'OK' } } } },
});

describe('specification change history in the catalog', () => {
  let harness: TestApp;
  let provider: TestSession;
  let client: TestSession;
  let partner: TestSession;
  let stranger: TestSession;

  async function publish(
    slug: string,
    visibility: 'public' | 'private',
    session = provider,
    app = harness,
  ): Promise<string> {
    const response = await app.authed(session, {
      method: 'POST',
      url: '/api/apis',
      payload: {
        name: `History ${slug}`,
        slug,
        spec: V1,
        auth_plugin: 'key_auth',
        requestable: true,
        visibility,
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<PublishApiResponse>().api.id;
  }

  async function revise(apiId: string, document: string, app = harness): Promise<void> {
    const response = await app.authed(provider, {
      method: 'PUT',
      url: `/api/apis/${apiId}/spec`,
      payload: { spec: document },
    });
    assert.equal(response.statusCode, 200, response.body);
  }

  async function changes(
    session: TestSession,
    slug: string,
    query = '',
    app = harness,
  ): Promise<CatalogSpecChangesResponse> {
    const response = await app.authed(session, {
      method: 'GET',
      url: `/api/catalog/${slug}/changes${query}`,
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json<CatalogSpecChangesResponse>();
  }

  before(async () => {
    harness = await buildTestApp();
    await harness.registerUser({ email: 'changes-super@example.test' });
    provider = await harness.registerUser({
      email: 'changes-provider@example.test',
      role: 'provider',
    });
    client = await harness.registerUser({ email: 'changes-client@example.test' });
    partner = await harness.registerUser({ email: 'changes-partner@example.test' });
    stranger = await harness.registerUser({ email: 'changes-stranger@example.test' });
  });

  after(async () => {
    await harness.close();
  });

  it('starts empty: a first publish has nothing to compare against', async () => {
    await publish('changes-empty', 'public');
    assert.deepEqual(await changes(client, 'changes-empty'), { items: [], total: 0 });
  });

  it('records what a revision changed, classified, for anyone who may read the API', async () => {
    const apiId = await publish('changes-public', 'public');
    await revise(apiId, V2);

    const page = await changes(client, 'changes-public');
    assert.equal(page.total, 1);
    const [entry] = page.items;
    assert.ok(entry);
    assert.equal(entry.api_id, apiId);
    assert.equal(entry.kind, 'update');
    assert.equal(entry.version, '2.0.0');
    assert.equal(entry.previous_version, '1.0.0');
    assert.equal(entry.report.complete, true);
    assert.equal(entry.report.changed, true);
    assert.deepEqual(entry.report.info_changes, ['version']);

    // It describes the revision the catalog now serves.
    const detail = await harness.authed(client, {
      method: 'GET',
      url: '/api/catalog/changes-public',
    });
    assert.equal(entry.revision_id, detail.json<CatalogDetailResponse>().spec?.id);

    const found = (kind: string, location: string | null = null): boolean =>
      entry.report.changes.some(
        (change) => change.kind === kind && (location === null || change.location === location),
      );
    assert.ok(found('operation_removed'), 'POST /invoices is gone');
    assert.ok(found('operation_added'), 'GET /receipts is new');
    assert.ok(found('parameter_added', 'query limit'), 'a required parameter appeared');
    assert.ok(found('schema_type_changed', '200 application/json'), 'total widened');
    assert.ok(found('schema_property_optional', '200 application/json'), 'total may be absent');
    assert.equal(entry.report.counts.breaking, 4);
    assert.equal(entry.report.counts.non_breaking, 1);
    assert.equal(entry.report.changes[0]?.severity, 'breaking', 'breaking changes lead');

    // The same summary, addressed by revision.
    const one = await harness.authed(client, {
      method: 'GET',
      url: `/api/catalog/changes-public/changes/${entry.revision_id}`,
    });
    assert.equal(one.statusCode, 200, one.body);
    assert.deepEqual(one.json<CatalogSpecChangeResponse>(), entry);
  });

  it('never carries the document, its servers or its descriptions', async () => {
    const response = await harness.authed(client, {
      method: 'GET',
      url: '/api/catalog/changes-public/changes',
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.doesNotMatch(
      response.body,
      /billing\.example\.com|PROVIDER-ONLY|raw_spec|upstream|created_by|revision_seq/,
    );
  });

  it('labels a rollback, and records an identical re-upload as no change', async () => {
    const apiId = await publish('changes-rollback', 'public');
    await revise(apiId, V2);
    const revisions = await harness.authed(provider, {
      method: 'GET',
      url: `/api/apis/${apiId}/revisions`,
    });
    const listed = revisions.json<ListApiRevisionsResponse>().items;
    const original = listed.find((item) => item.parsed_version === '1.0.0');
    assert.ok(original);
    const rolledBack = await harness.authed(provider, {
      method: 'POST',
      url: `/api/apis/${apiId}/revisions/${original.id}/rollback`,
      payload: {},
    });
    assert.equal(rolledBack.statusCode, 200, rolledBack.body);
    await revise(apiId, V1);

    const page = await changes(client, 'changes-rollback');
    assert.equal(page.total, 3);
    const [again, rollback, update] = page.items;
    assert.equal(update?.kind, 'update');
    assert.equal(rollback?.kind, 'rollback');
    assert.equal(rollback?.version, '1.0.0');
    assert.equal(rollback?.previous_version, '2.0.0');
    // The rollback undoes the update: what was added is removed again.
    assert.ok(rollback?.report.changes.some((change) => change.kind === 'operation_removed'));
    assert.equal(again?.kind, 'update');
    assert.equal(again?.report.changed, false, 'the same document again changes nothing');
    assert.deepEqual(again?.report.changes, []);

    // Newest first, and paged.
    const second = await changes(client, 'changes-rollback', '?limit=1&offset=1');
    assert.equal(second.total, 3);
    assert.deepEqual(
      second.items.map((item) => item.id),
      [rollback?.id],
    );
  });

  it('keeps summaries after retention prunes the revisions they describe', async () => {
    const limited = await buildTestApp({ env: { NEXUS_SPEC_HISTORY_LIMIT: '1' } });
    try {
      await limited.registerUser({ email: 'changes-retention-super@example.test' });
      const owner = await limited.registerUser({
        email: 'changes-retention@example.test',
        role: 'provider',
      });
      const reader = await limited.registerUser({ email: 'changes-retention-reader@example.test' });
      const apiId = await publish('changes-retention', 'public', owner, limited);
      for (const document of [V2, V1, V2]) {
        const response = await limited.authed(owner, {
          method: 'PUT',
          url: `/api/apis/${apiId}/spec`,
          payload: { spec: document },
        });
        assert.equal(response.statusCode, 200, response.body);
      }

      const retained = await limited.authed(owner, {
        method: 'GET',
        url: `/api/apis/${apiId}/revisions`,
      });
      const kept = new Set(retained.json<ListApiRevisionsResponse>().items.map((item) => item.id));
      assert.equal(kept.size, 2, 'the current revision and one more');

      const page = await changes(reader, 'changes-retention', '', limited);
      assert.equal(page.total, 3, 'every summary is still there');
      const oldest = page.items.at(-1);
      assert.ok(oldest);
      assert.ok(!kept.has(oldest.revision_id), 'its revision has been pruned');
      const response = await limited.authed(reader, {
        method: 'GET',
        url: `/api/catalog/changes-retention/changes/${oldest.revision_id}`,
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json<CatalogSpecChangeResponse>().report.changed, true);
    } finally {
      await limited.close();
    }
  });

  describe('a private API', () => {
    let privateId: string;
    let revisionId: string;

    before(async () => {
      privateId = await publish('changes-private', 'private');
      await revise(privateId, V2);
      const owned = await changes(provider, 'changes-private');
      revisionId = owned.items[0]?.revision_id ?? '';
      assert.ok(revisionId);

      // `partner` is authorized to read it, asks for access and is approved.
      const authorized = await harness.authed(provider, {
        method: 'POST',
        url: `/api/apis/${privateId}/viewers`,
        payload: { email: 'changes-partner@example.test' },
      });
      assert.equal(authorized.statusCode, 201, authorized.body);
      const created = await harness.authed(partner, {
        method: 'POST',
        url: '/api/access-requests',
        payload: { api_id: privateId, justification: 'Integration partner.' },
      });
      assert.equal(created.statusCode, 201, created.body);
      const requestId = created.json<CreateAccessRequestResponse>().access_request.id;
      const approved = await harness.authed(provider, {
        method: 'POST',
        url: `/api/access-requests/${requestId}/approve`,
      });
      assert.equal(approved.statusCode, 200, approved.body);
      assert.equal(approved.json<ApproveAccessRequestResponse>().grant.status, 'active');
    });

    it('shows its history to a grantee', async () => {
      const page = await changes(partner, 'changes-private');
      assert.equal(page.total, 1);
      assert.equal(page.items[0]?.revision_id, revisionId);
    });

    it('answers a non-grantee exactly as for an API that does not exist', async () => {
      const urls = [
        '/api/catalog/changes-private/changes',
        `/api/catalog/changes-private/changes/${revisionId}`,
      ];
      const missing = await harness.authed(stranger, {
        method: 'GET',
        url: '/api/catalog/no-such-api/changes',
      });
      assert.equal(missing.statusCode, 404);
      for (const url of urls) {
        const response = await harness.authed(stranger, { method: 'GET', url });
        assert.equal(response.statusCode, 404, `${url}: ${response.body}`);
        assert.equal(
          response.json<ApiErrorBody>().error.code,
          missing.json<ApiErrorBody>().error.code,
        );
        assert.doesNotMatch(response.body, /PROVIDER-ONLY|billing\.example\.com|receipts/);
      }
    });

    it('does not serve another API’s revision under this one', async () => {
      const response = await harness.authed(partner, {
        method: 'GET',
        url: `/api/catalog/changes-public/changes/${revisionId}`,
      });
      assert.equal(response.statusCode, 404, response.body);
    });
  });
});
