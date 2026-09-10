/**
 * Credential durability across a lost gateway write.
 *
 * Three reports converge on the same seam — the moment between a destructive
 * Edge call and the local row that records it — and each one is a different way
 * for the two to end up disagreeing:
 *
 * - **#131.** One dropped acknowledgement on a `DELETE` Edge applied, or one
 *   transient store error after a confirmed delete, left the mirror one row
 *   longer than the array. `resolveCredentialIndex` then refused every later
 *   rotate *and* revoke of that type, and the per-type cap blocked issuing a
 *   replacement: an account holding a live gateway credential nobody could
 *   kill. The retirement is now recorded as a `retiring` row *before* the
 *   delete, and the next call settles it. The invariant under test is simply
 *   "the owner can always revoke a live credential".
 * - **#132.** A below-cap rotation whose delete failed outright left the
 *   replacement it had already appended standing — a credential whose
 *   show-once plaintext was never delivered, occupying a cap slot, with
 *   nothing in the audit trail to explain it. The append is now taken back.
 * - **#144.** `issueForConsumer` computed its compensating delete from the
 *   *portal's* row count, so on a Nexus-only restore — a state
 *   `docs/operations.md` documents — a failed issue deleted an older,
 *   still-live gateway key and kept the orphan it had just created. The index
 *   now comes from the gateway, and the delete is only issued against an array
 *   that still looks the way the append left it.
 *
 * The negatives matter as much as the repairs: genuine out-of-band drift must
 * still refuse, because acting on a stale index is how somebody else's live
 * key dies. And a `retiring` row is only ever allowed to outlive its call when
 * the entry behind it *might* be gone: where the array proves the delete never
 * applied, the intent is withdrawn, because a `retiring` row over a live entry
 * is what would make a later settlement pick the wrong row.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  consumerUsernameForUser,
  type ApiErrorBody,
  type IssueCredentialResponse,
  type RotateCredentialResponse,
} from '@ferrum-nexus/shared';

import { buildTestApp, type TestApp, type TestSession } from './helpers.js';

function errorOf(body: string): ApiErrorBody['error'] {
  return (JSON.parse(body) as ApiErrorBody).error;
}

/**
 * Make the next `credentials.create` throw, after running `beforeThrow`.
 *
 * The same seam the lifecycle and ordering suites use: the service passes the
 * store no id and no timestamp, so wrapping one call changes nothing else. The
 * hook runs between the Edge append and the failure, which is what lets a test
 * move the gateway array *underneath* an in-flight append.
 */
function failNextCreate(harness: TestApp, beforeThrow?: () => void): void {
  const real = harness.store.credentials.create.bind(harness.store.credentials);
  harness.store.credentials.create = async () => {
    harness.store.credentials.create = real;
    beforeThrow?.();
    throw new Error('injected metadata insert failure');
  };
}

/** Let `successes` `credentials.update` calls through, then fail the next one. */
function failUpdateAfter(harness: TestApp, successes: number): void {
  const real = harness.store.credentials.update.bind(harness.store.credentials);
  let remaining = successes;
  harness.store.credentials.update = async (id, patch) => {
    if (remaining > 0) {
      remaining -= 1;
      return real(id, patch);
    }
    harness.store.credentials.update = real;
    throw new Error('injected metadata update failure');
  };
}

describe('credential durability across a lost gateway write', () => {
  let harness: TestApp;
  let nonce = 0;

  before(async () => {
    harness = await buildTestApp();
    await harness.registerUser({ email: 'durability-founder@example.test' });
  });

  after(async () => {
    await harness.close();
  });

  async function client(): Promise<TestSession> {
    nonce += 1;
    return harness.registerUser({
      email: `durability-${nonce}@example.test`,
      role: 'client',
    });
  }

  async function issue(actor: TestSession, label?: string): Promise<IssueCredentialResponse> {
    const response = await harness.authed(actor, {
      method: 'POST',
      url: '/api/credentials',
      payload: { credential_type: 'keyauth', ...(label ? { label } : {}) },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<IssueCredentialResponse>();
  }

  function rotate(actor: TestSession, credentialId: string) {
    return harness.authed(actor, {
      method: 'POST',
      url: `/api/credentials/${credentialId}/rotate`,
      payload: {},
    });
  }

  function revoke(actor: TestSession, credentialId: string) {
    return harness.authed(actor, { method: 'DELETE', url: `/api/credentials/${credentialId}` });
  }

  /** The keyauth material live on the mock gateway, in array order. */
  function liveKeys(userId: string): string[] {
    const consumer = harness.edge.consumerByUsername(consumerUsernameForUser(userId));
    return (consumer?.credentials.keyauth ?? []).map((entry) => String(entry.key));
  }

  /**
   * The basicauth material live on the mock gateway, in array order.
   *
   * Read straight off the stored consumer, not through a projection: Edge
   * omits `basicauth` from every response, which is exactly why the portal
   * cannot identify one of its entries.
   */
  function livePasswords(userId: string): string[] {
    const consumer = harness.edge.consumerByUsername(consumerUsernameForUser(userId));
    return (consumer?.credentials.basicauth ?? []).map((entry) => String(entry.password));
  }

  async function statusOf(credentialId: string): Promise<string | undefined> {
    return (await harness.store.credentials.findById(credentialId))?.status;
  }

  /** Audit rows of one action written against a consumer, newest first. */
  async function rowsFor(action: string, consumerId: string) {
    const rows = await harness.auditRows(action);
    return rows.filter((row) => row.details.consumer_id === consumerId);
  }

  /* ── #131 — a lost acknowledgement no longer wedges the type ──────────── */

  it('settles a revoke whose delete Edge applied but never acknowledged', async () => {
    const user = await client();
    const first = await issue(user, 'first');
    const second = await issue(user, 'second');
    const consumerId = first.credential.ferrum_consumer_id;

    // Edge removes the entry and the answer is lost on the way back.
    harness.edge.queueLostAck(503, { error: 'timeout' }, '/credentials/keyauth/', 'DELETE');
    const lost = await revoke(user, first.credential.id);
    assert.equal(lost.statusCode, 502, lost.body);

    // The drift the report is about: two live rows against one Edge entry.
    assert.deepEqual(liveKeys(user.user.id), [String(second.secret.key)]);
    assert.equal(await statusOf(first.credential.id), 'retiring', 'the intent is durable');

    // The invariant: the survivor is still revocable. It used to be 502.
    const survivor = await revoke(user, second.credential.id);
    assert.equal(survivor.statusCode, 200, survivor.body);
    assert.deepEqual(liveKeys(user.user.id), []);
    assert.equal(await statusOf(first.credential.id), 'revoked');
    assert.equal(await statusOf(second.credential.id), 'revoked');

    const settled = await rowsFor('credential.settle', consumerId);
    assert.equal(settled.length, 1, 'the settlement is audited');
    assert.equal(settled[0]?.target_id, first.credential.id);
    assert.equal(settled[0]?.details.gateway_entries, 1);
    assert.equal(settled[0]?.details.mirror_rows, 2);
  });

  it('settles a rotation whose row update failed after a confirmed delete', async () => {
    const user = await client();
    const original = await issue(user);
    const consumerId = original.credential.ferrum_consumer_id;

    // Below the cap: append, mark `retiring`, delete — and only the write that
    // settles the row to `revoked` fails. The delete really happened.
    failUpdateAfter(harness, 1);
    const rotated = await rotate(user, original.credential.id);
    assert.ok(rotated.statusCode >= 500, rotated.body);

    const replacement = await harness.store.credentials.list({ user_id: user.user.id });
    assert.equal(replacement.total, 2);
    assert.equal(liveKeys(user.user.id).length, 1, 'one Edge entry against two live rows');
    assert.equal(await statusOf(original.credential.id), 'retiring');

    // The rotation mutated the gateway and no `credential.rotate` row is ever
    // coming, so it leaves a trail of its own naming both halves: the
    // replacement whose secret was never delivered, and the row left pending.
    const replacementRow = replacement.items.find((row) => row.id !== original.credential.id);
    assert.ok(replacementRow);
    assert.equal((await rowsFor('credential.rotate', consumerId)).length, 0);
    const trail = await rowsFor('credential.append_rollback', consumerId);
    assert.equal(trail.length, 1);
    assert.equal(trail[0]?.details.withdrawn, false);
    assert.equal(trail[0]?.details.operation, 'rotate');
    assert.equal(trail[0]?.details.stranded_credential_id, replacementRow.id);
    assert.equal(trail[0]?.details.retired_credential_id, original.credential.id);

    // The cap is not spent on a row whose entry is already gone.
    const fresh = await issue(user, 'after the drift');
    assert.equal(await statusOf(original.credential.id), 'revoked');
    assert.equal(liveKeys(user.user.id).length, 2);
    assert.equal((await rowsFor('credential.settle', consumerId)).length, 1);

    // …and everything still live is revocable.
    assert.equal((await revoke(user, replacementRow.id)).statusCode, 200);
    assert.equal((await revoke(user, fresh.credential.id)).statusCode, 200);
    assert.deepEqual(liveKeys(user.user.id), []);
  });

  it('settles an at-cap rotation whose delete was applied and never acknowledged', async () => {
    const user = await client();
    const first = await issue(user, 'first');
    const second = await issue(user, 'second');

    // At the cap the old entry goes first and no local write follows it at
    // all — the transition #62's fix never reached.
    harness.edge.queueLostAck(503, { error: 'timeout' }, '/credentials/keyauth/', 'DELETE');
    const lost = await rotate(user, first.credential.id);
    assert.equal(lost.statusCode, 502, lost.body);
    assert.ok(!('secret' in JSON.parse(lost.body)), 'no secret was handed out');
    assert.equal(await statusOf(first.credential.id), 'retiring');
    assert.deepEqual(liveKeys(user.user.id), [String(second.secret.key)]);

    // Rotating the survivor now works instead of returning 502 for ever.
    const survivor = await rotate(user, second.credential.id);
    assert.equal(survivor.statusCode, 200, survivor.body);
    const body = survivor.json<RotateCredentialResponse>();
    assert.deepEqual(liveKeys(user.user.id), [String(body.secret.key)]);
    assert.equal(await statusOf(first.credential.id), 'revoked');

    // And the slot the wedged row was holding is free again.
    const fresh = await issue(user, 'after the drift');
    assert.equal(liveKeys(user.user.id).length, 2);
    assert.equal((await revoke(user, fresh.credential.id)).statusCode, 200);
  });

  it('puts the row back when a revoke’s delete never reached the gateway', async () => {
    const user = await client();
    const first = await issue(user, 'first');
    const second = await issue(user, 'second');
    const consumerId = first.credential.ferrum_consumer_id;

    // Refused *before* Edge touched the array, so the entry is still live. A
    // row left `retiring` over it is the one input that could later make a
    // settlement pick the wrong row and a positional delete take the survivor.
    harness.edge.queueFailure(503, { error: 'down' }, '/credentials/keyauth/', 'DELETE');
    const failed = await revoke(user, first.credential.id);
    assert.equal(failed.statusCode, 502, failed.body);

    assert.equal(await statusOf(first.credential.id), 'active', 'the intent was withdrawn');
    assert.equal(liveKeys(user.user.id).length, 2, 'nothing was deleted');
    assert.equal((await rowsFor('credential.settle', consumerId)).length, 0);

    // Which leaves an ordinary retry rather than a consumer to reconcile.
    const retried = await revoke(user, first.credential.id);
    assert.equal(retried.statusCode, 200, retried.body);
    assert.deepEqual(liveKeys(user.user.id), [String(second.secret.key)]);
    assert.equal(await statusOf(first.credential.id), 'revoked');
  });

  it('puts the row back when an at-cap rotation’s delete never reached the gateway', async () => {
    const user = await client();
    const first = await issue(user, 'first');
    const second = await issue(user, 'second');
    const consumerId = first.credential.ferrum_consumer_id;

    // At the cap the delete comes first and nothing has been appended yet, so
    // a refusal leaves the account exactly as the rotation found it.
    harness.edge.queueFailure(503, { error: 'down' }, '/credentials/keyauth/', 'DELETE');
    const failed = await rotate(user, first.credential.id);
    assert.equal(failed.statusCode, 502, failed.body);
    assert.ok(!('secret' in JSON.parse(failed.body)), 'no secret was handed out');

    assert.equal(await statusOf(first.credential.id), 'active', 'the intent was withdrawn');
    assert.deepEqual(liveKeys(user.user.id), [String(first.secret.key), String(second.secret.key)]);
    assert.equal((await rowsFor('credential.rotate', consumerId)).length, 0);
    assert.equal((await rowsFor('credential.settle', consumerId)).length, 0);

    // The cap slot is still this credential's own, so the retry is an ordinary
    // rotation instead of a 409 against a row nobody can use.
    const retried = await rotate(user, first.credential.id);
    assert.equal(retried.statusCode, 200, retried.body);
    const body = retried.json<RotateCredentialResponse>();
    assert.equal(await statusOf(first.credential.id), 'revoked');
    assert.deepEqual(liveKeys(user.user.id), [String(second.secret.key), String(body.secret.key)]);
  });

  it('still refuses drift that no pending retirement explains', async () => {
    const user = await client();
    const first = await issue(user, 'first');
    const second = await issue(user, 'second');

    // An operator deleted an entry by hand. Both rows are `active`, so there
    // is no reading of this that says which entry is which.
    const username = consumerUsernameForUser(user.user.id);
    const entries = harness.edge.consumerByUsername(username)?.credentials.keyauth;
    assert.ok(entries);
    entries.splice(0, 1);

    const rotated = await rotate(user, second.credential.id);
    assert.equal(rotated.statusCode, 502, rotated.body);
    assert.match(errorOf(rotated.body).message, /reconcile this consumer/);
    const revoked = await revoke(user, second.credential.id);
    assert.equal(revoked.statusCode, 502, revoked.body);
    assert.match(errorOf(revoked.body).message, /reconcile this consumer/);
    assert.equal(await statusOf(first.credential.id), 'active');
    assert.equal(await statusOf(second.credential.id), 'active');
  });

  it('refuses drift that two pending retirements could equally explain', async () => {
    const user = await client();
    const first = await issue(user, 'first');
    const second = await issue(user, 'second');

    await harness.store.credentials.update(first.credential.id, { status: 'retiring' });
    await harness.store.credentials.update(second.credential.id, { status: 'retiring' });
    const username = consumerUsernameForUser(user.user.id);
    const entries = harness.edge.consumerByUsername(username)?.credentials.keyauth;
    assert.ok(entries);
    entries.splice(0, 1);

    // One row too many, but two candidates for it: settling either would put
    // every remaining position out by one.
    const revoked = await revoke(user, second.credential.id);
    assert.equal(revoked.statusCode, 502, revoked.body);
    assert.match(errorOf(revoked.body).message, /reconcile this consumer/);
    assert.equal(await statusOf(first.credential.id), 'retiring');
    assert.equal(await statusOf(second.credential.id), 'retiring');
    assert.equal(liveKeys(user.user.id).length, 1, 'nothing was deleted');
  });

  /* ── #132 — a failed delete does not strand its replacement ───────────── */

  it('takes back the replacement when a below-cap rotation cannot delete', async () => {
    const user = await client();
    const original = await issue(user, 'production');
    const consumerId = original.credential.ferrum_consumer_id;

    harness.edge.queueFailure(503, { error: 'down' }, '/credentials/keyauth/', 'DELETE');
    const rotated = await rotate(user, original.credential.id);
    assert.equal(rotated.statusCode, 502, rotated.body);
    assert.ok(!('secret' in JSON.parse(rotated.body)), 'no secret was handed out');

    // The account is exactly as the rotation found it.
    assert.deepEqual(liveKeys(user.user.id), [String(original.secret.key)]);
    const rows = await harness.store.credentials.list({ user_id: user.user.id });
    assert.equal(rows.total, 1, 'the undelivered replacement left no row behind');
    assert.equal(rows.items[0]?.id, original.credential.id);
    assert.equal(await statusOf(original.credential.id), 'active');

    // What changed is recorded; what did not is not claimed.
    assert.equal((await rowsFor('credential.rotate', consumerId)).length, 0);
    const rollback = await rowsFor('credential.append_rollback', consumerId);
    assert.equal(rollback.length, 1);
    assert.equal(rollback[0]?.details.operation, 'rotate');
    assert.equal(rollback[0]?.details.withdrawn, true);

    // The cap slot was never spent, so the owner recovers unaided.
    const fresh = await issue(user, 'replacement');
    assert.equal(liveKeys(user.user.id).length, 2);
    assert.equal((await revoke(user, fresh.credential.id)).statusCode, 200);
  });

  it('confirms a compensating delete whose acknowledgement is lost', async () => {
    const user = await client();
    const original = await issue(user, 'production');
    const consumerId = original.credential.ferrum_consumer_id;

    // The old-entry delete is rejected before mutation. The rollback delete
    // then removes the appended replacement but loses its acknowledgement.
    harness.edge.queueFailure(503, { error: 'down' }, '/credentials/keyauth/', 'DELETE');
    harness.edge.queueLostAck(503, { error: 'timeout' }, '/credentials/keyauth/', 'DELETE');
    const rotated = await rotate(user, original.credential.id);
    assert.equal(rotated.statusCode, 502, rotated.body);
    assert.ok(!('secret' in JSON.parse(rotated.body)), 'no secret was handed out');

    assert.deepEqual(liveKeys(user.user.id), [String(original.secret.key)]);
    const rows = await harness.store.credentials.list({ user_id: user.user.id });
    assert.equal(rows.total, 1, 'the confirmed withdrawal removed the replacement row');
    assert.equal(rows.items[0]?.id, original.credential.id);
    assert.equal(await statusOf(original.credential.id), 'active');

    const rollback = await rowsFor('credential.append_rollback', consumerId);
    assert.equal(rollback.length, 1);
    assert.equal(rollback[0]?.details.withdrawn, true);

    // The mirror still agrees with Edge, so ordinary self-service remains available.
    assert.equal((await revoke(user, original.credential.id)).statusCode, 200);
    assert.deepEqual(liveKeys(user.user.id), []);
  });

  it('takes back the replacement when the retirement cannot even be recorded', async () => {
    const user = await client();
    const original = await issue(user, 'production');
    const consumerId = original.credential.ferrum_consumer_id;

    // Below the cap the replacement is appended first, so a store error on the
    // write that records the retirement strands it exactly as a failed delete
    // does — #132's end state reached by a different fault, before the gateway
    // is touched a second time.
    failUpdateAfter(harness, 0);
    const rotated = await rotate(user, original.credential.id);
    assert.ok(rotated.statusCode >= 500, rotated.body);

    // The account is exactly as the rotation found it.
    assert.deepEqual(liveKeys(user.user.id), [String(original.secret.key)]);
    const rows = await harness.store.credentials.list({ user_id: user.user.id });
    assert.equal(rows.total, 1, 'the undelivered replacement left no row behind');
    assert.equal(await statusOf(original.credential.id), 'active');

    const rollback = await rowsFor('credential.append_rollback', consumerId);
    assert.equal(rollback.length, 1);
    assert.equal(rollback[0]?.details.operation, 'rotate');
    assert.equal(rollback[0]?.details.withdrawn, true);
    assert.equal((await rowsFor('credential.rotate', consumerId)).length, 0);

    // The cap slot was never spent, so the owner recovers unaided.
    const fresh = await issue(user, 'replacement');
    assert.equal(liveKeys(user.user.id).length, 2);
    assert.equal((await revoke(user, fresh.credential.id)).statusCode, 200);
  });

  it('does not send an operator to reconcile a rotation that settles itself', async () => {
    const user = await client();
    const original = await issue(user, 'production');
    const consumerId = original.credential.ferrum_consumer_id;

    // Below the cap: append, retire, delete — and Edge applies the delete and
    // loses the answer. The previous entry really is gone, the mirror is one
    // row too long, and the next call on this pair settles it. Telling the
    // operator to reconcile — which empties the type on both sides — would
    // destroy a state that repairs itself.
    harness.edge.queueLostAck(503, { error: 'timeout' }, '/credentials/keyauth/', 'DELETE');
    const rotated = await rotate(user, original.credential.id);
    assert.equal(rotated.statusCode, 502, rotated.body);
    const error = errorOf(rotated.body);
    assert.doesNotMatch(
      error.message,
      /reconcile/,
      'no destructive steer for a self-healing state',
    );
    assert.match(error.message, /no longer holds it/);
    const details = error.details as Record<string, unknown> | undefined;
    const stranded = details?.stranded_credential_id;
    assert.ok(typeof stranded === 'string', 'the error names the credential to revoke');
    assert.equal(details?.retired_credential_id, original.credential.id);

    assert.equal(await statusOf(original.credential.id), 'retiring');
    assert.equal(liveKeys(user.user.id).length, 1, 'one entry against two live rows');

    // The next call settles the drift rather than refusing it, and everything
    // left behind is ordinary self-service.
    const fresh = await issue(user, 'after the lost acknowledgement');
    assert.equal(await statusOf(original.credential.id), 'revoked');
    assert.equal((await rowsFor('credential.settle', consumerId)).length, 1);
    assert.equal(liveKeys(user.user.id).length, 2);
    assert.equal((await revoke(user, stranded)).statusCode, 200);
    assert.equal((await revoke(user, fresh.credential.id)).statusCode, 200);
    assert.deepEqual(liveKeys(user.user.id), []);
  });

  it('names the stranded replacement when it cannot be taken back either', async () => {
    const user = await client();
    const original = await issue(user, 'production');
    const consumerId = original.credential.ferrum_consumer_id;

    // One failure for the rotation's delete, one for the compensating one.
    harness.edge.queueFailure(503, { error: 'down' }, '/credentials/keyauth/', 'DELETE');
    harness.edge.queueFailure(503, { error: 'still down' }, '/credentials/keyauth/', 'DELETE');
    const rotated = await rotate(user, original.credential.id);
    assert.equal(rotated.statusCode, 502, rotated.body);
    const error = errorOf(rotated.body);
    assert.match(error.message, /could not be taken back/);
    const details = error.details as Record<string, unknown> | undefined;
    const stranded = details?.stranded_credential_id;
    assert.ok(typeof stranded === 'string', 'the error names the credential to clean up');

    const rollback = await rowsFor('credential.append_rollback', consumerId);
    assert.equal(rollback.length, 1);
    assert.equal(rollback[0]?.details.withdrawn, false);
    assert.equal(rollback[0]?.details.stranded_credential_id, stranded);

    // Both sides agree — two entries, two rows — so recovery is self-service.
    assert.equal(liveKeys(user.user.id).length, 2);
    assert.equal(await statusOf(original.credential.id), 'active');
    assert.equal((await revoke(user, stranded)).statusCode, 200);
    assert.deepEqual(liveKeys(user.user.id), [String(original.secret.key)]);
  });

  /* ── #144 — a compensating delete only ever removes what it appended ──── */

  it('leaves the pre-restore key alone when an issue fails on a short mirror', async () => {
    const user = await client();
    const restored = await issue(user, 'survives the restore');
    const consumerId = restored.credential.ferrum_consumer_id;
    const preRestore = liveKeys(user.user.id);
    assert.deepEqual(preRestore, [String(restored.secret.key)]);

    // The documented Nexus-only restore: the gateway keeps its entry, the
    // portal has no live row for it at all.
    await harness.store.credentials.update(restored.credential.id, { status: 'revoked' });

    failNextCreate(harness);
    const issued = await harness.authed(user, {
      method: 'POST',
      url: '/api/credentials',
      payload: { credential_type: 'keyauth' },
    });
    assert.ok(issued.statusCode >= 500, issued.body);

    // Entries carry no id, so compare the material itself: an id comparison
    // would pass against a completely different key.
    assert.deepEqual(liveKeys(user.user.id), preRestore, 'the pre-restore key survived');
    const rollback = await rowsFor('credential.append_rollback', consumerId);
    assert.equal(rollback.length, 1);
    assert.equal(rollback[0]?.details.operation, 'issue');
    assert.equal(rollback[0]?.details.withdrawn, true);
  });

  it('never deletes a basicauth entry, which no read can identify', async () => {
    const user = await client();
    const response = await harness.authed(user, {
      method: 'POST',
      url: '/api/credentials',
      payload: { credential_type: 'basicauth' },
    });
    assert.equal(response.statusCode, 201, response.body);
    const restored = response.json<IssueCredentialResponse>();
    const consumerId = restored.credential.ferrum_consumer_id;
    const preRestore = livePasswords(user.user.id);
    assert.equal(preRestore.length, 1);

    // The same Nexus-only restore as above. `basicauth` appears in no read
    // projection, so there is no array to check an index against and the only
    // index available is one counted off the mirror — which now points at the
    // pre-restore password rather than at the orphan the append created.
    await harness.store.credentials.update(restored.credential.id, { status: 'revoked' });

    failNextCreate(harness);
    const issued = await harness.authed(user, {
      method: 'POST',
      url: '/api/credentials',
      payload: { credential_type: 'basicauth' },
    });
    assert.ok(issued.statusCode >= 500, issued.body);

    const passwords = livePasswords(user.user.id);
    assert.equal(passwords.length, 2, 'nothing was deleted on the mirror’s word');
    assert.equal(passwords[0], preRestore[0], 'the pre-restore password survived');

    // What identifies the orphan instead: where it went, and what it ends in.
    const rollback = await rowsFor('credential.append_rollback', consumerId);
    assert.equal(rollback.length, 1);
    assert.equal(rollback[0]?.details.withdrawn, false, 'the orphan is recorded, not guessed at');
    assert.equal(rollback[0]?.details.credential_type, 'basicauth');
    assert.equal(rollback[0]?.details.append_index, 0);
    assert.equal(rollback[0]?.details.last4, passwords[1]?.slice(-4));
    assert.equal(rollback[0]?.ip, '127.0.0.1', 'and the address that caused it');
  });

  it('deletes nothing when the array moved under an in-flight append', async () => {
    const user = await client();
    const original = await issue(user, 'mine');
    const consumerId = original.credential.ferrum_consumer_id;
    const foreign = 'nxs_out_of_band_entry_written_by_an_operator';

    // Edge redacts credential material on every read, so the fingerprint the
    // append computed can never be matched against the array; what can be
    // checked is that the array is still one entry longer than the length the
    // index came from. Here an operator prepends an entry while the append is
    // in flight, and index 1 stops meaning "the entry we just wrote".
    failNextCreate(harness, () => {
      const username = consumerUsernameForUser(user.user.id);
      const entries = harness.edge.consumerByUsername(username)?.credentials.keyauth;
      assert.ok(entries);
      entries.unshift({ key: foreign });
    });
    const issued = await harness.authed(user, {
      method: 'POST',
      url: '/api/credentials',
      payload: { credential_type: 'keyauth' },
    });
    assert.ok(issued.statusCode >= 500, issued.body);

    const keys = liveKeys(user.user.id);
    assert.equal(keys.length, 3, 'nothing was deleted at a position that had moved');
    assert.ok(keys.includes(foreign), 'the entry the delete would have taken is still live');
    assert.ok(keys.includes(String(original.secret.key)));
    const rollback = await rowsFor('credential.append_rollback', consumerId);
    assert.equal(rollback.length, 1);
    assert.equal(rollback[0]?.details.withdrawn, false, 'the orphan is recorded, not guessed at');
  });

  it('takes back an append whose own acknowledgement was lost', async () => {
    const user = await client();
    const original = await issue(user, 'first');
    const consumerId = original.credential.ferrum_consumer_id;

    // A refusal Edge really did refuse: the array never grew, so there is no
    // orphan to take back and nothing to put in front of an operator.
    harness.edge.queueFailure(503, { error: 'down' }, '/credentials/keyauth', 'POST');
    const refused = await harness.authed(user, {
      method: 'POST',
      url: '/api/credentials',
      payload: { credential_type: 'keyauth' },
    });
    assert.equal(refused.statusCode, 502, refused.body);
    assert.deepEqual(liveKeys(user.user.id), [String(original.secret.key)]);
    assert.equal((await rowsFor('credential.append_rollback', consumerId)).length, 0);

    // The same answer on the wire with the entry actually created. Nothing
    // local records it, so no later call could ever settle it: the mirror
    // would be one row *shorter* than the array for good.
    harness.edge.queueLostAck(503, { error: 'timeout' }, '/credentials/keyauth', 'POST');
    const lost = await harness.authed(user, {
      method: 'POST',
      url: '/api/credentials',
      payload: { credential_type: 'keyauth' },
    });
    assert.equal(lost.statusCode, 502, lost.body);

    assert.deepEqual(liveKeys(user.user.id), [String(original.secret.key)], 'the orphan went');
    assert.equal((await harness.store.credentials.list({ user_id: user.user.id })).total, 1);
    const rollback = await rowsFor('credential.append_rollback', consumerId);
    assert.equal(rollback.length, 1);
    assert.equal(rollback[0]?.details.operation, 'issue');
    assert.equal(rollback[0]?.details.withdrawn, true);
    assert.equal(rollback[0]?.details.append_index, 1);
    assert.equal(rollback[0]?.details.suspected, undefined, 'the array said it landed');
    assert.equal(rollback[0]?.ip, '127.0.0.1');

    // …and the cap slot it would have spent is free.
    const fresh = await issue(user, 'after the lost acknowledgement');
    assert.equal(liveKeys(user.user.id).length, 2);
    assert.equal((await revoke(user, fresh.credential.id)).statusCode, 200);
  });

  it('removes only its own append when the mirror is longer than the array', async () => {
    // A cap of three, so a third credential can be appended while the mirror
    // still holds two live rows for a gateway array of one.
    const roomy = await buildTestApp({ env: { FERRUM_MAX_CREDENTIALS_PER_TYPE: '3' } });
    try {
      await roomy.registerUser({ email: 'roomy-founder@example.test' });
      const user = await roomy.registerUser({
        email: 'roomy-client@example.test',
        role: 'client',
      });
      const mint = async (): Promise<IssueCredentialResponse> => {
        const response = await roomy.authed(user, {
          method: 'POST',
          url: '/api/credentials',
          payload: { credential_type: 'keyauth' },
        });
        assert.equal(response.statusCode, 201, response.body);
        return response.json<IssueCredentialResponse>();
      };
      await mint();
      const second = await mint();

      // An operator removed the *first* entry by hand: two live rows, one
      // entry, and the mirror's count now points past the array's end.
      const username = consumerUsernameForUser(user.user.id);
      const live = roomy.edge.consumerByUsername(username)?.credentials.keyauth;
      assert.ok(live);
      live.splice(0, 1);

      failNextCreate(roomy);
      const issued = await roomy.authed(user, {
        method: 'POST',
        url: '/api/credentials',
        payload: { credential_type: 'keyauth' },
      });
      assert.ok(issued.statusCode >= 500, issued.body);

      const entries = roomy.edge.consumerByUsername(username)?.credentials.keyauth ?? [];
      assert.deepEqual(
        entries.map((entry) => String(entry.key)),
        [String(second.secret.key)],
        'the orphan went, the live entry stayed',
      );
    } finally {
      await roomy.close();
    }
  });
});
