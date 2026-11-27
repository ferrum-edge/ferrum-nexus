/**
 * Credential deletes are conditioned on the read they were decided from
 * (ferrum-edge#7393), and that read is the one the target was located in
 * (issue #737).
 *
 * Edge gives credential entries no id, so a revoke or rotation addresses an
 * entry by its index. The portal's consumer lease keeps its own writers out,
 * but not another writer on the gateway: an operator, Foundry or automation
 * that adds or removes an entry between the read and `DELETE
 * .../{type}/{index}` moves the index onto a different credential.
 *
 * So a `keyauth` or `jwt` delete is decided from a credential-complete read
 * that locates the target by its material, and carries that read's consumer
 * `ETag` as `If-Match`. Edge v0.9.21 (ferrum-edge#7393) refuses a changed
 * consumer with `412`. An older Edge refuses the header itself with `400`;
 * Nexus treats that as a definite non-write naming the release it requires
 * and never sends the delete without the tag. A refusal is never resent; the
 * row follows what a fresh read shows, and a retry locates the entry afresh.
 * `credential-interleaving.test.ts` explores every interleaving.
 *
 * Secrets are compared by label, never printed.
 */

import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';

import type {
  ApiErrorBody,
  CredentialType,
  IssueCredentialResponse,
  RotateCredentialResponse,
  ShowOnceSecret,
} from '@ferrum-nexus/shared';

import { buildTestApp, type TestApp, type TestSession } from './helpers.js';

const FOREIGN_KEY = 'key-another-writer-added-by-hand';

function errorOf(body: string): ApiErrorBody['error'] {
  return (JSON.parse(body) as ApiErrorBody).error;
}

describe('credential deletes conditioned on the consumer tag', () => {
  let harness: TestApp;
  let restore: (() => void) | null = null;

  before(async () => {
    harness = await buildTestApp();
    await harness.registerUser({ email: 'if-match-founder@example.test' });
  });

  afterEach(() => {
    restore?.();
    restore = null;
    harness.edge.setCredentialIfMatch('evaluate');
    harness.edge.setConsumerTagIssued(true);
    harness.edge.clearInjections();
  });

  after(async () => {
    await harness.close();
  });

  let nonce = 0;
  async function client(): Promise<TestSession> {
    nonce += 1;
    return harness.registerUser({ email: `if-match-${nonce}@example.test`, role: 'client' });
  }

  async function issue(
    session: TestSession,
    type: CredentialType = 'keyauth',
  ): Promise<IssueCredentialResponse> {
    const response = await harness.authed(session, {
      method: 'POST',
      url: '/api/credentials',
      payload: { credential_type: type },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<IssueCredentialResponse>();
  }

  /** The keys live on the consumer, as labels: never the secrets themselves. */
  function labelled(
    consumerId: string,
    labels: Record<string, string | { secret: ShowOnceSecret }>,
  ): string[] {
    const stored = harness.edge.consumers.get(`nexus/${consumerId}`);
    return (stored?.credentials.keyauth ?? []).map((entry) => {
      for (const [label, source] of Object.entries(labels)) {
        const key = typeof source === 'string' ? source : source.secret.key;
        if (entry.key === key) return label;
      }
      return 'unknown';
    });
  }

  /** Another writer puts a key in front of the consumer's array, outside the portal's lease. */
  function prependForeignKey(consumerId: string): void {
    const stored = harness.edge.consumers.get(`nexus/${consumerId}`);
    assert.ok(stored);
    stored.credentials.keyauth = [{ key: FOREIGN_KEY }, ...(stored.credentials.keyauth ?? [])];
    stored.updated_at = new Date(Date.now() + 60_000).toISOString();
  }

  /**
   * Run `change` right after the next credential-complete read of
   * `consumerId` the portal makes: the read a `keyauth` delete is decided
   * from.
   */
  function afterNextIdentityRead(consumerId: string, change: () => void): void {
    const consumers = harness.edgeClient.consumers;
    const verification = consumers.verification.bind(consumers);
    consumers.verification = async (id, subject) => {
      const read = await verification(id, subject);
      if (id === consumerId) {
        consumers.verification = verification;
        change();
      }
      return read;
    };
    restore = () => {
      consumers.verification = verification;
    };
  }

  function revoke(session: TestSession, credentialId: string) {
    return harness.authed(session, { method: 'DELETE', url: `/api/credentials/${credentialId}` });
  }

  function rotate(session: TestSession, credentialId: string) {
    return harness.authed(session, {
      method: 'POST',
      url: `/api/credentials/${credentialId}/rotate`,
      payload: {},
    });
  }

  async function statusOf(credentialId: string): Promise<string | undefined> {
    return (await harness.store.credentials.findById(credentialId))?.status;
  }

  function credentialDeletes(consumerId: string) {
    return harness.edge.callsTo('DELETE', `/consumers/${consumerId}/credentials/keyauth`);
  }

  it('a revoke deletes nothing once the consumer changed', async () => {
    const user = await client();
    const first = await issue(user);
    const second = await issue(user);
    const consumerId = second.credential.ferrum_consumer_id;

    // Index 1 is `second` in the array the portal read, and `first` once
    // the other writer's key lands in front of it.
    afterNextIdentityRead(consumerId, () => prependForeignKey(consumerId));
    const refused = await revoke(user, second.credential.id);
    assert.equal(refused.statusCode, 409, refused.body);
    assert.equal(errorOf(refused.body).code, 'CONFLICT');

    const labels = labelled(consumerId, { foreign: FOREIGN_KEY, first, second });
    assert.deepEqual(labels, ['foreign', 'first', 'second'], 'nothing was deleted');
    // One refused delete, never resent.
    assert.equal(credentialDeletes(consumerId).length, 1);
    // A fresh read still holds the entry, so the retirement is withdrawn.
    assert.equal(await statusOf(second.credential.id), 'active');

    // The retry locates `second` afresh — at index 2 now — and deletes it.
    const retried = await revoke(user, second.credential.id);
    assert.equal(retried.statusCode, 200, retried.body);
    const after = labelled(consumerId, { foreign: FOREIGN_KEY, first, second });
    assert.deepEqual(after, ['foreign', 'first']);
    assert.equal(await statusOf(second.credential.id), 'revoked');
    assert.equal(await statusOf(first.credential.id), 'active');
  });

  it('an unchanged consumer is revoked and rotated as before', async () => {
    const user = await client();
    const first = await issue(user);
    const second = await issue(user);
    const consumerId = first.credential.ferrum_consumer_id;

    const revoked = await revoke(user, first.credential.id);
    assert.equal(revoked.statusCode, 200, revoked.body);
    assert.deepEqual(labelled(consumerId, { first, second }), ['second']);

    const rotated = await rotate(user, second.credential.id);
    assert.equal(rotated.statusCode, 200, rotated.body);
    const body = rotated.json<RotateCredentialResponse>();
    const replacement = { secret: body.secret };
    assert.deepEqual(labelled(consumerId, { second, replacement }), ['replacement']);

    // Every delete carried the tag of the read it came from.
    const deletes = credentialDeletes(consumerId);
    assert.ok(deletes.length > 0);
    assert.ok(deletes.every((call) => call.ifMatch !== undefined));
  });

  it('an Edge older than v0.9.21 deletes nothing and keeps the credential', async () => {
    // Edge v0.9.20 and earlier refuse `If-Match` on credential routes from
    // their router, before acting (ferrum-edge#7393).
    harness.edge.setCredentialIfMatch('unsupported');
    const user = await client();
    const first = await issue(user);
    const second = await issue(user);
    const consumerId = first.credential.ferrum_consumer_id;

    const refused = await revoke(user, first.credential.id);
    assert.equal(refused.statusCode, 502, refused.body);
    const error = errorOf(refused.body);
    assert.equal(error.code, 'EDGE_ERROR');
    assert.match(error.message, /requires Ferrum Edge v0\.9\.21 or later/);

    const deletes = credentialDeletes(consumerId);
    assert.equal(deletes.length, 1, 'one conditional attempt, never resent');
    assert.ok(
      deletes.every((call) => call.ifMatch !== undefined),
      'never sent without the tag',
    );
    assert.deepEqual(labelled(consumerId, { first, second }), ['first', 'second']);
    assert.equal(await statusOf(first.credential.id), 'active');
    assert.equal(await statusOf(second.credential.id), 'active');
  });

  it('a rotation whose consumer moved after its append deletes only the previous key', async () => {
    const user = await client();
    const only = await issue(user);
    const consumerId = only.credential.ferrum_consumer_id;

    // Below the cap the replacement is appended first. Another writer then
    // puts a key in front, so the index the decision read gave the
    // previous key (0) now names the foreign one. The previous key is
    // located again by its material, in a read the delete is conditioned
    // on (issue #737).
    const consumers = harness.edgeClient.consumers;
    const addCredential = consumers.addCredential.bind(consumers);
    consumers.addCredential = async (...args) => {
      consumers.addCredential = addCredential;
      const written = await addCredential(...args);
      prependForeignKey(consumerId);
      return written;
    };
    restore = () => {
      consumers.addCredential = addCredential;
    };

    const rotated = await rotate(user, only.credential.id);
    assert.equal(rotated.statusCode, 200, rotated.body);
    const replacement = { secret: rotated.json<RotateCredentialResponse>().secret };
    assert.deepEqual(labelled(consumerId, { foreign: FOREIGN_KEY, only, replacement }), [
      'foreign',
      'replacement',
    ]);
    assert.equal(await statusOf(only.credential.id), 'revoked');
  });

  for (const type of ['keyauth', 'jwt'] as const) {
    it(`a ${type} rotation whose replacement another writer removed keeps the previous credential`, async () => {
      const user = await client();
      const only = await issue(user, type);
      const consumerId = only.credential.ferrum_consumer_id;
      const field = type === 'keyauth' ? 'key' : 'secret';
      const material = (entry: Record<string, unknown>): unknown => entry[field];
      const previous = type === 'keyauth' ? only.secret.key : only.secret.jwt_secret;

      // Below the cap the replacement is appended first. Another writer
      // removes it before Nexus reads the consumer again, so retiring the
      // previous credential would leave the identity holding a dead secret
      // (review sol F1, dsf F1 on #739).
      const consumers = harness.edgeClient.consumers;
      const addCredential = consumers.addCredential.bind(consumers);
      consumers.addCredential = async (id, credentialType, entry, subject, ifMatch) => {
        consumers.addCredential = addCredential;
        const written = await addCredential(id, credentialType, entry, subject, ifMatch);
        const stored = harness.edge.consumers.get(`nexus/${consumerId}`);
        assert.ok(stored);
        const appended = (entry as unknown as Record<string, unknown>)[field];
        stored.credentials[type] = (stored.credentials[type] ?? []).filter(
          (candidate) => material(candidate) !== appended,
        );
        return written;
      };
      restore = () => {
        consumers.addCredential = addCredential;
      };

      const refused = await rotate(user, only.credential.id);
      assert.equal(refused.statusCode, 409, refused.body);
      assert.equal(errorOf(refused.body).code, 'CONFLICT');
      assert.ok(!('secret' in JSON.parse(refused.body)), 'no dead secret was handed out');

      const stored = harness.edge.consumers.get(`nexus/${consumerId}`);
      assert.deepEqual(
        (stored?.credentials[type] ?? []).map(material),
        [previous],
        'the working credential was not deleted',
      );
      assert.equal(await statusOf(only.credential.id), 'active');
      const rows = await harness.store.credentials.list({ user_id: user.user.id });
      assert.equal(rows.total, 1, 'the replacement that is gone left no row behind');
      // The withdrawn retirement is on the record (review dsf F2 on #739).
      const rollback = (await harness.auditRows('credential.revoke_rollback')).filter(
        (row) => row.target_id === only.credential.id,
      );
      assert.equal(rollback.length, 1);
      assert.equal(rollback[0]?.details.operation, 'rotate');
    });
  }

  it('an append Edge refused after another writer filled the cap takes nothing back', async () => {
    const user = await client();
    const only = await issue(user);
    const consumerId = only.credential.ferrum_consumer_id;
    const deletesBefore = credentialDeletes(consumerId).length;

    // The other writer's key lands just before the append, filling the
    // gateway's cap of two, so Edge refuses the append with a definite
    // `400`. Nothing was appended, so nothing is looked for or taken back:
    // the entry now at the append's index is the other writer's.
    const consumers = harness.edgeClient.consumers;
    const addCredential = consumers.addCredential.bind(consumers);
    consumers.addCredential = async (...args) => {
      consumers.addCredential = addCredential;
      const stored = harness.edge.consumers.get(`nexus/${consumerId}`);
      assert.ok(stored);
      stored.credentials.keyauth = [...(stored.credentials.keyauth ?? []), { key: FOREIGN_KEY }];
      return addCredential(...args);
    };
    restore = () => {
      consumers.addCredential = addCredential;
    };

    const refused = await harness.authed(user, {
      method: 'POST',
      url: '/api/credentials',
      payload: { credential_type: 'keyauth' },
    });
    assert.equal(refused.statusCode, 502, refused.body);
    assert.deepEqual(labelled(consumerId, { only, foreign: FOREIGN_KEY }), ['only', 'foreign']);
    assert.equal(credentialDeletes(consumerId).length, deletesBefore, 'nothing was deleted');
    const rollback = (await harness.auditRows('credential.append_rollback')).filter(
      (row) => row.details.consumer_id === consumerId,
    );
    assert.deepEqual(rollback, [], 'and nothing is recorded as an orphan');
  });

  it('refuses a basicauth revoke decided from a read without a strong tag', async () => {
    const user = await client();
    const first = await issue(user, 'basicauth');
    const second = await issue(user, 'basicauth');
    const consumerId = first.credential.ferrum_consumer_id;

    // `basicauth` is still placed from the tagged ordinary read, and Edge's
    // cached fallback after a failed store read issues no tag.
    harness.edge.setConsumerTagIssued(false);
    const refused = await revoke(user, first.credential.id);
    assert.equal(refused.statusCode, 502, refused.body);
    assert.equal(errorOf(refused.body).code, 'EDGE_ERROR');

    const deletes = harness.edge.callsTo(
      'DELETE',
      `/consumers/${consumerId}/credentials/basicauth`,
    );
    assert.equal(deletes.length, 0, 'nothing was deleted');
    const stored = harness.edge.consumers.get(`nexus/${consumerId}`);
    assert.equal(stored?.credentials.basicauth?.length, 2);
    assert.equal(await statusOf(first.credential.id), 'active');
    assert.equal(await statusOf(second.credential.id), 'active');
  });
});
