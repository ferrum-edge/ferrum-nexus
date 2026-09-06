import assert from 'node:assert/strict';
import { it } from 'node:test';

import { aclGroupForApi, consumerUsernameForUser } from '@ferrum-nexus/shared';

import { buildTestApp, SAMPLE_SPEC_YAML, type TestApp } from './helpers.js';

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function setup(h: TestApp) {
  const owner = await h.registerUser();
  const client = await h.registerUser({ role: 'client' });
  const published = await h.authed(owner, {
    method: 'POST',
    url: '/api/apis',
    payload: {
      name: 'Admission',
      slug: 'admission',
      spec: SAMPLE_SPEC_YAML,
      auth_plugin: 'key_auth',
      requestable: true,
      visibility: 'public',
    },
  });
  assert.equal(published.statusCode, 201, published.body);
  const apiId = published.json<{ api: { id: string } }>().api.id;
  const requested = await h.authed(client, {
    method: 'POST',
    url: '/api/access-requests',
    payload: { api_id: apiId, justification: 'Integration access' },
  });
  assert.equal(requested.statusCode, 201, requested.body);
  const requestId = requested.json<{ access_request: { id: string } }>().access_request.id;
  const approve = () =>
    h.authed(owner, { method: 'POST', url: `/api/access-requests/${requestId}/approve` });
  const change = (payload: Record<string, unknown>) =>
    h.authed(owner, { method: 'PATCH', url: `/api/apis/${apiId}`, payload });
  return { owner, client, apiId, requestId, approve, change };
}

for (const policy of [{ status: 'retired' }, { requestable: false }]) {
  it(`refuses pending approval after policy changes to ${JSON.stringify(policy)}`, async () => {
    const h = await buildTestApp();
    try {
      const s = await setup(h);
      const changed = await s.change(policy);
      assert.equal(changed.statusCode, 200, changed.body);
      const approved = await s.approve();
      assert.equal(approved.statusCode, 409, approved.body);
      assert.equal((await h.store.accessRequests.findById(s.requestId))?.status, 'pending');
      assert.equal(await h.store.grants.findActiveByApiAndUser(s.apiId, s.client.user.id), null);
      assert.equal(h.edge.consumerByUsername(consumerUsernameForUser(s.client.user.id)), undefined);
      const requested = await h.authed(s.client, {
        method: 'POST',
        url: '/api/access-requests',
        payload: { api_id: s.apiId, justification: 'After policy change' },
      });
      assert.equal(requested.statusCode, 409, requested.body);
      const cancelled = await h.authed(s.client, {
        method: 'POST',
        url: `/api/access-requests/${s.requestId}/cancel`,
      });
      assert.equal(cancelled.statusCode, 200, cancelled.body);
      assert.equal(await h.store.grants.findActiveByApiAndUser(s.apiId, s.client.user.id), null);
    } finally {
      await h.close();
    }
  });
}

for (const first of ['retire', 'approve']) {
  it(`orders ${first} before the competing operation`, { timeout: 20_000 }, async () => {
    const h = await buildTestApp();
    try {
      const s = await setup(h);
      const entered = barrier();
      const queued = barrier();
      const release = barrier();
      const api = await h.store.apis.findById(s.apiId);
      const key = `proxy:${api!.ferrum_proxy_id}`;
      const serialize = h.edgeClient.serializePerKey;
      let arrivals = 0;
      h.edgeClient.serializePerKey = (candidate, work) => {
        if (candidate === key && ++arrivals === 2) queued.release();
        return serialize(candidate, work);
      };
      if (first === 'retire') {
        const update = h.store.apis.update.bind(h.store.apis);
        h.store.apis.update = async (...args) => {
          if (args[0] === s.apiId) {
            entered.release();
            await release.promise;
          }
          return update(...args);
        };
      } else {
        const claim = h.store.accessRequests.updateIfStatus.bind(h.store.accessRequests);
        h.store.accessRequests.updateIfStatus = async (...args) => {
          if (args[0] === s.requestId) {
            entered.release();
            await release.promise;
          }
          return claim(...args);
        };
      }
      const leading = first === 'retire' ? s.change({ status: 'retired' }) : s.approve();
      await entered.promise;
      const following = first === 'retire' ? s.approve() : s.change({ status: 'retired' });
      await queued.promise;
      release.release();
      const [leadResponse, followResponse] = await Promise.all([leading, following]);
      assert.equal(leadResponse.statusCode, 200, leadResponse.body);
      assert.equal(followResponse.statusCode, first === 'retire' ? 409 : 200, followResponse.body);
      assert.equal((await h.store.apis.findById(s.apiId))?.status, 'retired');
      const grant = await h.store.grants.findActiveByApiAndUser(s.apiId, s.client.user.id);
      const remote = h.edge.consumerByUsername(consumerUsernameForUser(s.client.user.id));
      if (first === 'retire') {
        assert.equal(grant, null);
        assert.equal(remote, undefined);
        assert.equal((await h.store.accessRequests.findById(s.requestId))?.status, 'pending');
      } else {
        assert.equal(grant?.status, 'active');
        assert.deepEqual(remote?.acl_groups, [aclGroupForApi(s.apiId)]);
      }
    } finally {
      await h.close();
    }
  });
}
