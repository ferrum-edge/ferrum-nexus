/**
 * A gateway `404` means "already gone" only when Ferrum Edge says so (issue
 * #548).
 *
 * A router or proxy in front of the Edge admin API answers `404` for a route it
 * does not know, with a body of its own. Read as Edge's not-found, that answer
 * let an API delete record a live proxy as removed, a restore build a second
 * proxy beside a live one, and a reconciliation pass report a live proxy as
 * orphaned. Each path here is held to Edge's resource-specific not-found body;
 * the client contract for every such route is in `client.protocol.test.ts`.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { ApiErrorBody, PublishApiResponse } from '@ferrum-nexus/shared';

import { buildTestApp, SAMPLE_SPEC_YAML, type TestApp, type TestSession } from './helpers.js';

const NAMESPACE = 'nexus';

/** What a router in front of Edge answers for a route it does not have. */
const ROUTER_404 = { message: 'Route not found', error: 'Not Found', statusCode: 404 };

describe('confirmed gateway absence', () => {
  let harness: TestApp;
  let provider: TestSession;
  let apiId: string;
  let proxyId: string;

  function deleteApi(): ReturnType<TestApp['authed']> {
    return harness.authed(provider, { method: 'DELETE', url: `/api/apis/${apiId}` });
  }

  beforeEach(async () => {
    harness = await buildTestApp();
    await harness.registerUser({ email: 'absence-founder@example.test' });
    provider = await harness.registerUser({
      email: 'absence-provider@example.test',
      role: 'provider',
    });
    const published = await harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: {
        name: 'Absence billing',
        slug: 'absence-billing',
        spec: SAMPLE_SPEC_YAML,
        auth_plugin: 'key_auth',
        requestable: true,
        visibility: 'public',
      },
    });
    assert.equal(published.statusCode, 201, published.body);
    apiId = published.json<PublishApiResponse>().api.id;
    const row = await harness.store.apis.findById(apiId);
    assert.ok(row?.ferrum_proxy_id);
    proxyId = row.ferrum_proxy_id;
  });

  afterEach(async () => {
    await harness.close();
  });

  it('keeps the API when a router answers its proxy delete with a 404', async () => {
    harness.edge.queueFailure(404, ROUTER_404, `/proxies/${proxyId}`, 'DELETE');
    const failed = await deleteApi();
    assert.equal(failed.statusCode, 502, failed.body);
    assert.equal(failed.json<ApiErrorBody>().error.code, 'EDGE_PROTOCOL_ERROR');
    assert.equal((await harness.store.apis.findById(apiId))?.ferrum_proxy_id, proxyId);
    assert.ok(harness.edge.proxies.has(`${NAMESPACE}/${proxyId}`), 'the proxy is still live');

    // Retried against the gateway itself, the delete completes.
    const removed = await deleteApi();
    assert.equal(removed.statusCode, 200, removed.body);
    assert.equal(await harness.store.apis.findById(apiId), null);
    assert.equal(harness.edge.proxies.has(`${NAMESPACE}/${proxyId}`), false);
  });

  it('completes the delete when Edge itself says the proxy is gone', async () => {
    await harness.edgeClient.proxies.delete(proxyId);
    assert.equal(harness.edge.proxies.has(`${NAMESPACE}/${proxyId}`), false);

    const removed = await deleteApi();
    assert.equal(removed.statusCode, 200, removed.body);
    assert.equal(await harness.store.apis.findById(apiId), null);
  });

  it('never rebuilds beside a proxy a router answered 404 for', async () => {
    const proxies = harness.edge.proxies.size;
    harness.edge.queueFailure(404, ROUTER_404, `/proxies/${proxyId}`, 'GET');
    const response = await harness.authed(provider, {
      method: 'POST',
      url: `/api/apis/${apiId}/restore-gateway`,
      payload: {},
    });
    assert.equal(response.statusCode, 502, response.body);
    assert.equal(response.json<ApiErrorBody>().error.code, 'EDGE_PROTOCOL_ERROR');

    const row = await harness.store.apis.findById(apiId);
    assert.equal(row?.ferrum_proxy_id, proxyId, 'the reference is untouched');
    assert.equal(row?.gateway_state, 'deployed');
    assert.equal(harness.edge.proxies.size, proxies, 'no second proxy was built');
  });

  it('never reports a live proxy as orphaned on a router 404', async () => {
    harness.edge.queueFailure(404, ROUTER_404, `/proxies/${proxyId}`, 'GET');
    const unread = await harness.services.reconciliation.scan();
    assert.equal(unread.status, 'unknown');
    assert.deepEqual(unread.orphaned_proxies, []);
    const row = await harness.store.apis.findById(apiId);
    assert.equal(row?.ferrum_proxy_id, proxyId);
    assert.equal(row?.gateway_state, 'deployed');

    // With Edge answering for itself, the same proxy reads as present.
    const read = await harness.services.reconciliation.scan();
    assert.equal(read.status, 'ok');
    assert.equal(read.proxies.orphaned, 0);
  });
});
