import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  consumerUsernameForUser,
  CSRF_COOKIE,
  SESSION_COOKIE,
  type ApiErrorBody,
  type IssueCredentialResponse,
  type Organization,
  type Paginated,
  type User,
} from '@ferrum-nexus/shared';

import {
  buildTestApp,
  cookieValue,
  TEST_PASSWORD,
  type TestApp,
  type TestSession,
} from './helpers.js';

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

  it('strips the gateway identity of an account it disables', async () => {
    const target = await harness.registerUser({ email: 'gateway-victim@example.test' });
    const username = consumerUsernameForUser(target.user.id);

    // Give the account a working gateway identity: an API key and an ACL group.
    const issued = await harness.authed(target, {
      method: 'POST',
      url: '/api/credentials',
      payload: { credential_type: 'keyauth', label: 'CI' },
    });
    assert.equal(issued.statusCode, 201, issued.body);
    const credentialId = issued.json<IssueCredentialResponse>().credential.id;

    const consumer = harness.edge.consumerByUsername(username);
    assert.ok(consumer, 'the credential provisioned a consumer');
    consumer.acl_groups = ['nexus:api:some-api:approved'];
    assert.equal(consumer.credentials.keyauth?.length, 1);

    const disabled = await harness.authed(admin, {
      method: 'PATCH',
      url: `/api/users/${target.user.id}`,
      payload: { status: 'disabled' },
    });
    assert.equal(disabled.statusCode, 200, disabled.body);

    // The gateway identity is gone, not merely the browser session: an issued
    // key needs no session, and an API published with `requestable: false`
    // carries no `access_control` plugin for an empty group list to stop.
    const after = harness.edge.consumerByUsername(username);
    assert.deepEqual(after?.acl_groups, []);
    assert.deepEqual(after?.credentials, {});

    const row = await harness.store.credentials.findById(credentialId);
    assert.equal(row?.status, 'revoked', 'the mirrored metadata follows the gateway');

    const audited = (await harness.auditRows('user.disable')).find(
      (entry) => entry.target_id === target.user.id,
    );
    const details = audited?.details as { gateway_teardown?: string; revoked_credentials?: number };
    assert.equal(details?.gateway_teardown, 'ok');
    assert.equal(details?.revoked_credentials, 1);
  });

  it('leaves the gateway teardown pending when the gateway refuses it', async () => {
    const target = await harness.registerUser({ email: 'gateway-flaky@example.test' });
    const issued = await harness.authed(target, {
      method: 'POST',
      url: '/api/credentials',
      payload: { credential_type: 'keyauth' },
    });
    assert.equal(issued.statusCode, 201, issued.body);

    harness.edge.queueFailure(500, { error: 'gateway exploded' }, '/consumers');

    const disabled = await harness.authed(admin, {
      method: 'PATCH',
      url: `/api/users/${target.user.id}`,
      payload: { status: 'disabled' },
    });
    assert.equal(disabled.statusCode, 200, 'an unreachable gateway must not leave the account on');
    const body = disabled.json<{ user: User; gateway_teardown?: string }>();
    assert.equal(body.user.status, 'disabled');
    // Not `failed`: the revocation is owed, queued and retried — reporting the
    // security operation complete is the bug this replaced.
    assert.equal(body.gateway_teardown, 'pending');

    const audited = (await harness.auditRows('user.disable')).find(
      (entry) => entry.target_id === target.user.id,
    );
    assert.equal((audited?.details as { gateway_teardown?: string }).gateway_teardown, 'pending');

    const job = await harness.store.gatewayTeardownJobs.findByUser(target.user.id);
    assert.equal(job?.status, 'pending', 'the revocation survives as durable work');
  });

  it('ends every other session when the caller changes their password', async () => {
    const owner = await harness.registerUser({ email: 'rotator@example.test' });
    const other = await harness.loginUser('rotator@example.test');
    const elsewhere = await harness.loginUser('rotator@example.test');

    for (const session of [other, elsewhere]) {
      const alive = await harness.authed(session, { method: 'GET', url: '/api/users/me' });
      assert.equal(alive.statusCode, 200);
    }

    const changed = await harness.authed(owner, {
      method: 'PATCH',
      url: '/api/users/me',
      payload: { current_password: TEST_PASSWORD, new_password: 'a-brand-new-passphrase' },
    });
    assert.equal(changed.statusCode, 200, changed.body);

    for (const session of [other, elsewhere]) {
      const dead = await harness.authed(session, { method: 'GET', url: '/api/users/me' });
      assert.equal(dead.statusCode, 401, 'a password change must not leave other sessions alive');
      assert.equal(errorCode(dead.body), 'UNAUTHORIZED');
    }

    // The caller stays signed in, on the replacement cookies from the response.
    const reissuedSession = cookieValue(changed, SESSION_COOKIE);
    const reissuedCsrf = cookieValue(changed, CSRF_COOKIE);
    assert.ok(reissuedSession, 'a replacement session cookie is set');
    assert.ok(reissuedCsrf);
    assert.notEqual(reissuedSession, owner.sessionToken, 'and it is a new session');

    const stillWorks = await harness.app.inject({
      method: 'GET',
      url: '/api/users/me',
      headers: { cookie: `${SESSION_COOKIE}=${reissuedSession}; ${CSRF_COOKIE}=${reissuedCsrf}` },
    });
    assert.equal(stillWorks.statusCode, 200, stillWorks.body);

    // The original cookie pair died with every other session.
    const oldCookies = await harness.authed(owner, { method: 'GET', url: '/api/users/me' });
    assert.equal(oldCookies.statusCode, 401);

    // …and the new password is the one that signs in.
    await harness.loginUser('rotator@example.test', 'a-brand-new-passphrase');
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
