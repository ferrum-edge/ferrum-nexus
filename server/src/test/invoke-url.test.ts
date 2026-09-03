/**
 * Every API the portal hands out says **where to call it**.
 *
 * `listen_path` is always known (`/<namespace>/<slug>`); `invoke_url` needs an
 * operator-supplied origin and is `null` without one, on purpose — a guessed
 * host is worse than an absent one. Both are derived per request rather than
 * stored, so the same row reports a different `invoke_url` the moment the
 * gateway address changes, with no migration.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type {
  AdminSettingsResponse,
  ApproveAccessRequestResponse,
  CatalogDetailResponse,
  CatalogListResponse,
  CreateAccessRequestResponse,
  GetApiResponse,
  ListAccessRequestsResponse,
  ListApisResponse,
  ListGrantsResponse,
  PublishApiResponse,
} from '@ferrum-nexus/shared';

import { SAMPLE_SPEC_YAML, buildTestApp, type TestApp, type TestSession } from './helpers.js';

const GATEWAY = 'https://gateway.example.com';

describe('invoke url and listen path', () => {
  let harness: TestApp;
  let founder: TestSession;
  let provider: TestSession;
  let client: TestSession;
  let apiId: string;

  async function setGateway(publicUrl: string | null): Promise<void> {
    const response = await harness.authed(founder, {
      method: 'PUT',
      url: '/api/admin/settings',
      payload: { gateway: { public_url: publicUrl } },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json<AdminSettingsResponse>().gateway.public_url, publicUrl);
  }

  async function catalogDetail(): Promise<CatalogDetailResponse['api']> {
    const response = await harness.authed(client, { method: 'GET', url: '/api/catalog/billing' });
    assert.equal(response.statusCode, 200, response.body);
    return response.json<CatalogDetailResponse>().api;
  }

  before(async () => {
    harness = await buildTestApp();
    founder = await harness.registerUser({ email: 'iu-founder@example.test' });
    provider = await harness.registerUser({ email: 'iu-provider@example.test', role: 'provider' });
    client = await harness.registerUser({ email: 'iu-client@example.test', role: 'client' });

    const published = await harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: {
        name: 'Billing',
        slug: 'billing',
        spec: SAMPLE_SPEC_YAML,
        auth_plugin: 'key_auth',
        requestable: true,
        visibility: 'public',
      },
    });
    assert.equal(published.statusCode, 201, published.body);
    const body = published.json<PublishApiResponse>();
    apiId = body.api.id;

    // The publish response itself already carries both fields.
    assert.equal(body.api.listen_path, '/nexus/billing');
    assert.equal(body.api.invoke_url, null, 'nothing is configured yet');
  });

  after(async () => {
    await harness.close();
  });

  describe('with no gateway address configured', () => {
    it('reports the listen path and a null invoke url on the catalog', async () => {
      const list = await harness.authed(client, { method: 'GET', url: '/api/catalog?limit=50' });
      assert.equal(list.statusCode, 200, list.body);
      const row = list.json<CatalogListResponse>().items.find((item) => item.id === apiId);
      assert.ok(row, 'the API is listed');
      assert.equal(row.listen_path, '/nexus/billing');
      assert.equal(row.invoke_url, null);

      const detail = await catalogDetail();
      assert.equal(detail.listen_path, '/nexus/billing');
      assert.equal(detail.invoke_url, null);
    });

    it('reports the same on the provider views', async () => {
      const list = await harness.authed(provider, { method: 'GET', url: '/api/apis' });
      assert.equal(list.statusCode, 200, list.body);
      const row = list.json<ListApisResponse>().items.find((item) => item.id === apiId);
      assert.ok(row);
      assert.equal(row.listen_path, '/nexus/billing');
      assert.equal(row.invoke_url, null);

      const detail = await harness.authed(provider, { method: 'GET', url: `/api/apis/${apiId}` });
      assert.equal(detail.statusCode, 200, detail.body);
      assert.equal(detail.json<GetApiResponse>().api.invoke_url, null);
    });
  });

  describe('once an admin publishes the gateway address', () => {
    before(async () => {
      await setGateway(GATEWAY);
    });

    it('fills the invoke url on the catalog list and detail', async () => {
      const list = await harness.authed(client, { method: 'GET', url: '/api/catalog?limit=50' });
      const row = list.json<CatalogListResponse>().items.find((item) => item.id === apiId);
      assert.ok(row);
      assert.equal(row.invoke_url, `${GATEWAY}/nexus/billing`);

      const detail = await catalogDetail();
      assert.equal(detail.invoke_url, `${GATEWAY}/nexus/billing`);
    });

    it('fills it on the provider views without a restart', async () => {
      const detail = await harness.authed(provider, { method: 'GET', url: `/api/apis/${apiId}` });
      assert.equal(detail.json<GetApiResponse>().api.invoke_url, `${GATEWAY}/nexus/billing`);
    });

    it('answers a PATCH with the derived fields too', async () => {
      // Both fields are recomputed on the way out, so a PATCH answer describes
      // the API as it is now rather than replaying a stored string.
      const patched = await harness.authed(provider, {
        method: 'PATCH',
        url: `/api/apis/${apiId}`,
        payload: { version: '3.0.0' },
      });
      assert.equal(patched.statusCode, 200, patched.body);
      const updated = patched.json<{ api: { listen_path: string; invoke_url: string | null } }>();
      assert.equal(updated.api.listen_path, '/nexus/billing');
      assert.equal(updated.api.invoke_url, `${GATEWAY}/nexus/billing`);
    });

    it('carries them on the API summary embedded in requests and grants', async () => {
      const requested = await harness.authed(client, {
        method: 'POST',
        url: '/api/access-requests',
        payload: { api_id: apiId, justification: 'Reconciling invoices nightly.' },
      });
      assert.equal(requested.statusCode, 201, requested.body);
      const requestId = requested.json<CreateAccessRequestResponse>().access_request.id;

      const listed = await harness.authed(client, {
        method: 'GET',
        url: '/api/access-requests?mine=true',
      });
      const request = listed
        .json<ListAccessRequestsResponse>()
        .items.find((item) => item.id === requestId);
      assert.ok(request?.api, 'the request embeds its API');
      assert.equal(request.api.listen_path, '/nexus/billing');
      assert.equal(request.api.invoke_url, `${GATEWAY}/nexus/billing`);

      const approved = await harness.authed(provider, {
        method: 'POST',
        url: `/api/access-requests/${requestId}/approve`,
        payload: {},
      });
      assert.equal(approved.statusCode, 200, approved.body);
      const grant = approved.json<ApproveAccessRequestResponse>().grant;
      assert.equal(grant.status, 'active');

      const grants = await harness.authed(client, { method: 'GET', url: '/api/grants?mine=true' });
      const mine = grants.json<ListGrantsResponse>().items.find((row) => row.id === grant.id);
      assert.ok(mine?.api, 'the grant embeds its API');
      assert.equal(mine.api.listen_path, '/nexus/billing');
      assert.equal(
        mine.api.invoke_url,
        `${GATEWAY}/nexus/billing`,
        'a client can read the call address off their own grant',
      );
    });

    it('goes back to null when the address is cleared', async () => {
      await setGateway(null);
      const detail = await catalogDetail();
      assert.equal(detail.invoke_url, null);
      assert.equal(detail.listen_path, '/nexus/billing');
    });
  });
});

describe('FERRUM_GATEWAY_PUBLIC_URL as the default', () => {
  let harness: TestApp;
  let founder: TestSession;

  before(async () => {
    harness = await buildTestApp({ env: { FERRUM_GATEWAY_PUBLIC_URL: 'http://127.0.0.1:8000/' } });
    founder = await harness.registerUser({ email: 'env-founder@example.test' });
    const published = await harness.authed(founder, {
      method: 'POST',
      url: '/api/apis',
      payload: {
        name: 'Shipping',
        slug: 'shipping',
        spec: SAMPLE_SPEC_YAML,
        auth_plugin: 'key_auth',
        requestable: false,
        visibility: 'public',
      },
    });
    assert.equal(published.statusCode, 201, published.body);
  });

  after(async () => {
    await harness.close();
  });

  it('normalises the environment value and uses it when nothing is stored', async () => {
    const settings = await harness.authed(founder, { method: 'GET', url: '/api/admin/settings' });
    assert.equal(
      settings.json<AdminSettingsResponse>().gateway.public_url,
      'http://127.0.0.1:8000',
      'the trailing slash is stripped',
    );

    const detail = await harness.authed(founder, { method: 'GET', url: '/api/catalog/shipping' });
    assert.equal(detail.statusCode, 200, detail.body);
    assert.equal(
      detail.json<CatalogDetailResponse>().api.invoke_url,
      'http://127.0.0.1:8000/nexus/shipping',
    );
  });

  it('lets a stored setting override it', async () => {
    const saved = await harness.authed(founder, {
      method: 'PUT',
      url: '/api/admin/settings',
      payload: { gateway: { public_url: 'https://edge.example.com' } },
    });
    assert.equal(saved.statusCode, 200, saved.body);

    const detail = await harness.authed(founder, { method: 'GET', url: '/api/catalog/shipping' });
    assert.equal(
      detail.json<CatalogDetailResponse>().api.invoke_url,
      'https://edge.example.com/nexus/shipping',
    );
  });

  it('falls back to the environment value again once the override is cleared', async () => {
    const cleared = await harness.authed(founder, {
      method: 'PUT',
      url: '/api/admin/settings',
      payload: { gateway: { public_url: null } },
    });
    assert.equal(cleared.statusCode, 200, cleared.body);
    assert.equal(
      cleared.json<AdminSettingsResponse>().gateway.public_url,
      'http://127.0.0.1:8000',
      'clearing the override exposes the env default, not null',
    );

    const detail = await harness.authed(founder, { method: 'GET', url: '/api/catalog/shipping' });
    assert.equal(
      detail.json<CatalogDetailResponse>().api.invoke_url,
      'http://127.0.0.1:8000/nexus/shipping',
    );
  });
});
