import assert from 'node:assert/strict';
import { it } from 'node:test';

import { aclGroupForApi, consumerUsernameForUser } from '@ferrum-nexus/shared';

import { canonicalConsumerLockKey } from '../credentials/consumers.js';
import { CONSUMER_SCAN_LIMIT } from '../ferrum-admin/client.js';
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
  const lookup = h.edgeClient.consumers.ensure.bind(h.edgeClient.consumers);
  const create = h.edgeClient.consumers.create.bind(h.edgeClient.consumers);
  let arrivals = 0;
  let reads = 0;
  let creates = 0;
  h.edgeClient.serializePerKey = (candidate, work) => {
    if (candidate === key && ++arrivals === 2) queued.release();
    return serialize(candidate, work);
  };
  h.edgeClient.consumers.ensure = async (body, subject) => {
    if (body.username === consumerUsernameForUser(userId)) {
      reads += 1;
      if (reads === 1) {
        entered.release();
        await releaseRead.promise;
      }
    }
    return lookup(body, subject);
  };
  h.edgeClient.consumers.create = async (...args) => {
    if (args[0].username === consumerUsernameForUser(userId)) creates += 1;
    return create(...args);
  };
  return { entered, queued, releaseRead, counts: () => ({ reads, creates }) };
}

it('orders first issuance through one canonical identity', { timeout: 20_000 }, async () => {
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
    assert.equal(h.edge.callsTo('POST', '/consumers').length, 1);
    assert.equal(
      h.edge.callsTo('GET', '/consumers').filter((call) => call.path === '/consumers').length,
      0,
      'a failed mapping insert is recovered by direct id without a scan',
    );
  } finally {
    await h.close();
  }
});

it('separates provisioning keys by namespace without delimiter collisions', () => {
  assert.notEqual(
    canonicalConsumerLockKey('alpha', 'user'),
    canonicalConsumerLockKey('beta', 'user'),
  );
  assert.notEqual(canonicalConsumerLockKey('a:b', 'c'), canonicalConsumerLockKey('a', 'b:c'));
});

it('provisions credentials, approvals and test consumers beyond 10,000 consumers', async () => {
  const h = await buildTestApp();
  try {
    const provider = await h.registerUser();
    const client = await h.registerUser({ role: 'client' });
    const applicant = await h.registerUser({ role: 'client' });
    for (let index = 0; index <= CONSUMER_SCAN_LIMIT; index += 1) {
      h.edge.seedConsumer({ username: `filler-${index}`, namespace: 'nexus' });
    }
    const published = await h.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: {
        name: 'Large namespace',
        slug: 'large-namespace',
        spec: SAMPLE_SPEC_YAML,
        auth_plugin: 'key_auth',
        requestable: true,
        visibility: 'public',
      },
    });
    assert.equal(published.statusCode, 201, published.body);
    const apiId = published.json<{ api: { id: string } }>().api.id;
    const issued = await h.authed(client, {
      method: 'POST',
      url: '/api/credentials',
      payload: { credential_type: 'keyauth' },
    });
    assert.equal(issued.statusCode, 201, issued.body);
    const requested = await h.authed(applicant, {
      method: 'POST',
      url: '/api/access-requests',
      payload: { api_id: apiId, justification: 'Integration access' },
    });
    assert.equal(requested.statusCode, 201, requested.body);
    const requestId = requested.json<{ access_request: { id: string } }>().access_request.id;
    const approved = await h.authed(provider, {
      method: 'POST',
      url: `/api/access-requests/${requestId}/approve`,
      payload: {},
    });
    assert.equal(approved.statusCode, 200, approved.body);
    // Replacements must use the registry too, including the fresh id Nexus
    // assigns each replacement. Exercise two replacements, not just first use.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const tested = await h.authed(provider, {
        method: 'POST',
        url: `/api/apis/${apiId}/test-consumer`,
        payload: {},
      });
      assert.equal(tested.statusCode, 201, tested.body);
    }
    const lists = h.edge.callsTo('GET', '/consumers').filter((call) => call.path === '/consumers');
    assert.equal(lists.length, 0, 'normal provisioning never scans the namespace');
  } finally {
    await h.close();
  }
});

it('adopts a legacy consumer without a portal mapping and caches its original id', async () => {
  const h = await buildTestApp();
  try {
    const user = await h.registerUser();
    for (let index = 0; index < 501; index += 1) {
      h.edge.seedConsumer({ username: `legacy-filler-${index}`, namespace: 'nexus' });
    }
    const legacy = h.edge.seedConsumer({
      username: consumerUsernameForUser(user.user.id),
      custom_id: user.user.id,
      namespace: 'nexus',
    });
    const provisioner = h.services.credentials.provisioner;
    const mapping = await provisioner.ensureConsumer(user.user);
    assert.equal(mapping.ferrum_consumer_id, legacy.id);
    const calls = h.edge.callsTo('GET', '/consumers').length;
    assert.equal((await provisioner.ensureConsumer(user.user)).id, mapping.id);
    assert.equal(h.edge.callsTo('GET', '/consumers').length, calls);
    assert.equal(h.edge.consumers.size, 502, 'adoption does not create a duplicate');
  } finally {
    await h.close();
  }
});

it('replaces a legacy test consumer whose registry row has no id', async () => {
  const h = await buildTestApp();
  try {
    const provider = await h.registerUser();
    const published = await h.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: {
        name: 'Legacy test identity',
        slug: 'legacy-test-identity',
        spec: SAMPLE_SPEC_YAML,
        auth_plugin: 'key_auth',
        requestable: true,
        visibility: 'public',
      },
    });
    assert.equal(published.statusCode, 201, published.body);
    const apiId = published.json<{ api: { id: string } }>().api.id;
    const username = `nexus-test-${apiId}`;
    const identity = await h.services.credentials.claimGatewayIdentity(provider.user.id, username);
    assert.equal(identity.ferrum_consumer_id, null);
    const legacy = h.edge.seedConsumer({ username, namespace: 'nexus' });
    const replaced = await h.authed(provider, {
      method: 'POST',
      url: `/api/apis/${apiId}/test-consumer`,
      payload: {},
    });
    assert.equal(replaced.statusCode, 201, replaced.body);
    const bound = await h.store.gatewayIdentities.findByUsername('nexus', username);
    assert.equal(bound?.ferrum_consumer_id, h.edge.consumerByUsername(username)?.id);
    assert.notEqual(bound?.ferrum_consumer_id, legacy.id);
    assert.equal(h.edge.consumers.has(`nexus/${legacy.id}`), false);
  } finally {
    await h.close();
  }
});
