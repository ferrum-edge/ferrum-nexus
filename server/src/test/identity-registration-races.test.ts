/**
 * The first issuance of a gateway identity versus the disable of its owner.
 *
 * Issue #78, the residue of #57/#58: the account teardown discovered a
 * provider's test consumer through its live credential rows, and a test
 * consumer being created for the first time has none until its first append
 * has landed. A disable that ran after the issuance's owner check but before
 * that append reported `no_consumer`, closed its job, and the append then
 * handed the disabled provider a working key carrying the API's approval
 * group.
 *
 * Every test here holds the issuance at one of its two gateway writes — the
 * consumer create, or the credential append — runs a disable to completion of
 * its portal half, and only then lets the issuance go. The barrier is the Edge
 * *client* method, wrapped for one call, so the service under test runs
 * exactly as it does in production and the interleaving is exact rather than
 * timed. What is asserted is the property the issue names: when the disable
 * reports completion, nothing of the account is live on the gateway.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  aclGroupForApi,
  consumerUsernameForUser,
  type ApiErrorBody,
  type CreateTestConsumerResponse,
  type IssueCredentialResponse,
  type PublishApiResponse,
} from '@ferrum-nexus/shared';

import { buildTestApp, SAMPLE_SPEC_YAML, type TestApp, type TestSession } from './helpers.js';

function errorCode(body: string): string {
  return (JSON.parse(body) as ApiErrorBody).error.code;
}

/** A barrier the test opens by hand. */
interface Gate {
  /** Resolves once the guarded call has been entered and parked. */
  arrived: Promise<void>;
  /** Let it continue. The real implementation is restored on arrival. */
  release: () => void;
}

type EdgeCall = (...args: unknown[]) => Promise<unknown>;

/** The two disable paths, which must behave identically. */
type DisableMode = 'patch' | 'god';

const MODES: readonly DisableMode[] = ['patch', 'god'];

describe('first gateway identity versus disable', () => {
  let harness: TestApp;
  /** The first registered account, therefore `super_admin`. */
  let founder: TestSession;
  let counter = 0;

  before(async () => {
    harness = await buildTestApp();
    founder = await harness.registerUser({ email: 'identity-founder@example.test' });
  });

  after(async () => {
    await harness.close();
  });

  /* ── helpers ──────────────────────────────────────────────────────────── */

  async function freshProvider(): Promise<TestSession> {
    counter += 1;
    return harness.registerUser({
      email: `identity-provider${counter}@example.test`,
      role: 'provider',
    });
  }

  async function publish(owner: TestSession, slug: string): Promise<{ id: string }> {
    const response = await harness.authed(owner, {
      method: 'POST',
      url: '/api/apis',
      payload: {
        name: `API ${slug}`,
        slug,
        spec: SAMPLE_SPEC_YAML,
        auth_plugin: 'key_auth',
        requestable: true,
        visibility: 'public',
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<PublishApiResponse>().api;
  }

  /**
   * Park the **next** call of one Edge client method at the moment the service
   * has decided to make it — after every check that precedes it, before the
   * gateway has seen it. The wrapper restores itself as it is entered, so only
   * that one call is held.
   */
  function holdNext(method: 'create' | 'addCredential'): Gate {
    const consumers = harness.edgeClient.consumers as unknown as Record<string, EdgeCall>;
    const real = consumers[method];
    if (!real) throw new Error(`no Edge client method ${method}`);
    const bound: EdgeCall = (...args) => real.apply(harness.edgeClient.consumers, args);
    let arrivedOpen: () => void = () => undefined;
    let proceedOpen: () => void = () => undefined;
    const arrived = new Promise<void>((resolve) => {
      arrivedOpen = resolve;
    });
    const proceed = new Promise<void>((resolve) => {
      proceedOpen = resolve;
    });
    consumers[method] = async (...args) => {
      consumers[method] = bound;
      arrivedOpen();
      await proceed;
      return bound(...args);
    };
    return { arrived, release: proceedOpen };
  }

  function createTestConsumer(actor: TestSession, apiId: string) {
    return harness.authed(actor, {
      method: 'POST',
      url: `/api/apis/${apiId}/test-consumer`,
      payload: {},
    });
  }

  async function disable(
    mode: DisableMode,
    target: TestSession,
  ): Promise<{ status: number; teardown: string | undefined; body: string }> {
    const response =
      mode === 'patch'
        ? await harness.authed(founder, {
            method: 'PATCH',
            url: `/api/users/${target.user.id}`,
            payload: { status: 'disabled' },
          })
        : await harness.authed(founder, {
            method: 'POST',
            url: '/api/admin/god/disable-user',
            payload: { user_id: target.user.id, reason: 'Racing the first test-consumer append.' },
          });
    return {
      status: response.statusCode,
      teardown: response.json<{ gateway_teardown?: string }>().gateway_teardown,
      body: response.body,
    };
  }

  /** Block until the disable's portal half has committed. */
  async function untilDisabled(userId: string): Promise<void> {
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      if ((await harness.store.users.findById(userId))?.status === 'disabled') return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('the disable never committed');
  }

  async function registrations(userId: string): Promise<number> {
    return (await harness.store.gatewayIdentities.listByUser(userId, 'nexus')).length;
  }

  /** The property every test ends on: nothing of the account is live anywhere. */
  async function assertNothingLive(provider: TestSession, apiId: string): Promise<void> {
    const username = `nexus-test-${apiId}`;
    assert.equal(
      harness.edge.consumerByUsername(username),
      undefined,
      'the test consumer is gone from the gateway',
    );
    const canonical = harness.edge.consumerByUsername(consumerUsernameForUser(provider.user.id));
    if (canonical) {
      assert.deepEqual(canonical.acl_groups, [], 'the canonical consumer holds no group');
      assert.deepEqual(canonical.credentials, {}, 'the canonical consumer holds no credential');
    }
    const group = aclGroupForApi(apiId);
    for (const consumer of harness.edge.consumers.values()) {
      assert.ok(
        !consumer.acl_groups.includes(group),
        `no consumer carries the approval group (${consumer.username} does)`,
      );
    }
    const rows = await harness.store.credentials.list({ user_id: provider.user.id }, { limit: 50 });
    for (const row of rows.items) {
      assert.equal(row.status, 'revoked', `credential ${row.id} is revoked in the mirror`);
    }
    assert.equal(await registrations(provider.user.id), 0, 'no registration is left behind');
    assert.equal(
      (await harness.store.gatewayTeardownJobs.findByUser(provider.user.id))?.status,
      'done',
    );
  }

  /* ── The append wins the identity's key; the teardown follows it ──────── */

  for (const mode of MODES) {
    it(`${mode}: an append in flight at the disable is torn down behind it`, async () => {
      const provider = await freshProvider();
      const api = await publish(provider, `identity-append-${mode}`);

      // Held after the owner check inside the consumer's critical section:
      // the exact window the issue reproduces.
      const gate = holdNext('addCredential');
      const creating = createTestConsumer(provider, api.id);
      await gate.arrived;
      assert.equal(
        await registrations(provider.user.id),
        1,
        'the identity is registered before anything is appended',
      );

      const disabling = disable(mode, provider);
      await untilDisabled(provider.user.id);
      gate.release();

      const [created, disabled] = await Promise.all([creating, disabling]);
      assert.equal(created.statusCode, 201, created.body);
      assert.equal(disabled.status, 200, disabled.body);
      assert.equal(
        disabled.teardown,
        'ok',
        'the teardown found the identity and waited for the append',
      );
      await assertNothingLive(provider, api.id);

      // The key the provider was handed is the one the teardown deleted.
      const issued = created.json<CreateTestConsumerResponse>();
      const row = await harness.store.credentials.findById(issued.credential.id);
      assert.equal(row?.status, 'revoked');
    });
  }

  /* ── The disable wins; the append is refused and compensated ─────────── */

  for (const mode of MODES) {
    it(`${mode}: a refused append takes the consumer it created down with it`, async () => {
      const provider = await freshProvider();
      const api = await publish(provider, `identity-refused-${mode}`);

      // Held at the consumer create — registered, nothing on the gateway yet.
      const gate = holdNext('create');
      const creating = createTestConsumer(provider, api.id);
      await gate.arrived;
      assert.equal(await registrations(provider.user.id), 1);

      const disabling = disable(mode, provider);
      await untilDisabled(provider.user.id);
      gate.release();

      const [created, disabled] = await Promise.all([creating, disabling]);
      assert.equal(created.statusCode, 403, created.body);
      assert.equal(errorCode(created.body), 'USER_DISABLED');
      assert.equal(disabled.status, 200, disabled.body);
      assert.equal(
        disabled.teardown,
        'no_consumer',
        'the compensation had already removed what the issuance created',
      );
      await assertNothingLive(provider, api.id);
      assert.ok(
        harness.edge.callsTo('DELETE', '/consumers/').length >= 1,
        'the consumer the issuance created was deleted again',
      );
    });
  }

  it('a disable that lands before the registration refuses the issuance outright', async () => {
    const provider = await freshProvider();
    const api = await publish(provider, 'identity-before');

    const disabled = await disable('patch', provider);
    assert.equal(disabled.teardown, 'no_consumer');

    // The request-time copy of the account, as an in-flight request carries it.
    const stale = await harness.store.users.findById(provider.user.id);
    assert.ok(stale);
    await assert.rejects(
      () => harness.services.publishing.createTestConsumer(stale, api.id),
      (error: Error) => /disabled/i.test(error.message),
    );
    assert.equal(await registrations(provider.user.id), 0, 'nothing was registered');
    assert.equal(harness.edge.consumerByUsername(`nexus-test-${api.id}`), undefined);
  });

  /* ── With an existing canonical consumer ─────────────────────────────── */

  it('strips the canonical consumer and the in-flight test consumer together', async () => {
    const provider = await freshProvider();
    const api = await publish(provider, 'identity-canonical');
    const personal = await harness.authed(provider, {
      method: 'POST',
      url: '/api/credentials',
      payload: { credential_type: 'keyauth', label: 'personal' },
    });
    assert.equal(personal.statusCode, 201, personal.body);
    const personalId = personal.json<IssueCredentialResponse>().credential.id;
    const canonical = harness.edge.consumerByUsername(consumerUsernameForUser(provider.user.id));
    assert.ok(canonical);
    canonical.acl_groups = ['nexus:api:some-other-api:approved'];

    const gate = holdNext('addCredential');
    const creating = createTestConsumer(provider, api.id);
    await gate.arrived;
    const disabling = disable('patch', provider);
    await untilDisabled(provider.user.id);
    gate.release();

    const [created, disabled] = await Promise.all([creating, disabling]);
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(disabled.teardown, 'ok');
    await assertNothingLive(provider, api.id);
    assert.equal((await harness.store.credentials.findById(personalId))?.status, 'revoked');

    const audited = (await harness.auditRows('user.disable')).find(
      (row) => row.target_id === provider.user.id,
    );
    assert.equal(audited?.details.revoked_credentials, 2, 'both identities were revoked');
    assert.equal(audited?.details.gateway_consumer_id, canonical.id);
    assert.equal((audited?.details.deleted_consumers as string[]).length, 1);
  });

  /* ── Retries ─────────────────────────────────────────────────────────── */

  it('a gateway failure on the in-flight identity leaves it for the worker', async () => {
    const provider = await freshProvider();
    const api = await publish(provider, 'identity-retry');

    const gate = holdNext('addCredential');
    const creating = createTestConsumer(provider, api.id);
    await gate.arrived;
    // The teardown's delete of the test consumer is the only DELETE in play.
    harness.edge.queueFailure(503, { error: 'down' }, '/consumers/', 'DELETE');
    const disabling = disable('patch', provider);
    await untilDisabled(provider.user.id);
    gate.release();

    const [created, disabled] = await Promise.all([creating, disabling]);
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(disabled.teardown, 'pending', 'the failed identity leaves the job pending');

    // Exactly the exposure the retry exists for: the key is live, and so is
    // the registration that will find it again.
    const username = `nexus-test-${api.id}`;
    assert.equal(harness.edge.consumerByUsername(username)?.credentials.keyauth?.length, 1);
    assert.equal(await registrations(provider.user.id), 1, 'the registration is kept');
    assert.equal(
      (await harness.store.gatewayTeardownJobs.findByUser(provider.user.id))?.status,
      'pending',
    );

    const tick = await harness.services.teardown.tick();
    assert.ok(tick.completed >= 1, JSON.stringify(tick));
    await assertNothingLive(provider, api.id);
  });

  it('a gateway failure during the compensation leaves the identity for the worker', async () => {
    const provider = await freshProvider();
    const api = await publish(provider, 'identity-compensation');

    const gate = holdNext('create');
    const creating = createTestConsumer(provider, api.id);
    await gate.arrived;
    // One failure for the compensating delete, one for the inline teardown's.
    harness.edge.queueFailure(503, { error: 'down' }, '/consumers/', 'DELETE');
    harness.edge.queueFailure(503, { error: 'still down' }, '/consumers/', 'DELETE');
    const disabling = disable('god', provider);
    await untilDisabled(provider.user.id);
    gate.release();

    const [created, disabled] = await Promise.all([creating, disabling]);
    assert.equal(created.statusCode, 403, created.body);
    assert.equal(errorCode(created.body), 'USER_DISABLED');
    assert.equal(disabled.teardown, 'pending');

    // The consumer the issuance created is still up, carrying the group and
    // no credential; the registration is what will bring it down.
    const username = `nexus-test-${api.id}`;
    const orphan = harness.edge.consumerByUsername(username);
    assert.ok(orphan, 'the compensation could not delete the consumer');
    assert.deepEqual(orphan.acl_groups, [aclGroupForApi(api.id)]);
    assert.equal(orphan.credentials.keyauth?.length ?? 0, 0);
    assert.equal(await registrations(provider.user.id), 1);

    const tick = await harness.services.teardown.tick();
    assert.ok(tick.completed >= 1, JSON.stringify(tick));
    await assertNothingLive(provider, api.id);
  });

  it('a failed compensation reopens a teardown job that had already closed', async () => {
    const provider = await freshProvider();
    const api = await publish(provider, 'identity-reopen');
    const username = `nexus-test-${api.id}`;

    // The state another instance can leave: a registration whose consumer is
    // up, an owner whose disable finished (finding nothing else) before the
    // compensation ran, and a compensation the gateway refuses.
    const identity = await harness.services.credentials.claimGatewayIdentity(
      provider.user.id,
      username,
    );
    const seeded = harness.edge.seedConsumer({ username, acl_groups: [aclGroupForApi(api.id)] });
    await harness.services.credentials.bindGatewayIdentity(identity, seeded.id);
    await harness.store.users.update(provider.user.id, { status: 'disabled' });
    const job = await harness.store.gatewayTeardownJobs.upsertPending(
      provider.user.id,
      founder.user.id,
      new Date().toISOString(),
    );
    await harness.store.gatewayTeardownJobs.markDone(job.id, new Date().toISOString());

    harness.edge.queueFailure(503, { error: 'down' }, `/consumers/${seeded.id}`, 'DELETE');
    await harness.services.credentials.abandonGatewayIdentity(identity, seeded.id, founder.user.id);

    assert.ok(harness.edge.consumerByUsername(username), 'the consumer is still up');
    assert.equal(await registrations(provider.user.id), 1, 'the registration is kept');
    assert.equal(
      (await harness.store.gatewayTeardownJobs.findByUser(provider.user.id))?.status,
      'pending',
      'the closed job is owed again',
    );

    const tick = await harness.services.teardown.tick();
    assert.ok(tick.completed >= 1, JSON.stringify(tick));
    await assertNothingLive(provider, api.id);
  });

  /* ── Re-enable ───────────────────────────────────────────────────────── */

  it('a stale teardown cannot strip a test consumer recreated after a re-enable', async () => {
    const provider = await freshProvider();
    const api = await publish(provider, 'identity-reenable');
    const username = `nexus-test-${api.id}`;

    const first = await createTestConsumer(provider, api.id);
    assert.equal(first.statusCode, 201, first.body);

    // The disable's inline attempt fails on the test consumer, so the job stays
    // pending and the registration stays with it.
    harness.edge.queueFailure(503, { error: 'down' }, '/consumers/', 'DELETE');
    const disabled = await disable('patch', provider);
    assert.equal(disabled.teardown, 'pending');
    assert.equal(await registrations(provider.user.id), 1);

    const reenabled = await harness.authed(founder, {
      method: 'PATCH',
      url: `/api/users/${provider.user.id}`,
      payload: { status: 'active' },
    });
    assert.equal(reenabled.statusCode, 200, reenabled.body);
    assert.equal(await harness.store.gatewayTeardownJobs.findByUser(provider.user.id), null);

    // Back in business: a fresh test consumer, registered to the same account.
    const back = await harness.loginUser(`identity-provider${counter}@example.test`);
    const second = await createTestConsumer(back, api.id);
    assert.equal(second.statusCode, 201, second.body);
    const credentialId = second.json<CreateTestConsumerResponse>().credential.id;
    const recreated = harness.edge.consumerByUsername(username);
    assert.ok(recreated);
    assert.equal(recreated.credentials.keyauth?.length, 1);

    // A worker that claimed the job before the re-enable and only now runs it.
    await assert.rejects(
      () => harness.services.credentials.disableGatewayAccess(provider.user.id, founder.user.id),
      (error: Error) => /no longer disabled/i.test(error.message),
    );
    assert.equal(harness.edge.consumerByUsername(username)?.id, recreated.id);
    assert.equal(harness.edge.consumerByUsername(username)?.credentials.keyauth?.length, 1);
    assert.deepEqual(harness.edge.consumerByUsername(username)?.acl_groups, [
      aclGroupForApi(api.id),
    ]);
    assert.equal((await harness.store.credentials.findById(credentialId))?.status, 'active');
    assert.equal(await registrations(provider.user.id), 1, 'the registration is untouched');

    const tick = await harness.services.teardown.tick();
    assert.equal(tick.claimed, 0, 'nothing is queued against a live account');
  });
});
