import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  aclGroupForApi,
  type CreateAccessRequestResponse,
  type PublishApiResponse,
  type UpdateUserResponse,
} from '@ferrum-nexus/shared';

import { buildTestApp, SAMPLE_SPEC_YAML, type TestApp, type TestSession } from './helpers.js';

async function publish(h: TestApp, provider: TestSession, slug: string) {
  const response = await h.authed(provider, {
    method: 'POST',
    url: '/api/apis',
    payload: {
      name: slug,
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

async function approve(h: TestApp, provider: TestSession, client: TestSession, apiId: string) {
  const requested = await h.authed(client, {
    method: 'POST',
    url: '/api/access-requests',
    payload: { api_id: apiId, justification: 'Approved integration' },
  });
  assert.equal(requested.statusCode, 201, requested.body);
  const id = requested.json<CreateAccessRequestResponse>().access_request.id;
  const approved = await h.authed(provider, {
    method: 'POST',
    url: `/api/access-requests/${id}/approve`,
  });
  assert.equal(approved.statusCode, 200, approved.body);
}

for (const scenario of [
  { name: 'one grant', grants: 1, god: false, revoke: false, pending: false },
  { name: 'two grants', grants: 2, god: false, revoke: false, pending: false },
  { name: 'god mode retaining grants', grants: 2, god: true, revoke: false, pending: false },
  { name: 'god mode revoking grants', grants: 2, god: true, revoke: true, pending: false },
  { name: 'a pending teardown', grants: 1, god: false, revoke: false, pending: true },
]) {
  test(`re-enable restores only retained ACL access after ${scenario.name}`, async () => {
    const h = await buildTestApp();
    try {
      const founder = await h.registerUser({ email: 'founder@example.test' });
      const provider = await h.registerUser({ email: 'provider@example.test', role: 'provider' });
      const client = await h.registerUser({ email: 'client@example.test', role: 'client' });
      const apiIds: string[] = [];
      for (let index = 0; index < scenario.grants; index += 1) {
        const apiId = await publish(h, provider, `reenable-${index}`);
        await approve(h, provider, client, apiId);
        apiIds.push(apiId);
      }
      const issued = await h.authed(client, {
        method: 'POST',
        url: '/api/credentials',
        payload: { credential_type: 'keyauth' },
      });
      assert.equal(issued.statusCode, 201, issued.body);
      const mapping = await h.services.credentials.provisioner.findConsumer(client.user.id);
      assert.ok(mapping);
      if (scenario.pending) h.edge.queueFailure(503, { error: 'down' }, '/consumers/', 'PUT');
      const disabled = await h.authed(
        founder,
        scenario.god
          ? {
              method: 'POST',
              url: '/api/admin/god/disable-user',
              payload: {
                user_id: client.user.id,
                reason: 'Temporary hold',
                revoke_grants: scenario.revoke,
              },
            }
          : {
              method: 'PATCH',
              url: `/api/users/${client.user.id}`,
              payload: { status: 'disabled' },
            },
      );
      assert.equal(disabled.statusCode, 200, disabled.body);
      if (scenario.pending) {
        assert.equal(disabled.json<UpdateUserResponse>().gateway_teardown, 'pending');
      } else {
        const stripped = await h.edgeClient.consumers.get(mapping.ferrum_consumer_id);
        assert.deepEqual(stripped?.acl_groups, []);
        assert.equal(stripped?.credentials.keyauth?.length ?? 0, 0);
      }
      const enabled = await h.authed(founder, {
        method: 'PATCH',
        url: `/api/users/${client.user.id}`,
        payload: { status: 'active' },
      });
      assert.equal(enabled.statusCode, 200, enabled.body);
      const live = await h.edgeClient.consumers.get(mapping.ferrum_consumer_id);
      assert.deepEqual(
        live?.acl_groups?.sort(),
        scenario.revoke ? [] : apiIds.map(aclGroupForApi).sort(),
      );
      assert.equal(await h.store.gatewayTeardownJobs.findByUser(client.user.id), null);
      if (!scenario.pending) {
        assert.equal(live?.credentials.keyauth?.length ?? 0, 0, 'old material stays revoked');
        const signedIn = await h.loginUser('client@example.test');
        const fresh = await h.authed(signedIn, {
          method: 'POST',
          url: '/api/credentials',
          payload: { credential_type: 'keyauth' },
        });
        assert.equal(fresh.statusCode, 201, fresh.body);
        const withKey = await h.edgeClient.consumers.get(mapping.ferrum_consumer_id);
        assert.equal(withKey?.credentials.keyauth?.length, 1);
        assert.deepEqual(withKey?.acl_groups?.sort(), live?.acl_groups?.sort());
      }
    } finally {
      await h.close();
    }
  });
}

test('an active-status retry repairs a failed ACL restore', async () => {
  const h = await buildTestApp();
  try {
    const founder = await h.registerUser({ email: 'founder@example.test' });
    const provider = await h.registerUser({ email: 'provider@example.test', role: 'provider' });
    const client = await h.registerUser({ email: 'client@example.test', role: 'client' });
    const apiId = await publish(h, provider, 'retry-restore');
    await approve(h, provider, client, apiId);
    const update = (status: 'active' | 'disabled') =>
      h.authed(founder, {
        method: 'PATCH',
        url: `/api/users/${client.user.id}`,
        payload: { status },
      });
    assert.equal((await update('disabled')).statusCode, 200);
    h.edge.queueFailure(503, { error: 'down' }, '/consumers/', 'PUT');
    assert.equal((await update('active')).statusCode, 502);
    assert.equal((await h.store.users.findById(client.user.id))?.status, 'active');
    assert.equal((await update('active')).statusCode, 200);
    const mapping = await h.services.credentials.provisioner.findConsumer(client.user.id);
    const live = await h.edgeClient.consumers.get(mapping!.ferrum_consumer_id);
    assert.deepEqual(live?.acl_groups, [aclGroupForApi(apiId)]);
    assert.equal(live?.credentials.keyauth?.length ?? 0, 0);
  } finally {
    await h.close();
  }
});

test('re-enable does not recreate a provider test identity or provision an empty canonical consumer', async () => {
  const h = await buildTestApp();
  try {
    const founder = await h.registerUser({ email: 'founder@example.test' });
    const provider = await h.registerUser({ email: 'provider@example.test', role: 'provider' });
    const apiId = await publish(h, provider, 'provider-restore');
    const created = await h.authed(provider, {
      method: 'POST',
      url: `/api/apis/${apiId}/test-consumer`,
      payload: {},
    });
    assert.equal(created.statusCode, 201, created.body);
    for (const status of ['disabled', 'active']) {
      const response = await h.authed(founder, {
        method: 'PATCH',
        url: `/api/users/${provider.user.id}`,
        payload: { status },
      });
      assert.equal(response.statusCode, 200, response.body);
    }
    assert.equal(await h.edgeClient.consumers.getByUsername(`nexus-test-${apiId}`), null);
    assert.equal(await h.services.credentials.provisioner.findConsumer(provider.user.id), null);
    assert.deepEqual(await h.store.gatewayIdentities.listByUser(provider.user.id, 'nexus'), []);
  } finally {
    await h.close();
  }
});

test('a concurrent grant revocation wins after an in-flight restoration', async () => {
  const h = await buildTestApp();
  let release = () => {};
  try {
    const founder = await h.registerUser({ email: 'founder@example.test' });
    const provider = await h.registerUser({ email: 'provider@example.test', role: 'provider' });
    const client = await h.registerUser({ email: 'client@example.test', role: 'client' });
    const apiId = await publish(h, provider, 'restore-revoke-race');
    await approve(h, provider, client, apiId);
    const grant = await h.store.grants.findActiveByApiAndUser(apiId, client.user.id);
    assert.ok(grant);
    const actor = await h.store.users.findById(founder.user.id);
    assert.ok(actor);
    let arrived = () => {};
    const reading = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const realList = h.store.grants.listActiveByUser.bind(h.store.grants);
    h.store.grants.listActiveByUser = async (userId) => {
      h.store.grants.listActiveByUser = realList;
      const snapshot = await realList(userId);
      arrived();
      await held;
      return snapshot;
    };
    const restoring = h.services.credentials.restoreGatewayAccess(client.user.id, founder.user.id);
    await reading;
    let claimed = () => {};
    const revoking = new Promise<void>((resolve) => {
      claimed = resolve;
    });
    const realUpdate = h.store.grants.updateIfStatus.bind(h.store.grants);
    h.store.grants.updateIfStatus = async (...args) => {
      h.store.grants.updateIfStatus = realUpdate;
      const result = await realUpdate(...args);
      claimed();
      return result;
    };
    const revoked = h.services.access.revoke(actor, grant.id, 'Withdraw integration');
    await revoking;
    release();
    await Promise.all([restoring, revoked]);
    const mapping = await h.services.credentials.provisioner.findConsumer(client.user.id);
    const live = await h.edgeClient.consumers.get(mapping!.ferrum_consumer_id);
    assert.deepEqual(live?.acl_groups, []);
    assert.equal((await h.store.grants.findById(grant.id))?.status, 'revoked');
  } finally {
    release();
    await h.close();
  }
});
