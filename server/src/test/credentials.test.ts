import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  consumerUsernameForUser,
  type ApiErrorBody,
  type IssueCredentialResponse,
  type ListCredentialsResponse,
  type ListNotificationsResponse,
  type RotateCredentialResponse,
} from '@ferrum-nexus/shared';

import { sha256Hex } from '../lib/crypto.js';
import { buildTestApp, type TestApp, type TestSession } from './helpers.js';

function errorCode(body: string): string {
  return (JSON.parse(body) as ApiErrorBody).error.code;
}

/**
 * Hold the first `count` `credentials.findById` calls until every one of them
 * has arrived, then release them together and restore the real method.
 *
 * This is what makes a rotate/rotate race a real interleaving rather than two
 * sequential calls: both requests resolve the target *before* either enters the
 * per-consumer queue, which is precisely the window in which the second one
 * used to carry on with a credential the first had already retired.
 */
function barrierOnCredentialLoad(harness: TestApp, count: number): void {
  const real = harness.store.credentials.findById.bind(harness.store.credentials);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrived = 0;

  harness.store.credentials.findById = async (id) => {
    arrived += 1;
    if (arrived >= count) {
      harness.store.credentials.findById = real;
      release();
    } else {
      await gate;
    }
    return real(id);
  };
}

describe('gateway credentials', () => {
  let harness: TestApp;
  let founder: TestSession;
  let alice: TestSession;
  let bob: TestSession;

  async function issue(
    actor: TestSession,
    credentialType: string,
    label?: string,
  ): Promise<IssueCredentialResponse> {
    const response = await harness.authed(actor, {
      method: 'POST',
      url: '/api/credentials',
      payload: { credential_type: credentialType, ...(label ? { label } : {}) },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<IssueCredentialResponse>();
  }

  /** The mock's unredacted view of a user's consumer. */
  function consumerOf(userId: string) {
    return harness.edge.consumerByUsername(consumerUsernameForUser(userId));
  }

  before(async () => {
    harness = await buildTestApp();
    founder = await harness.registerUser({ email: 'cred-founder@example.test' });
    alice = await harness.registerUser({ email: 'cred-alice@example.test', role: 'client' });
    bob = await harness.registerUser({ email: 'cred-bob@example.test', role: 'client' });
  });

  after(async () => {
    await harness.close();
  });

  it('issues an API key, storing only a fingerprint and last4', async () => {
    const body = await issue(alice, 'keyauth', 'CI pipeline');

    assert.equal(body.secret.type, 'keyauth');
    assert.ok(body.secret.key);
    assert.equal(body.secret.username, undefined);
    assert.equal(body.consumer_username, consumerUsernameForUser(alice.user.id));

    assert.equal(body.credential.credential_type, 'keyauth');
    assert.equal(body.credential.status, 'active');
    assert.equal(body.credential.label, 'CI pipeline');
    assert.equal(body.credential.last4, body.secret.key.slice(-4));
    // The stored fingerprint is a plain SHA-256 of the material, and the
    // material itself appears nowhere in the row.
    assert.equal(body.credential.fingerprint, sha256Hex(body.secret.key));
    assert.ok(!JSON.stringify(body.credential).includes(body.secret.key));

    const consumer = consumerOf(alice.user.id);
    assert.equal(consumer?.custom_id, alice.user.id);
    assert.equal(consumer?.credentials.keyauth?.length, 1);
    assert.equal(consumer?.credentials.keyauth?.[0]?.key, body.secret.key);

    const row = (await harness.auditRows('credential.issue')).find(
      (entry) => entry.target_id === body.credential.id,
    );
    assert.equal(row?.details.credential_type, 'keyauth');
    assert.ok(!JSON.stringify(row?.details).includes(body.secret.key));
  });

  it('issues basic-auth keyed on the consumer username, since Edge has no other', async () => {
    const body = await issue(bob, 'basicauth');
    assert.equal(body.secret.type, 'basicauth');
    // Edge's `basicauth` entry accepts exactly one of `password` /
    // `password_hash`; the lookup key is the consumer's own username.
    assert.equal(body.secret.username, consumerUsernameForUser(bob.user.id));
    assert.ok(body.secret.password);
    assert.equal(body.secret.key, undefined);
    assert.equal(body.credential.fingerprint, sha256Hex(body.secret.password));

    const entries = consumerOf(bob.user.id)?.credentials.basicauth;
    assert.equal(entries?.length, 1);
    assert.deepEqual(Object.keys(entries?.[0] ?? {}), ['password']);
  });

  it('issues a JWT secret plus the consumer id the client must put in `sub`', async () => {
    const body = await issue(bob, 'jwt');
    assert.equal(body.secret.type, 'jwt');
    assert.ok(body.secret.jwt_secret);
    assert.ok(
      (body.secret.jwt_secret?.length ?? 0) >= 32,
      'Edge requires a jwt secret of at least 32 characters',
    );
    assert.equal(body.secret.jwt_key, consumerUsernameForUser(bob.user.id));

    const entries = consumerOf(bob.user.id)?.credentials.jwt;
    assert.equal(entries?.length, 1);
    // Only `secret` — Edge rejects an entry carrying anything else.
    assert.deepEqual(Object.keys(entries?.[0] ?? {}), ['secret']);
  });

  it('enforces the per-type cap before it ever calls the gateway', async () => {
    // The default cap is 2; alice already has one keyauth entry.
    await issue(alice, 'keyauth');
    const callsBefore = harness.edge.callsTo('POST', '/credentials/keyauth').length;

    const response = await harness.authed(alice, {
      method: 'POST',
      url: '/api/credentials',
      payload: { credential_type: 'keyauth' },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(errorCode(response.body), 'CONFLICT');
    assert.match(JSON.parse(response.body).error.message, /revoke or rotate/);
    assert.equal(
      harness.edge.callsTo('POST', '/credentials/keyauth').length,
      callsBefore,
      'the cap is checked before the Edge append, not after a 400',
    );

    // A different type is unaffected — the cap is per type.
    const other = await harness.authed(alice, {
      method: 'POST',
      url: '/api/credentials',
      payload: { credential_type: 'jwt' },
    });
    assert.equal(other.statusCode, 201);
  });

  it('rotates append-then-delete, leaving exactly the new secret live', async () => {
    const rotator = await harness.registerUser({
      email: 'cred-rotate@example.test',
      role: 'client',
    });
    const original = await issue(rotator, 'keyauth', 'Production');

    const response = await harness.authed(rotator, {
      method: 'POST',
      url: `/api/credentials/${original.credential.id}/rotate`,
      payload: {},
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json<RotateCredentialResponse>();

    assert.notEqual(body.secret.key, original.secret.key);
    assert.equal(body.credential.rotated_from_id, original.credential.id);
    assert.equal(body.credential.status, 'active');
    assert.equal(body.credential.label, 'Production', 'the label carries over by default');
    assert.equal(body.previous.status, 'revoked');
    assert.equal(body.previous.id, original.credential.id);

    // On the gateway: exactly one entry, and it is the new one.
    const entries = consumerOf(rotator.user.id)?.credentials.keyauth;
    assert.equal(entries?.length, 1);
    assert.equal(entries?.[0]?.key, body.secret.key);

    // The old entry was deleted by index, after the append.
    const deletes = harness.edge.callsTo('DELETE', '/credentials/keyauth/');
    assert.equal(deletes.length, 1);
    assert.ok(deletes[0]?.path.endsWith('/0'), 'the oldest entry is index 0');

    const bell = await harness.authed(rotator, {
      method: 'GET',
      url: '/api/notifications?type=credential_rotated',
    });
    assert.equal(bell.json<ListNotificationsResponse>().total, 1);

    const mail = (await harness.outbox()).filter(
      (row) => row.to_email === 'cred-rotate@example.test' && row.subject.includes('rotated'),
    );
    assert.equal(mail.length, 1);
    assert.ok(!mail[0]?.body_text.includes(body.secret.key ?? 'x'), 'no plaintext in email');

    const row = (await harness.auditRows('credential.rotate')).find(
      (entry) => entry.target_id === body.credential.id,
    );
    assert.equal(row?.details.rotated_from, original.credential.id);
  });

  it('rotates the correct entry when the consumer holds two of the type', async () => {
    const holder = await harness.registerUser({ email: 'cred-two@example.test', role: 'client' });
    const first = await issue(holder, 'keyauth', 'first');
    const second = await issue(holder, 'keyauth', 'second');

    // Rotating the *newer* one must delete index 1, not index 0.
    const response = await harness.authed(holder, {
      method: 'POST',
      url: `/api/credentials/${second.credential.id}/rotate`,
      payload: {},
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json<RotateCredentialResponse>();

    const keys = (consumerOf(holder.user.id)?.credentials.keyauth ?? []).map((entry) => entry.key);
    assert.equal(keys.length, 2);
    assert.ok(keys.includes(first.secret.key), 'the untouched credential survived');
    assert.ok(keys.includes(body.secret.key), 'the replacement is live');
    assert.ok(!keys.includes(second.secret.key), 'the rotated credential is gone');
  });

  it('refuses to rotate when the gateway array has drifted from the portal', async () => {
    const drifted = await harness.registerUser({
      email: 'cred-drift@example.test',
      role: 'client',
    });
    const original = await issue(drifted, 'keyauth', 'Production');

    // An operator emptied the type by hand: one live Nexus row, zero live
    // entries. The index no longer resolves, and the whole-type fallback would
    // delete the entry the rotation had just appended — handing back a
    // show-once secret that authenticates nothing.
    const consumer = consumerOf(drifted.user.id);
    assert.ok(consumer);
    delete consumer.credentials.keyauth;

    const response = await harness.authed(drifted, {
      method: 'POST',
      url: `/api/credentials/${original.credential.id}/rotate`,
      payload: {},
    });
    assert.equal(response.statusCode, 502, response.body);
    assert.equal(errorCode(response.body), 'EDGE_ERROR');
    assert.match(JSON.parse(response.body).error.message, /reconcile this consumer/);

    // Nothing was created: no second row, no appended entry, no secret.
    assert.equal(consumerOf(drifted.user.id)?.credentials.keyauth, undefined);
    const rows = await harness.store.credentials.list({ user_id: drifted.user.id });
    assert.equal(rows.total, 1, 'the refused rotation left no extra row behind');
    assert.equal(rows.items[0]?.id, original.credential.id);
    assert.equal(rows.items[0]?.status, 'active', 'and did not revoke the original either');
    assert.ok(!('secret' in JSON.parse(response.body)));

    // Revoking the same drifted credential still works: deleting the whole
    // type is exactly what a revoke asked for.
    const revoked = await harness.authed(drifted, {
      method: 'DELETE',
      url: `/api/credentials/${original.credential.id}`,
    });
    assert.equal(revoked.statusCode, 200, revoked.body);
    assert.equal(
      (await harness.store.credentials.findById(original.credential.id))?.status,
      'revoked',
    );
  });

  it('lets exactly one of two raced rotations of the same credential win', async () => {
    const racer = await harness.registerUser({ email: 'cred-race@example.test', role: 'client' });
    const original = await issue(racer, 'keyauth', 'Production');
    const rotate = (): Promise<{ statusCode: number; body: string }> =>
      harness.authed(racer, {
        method: 'POST',
        url: `/api/credentials/${original.credential.id}/rotate`,
        payload: {},
      });

    // Both requests load the target, then both are let go at once.
    barrierOnCredentialLoad(harness, 2);
    const [first, second] = await Promise.all([rotate(), rotate()]);

    const codes = [first.statusCode, second.statusCode].sort((a, b) => a - b);
    assert.deepEqual(codes, [200, 409], `got ${first.body} / ${second.body}`);
    const winner = JSON.parse(
      (first.statusCode === 200 ? first : second).body,
    ) as RotateCredentialResponse;
    const loser = first.statusCode === 200 ? second : first;
    assert.equal(errorCode(loser.body), 'CONFLICT');
    assert.ok(!('secret' in JSON.parse(loser.body)), 'the loser hands out no show-once secret');

    // The gateway keeps exactly one working key — the winner's. The bug this
    // covers ended with no `keyauth` array on the consumer at all.
    const entries = consumerOf(racer.user.id)?.credentials.keyauth;
    assert.equal(entries?.length, 1);
    assert.equal(entries?.[0]?.key, winner.secret.key);

    // …and the portal mirrors it: one active row, the rotated one revoked.
    const rows = await harness.store.credentials.list({ user_id: racer.user.id });
    assert.equal(rows.total, 2, 'only one replacement row was created');
    const active = rows.items.filter((row) => row.status === 'active');
    assert.equal(active.length, 1);
    assert.equal(active[0]?.id, winner.credential.id);
    assert.equal(
      (await harness.store.credentials.findById(original.credential.id))?.status,
      'revoked',
    );
  });

  it('revokes a credential from the gateway and the portal together', async () => {
    const holder = await harness.registerUser({
      email: 'cred-revoke@example.test',
      role: 'client',
    });
    const issued = await issue(holder, 'keyauth');

    const response = await harness.authed(holder, {
      method: 'DELETE',
      url: `/api/credentials/${issued.credential.id}`,
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { ok: true });

    assert.equal(consumerOf(holder.user.id)?.credentials.keyauth, undefined);
    const row = await harness.store.credentials.findById(issued.credential.id);
    assert.equal(row?.status, 'revoked');

    assert.ok(
      (await harness.auditRows('credential.revoke')).some(
        (entry) => entry.target_id === issued.credential.id,
      ),
    );

    // A revoked slot frees room under the cap again.
    const replacement = await harness.authed(holder, {
      method: 'POST',
      url: '/api/credentials',
      payload: { credential_type: 'keyauth' },
    });
    assert.equal(replacement.statusCode, 201);
  });

  it('refuses to rotate or revoke another account’s credential', async () => {
    const issued = await issue(bob, 'keyauth');

    const rotate = await harness.authed(alice, {
      method: 'POST',
      url: `/api/credentials/${issued.credential.id}/rotate`,
      payload: {},
    });
    assert.equal(rotate.statusCode, 403);
    assert.equal(errorCode(rotate.body), 'FORBIDDEN');

    const revoke = await harness.authed(alice, {
      method: 'DELETE',
      url: `/api/credentials/${issued.credential.id}`,
    });
    assert.equal(revoke.statusCode, 403);

    const row = await harness.store.credentials.findById(issued.credential.id);
    assert.equal(row?.status, 'active');
  });

  it('lists only the caller’s own credentials unless an admin asks otherwise', async () => {
    const mine = await harness.authed(alice, { method: 'GET', url: '/api/credentials' });
    const rows = mine.json<ListCredentialsResponse>();
    assert.ok(rows.total > 0);
    assert.ok(rows.items.every((row) => row.user_id === alice.user.id));

    const peek = await harness.authed(alice, {
      method: 'GET',
      url: `/api/credentials?user_id=${bob.user.id}`,
    });
    assert.equal(peek.statusCode, 403);

    const admin = await harness.authed(founder, {
      method: 'GET',
      url: `/api/credentials?user_id=${bob.user.id}`,
    });
    assert.equal(admin.statusCode, 200);
    assert.ok(
      admin.json<ListCredentialsResponse>().items.every((row) => row.user_id === bob.user.id),
    );
  });

  it('filters the list by status', async () => {
    const response = await harness.authed(founder, {
      method: 'GET',
      url: `/api/credentials?user_id=${alice.user.id}&status=active`,
    });
    assert.ok(
      response.json<ListCredentialsResponse>().items.every((row) => row.status === 'active'),
    );
  });

  it('rejects an unknown credential type at the route boundary', async () => {
    const response = await harness.authed(alice, {
      method: 'POST',
      url: '/api/credentials',
      payload: { credential_type: 'hmac_auth' },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(errorCode(response.body), 'VALIDATION_FAILED');
  });

  it('requires a session and the CSRF header', async () => {
    const anonymous = await harness.app.inject({
      method: 'POST',
      url: '/api/credentials',
      payload: { credential_type: 'keyauth' },
    });
    assert.equal(anonymous.statusCode, 401);

    const noCsrf = await harness.app.inject({
      method: 'POST',
      url: '/api/credentials',
      headers: { cookie: alice.cookieHeader },
      payload: { credential_type: 'keyauth' },
    });
    assert.equal(noCsrf.statusCode, 403);
    assert.equal(errorCode(noCsrf.body), 'CSRF_MISMATCH');
  });
});
