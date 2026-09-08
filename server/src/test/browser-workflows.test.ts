/**
 * The server halves of the five documented workflow steps the browser could not
 * complete (issue #178).
 *
 * Each case is the exact call the repaired control now makes, so a regression in
 * the contract shows up here rather than as a control that silently stops
 * working: the broadcast audience that has to include every administrative role,
 * the registration policy the public branding payload now carries, the
 * organization assignment and directory filters behind the user editor, a
 * provider-initiated thread with a named counterparty, and an administrator
 * reaching somebody else's API workspace without god mode.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  type ApproveAccessRequestResponse,
  type BrandingResponse,
  type CreateAccessRequestResponse,
  type CreateOrganizationResponse,
  type CreateThreadResponse,
  type GetApiResponse,
  type ListUsersResponse,
  type MassEmailResponse,
  type PublishApiResponse,
  type UpdateUserResponse,
} from '@ferrum-nexus/shared';

import {
  SAMPLE_SPEC_YAML,
  TEST_BOOTSTRAP_TOKEN,
  TEST_PASSWORD,
  buildTestApp,
  type TestApp,
  type TestSession,
} from './helpers.js';

describe('browser workflow contracts', () => {
  let harness: TestApp;
  let founder: TestSession;
  let admin: TestSession;
  let provider: TestSession;
  let client: TestSession;

  before(async () => {
    harness = await buildTestApp();
    founder = await harness.registerUser({ email: 'bw-founder@example.test' });
    admin = await harness.registerUser({ email: 'bw-admin@example.test', role: 'client' });
    provider = await harness.registerUser({ email: 'bw-provider@example.test', role: 'provider' });
    client = await harness.registerUser({ email: 'bw-client@example.test', role: 'client' });

    const promoted = await harness.authed(founder, {
      method: 'PATCH',
      url: `/api/users/${admin.user.id}`,
      payload: { role: 'admin' },
    });
    assert.equal(promoted.statusCode, 200, promoted.body);
    admin = await harness.loginUser('bw-admin@example.test');
  });

  after(async () => {
    await harness.close();
  });

  /* ── A. every administrative role ─────────────────────────────────────── */

  it('reaches both administrative roles only when both are named', async () => {
    async function recipients(roles: string[]): Promise<number> {
      const response = await harness.authed(founder, {
        method: 'POST',
        url: '/api/admin/mass-email',
        payload: {
          subject: 'Incident notice',
          body_text: 'The gateway is degraded.',
          audience: { scope: 'filtered', roles, status: 'active' },
          idempotency_key: `bw-admins-${roles.join('-')}`,
        },
      });
      assert.equal(response.statusCode, 200, response.body);
      return response.json<MassEmailResponse>().recipients;
    }

    // What the composer used to send: the founder is a super_admin, so the one
    // account an "Administrator" audience reached was the promoted admin.
    assert.equal(await recipients(['admin']), 1);
    // What the "All administrative roles" control sends now.
    assert.equal(await recipients(['admin', 'super_admin']), 2);
  });

  it('accepts the guide’s explicit audience of one for a pre-send test', async () => {
    const response = await harness.authed(founder, {
      method: 'POST',
      url: '/api/admin/mass-email',
      payload: {
        subject: 'Proof copy',
        body_text: 'Checking the plain-text body.',
        audience: { scope: 'explicit', user_ids: [founder.user.id] },
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json<MassEmailResponse>(), { enqueued: 1, recipients: 1 });
  });

  /* ── B. the registration policy the sign-up form reads ────────────────── */

  it('publishes the registration policy the register form has to obey', async () => {
    const before = await harness.app.inject({ method: 'GET', url: '/api/branding' });
    assert.deepEqual(before.json<BrandingResponse>().registration, {
      open_registration: true,
      allowed_roles: ['client', 'provider'],
    });

    const saved = await harness.authed(founder, {
      method: 'PUT',
      url: '/api/admin/settings',
      payload: { registration: { allowed_roles: ['client'] } },
    });
    assert.equal(saved.statusCode, 200, saved.body);

    const after = await harness.app.inject({ method: 'GET', url: '/api/branding' });
    assert.deepEqual(after.json<BrandingResponse>().registration, {
      open_registration: true,
      allowed_roles: ['client'],
    });

    // The policy the payload now advertises is the one the server enforces.
    const refused = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: 'bw-refused@example.test',
        password: TEST_PASSWORD,
        display_name: 'Refused',
        role: 'provider',
        bootstrap_token: TEST_BOOTSTRAP_TOKEN,
      },
    });
    assert.equal(refused.statusCode, 403, refused.body);

    const accepted = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: 'bw-accepted@example.test',
        password: TEST_PASSWORD,
        display_name: 'Accepted',
        role: 'client',
        bootstrap_token: TEST_BOOTSTRAP_TOKEN,
      },
    });
    assert.equal(accepted.statusCode, 201, accepted.body);

    const restored = await harness.authed(founder, {
      method: 'PUT',
      url: '/api/admin/settings',
      payload: { registration: { allowed_roles: ['client', 'provider'] } },
    });
    assert.equal(restored.statusCode, 200, restored.body);
  });

  /* ── C. organizations and directory filters ───────────────────────────── */

  it('assigns an organization and filters the directory by it and by status', async () => {
    const created = await harness.authed(admin, {
      method: 'POST',
      url: '/api/organizations',
      payload: { name: 'Acme', description: null },
    });
    assert.equal(created.statusCode, 201, created.body);
    const orgId = created.json<CreateOrganizationResponse>().organization.id;

    const assigned = await harness.authed(admin, {
      method: 'PATCH',
      url: `/api/users/${client.user.id}`,
      payload: { org_id: orgId, display_name: 'Acme Client' },
    });
    assert.equal(assigned.statusCode, 200, assigned.body);
    const updated = assigned.json<UpdateUserResponse>().user;
    assert.equal(updated.org_id, orgId);
    assert.equal(updated.display_name, 'Acme Client');

    const byOrg = await harness.authed(admin, {
      method: 'GET',
      url: `/api/users?org_id=${orgId}`,
    });
    assert.equal(byOrg.statusCode, 200, byOrg.body);
    assert.deepEqual(
      byOrg.json<ListUsersResponse>().items.map((user) => user.id),
      [client.user.id],
    );

    const byStatus = await harness.authed(admin, {
      method: 'GET',
      url: '/api/users?status=disabled',
    });
    assert.equal(byStatus.statusCode, 200, byStatus.body);
    assert.equal(byStatus.json<ListUsersResponse>().items.length, 0);

    // Undo the assignment so later cases see the account unchanged.
    const cleared = await harness.authed(admin, {
      method: 'PATCH',
      url: `/api/users/${client.user.id}`,
      payload: { org_id: null },
    });
    assert.equal(cleared.statusCode, 200, cleared.body);
    assert.equal(cleared.json<UpdateUserResponse>().user.org_id, null);
  });

  /* ── D & E. provider messaging and the admin's route into a workspace ─── */

  it('lets a provider open a thread with a requester and an admin manage the API', async () => {
    const published = await harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: {
        name: 'Billing',
        slug: 'bw-billing',
        spec: SAMPLE_SPEC_YAML,
        auth_plugin: 'key_auth',
        requestable: true,
        visibility: 'public',
      },
    });
    assert.equal(published.statusCode, 201, published.body);
    const apiId = published.json<PublishApiResponse>().api.id;

    const requested = await harness.authed(client, {
      method: 'POST',
      url: '/api/access-requests',
      payload: { api_id: apiId, justification: 'Short.' },
    });
    assert.equal(requested.statusCode, 201, requested.body);
    const requestId = requested.json<CreateAccessRequestResponse>().access_request.id;

    // D: the provider clarifies the thin justification before deciding.
    const thread = await harness.authed(provider, {
      method: 'POST',
      url: '/api/threads',
      payload: {
        subject: 'About your access request',
        recipient_user_id: client.user.id,
        api_id: apiId,
        body: 'Could you say which integration needs this?',
      },
    });
    assert.equal(thread.statusCode, 201, thread.body);
    assert.equal(thread.json<CreateThreadResponse>().thread.api_id, apiId);

    // E: the admin reaches the workspace of an API they do not own, and acts.
    const workspace = await harness.authed(admin, { method: 'GET', url: `/api/apis/${apiId}` });
    assert.equal(workspace.statusCode, 200, workspace.body);
    assert.equal(workspace.json<GetApiResponse>().api.id, apiId);
    assert.equal(workspace.json<GetApiResponse>().stats.pending_requests, 1);

    const approved = await harness.authed(admin, {
      method: 'POST',
      url: `/api/access-requests/${requestId}/approve`,
      payload: { decision_note: null },
    });
    assert.equal(approved.statusCode, 200, approved.body);
    assert.equal(approved.json<ApproveAccessRequestResponse>().grant.api_id, apiId);
  });
});
