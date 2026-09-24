/**
 * Credential and access ownership under concurrency — issue #341.
 *
 * Each test drives one of the gaps the issue names to the exact interleaving
 * that used to go wrong, by parking one operation at a store or provisioning
 * boundary while a competing one runs:
 *
 * 1. an application delete racing a first credential issue, which could leave
 *    a live Edge consumer nothing in the portal tracks;
 * 2. the god-mode grant sweep, which put a grant whose ACL removal failed back
 *    to `active` and said nothing — so a later re-enable restored the access a
 *    super admin had asked to remove;
 * 3. `credentials.reconcile`, which would empty a credential type on any
 *    consumer id it was handed, including one an operator created by hand;
 * 4. a revocation racing a re-approval of the same API, which could strip the
 *    new grant's group after it landed;
 * 5. an issue whose application was disabled after the route resolved it.
 *
 * And the ordering around them: an approval's grant is written under the
 * consumer key an application delete holds, a re-enable that cancelled a
 * failed teardown rebuilds the approval groups from active grants only, and a
 * revocation's notice goes out before an approval that followed it.
 *
 * The assertions read the mock gateway directly: what matters is what Edge
 * would enforce, not what the portal believes.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  ACCESS_CONTROL_PLUGIN,
  aclGroupForApi,
  consumerUsernameForApplication,
  consumerUsernameForUser,
  type ApiErrorBody,
  type ApproveAccessRequestResponse,
  type CreateAccessRequestResponse,
  type CreateApplicationResponse,
  type IssueCredentialResponse,
  type PublishApiResponse,
  type ReconcileCredentialsResponse,
} from '@ferrum-nexus/shared';

import { SAMPLE_SPEC_YAML, buildTestApp, type TestApp, type TestSession } from './helpers.js';
import type { StoredConsumer } from './mock-ferrum-edge.js';

const NAMESPACE = 'nexus';

function errorOf(body: string): ApiErrorBody['error'] {
  return (JSON.parse(body) as ApiErrorBody).error;
}

/** A promise plus the function that settles it. */
function latch(): { wait: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/** Give an operation that is *not* serialised every chance to run ahead. */
function settle(ms = 150): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('credential and access ownership (issue #341)', () => {
  let harness: TestApp;
  let founder: TestSession;
  let provider: TestSession;
  let owner: TestSession;
  let apiId: string;

  async function publish(slug: string): Promise<string> {
    const response = await harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: {
        name: `Ownership ${slug}`,
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

  async function createApplication(name: string): Promise<string> {
    const response = await harness.authed(owner, {
      method: 'POST',
      url: '/api/applications',
      payload: { name },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<CreateApplicationResponse>().application.id;
  }

  async function requestAccess(): Promise<string> {
    const response = await harness.authed(owner, {
      method: 'POST',
      url: '/api/access-requests',
      payload: { api_id: apiId, justification: 'Integration access' },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<CreateAccessRequestResponse>().access_request.id;
  }

  async function approve(requestId: string): Promise<ApproveAccessRequestResponse> {
    const response = await harness.authed(provider, {
      method: 'POST',
      url: `/api/access-requests/${requestId}/approve`,
      payload: {},
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json<ApproveAccessRequestResponse>();
  }

  /** The ACL groups the gateway holds on an account's own consumer. */
  function groupsOf(userId: string): string[] {
    const username = consumerUsernameForUser(userId);
    return harness.edge.consumerByUsername(username, NAMESPACE)?.acl_groups ?? [];
  }

  /** An application's consumer as the gateway holds it, if it has one. */
  function appConsumer(applicationId: string): StoredConsumer | undefined {
    const username = consumerUsernameForApplication(applicationId);
    return harness.edge.consumerByUsername(username, NAMESPACE);
  }

  async function auditFor(action: string, targetId: string): Promise<Record<string, unknown>> {
    const row = (await harness.auditRows(action)).find((entry) => entry.target_id === targetId);
    assert.ok(row, `an ${action} row for ${targetId}`);
    return row.details;
  }

  beforeEach(async () => {
    harness = await buildTestApp();
    founder = await harness.registerUser({ email: 'ownership-founder@example.test' });
    provider = await harness.registerUser({
      email: 'ownership-provider@example.test',
      role: 'provider',
    });
    owner = await harness.registerUser({ email: 'ownership-owner@example.test', role: 'client' });
    apiId = await publish('ownership-api');
  });

  afterEach(async () => {
    harness.edge.clearInjections();
    await harness.close();
  });

  /* ── 1. Application delete vs. credential issue ─────────────────────── */

  describe('application delete vs. credential issue', () => {
    it('refuses to provision an application deleted after the route resolved it', async () => {
      const appId = await createApplication('Deleted mid-issue');
      const provisioner = harness.services.credentials.provisioner;
      const real = provisioner.ensureConsumer.bind(provisioner);
      const arrived = latch();
      const proceed = latch();
      // Park the issue after `resolveForActor` accepted the application and
      // before provisioning starts — the window the delete used to land in.
      provisioner.ensureConsumer = async (user, applicationId) => {
        provisioner.ensureConsumer = real;
        arrived.open();
        await proceed.wait;
        return real(user, applicationId);
      };
      try {
        const issuing = harness.authed(owner, {
          method: 'POST',
          url: '/api/credentials',
          payload: { credential_type: 'keyauth', application_id: appId },
        });
        await arrived.wait;

        const deleted = await harness.authed(owner, {
          method: 'DELETE',
          url: `/api/applications/${appId}`,
        });
        assert.equal(deleted.statusCode, 200, deleted.body);

        proceed.open();
        const issued = await issuing;
        assert.equal(issued.statusCode, 404, issued.body);
      } finally {
        provisioner.ensureConsumer = real;
        proceed.open();
      }

      const username = consumerUsernameForApplication(appId);
      assert.equal(appConsumer(appId), undefined, 'no gateway identity outlives the application');
      const creates = harness.edge.callsTo('POST', '/consumers');
      assert.ok(
        creates.every((call) => (call.body as { username?: unknown }).username !== username),
        'the consumer was never even created',
      );
      assert.equal(
        await harness.store.consumers.findByUserAndNamespace(owner.user.id, NAMESPACE, appId),
        null,
      );
      assert.equal((await harness.store.credentials.list({ application_id: appId })).total, 0);
    });

    it('waits for an in-flight provisioning, then takes its consumer down', async () => {
      const appId = await createApplication('Provisioning mid-delete');
      const consumers = harness.store.consumers;
      const realCreate = consumers.create.bind(consumers);
      const arrived = latch();
      const proceed = latch();
      // Park the provisioning *inside* its name key: the Edge consumer exists,
      // its mapping does not yet. A delete that read "no mapping" here used to
      // cascade the rows away and leave the consumer — and the key appended
      // to it next — live and untracked.
      consumers.create = async (input) => {
        if (input.application_id === appId) {
          consumers.create = realCreate;
          arrived.open();
          await proceed.wait;
        }
        return realCreate(input);
      };
      try {
        const issuing = harness.authed(owner, {
          method: 'POST',
          url: '/api/credentials',
          payload: { credential_type: 'keyauth', application_id: appId },
        });
        await arrived.wait;
        assert.ok(appConsumer(appId), 'the consumer exists before its mapping does');

        const deleting = harness.authed(owner, {
          method: 'DELETE',
          url: `/api/applications/${appId}`,
        });
        await settle();
        assert.ok(
          await harness.store.applications.findById(appId),
          'the delete waits for the provisioning it would otherwise orphan',
        );

        proceed.open();
        const [issued, deleted] = await Promise.all([issuing, deleting]);
        assert.equal(deleted.statusCode, 200, deleted.body);
        // Either order behind the consumer key is safe: the issue appended
        // first and its key went with the consumer, or the delete went first
        // and the issue found the application gone.
        assert.ok([201, 404].includes(issued.statusCode), issued.body);
      } finally {
        consumers.create = realCreate;
        proceed.open();
      }

      assert.equal(appConsumer(appId), undefined, 'the delete found the mapping it was waiting on');
      assert.equal(await harness.store.applications.findById(appId), null);
      assert.equal((await harness.store.credentials.list({ application_id: appId })).total, 0);
      const details = await auditFor('application.delete', appId);
      assert.equal(typeof details.consumer_id, 'string', 'the consumer that came down is named');
      assert.equal(details.unmapped_consumer, undefined);
    });

    it('orders an approval’s grant and an application delete under the consumer key', async () => {
      const appId = await createApplication('Deleted mid-approval');
      const requested = await harness.authed(owner, {
        method: 'POST',
        url: '/api/access-requests',
        payload: { api_id: apiId, application_id: appId, justification: 'Integration access' },
      });
      assert.equal(requested.statusCode, 201, requested.body);
      const requestId = requested.json<CreateAccessRequestResponse>().access_request.id;
      const consumerId = harness.edgeClient.consumers.derivedId(
        consumerUsernameForApplication(appId),
      );
      // Hold the approval's ACL write at the gateway, then start the delete
      // while it is held. Released straight after that write, the consumer
      // key let the delete remove the consumer and cascade the rows before
      // the grant was inserted — which MongoDB, with no foreign key, then
      // wrote for an application that no longer existed.
      harness.edge.delay(`/consumers/${consumerId}`, 300, 'PUT');
      const approving = harness.authed(provider, {
        method: 'POST',
        url: `/api/access-requests/${requestId}/approve`,
        payload: {},
      });
      const deadline = Date.now() + 5_000;
      while (harness.edge.callsTo('PUT', `/consumers/${consumerId}`).length === 0) {
        assert.ok(Date.now() < deadline, 'the approval reached the gateway');
        await settle(10);
      }
      const deleting = harness.authed(owner, {
        method: 'DELETE',
        url: `/api/applications/${appId}`,
      });

      const [approved, deleted] = await Promise.all([approving, deleting]);
      assert.equal(approved.statusCode, 200, approved.body);
      assert.equal(deleted.statusCode, 200, deleted.body);
      const grantId = approved.json<ApproveAccessRequestResponse>().grant.id;

      // The grant landed before the delete took the key, so the delete saw
      // it, counted it, and took it with the application.
      const details = await auditFor('application.delete', appId);
      assert.equal(details.revoked_grants, 1);
      assert.equal(await harness.store.grants.findById(grantId), null);
      assert.equal(await harness.store.applications.findById(appId), null);
      assert.equal(appConsumer(appId), undefined, 'no gateway identity outlives the application');
    });

    it('takes down an unmapped consumer found at the derived id', async () => {
      const appId = await createApplication('Unmapped');
      const username = consumerUsernameForApplication(appId);
      // What a provisioning whose mapping insert failed leaves behind.
      const { consumer } = await harness.edgeClient.consumers.ensure({
        username,
        custom_id: appId,
        acl_groups: [],
      });
      assert.equal(consumer.id, harness.edgeClient.consumers.derivedId(username));
      assert.equal(
        await harness.store.consumers.findByUserAndNamespace(owner.user.id, NAMESPACE, appId),
        null,
      );

      const deleted = await harness.authed(owner, {
        method: 'DELETE',
        url: `/api/applications/${appId}`,
      });
      assert.equal(deleted.statusCode, 200, deleted.body);
      assert.equal(appConsumer(appId), undefined, 'no mapping is not proof of no consumer');

      const details = await auditFor('application.delete', appId);
      assert.equal(details.consumer_id, consumer.id);
      assert.equal(details.unmapped_consumer, true);
    });

    it('leaves a consumer at the derived id alone when it is some other identity', async () => {
      const appId = await createApplication('Squatted');
      const username = consumerUsernameForApplication(appId);
      const derived = harness.edgeClient.consumers.derivedId(username);
      harness.edge.seedConsumer({
        id: derived,
        username: 'operator-managed',
        namespace: NAMESPACE,
      });

      const deleted = await harness.authed(owner, {
        method: 'DELETE',
        url: `/api/applications/${appId}`,
      });
      assert.equal(deleted.statusCode, 200, deleted.body);
      assert.ok(
        harness.edge.consumers.get(`${NAMESPACE}/${derived}`),
        'a consumer the portal did not create is never deleted',
      );
      assert.equal(harness.edge.callsTo('DELETE', `/consumers/${derived}`).length, 0);
      assert.equal((await auditFor('application.delete', appId)).consumer_id, null);
    });
  });

  /* ── 5. Issue re-checks the application inside the consumer key ─────── */

  it('refuses a credential for an application disabled after its identity was provisioned', async () => {
    const appId = await createApplication('Disabled mid-issue');
    const provisioner = harness.services.credentials.provisioner;
    const real = provisioner.ensureConsumer.bind(provisioner);
    const arrived = latch();
    const proceed = latch();
    // Park the issue after provisioning, before it takes the consumer key.
    provisioner.ensureConsumer = async (user, applicationId) => {
      provisioner.ensureConsumer = real;
      const consumer = await real(user, applicationId);
      arrived.open();
      await proceed.wait;
      return consumer;
    };
    try {
      const issuing = harness.authed(owner, {
        method: 'POST',
        url: '/api/credentials',
        payload: { credential_type: 'keyauth', application_id: appId },
      });
      await arrived.wait;

      const disabled = await harness.authed(owner, {
        method: 'PATCH',
        url: `/api/applications/${appId}`,
        payload: { status: 'disabled' },
      });
      assert.equal(disabled.statusCode, 200, disabled.body);

      proceed.open();
      const issued = await issuing;
      assert.equal(issued.statusCode, 409, issued.body);
      assert.equal(errorOf(issued.body).code, 'CONFLICT');
      assert.ok(!('secret' in JSON.parse(issued.body)), 'no secret was handed out');
    } finally {
      provisioner.ensureConsumer = real;
      proceed.open();
    }

    const remote = appConsumer(appId);
    assert.ok(remote, 'the identity was provisioned before the disable');
    assert.equal(remote.credentials.keyauth?.length ?? 0, 0, 'but nothing was appended to it');
    assert.equal((await harness.store.credentials.list({ application_id: appId })).total, 0);
  });

  /* ── 4. Revoke is serialised with approve ───────────────────────────── */

  it('orders a revocation and a re-approval of the same API under one proxy lease', async () => {
    const first = await approve(await requestAccess());
    const grantId = first.grant.id;
    const group = aclGroupForApi(apiId);
    assert.deepEqual(groupsOf(owner.user.id), [group]);

    // Record the order the grantee is told things in, and hold the
    // revocation's notice back: were it sent after the lease is released, the
    // approval waiting on the lease would announce first.
    const notifier = harness.services.notifications;
    const realNotify = notifier.notify.bind(notifier);
    const told: string[] = [];
    notifier.notify = async (userId, type, title, body, link) => {
      if (type === 'access_revoked') await settle();
      if (userId === owner.user.id) told.push(type);
      return realNotify(userId, type, title, body, link);
    };

    // Park the revocation after its claim and before its ACL removal: the
    // first thing it does on the way to the gateway is look up the mapping.
    const repo = harness.store.consumers;
    const realFind = repo.findByUserAndNamespace.bind(repo);
    const arrived = latch();
    const proceed = latch();
    repo.findByUserAndNamespace = async (userId, namespace, applicationId) => {
      repo.findByUserAndNamespace = realFind;
      arrived.open();
      await proceed.wait;
      return realFind(userId, namespace, applicationId);
    };
    try {
      const revoking = harness.authed(provider, {
        method: 'POST',
        url: `/api/grants/${grantId}/revoke`,
        payload: { reason: 'Contract ended.' },
      });
      await arrived.wait;
      assert.equal((await harness.store.grants.findById(grantId))?.status, 'revoked');

      // The client asks again and the provider approves while the revocation
      // is still on its way to the gateway.
      const again = await requestAccess();
      let approvedEarly = false;
      const approving = harness.authed(provider, {
        method: 'POST',
        url: `/api/access-requests/${again}/approve`,
        payload: {},
      });
      void approving.then(() => {
        approvedEarly = true;
      });
      await settle();
      assert.equal(approvedEarly, false, 'the approval waits for the revocation to finish');

      proceed.open();
      const revoked = await revoking;
      assert.equal(revoked.statusCode, 200, revoked.body);
      const approved = await approving;
      assert.equal(approved.statusCode, 200, approved.body);
    } finally {
      repo.findByUserAndNamespace = realFind;
      notifier.notify = realNotify;
      proceed.open();
    }

    const active = await harness.store.grants.findActiveByApiAndUser(apiId, owner.user.id, null);
    assert.ok(active, 'the re-approval holds an active grant');
    assert.notEqual(active.id, grantId);
    assert.deepEqual(groupsOf(owner.user.id), [group], 'and the gateway honours it');
    assert.deepEqual(
      told.filter((type) => type.startsWith('access_')),
      ['access_revoked', 'access_request_approved'],
      'the grantee hears of the revocation before the approval that followed it',
    );
  });

  /* ── 2. The god-mode sweep never swallows a gateway failure ─────────── */

  describe('god-mode grant sweep', () => {
    it('moves each originating request to revoked, as a targeted revocation does', async () => {
      const requestId = await requestAccess();
      const { grant } = await approve(requestId);

      const disabled = await harness.authed(founder, {
        method: 'POST',
        url: '/api/admin/god/disable-user',
        payload: { user_id: owner.user.id, reason: 'Account compromised.', revoke_grants: true },
      });
      assert.equal(disabled.statusCode, 200, disabled.body);
      assert.equal((await harness.store.grants.findById(grant.id))?.status, 'revoked');
      assert.equal((await harness.store.accessRequests.findById(requestId))?.status, 'revoked');
    });

    it('reports a failed ACL removal, keeps the grant revoked, and never restores it', async () => {
      const requestId = await requestAccess();
      const { grant } = await approve(requestId);
      const consumer = harness.edge.consumerByUsername(
        consumerUsernameForUser(owner.user.id),
        NAMESPACE,
      );
      assert.ok(consumer);
      // The sweep's ACL write is the first `PUT` to the consumer; the
      // teardown's, after it, goes through.
      harness.edge.queueFailure(500, { error: 'refused' }, `/consumers/${consumer.id}`, 'PUT');

      const disabled = await harness.authed(founder, {
        method: 'POST',
        url: '/api/admin/god/disable-user',
        payload: { user_id: owner.user.id, reason: 'Account compromised.', revoke_grants: true },
      });
      assert.equal(disabled.statusCode, 502, disabled.body);
      const error = errorOf(disabled.body);
      assert.equal(error.code, 'EDGE_ERROR');
      const body = error.details as { failed_grants: { grant_id: string; stage: string }[] };
      assert.deepEqual(
        body.failed_grants.map((entry) => [entry.grant_id, entry.stage]),
        [[grant.id, 'gateway']],
        'the caller learns which grant failed, and where',
      );

      // Fail closed: the grant is not put back to `active` …
      assert.equal((await harness.store.grants.findById(grant.id))?.status, 'revoked');
      assert.equal((await harness.store.accessRequests.findById(requestId))?.status, 'revoked');
      const rollbacks = await harness.auditRows('access.revoke_rollback');
      assert.ok(!rollbacks.some((row) => row.target_id === grant.id), 'nothing was unwound');
      const revokeRow = await auditFor('access.revoke', grant.id);
      assert.equal(revokeRow.bulk, true);
      assert.equal(revokeRow.acl_group_removed, false);

      // … the disable is not reported as a success …
      for (const action of ['user.disable', 'god.disable_user']) {
        const details = await auditFor(action, owner.user.id);
        assert.deepEqual(details.failed_steps, ['revoke_grants'], action);
        assert.equal(details.failed_grant_revocations, 1, action);
      }
      assert.equal((await auditFor('god.disable_user', owner.user.id)).revoked_grants, 0);

      // … the teardown that followed took the group off anyway …
      assert.deepEqual(groupsOf(owner.user.id), []);

      // … and re-enabling the account does not hand back the access the super
      // admin removed.
      const enabled = await harness.authed(founder, {
        method: 'PATCH',
        url: `/api/users/${owner.user.id}`,
        payload: { status: 'active' },
      });
      assert.equal(enabled.statusCode, 200, enabled.body);
      assert.deepEqual(groupsOf(owner.user.id), [], 'a re-enable does not restore it');
    });

    it('drops a stray group on re-enable when the teardown failed as well', async () => {
      const issued = await harness.authed(owner, {
        method: 'POST',
        url: '/api/credentials',
        payload: { credential_type: 'keyauth' },
      });
      assert.equal(issued.statusCode, 201, issued.body);
      const requestId = await requestAccess();
      const { grant } = await approve(requestId);
      const group = aclGroupForApi(apiId);
      const consumer = harness.edge.consumerByUsername(
        consumerUsernameForUser(owner.user.id),
        NAMESPACE,
      );
      assert.ok(consumer);
      // A group an operator put on the consumer by hand: not the portal's.
      consumer.acl_groups = [...consumer.acl_groups, 'operator:beta'];
      // The sweep's ACL write and the teardown's, one after the other, both
      // refused — the teardown stays queued with the group still on.
      harness.edge.queueFailure(500, { error: 'refused' }, `/consumers/${consumer.id}`, 'PUT');
      harness.edge.queueFailure(500, { error: 'refused' }, `/consumers/${consumer.id}`, 'PUT');

      const disabled = await harness.authed(founder, {
        method: 'POST',
        url: '/api/admin/god/disable-user',
        payload: { user_id: owner.user.id, reason: 'Account compromised.', revoke_grants: true },
      });
      assert.equal(disabled.statusCode, 502, disabled.body);
      assert.equal((await harness.store.grants.findById(grant.id))?.status, 'revoked');
      assert.equal(
        (await harness.store.gatewayTeardownJobs.findByUser(owner.user.id))?.status,
        'pending',
        'the teardown is still owed',
      );
      assert.ok(groupsOf(owner.user.id).includes(group), 'the group is still on the consumer');

      // Re-enabled before the worker retries: the owed teardown is cancelled.
      const enabled = await harness.authed(founder, {
        method: 'PATCH',
        url: `/api/users/${owner.user.id}`,
        payload: { status: 'active' },
      });
      assert.equal(enabled.statusCode, 200, enabled.body);
      assert.equal(await harness.store.gatewayTeardownJobs.findByUser(owner.user.id), null);

      // The re-enable rebuilt the portal's groups from active grants — there
      // are none — and left the operator's alone.
      assert.deepEqual(groupsOf(owner.user.id), ['operator:beta']);
      const live = harness.edge.consumerByUsername(
        consumerUsernameForUser(owner.user.id),
        NAMESPACE,
      );
      assert.equal(live?.credentials.keyauth?.length, 1, 'the account keeps its key');
      const proxyId = (await harness.store.apis.findById(apiId))?.ferrum_proxy_id;
      assert.ok(proxyId);
      const acl = harness.edge.pluginForProxy(proxyId, ACCESS_CONTROL_PLUGIN, NAMESPACE);
      const config = acl?.config as { allowed_groups?: string[] } | undefined;
      const allowed = config?.allowed_groups ?? [];
      assert.deepEqual(allowed, [group]);
      assert.ok(
        !(live?.acl_groups ?? []).some((entry) => allowed.includes(entry)),
        'so the key cannot reach the API',
      );
    });

    it('counts a consumer already gone from the gateway as its group removed', async () => {
      const requestId = await requestAccess();
      const { grant } = await approve(requestId);
      const username = consumerUsernameForUser(owner.user.id);
      for (const [key, stored] of [...harness.edge.consumers.entries()]) {
        if (stored.username === username) harness.edge.consumers.delete(key);
      }

      const disabled = await harness.authed(founder, {
        method: 'POST',
        url: '/api/admin/god/disable-user',
        payload: { user_id: owner.user.id, reason: 'Account compromised.', revoke_grants: true },
      });
      assert.equal(disabled.statusCode, 200, disabled.body);
      assert.equal((await harness.store.grants.findById(grant.id))?.status, 'revoked');
      const revokeRow = await auditFor('access.revoke', grant.id);
      assert.equal(revokeRow.acl_group_removed, undefined, 'no failure is recorded');
      const details = await auditFor('god.disable_user', owner.user.id);
      assert.equal(details.revoked_grants, 1);
      assert.equal(details.failed_steps, undefined);
    });
  });

  /* ── 3. Reconcile only addresses consumers the portal owns ──────────── */

  describe('credentials.reconcile', () => {
    function reconcile(consumerId: string): ReturnType<TestApp['authed']> {
      return harness.authed(founder, {
        method: 'POST',
        url: '/api/admin/credentials/reconcile',
        payload: { consumer_id: consumerId, credential_type: 'keyauth', reason: 'cleanup' },
      });
    }

    it('refuses a consumer an operator created on the gateway', async () => {
      const foreign = harness.edge.seedConsumer({
        username: 'partner-billing',
        namespace: NAMESPACE,
        credentials: { keyauth: [{ key: 'operator-managed-key' }] },
      });

      const response = await reconcile(foreign.id);
      assert.equal(response.statusCode, 403, response.body);
      assert.equal(errorOf(response.body).code, 'FORBIDDEN');
      assert.equal(harness.edge.callsTo('DELETE', `/consumers/${foreign.id}`).length, 0);
      assert.equal(
        harness.edge.consumers.get(`${NAMESPACE}/${foreign.id}`)?.credentials.keyauth?.length,
        1,
        'the operator’s credential is untouched',
      );
      assert.equal((await harness.auditRows('credential.reconcile')).length, 0);
    });

    it('refuses an id nothing in the portal knows', async () => {
      const response = await reconcile('00000000-0000-4000-8000-000000000000');
      assert.equal(response.statusCode, 403, response.body);
      assert.equal((await harness.auditRows('credential.reconcile')).length, 0);
    });

    it('refuses a mapped id whose live consumer is some other identity', async () => {
      const other = await harness.registerUser({ email: 'ownership-other@example.test' });
      const live = harness.edge.seedConsumer({
        username: 'operator-reused',
        namespace: NAMESPACE,
        credentials: { keyauth: [{ key: 'operator-managed-key' }] },
      });
      await harness.store.consumers.create({
        user_id: other.user.id,
        application_id: null,
        namespace: NAMESPACE,
        ferrum_consumer_id: live.id,
        ferrum_username: consumerUsernameForUser(other.user.id),
      });

      const response = await reconcile(live.id);
      assert.equal(response.statusCode, 403, response.body);
      assert.equal(harness.edge.callsTo('DELETE', `/consumers/${live.id}`).length, 0);
    });

    it('refuses a consumer whose credential rows name another identity', async () => {
      const issued = await harness.authed(owner, {
        method: 'POST',
        url: '/api/credentials',
        payload: { credential_type: 'keyauth' },
      });
      assert.equal(issued.statusCode, 201, issued.body);
      const consumerId = issued.json<IssueCredentialResponse>().credential.ferrum_consumer_id;
      // Only the credential rows vouch for it now …
      const mapping = await harness.store.consumers.findByFerrumId(consumerId);
      assert.ok(mapping);
      await harness.store.consumers.delete(mapping.id);
      // … and the live consumer carries a portal-shaped username, but not the
      // one Nexus derives for the account those rows belong to.
      const live = harness.edge.consumerByUsername(
        consumerUsernameForUser(owner.user.id),
        NAMESPACE,
      );
      assert.ok(live);
      live.username = consumerUsernameForUser(founder.user.id);

      const response = await reconcile(consumerId);
      assert.equal(response.statusCode, 403, response.body);
      assert.equal(harness.edge.callsTo('DELETE', `/consumers/${consumerId}`).length, 0);

      // With the username the rows' owner derives, the rows are enough.
      live.username = consumerUsernameForUser(owner.user.id);
      const settled = await reconcile(consumerId);
      assert.equal(settled.statusCode, 200, settled.body);
    });

    it('rejects an id that is not consumer-id shaped before taking a lease on it', async () => {
      const response = await reconcile(`proxy:${apiId}`);
      assert.equal(response.statusCode, 400, response.body);
      assert.equal(errorOf(response.body).code, 'VALIDATION_FAILED');
      assert.equal((await harness.auditRows('credential.reconcile')).length, 0);
    });

    it('still reconciles the portal’s own consumer', async () => {
      const issued = await harness.authed(owner, {
        method: 'POST',
        url: '/api/credentials',
        payload: { credential_type: 'keyauth' },
      });
      assert.equal(issued.statusCode, 201, issued.body);
      const consumerId = issued.json<IssueCredentialResponse>().credential.ferrum_consumer_id;

      const response = await reconcile(consumerId);
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json<ReconcileCredentialsResponse>(), {
        consumer_id: consumerId,
        credential_type: 'keyauth',
        revoked_credentials: 1,
        gateway_cleared: true,
      });
    });
  });
});
