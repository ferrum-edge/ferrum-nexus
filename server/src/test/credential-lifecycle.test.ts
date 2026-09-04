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
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  aclGroupForApi,
  consumerUsernameForUser,
  type ApiErrorBody,
  type CreateTestConsumerResponse,
  type CredentialType,
  type IssueCredentialResponse,
  type ListCredentialsResponse,
  type PublishApiResponse,
  type RotateCredentialResponse,
  type UpdateUserResponse,
} from '@ferrum-nexus/shared';

import { buildTestApp, SAMPLE_SPEC_YAML, type TestApp, type TestSession } from './helpers.js';

function errorCode(body: string): string {
  return (JSON.parse(body) as ApiErrorBody).error.code;
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
});
