/**
 * Permission-enforced private API documentation — issue #288.
 *
 * Nexus already had `internal`, which means **unlisted, not secret**: a
 * provider hands somebody a link and they can read the docs and ask for
 * access. That is a good answer for "keep it out of the shop window" and the
 * wrong one for a confidential API shared with two named partners, who should
 * be the only accounts that can read it at all.
 *
 * So `private` is a third value rather than a redefinition of the second —
 * `internal` still means exactly what it meant — and these tests pin both:
 * the new mode enforces, and the old one is unchanged.
 *
 * The other thing they pin is the separation the feature turns on: an
 * authorization lets an account *read the documentation*. It is not a grant.
 * It writes no ACL group, touches no consumer, reaches no gateway, and an
 * authorized viewer still has to request access and be approved before they
 * can call anything.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  aclGroupForApi,
  consumerUsernameForUser,
  type AuthorizeApiViewerResponse,
  type CatalogDetailResponse,
  type CatalogListResponse,
  type ListApiViewersResponse,
  type PublishApiResponse,
} from '@ferrum-nexus/shared';

import { AuditAction } from '../audit/service.js';
import { buildTestApp, SAMPLE_SPEC_YAML, type TestApp, type TestSession } from './helpers.js';

describe('private API visibility', () => {
  let harness: TestApp;
  let admin: TestSession;
  let provider: TestSession;
  let partner: TestSession;
  let stranger: TestSession;
  let publicId: string;
  let internalId: string;
  let privateId: string;
  let privateSlug: string;

  async function publish(
    slug: string,
    visibility: 'public' | 'internal' | 'private',
  ): Promise<string> {
    const response = await harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: {
        name: `Visibility ${slug}`,
        slug,
        spec: SAMPLE_SPEC_YAML,
        auth_plugin: 'key_auth',
        requestable: true,
        visibility,
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<PublishApiResponse>().api.id;
  }

  /** The slugs `session` sees when browsing the whole catalog. */
  async function browse(session: TestSession): Promise<string[]> {
    const response = await harness.authed(session, {
      method: 'GET',
      url: '/api/catalog?limit=100',
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json<CatalogListResponse>().items.map((api) => api.slug);
  }

  async function openDetail(session: TestSession, slug: string): Promise<number> {
    const response = await harness.authed(session, {
      method: 'GET',
      url: `/api/catalog/${slug}`,
    });
    return response.statusCode;
  }

  async function openSpec(session: TestSession, slug: string): Promise<number> {
    const response = await harness.authed(session, {
      method: 'GET',
      url: `/api/catalog/${slug}/spec`,
    });
    return response.statusCode;
  }

  before(async () => {
    harness = await buildTestApp();
    admin = await harness.registerUser({ email: 'private-super@example.test' });
    provider = await harness.registerUser({
      email: 'private-provider@example.test',
      role: 'provider',
    });
    partner = await harness.registerUser({ email: 'private-partner@example.test', role: 'client' });
    stranger = await harness.registerUser({
      email: 'private-stranger@example.test',
      role: 'client',
    });

    publicId = await publish('vis-public', 'public');
    internalId = await publish('vis-internal', 'internal');
    privateId = await publish('vis-private', 'private');
    privateSlug = 'vis-private';
  });

  after(async () => {
    await harness.close();
  });

  it('keeps `internal` exactly as it was: unlisted, but openable by link', async () => {
    assert.ok(!(await browse(stranger)).includes('vis-internal'), 'still unlisted');
    assert.equal(await openDetail(stranger, 'vis-internal'), 200, 'still openable');
    assert.equal(await openSpec(stranger, 'vis-internal'), 200, 'and still readable');
  });

  it('hides a private API from an unrelated account entirely', async () => {
    const slugs = await browse(stranger);
    assert.ok(slugs.includes('vis-public'));
    assert.ok(!slugs.includes(privateSlug), 'not listed');

    // Knowing the slug is not access, and the refusal is `404` rather than
    // `403` so the endpoint does not confirm that the slug names anything.
    assert.equal(await openDetail(stranger, privateSlug), 404, 'not openable');
    assert.equal(await openSpec(stranger, privateSlug), 404, 'specification not readable');
  });

  it('does not let an unauthorized account request access to one', async () => {
    const response = await harness.authed(stranger, {
      method: 'POST',
      url: '/api/access-requests',
      payload: { api_id: privateId, justification: 'Let me in' },
    });
    assert.equal(response.statusCode, 404, response.body);
  });

  it('shows it to the owner and to administrators', async () => {
    assert.ok((await browse(provider)).includes(privateSlug));
    assert.equal(await openDetail(provider, privateSlug), 200);
    assert.ok((await browse(admin)).includes(privateSlug));
    assert.equal(await openSpec(admin, privateSlug), 200);
  });

  it('authorizes a named partner by email, and says it is not a grant', async () => {
    const response = await harness.authed(provider, {
      method: 'POST',
      url: `/api/apis/${privateId}/viewers`,
      payload: { email: 'private-partner@example.test', note: 'Design partner' },
    });
    assert.equal(response.statusCode, 201, response.body);
    const { viewer } = response.json<AuthorizeApiViewerResponse>();
    assert.equal(viewer.user_id, partner.user.id);
    assert.equal(viewer.user?.email, 'private-partner@example.test');
    assert.equal(viewer.note, 'Design partner');
    assert.equal(viewer.granted_by, provider.user.id);

    // Read access, and nothing else. No grant row, no ACL group on the
    // partner's gateway consumer, nothing on Edge.
    const grants = await harness.store.grants.list({ api_id: privateId, status: 'active' });
    assert.equal(grants.total, 0, 'authorizing a viewer writes no grant');
    const consumer = harness.edge.consumerByUsername(
      consumerUsernameForUser(partner.user.id),
      'nexus',
    );
    assert.ok(
      !consumer?.acl_groups?.includes(aclGroupForApi(privateId)),
      'and attaches no ACL group',
    );

    const audited = await harness.auditRows(AuditAction.API_VIEWER_AUTHORIZE);
    const row = audited.find((entry) => entry.target_id === privateId);
    assert.ok(row);
    assert.equal(row.details.viewer_user_id, partner.user.id);
    assert.equal(row.details.grants_invocation, false);

    // …and the partner is told, in those terms.
    const notifications = await harness.store.notifications.list({ user_id: partner.user.id });
    const notice = notifications.items.find(
      (entry) => entry.title === 'You can now view a private API',
    );
    assert.ok(notice, 'the partner is notified');
    assert.match(notice.body, /does not let you call it/);
  });

  it('lets the authorized partner list, open and read it', async () => {
    assert.ok((await browse(partner)).includes(privateSlug));
    assert.equal(await openDetail(partner, privateSlug), 200);
    assert.equal(await openSpec(partner, privateSlug), 200);
    // The search half of listing enforces the same rule, and the total with it.
    const searched = await harness.authed(partner, {
      method: 'GET',
      url: '/api/catalog?q=vis-private',
    });
    const body = searched.json<CatalogListResponse>();
    assert.equal(body.total, 1);
    assert.equal(body.items[0]?.slug, privateSlug);

    const strangerSearch = await harness.authed(stranger, {
      method: 'GET',
      url: '/api/catalog?q=vis-private',
    });
    assert.equal(
      strangerSearch.json<CatalogListResponse>().total,
      0,
      'server-side totals do not leak it either',
    );
  });

  it('still makes the partner request access before they can call it', async () => {
    const detail = await harness.authed(partner, {
      method: 'GET',
      url: `/api/catalog/${privateSlug}`,
    });
    const body = detail.json<CatalogDetailResponse>();
    assert.equal(body.my_grant, null, 'reading the docs granted nothing');
    assert.equal(body.api.access_state, 'none');

    const requested = await harness.authed(partner, {
      method: 'POST',
      url: '/api/access-requests',
      payload: { api_id: privateId, justification: 'Integration' },
    });
    assert.equal(requested.statusCode, 201, requested.body);
  });

  it('lists the authorized viewers to the provider', async () => {
    const response = await harness.authed(provider, {
      method: 'GET',
      url: `/api/apis/${privateId}/viewers`,
    });
    assert.equal(response.statusCode, 200, response.body);
    const page = response.json<ListApiViewersResponse>();
    assert.equal(page.total, 1);
    assert.equal(page.items[0]?.user?.email, 'private-partner@example.test');
  });

  it('refuses an address with no portal account, rather than storing a promise', async () => {
    const response = await harness.authed(provider, {
      method: 'POST',
      url: `/api/apis/${privateId}/viewers`,
      payload: { email: 'nobody@example.test' },
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.match(response.json<{ error: { message: string } }>().error.message, /register first/);
  });

  it('keeps the viewer list to whoever administers the API', async () => {
    const other = await harness.registerUser({
      email: 'private-other-provider@example.test',
      role: 'provider',
    });
    const listed = await harness.authed(other, {
      method: 'GET',
      url: `/api/apis/${privateId}/viewers`,
    });
    assert.equal(listed.statusCode, 403, listed.body);

    const invited = await harness.authed(other, {
      method: 'POST',
      url: `/api/apis/${privateId}/viewers`,
      payload: { email: 'private-stranger@example.test' },
    });
    assert.equal(invited.statusCode, 403, invited.body);
    assert.equal(await openDetail(stranger, privateSlug), 404, 'and nothing changed');
  });

  it('revokes the authorization consistently across every read', async () => {
    const revoked = await harness.authed(provider, {
      method: 'DELETE',
      url: `/api/apis/${privateId}/viewers/${partner.user.id}`,
    });
    assert.equal(revoked.statusCode, 200, revoked.body);

    assert.ok(!(await browse(partner)).includes(privateSlug), 'gone from the browse list');
    assert.equal(await openDetail(partner, privateSlug), 404, 'and from the detail page');
    assert.equal(await openSpec(partner, privateSlug), 404, 'and from the specification');

    const audited = await harness.auditRows(AuditAction.API_VIEWER_REVOKE);
    const row = audited.find((entry) => entry.target_id === privateId);
    assert.ok(row);
    assert.equal(row.details.revoked_grant, false);
  });

  it('keeps an approved client reading it even without an authorization', async () => {
    // The partner's earlier access request, approved: a grant is enough on its
    // own, because somebody who may call the API may certainly read its docs.
    const pending = await harness.store.accessRequests.list({
      api_id: privateId,
      user_id: partner.user.id,
      status: 'pending',
    });
    const requestId = pending.items[0]?.id;
    assert.ok(requestId);
    const approved = await harness.authed(provider, {
      method: 'POST',
      url: `/api/access-requests/${requestId}/approve`,
      payload: {},
    });
    assert.equal(approved.statusCode, 200, approved.body);

    assert.ok(!(await harness.store.apiViewers.find(privateId, partner.user.id)));
    assert.ok((await browse(partner)).includes(privateSlug));
    assert.equal(await openDetail(partner, privateSlug), 200);
  });

  it('leaves public APIs alone throughout', async () => {
    const slugs = await browse(stranger);
    assert.ok(slugs.includes('vis-public'));
    assert.equal(await openDetail(stranger, 'vis-public'), 200);
    assert.ok(publicId && internalId, 'both fixtures were published');
  });
});
