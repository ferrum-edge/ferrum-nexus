/**
 * Per-identity catalog access — issue #314.
 *
 * The catalog detail's `my_request`/`my_grant` are account-wide
 * representatives: the latest request by any identity, and the account's own
 * grant or else any application's. The access form used to gate on them, so
 * once Application A had a pending request or a grant, Application B (and the
 * account itself) could no longer ask for the same API through the UI — even
 * though the backend keeps grants and pending requests separate per
 * `(api, account, application)`.
 *
 * `GET /api/catalog/:slug/access?application_id=` answers for one identity.
 * These tests pin that it is scoped to exactly that identity, that it is
 * authorized like the detail read plus ownership of the named application (no
 * other account's state, not even for an admin), and that the duplicate-request
 * rejection it mirrors is still scoped to `application_id`.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type {
  CatalogDetailResponse,
  CatalogIdentityAccessResponse,
  CreateAccessRequestResponse,
  CreateApplicationResponse,
  ListApplicationsResponse,
  PublishApiResponse,
} from '@ferrum-nexus/shared';

import { buildTestApp, SAMPLE_SPEC_YAML, type TestApp, type TestSession } from './helpers.js';

describe('per-identity catalog access', () => {
  let harness: TestApp;
  let admin: TestSession;
  let provider: TestSession;
  let owner: TestSession;
  let other: TestSession;
  const slug = 'identity-access-api';
  let apiId: string;
  let appA: string;
  let appB: string;

  async function publish(
    apiSlug: string,
    visibility: 'public' | 'internal' | 'private' = 'public',
  ): Promise<string> {
    const response = await harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: {
        name: `Identity ${apiSlug}`,
        slug: apiSlug,
        spec: SAMPLE_SPEC_YAML,
        auth_plugin: 'key_auth',
        requestable: true,
        visibility,
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<PublishApiResponse>().api.id;
  }

  async function createApplication(session: TestSession, name: string): Promise<string> {
    const response = await harness.authed(session, {
      method: 'POST',
      url: '/api/applications',
      payload: { name },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<CreateApplicationResponse>().application.id;
  }

  async function requestAccess(
    session: TestSession,
    applicationId: string | null,
  ): Promise<{ statusCode: number; id: string | null; body: string }> {
    const response = await harness.authed(session, {
      method: 'POST',
      url: '/api/access-requests',
      payload: {
        api_id: apiId,
        justification: 'Integration access',
        ...(applicationId === null ? {} : { application_id: applicationId }),
      },
    });
    return {
      statusCode: response.statusCode,
      id:
        response.statusCode === 201
          ? response.json<CreateAccessRequestResponse>().access_request.id
          : null,
      body: response.body,
    };
  }

  async function approve(requestId: string): Promise<void> {
    const approved = await harness.authed(provider, {
      method: 'POST',
      url: `/api/access-requests/${requestId}/approve`,
      payload: {},
    });
    assert.equal(approved.statusCode, 200, approved.body);
  }

  async function identityAccess(
    session: TestSession,
    applicationId: string | null | undefined,
    apiSlug = slug,
  ): Promise<{ statusCode: number; body: CatalogIdentityAccessResponse; raw: string }> {
    const query =
      applicationId === undefined
        ? ''
        : `?application_id=${applicationId === null ? 'account' : applicationId}`;
    const response = await harness.authed(session, {
      method: 'GET',
      url: `/api/catalog/${apiSlug}/access${query}`,
    });
    return {
      statusCode: response.statusCode,
      body: response.json<CatalogIdentityAccessResponse>(),
      raw: response.body,
    };
  }

  beforeEach(async () => {
    harness = await buildTestApp();
    admin = await harness.registerUser({ email: 'identity-super@example.test' });
    provider = await harness.registerUser({
      email: 'identity-provider@example.test',
      role: 'provider',
    });
    owner = await harness.registerUser({ email: 'identity-owner@example.test', role: 'client' });
    other = await harness.registerUser({ email: 'identity-other@example.test', role: 'client' });
    apiId = await publish(slug);
    appA = await createApplication(owner, 'Application A');
    appB = await createApplication(owner, 'Application B');
  });

  afterEach(async () => {
    await harness.close();
  });

  it('reports A pending while B and the account remain requestable', async () => {
    const pendingA = await requestAccess(owner, appA);
    assert.equal(pendingA.statusCode, 201, pendingA.body);

    const a = await identityAccess(owner, appA);
    assert.equal(a.statusCode, 200, a.raw);
    assert.equal(a.body.application?.id, appA);
    assert.equal(a.body.application?.name, 'Application A');
    assert.equal(a.body.request?.id, pendingA.id);
    assert.equal(a.body.request?.status, 'pending');
    assert.equal(a.body.request?.application_id, appA);
    assert.equal(a.body.grant, null);

    // B's standing is B's own: A's pending request is not reported for it.
    const b = await identityAccess(owner, appB);
    assert.equal(b.statusCode, 200, b.raw);
    assert.equal(b.body.application?.id, appB);
    assert.equal(b.body.request, null);
    assert.equal(b.body.grant, null);

    // Neither for the account itself, with or without the explicit sentinel.
    for (const scope of [null, undefined] as const) {
      const account = await identityAccess(owner, scope);
      assert.equal(account.statusCode, 200, account.raw);
      assert.equal(account.body.application, null);
      assert.equal(account.body.request, null);
      assert.equal(account.body.grant, null);
    }

    // The account-wide representative still points at A's request — which is
    // exactly why it cannot be the form's gate.
    const detail = await harness.authed(owner, { method: 'GET', url: `/api/catalog/${slug}` });
    assert.equal(detail.json<CatalogDetailResponse>().my_request?.id, pendingA.id);

    // And B can in fact ask; the duplicate rejection is scoped to A.
    const requestB = await requestAccess(owner, appB);
    assert.equal(requestB.statusCode, 201, requestB.body);
    const duplicateA = await requestAccess(owner, appA);
    assert.equal(duplicateA.statusCode, 409, duplicateA.body);
    const afterB = await identityAccess(owner, appB);
    assert.equal(afterB.body.request?.id, requestB.id);
    assert.equal(afterB.body.request?.status, 'pending');
  });

  it('reports A granted while B stays requestable, keeping the representative grant', async () => {
    const requestA = await requestAccess(owner, appA);
    assert.equal(requestA.statusCode, 201, requestA.body);
    await approve(requestA.id!);

    const a = await identityAccess(owner, appA);
    assert.equal(a.body.grant?.status, 'active');
    assert.equal(a.body.grant?.application_id, appA);
    assert.equal(a.body.grant?.application?.name, 'Application A');
    assert.equal(a.body.request?.status, 'approved');

    const b = await identityAccess(owner, appB);
    assert.equal(b.body.grant, null);
    assert.equal(b.body.request, null);

    const account = await identityAccess(owner, null);
    assert.equal(account.body.grant, null, 'an application grant is not the account’s');

    // The detail's representative grant — what admits the caller to a
    // private API's docs — is unchanged and still reports A's grant.
    const detail = await harness.authed(owner, { method: 'GET', url: `/api/catalog/${slug}` });
    assert.equal(detail.json<CatalogDetailResponse>().my_grant?.application_id, appA);

    // A second grant for A is refused; a request for B is not.
    const duplicateA = await requestAccess(owner, appA);
    assert.equal(duplicateA.statusCode, 409, duplicateA.body);
    const requestB = await requestAccess(owner, appB);
    assert.equal(requestB.statusCode, 201, requestB.body);
  });

  it('reports an account-level grant for the account only', async () => {
    const requested = await requestAccess(owner, null);
    assert.equal(requested.statusCode, 201, requested.body);
    await approve(requested.id!);

    const account = await identityAccess(owner, null);
    assert.equal(account.body.application, null);
    assert.equal(account.body.grant?.status, 'active');
    assert.equal(account.body.grant?.application_id, null);
    assert.equal(account.body.grant?.application, undefined);

    const a = await identityAccess(owner, appA);
    assert.equal(a.body.grant, null, 'the account’s grant is not reported for its applications');
    const requestA = await requestAccess(owner, appA);
    assert.equal(requestA.statusCode, 201, requestA.body);
  });

  it('never answers for somebody else’s application, not even to an admin', async () => {
    await requestAccess(owner, appA);

    const foreign = await identityAccess(other, appA);
    assert.equal(foreign.statusCode, 404, foreign.raw);
    assert.doesNotMatch(foreign.raw, /pending/);

    const asAdmin = await identityAccess(admin, appA);
    assert.equal(asAdmin.statusCode, 404, asAdmin.raw);

    const missing = await identityAccess(owner, '00000000-0000-4000-8000-000000000000');
    assert.equal(missing.statusCode, 404, missing.raw);

    // Another account's own standing is its own: the owner's request for A
    // does not appear under `other`'s account scope.
    const theirs = await identityAccess(other, null);
    assert.equal(theirs.statusCode, 200, theirs.raw);
    assert.equal(theirs.body.request, null);
    assert.equal(theirs.body.grant, null);
  });

  it('answers for a disabled application, which keeps what it holds', async () => {
    const requestA = await requestAccess(owner, appA);
    await approve(requestA.id!);
    const disabled = await harness.authed(owner, {
      method: 'PATCH',
      url: `/api/applications/${appA}`,
      payload: { status: 'disabled' },
    });
    assert.equal(disabled.statusCode, 200, disabled.body);

    const a = await identityAccess(owner, appA);
    assert.equal(a.statusCode, 200, a.raw);
    assert.equal(a.body.application?.status, 'disabled');
    assert.equal(a.body.grant?.status, 'active');
  });

  it('refuses an API the caller may not open, before looking at any identity', async () => {
    const privateSlug = 'identity-private-api';
    await publish(privateSlug, 'private');

    for (const scope of [null, appA, '00000000-0000-4000-8000-000000000000']) {
      const response = await identityAccess(owner, scope, privateSlug);
      assert.equal(response.statusCode, 404, response.raw);
      assert.match(response.raw, /API/);
    }

    const unknown = await identityAccess(owner, null, 'no-such-api');
    assert.equal(unknown.statusCode, 404, unknown.raw);
  });

  it('validates the identity parameter and requires a session', async () => {
    const tooLong = await identityAccess(owner, 'x'.repeat(65));
    assert.equal(tooLong.statusCode, 400, tooLong.raw);

    const anonymous = await harness.app.inject({
      method: 'GET',
      url: `/api/catalog/${slug}/access`,
    });
    assert.equal(anonymous.statusCode, 401, anonymous.body);
  });

  it('lists only the caller’s own applications for a picker, even for an admin', async () => {
    await createApplication(admin, 'Admin tooling');

    // Unscoped, an admin sees every account's applications…
    const everyone = await harness.authed(admin, { method: 'GET', url: '/api/applications' });
    assert.equal(everyone.json<ListApplicationsResponse>().total, 3);

    // …while `mine` narrows to the ones they may act as.
    const mine = await harness.authed(admin, {
      method: 'GET',
      url: '/api/applications?mine=true',
    });
    const page = mine.json<ListApplicationsResponse>();
    assert.equal(page.total, 1);
    assert.equal(page.items[0]?.name, 'Admin tooling');

    // A client is always scoped to their own, and `q` searches within that.
    const searched = await harness.authed(owner, {
      method: 'GET',
      url: '/api/applications?mine=true&status=active&q=application%20b',
    });
    const found = searched.json<ListApplicationsResponse>();
    assert.deepEqual(
      found.items.map((item) => item.id),
      [appB],
    );
    assert.equal(found.total, 1);

    const oversized = await harness.authed(owner, {
      method: 'GET',
      url: `/api/applications?q=${'x'.repeat(201)}`,
    });
    assert.equal(oversized.statusCode, 400, oversized.body);
  });
});
