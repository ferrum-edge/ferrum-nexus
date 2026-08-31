import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type { ApiErrorBody, Organization, Paginated, User } from '@ferrum-nexus/shared';

import { buildTestApp, TEST_PASSWORD, type TestApp, type TestSession } from './helpers.js';

function errorCode(body: string): string {
  return (JSON.parse(body) as ApiErrorBody).error.code;
}

describe('users and organizations', () => {
  let harness: TestApp;
  /** The first registered account, therefore `super_admin`. */
  let founder: TestSession;
  let admin: TestSession;
  let provider: TestSession;
  let client: TestSession;

  before(async () => {
    harness = await buildTestApp();
    founder = await harness.registerUser({ email: 'founder@example.test' });
    admin = await harness.registerUser({ email: 'admin@example.test', role: 'client' });
    provider = await harness.registerUser({ email: 'provider@example.test', role: 'provider' });
    client = await harness.registerUser({ email: 'client@example.test', role: 'client' });

    // Promote the second account so the tests have a plain admin to work with.
    const promoted = await harness.authed(founder, {
      method: 'PATCH',
      url: `/api/users/${admin.user.id}`,
      payload: { role: 'admin' },
    });
    assert.equal(promoted.statusCode, 200);
    admin = await harness.loginUser('admin@example.test');
  });

  after(async () => {
    await harness.close();
  });

  it('returns and updates the caller profile without touching role or email', async () => {
    const me = await harness.authed(client, { method: 'GET', url: '/api/users/me' });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json<{ user: User }>().user.email, 'client@example.test');

    const updated = await harness.authed(client, {
      method: 'PATCH',
      url: '/api/users/me',
      payload: { display_name: 'Renamed', company: 'Acme', role: 'super_admin' },
    });
    assert.equal(updated.statusCode, 200);
    const user = updated.json<{ user: User }>().user;
    assert.equal(user.display_name, 'Renamed');
    assert.equal(user.company, 'Acme');
    assert.equal(user.role, 'client', 'role is not reachable from the self-service route');
  });

  it('refuses a password change without the current password', async () => {
    const response = await harness.authed(client, {
      method: 'PATCH',
      url: '/api/users/me',
      payload: { new_password: 'a-brand-new-password' },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(errorCode(response.body), 'VALIDATION_FAILED');

    const wrong = await harness.authed(client, {
      method: 'PATCH',
      url: '/api/users/me',
      payload: { current_password: 'not-it-at-all', new_password: 'a-brand-new-password' },
    });
    assert.equal(wrong.statusCode, 403);
  });

  it('keeps the admin user list away from clients and providers', async () => {
    for (const session of [client, provider]) {
      const response = await harness.authed(session, { method: 'GET', url: '/api/users' });
      assert.equal(response.statusCode, 403);
      assert.equal(errorCode(response.body), 'FORBIDDEN');
    }

    const allowed = await harness.authed(admin, { method: 'GET', url: '/api/users' });
    assert.equal(allowed.statusCode, 200);
    assert.ok(allowed.json<Paginated<User>>().total >= 4);
  });

  it('filters the user list by role and search term', async () => {
    const byRole = await harness.authed(admin, {
      method: 'GET',
      url: '/api/users?role=provider',
    });
    assert.equal(byRole.statusCode, 200);
    const providers = byRole.json<Paginated<User>>();
    assert.equal(providers.total, 1);
    assert.equal(providers.items[0]?.email, 'provider@example.test');

    const bySearch = await harness.authed(admin, { method: 'GET', url: '/api/users?q=founder@' });
    assert.equal(bySearch.json<Paginated<User>>().total, 1);
  });

  it('lets only a super_admin grant an administrator role', async () => {
    const byAdmin = await harness.authed(admin, {
      method: 'PATCH',
      url: `/api/users/${client.user.id}`,
      payload: { role: 'admin' },
    });
    assert.equal(byAdmin.statusCode, 403);
    assert.equal(errorCode(byAdmin.body), 'FORBIDDEN');

    // The same admin may still move an account between the ordinary roles.
    const ordinary = await harness.authed(admin, {
      method: 'PATCH',
      url: `/api/users/${client.user.id}`,
      payload: { role: 'provider' },
    });
    assert.equal(ordinary.statusCode, 200);
    assert.equal(ordinary.json<{ user: User }>().user.role, 'provider');

    const bySuperAdmin = await harness.authed(founder, {
      method: 'PATCH',
      url: `/api/users/${client.user.id}`,
      payload: { role: 'client' },
    });
    assert.equal(bySuperAdmin.statusCode, 200);
  });

  it('refuses to demote or disable the last active super_admin', async () => {
    const demote = await harness.authed(founder, {
      method: 'PATCH',
      url: `/api/users/${founder.user.id}`,
      payload: { role: 'admin' },
    });
    assert.equal(demote.statusCode, 409);
    assert.equal(errorCode(demote.body), 'LAST_SUPER_ADMIN');

    const disable = await harness.authed(founder, {
      method: 'PATCH',
      url: `/api/users/${founder.user.id}`,
      payload: { status: 'disabled' },
    });
    assert.equal(disable.statusCode, 409);
    assert.equal(errorCode(disable.body), 'LAST_SUPER_ADMIN');
  });

  it('terminates the sessions of an account it disables', async () => {
    const victim = await harness.registerUser({ email: 'victim@example.test' });
    const beforeDisable = await harness.authed(victim, { method: 'GET', url: '/api/users/me' });
    assert.equal(beforeDisable.statusCode, 200);

    const disabled = await harness.authed(admin, {
      method: 'PATCH',
      url: `/api/users/${victim.user.id}`,
      payload: { status: 'disabled' },
    });
    assert.equal(disabled.statusCode, 200);
    assert.equal(disabled.json<{ user: User }>().user.status, 'disabled');

    const afterDisable = await harness.authed(victim, { method: 'GET', url: '/api/users/me' });
    assert.equal(afterDisable.statusCode, 401);
    assert.equal(errorCode(afterDisable.body), 'UNAUTHORIZED');

    const relogin = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'victim@example.test', password: TEST_PASSWORD },
    });
    assert.equal(relogin.statusCode, 403);
    assert.equal(errorCode(relogin.body), 'USER_DISABLED');
  });

  it('writes a role-change audit row', async () => {
    const page = await harness.store.auditLogs.list({ action: 'user.role_change' });
    assert.ok(page.total >= 1);
    const entry = page.items[0];
    assert.equal(entry?.target_type, 'user');
    assert.ok(Array.isArray((entry?.details as { changed_fields?: unknown }).changed_fields));
  });

  it('manages organizations behind the admin guard', async () => {
    const denied = await harness.authed(provider, {
      method: 'POST',
      url: '/api/organizations',
      payload: { name: 'Sneaky Inc' },
    });
    assert.equal(denied.statusCode, 403);

    const created = await harness.authed(admin, {
      method: 'POST',
      url: '/api/organizations',
      payload: { name: 'Acme Inc', description: 'Test tenant' },
    });
    assert.equal(created.statusCode, 201);
    const organization = created.json<{ organization: Organization }>().organization;

    const duplicate = await harness.authed(admin, {
      method: 'POST',
      url: '/api/organizations',
      payload: { name: 'Acme Inc' },
    });
    assert.equal(duplicate.statusCode, 409);

    const renamed = await harness.authed(admin, {
      method: 'PATCH',
      url: `/api/organizations/${organization.id}`,
      payload: { description: 'Renamed tenant' },
    });
    assert.equal(renamed.statusCode, 200);
    assert.equal(
      renamed.json<{ organization: Organization }>().organization.description,
      'Renamed tenant',
    );

    const listed = await harness.authed(admin, { method: 'GET', url: '/api/organizations' });
    assert.equal(listed.json<Paginated<Organization>>().total, 1);
  });
});
