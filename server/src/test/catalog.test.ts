import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import type {
  ApiErrorBody,
  ApproveAccessRequestResponse,
  CatalogDetailResponse,
  CatalogListResponse,
  CatalogSpecResponse,
  CreateAccessRequestResponse,
  GetApiSpecResponse,
  PublishApiResponse,
} from '@ferrum-nexus/shared';

import { createCatalogService } from '../catalog/service.js';
import {
  SAMPLE_SPEC_JSON,
  SAMPLE_SPEC_YAML,
  buildTestApp,
  type TestApp,
  type TestSession,
} from './helpers.js';

function errorCode(body: string): string {
  return (JSON.parse(body) as ApiErrorBody).error.code;
}

describe('catalog visibility', () => {
  let harness: TestApp;
  let founder: TestSession;
  let provider: TestSession;
  let otherProvider: TestSession;
  let client: TestSession;
  let grantee: TestSession;

  let publicApi: string;
  let internalApi: string;
  let retiredApi: string;

  async function publish(
    owner: TestSession,
    slug: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const response = await harness.authed(owner, {
      method: 'POST',
      url: '/api/apis',
      payload: {
        name: `API ${slug}`,
        slug,
        spec: SAMPLE_SPEC_YAML,
        auth_plugin: 'key_auth',
        requestable: true,
        visibility: 'public',
        ...overrides,
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<PublishApiResponse>().api.id;
  }

  /** Ids visible to `session` in one catalog page. */
  async function catalogIds(session: TestSession, query = ''): Promise<string[]> {
    const response = await harness.authed(session, {
      method: 'GET',
      url: `/api/catalog?limit=200${query}`,
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json<CatalogListResponse>().items.map((api) => api.id);
  }

  before(async () => {
    harness = await buildTestApp({
      env: { FERRUM_GATEWAY_PUBLIC_URL: 'https://gateway.example.test' },
    });
    founder = await harness.registerUser({ email: 'cat-founder@example.test' });
    provider = await harness.registerUser({ email: 'cat-provider@example.test', role: 'provider' });
    otherProvider = await harness.registerUser({
      email: 'cat-other@example.test',
      role: 'provider',
    });
    client = await harness.registerUser({ email: 'cat-client@example.test', role: 'client' });
    grantee = await harness.registerUser({ email: 'cat-grantee@example.test', role: 'client' });

    publicApi = await publish(provider, 'cat-public');
    internalApi = await publish(provider, 'cat-internal', { visibility: 'internal' });
    retiredApi = await publish(provider, 'cat-retired');
    await harness.authed(provider, {
      method: 'PATCH',
      url: `/api/apis/${retiredApi}`,
      payload: { status: 'retired' },
    });

    // `grantee` holds an approved grant on the internal API.
    const created = await harness.authed(grantee, {
      method: 'POST',
      url: '/api/access-requests',
      payload: { api_id: internalApi, justification: 'Approved partner.' },
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

  after(async () => {
    await harness.close();
  });

  describe('the listing matrix', () => {
    it('shows a plain client the public, published APIs only', async () => {
      const ids = await catalogIds(client);
      assert.ok(ids.includes(publicApi));
      assert.ok(!ids.includes(internalApi), 'internal APIs are unlisted for ordinary clients');
      assert.ok(!ids.includes(retiredApi), 'retired APIs leave the browse list');
    });

    it('shows an internal API to a client who already holds a grant on it', async () => {
      const ids = await catalogIds(grantee);
      assert.ok(ids.includes(internalApi), 'a grantee keeps seeing what they were approved for');
      assert.ok(!ids.includes(retiredApi));
    });

    it('shows the owner every API they publish, whatever its state', async () => {
      const ids = await catalogIds(provider);
      assert.ok(ids.includes(publicApi));
      assert.ok(ids.includes(internalApi));
      assert.ok(ids.includes(retiredApi));
    });

    it('hides another provider’s internal API from a provider without a grant', async () => {
      const ids = await catalogIds(otherProvider);
      assert.ok(ids.includes(publicApi));
      assert.ok(!ids.includes(internalApi));
    });

    it('shows an admin everything, including retired entries', async () => {
      const ids = await catalogIds(founder);
      assert.ok(ids.includes(publicApi));
      assert.ok(ids.includes(internalApi));
      assert.ok(ids.includes(retiredApi));
    });

    it('reports each viewer’s own access state on the row', async () => {
      const asOwner = await harness.authed(provider, {
        method: 'GET',
        url: '/api/catalog?limit=200',
      });
      const ownerRow = asOwner
        .json<CatalogListResponse>()
        .items.find((api) => api.id === publicApi);
      assert.equal(ownerRow?.access_state, 'owner');
      assert.equal(ownerRow?.owner?.email, 'cat-provider@example.test');

      const asGrantee = await harness.authed(grantee, {
        method: 'GET',
        url: '/api/catalog?limit=200',
      });
      const granteeRow = asGrantee
        .json<CatalogListResponse>()
        .items.find((api) => api.id === internalApi);
      assert.equal(granteeRow?.access_state, 'granted');

      const asClient = await harness.authed(client, {
        method: 'GET',
        url: '/api/catalog?limit=200',
      });
      const clientRow = asClient
        .json<CatalogListResponse>()
        .items.find((api) => api.id === publicApi);
      assert.equal(clientRow?.access_state, 'none');
    });

    it('does not expose provider-only upstream URLs', async () => {
      const list = await harness.authed(client, {
        method: 'GET',
        url: '/api/catalog?limit=200',
      });
      const row = list.json<CatalogListResponse>().items.find((api) => api.id === publicApi);
      assert.ok(row);
      assert.ok(!Object.hasOwn(row, 'upstream_url'));

      const detail = await harness.authed(client, {
        method: 'GET',
        url: '/api/catalog/cat-public',
      });
      assert.equal(detail.statusCode, 200);
      assert.ok(!Object.hasOwn(detail.json<CatalogDetailResponse>().api, 'upstream_url'));
    });

    it('reflects a pending request in the access state', async () => {
      const created = await harness.authed(client, {
        method: 'POST',
        url: '/api/access-requests',
        payload: { api_id: publicApi, justification: 'Please.' },
      });
      assert.equal(created.statusCode, 201);

      const response = await harness.authed(client, {
        method: 'GET',
        url: '/api/catalog?limit=200',
      });
      const row = response.json<CatalogListResponse>().items.find((api) => api.id === publicApi);
      assert.equal(row?.access_state, 'pending');
    });

    it('honours the q, requestable and visibility filters', async () => {
      await publish(provider, 'cat-fixed', { requestable: false });

      const byQuery = await catalogIds(client, '&q=cat-public');
      assert.deepEqual(byQuery, [publicApi]);

      const requestable = await harness.authed(client, {
        method: 'GET',
        url: '/api/catalog?limit=200&requestable=false',
      });
      assert.ok(
        requestable.json<CatalogListResponse>().items.every((api) => api.requestable === false),
      );

      const internalOnly = await harness.authed(founder, {
        method: 'GET',
        url: '/api/catalog?limit=200&visibility=internal',
      });
      assert.ok(
        internalOnly
          .json<CatalogListResponse>()
          .items.every((api) => api.visibility === 'internal'),
      );
    });

    it('paginates over the filtered set, not the raw table', async () => {
      const first = await harness.authed(client, { method: 'GET', url: '/api/catalog?limit=1' });
      const page = first.json<CatalogListResponse>();
      assert.equal(page.items.length, 1);
      assert.ok(page.total >= 2);

      const second = await harness.authed(client, {
        method: 'GET',
        url: '/api/catalog?limit=1&offset=1',
      });
      assert.notEqual(second.json<CatalogListResponse>().items[0]?.id, page.items[0]?.id);
    });
  });

  describe('detail and spec', () => {
    it('returns the API, its current spec metadata and the caller’s state', async () => {
      const response = await harness.authed(grantee, {
        method: 'GET',
        url: '/api/catalog/cat-internal',
      });
      assert.equal(response.statusCode, 200);
      const body = response.json<CatalogDetailResponse>();
      assert.equal(body.api.id, internalApi);
      assert.equal(body.api.access_state, 'granted');
      assert.equal(body.spec?.parsed_title, 'Billing API');
      assert.equal(body.my_grant?.status, 'active');
      assert.equal(body.my_request?.status, 'approved');
    });

    it('opens an unlisted internal API to anyone holding its link', async () => {
      // `internal` keeps an API out of the browse list (asserted above) without
      // making it unreadable — otherwise `internal` + `requestable` would be a
      // combination nobody could act on.
      const detail = await harness.authed(client, {
        method: 'GET',
        url: '/api/catalog/cat-internal',
      });
      assert.equal(detail.statusCode, 200);
      assert.equal(detail.json<CatalogDetailResponse>().api.visibility, 'internal');

      const spec = await harness.authed(client, {
        method: 'GET',
        url: '/api/catalog/cat-internal/spec',
      });
      assert.equal(spec.statusCode, 200);
    });

    it('lets a client request access to an internal API they were sent a link to', async () => {
      const requester = await harness.registerUser({
        email: 'cat-linked@example.test',
        role: 'client',
      });
      const response = await harness.authed(requester, {
        method: 'POST',
        url: '/api/access-requests',
        payload: { api_id: internalApi, justification: 'Sent this link by the provider.' },
      });
      assert.equal(response.statusCode, 201, response.body);
    });

    it('answers 404 — not 403 — for an API the caller may not open', async () => {
      const detail = await harness.authed(client, {
        method: 'GET',
        url: '/api/catalog/cat-retired',
      });
      assert.equal(detail.statusCode, 404);
      assert.equal(errorCode(detail.body), 'NOT_FOUND');

      const spec = await harness.authed(client, {
        method: 'GET',
        url: '/api/catalog/cat-retired/spec',
      });
      assert.equal(spec.statusCode, 404);
    });

    it('serves a normalized document in the uploaded format', async () => {
      const yaml = await harness.authed(client, {
        method: 'GET',
        url: '/api/catalog/cat-public/spec',
      });
      assert.equal(yaml.statusCode, 200);
      const yamlBody = yaml.json<CatalogSpecResponse>();
      assert.equal(yamlBody.content_type, 'application/yaml');
      assert.deepEqual(parseYaml(yamlBody.raw_spec), {
        ...parseYaml(SAMPLE_SPEC_YAML),
        servers: [{ url: 'https://gateway.example.test/nexus/cat-public' }],
      });
      assert.equal(yamlBody.parsed_title, 'Billing API');

      await publish(provider, 'cat-json', { spec: SAMPLE_SPEC_JSON });
      const json = await harness.authed(client, {
        method: 'GET',
        url: '/api/catalog/cat-json/spec',
      });
      assert.equal(json.json<CatalogSpecResponse>().content_type, 'application/json');
    });

    for (const format of ['json', 'yaml'] as const) {
      for (const visibility of ['public', 'internal'] as const) {
        it(`rewrites every server in ${visibility} ${format} specs for non-grantees`, async () => {
          const upstream = 'https://origin.example.test/private';
          const servers = [{ url: upstream, description: upstream }];
          const operation = { servers, responses: { '200': { description: 'OK' } } };
          const item = { servers, get: operation };
          const document = {
            openapi: '3.1.0',
            info: { title: 'Server projection', version: '1.0.0' },
            servers,
            paths: {
              '/invoices': {
                ...item,
                post: { ...operation, callbacks: { notify: { '{$request.body#/url}': item } } },
              },
            },
            components: {
              pathItems: { Invoices: item },
              callbacks: { notify: { '/event': item } },
            },
            webhooks: { event: item },
            'x-extra': [{ servers }],
          };
          const raw = format === 'json' ? JSON.stringify(document) : stringifyYaml(document);
          const slug = `cat-servers-${visibility}-${format}`;
          const id = await publish(provider, slug, { spec: raw, visibility });
          const response = await harness.authed(client, {
            method: 'GET',
            url: `/api/catalog/${slug}/spec`,
          });
          assert.equal(response.statusCode, 200, response.body);
          const body = response.json<CatalogSpecResponse>();
          assert.equal(body.content_type, `application/${format}`);
          assert.ok(!body.raw_spec.includes('origin.example.test'));
          const normalized: unknown =
            format === 'json' ? JSON.parse(body.raw_spec) : parseYaml(body.raw_spec);
          let count = 0;
          const checkServers = (value: unknown): void => {
            if (Array.isArray(value)) {
              value.forEach(checkServers);
            } else if (typeof value === 'object' && value !== null) {
              for (const [key, child] of Object.entries(value)) {
                if (key === 'servers') {
                  count++;
                  assert.deepEqual(child, [{ url: `https://gateway.example.test/nexus/${slug}` }]);
                } else {
                  checkServers(child);
                }
              }
            }
          };
          checkServers(normalized);
          assert.equal(count, 13);

          for (const viewer of [provider, founder]) {
            const original = await harness.authed(viewer, {
              method: 'GET',
              url: `/api/apis/${id}/spec`,
            });
            assert.equal(original.statusCode, 200, original.body);
            assert.equal(original.json<GetApiSpecResponse>().raw_spec, raw.trim());
            assert.equal(original.json<GetApiSpecResponse>().content_type, `application/${format}`);
          }
          for (const viewer of [client, otherProvider]) {
            const denied = await harness.authed(viewer, {
              method: 'GET',
              url: `/api/apis/${id}/spec`,
            });
            assert.equal(denied.statusCode, 403, denied.body);
            assert.ok(!denied.body.includes('origin.example.test'));
          }
        });
      }
    }

    it('uses only the listen path when the public gateway origin is unset', async () => {
      const catalog = createCatalogService({
        store: harness.store,
        settings: { getGatewayPublicUrl: async () => null },
      });
      const viewer = await harness.store.users.findById(client.user.id);
      assert.ok(viewer);
      const body = await catalog.spec(viewer, 'cat-public');
      assert.deepEqual(parseYaml(body.raw_spec).servers, [{ url: '/nexus/cat-public' }]);
      assert.ok(!body.raw_spec.includes('billing.example.com'));
    });

    it('fails closed without parser details for an invalid stored document', async (t) => {
      const record = await harness.store.apiSpecs.findCurrentByApi(publicApi);
      assert.ok(record);
      t.mock.method(harness.store.apiSpecs, 'findCurrentByApi', async () => ({
        ...record,
        raw_spec: '{"servers": [{"url": "https://origin.example.test"}],',
      }));
      const response = await harness.authed(client, {
        method: 'GET',
        url: '/api/catalog/cat-public/spec',
      });
      assert.equal(response.statusCode, 400, response.body);
      assert.equal(errorCode(response.body), 'SPEC_INVALID');
      assert.ok(!response.body.includes('origin.example.test'));
      assert.equal(response.json<ApiErrorBody>().error.details, undefined);
    });

    it('keeps serving the documentation of a retired API to its owner and admins', async () => {
      const asOwner = await harness.authed(provider, {
        method: 'GET',
        url: '/api/catalog/cat-retired/spec',
      });
      assert.equal(asOwner.statusCode, 200);

      const asAdmin = await harness.authed(founder, {
        method: 'GET',
        url: '/api/catalog/cat-retired',
      });
      assert.equal(asAdmin.statusCode, 200);

      const asClient = await harness.authed(client, {
        method: 'GET',
        url: '/api/catalog/cat-retired',
      });
      assert.equal(asClient.statusCode, 404);
    });

    it('requires a session for every catalog route', async () => {
      for (const url of [
        '/api/catalog',
        '/api/catalog/cat-public',
        '/api/catalog/cat-public/spec',
      ]) {
        const response = await harness.app.inject({ method: 'GET', url });
        assert.equal(response.statusCode, 401, url);
      }
    });
  });
});
