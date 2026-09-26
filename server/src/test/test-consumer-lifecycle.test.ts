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

import { gatewayIdentityLockKey } from '../credentials/service.js';
import type { NexusStore, TransactionOptions } from '../db/store.js';
import { derivedConsumerId } from '../ferrum-admin/client.js';
import { isoInSeconds, newId, nowIso } from '../lib/ids.js';
import { buildTestApp, SAMPLE_SPEC_YAML, type TestApp, type TestSession } from './helpers.js';

function errorCode(body: string): string {
  return (JSON.parse(body) as ApiErrorBody).error.code;
}

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
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
   * Run `before` inside a deletion of `apiId`, once its test identity is torn
   * down and before the transaction that drops the rows and writes
   * `api.delete` — still under the identity's name key. Outside that
   * transaction on purpose: parked inside it, every other store call would
   * queue behind the open transaction. Returns the restore.
   */
  function beforeRowDelete(apiId: string, before: () => Promise<void>): () => void {
    const credentials = harness.services.credentials;
    const teardown = credentials.teardownGatewayIdentity;
    credentials.teardownGatewayIdentity = (username, subject, options) => {
      const whileHeld = options?.whileHeld;
      if (username !== `nexus-test-${apiId}` || !whileHeld) {
        return teardown.call(credentials, username, subject, options);
      }
      return teardown.call(credentials, username, subject, {
        ...options,
        whileHeld: async (result) => {
          await before();
          await whileHeld(result);
        },
      });
    };
    return () => {
      credentials.teardownGatewayIdentity = teardown;
    };
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

  /* ── #373: a creation and a deletion never interleave ────────────────── */

  it('refuses a creation that read the API before a deletion completed', async () => {
    const api = await publish();
    const username = `nexus-test-${api.id}`;
    const key = gatewayIdentityLockKey(username);

    // The creation has loaded and authorised the API and is about to ask for
    // the identity's name key; the whole deletion runs in that gap. Resumed,
    // the creation holds a snapshot of an API that no longer exists.
    const entered = barrier();
    const resume = barrier();
    const serialize = harness.edgeClient.serializePerKey;
    let parked = false;
    harness.edgeClient.serializePerKey = async (candidate, work) => {
      if (candidate === key && !parked) {
        parked = true;
        entered.release();
        await resume.promise;
      }
      return serialize(candidate, work);
    };
    try {
      const creating = createTestConsumer(api.id);
      await entered.promise;
      const removed = await deleteApi(api.id);
      assert.equal(removed.statusCode, 200, removed.body);
      resume.release();

      const created = await creating;
      assert.equal(created.statusCode, 404, created.body);
      assert.equal(errorCode(created.body), 'NOT_FOUND');
    } finally {
      // Whatever failed above, nothing may stay parked into `harness.close()`.
      entered.release();
      resume.release();
      harness.edgeClient.serializePerKey = serialize;
    }

    assert.equal(await harness.store.apis.findById(api.id), null);
    assert.equal(
      harness.edge.consumerByUsername(username),
      undefined,
      'no consumer outlives the API it names',
    );
    assert.equal(await registrationFor(username), null, 'and no registration either');
    assert.equal(
      (await harness.auditRows('test_consumer.create')).find((row) => row.target_id === api.id),
      undefined,
      'nothing is audited as created',
    );
  });

  it('refuses a creation that queued between the teardown and the row delete', async () => {
    const api = await publish();
    const username = `nexus-test-${api.id}`;
    const key = gatewayIdentityLockKey(username);

    // Park the deletion after its identity teardown, just before it drops the
    // API's rows, and start a creation there. The creation must wait for the
    // rows to go rather than find them still standing and build a consumer
    // that nothing would ever collect.
    const inside = barrier();
    const queued = barrier();
    const resume = barrier();
    let parked = false;
    const restoreTeardown = beforeRowDelete(api.id, async () => {
      if (parked) return;
      parked = true;
      inside.release();
      await resume.promise;
    });
    const serialize = harness.edgeClient.serializePerKey;
    let arrivals = 0;
    harness.edgeClient.serializePerKey = (candidate, work) => {
      if (candidate === key && ++arrivals === 2) queued.release();
      return serialize(candidate, work);
    };
    try {
      const removing = deleteApi(api.id);
      await inside.promise;
      const creating = createTestConsumer(api.id);
      await queued.promise;
      resume.release();

      const [removed, created] = await Promise.all([removing, creating]);
      assert.equal(removed.statusCode, 200, removed.body);
      assert.equal(created.statusCode, 404, created.body);
      assert.equal(errorCode(created.body), 'NOT_FOUND');
    } finally {
      inside.release();
      queued.release();
      resume.release();
      restoreTeardown();
      harness.edgeClient.serializePerKey = serialize;
    }

    assert.equal(await harness.store.apis.findById(api.id), null);
    assert.equal(harness.edge.consumerByUsername(username), undefined);
    assert.equal(await registrationFor(username), null);
    assert.equal(
      (await harness.auditRows('test_consumer.create')).find((row) => row.target_id === api.id),
      undefined,
      'nothing is audited as created',
    );
  });

  it('collects a creation that was still in flight when the deletion began', async () => {
    const api = await publish();
    const username = `nexus-test-${api.id}`;
    const key = gatewayIdentityLockKey(username);

    // The other order: the creation holds the name key with its consumer
    // already on the gateway, and the deletion queues for the key behind it.
    // The creation completes, and the deletion then sweeps what it made.
    const inside = barrier();
    const queued = barrier();
    const resume = barrier();
    const realCreateRow = harness.store.credentials.create;
    const createRow = realCreateRow.bind(harness.store.credentials);
    // Only the test consumer's own row: an unrelated credential write that
    // happened to land meanwhile must not trip the barrier.
    const testConsumerId = derivedConsumerId('nexus', username);
    let parked = false;
    harness.store.credentials.create = async (input) => {
      if (!parked && input.ferrum_consumer_id === testConsumerId) {
        parked = true;
        inside.release();
        await resume.promise;
      }
      return createRow(input);
    };
    const serialize = harness.edgeClient.serializePerKey;
    let arrivals = 0;
    harness.edgeClient.serializePerKey = (candidate, work) => {
      if (candidate === key && ++arrivals === 2) queued.release();
      return serialize(candidate, work);
    };
    let consumerId: string | undefined;
    let credentialId = '';
    try {
      const creating = createTestConsumer(api.id);
      await inside.promise;
      consumerId = harness.edge.consumerByUsername(username)?.id;
      assert.ok(consumerId, 'the in-flight consumer is already on the gateway');
      const removing = deleteApi(api.id);
      await queued.promise;
      resume.release();

      const [created, removed] = await Promise.all([creating, removing]);
      assert.equal(created.statusCode, 201, created.body);
      assert.equal(removed.statusCode, 200, removed.body);
      credentialId = created.json<CreateTestConsumerResponse>().credential.id;
    } finally {
      inside.release();
      queued.release();
      resume.release();
      harness.store.credentials.create = realCreateRow;
      harness.edgeClient.serializePerKey = serialize;
    }

    assert.equal(await harness.store.apis.findById(api.id), null);
    assert.equal(harness.edge.consumerByUsername(username), undefined, 'the consumer was swept');
    assert.equal(await registrationFor(username), null);
    assert.equal((await harness.store.credentials.findById(credentialId))?.status, 'revoked');
    const audited = (await harness.auditRows('api.delete')).find((row) => row.target_id === api.id);
    assert.ok(audited);
    assert.equal(audited.details.test_consumer_id, consumerId);
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

  it('revokes a credential of the old flavour when auth_plugin changes mid-creation', async () => {
    const api = await publish();
    const username = `nexus-test-${api.id}`;
    const testConsumerId = derivedConsumerId('nexus', username);

    // The name key pins the API's existence, not its fields: `update()` writes
    // the row under the proxy lease. Commit an `auth_plugin` swap while the
    // creation is issuing its `keyauth` credential, exactly where a PATCH
    // that had computed its impact a moment earlier would have landed.
    const realCreateRow = harness.store.credentials.create;
    const createRow = realCreateRow.bind(harness.store.credentials);
    let swapped = false;
    harness.store.credentials.create = async (input) => {
      if (!swapped && input.ferrum_consumer_id === testConsumerId) {
        swapped = true;
        await harness.store.apis.update(api.id, { auth_plugin: 'basic_auth' });
      }
      return createRow(input);
    };
    const refused = await createTestConsumer(api.id).finally(() => {
      harness.store.credentials.create = realCreateRow;
    });
    assert.ok(swapped, 'the swap landed mid-issue');
    assert.equal(refused.statusCode, 409, refused.body);
    assert.equal(errorCode(refused.body), 'CONFLICT');

    // The key of the old flavour was never handed out, and nothing of it is
    // left live on either side.
    const rows = await harness.store.credentials.listByConsumer(testConsumerId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.credential_type, 'keyauth');
    assert.equal(rows[0]?.status, 'revoked', 'the issued credential was revoked');
    const revokedAudit = (await harness.auditRows('credential.revoke')).find(
      (row) => row.target_id === rows[0]?.id,
    );
    assert.ok(revokedAudit, 'and its revocation is audited');
    assert.equal(revokedAudit.details.reason, 'auth_plugin_change');
    assert.equal(harness.edge.consumerByUsername(username), undefined, 'the consumer is gone');
    assert.equal(await registrationFor(username), null, 'and so is its registration');
    assert.equal(
      (await harness.auditRows('test_consumer.create')).find((row) => row.target_id === api.id),
      undefined,
      'nothing is audited as created',
    );

    // A retry issues against the flavour the API has now.
    const retried = await createTestConsumer(api.id);
    assert.equal(retried.statusCode, 201, retried.body);
    assert.equal(
      retried.json<CreateTestConsumerResponse>().credential.credential_type,
      'basicauth',
    );
  });

  it('records the collected test consumer on a retry after the row delete failed', async () => {
    const api = await publish();
    const username = `nexus-test-${api.id}`;

    const created = await createTestConsumer(api.id);
    assert.equal(created.statusCode, 201, created.body);
    const credentialId = created.json<CreateTestConsumerResponse>().credential.id;
    const consumerId = harness.edge.consumerByUsername(username)?.id;
    assert.ok(consumerId);

    // The teardown succeeds; the row-delete transaction that follows it under
    // the name key fails once. Armed only once the teardown is done, so no
    // earlier transaction — `api.delete_start`'s — can take the failure instead.
    const realTransaction = harness.store.transaction;
    const transaction = realTransaction.bind(harness.store);
    let armed = false;
    let failed = false;
    const restoreTeardown = beforeRowDelete(api.id, async () => {
      if (!failed) armed = true;
    });
    harness.store.transaction = async <T>(
      fn: (tx: NexusStore) => Promise<T>,
      options?: TransactionOptions,
    ): Promise<T> => {
      if (armed && !failed) {
        armed = false;
        failed = true;
        throw new Error('database is gone');
      }
      return transaction(fn, options);
    };
    const refused = await deleteApi(api.id).finally(() => {
      restoreTeardown();
      harness.store.transaction = realTransaction;
    });
    assert.ok(failed, 'the row delete was the transaction that failed');
    assert.ok(refused.statusCode >= 500, refused.body);
    assert.ok(await harness.store.apis.findById(api.id), 'the API survives for the retry');
    assert.equal(harness.edge.consumerByUsername(username), undefined, 'the teardown held');
    assert.equal(
      (await registrationFor(username))?.ferrum_consumer_id,
      consumerId,
      'the registration is kept, still naming the collected consumer',
    );
    assert.equal(
      (await harness.auditRows('api.delete')).find((row) => row.target_id === api.id),
      undefined,
      'and nothing is audited as a completed delete',
    );

    const retried = await deleteApi(api.id);
    assert.equal(retried.statusCode, 200, retried.body);
    assert.equal(await harness.store.apis.findById(api.id), null);
    assert.equal(harness.edge.consumerByUsername(username), undefined);
    assert.equal(await registrationFor(username), null, 'nothing is left behind');
    assert.equal((await harness.store.credentials.findById(credentialId))?.status, 'revoked');
    const audited = (await harness.auditRows('api.delete')).filter(
      (row) => row.target_id === api.id,
    );
    assert.equal(audited.length, 1);
    assert.equal(
      audited[0]?.details.test_consumer_id,
      consumerId,
      'the retry still records the test consumer as collected',
    );
  });

  it('does not drop the rows once its leases changed hands mid-deletion (issue #384)', async () => {
    const api = await publish();
    const username = `nexus-test-${api.id}`;
    const key = gatewayIdentityLockKey(username);

    const created = await createTestConsumer(api.id);
    assert.equal(created.statusCode, 201, created.body);
    const consumerId = harness.edge.consumerByUsername(username)?.id;
    assert.ok(consumerId);

    // The deletion stalls after its teardown, just before the row delete, for
    // longer than the lease TTL: every lease it holds lapses and is swept, and
    // another instance takes the identity's name key — and with it the right
    // to build a consumer for an API whose row it still sees. Resumed, the
    // deletion must not commit the row delete behind that instance's back.
    let stalled = false;
    const restoreTeardown = beforeRowDelete(api.id, async () => {
      if (stalled) return;
      stalled = true;
      await harness.store.leases.deleteExpired('9999-01-01T00:00:00.000Z');
      assert.equal(
        await harness.store.leases.acquire(key, 'other-instance', isoInSeconds(600), nowIso()),
        true,
      );
    });
    const refused = await deleteApi(api.id).finally(restoreTeardown);
    assert.ok(stalled, 'the deletion reached the row delete');
    assert.equal(
      await harness.store.leases.release(key, 'other-instance'),
      true,
      "the stale deletion left the new holder's lease alone",
    );

    assert.equal(refused.statusCode, 409, refused.body);
    assert.equal(errorCode(refused.body), 'CONFLICT');
    assert.ok(await harness.store.apis.findById(api.id), 'the stale row delete rolled back');
    assert.equal(
      (await harness.auditRows('api.delete')).find((row) => row.target_id === api.id),
      undefined,
      'nothing is audited as a completed delete',
    );
    assert.equal(
      (await registrationFor(username))?.ferrum_consumer_id,
      consumerId,
      'the registration is kept, still naming the collected consumer',
    );

    // Holding the keys again, the retry completes and records what the stale
    // attempt collected.
    const retried = await deleteApi(api.id);
    assert.equal(retried.statusCode, 200, retried.body);
    assert.equal(await harness.store.apis.findById(api.id), null);
    assert.equal(harness.edge.consumerByUsername(username), undefined);
    assert.equal(await registrationFor(username), null, 'nothing is left behind');
    const audited = (await harness.auditRows('api.delete')).filter(
      (row) => row.target_id === api.id,
    );
    assert.equal(audited.length, 1);
    assert.equal(audited[0]?.details.test_consumer_id, consumerId);
  });

  it('keeps a newer claim when a stale replacement abandons (issue #384)', async () => {
    const api = await publish();
    const username = `nexus-test-${api.id}`;
    const key = gatewayIdentityLockKey(username);
    assert.equal((await createTestConsumer(api.id)).statusCode, 201);

    // The replacement stalls just before it records the id it is about to
    // create under, for longer than the lease TTL: its lease is swept, and the
    // same account's replacement on another instance takes the name key,
    // claims the registration and binds its own consumer. Resumed, the stale
    // bind is refused — and the compensation that refusal leads into must not
    // remove the registration the newer attempt now depends on.
    const credentials = harness.services.credentials;
    const bind = credentials.bindGatewayIdentity;
    const newer = newId();
    let stalled = false;
    credentials.bindGatewayIdentity = async (identity, consumerId) => {
      if (!stalled) {
        stalled = true;
        await harness.store.leases.deleteExpired('9999-01-01T00:00:00.000Z');
        assert.equal(
          await harness.store.leases.acquire(key, 'other-instance', isoInSeconds(600), nowIso()),
          true,
        );
        const claimed = await harness.store.gatewayIdentities.claim({
          user_id: provider.user.id,
          namespace: 'nexus',
          ferrum_username: username,
          ferrum_consumer_id: null,
        });
        await harness.store.gatewayIdentities.bindConsumer(claimed.id, newer);
      }
      return bind.call(credentials, identity, consumerId);
    };
    const refused = await createTestConsumer(api.id).finally(() => {
      credentials.bindGatewayIdentity = bind;
    });
    assert.ok(stalled, 'the replacement reached its bind');
    assert.equal(
      await harness.store.leases.release(key, 'other-instance'),
      true,
      "the stale replacement left the new holder's lease alone",
    );

    assert.equal(refused.statusCode, 409, refused.body);
    assert.equal(errorCode(refused.body), 'CONFLICT');
    const kept = await registrationFor(username);
    assert.equal(kept?.user_id, provider.user.id);
    assert.equal(
      kept?.ferrum_consumer_id,
      newer,
      "the newer attempt's registration survives the stale compensation",
    );

    const removed = await deleteApi(api.id);
    assert.equal(removed.statusCode, 200, removed.body);
    assert.equal(await registrationFor(username), null);
  });

  it('does not report a refused registration removal as done (issue #384)', async () => {
    const api = await publish();
    const username = `nexus-test-${api.id}`;
    const key = gatewayIdentityLockKey(username);
    assert.equal((await createTestConsumer(api.id)).statusCode, 201);
    const consumerId = harness.edge.consumerByUsername(username)?.id;
    assert.ok(consumerId);

    // The follow-up commits, then the teardown stalls past the TTL before it
    // consumes the registration, and another instance takes the name key: the
    // removal is refused and only logged, since the follow-up is durable.
    const result = await harness.services.credentials.teardownGatewayIdentity(
      username,
      provider.user.id,
      {
        whileHeld: async () => {
          await harness.store.leases.deleteExpired('9999-01-01T00:00:00.000Z');
          assert.equal(
            await harness.store.leases.acquire(key, 'other-instance', isoInSeconds(600), nowIso()),
            true,
          );
        },
      },
    );
    assert.equal(await harness.store.leases.release(key, 'other-instance'), true);

    assert.equal(result.consumer_id, consumerId);
    assert.equal(result.registration_removed, false, 'a kept registration is not reported removed');
    assert.equal((await registrationFor(username))?.ferrum_consumer_id, consumerId);

    // The API deletion still finds it, and consumes it.
    const removed = await deleteApi(api.id);
    assert.equal(removed.statusCode, 200, removed.body);
    assert.equal(await registrationFor(username), null);
  });

  it('answers 404 to a deletion that finds the row already removed', async () => {
    const api = await publish();

    // Park the deletion just before its row-delete transaction and remove the
    // row underneath it, as a concurrent deletion that won would have. Only
    // the winner may answer `200` and write `api.delete`.
    const inside = barrier();
    const resume = barrier();
    let parked = false;
    const restoreTeardown = beforeRowDelete(api.id, async () => {
      if (parked) return;
      parked = true;
      inside.release();
      await resume.promise;
    });
    try {
      const removing = deleteApi(api.id);
      await inside.promise;
      await harness.store.transaction(async (tx) => {
        await tx.grants.deleteByApi(api.id);
        await tx.accessRequests.deleteByApi(api.id);
        await tx.apiPlugins.deleteByApi(api.id);
        await tx.apiViewers.deleteByApi(api.id);
        await tx.apiSpecs.deleteByApi(api.id);
        assert.equal(await tx.apis.delete(api.id), true);
      });
      resume.release();

      const removed = await removing;
      assert.equal(removed.statusCode, 404, removed.body);
      assert.equal(errorCode(removed.body), 'NOT_FOUND');
    } finally {
      inside.release();
      resume.release();
      restoreTeardown();
    }

    assert.equal(
      (await harness.auditRows('api.delete')).find((row) => row.target_id === api.id),
      undefined,
      'the losing deletion writes no audit row',
    );
  });
});
