/**
 * Application-scoped identities — issue #289.
 *
 * The claim under test is the one that makes the feature worth having: two
 * applications owned by **one** account, approved for different APIs, cannot
 * reach each other's. That is not a UI property. It holds because each
 * application is its own Ferrum consumer, and ACL groups live on consumers —
 * so these tests read the mock gateway's consumers directly rather than
 * trusting the portal's own view of who has what.
 *
 * The other half is compatibility. Account-scoped access is unchanged and is
 * still what an omitted `application_id` means, so the suite checks that an
 * account credential keeps exactly the access it had, and that an application
 * grant never leaks onto the account's own consumer.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  aclGroupForApi,
  consumerUsernameForApplication,
  consumerUsernameForUser,
  type CreateAccessRequestResponse,
  type CreateApplicationResponse,
  type IssueCredentialResponse,
  type ListAccessRequestsResponse,
  type ListApplicationsResponse,
  type ListCredentialsResponse,
  type ListGrantsResponse,
  type PublishApiResponse,
} from '@ferrum-nexus/shared';

import { AuditAction } from '../audit/service.js';
import { buildTestApp, SAMPLE_SPEC_YAML, type TestApp, type TestSession } from './helpers.js';

const NAMESPACE = 'nexus';

describe('application-scoped identities', () => {
  let harness: TestApp;
  let provider: TestSession;
  let owner: TestSession;
  let other: TestSession;
  let apiX: string;
  let apiY: string;
  let appA: string;
  let appB: string;

  async function publish(slug: string): Promise<string> {
    const response = await harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: {
        name: `App ${slug}`,
        slug,
        spec: SAMPLE_SPEC_YAML,
        auth_plugin: 'key_auth',
        requestable: true,
        visibility: 'public',
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<PublishApiResponse>().api.id;
  }

  async function createApplication(session: TestSession, name: string): Promise<string> {
    const response = await harness.authed(session, {
      method: 'POST',
      url: '/api/applications',
      payload: { name, description: `${name} integration` },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<CreateApplicationResponse>().application.id;
  }

  /** Request access for one identity and have the provider approve it. */
  async function grant(
    session: TestSession,
    apiId: string,
    applicationId: string | null,
  ): Promise<void> {
    const requested = await harness.authed(session, {
      method: 'POST',
      url: '/api/access-requests',
      payload: {
        api_id: apiId,
        justification: 'Integration access',
        ...(applicationId === null ? {} : { application_id: applicationId }),
      },
    });
    assert.equal(requested.statusCode, 201, requested.body);
    const requestId = requested.json<CreateAccessRequestResponse>().access_request.id;
    const approved = await harness.authed(provider, {
      method: 'POST',
      url: `/api/access-requests/${requestId}/approve`,
      payload: {},
    });
    assert.equal(approved.statusCode, 200, approved.body);
  }

  /** The ACL groups the gateway holds for one identity's consumer. */
  function groupsOf(applicationId: string | null, userId = owner.user.id): string[] {
    const username =
      applicationId === null
        ? consumerUsernameForUser(userId)
        : consumerUsernameForApplication(applicationId);
    return harness.edge.consumerByUsername(username, NAMESPACE)?.acl_groups ?? [];
  }

  beforeEach(async () => {
    harness = await buildTestApp();
    await harness.registerUser({ email: 'apps-super@example.test' });
    provider = await harness.registerUser({
      email: 'apps-provider@example.test',
      role: 'provider',
    });
    owner = await harness.registerUser({ email: 'apps-owner@example.test', role: 'client' });
    other = await harness.registerUser({ email: 'apps-other@example.test', role: 'client' });

    apiX = await publish('app-api-x');
    apiY = await publish('app-api-y');
    appA = await createApplication(owner, 'Application A');
    appB = await createApplication(owner, 'Application B');
  });

  afterEach(async () => {
    await harness.close();
  });

  it('keeps one owner’s two applications on independent approved API sets', async () => {
    await grant(owner, apiX, appA);
    await grant(owner, apiY, appB);

    // The whole claim, read off the gateway: A matches X and not Y, B the
    // other way round.
    assert.deepEqual(groupsOf(appA), [aclGroupForApi(apiX)]);
    assert.deepEqual(groupsOf(appB), [aclGroupForApi(apiY)]);

    // And nothing landed on the account's own identity, which would have
    // handed every account credential both APIs.
    assert.deepEqual(groupsOf(null), []);
  });

  it('issues, rotates and revokes credentials per application', async () => {
    await grant(owner, apiX, appA);

    const issued = await harness.authed(owner, {
      method: 'POST',
      url: '/api/credentials',
      payload: { credential_type: 'keyauth', application_id: appA },
    });
    assert.equal(issued.statusCode, 201, issued.body);
    const body = issued.json<IssueCredentialResponse>();
    assert.equal(body.consumer_username, consumerUsernameForApplication(appA));
    assert.equal(body.credential.application_id, appA);

    // The material is on the application's consumer, where its groups are.
    const consumer = harness.edge.consumerByUsername(
      consumerUsernameForApplication(appA),
      NAMESPACE,
    );
    assert.ok(consumer);
    assert.ok((consumer.credentials?.keyauth ?? []).length > 0);
    assert.deepEqual(
      harness.edge.consumerByUsername(consumerUsernameForApplication(appB), NAMESPACE),
      undefined,
      'an application with no access and no credential has no gateway identity yet',
    );

    const rotated = await harness.authed(owner, {
      method: 'POST',
      url: `/api/credentials/${body.credential.id}/rotate`,
      payload: {},
    });
    assert.equal(rotated.statusCode, 200, rotated.body);
    assert.equal(
      rotated.json<IssueCredentialResponse>().credential.application_id,
      appA,
      'a rotation never moves a credential between identities',
    );

    const scoped = await harness.authed(owner, {
      method: 'GET',
      url: `/api/credentials?application_id=${appA}`,
    });
    const listed = scoped.json<ListCredentialsResponse>();
    assert.ok(listed.items.every((item) => item.application_id === appA));

    const accountOnly = await harness.authed(owner, {
      method: 'GET',
      url: '/api/credentials?application_id=account',
    });
    assert.equal(
      accountOnly.json<ListCredentialsResponse>().total,
      0,
      'the account itself holds none of these',
    );
  });

  it('approves and revokes one application without touching the other', async () => {
    await grant(owner, apiX, appA);
    await grant(owner, apiX, appB);
    assert.deepEqual(groupsOf(appA), [aclGroupForApi(apiX)]);
    assert.deepEqual(groupsOf(appB), [aclGroupForApi(apiX)]);

    const grants = await harness.authed(provider, {
      method: 'GET',
      url: `/api/grants?api_id=${apiX}`,
    });
    const rows = grants.json<ListGrantsResponse>().items;
    const forA = rows.find((row) => row.application_id === appA);
    assert.ok(forA, 'each identity holds its own grant for the same API');
    assert.equal(forA.application?.name, 'Application A');

    const revoked = await harness.authed(provider, {
      method: 'POST',
      url: `/api/grants/${forA.id}/revoke`,
      payload: { reason: 'Rotating partners' },
    });
    assert.equal(revoked.statusCode, 200, revoked.body);

    assert.deepEqual(groupsOf(appA), [], 'A lost it');
    assert.deepEqual(groupsOf(appB), [aclGroupForApi(apiX)], 'B kept it');
  });

  it('shows the provider which application is asking', async () => {
    await harness.authed(owner, {
      method: 'POST',
      url: '/api/access-requests',
      payload: { api_id: apiX, justification: 'For A', application_id: appA },
    });
    const inbox = await harness.authed(provider, {
      method: 'GET',
      url: `/api/access-requests?api_id=${apiX}`,
    });
    const request = inbox.json<ListAccessRequestsResponse>().items[0];
    assert.ok(request);
    assert.equal(request.application_id, appA);
    assert.equal(request.application?.name, 'Application A');
    assert.equal(request.requester?.email, 'apps-owner@example.test');
  });

  it('leaves account-scoped access exactly as it was', async () => {
    await grant(owner, apiX, null);
    assert.deepEqual(groupsOf(null), [aclGroupForApi(apiX)]);

    const issued = await harness.authed(owner, {
      method: 'POST',
      url: '/api/credentials',
      payload: { credential_type: 'keyauth' },
    });
    assert.equal(issued.statusCode, 201, issued.body);
    const body = issued.json<IssueCredentialResponse>();
    assert.equal(body.consumer_username, consumerUsernameForUser(owner.user.id));
    assert.equal(body.credential.application_id, null);

    // …and an account grant is independent of an application one, both ways.
    await grant(owner, apiX, appA);
    assert.deepEqual(groupsOf(null), [aclGroupForApi(apiX)]);
    assert.deepEqual(groupsOf(appA), [aclGroupForApi(apiX)]);
  });

  it('refuses to act as somebody else’s application', async () => {
    const requested = await harness.authed(other, {
      method: 'POST',
      url: '/api/access-requests',
      payload: { api_id: apiX, justification: 'Not mine', application_id: appA },
    });
    assert.equal(requested.statusCode, 403, requested.body);

    const issued = await harness.authed(other, {
      method: 'POST',
      url: '/api/credentials',
      payload: { credential_type: 'keyauth', application_id: appA },
    });
    assert.equal(issued.statusCode, 403, issued.body);

    // Not even an administrator: acting as an application means acquiring a
    // secret that authenticates as it.
    const admin = await harness.loginUser('apps-super@example.test');
    const asAdmin = await harness.authed(admin, {
      method: 'POST',
      url: '/api/credentials',
      payload: { credential_type: 'keyauth', application_id: appA },
    });
    assert.equal(asAdmin.statusCode, 403, asAdmin.body);
  });

  it('refuses new access and new credentials for a disabled application', async () => {
    const disabled = await harness.authed(owner, {
      method: 'PATCH',
      url: `/api/applications/${appA}`,
      payload: { status: 'disabled' },
    });
    assert.equal(disabled.statusCode, 200, disabled.body);

    const requested = await harness.authed(owner, {
      method: 'POST',
      url: '/api/access-requests',
      payload: { api_id: apiX, justification: 'After disable', application_id: appA },
    });
    assert.equal(requested.statusCode, 409, requested.body);

    const issued = await harness.authed(owner, {
      method: 'POST',
      url: '/api/credentials',
      payload: { credential_type: 'keyauth', application_id: appA },
    });
    assert.equal(issued.statusCode, 409, issued.body);

    // Disabling revokes nothing, and the audit row says so out loud.
    const rows = await harness.auditRows(AuditAction.APPLICATION_UPDATE);
    const row = rows.find((entry) => entry.target_id === appA);
    assert.equal(row?.details.revoked_existing_access, false);
  });

  it('refuses to approve a request whose application was disabled after it was filed', async () => {
    // The documented contract is that a disabled application acquires no new
    // access. A request filed while it was active is exactly the case a check
    // at request time alone does not cover.
    const requested = await harness.authed(owner, {
      method: 'POST',
      url: '/api/access-requests',
      payload: { api_id: apiX, justification: 'Before the disable', application_id: appA },
    });
    assert.equal(requested.statusCode, 201, requested.body);
    const requestId = requested.json<CreateAccessRequestResponse>().access_request.id;

    const disabled = await harness.authed(owner, {
      method: 'PATCH',
      url: `/api/applications/${appA}`,
      payload: { status: 'disabled' },
    });
    assert.equal(disabled.statusCode, 200, disabled.body);

    const approved = await harness.authed(provider, {
      method: 'POST',
      url: `/api/access-requests/${requestId}/approve`,
      payload: {},
    });
    assert.equal(approved.statusCode, 409, approved.body);
    assert.deepEqual(groupsOf(appA), [], 'and nothing reached the gateway');
    const still = await harness.store.accessRequests.findById(requestId);
    assert.equal(still?.status, 'pending', 'the request is left for a decision once re-enabled');
  });

  it('refuses to rotate a disabled application’s credential into a new secret', async () => {
    await grant(owner, apiX, appA);
    const issued = await harness.authed(owner, {
      method: 'POST',
      url: '/api/credentials',
      payload: { credential_type: 'keyauth', application_id: appA },
    });
    const credentialId = issued.json<IssueCredentialResponse>().credential.id;
    await harness.authed(owner, {
      method: 'PATCH',
      url: `/api/applications/${appA}`,
      payload: { status: 'disabled' },
    });

    const rotated = await harness.authed(owner, {
      method: 'POST',
      url: `/api/credentials/${credentialId}/rotate`,
      payload: {},
    });
    assert.equal(rotated.statusCode, 409, rotated.body);

    // Revoking is still allowed — it takes access away rather than adding it.
    const revoked = await harness.authed(owner, {
      method: 'DELETE',
      url: `/api/credentials/${credentialId}`,
    });
    assert.equal(revoked.statusCode, 200, revoked.body);
  });

  it('takes the gateway identity down when the application is deleted', async () => {
    await grant(owner, apiX, appA);
    await harness.authed(owner, {
      method: 'POST',
      url: '/api/credentials',
      payload: { credential_type: 'keyauth', application_id: appA },
    });
    assert.ok(harness.edge.consumerByUsername(consumerUsernameForApplication(appA), NAMESPACE));

    const deleted = await harness.authed(owner, {
      method: 'DELETE',
      url: `/api/applications/${appA}`,
    });
    assert.equal(deleted.statusCode, 200, deleted.body);
    assert.deepEqual(deleted.json<{ revoked_grants: number; revoked_credentials: number }>(), {
      revoked_grants: 1,
      revoked_credentials: 1,
    });

    assert.equal(
      harness.edge.consumerByUsername(consumerUsernameForApplication(appA), NAMESPACE),
      undefined,
      'the gateway identity goes with it',
    );
    assert.equal(await harness.store.applications.findById(appA), null);
    assert.equal(
      (await harness.store.grants.list({ application_id: appA })).total,
      0,
      'and the cascade takes its grants',
    );
  });

  it('strips every identity when the account is disabled, and restores each separately', async () => {
    await grant(owner, apiX, appA);
    await grant(owner, apiY, appB);
    await grant(owner, apiX, null);

    const superAdmin = await harness.loginUser('apps-super@example.test');
    const disabled = await harness.authed(superAdmin, {
      method: 'PATCH',
      url: `/api/users/${owner.user.id}`,
      payload: { status: 'disabled' },
    });
    assert.equal(disabled.statusCode, 200, disabled.body);
    await harness.services.teardown.tick();

    // An application identity is a separate consumer carrying its own
    // approvals, so every one of them has to be stripped — leaving one with
    // its groups would leave the offboarding half-done. They are *stripped*
    // rather than deleted, like the account's own consumer and unlike a
    // disposable test consumer: an application is a lasting identity, and
    // re-enabling has to be able to give each one its own approvals back.
    assert.deepEqual(groupsOf(appA), []);
    assert.deepEqual(groupsOf(appB), []);
    assert.deepEqual(groupsOf(null), []);
    for (const id of [appA, appB]) {
      const consumer = harness.edge.consumerByUsername(
        consumerUsernameForApplication(id),
        NAMESPACE,
      );
      assert.deepEqual(consumer?.credentials ?? {}, {}, 'and its credential material is gone');
    }

    const reenabled = await harness.authed(superAdmin, {
      method: 'PATCH',
      url: `/api/users/${owner.user.id}`,
      payload: { status: 'active' },
    });
    assert.equal(reenabled.statusCode, 200, reenabled.body);

    // Restored per identity, not pooled: A gets X back and not Y.
    assert.deepEqual(groupsOf(appA), [aclGroupForApi(apiX)]);
    assert.deepEqual(groupsOf(appB), [aclGroupForApi(apiY)]);
    assert.deepEqual(groupsOf(null), [aclGroupForApi(apiX)]);
  });

  it('refuses to report a re-enable as done when an identity with grants has no mapping', async () => {
    await grant(owner, apiX, appA);
    await grant(owner, apiY, null);
    const superAdmin = await harness.loginUser('apps-super@example.test');
    const disabled = await harness.authed(superAdmin, {
      method: 'PATCH',
      url: `/api/users/${owner.user.id}`,
      payload: { status: 'disabled' },
    });
    assert.equal(disabled.statusCode, 200, disabled.body);
    await harness.services.teardown.tick();

    // The account's own mapping goes missing; its application keeps its own.
    const canonical = await harness.store.consumers.findByUserAndNamespace(
      owner.user.id,
      NAMESPACE,
    );
    assert.ok(canonical);
    await harness.store.consumers.delete(canonical.id);

    // Restoring only the application and answering 200 would leave the
    // account's own grant unrestored with nothing saying so.
    const reenabled = await harness.authed(superAdmin, {
      method: 'PATCH',
      url: `/api/users/${owner.user.id}`,
      payload: { status: 'active' },
    });
    assert.equal(reenabled.statusCode, 502, reenabled.body);
    assert.match(reenabled.body, /no gateway consumer mapping/);
  });

  it('repairs an orphaned application consumer with that application’s grants', async () => {
    await grant(owner, apiX, appA);
    await grant(owner, apiY, appB);

    // A rebuilt gateway: every stored id points at nothing.
    harness.edge.consumers.clear();

    const report = await harness.services.reconciliation.scan();
    assert.equal(report.status, 'orphaned');
    const orphanA = report.orphaned_consumers.find((entry) => entry.application_id === appA);
    assert.ok(orphanA, 'an application consumer is reported as its own orphan');
    assert.equal(orphanA.ferrum_username, consumerUsernameForApplication(appA));

    const superAdmin = await harness.loginUser('apps-super@example.test');
    const repaired = await harness.authed(superAdmin, {
      method: 'POST',
      url: '/api/admin/gateway/repair',
      payload: { all: true, reason: 'Gateway rebuild' },
    });
    assert.equal(repaired.statusCode, 200, repaired.body);

    // Each identity gets back its *own* approvals. Replaying the account's
    // whole grant list here would give both applications both APIs.
    assert.deepEqual(groupsOf(appA), [aclGroupForApi(apiX)]);
    assert.deepEqual(groupsOf(appB), [aclGroupForApi(apiY)]);
  });

  it('lists only the caller’s applications, with their counts', async () => {
    await grant(owner, apiX, appA);

    const mine = await harness.authed(owner, { method: 'GET', url: '/api/applications' });
    const page = mine.json<ListApplicationsResponse>();
    assert.equal(page.total, 2);
    const a = page.items.find((item) => item.id === appA);
    assert.equal(a?.active_grants, 1);
    assert.equal(a?.active_credentials, 0);

    const theirs = await harness.authed(other, { method: 'GET', url: '/api/applications' });
    assert.equal(theirs.json<ListApplicationsResponse>().total, 0);

    const foreign = await harness.authed(other, {
      method: 'GET',
      url: `/api/applications/${appA}`,
    });
    assert.equal(foreign.statusCode, 404, 'somebody else’s reads as absent, not forbidden');
  });

  it('refuses a duplicate name for one owner and allows it across owners', async () => {
    const duplicate = await harness.authed(owner, {
      method: 'POST',
      url: '/api/applications',
      payload: { name: '  application a  ' },
    });
    assert.equal(duplicate.statusCode, 409, duplicate.body);

    const elsewhere = await harness.authed(other, {
      method: 'POST',
      url: '/api/applications',
      payload: { name: 'Application A' },
    });
    assert.equal(elsewhere.statusCode, 201, elsewhere.body);
  });

  it('bounds how many applications one account may own', async () => {
    const limited = await buildTestApp({ env: { NEXUS_MAX_APPLICATIONS_PER_OWNER: '1' } });
    try {
      await limited.registerUser({ email: 'quota-super@example.test' });
      const client = await limited.registerUser({ email: 'quota@example.test', role: 'client' });
      const first = await limited.authed(client, {
        method: 'POST',
        url: '/api/applications',
        payload: { name: 'Only one' },
      });
      assert.equal(first.statusCode, 201, first.body);
      const second = await limited.authed(client, {
        method: 'POST',
        url: '/api/applications',
        payload: { name: 'One too many' },
      });
      assert.equal(second.statusCode, 429, second.body);
      assert.equal(
        second.json<{ error: { code: string } }>().error.code,
        'QUOTA_EXCEEDED',
        second.body,
      );
    } finally {
      await limited.close();
    }
  });
});
