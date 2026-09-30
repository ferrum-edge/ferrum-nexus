/**
 * Revoking a `basicauth` credential removes that credential's password.
 *
 * Edge omits `basicauth` from every read, so the portal locates an entry by the
 * position its own rows give it and nothing else. One entry the rows do not
 * account for moves every index after it: an append Edge accepted whose row was
 * never written, followed by an ordinary issue, left the later credential at
 * index 1 while the mirror said 0 — and revoking it deleted the earlier,
 * untracked entry, marked the requested row `revoked`, and left its password
 * authenticating. A delete whose acknowledgement was lost did the same the
 * other way round: its row stayed `retiring`, still counted, and a retried
 * revoke deleted the *next* password in its place.
 *
 * The invariants under test:
 *
 * - no `basicauth` entry reaches the gateway without a row naming it;
 * - while any row of the pair has an unconfirmed outcome, nothing is issued,
 *   rotated or revoked by position;
 * - revoking the pair's last `active` credential clears the whole type, which
 *   needs no position, and is how an owner recovers without an administrator.
 *
 * Secrets are compared by membership, never printed: an assertion that fails
 * reports counts and booleans only.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  consumerUsernameForUser,
  type ApiErrorBody,
  type IssueCredentialResponse,
  type ReconcileCredentialsResponse,
  type RotateCredentialResponse,
  type ShowOnceSecret,
} from '@ferrum-nexus/shared';

import type { CredentialRecord } from '../db/store.js';
import { buildTestApp, type TestApp, type TestSession } from './helpers.js';

function errorOf(body: string): ApiErrorBody['error'] {
  return (JSON.parse(body) as ApiErrorBody).error;
}

/** Make the next `credentials.create` throw. */
function failNextCreate(harness: TestApp): void {
  const real = harness.store.credentials.create.bind(harness.store.credentials);
  harness.store.credentials.create = async () => {
    harness.store.credentials.create = real;
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

/**
 * Fail the first credential row write made after a `basicauth` append reached
 * the gateway — the row itself, or the activation of one written beforehand —
 * so the fault is "Edge accepted the entry and the portal could not record it"
 * whichever order the two writes come in.
 */
function failFirstRowWriteAfterAppend(harness: TestApp): void {
  const appends = (): number => harness.edge.callsTo('POST', '/credentials/basicauth').length;
  const before = appends();
  const repo = harness.store.credentials;
  const create = repo.create.bind(repo);
  const updateIfStatus = repo.updateIfStatus.bind(repo);
  const restore = (): void => {
    repo.create = create;
    repo.updateIfStatus = updateIfStatus;
  };
  repo.create = async (input) => {
    if (appends() === before) return create(input);
    restore();
    throw new Error('injected metadata write failure');
  };
  repo.updateIfStatus = async (id, expected, patch) => {
    if (appends() === before) return updateIfStatus(id, expected, patch);
    restore();
    throw new Error('injected metadata write failure');
  };
}

describe('basicauth revocation removes the selected password', () => {
  let harness: TestApp;
  /** First account, therefore `super_admin`. */
  let founder: TestSession;
  let nonce = 0;

  before(async () => {
    harness = await buildTestApp();
    founder = await harness.registerUser({ email: 'basic-revoke-founder@example.test' });
  });

  after(async () => {
    await harness.close();
  });

  async function client(): Promise<TestSession> {
    nonce += 1;
    return harness.registerUser({ email: `basic-revoke-${nonce}@example.test`, role: 'client' });
  }

  function tryIssue(actor: TestSession) {
    return harness.authed(actor, {
      method: 'POST',
      url: '/api/credentials',
      payload: { credential_type: 'basicauth' },
    });
  }

  async function issue(actor: TestSession): Promise<IssueCredentialResponse> {
    const response = await tryIssue(actor);
    assert.equal(response.statusCode, 201, response.body);
    return response.json<IssueCredentialResponse>();
  }

  function revoke(actor: TestSession, credentialId: string) {
    return harness.authed(actor, { method: 'DELETE', url: `/api/credentials/${credentialId}` });
  }

  function rotate(actor: TestSession, credentialId: string) {
    return harness.authed(actor, {
      method: 'POST',
      url: `/api/credentials/${credentialId}/rotate`,
      payload: {},
    });
  }

  function reconcile(actor: TestSession, payload: Record<string, unknown>) {
    return harness.authed(actor, {
      method: 'POST',
      url: '/api/admin/credentials/reconcile',
      payload,
    });
  }

  /**
   * The basicauth passwords live on the mock gateway, in array order — read
   * off the stored consumer, because Edge omits the type from every response.
   */
  function livePasswords(actor: TestSession): string[] {
    const consumer = harness.edge.consumerByUsername(consumerUsernameForUser(actor.user.id));
    return (consumer?.credentials.basicauth ?? []).map((entry) => String(entry.password));
  }

  /** Whether the gateway would still accept this credential's password. */
  function authenticates(actor: TestSession, issued: { secret: ShowOnceSecret }): boolean {
    return livePasswords(actor).includes(String(issued.secret.password));
  }

  /** The account's basicauth rows that still occupy a gateway slot. */
  async function liveRowsOf(actor: TestSession): Promise<CredentialRecord[]> {
    const page = await harness.store.credentials.list(
      { user_id: actor.user.id, credential_type: 'basicauth' },
      { limit: 50 },
    );
    return page.items.filter((row) => row.status !== 'revoked');
  }

  async function statusOf(credentialId: string): Promise<string | undefined> {
    return (await harness.store.credentials.findById(credentialId))?.status;
  }

  /** Audit rows of one action written against a consumer, newest first. */
  async function rowsFor(action: string, consumerId: string) {
    const rows = await harness.auditRows(action);
    return rows.filter((row) => row.details.consumer_id === consumerId);
  }

  /* ── The report: an append Edge accepted and the portal never recorded ── */

  it('records an append whose row write failed and holds the pair until cleared', async () => {
    const user = await client();

    failFirstRowWriteAfterAppend(harness);
    const failed = await tryIssue(user);
    assert.ok(failed.statusCode >= 500, failed.body);
    assert.ok(!('secret' in JSON.parse(failed.body)), 'no secret was handed out');
    assert.equal(livePasswords(user).length, 1, 'the append reached the gateway');

    // The entry has a row: it holds its slot, and says its outcome is unproved.
    const rows = await liveRowsOf(user);
    assert.equal(rows.length, 1, 'the gateway entry is named by a portal row');
    const [pending] = rows;
    assert.ok(pending);
    assert.equal(pending.status, 'retiring');
    const consumerId = pending.ferrum_consumer_id;
    const rollback = await rowsFor('credential.append_rollback', consumerId);
    assert.equal(rollback.length, 1);
    assert.equal(rollback[0]?.details.withdrawn, false);
    assert.equal(rollback[0]?.details.stranded_credential_id, pending.id);

    // The report's next step: a later credential on top of the untracked one.
    // Its position could not be vouched for, so it is refused outright.
    const later = await tryIssue(user);
    assert.equal(later.statusCode, 409, later.body);
    assert.equal(errorOf(later.body).code, 'CONFLICT');
    assert.match(errorOf(later.body).message, /reconcile this consumer/);
    // No active row is left, so the repair on offer is revoking the retiring one.
    assert.match(errorOf(later.body).message, /revoke the retiring credential/);
    assert.doesNotMatch(errorOf(later.body).message, /clear_type/);
    assert.equal(livePasswords(user).length, 1, 'nothing was appended');

    // Revoking the only row clears the type, the unrecorded entry with it.
    const cleared = await revoke(user, pending.id);
    assert.equal(cleared.statusCode, 200, cleared.body);
    assert.equal(livePasswords(user).length, 0, 'no basicauth password survives');
    assert.equal(await statusOf(pending.id), 'revoked');

    // …and the identity is back to ordinary self-service.
    const fresh = await issue(user);
    assert.equal(fresh.credential.status, 'active');
    assert.ok(authenticates(user, fresh));
    const revoked = await revoke(user, fresh.credential.id);
    assert.equal(revoked.statusCode, 200, revoked.body);
    assert.equal(authenticates(user, fresh), false, 'the revoked password no longer works');
  });

  it('removes the revoked password even behind an entry no row accounts for', async () => {
    const user = await client();
    const tracked = await issue(user);

    // What an earlier release could leave behind: an entry whose row was never
    // written, ahead of the credential issued after it. No read reveals it.
    const username = consumerUsernameForUser(user.user.id);
    const entries = harness.edge.consumerByUsername(username)?.credentials.basicauth;
    assert.ok(entries);
    entries.unshift({ password: 'an-entry-appended-without-a-portal-row' });

    const revoked = await revoke(user, tracked.credential.id);
    assert.equal(revoked.statusCode, 200, revoked.body);
    assert.equal(authenticates(user, tracked), false, 'the revoked password no longer works');
    assert.equal(livePasswords(user).length, 0, 'the untracked entry went with the type');
    assert.equal(await statusOf(tracked.credential.id), 'revoked');
  });

  it('holds an append whose acknowledgement was lost until the type is cleared', async () => {
    const user = await client();
    const kept = await issue(user);
    const consumerId = kept.credential.ferrum_consumer_id;

    // Edge appends the entry and the answer is lost: a refusal and a landed
    // append read the same on the wire, and no read can tell them apart.
    harness.edge.queueLostAck(503, { error: 'timeout' }, '/credentials/basicauth', 'POST');
    const lost = await tryIssue(user);
    assert.equal(lost.statusCode, 502, lost.body);
    assert.equal(livePasswords(user).length, 2, 'the append landed');

    const rows = await liveRowsOf(user);
    assert.equal(rows.length, 2, 'both gateway entries are named by portal rows');
    const pending = rows.find((row) => row.id !== kept.credential.id);
    assert.ok(pending);
    assert.equal(pending.status, 'retiring');
    const rollback = await rowsFor('credential.append_rollback', consumerId);
    assert.equal(rollback.length, 1);
    assert.equal(rollback[0]?.details.suspected, true);
    assert.equal(rollback[0]?.details.stranded_credential_id, pending.id);

    // The unconfirmed row is not addressed by position…
    const refused = await revoke(user, pending.id);
    assert.equal(refused.statusCode, 409, refused.body);
    assert.equal(livePasswords(user).length, 2, 'nothing was deleted');

    // …but the last active credential takes the type, and the pending row, with it.
    const cleared = await revoke(user, kept.credential.id);
    assert.equal(cleared.statusCode, 200, cleared.body);
    assert.equal(livePasswords(user).length, 0);
    assert.equal(await statusOf(kept.credential.id), 'revoked');
    assert.equal(await statusOf(pending.id), 'revoked');
  });

  it('refuses a row write that fails before the append reaches the gateway', async () => {
    const user = await client();
    const appends = harness.edge.callsTo('POST', '/credentials/basicauth').length;

    // The row comes first, so a store that cannot write it stops the issue
    // before there is anything on the gateway to lose track of.
    failNextCreate(harness);
    const failed = await tryIssue(user);
    assert.ok(failed.statusCode >= 500, failed.body);
    assert.equal(
      harness.edge.callsTo('POST', '/credentials/basicauth').length,
      appends,
      'nothing was appended',
    );
    assert.equal(livePasswords(user).length, 0);
    assert.equal((await liveRowsOf(user)).length, 0);
  });

  it('holds an append answered 408, which does not prove it never landed', async () => {
    const user = await client();
    harness.edge.queueLostAck(408, { error: 'request timeout' }, '/credentials/basicauth', 'POST');
    const timedOut = await tryIssue(user);
    assert.equal(timedOut.statusCode, 502, timedOut.body);
    assert.equal(livePasswords(user).length, 1, 'the append landed');

    const rows = await liveRowsOf(user);
    assert.equal(rows.length, 1, 'the entry keeps a row');
    assert.equal(rows[0]?.status, 'retiring');
    const rollback = await rowsFor('credential.append_rollback', rows[0]!.ferrum_consumer_id);
    assert.equal(rollback.length, 1);
    assert.equal(rollback[0]?.details.suspected, true);

    const cleared = await revoke(user, rows[0]!.id);
    assert.equal(cleared.statusCode, 200, cleared.body);
    assert.equal(livePasswords(user).length, 0);
  });

  it('records the stranded append even when its row cannot be restored either', async () => {
    const user = await client();
    // Every conditional write after the append fails: the activation, the
    // transactional restore and the fallback outside the transaction.
    const repo = harness.store.credentials;
    const updateIfStatus = repo.updateIfStatus.bind(repo);
    const appends = (): number => harness.edge.callsTo('POST', '/credentials/basicauth').length;
    const before = appends();
    repo.updateIfStatus = async (id, expected, patch) => {
      if (appends() === before) return updateIfStatus(id, expected, patch);
      throw new Error('injected metadata write failure');
    };
    const failed = await (async () => {
      try {
        return await tryIssue(user);
      } finally {
        repo.updateIfStatus = updateIfStatus;
      }
    })();
    assert.ok(failed.statusCode >= 500, failed.body);
    assert.equal(livePasswords(user).length, 1, 'the append reached the gateway');

    const rows = await liveRowsOf(user);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.status, 'retiring', 'the row was never activated');
    const rollback = await rowsFor('credential.append_rollback', rows[0]!.ferrum_consumer_id);
    assert.equal(rollback.length, 1, 'the orphan is still recorded');
    assert.equal(rollback[0]?.details.withdrawn, false);
    assert.equal(rollback[0]?.details.stranded_credential_id, rows[0]!.id);
  });

  it('clears the pending row when Edge definitely rejects a Basic Auth append', async () => {
    const user = await client();
    harness.edge.queueFailure(
      400,
      { error: 'credential cap reached' },
      '/credentials/basicauth',
      'POST',
    );
    const rejected = await tryIssue(user);
    assert.equal(rejected.statusCode, 502, rejected.body);
    assert.equal(livePasswords(user).length, 0);
    assert.equal((await liveRowsOf(user)).length, 0);

    const next = await issue(user);
    assert.equal(livePasswords(user).length, 1);
    assert.equal(await statusOf(next.credential.id), 'active');
  });

  /* ── Deletes whose outcome was never confirmed ───────────────────────── */

  it('never moves a retried revoke onto another password after a lost delete', async () => {
    const user = await client();
    const first = await issue(user);
    const second = await issue(user);
    const consumerId = first.credential.ferrum_consumer_id;

    // Edge removes the first entry and the answer is lost on the way back.
    harness.edge.queueLostAck(503, { error: 'timeout' }, '/credentials/basicauth/', 'DELETE');
    const lost = await revoke(user, first.credential.id);
    assert.equal(lost.statusCode, 502, lost.body);
    assert.equal(await statusOf(first.credential.id), 'retiring');
    assert.equal(authenticates(user, first), false);
    assert.equal(authenticates(user, second), true);

    // The retry used to delete index 0 — by now the second password — and
    // report the first revoked.
    const retried = await revoke(user, first.credential.id);
    assert.equal(retried.statusCode, 409, retried.body);
    assert.equal(errorOf(retried.body).code, 'CONFLICT');
    // An active credential remains beside it, so only an explicit clear helps.
    assert.match(errorOf(retried.body).message, /clear_type=true/);
    assert.deepEqual(errorOf(retried.body).details, {
      consumer_id: consumerId,
      credential_type: 'basicauth',
      unconfirmed_credentials: 1,
      active_credentials: 1,
    });
    assert.equal(authenticates(user, second), true, 'the other password was not deleted');

    // Nor is the survivor rotated by position, or another credential issued.
    const rotated = await rotate(user, second.credential.id);
    assert.equal(rotated.statusCode, 409, rotated.body);
    assert.ok(!('secret' in JSON.parse(rotated.body)), 'no secret was handed out');
    assert.equal((await tryIssue(user)).statusCode, 409);
    assert.equal(livePasswords(user).length, 1, 'the gateway is untouched');
    assert.equal(await statusOf(second.credential.id), 'active');

    // Revoking the last active credential clears the type and settles the rest.
    const cleared = await revoke(user, second.credential.id);
    assert.equal(cleared.statusCode, 200, cleared.body);
    assert.equal(livePasswords(user).length, 0);
    assert.equal(await statusOf(first.credential.id), 'revoked');
    assert.equal(await statusOf(second.credential.id), 'revoked');
    const trail = (await rowsFor('credential.revoke', consumerId)).find(
      (row) => row.target_id === second.credential.id,
    );
    assert.ok(trail, 'the clearing revoke is audited');
    assert.deepEqual(trail.details.swept_credential_ids, [first.credential.id]);
    assert.equal(trail.details.scope, 'whole-type');
    const sweptAudit = (await harness.auditRows('credential.revoke')).find(
      (row) => row.target_id === first.credential.id,
    );
    assert.equal(sweptAudit?.details.swept_by, second.credential.id);
    assert.equal(sweptAudit?.details.owner_user_id, user.user.id);
  });

  it('retries a whole-type delete after its acknowledgement is lost', async () => {
    const user = await client();
    const first = await issue(user);
    const second = await issue(user);
    harness.edge.queueLostAck(503, { error: 'timeout' }, '/credentials/basicauth', 'DELETE');

    const lost = await harness.authed(user, {
      method: 'DELETE',
      url: `/api/credentials/${first.credential.id}?clear_type=true`,
    });
    assert.equal(lost.statusCode, 502, lost.body);
    assert.equal(livePasswords(user).length, 0, 'the delete reached Edge');
    assert.equal(await statusOf(first.credential.id), 'retiring');

    const retried = await harness.authed(user, {
      method: 'DELETE',
      url: `/api/credentials/${first.credential.id}?clear_type=true`,
    });
    assert.equal(retried.statusCode, 200, retried.body);
    assert.equal(await statusOf(first.credential.id), 'revoked');
    assert.equal(await statusOf(second.credential.id), 'revoked');
  });

  it('keeps a failed append-first rotation recoverable when the old delete fails', async () => {
    const user = await client();
    const original = await issue(user);
    harness.edge.queueFailure(
      400,
      { error: 'delete refused' },
      '/credentials/basicauth/',
      'DELETE',
    );

    const failed = await rotate(user, original.credential.id);
    assert.equal(failed.statusCode, 502, failed.body);
    assert.ok(!('secret' in JSON.parse(failed.body)), 'the replacement secret was not returned');
    const rows = await liveRowsOf(user);
    assert.equal(rows.filter((row) => row.status === 'retiring').length, 1);
    assert.equal(rows.filter((row) => row.status === 'active').length, 1);

    const survivor = rows.find((row) => row.status === 'active');
    assert.ok(survivor);
    const cleared = await harness.authed(user, {
      method: 'DELETE',
      url: `/api/credentials/${survivor.id}?clear_type=true`,
    });
    assert.equal(cleared.statusCode, 200, cleared.body);
    assert.equal(livePasswords(user).length, 0);
  });

  it('keeps a lost append acknowledgement at the cap named during rotation', async () => {
    const user = await client();
    const first = await issue(user);
    const second = await issue(user);
    harness.edge.queueLostAck(503, { error: 'timeout' }, '/credentials/basicauth', 'POST');

    const failed = await rotate(user, first.credential.id);
    assert.equal(failed.statusCode, 502, failed.body);
    assert.equal(await statusOf(first.credential.id), 'revoked');
    assert.equal(await statusOf(second.credential.id), 'active');
    const rows = await liveRowsOf(user);
    assert.equal(rows.filter((row) => row.status === 'retiring').length, 1);
    assert.equal(livePasswords(user).length, 2);

    const cleared = await harness.authed(user, {
      method: 'DELETE',
      url: `/api/credentials/${second.credential.id}?clear_type=true`,
    });
    assert.equal(cleared.statusCode, 200, cleared.body);
    assert.equal(livePasswords(user).length, 0);
  });

  it('leaves a failed settlement for reconciliation instead of guessing', async () => {
    const user = await client();
    const first = await issue(user);
    const second = await issue(user);
    const consumerId = first.credential.ferrum_consumer_id;

    // The delete is confirmed; only the write that settles the row fails.
    failUpdateAfter(harness, 1);
    const failed = await revoke(user, first.credential.id);
    assert.ok(failed.statusCode >= 500, failed.body);
    assert.equal(await statusOf(first.credential.id), 'retiring');
    assert.equal(authenticates(user, first), false);

    const retried = await revoke(user, first.credential.id);
    assert.equal(retried.statusCode, 409, retried.body);
    assert.equal(authenticates(user, second), true, 'the other password was not deleted');

    // The administrator's repair clears the type on both sides.
    const response = await reconcile(founder, {
      consumer_id: consumerId,
      credential_type: 'basicauth',
      reason: 'unconfirmed basicauth settlement',
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json<ReconcileCredentialsResponse>().revoked_credentials, 2);
    assert.equal(livePasswords(user).length, 0);
    assert.equal(await statusOf(first.credential.id), 'revoked');
    assert.equal(await statusOf(second.credential.id), 'revoked');

    const fresh = await issue(user);
    assert.ok(authenticates(user, fresh));
  });

  /* ── Positive controls: confirmed credentials behave as they always have ─ */

  it('still revokes and rotates confirmed basicauth credentials one at a time', async () => {
    const user = await client();
    const first = await issue(user);
    const second = await issue(user);
    const positional = (): number =>
      harness.edge.callsTo('DELETE', '/credentials/basicauth/').length;
    const deletesBefore = positional();

    // With another active credential beside it, the target alone is deleted.
    const revoked = await revoke(user, first.credential.id);
    assert.equal(revoked.statusCode, 200, revoked.body);
    assert.equal(positional(), deletesBefore + 1, 'one positional delete');
    assert.equal(authenticates(user, first), false);
    assert.equal(authenticates(user, second), true, 'the other password is untouched');
    assert.equal(await statusOf(second.credential.id), 'active');

    // Below the cap: append the replacement, then delete the old entry.
    const rotated = await rotate(user, second.credential.id);
    assert.equal(rotated.statusCode, 200, rotated.body);
    const body = rotated.json<RotateCredentialResponse>();
    assert.equal(body.credential.status, 'active');
    assert.equal(body.previous.status, 'revoked');
    assert.equal(authenticates(user, second), false);
    assert.equal(authenticates(user, body), true);
    assert.equal(livePasswords(user).length, 1);

    // A new credential beside it is issued as usual, and each is revocable.
    const third = await issue(user);
    assert.equal((await revoke(user, body.credential.id)).statusCode, 200);
    assert.equal(authenticates(user, third), true);
    assert.equal((await revoke(user, third.credential.id)).statusCode, 200);
    assert.equal(livePasswords(user).length, 0);
  });

  it('serializes a concurrent issue and revoke without losing the new password', async () => {
    const user = await client();
    const original = await issue(user);
    const [replacement, revoked] = await Promise.all([
      issue(user),
      revoke(user, original.credential.id),
    ]);
    assert.equal(revoked.statusCode, 200, revoked.body);
    assert.equal(await statusOf(original.credential.id), 'revoked');
    assert.equal(await statusOf(replacement.credential.id), 'active');
    assert.equal(authenticates(user, replacement), true);
    assert.equal(livePasswords(user).length, 1);
  });

  /* ── clear_type is bounded ───────────────────────────────────────────── */

  it('refuses clear_type on a type that is not HTTP Basic', async () => {
    const user = await client();
    const response = await harness.authed(user, {
      method: 'POST',
      url: '/api/credentials',
      payload: { credential_type: 'keyauth' },
    });
    assert.equal(response.statusCode, 201, response.body);
    const key = response.json<IssueCredentialResponse>().credential;

    const refused = await harness.authed(user, {
      method: 'DELETE',
      url: `/api/credentials/${key.id}?clear_type=true`,
    });
    assert.equal(refused.statusCode, 400, refused.body);
    assert.equal(errorOf(refused.body).code, 'VALIDATION_FAILED');
    assert.equal(await statusOf(key.id), 'active', 'nothing was revoked');
  });

  it('keeps clear_type from revoking rows that belong to another account', async () => {
    const user = await client();
    const other = await client();
    const own = await issue(user);
    const consumerId = own.credential.ferrum_consumer_id;
    // A row on this consumer the portal attributes to somebody else.
    const foreign = await harness.store.credentials.create({
      user_id: other.user.id,
      application_id: null,
      ferrum_consumer_id: consumerId,
      credential_type: 'basicauth',
      ferrum_credential_id: `${consumerId}/credentials/basicauth`,
      fingerprint: `test-foreign-row-${nonce}`,
      last4: 'frgn',
      label: null,
      status: 'active',
      rotated_from_id: null,
    });

    const refused = await harness.authed(user, {
      method: 'DELETE',
      url: `/api/credentials/${own.credential.id}?clear_type=true`,
    });
    assert.equal(refused.statusCode, 403, refused.body);
    assert.equal(authenticates(user, own), true, 'nothing was deleted');
    assert.equal(await statusOf(foreign.id), 'active');

    // An administrator may clear it.
    const cleared = await harness.authed(founder, {
      method: 'DELETE',
      url: `/api/credentials/${own.credential.id}?clear_type=true`,
    });
    assert.equal(cleared.statusCode, 200, cleared.body);
    assert.equal(livePasswords(user).length, 0);
    assert.equal(await statusOf(own.credential.id), 'revoked');
    assert.equal(await statusOf(foreign.id), 'revoked');
  });

  it('keeps a plain last revoke from sweeping another account’s retiring row', async () => {
    const user = await client();
    const other = await client();
    const own = await issue(user);
    const foreign = await harness.store.credentials.create({
      user_id: other.user.id,
      application_id: null,
      ferrum_consumer_id: own.credential.ferrum_consumer_id,
      credential_type: 'basicauth',
      ferrum_credential_id: `${own.credential.ferrum_consumer_id}/credentials/basicauth`,
      fingerprint: `test-foreign-retiring-row-${nonce}`,
      last4: 'frgn',
      label: null,
      status: 'retiring',
      rotated_from_id: null,
    });

    const refused = await revoke(user, own.credential.id);
    assert.equal(refused.statusCode, 403, refused.body);
    assert.equal(authenticates(user, own), true, 'nothing was deleted');
    assert.equal(await statusOf(own.credential.id), 'active');
    assert.equal(await statusOf(foreign.id), 'retiring');
  });
});

/* ── The upgrade scan: appends an earlier release left without a row ───── */

describe('legacy basicauth append scan', () => {
  const SCAN_SETTING = 'credentials.legacy_basicauth_scan_v1';
  let harness: TestApp;
  let founder: TestSession;
  let nonce = 0;

  before(async () => {
    // Room for three rows, so a v0.2.0 orphan fits beside two tracked ones.
    harness = await buildTestApp({ env: { FERRUM_MAX_CREDENTIALS_PER_TYPE: '3' } });
    founder = await harness.registerUser({ email: 'basic-legacy-founder@example.test' });
  });

  after(async () => {
    await harness.close();
  });

  async function client(): Promise<TestSession> {
    nonce += 1;
    return harness.registerUser({ email: `basic-legacy-${nonce}@example.test`, role: 'client' });
  }

  async function issue(actor: TestSession): Promise<IssueCredentialResponse['credential']> {
    const response = await harness.authed(actor, {
      method: 'POST',
      url: '/api/credentials',
      payload: { credential_type: 'basicauth' },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<IssueCredentialResponse>().credential;
  }

  function revoke(actor: TestSession, credentialId: string, clearType = false) {
    return harness.authed(actor, {
      method: 'DELETE',
      url: `/api/credentials/${credentialId}${clearType ? '?clear_type=true' : ''}`,
    });
  }

  function gatewayEntries(actor: TestSession): Record<string, unknown>[] {
    const consumer = harness.edge.consumerByUsername(consumerUsernameForUser(actor.user.id));
    return consumer?.credentials.basicauth ?? [];
  }

  async function rowsOf(actor: TestSession): Promise<CredentialRecord[]> {
    const page = await harness.store.credentials.list(
      { user_id: actor.user.id, credential_type: 'basicauth' },
      { limit: 50 },
    );
    return page.items;
  }

  async function statusOf(credentialId: string): Promise<string | undefined> {
    return (await harness.store.credentials.findById(credentialId))?.status;
  }

  /**
   * What `v0.2.0` wrote for a `basicauth` append it could not record: the
   * lost-acknowledgement path, which names no row, so `stranded_credential_id`
   * is absent. Dated in the past so any real audit row written afterwards
   * sorts strictly later.
   */
  async function seedLegacyOrphan(
    actor: TestSession,
    consumerId: string,
    extra: Record<string, unknown> = {},
  ) {
    return harness.store.auditLogs.create({
      actor_user_id: actor.user.id,
      actor_role: actor.user.role,
      action: 'credential.append_rollback',
      target_type: 'consumer',
      target_id: consumerId,
      details: {
        credential_type: 'basicauth',
        consumer_id: consumerId,
        operation: 'issue',
        withdrawn: false,
        last4: 'lgcy',
        append_index: 0,
        owner_user_id: actor.user.id,
        suspected: true,
        cause: 'The gateway rejected the request',
        ...extra,
      },
      ip: null,
      created_at: new Date(Date.now() - 60_000).toISOString(),
    });
  }

  async function rescan(): Promise<void> {
    await harness.store.settings.delete(SCAN_SETTING);
    await harness.services.credentials.initializeLegacyBasicAuthPositions();
  }

  async function placeholdersFor(eventId: string) {
    const rows = await harness.auditRows('credential.legacy_placeholder');
    return rows.filter((row) => row.details.source_event_id === eventId);
  }

  it('holds an orphan v0.2.0 recorded without a row until the type is cleared', async () => {
    const user = await client();
    const first = await issue(user);
    const second = await issue(user);
    const consumerId = first.ferrum_consumer_id;
    // The orphan itself: an entry on the gateway that no row accounts for.
    gatewayEntries(user).unshift({ password: 'an-entry-v0.2.0-appended-without-a-row' });
    const event = await seedLegacyOrphan(user, consumerId);

    await rescan();
    assert.deepEqual((await harness.store.settings.get(SCAN_SETTING))?.value, {
      completed: true,
    });
    assert.equal(harness.services.credentials.legacyBasicAuthScanState(), 'completed');

    const placeholder = (await rowsOf(user)).find(
      (row) => row.id !== first.id && row.id !== second.id,
    );
    assert.ok(placeholder, 'the orphan now has a row');
    assert.equal(placeholder.status, 'retiring');
    assert.equal(placeholder.ferrum_consumer_id, consumerId);
    assert.equal(placeholder.application_id, null, 'the account identity, from its mapping');
    assert.equal(placeholder.last4, 'lgcy');
    const [audited, ...more] = await placeholdersFor(event.id);
    assert.ok(audited, 'the placeholder is audited');
    assert.equal(more.length, 0);
    assert.equal(audited.target_id, placeholder.id);
    assert.equal(audited.details.consumer_id, consumerId);

    // The report's positional revoke would now delete the orphan instead.
    const refused = await revoke(user, first.id);
    assert.equal(refused.statusCode, 409, refused.body);
    assert.equal(errorOf(refused.body).code, 'CONFLICT');
    assert.match(errorOf(refused.body).message, /clear_type=true/);
    assert.equal(gatewayEntries(user).length, 3, 'nothing was deleted');
    assert.equal(await statusOf(first.id), 'active');

    // A repeated scan writes nothing new.
    await rescan();
    assert.equal((await placeholdersFor(event.id)).length, 1);
    assert.equal((await rowsOf(user)).length, 3);

    // The owner's explicit clear removes the orphan with everything else.
    const cleared = await revoke(user, second.id, true);
    assert.equal(cleared.statusCode, 200, cleared.body);
    assert.equal(gatewayEntries(user).length, 0);
    for (const row of await rowsOf(user)) assert.equal(row.status, 'revoked');

    // A scan after the clear leaves the settled placeholder alone.
    await rescan();
    assert.equal((await placeholdersFor(event.id)).length, 1);
    assert.equal(await statusOf(placeholder.id), 'revoked');
  });

  it('also holds an orphan whose stranded row is no longer live', async () => {
    const user = await client();
    const kept = await issue(user);
    const gone = await issue(user);
    await harness.store.credentials.update(gone.id, { status: 'revoked' });
    const event = await seedLegacyOrphan(user, kept.ferrum_consumer_id, {
      operation: 'rotate',
      stranded_credential_id: gone.id,
    });

    await rescan();
    assert.equal((await placeholdersFor(event.id)).length, 1);
    const refused = await harness.authed(user, {
      method: 'POST',
      url: '/api/credentials',
      payload: { credential_type: 'basicauth' },
    });
    assert.equal(refused.statusCode, 409, refused.body);
  });

  it('leaves an orphan alone while the row that names it is still live', async () => {
    const user = await client();
    const live = await issue(user);
    const event = await seedLegacyOrphan(user, live.ferrum_consumer_id, {
      operation: 'rotate',
      stranded_credential_id: live.id,
    });

    await rescan();
    assert.equal((await placeholdersFor(event.id)).length, 0);
    assert.equal((await rowsOf(user)).length, 1);
  });

  it('skips an orphan a later reconcile already cleared', async () => {
    const user = await client();
    const credential = await issue(user);
    const consumerId = credential.ferrum_consumer_id;
    const event = await seedLegacyOrphan(user, consumerId);

    const reconciled = await harness.authed(founder, {
      method: 'POST',
      url: '/api/admin/credentials/reconcile',
      payload: { consumer_id: consumerId, credential_type: 'basicauth', reason: 'legacy orphan' },
    });
    assert.equal(reconciled.statusCode, 200, reconciled.body);

    await rescan();
    assert.equal((await placeholdersFor(event.id)).length, 0);
    assert.equal((await rowsOf(user)).filter((row) => row.status !== 'revoked').length, 0);
  });

  it('skips an orphan a later whole-type revoke already cleared', async () => {
    const user = await client();
    const only = await issue(user);
    const event = await seedLegacyOrphan(user, only.ferrum_consumer_id);

    // The only active credential: its revoke empties the type.
    const revoked = await revoke(user, only.id);
    assert.equal(revoked.statusCode, 200, revoked.body);

    await rescan();
    assert.equal((await placeholdersFor(event.id)).length, 0);
    const fresh = await issue(user);
    assert.equal(fresh.status, 'active', 'issuing is not held');
  });

  it('keeps no completion marker when the scan fails, and completes on a retry', async () => {
    const user = await client();
    const credential = await issue(user);
    const event = await seedLegacyOrphan(user, credential.ferrum_consumer_id);
    await harness.store.settings.delete(SCAN_SETTING);

    const list = harness.store.auditLogs.list;
    harness.store.auditLogs.list = async () => {
      harness.store.auditLogs.list = list;
      throw new Error('injected audit read failure');
    };
    await assert.rejects(harness.services.credentials.initializeLegacyBasicAuthPositions());
    assert.equal(harness.services.credentials.legacyBasicAuthScanState(), 'failed');
    assert.equal(await harness.store.settings.get(SCAN_SETTING), null);

    await harness.services.credentials.initializeLegacyBasicAuthPositions();
    assert.equal(harness.services.credentials.legacyBasicAuthScanState(), 'completed');
    assert.equal((await placeholdersFor(event.id)).length, 1);
  });
});
