/**
 * The disposable `nexus-test-<api_id>` consumer, from a create whose
 * acknowledgement went missing to the deletion of the API it belongs to.
 *
 * Two defects, one resource. Issue #139: a `POST /consumers` Edge *applied* and
 * failed to acknowledge left `consumerId` `null` in the compensation, which
 * skipped the delete and then removed the registration anyway — an orphan on
 * the gateway carrying the API's approval group, with nothing in the product
 * that could ever find it again. Issue #136: `DELETE /api/apis/:id` tore down
 * the proxy and every portal row but never the test consumer, so an ordinary
 * deletion leaked the same identity, its key and its group by design.
 *
 * The property both halves are measured against is the registry's own:
 * **a consumer that may exist keeps a registration until it is known to be
 * gone, and an API that is gone leaves no identity of its own behind.**
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  aclGroupForApi,
  type ApiErrorBody,
  type CreateTestConsumerResponse,
  type PublishApiResponse,
} from '@ferrum-nexus/shared';

import { derivedConsumerId } from '../ferrum-admin/client.js';
import { buildTestApp, SAMPLE_SPEC_YAML, type TestApp, type TestSession } from './helpers.js';

function errorCode(body: string): string {
  return (JSON.parse(body) as ApiErrorBody).error.code;
}

describe('test consumer lifecycle', () => {
  let harness: TestApp;
  let founder: TestSession;
  let provider: TestSession;
  let counter = 0;

  before(async () => {
    harness = await buildTestApp();
    founder = await harness.registerUser({ email: 'test-consumer-founder@example.test' });
    provider = await harness.registerUser({
      email: 'test-consumer-provider@example.test',
      role: 'provider',
    });
  });

  after(async () => {
    await harness.close();
  });

  beforeEach(() => {
    harness.edge.clearInjections();
  });

  async function publish(): Promise<{ id: string }> {
    counter += 1;
    const response = await harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: {
        name: `Lifecycle API ${counter}`,
        slug: `lifecycle-api-${counter}`,
        spec: SAMPLE_SPEC_YAML,
        auth_plugin: 'key_auth',
        requestable: true,
        visibility: 'public',
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<PublishApiResponse>().api;
  }

  function createTestConsumer(apiId: string) {
    return harness.authed(provider, {
      method: 'POST',
      url: `/api/apis/${apiId}/test-consumer`,
      payload: {},
    });
  }

  function deleteApi(apiId: string, actor: TestSession = provider) {
    return harness.authed(actor, { method: 'DELETE', url: `/api/apis/${apiId}` });
  }

  async function registrationFor(username: string) {
    return harness.store.gatewayIdentities.findByUsername('nexus', username);
  }

  /**
   * The `id` the last `POST /consumers` asked Edge to assign — the id whose
   * create the compensation has to settle when no answer came back. Exact
   * path, so a credential append (`/consumers/:id/credentials/:type`) is not
   * mistaken for a consumer create.
   */
  function lastRequestedConsumerId(): string | undefined {
    const posts = harness.edge.callsTo('POST', '/consumers');
    const posted = posts.filter((entry) => entry.path === '/consumers').at(-1);
    const body = posted?.body;
    return typeof body === 'object' && body !== null && 'id' in body
      ? String((body as { id: unknown }).id)
      : undefined;
  }

  /* ── #139: the create that was applied but never acknowledged ─────────── */

  it('deletes a consumer whose create was applied but never acknowledged', async () => {
    const api = await publish();
    const username = `nexus-test-${api.id}`;

    // Edge stores the consumer and then answers 503: the write landed, the
    // caller has no id for it, and the client never retries a write.
    harness.edge.queueLostAck(503, undefined, '/consumers', 'POST');
    const attempt = await createTestConsumer(api.id);
    assert.equal(attempt.statusCode, 502, attempt.body);
    assert.equal(errorCode(attempt.body), 'EDGE_ERROR');

    // Neither half of the orphan survives: the create asked for the id the
    // username derives to, so the compensation resolved the consumer by that
    // id and deleted it, and only then was the registration released.
    assert.equal(
      lastRequestedConsumerId(),
      derivedConsumerId('nexus', username),
      'the first consumer of a username is created under its derived id',
    );
    assert.equal(
      harness.edge.consumerByUsername(username),
      undefined,
      'the unacknowledged consumer was collected',
    );
    assert.equal(await registrationFor(username), null, 'and its registration with it');
    for (const consumer of harness.edge.consumers.values()) {
      assert.ok(
        !consumer.acl_groups.includes(aclGroupForApi(api.id)),
        `no consumer keeps the approval group (${consumer.username} does)`,
      );
    }

    // And the API is still usable: the next attempt succeeds normally.
    const retried = await createTestConsumer(api.id);
    assert.equal(retried.statusCode, 201, retried.body);
    assert.ok(harness.edge.consumerByUsername(username));
  });

  it('keeps the registration when the compensating delete cannot run', async () => {
    const api = await publish();
    const username = `nexus-test-${api.id}`;

    // The create lands unacknowledged, and the compensation's delete fails
    // too. Now the consumer is definitely up and Nexus definitely cannot
    // remove it — the one case where the registration must survive.
    harness.edge.queueLostAck(503, undefined, '/consumers', 'POST');
    harness.edge.queueFailure(503, { error: 'down' }, '/consumers/', 'DELETE');
    const attempt = await createTestConsumer(api.id);
    assert.equal(attempt.statusCode, 502, attempt.body);

    const live = harness.edge.consumerByUsername(username);
    assert.ok(live, 'the consumer is still up');
    const registration = await registrationFor(username);
    assert.ok(registration, 'so the registration that leads to it is kept');
    assert.equal(registration.user_id, provider.user.id);

    // Which is exactly what makes it reclaimable: a later deletion of the API
    // finds it through that registration and collects it.
    const removed = await deleteApi(api.id);
    assert.equal(removed.statusCode, 200, removed.body);
    assert.equal(harness.edge.consumerByUsername(username), undefined);
    assert.equal(await registrationFor(username), null);
  });

  it('leaves nothing behind when the create genuinely never landed', async () => {
    const api = await publish();
    const username = `nexus-test-${api.id}`;

    // A refused write, not a lost acknowledgement: nothing was stored, so
    // nothing is owed and no row may be left over either.
    harness.edge.queueFailure(503, { error: 'down' }, '/consumers', 'POST');
    const attempt = await createTestConsumer(api.id);
    assert.equal(attempt.statusCode, 502, attempt.body);

    assert.equal(harness.edge.consumerByUsername(username), undefined);
    assert.equal(await registrationFor(username), null, 'no registration is leaked');
  });

  it('gives a replacement its own id and collects it there when the create is lost', async () => {
    const api = await publish();
    const username = `nexus-test-${api.id}`;

    const first = await createTestConsumer(api.id);
    assert.equal(first.statusCode, 201, first.body);
    const firstCredentialId = first.json<CreateTestConsumerResponse>().credential.id;
    const firstId = harness.edge.consumerByUsername(username)?.id;
    assert.ok(firstId);
    assert.equal(
      firstId,
      derivedConsumerId('nexus', username),
      'the first consumer of the username holds the derived id',
    );

    // The replacement's create lands and its acknowledgement is lost. The id
    // it asked for is the only thing the compensation has to go on.
    const deletesBefore = harness.edge.callsTo('DELETE', '/consumers/').length;
    harness.edge.queueLostAck(503, undefined, '/consumers', 'POST');
    const replacement = await createTestConsumer(api.id);
    assert.equal(replacement.statusCode, 502, replacement.body);
    assert.equal(errorCode(replacement.body), 'EDGE_ERROR');

    const attemptedId = lastRequestedConsumerId();
    assert.ok(attemptedId);
    assert.notEqual(
      attemptedId,
      firstId,
      'a replacement is a distinct consumer, not the replaced one under its own id',
    );
    // Two deletes, in order: the consumer being replaced, then the
    // unacknowledged replacement resolved by the id it was created under.
    assert.equal(harness.edge.callsTo('DELETE', '/consumers/').length - deletesBefore, 2);
    assert.equal(harness.edge.callsTo('DELETE', `/consumers/${attemptedId}`).length, 1);
    assert.equal(harness.edge.consumers.has(`nexus/${attemptedId}`), false);
    assert.equal(harness.edge.consumerByUsername(username), undefined);
    assert.equal(await registrationFor(username), null, 'the registration is released');

    // The two consumers stayed distinguishable throughout, which is the whole
    // point of the fresh id: the replaced consumer's row is revoked, and the
    // replacement — which never got one — leaves none behind.
    assert.equal((await harness.store.credentials.findById(firstCredentialId))?.status, 'revoked');
    assert.deepEqual(await harness.store.credentials.listByConsumer(attemptedId), []);
    assert.equal((await harness.store.credentials.listByConsumer(firstId)).length, 1);
    for (const consumer of harness.edge.consumers.values()) {
      assert.ok(!consumer.acl_groups.includes(aclGroupForApi(api.id)));
    }
  });

  it('leaves the consumer it could not replace, and its rows, exactly as they were', async () => {
    const api = await publish();
    const username = `nexus-test-${api.id}`;

    const first = await createTestConsumer(api.id);
    assert.equal(first.statusCode, 201, first.body);
    const credentialId = first.json<CreateTestConsumerResponse>().credential.id;
    const live = harness.edge.consumerByUsername(username);
    assert.ok(live);

    // The delete of the consumer being replaced fails, so no create is ever
    // issued. The compensation has no attempted id, and must not go hunting
    // for one — the consumer it would find is the one that is still in use.
    const deletesBefore = harness.edge.callsTo('DELETE', '/consumers/').length;
    harness.edge.queueFailure(503, { error: 'down' }, `/consumers/${live.id}`, 'DELETE');
    const replacement = await createTestConsumer(api.id);
    assert.equal(replacement.statusCode, 502, replacement.body);

    assert.equal(harness.edge.callsTo('DELETE', '/consumers/').length - deletesBefore, 1);
    assert.equal(harness.edge.consumerByUsername(username)?.id, live.id, 'the consumer survives');
    assert.equal(harness.edge.consumerByUsername(username)?.credentials.keyauth?.length, 1);
    assert.deepEqual(harness.edge.consumerByUsername(username)?.acl_groups, [
      aclGroupForApi(api.id),
    ]);
    assert.equal(
      (await harness.store.credentials.findById(credentialId))?.status,
      'active',
      'and so does the key the provider is still holding',
    );

    // Deleting the API collects it, registration or no registration.
    const removed = await deleteApi(api.id);
    assert.equal(removed.statusCode, 200, removed.body);
    assert.equal(harness.edge.consumerByUsername(username), undefined);
    assert.equal((await harness.store.credentials.findById(credentialId))?.status, 'revoked');
  });

  it('retains a fresh-id consumer registration when a later replacement fails', async () => {
    const api = await publish();
    const username = `nexus-test-${api.id}`;

    assert.equal((await createTestConsumer(api.id)).statusCode, 201);
    const replaced = await createTestConsumer(api.id);
    assert.equal(replaced.statusCode, 201, replaced.body);
    const credentialId = replaced.json<CreateTestConsumerResponse>().credential.id;
    const live = harness.edge.consumerByUsername(username);
    assert.ok(live);
    assert.notEqual(live.id, derivedConsumerId('nexus', username));

    harness.edge.queueFailure(503, { error: 'down' }, `/consumers/${live.id}`, 'DELETE');
    const failed = await createTestConsumer(api.id);
    assert.equal(failed.statusCode, 502, failed.body);
    assert.equal((await registrationFor(username))?.ferrum_consumer_id, live.id);

    const removed = await deleteApi(api.id);
    assert.equal(removed.statusCode, 200, removed.body);
    assert.equal(harness.edge.consumerByUsername(username), undefined);
    assert.equal((await harness.store.credentials.findById(credentialId))?.status, 'revoked');
    assert.equal(await registrationFor(username), null);
  });

  /* ── #136: deleting the API collects the identity it created ──────────── */

  it('tears down the test consumer, its credential and its group with the API', async () => {
    const api = await publish();
    const username = `nexus-test-${api.id}`;

    const created = await createTestConsumer(api.id);
    assert.equal(created.statusCode, 201, created.body);
    const credentialId = created.json<CreateTestConsumerResponse>().credential.id;
    const live = harness.edge.consumerByUsername(username);
    assert.ok(live);
    assert.equal(live.credentials.keyauth?.length, 1);
    assert.deepEqual(live.acl_groups, [aclGroupForApi(api.id)]);

    const removed = await deleteApi(api.id);
    assert.equal(removed.statusCode, 200, removed.body);

    assert.equal(harness.edge.consumerByUsername(username), undefined, 'the consumer is gone');
    assert.equal(await registrationFor(username), null, 'its registration is consumed');
    assert.equal(
      (await harness.store.credentials.findById(credentialId))?.status,
      'revoked',
      'and the mirror follows the gateway',
    );
    for (const consumer of harness.edge.consumers.values()) {
      assert.ok(!consumer.acl_groups.includes(aclGroupForApi(api.id)));
    }

    const audited = (await harness.auditRows('api.delete')).find((row) => row.target_id === api.id);
    assert.ok(audited, 'the deletion is audited');
    assert.equal(audited.details.test_consumer_id, live.id);
    assert.equal(audited.details.test_consumer_revoked_credentials, 1);
  });

  it('deletes an API that never had a test consumer without touching anything', async () => {
    const api = await publish();
    const before = harness.edge.consumers.size;

    const removed = await deleteApi(api.id);
    assert.equal(removed.statusCode, 200, removed.body);
    assert.equal(harness.edge.consumers.size, before, 'no consumer was created or destroyed');

    const audited = (await harness.auditRows('api.delete')).find((row) => row.target_id === api.id);
    assert.ok(audited);
    assert.equal(
      audited.details.test_consumer_id,
      undefined,
      'and nothing claims a teardown that was never needed',
    );
  });

  it('refuses the deletion rather than reporting success over a stranded identity', async () => {
    const api = await publish();
    const username = `nexus-test-${api.id}`;

    const created = await createTestConsumer(api.id);
    assert.equal(created.statusCode, 201, created.body);

    harness.edge.queueFailure(503, { error: 'down' }, '/consumers/', 'DELETE');
    const refused = await deleteApi(api.id);
    assert.equal(refused.statusCode, 502, refused.body);

    // The API is still in the portal, which is what makes the retry possible;
    // the identity is still registered, which is what makes it findable.
    assert.ok(await harness.store.apis.findById(api.id), 'the API row survives for the retry');
    assert.ok(await registrationFor(username), 'the registration survives with it');
    assert.equal(
      (await harness.auditRows('api.delete')).find((row) => row.target_id === api.id),
      undefined,
      'and nothing is audited as a completed delete',
    );

    const retried = await deleteApi(api.id);
    assert.equal(retried.statusCode, 200, retried.body);
    assert.equal(harness.edge.consumerByUsername(username), undefined);
    assert.equal(await registrationFor(username), null);
    assert.equal(await harness.store.apis.findById(api.id), null);
  });

  it('collects the identity when an administrator deletes another provider’s API', async () => {
    const api = await publish();
    const username = `nexus-test-${api.id}`;
    assert.equal((await createTestConsumer(api.id)).statusCode, 201);

    const removed = await deleteApi(api.id, founder);
    assert.equal(removed.statusCode, 200, removed.body);
    assert.equal(harness.edge.consumerByUsername(username), undefined);
    assert.equal(await registrationFor(username), null);
  });

  it('serialises a deletion against a test-consumer creation for the same API', async () => {
    const api = await publish();
    const username = `nexus-test-${api.id}`;

    // Hold the creation inside the identity's name key — the same key the
    // deletion's teardown takes — and start the deletion while it is parked.
    // Whichever order they settle in, the end state may not be a consumer for
    // an API that no longer exists.
    harness.edge.delay('/consumers', 150, 'POST');
    const creating = createTestConsumer(api.id);
    const removing = deleteApi(api.id);
    const [created, removed] = await Promise.all([creating, removing]);

    assert.ok([201, 404, 409, 502].includes(created.statusCode), created.body);
    assert.ok([200, 409].includes(removed.statusCode), removed.body);

    if (removed.statusCode === 200) {
      assert.equal(await harness.store.apis.findById(api.id), null);
      assert.equal(
        harness.edge.consumerByUsername(username),
        undefined,
        'no consumer outlives the API it names',
      );
      assert.equal(await registrationFor(username), null);
    } else {
      assert.ok(await harness.store.apis.findById(api.id), 'the API is still there to delete');
    }
  });
});
