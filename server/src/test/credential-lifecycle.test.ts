/**
 * Credential lifecycle invariants that span more than one gateway identity.
 *
 * Four separate reports converge here, and they all say the same thing in
 * different words: the credential mirror is only worth having if it cannot
 * disagree with Edge, and an account's gateway identity is only revoked if
 * *every* identity it holds is revoked.
 *
 * - **Account teardown covers test consumers.** A provider's
 *   `nexus-test-<apiId>` consumer is a distinct Edge identity holding a
 *   credential attributed to that provider. Disabling the account has to take
 *   it down too, or offboarding hands the account a working key.
 * - **A disabled owner cannot be issued a credential.** Serialising gateway
 *   writes orders them; it does not re-authorise them. A request that passed
 *   authentication before the disable must be refused when it reaches the front
 *   of the queue afterwards, and removed by the teardown when it gets there
 *   first.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  aclGroupForApi,
  consumerUsernameForUser,
  type ApiErrorBody,
  type CreateAccessRequestResponse,
  type CreateTestConsumerResponse,
  type CredentialType,
  type IssueCredentialResponse,
  type ListCredentialsResponse,
  type PublishApiResponse,
  type RotateCredentialResponse,
  type UpdateUserResponse,
} from '@ferrum-nexus/shared';

import { createTeardownWorker } from '../credentials/teardown-worker.js';
import type { UserRecord } from '../db/store.js';
import { buildTestApp, SAMPLE_SPEC_YAML, type TestApp, type TestSession } from './helpers.js';

function errorCode(body: string): string {
  return (JSON.parse(body) as ApiErrorBody).error.code;
}

/** A barrier the test opens by hand. */
interface Gate {
  /** Resolves once the guarded call has been entered and parked. */
  arrived: Promise<void>;
  /** Let it continue, and restore the real implementation. */
  release: () => void;
}

describe('credential lifecycle across identities', () => {
  let harness: TestApp;
  /** The first registered account, therefore `super_admin`. */
  let founder: TestSession;
  let admin: TestSession;

  async function publish(session: TestSession, slug: string, authPlugin = 'key_auth') {
    const response = await harness.authed(session, {
      method: 'POST',
      url: '/api/apis',
      payload: {
        name: `API ${slug}`,
        slug,
        version: '1.0.0',
        spec: SAMPLE_SPEC_YAML,
        auth_plugin: authPlugin,
        requestable: true,
        visibility: 'public',
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<PublishApiResponse>().api;
  }

  async function issue(
    actor: TestSession,
    credentialType: CredentialType,
  ): Promise<IssueCredentialResponse> {
    const response = await harness.authed(actor, {
      method: 'POST',
      url: '/api/credentials',
      payload: { credential_type: credentialType },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<IssueCredentialResponse>();
  }

  /**
   * Park the next `ensureConsumer` — the asynchronous boundary an issue crosses
   * after authentication and before it locks the consumer.
   *
   * This is the report's reproduction step made deterministic: the request is
   * held there, the disable runs to completion behind it, and only then is it
   * released to try its append.
   */
  function holdEnsureConsumer(): Gate {
    const provisioner = harness.services.credentials.provisioner;
    const real = provisioner.ensureConsumer.bind(provisioner);
    let announce: () => void = () => {};
    let release: () => void = () => {};
    const arrived = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    provisioner.ensureConsumer = async (user) => {
      provisioner.ensureConsumer = real;
      const consumer = await real(user);
      announce();
      await held;
      return consumer;
    };

    return {
      arrived,
      release: () => {
        provisioner.ensureConsumer = real;
        release();
      },
    };
  }

  /** The stored record behind a session — what a request carries internally. */
  async function record(session: TestSession): Promise<UserRecord> {
    const row = await harness.store.users.findById(session.user.id);
    assert.ok(row);
    return row;
  }

  async function disable(target: TestSession): Promise<UpdateUserResponse> {
    const response = await harness.authed(admin, {
      method: 'PATCH',
      url: `/api/users/${target.user.id}`,
      payload: { status: 'disabled' },
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json<UpdateUserResponse>();
  }

  before(async () => {
    harness = await buildTestApp();
    founder = await harness.registerUser({ email: 'lifecycle-founder@example.test' });
    admin = await harness.registerUser({ email: 'lifecycle-admin@example.test' });
    const promoted = await harness.authed(founder, {
      method: 'PATCH',
      url: `/api/users/${admin.user.id}`,
      payload: { role: 'admin' },
    });
    assert.equal(promoted.statusCode, 200, promoted.body);
    admin = await harness.loginUser('lifecycle-admin@example.test');
  });

  after(async () => {
    await harness.close();
  });

  /* ── #57 — teardown must cover every identity ─────────────────────────── */

  it('tears down a provider test consumer when the account is disabled', async () => {
    const provider = await harness.registerUser({
      email: 'lifecycle-testcon@example.test',
      role: 'provider',
    });
    const api = await publish(provider, 'lifecycle-testcon');

    const created = await harness.authed(provider, {
      method: 'POST',
      url: `/api/apis/${api.id}/test-consumer`,
      payload: {},
    });
    assert.equal(created.statusCode, 201, created.body);
    const testCredential = created.json<CreateTestConsumerResponse>().credential;
    const username = `nexus-test-${api.id}`;
    assert.ok(harness.edge.consumerByUsername(username));

    const body = await disable(provider);
    assert.equal(body.gateway_teardown, 'ok');

    assert.equal(
      harness.edge.consumerByUsername(username),
      undefined,
      'the test consumer is gone from the gateway',
    );
    const row = await harness.store.credentials.findById(testCredential.id);
    assert.equal(row?.status, 'revoked', 'the test credential row follows the gateway');
    assert.equal(
      (await harness.store.gatewayTeardownJobs.findByUser(provider.user.id))?.status ?? 'done',
      'done',
    );
  });

  it('tears down the canonical consumer and the test consumers together', async () => {
    const provider = await harness.registerUser({
      email: 'lifecycle-both@example.test',
      role: 'provider',
    });
    const first = await publish(provider, 'lifecycle-both-one');
    const second = await publish(provider, 'lifecycle-both-two', 'basic_auth');
    const personal = await issue(provider, 'keyauth');

    const testCredentials: string[] = [];
    for (const api of [first, second]) {
      const created = await harness.authed(provider, {
        method: 'POST',
        url: `/api/apis/${api.id}/test-consumer`,
        payload: {},
      });
      assert.equal(created.statusCode, 201, created.body);
      testCredentials.push(created.json<CreateTestConsumerResponse>().credential.id);
    }

    const body = await disable(provider);
    assert.equal(body.gateway_teardown, 'ok');

    assert.equal(harness.edge.consumerByUsername(`nexus-test-${first.id}`), undefined);
    assert.equal(harness.edge.consumerByUsername(`nexus-test-${second.id}`), undefined);
    const canonical = harness.edge.consumerByUsername(consumerUsernameForUser(provider.user.id));
    assert.deepEqual(canonical?.acl_groups, []);
    assert.equal(canonical?.credentials.keyauth?.length ?? 0, 0);

    for (const id of [...testCredentials, personal.credential.id]) {
      assert.equal((await harness.store.credentials.findById(id))?.status, 'revoked');
    }
  });

  it('retries only the identities a failed teardown left behind', async () => {
    const provider = await harness.registerUser({
      email: 'lifecycle-retry@example.test',
      role: 'provider',
    });
    const api = await publish(provider, 'lifecycle-retry');
    const created = await harness.authed(provider, {
      method: 'POST',
      url: `/api/apis/${api.id}/test-consumer`,
      payload: {},
    });
    assert.equal(created.statusCode, 201, created.body);
    const testCredentialId = created.json<CreateTestConsumerResponse>().credential.id;
    await issue(provider, 'keyauth');

    // The test consumer's DELETE fails; the canonical consumer is untouched by
    // that failure, so the retry must not redo it and must finish the rest.
    const testConsumerId = harness.edge.consumerByUsername(`nexus-test-${api.id}`)?.id;
    assert.ok(testConsumerId);
    harness.edge.queueFailure(503, { error: 'down' }, `/consumers/${testConsumerId}`, 'DELETE');

    const body = await disable(provider);
    assert.equal(body.gateway_teardown, 'pending', 'a failed identity leaves the job pending');
    assert.ok(harness.edge.consumerByUsername(`nexus-test-${api.id}`));

    const retried = await harness.services.credentials.disableGatewayAccess(
      provider.user.id,
      admin.user.id,
    );
    assert.equal(harness.edge.consumerByUsername(`nexus-test-${api.id}`), undefined);
    assert.equal((await harness.store.credentials.findById(testCredentialId))?.status, 'revoked');
    assert.ok(retried.consumer_id);
  });

  /* ── #58 — a disabled owner cannot be issued a credential ─────────────── */

  it('refuses an issue that was in flight when the account was disabled', async () => {
    const victim = await harness.registerUser({
      email: 'lifecycle-inflight@example.test',
      role: 'client',
    });
    // Provision the consumer up front so the held request has only the append
    // left to do — the exact window the report describes.
    await issue(victim, 'keyauth');
    const username = consumerUsernameForUser(victim.user.id);

    const gate = holdEnsureConsumer();
    const pending = harness.authed(victim, {
      method: 'POST',
      url: '/api/credentials',
      payload: { credential_type: 'basicauth' },
    });
    await gate.arrived;

    // The disable runs to completion — teardown included — while the issue is
    // parked between `ensureConsumer` and the append.
    const body = await disable(victim);
    assert.equal(body.gateway_teardown, 'ok');

    gate.release();
    const issued = await pending;
    assert.equal(issued.statusCode, 403, issued.body);
    assert.equal(errorCode(issued.body), 'USER_DISABLED');

    const consumer = harness.edge.consumerByUsername(username);
    assert.equal(consumer?.credentials.keyauth?.length ?? 0, 0);
    assert.equal(consumer?.credentials.basicauth?.length ?? 0, 0, 'no key survived the disable');
    const live = await harness.store.credentials.list(
      { user_id: victim.user.id, status: 'active' },
      { limit: 50 },
    );
    assert.deepEqual(
      live.items.map((row) => row.id),
      [],
    );
  });

  it('removes an issue that won the lock ahead of the teardown behind it', async () => {
    const victim = await harness.registerUser({
      email: 'lifecycle-winner@example.test',
      role: 'client',
    });
    await issue(victim, 'keyauth');
    const username = consumerUsernameForUser(victim.user.id);

    // Hold the append itself: the issue is inside the consumer's critical
    // section, so the disable's teardown queues behind it and cleans up after.
    harness.edge.delay('/credentials/basicauth', 40, 'POST');
    const pending = harness.authed(victim, {
      method: 'POST',
      url: '/api/credentials',
      payload: { credential_type: 'basicauth' },
    });
    const body = await disable(victim);
    const issued = await pending;

    assert.equal(body.gateway_teardown, 'ok');
    assert.ok(
      issued.statusCode === 201 || issued.statusCode === 403,
      `expected the append to be refused or undone, got ${issued.statusCode}`,
    );
    const consumer = harness.edge.consumerByUsername(username);
    assert.equal(consumer?.credentials.keyauth?.length ?? 0, 0);
    assert.equal(consumer?.credentials.basicauth?.length ?? 0, 0);
    const live = await harness.store.credentials.list(
      { user_id: victim.user.id, status: 'active' },
      { limit: 50 },
    );
    assert.deepEqual(
      live.items.map((row) => row.id),
      [],
      'the teardown revoked whatever the issue managed to write',
    );
  });

  it('refuses to rotate a disabled account’s credential, even for an admin', async () => {
    const victim = await harness.registerUser({
      email: 'lifecycle-rotdis@example.test',
      role: 'client',
    });
    const issued = await issue(victim, 'keyauth');
    // Disable against a gateway that refuses, so the row is still `active` and
    // the rotation is refused on the account's status rather than on the row's.
    harness.edge.queueFailure(503, { error: 'down' }, '/consumers/', 'PUT');
    assert.equal((await disable(victim)).gateway_teardown, 'pending');
    assert.equal(
      (await harness.store.credentials.findById(issued.credential.id))?.status,
      'active',
    );

    const rotated = await harness.authed(admin, {
      method: 'POST',
      url: `/api/credentials/${issued.credential.id}/rotate`,
      payload: {},
    });
    assert.equal(rotated.statusCode, 403, rotated.body);
    assert.equal(errorCode(rotated.body), 'USER_DISABLED');
    const consumer = harness.edge.consumerByUsername(consumerUsernameForUser(victim.user.id));
    assert.equal(consumer?.credentials.keyauth?.length, 1, 'no replacement was appended');
  });

  it('refuses a test-consumer credential for a disabled provider', async () => {
    const provider = await harness.registerUser({
      email: 'lifecycle-testdis@example.test',
      role: 'provider',
    });
    const api = await publish(provider, 'lifecycle-testdis');
    // The request-time copy of the account, taken while it was still active —
    // exactly what an in-flight request carries.
    const stale = await record(provider);
    await disable(provider);

    await assert.rejects(
      () => harness.services.publishing.createTestConsumer(stale, api.id),
      (error: Error) => /disabled/i.test(error.message),
    );
    assert.equal(
      harness.edge.consumerByUsername(`nexus-test-${api.id}`)?.credentials.keyauth?.length ?? 0,
      0,
      'no credential was minted on the test consumer',
    );
  });

  it('refuses to grant an ACL group to a disabled account', async () => {
    const provider = await harness.registerUser({
      email: 'lifecycle-acl-provider@example.test',
      role: 'provider',
    });
    const client = await harness.registerUser({
      email: 'lifecycle-acl-client@example.test',
      role: 'client',
    });
    const api = await publish(provider, 'lifecycle-acl');
    await issue(client, 'keyauth');

    const requested = await harness.authed(client, {
      method: 'POST',
      url: '/api/access-requests',
      payload: { api_id: api.id, justification: 'please' },
    });
    assert.equal(requested.statusCode, 201, requested.body);
    const requestId = requested.json<CreateAccessRequestResponse>().access_request.id;

    await disable(client);

    const approved = await harness.authed(provider, {
      method: 'POST',
      url: `/api/access-requests/${requestId}/approve`,
      payload: {},
    });
    assert.equal(approved.statusCode, 403, approved.body);
    assert.equal(errorCode(approved.body), 'USER_DISABLED');
    const consumer = harness.edge.consumerByUsername(consumerUsernameForUser(client.user.id));
    assert.equal(
      consumer?.acl_groups.includes(aclGroupForApi(api.id)),
      false,
      'a disabled account did not gain the group',
    );
  });

  it('abandons a teardown whose account was re-enabled under it', async () => {
    const victim = await harness.registerUser({
      email: 'lifecycle-reenable@example.test',
      role: 'client',
    });
    await issue(victim, 'keyauth');
    // Disable with the gateway down, so the job is left pending and claimable.
    harness.edge.queueFailure(503, { error: 'down' }, '/consumers/', 'PUT');
    assert.equal((await disable(victim)).gateway_teardown, 'pending');

    const enabled = await harness.authed(admin, {
      method: 'PATCH',
      url: `/api/users/${victim.user.id}`,
      payload: { status: 'active' },
    });
    assert.equal(enabled.statusCode, 200, enabled.body);

    // Whatever a stale worker still holds, the teardown itself refuses.
    const restored = await issue(
      await harness.loginUser('lifecycle-reenable@example.test'),
      'keyauth',
    );
    await assert.rejects(
      () => harness.services.credentials.disableGatewayAccess(victim.user.id, admin.user.id),
      (error: Error) => /no longer disabled/i.test(error.message),
    );
    assert.equal(
      (await harness.store.credentials.findById(restored.credential.id))?.status,
      'active',
      'the re-enabled account kept its credential',
    );
    const consumer = harness.edge.consumerByUsername(consumerUsernameForUser(victim.user.id));
    assert.equal(consumer?.credentials.keyauth?.length, 2);
  });

  it('drops rather than reschedules a job whose account was re-enabled mid-attempt', async () => {
    // Its own harness: `tick()` claims every due job, and this assertion is
    // about the one job it queues.
    const solo = await buildTestApp();
    try {
      const founderThere = await solo.registerUser({ email: 'worker-founder@example.test' });
      const victim = await solo.registerUser({
        email: 'worker-victim@example.test',
        role: 'client',
      });
      const issued = await solo.authed(victim, {
        method: 'POST',
        url: '/api/credentials',
        payload: { credential_type: 'keyauth' },
      });
      assert.equal(issued.statusCode, 201, issued.body);

      solo.edge.queueFailure(503, { error: 'down' }, '/consumers/', 'PUT');
      const disabled = await solo.authed(founderThere, {
        method: 'PATCH',
        url: `/api/users/${victim.user.id}`,
        payload: { status: 'disabled' },
      });
      assert.equal(disabled.statusCode, 200, disabled.body);
      assert.equal(disabled.json<UpdateUserResponse>().gateway_teardown, 'pending');

      // Re-enable *behind* the worker: the claim-time check passes because the
      // status only flips once the worker is already inside the attempt.
      const worker = createTeardownWorker({
        store: solo.store,
        credentials: {
          disableGatewayAccess: async (userId, subject) => {
            await solo.store.users.update(victim.user.id, { status: 'active' });
            return solo.services.credentials.disableGatewayAccess(userId, subject);
          },
        },
        audit: solo.services.audit,
      });
      const result = await worker.tick();
      assert.equal(result.claimed, 1);
      assert.equal(result.rescheduled, 0, 'a moot job is not retried');
      assert.equal(result.cancelled, 1);
      assert.equal(await solo.store.gatewayTeardownJobs.findByUser(victim.user.id), null);
    } finally {
      await solo.close();
    }
  });
});
