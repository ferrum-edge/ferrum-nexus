import assert from 'node:assert/strict';
import { it } from 'node:test';

import { aclGroupForApi, consumerUsernameForUser } from '@ferrum-nexus/shared';

import { canonicalConsumerLockKey } from '../credentials/consumers.js';
import { buildTestApp, SAMPLE_SPEC_YAML, type TestApp } from './helpers.js';

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Hold the first name lookup until the second operation reaches the name queue. */
function overlapProvisioning(h: TestApp, userId: string) {
  const entered = barrier();
  const queued = barrier();
  const releaseRead = barrier();
  const key = canonicalConsumerLockKey(h.config.edge.namespace, consumerUsernameForUser(userId));
  const serialize = h.edgeClient.serializePerKey;
  const lookup = h.edgeClient.consumers.getByUsername.bind(h.edgeClient.consumers);
  const create = h.edgeClient.consumers.create.bind(h.edgeClient.consumers);
  let arrivals = 0;
  let reads = 0;
  let creates = 0;
  h.edgeClient.serializePerKey = (candidate, work) => {
    if (candidate === key && ++arrivals === 2) queued.release();
    return serialize(candidate, work);
  };
  h.edgeClient.consumers.getByUsername = async (username) => {
    if (username === consumerUsernameForUser(userId)) {
      reads += 1;
      if (reads === 1) {
        entered.release();
        await releaseRead.promise;
      }
    }
    return lookup(username);
  };
  h.edgeClient.consumers.create = async (...args) => {
    if (args[0].username === consumerUsernameForUser(userId)) creates += 1;
    return create(...args);
  };
  return { entered, queued, releaseRead, counts: () => ({ reads, creates }) };
}

it('orders concurrent first issuance through one canonical identity', { timeout: 20_000 }, async () => {
  const h = await buildTestApp();
  try {
    const user = await h.registerUser();
    const gates = overlapProvisioning(h, user.user.id);
    const issue = () =>
      h.authed(user, {
        method: 'POST',
        url: '/api/credentials',
        payload: { credential_type: 'keyauth' },
      });
    const first = issue();
    await gates.entered.promise;
    const second = issue();
    await gates.queued.promise;
    gates.releaseRead.release();
    const responses = await Promise.all([first, second]);
    for (const response of responses) assert.equal(response.statusCode, 201, response.body);
    assert.deepEqual(gates.counts(), { reads: 1, creates: 1 });
    const mapping = await h.services.credentials.provisioner.findConsumer(user.user.id);
    const remote = h.edge.consumerByUsername(consumerUsernameForUser(user.user.id));
    assert.equal(mapping?.ferrum_consumer_id, remote?.id);
    assert.equal(remote?.credentials.keyauth?.length, 2);
    assert.equal((await h.store.credentials.list({ user_id: user.user.id })).total, 2);
  } finally {
    await h.close();
  }
});

it('preserves credentials and ACLs on first-use overlap', { timeout: 20_000 }, async () => {
  const h = await buildTestApp();
  try {
    const provider = await h.registerUser();
    const user = await h.registerUser({ role: 'client' });
    const published = await h.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: {
        name: 'First approval',
        slug: 'first-approval',
        spec: SAMPLE_SPEC_YAML,
        auth_plugin: 'key_auth',
        requestable: true,
        visibility: 'public',
      },
    });
    assert.equal(published.statusCode, 201, published.body);
    const apiId = published.json<{ api: { id: string } }>().api.id;
    const requested = await h.authed(user, {
      method: 'POST',
      url: '/api/access-requests',
      payload: { api_id: apiId, justification: 'Integration access' },
    });
    assert.equal(requested.statusCode, 201, requested.body);
    const requestId = requested.json<{ access_request: { id: string } }>().access_request.id;
    const gates = overlapProvisioning(h, user.user.id);
    const issued = h.authed(user, {
      method: 'POST',
      url: '/api/credentials',
      payload: { credential_type: 'keyauth' },
    });
    await gates.entered.promise;
    const approved = h.authed(provider, {
      method: 'POST',
      url: `/api/access-requests/${requestId}/approve`,
      payload: {},
    });
    await gates.queued.promise;
    gates.releaseRead.release();
    const [issueResponse, approvalResponse] = await Promise.all([issued, approved]);
    assert.equal(issueResponse.statusCode, 201, issueResponse.body);
    assert.equal(approvalResponse.statusCode, 200, approvalResponse.body);
    assert.deepEqual(gates.counts(), { reads: 1, creates: 1 });
    const remote = h.edge.consumerByUsername(consumerUsernameForUser(user.user.id));
    assert.equal(remote?.credentials.keyauth?.length, 1);
    assert.deepEqual(remote?.acl_groups, [aclGroupForApi(apiId)]);
    assert.equal(remote?.custom_id, user.user.id);
  } finally {
    await h.close();
  }
});

it('adopts the same remote identity after local mapping persistence fails', async () => {
  const h = await buildTestApp();
  try {
    const user = await h.registerUser();
    const provisioner = h.services.credentials.provisioner;
    const insert = h.store.consumers.create.bind(h.store.consumers);
    h.store.consumers.create = async () => {
      throw new Error('mapping unavailable');
    };
    await assert.rejects(provisioner.ensureConsumer(user.user), /mapping unavailable/);
    const remote = h.edge.consumerByUsername(consumerUsernameForUser(user.user.id));
    assert.ok(remote);
    assert.equal(await provisioner.findConsumer(user.user.id), null);
    h.store.consumers.create = insert;
    const adopted = await provisioner.ensureConsumer(user.user);
    assert.equal(adopted.ferrum_consumer_id, remote.id);
    assert.equal((await provisioner.ensureConsumer(user.user)).id, adopted.id);
  } finally {
    await h.close();
  }
});

it('separates provisioning keys by namespace without delimiter collisions', () => {
  assert.notEqual(canonicalConsumerLockKey('alpha', 'user'), canonicalConsumerLockKey('beta', 'user'));
  assert.notEqual(canonicalConsumerLockKey('a:b', 'c'), canonicalConsumerLockKey('a', 'b:c'));
});
