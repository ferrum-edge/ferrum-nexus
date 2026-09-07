import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { describe, it } from 'node:test';

import { consumerUsernameForUser, type IssueCredentialResponse } from '@ferrum-nexus/shared';

import { createTeardownWorker } from '../credentials/teardown-worker.js';
import { buildTestApp, TEST_EDGE_JWT_SECRET } from './helpers.js';
import { createMockFerrumEdge } from './mock-ferrum-edge.js';

describe('gateway teardown after an invalid HTTP response', () => {
  for (const [status, body] of [
    [302, ''],
    [200, '<html>private-response-canary</html>'],
    [200, 'null'],
    [200, ''],
    [204, ''],
  ] as const) {
    it(`keeps revocation pending for ${status}/${body || 'empty'} and recovers`, async (t) => {
      const edge = createMockFerrumEdge({
        jwtSecret: TEST_EDGE_JWT_SECRET,
        issuer: 'ferrum-edge',
      });
      await edge.start();
      let intercept = false;
      let redirected = 0;
      const relay = createServer((req, res) => {
        if (req.url === '/redirect-target') redirected += 1;
        if (intercept && req.method === 'GET' && req.url?.startsWith('/consumers/')) {
          req.resume();
          res.writeHead(status, {
            location: '/redirect-target',
            'content-type': 'application/json',
          });
          res.end(body);
          return;
        }
        const upstream = request(
          new URL(req.url ?? '/', edge.url),
          { method: req.method, headers: req.headers },
          (response) => {
            res.writeHead(response.statusCode ?? 502, response.headers);
            response.pipe(res);
          },
        );
        upstream.on('error', () => res.destroy());
        req.pipe(upstream);
      });
      await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
      t.after(async () => {
        await new Promise<void>((resolve, reject) => {
          relay.close((error) => (error ? reject(error) : resolve()));
          relay.closeAllConnections();
        });
        await edge.stop();
      });
      const address = relay.address();
      assert.ok(address && typeof address !== 'string');
      const harness = await buildTestApp({
        edge,
        env: { FERRUM_ADMIN_URL: `http://127.0.0.1:${address.port}` },
      });
      t.after(() => harness.close());
      const founder = await harness.registerUser();
      const target = await harness.registerUser();
      const issued = await harness.authed(target, {
        method: 'POST',
        url: '/api/credentials',
        payload: { credential_type: 'keyauth', label: 'socket regression' },
      });
      assert.equal(issued.statusCode, 201, issued.body);
      const credentialId = issued.json<IssueCredentialResponse>().credential.id;
      const username = consumerUsernameForUser(target.user.id);
      const consumer = edge.consumerByUsername(username);
      assert.ok(consumer);
      consumer.acl_groups = ['nexus:api:fixture:approved'];
      const extra = edge.seedConsumer({
        username: 'nexus-test-socket',
        namespace: 'nexus',
        credentials: { keyauth: [{ key: 'fixture-test-key' }] },
        acl_groups: ['nexus:api:fixture:approved'],
      });
      const identity = await harness.store.gatewayIdentities.claim({
        user_id: target.user.id,
        namespace: 'nexus',
        ferrum_username: extra.username,
        ferrum_consumer_id: extra.id,
      });

      intercept = true;
      const disabled = await harness.authed(founder, {
        method: 'PATCH',
        url: `/api/users/${target.user.id}`,
        payload: { status: 'disabled' },
      });
      assert.equal(disabled.statusCode, 200, disabled.body);
      assert.equal(disabled.json<{ gateway_teardown: string }>().gateway_teardown, 'pending');
      assert.equal(
        (await harness.store.gatewayTeardownJobs.findByUser(target.user.id))?.status,
        'pending',
      );
      const tick = await harness.services.teardown.tick();
      assert.equal(tick.completed, 0);
      assert.equal(tick.rescheduled, 1);
      const pending = await harness.store.gatewayTeardownJobs.findByUser(target.user.id);
      assert.equal(pending?.status, 'pending');
      assert.equal(pending?.completed_at, null);
      assert.match(pending?.last_error ?? '', /invalid protocol response/);
      assert.ok(!pending?.last_error?.includes('private-response-canary'));
      assert.ok(await harness.store.gatewayIdentities.findById(identity.id));
      assert.equal((await harness.store.credentials.findById(credentialId))?.status, 'active');
      assert.equal(consumer.credentials.keyauth?.length, 1);
      assert.deepEqual(consumer.acl_groups, ['nexus:api:fixture:approved']);
      assert.equal(edge.consumerByUsername(extra.username)?.credentials.keyauth?.length, 1);
      assert.equal(redirected, 0);

      intercept = false;
      assert.ok(pending);
      const recovered = createTeardownWorker({
        store: harness.store,
        credentials: harness.services.credentials,
        audit: harness.services.audit,
        now: () => new Date(pending.next_attempt_at),
      });
      const retried = await recovered.tick();
      assert.equal(retried.completed, 1);
      assert.equal(retried.rescheduled, 0);
      assert.equal(
        (await harness.store.gatewayTeardownJobs.findByUser(target.user.id))?.status,
        'done',
      );
      assert.equal((await harness.store.credentials.findById(credentialId))?.status, 'revoked');
      assert.equal(await harness.store.gatewayIdentities.findById(identity.id), null);
      assert.equal(edge.consumerByUsername(extra.username), undefined);
      assert.deepEqual(edge.consumerByUsername(username)?.credentials, {});
      assert.deepEqual(edge.consumerByUsername(username)?.acl_groups, []);
    });
  }
});
