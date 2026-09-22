/**
 * Where private visibility (#288) meets application identities (#289).
 *
 * The two features were built and tested separately, and each was right on its
 * own terms. What neither suite exercised is an account whose **only** grant
 * on a private API belongs to one of its applications — or an unauthorized
 * account reaching a private API through a surface that is not the catalog.
 * These tests pin the rules at those seams:
 *
 * - a grant is a grant whichever of the account's identities holds it, so an
 *   application-only grantee can open what the catalog lists for them;
 * - an account that already holds a grant on a private API can request access
 *   for another of its identities;
 * - the messaging surface does not let an unauthorized account attach a thread
 *   to a private API, which would hand its name and slug back in the listing.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type {
  CatalogDetailResponse,
  CatalogListResponse,
  CreateAccessRequestResponse,
  CreateApplicationResponse,
  ListThreadsResponse,
  PublishApiResponse,
} from '@ferrum-nexus/shared';

import { buildTestApp, SAMPLE_SPEC_YAML, type TestApp, type TestSession } from './helpers.js';

describe('private visibility across application identities and messaging', () => {
  let harness: TestApp;
  let provider: TestSession;
  let owner: TestSession;
  let stranger: TestSession;
  let privateId: string;
  const slug = 'seam-private';
  let appId: string;

  async function approve(requestId: string): Promise<void> {
    const approved = await harness.authed(provider, {
      method: 'POST',
      url: `/api/access-requests/${requestId}/approve`,
      payload: {},
    });
    assert.equal(approved.statusCode, 200, approved.body);
  }

  before(async () => {
    harness = await buildTestApp();
    await harness.registerUser({ email: 'seam-super@example.test' });
    provider = await harness.registerUser({
      email: 'seam-provider@example.test',
      role: 'provider',
    });
    owner = await harness.registerUser({ email: 'seam-owner@example.test', role: 'client' });
    stranger = await harness.registerUser({ email: 'seam-stranger@example.test', role: 'client' });

    const published = await harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: {
        name: 'Seam Private',
        slug,
        spec: SAMPLE_SPEC_YAML,
        auth_plugin: 'key_auth',
        requestable: true,
        visibility: 'private',
      },
    });
    assert.equal(published.statusCode, 201, published.body);
    privateId = published.json<PublishApiResponse>().api.id;

    const created = await harness.authed(owner, {
      method: 'POST',
      url: '/api/applications',
      payload: { name: 'Seam app' },
    });
    appId = created.json<CreateApplicationResponse>().application.id;

    // The owner is let in to read, requests for the *application*, is
    // approved — and is then no longer a viewer. From here on the only thing
    // connecting the account to the API is the application's grant.
    await harness.authed(provider, {
      method: 'POST',
      url: `/api/apis/${privateId}/viewers`,
      payload: { email: 'seam-owner@example.test' },
    });
    const requested = await harness.authed(owner, {
      method: 'POST',
      url: '/api/access-requests',
      payload: { api_id: privateId, justification: 'App', application_id: appId },
    });
    assert.equal(requested.statusCode, 201, requested.body);
    await approve(requested.json<CreateAccessRequestResponse>().access_request.id);
    const revoked = await harness.authed(provider, {
      method: 'DELETE',
      url: `/api/apis/${privateId}/viewers/${owner.user.id}`,
    });
    assert.equal(revoked.statusCode, 200, revoked.body);
  });

  after(async () => {
    await harness.close();
  });

  it('lets an application-only grantee open what the catalog lists for them', async () => {
    const listed = await harness.authed(owner, { method: 'GET', url: '/api/catalog' });
    assert.ok(listed.json<CatalogListResponse>().items.some((item) => item.slug === slug));

    const detail = await harness.authed(owner, { method: 'GET', url: `/api/catalog/${slug}` });
    assert.equal(detail.statusCode, 200, 'listing it and then refusing to open it is incoherent');
    assert.equal(
      detail.json<CatalogDetailResponse>().my_grant?.application_id,
      appId,
      'and the grant that admits them is the one reported',
    );

    const spec = await harness.authed(owner, { method: 'GET', url: `/api/catalog/${slug}/spec` });
    assert.equal(spec.statusCode, 200, spec.body);
  });

  it('lets an existing grantee request access for their own account', async () => {
    const requested = await harness.authed(owner, {
      method: 'POST',
      url: '/api/access-requests',
      payload: { api_id: privateId, justification: 'Account too' },
    });
    assert.equal(requested.statusCode, 201, requested.body);
  });

  it('answers a probe for a private API with 404 whatever state it is in', async () => {
    // Every refusal in the request path says something different — retired,
    // not accepting requests — so if any of them ran before the visibility
    // check, a guessed id would be an existence oracle.
    for (const patch of [{ requestable: false }, { status: 'retired' }] as const) {
      const published = await harness.authed(provider, {
        method: 'POST',
        url: '/api/apis',
        payload: {
          name: `Seam probe ${Object.keys(patch)[0]}`,
          slug: `seam-probe-${Object.keys(patch)[0]}`,
          spec: SAMPLE_SPEC_YAML,
          auth_plugin: 'key_auth',
          requestable: true,
          visibility: 'private',
        },
      });
      assert.equal(published.statusCode, 201, published.body);
      const id = published.json<PublishApiResponse>().api.id;
      const patched = await harness.authed(provider, {
        method: 'PATCH',
        url: `/api/apis/${id}`,
        payload: patch,
      });
      assert.equal(patched.statusCode, 200, patched.body);

      const probe = await harness.authed(stranger, {
        method: 'POST',
        url: '/api/access-requests',
        payload: { api_id: id, justification: 'Probe' },
      });
      assert.equal(probe.statusCode, 404, `${JSON.stringify(patch)}: ${probe.body}`);
    }
  });

  it('refuses a thread about a private API the sender cannot see', async () => {
    const response = await harness.authed(stranger, {
      method: 'POST',
      url: '/api/threads',
      payload: {
        subject: 'Probing',
        body: 'Is this real?',
        recipient_user_id: provider.user.id,
        api_id: privateId,
      },
    });
    assert.equal(response.statusCode, 404, response.body);

    const threads = await harness.authed(stranger, { method: 'GET', url: '/api/threads' });
    const body = threads.json<ListThreadsResponse>();
    assert.ok(
      !body.items.some((thread) => thread.api?.slug === slug),
      'no thread hands the private API back',
    );
  });

  it('still lets an authorized account open a thread about it', async () => {
    const response = await harness.authed(owner, {
      method: 'POST',
      url: '/api/threads',
      payload: {
        subject: 'Question',
        body: 'About the API I can call',
        recipient_user_id: provider.user.id,
        api_id: privateId,
      },
    });
    assert.equal(response.statusCode, 201, response.body);
  });
});
