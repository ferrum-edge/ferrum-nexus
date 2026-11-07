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
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import {
  aclGroupForApi,
  consumerUsernameForUser,
  type AccessRequest,
  type ApproveAccessRequestResponse,
  type AuthorizeApiViewerResponse,
  type CatalogDetailResponse,
  type CatalogListResponse,
  type CreateAccessRequestResponse,
  type CreateThreadResponse,
  type GetThreadResponse,
  type Grant,
  type ListAccessRequestsResponse,
  type ListApiViewersResponse,
  type ListGrantsResponse,
  type ListThreadsResponse,
  type MessageThread,
  type PublishApiResponse,
} from '@ferrum-nexus/shared';

import { AuditAction } from '../audit/service.js';
import { buildTestApp, SAMPLE_SPEC_YAML, type TestApp, type TestSession } from './helpers.js';

const DOES_NOT_ACCEPT_ACCESS = /does not accept access requests/;
const DOES_NOT_LET_YOU = /does not let you call it/;
const REGISTER_FIRST = /register first/;
const ALREADY_HAVE_ACCESS = /already have access/;

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
    requestable = true,
  ): Promise<string> {
    const response = await harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: {
        name: `Visibility ${slug}`,
        slug,
        spec: SAMPLE_SPEC_YAML,
        auth_plugin: 'key_auth',
        requestable,
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

  it('conceals private API state before returning requestability errors', async () => {
    const notRequestableId = await publish('vis-private-closed', 'private', false);
    const retiredId = await publish('vis-private-retired', 'private');
    const retired = await harness.authed(provider, {
      method: 'PATCH',
      url: `/api/apis/${retiredId}`,
      payload: { status: 'retired' },
    });
    assert.equal(retired.statusCode, 200, retired.body);

    for (const apiId of [notRequestableId, retiredId]) {
      const concealed = await harness.authed(stranger, {
        method: 'POST',
        url: '/api/access-requests',
        payload: { api_id: apiId, justification: 'Tell me about it' },
      });
      assert.equal(concealed.statusCode, 404, concealed.body);
    }

    const adminResponse = await harness.authed(admin, {
      method: 'POST',
      url: '/api/access-requests',
      payload: { api_id: notRequestableId, justification: 'Administrative check' },
    });
    assert.equal(adminResponse.statusCode, 409, adminResponse.body);
    assert.match(adminResponse.body, DOES_NOT_ACCEPT_ACCESS);
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
    assert.match(notice.body, DOES_NOT_LET_YOU);
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
    assert.match(response.json<{ error: { message: string } }>().error.message, REGISTER_FIRST);
  });

  it('answers for an administrator exactly as for an account that does not exist', async () => {
    // Administrators read every API, so there is nothing to authorize — but a
    // distinct "that is an administrator" answer made this endpoint an oracle
    // for which addresses hold the admin role (issue #344).
    /** Status and body of one authorization attempt. */
    async function authorize(payload: Record<string, string>): Promise<[number, unknown]> {
      const response = await harness.authed(provider, {
        method: 'POST',
        url: `/api/apis/${privateId}/viewers`,
        payload,
      });
      return [response.statusCode, response.json()];
    }

    const byUnknownEmail = await authorize({ email: 'nobody@example.test' });
    const byAdminEmail = await authorize({ email: 'private-super@example.test' });
    assert.equal(byAdminEmail[0], 400);
    assert.deepEqual(byAdminEmail, byUnknownEmail);

    const byUnknownId = await authorize({ user_id: randomUUID() });
    const byAdminId = await authorize({ user_id: admin.user.id });
    assert.equal(byAdminId[0], 400);
    assert.deepEqual(byAdminId, byUnknownId);

    assert.equal(
      await harness.store.apiViewers.find(privateId, admin.user.id),
      null,
      'and nothing was written for the administrator',
    );
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

    const requestedAgain = await harness.authed(partner, {
      method: 'POST',
      url: '/api/access-requests',
      payload: { api_id: privateId, justification: 'Again' },
    });
    assert.equal(requestedAgain.statusCode, 409, requestedAgain.body);
    assert.match(requestedAgain.body, ALREADY_HAVE_ACCESS);
  });

  it('leaves public APIs alone throughout', async () => {
    const slugs = await browse(stranger);
    assert.ok(slugs.includes('vis-public'));
    assert.equal(await openDetail(stranger, 'vis-public'), 200);
    assert.ok(publicId && internalId, 'both fixtures were published');
  });
});

/**
 * The rows an account keeps after it loses read access — its access requests,
 * its grants, its message threads — embed a summary of their API read from the
 * API's current row. The private rule was checked when each row was written;
 * these tests pin that it is checked again on every read, so a former reader
 * keeps `api_id` but stops seeing the API's later name, version, address and
 * tools while the catalog answers it `404`.
 */
describe('API summaries embedded in an account’s own rows', () => {
  let harness: TestApp;
  let admin: TestSession;
  let provider: TestSession;

  async function publish(slug: string, visibility: 'public' | 'private'): Promise<string> {
    const response = await harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: {
        name: `Summary ${slug}`,
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

  async function patchApi(apiId: string, payload: Record<string, string>): Promise<void> {
    const response = await harness.authed(provider, {
      method: 'PATCH',
      url: `/api/apis/${apiId}`,
      payload,
    });
    assert.equal(response.statusCode, 200, response.body);
  }

  async function authorizeViewer(apiId: string, session: TestSession): Promise<void> {
    const response = await harness.authed(provider, {
      method: 'POST',
      url: `/api/apis/${apiId}/viewers`,
      payload: { user_id: session.user.id },
    });
    assert.equal(response.statusCode, 201, response.body);
  }

  async function revokeViewer(apiId: string, session: TestSession): Promise<void> {
    const response = await harness.authed(provider, {
      method: 'DELETE',
      url: `/api/apis/${apiId}/viewers/${session.user.id}`,
    });
    assert.equal(response.statusCode, 200, response.body);
  }

  async function requestAccess(session: TestSession, apiId: string): Promise<AccessRequest> {
    const response = await harness.authed(session, {
      method: 'POST',
      url: '/api/access-requests',
      payload: { api_id: apiId, justification: 'Integration' },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<CreateAccessRequestResponse>().access_request;
  }

  async function openThread(session: TestSession, apiId: string): Promise<MessageThread> {
    const response = await harness.authed(session, {
      method: 'POST',
      url: '/api/threads',
      payload: {
        subject: 'About the API',
        body: 'A question',
        recipient_user_id: provider.user.id,
        api_id: apiId,
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<CreateThreadResponse>().thread;
  }

  /** `session`'s access requests on `apiId`, as its own listing returns them. */
  async function listRequests(session: TestSession, apiId: string): Promise<AccessRequest[]> {
    const response = await harness.authed(session, {
      method: 'GET',
      url: `/api/access-requests?api_id=${apiId}`,
    });
    assert.equal(response.statusCode, 200, response.body);
    const items = response.json<ListAccessRequestsResponse>().items;
    assert.ok(items.length > 0, 'the rows themselves stay listed');
    return items;
  }

  /** `session`'s grants on `apiId`, as its own listing returns them. */
  async function listGrants(session: TestSession, apiId: string): Promise<Grant[]> {
    const response = await harness.authed(session, {
      method: 'GET',
      url: `/api/grants?api_id=${apiId}`,
    });
    assert.equal(response.statusCode, 200, response.body);
    const items = response.json<ListGrantsResponse>().items;
    assert.ok(items.length > 0, 'the rows themselves stay listed');
    return items;
  }

  /** The thread as `session` sees it in its listing and on its own page. */
  async function readThread(
    session: TestSession,
    threadId: string,
  ): Promise<{ listed: MessageThread; detail: GetThreadResponse; raw: string }> {
    const list = await harness.authed(session, { method: 'GET', url: '/api/threads' });
    assert.equal(list.statusCode, 200, list.body);
    const listed = list.json<ListThreadsResponse>().items.find((entry) => entry.id === threadId);
    assert.ok(listed, 'the thread itself stays listed');
    const detail = await harness.authed(session, {
      method: 'GET',
      url: `/api/threads/${threadId}`,
    });
    assert.equal(detail.statusCode, 200, detail.body);
    return { listed, detail: detail.json<GetThreadResponse>(), raw: list.body + detail.body };
  }

  before(async () => {
    harness = await buildTestApp();
    admin = await harness.registerUser({ email: 'summary-super@example.test' });
    provider = await harness.registerUser({
      email: 'summary-provider@example.test',
      role: 'provider',
    });
  });

  after(async () => {
    await harness.close();
  });

  it('drops the summary from a former viewer’s requests and threads once revoked', async () => {
    const apiId = await publish('summary-viewer', 'private');
    const former = await harness.registerUser({
      email: 'summary-former-viewer@example.test',
      role: 'client',
    });
    await authorizeViewer(apiId, former);
    const created = await requestAccess(former, apiId);
    assert.equal(created.api?.name, 'Summary summary-viewer', 'an authorized viewer sees it');
    const thread = await openThread(former, apiId);
    assert.equal(thread.api?.name, 'Summary summary-viewer');

    await revokeViewer(apiId, former);
    await patchApi(apiId, { name: 'Renamed after the revoke' });
    const catalog = await harness.authed(former, {
      method: 'GET',
      url: '/api/catalog/summary-viewer',
    });
    assert.equal(catalog.statusCode, 404, 'the catalog refuses the former viewer');

    const [request] = await listRequests(former, apiId);
    assert.equal(request?.api_id, apiId, 'the row keeps its api_id');
    assert.equal(request?.api, undefined, 'and loses the summary');

    const read = await readThread(former, thread.id);
    assert.equal(read.listed.api_id, apiId);
    assert.equal(read.listed.api, undefined, 'the thread listing drops it');
    assert.equal(read.detail.api, undefined, 'and so does the thread page');
    assert.ok(!read.raw.includes('Renamed after the revoke'), 'the new name never reaches them');

    // The owner and an administrator still read the live summary.
    const [ownerView] = await listRequests(provider, apiId);
    assert.equal(ownerView?.api?.name, 'Renamed after the revoke');
    const [adminView] = await listRequests(admin, apiId);
    assert.equal(adminView?.api?.name, 'Renamed after the revoke');
    const ownerThread = await readThread(provider, thread.id);
    assert.equal(ownerThread.detail.api?.name, 'Renamed after the revoke');
  });

  it('keeps it for an active grantee, and drops it once the grant is revoked', async () => {
    const apiId = await publish('summary-grant', 'private');
    const grantee = await harness.registerUser({
      email: 'summary-grantee@example.test',
      role: 'client',
    });
    await authorizeViewer(apiId, grantee);
    const created = await requestAccess(grantee, apiId);
    const approved = await harness.authed(provider, {
      method: 'POST',
      url: `/api/access-requests/${created.id}/approve`,
      payload: {},
    });
    assert.equal(approved.statusCode, 200, approved.body);
    const { grant } = approved.json<ApproveAccessRequestResponse>();

    // The grant alone is read access: withdrawing the authorization changes nothing.
    await revokeViewer(apiId, grantee);
    const [active] = await listGrants(grantee, apiId);
    assert.equal(active?.api?.name, 'Summary summary-grant', 'an active grantee sees it');

    const revoked = await harness.authed(provider, {
      method: 'POST',
      url: `/api/grants/${grant.id}/revoke`,
      payload: {},
    });
    assert.equal(revoked.statusCode, 200, revoked.body);
    await patchApi(apiId, { name: 'Renamed after the grant' });

    const [held] = await listGrants(grantee, apiId);
    assert.equal(held?.status, 'revoked');
    assert.equal(held?.api_id, apiId);
    assert.equal(held?.api, undefined, 'the revoked grant loses the summary');
    const [request] = await listRequests(grantee, apiId);
    assert.equal(request?.api, undefined, 'and so does the request that led to it');

    const [adminView] = await listGrants(admin, apiId);
    assert.equal(adminView?.api?.name, 'Renamed after the grant');
  });

  it('drops it from rows written while the API was public once it turns private', async () => {
    const apiId = await publish('summary-flip', 'public');
    const early = await harness.registerUser({
      email: 'summary-early@example.test',
      role: 'client',
    });
    await requestAccess(early, apiId);
    const thread = await openThread(early, apiId);
    const [earlier] = await listRequests(early, apiId);
    assert.equal(earlier?.api?.name, 'Summary summary-flip', 'a public API is anyone’s to read');

    await patchApi(apiId, { visibility: 'private', name: 'Renamed once private' });

    const [request] = await listRequests(early, apiId);
    assert.equal(request?.api_id, apiId);
    assert.equal(request?.api, undefined);
    const read = await readThread(early, thread.id);
    assert.equal(read.listed.api, undefined);
    assert.equal(read.detail.api, undefined);
    assert.ok(!read.raw.includes('Renamed once private'));

    const [ownerView] = await listRequests(provider, apiId);
    assert.equal(ownerView?.api?.name, 'Renamed once private');
  });
});
