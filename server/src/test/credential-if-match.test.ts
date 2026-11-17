/**
 * Positional credential changes are conditioned on the read they were decided
 * from (ferrum-edge#7393).
 *
 * Edge gives credential entries no id and redacts them on every read, so a
 * revoke or rotation addresses an entry by its index in the array Nexus read.
 * The portal's consumer lease keeps its own writers out of that window, but not
 * another writer on the gateway: an operator, Foundry or automation that adds
 * or removes an entry between the read and `DELETE .../{type}/{index}` moves
 * the index onto a different credential, which the delete then removed while
 * the requested one kept working.
 *
 * Every such write now carries the consumer `ETag` of that read as `If-Match`.
 * Edge with ferrum-edge#7393 refuses a changed consumer with `412`; Edge
 * v0.9.20, the pinned release, refuses the header with `400`, and Nexus then
 * re-reads the consumer and writes without it only if the tag is unchanged.
 * Both gateways are covered here. A refusal deletes and appends nothing, is not
 * retried, and leaves the credential's row `active`.
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

describe('credential writes conditioned on the consumer tag', () => {
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

  /** Another writer removes one credential from the consumer, outside the portal's lease. */
  function removeKey(consumerId: string, issued: IssueCredentialResponse): void {
    const stored = harness.edge.consumers.get(`nexus/${consumerId}`);
    assert.ok(stored);
    const entries = stored.credentials.keyauth ?? [];
    stored.credentials.keyauth = entries.filter((entry) => entry.key !== issued.secret.key);
    stored.updated_at = new Date(Date.now() + 60_000).toISOString();
  }

  /** Run `change` right after the next tagged read of `consumerId` the portal makes. */
  function afterNextTaggedRead(consumerId: string, change: () => void): void {
    const consumers = harness.edgeClient.consumers;
    const getTagged = consumers.getTagged.bind(consumers);
    consumers.getTagged = async (id, options) => {
      const read = await getTagged(id, options);
      if (id === consumerId) {
        consumers.getTagged = getTagged;
        change();
      }
      return read;
    };
    restore = () => {
      consumers.getTagged = getTagged;
    };
  }

  async function statusOf(credentialId: string): Promise<string | undefined> {
    return (await harness.store.credentials.findById(credentialId))?.status;
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

  function credentialWrites(consumerId: string, method: 'POST' | 'DELETE') {
    return harness.edge.callsTo(method, `/consumers/${consumerId}/credentials/keyauth`);
  }

  for (const mode of ['evaluate', 'unsupported'] as const) {
    const gateway = mode === 'evaluate' ? 'Edge with #7393' : 'Edge v0.9.20';

    it(`${gateway}: a revoke deletes nothing once the consumer changed`, async () => {
      harness.edge.setCredentialIfMatch(mode);
      const user = await client();
      const first = await issue(user);
      const second = await issue(user);
      const consumerId = second.credential.ferrum_consumer_id;

      // Index 1 is `second` in the array the portal read, and `first` once
      // the other writer's key lands in front of it.
      afterNextTaggedRead(consumerId, () => prependForeignKey(consumerId));
      const refused = await revoke(user, second.credential.id);
      assert.equal(refused.statusCode, 409, refused.body);
      assert.equal(errorOf(refused.body).code, 'CONFLICT');

      const labels = labelled(consumerId, { foreign: FOREIGN_KEY, first, second });
      assert.deepEqual(labels, ['foreign', 'first', 'second']);
      assert.equal(await statusOf(second.credential.id), 'active', 'the intent was withdrawn');
      assert.equal(await statusOf(first.credential.id), 'active');
      assert.equal(credentialWrites(consumerId, 'DELETE').length, 1, 'never resent');
    });

    it(`${gateway}: a rotation appends nothing once the consumer changed`, async () => {
      harness.edge.setCredentialIfMatch(mode);
      const user = await client();
      const only = await issue(user);
      const consumerId = only.credential.ferrum_consumer_id;
      const appendsBefore = credentialWrites(consumerId, 'POST').length;

      // Below the cap: the append comes first and is conditioned on the read.
      afterNextTaggedRead(consumerId, () => prependForeignKey(consumerId));
      const refused = await rotate(user, only.credential.id);
      assert.equal(refused.statusCode, 409, refused.body);
      assert.equal(errorOf(refused.body).code, 'CONFLICT');
      assert.ok(!('secret' in JSON.parse(refused.body)), 'no secret was handed out');

      assert.deepEqual(labelled(consumerId, { foreign: FOREIGN_KEY, only }), ['foreign', 'only']);
      assert.equal(await statusOf(only.credential.id), 'active');
      assert.equal(credentialWrites(consumerId, 'POST').length, appendsBefore + 1);
      assert.equal(credentialWrites(consumerId, 'DELETE').length, 0);
    });

    it(`${gateway}: a capped rotation deletes nothing once the consumer changed`, async () => {
      harness.edge.setCredentialIfMatch(mode);
      const user = await client();
      const first = await issue(user);
      const second = await issue(user);
      const consumerId = first.credential.ferrum_consumer_id;
      const appendsBefore = credentialWrites(consumerId, 'POST').length;

      // At the cap the old entry is deleted first, by the index of the read.
      afterNextTaggedRead(consumerId, () => prependForeignKey(consumerId));
      const refused = await rotate(user, second.credential.id);
      assert.equal(refused.statusCode, 409, refused.body);
      assert.equal(errorOf(refused.body).code, 'CONFLICT');

      const labels = labelled(consumerId, { foreign: FOREIGN_KEY, first, second });
      assert.deepEqual(labels, ['foreign', 'first', 'second']);
      assert.equal(await statusOf(second.credential.id), 'active', 'the intent was withdrawn');
      assert.equal(credentialWrites(consumerId, 'POST').length, appendsBefore, 'no append');
      assert.equal(credentialWrites(consumerId, 'DELETE').length, 1, 'never resent');
    });

    it(`${gateway}: an unchanged consumer is revoked and rotated as before`, async () => {
      harness.edge.setCredentialIfMatch(mode);
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
      assert.equal(await statusOf(second.credential.id), 'revoked');

      // Every positional write carried the tag of the read it came from.
      const deletes = credentialWrites(consumerId, 'DELETE');
      const conditioned = deletes.filter((call) => call.ifMatch !== undefined);
      if (mode === 'evaluate') {
        assert.equal(conditioned.length, deletes.length);
      } else {
        // Each was refused for its header once, then sent without it.
        assert.equal(conditioned.length * 2, deletes.length);
      }
    });
  }

  for (const mode of ['evaluate', 'unsupported'] as const) {
    const gateway = mode === 'evaluate' ? 'Edge with #7393' : 'Edge v0.9.20';

    it(`${gateway}: a refused clear keeps an earlier unconfirmed retirement (sol F1)`, async () => {
      const user = await client();
      const first = await issue(user, 'basicauth');
      const second = await issue(user, 'basicauth');
      const consumerId = first.credential.ferrum_consumer_id;
      const passwords = (): number =>
        harness.edge.consumers.get(`nexus/${consumerId}`)?.credentials.basicauth?.length ?? 0;

      // Edge removes the first password and the answer is lost: the row is
      // `retiring`, an outcome nobody confirmed.
      harness.edge.queueLostAck(503, { error: 'timeout' }, '/credentials/basicauth/', 'DELETE');
      const lost = await revoke(user, first.credential.id);
      assert.equal(lost.statusCode, 502, lost.body);
      assert.equal(await statusOf(first.credential.id), 'retiring');
      assert.equal(passwords(), 1);

      // The clear is refused because another writer changed the consumer.
      harness.edge.setCredentialIfMatch(mode);
      afterNextTaggedRead(consumerId, () => {
        const stored = harness.edge.consumers.get(`nexus/${consumerId}`);
        assert.ok(stored);
        stored.acl_groups = [...stored.acl_groups, 'operator-group'];
        stored.updated_at = new Date(Date.now() + 60_000).toISOString();
      });
      const refused = await harness.authed(user, {
        method: 'DELETE',
        url: `/api/credentials/${first.credential.id}?clear_type=true`,
      });
      assert.equal(refused.statusCode, 409, refused.body);
      assert.equal(errorOf(refused.body).code, 'CONFLICT');

      // The refusal proves only that this delete did not run, not that the
      // earlier one did not: promoting the row would let a later positional
      // revoke of it land on the second password.
      assert.equal(await statusOf(first.credential.id), 'retiring');
      assert.equal(await statusOf(second.credential.id), 'active');
      assert.equal(passwords(), 1);
    });
  }

  for (const mode of ['evaluate', 'unsupported'] as const) {
    const gateway = mode === 'evaluate' ? 'Edge with #7393' : 'Edge v0.9.20';

    it(`${gateway}: a revoke refused because its entry was removed stays retiring`, async () => {
      harness.edge.setCredentialIfMatch(mode);
      const user = await client();
      const first = await issue(user);
      const second = await issue(user);
      const consumerId = first.credential.ferrum_consumer_id;

      // Another writer removes the very credential being revoked after the
      // portal's read: the delete is refused, but the entry is gone, so the
      // row must not claim it is live again (review dsf round 3).
      afterNextTaggedRead(consumerId, () => removeKey(consumerId, first));
      const refused = await revoke(user, first.credential.id);
      assert.equal(refused.statusCode, 409, refused.body);
      assert.deepEqual(labelled(consumerId, { first, second }), ['second']);
      assert.equal(await statusOf(first.credential.id), 'retiring', 'not reactivated');

      // The next call on the pair settles it to what the gateway says.
      const next = await revoke(user, second.credential.id);
      assert.equal(next.statusCode, 200, next.body);
      assert.equal(await statusOf(first.credential.id), 'revoked');
      assert.equal(await statusOf(second.credential.id), 'revoked');
      assert.deepEqual(labelled(consumerId, { first, second }), []);
    });

    it(`${gateway}: a refused capped rotation of a removed entry stays retiring`, async () => {
      harness.edge.setCredentialIfMatch(mode);
      const user = await client();
      const first = await issue(user);
      const second = await issue(user);
      const consumerId = first.credential.ferrum_consumer_id;
      const appendsBefore = credentialWrites(consumerId, 'POST').length;

      afterNextTaggedRead(consumerId, () => removeKey(consumerId, second));
      const refused = await rotate(user, second.credential.id);
      assert.equal(refused.statusCode, 409, refused.body);
      assert.deepEqual(labelled(consumerId, { first, second }), ['first']);
      assert.equal(await statusOf(second.credential.id), 'retiring', 'not reactivated');
      assert.equal(credentialWrites(consumerId, 'POST').length, appendsBefore, 'no append');
    });
  }

  it('a rotation whose previous key another writer removed does not reactivate it', async () => {
    const user = await client();
    const only = await issue(user);
    const consumerId = only.credential.ferrum_consumer_id;

    // Below the cap: the replacement lands, then another writer removes the
    // previous key before the rotation's fresh read.
    const consumers = harness.edgeClient.consumers;
    const addCredential = consumers.addCredential.bind(consumers);
    consumers.addCredential = async (...args) => {
      consumers.addCredential = addCredential;
      const written = await addCredential(...args);
      removeKey(consumerId, only);
      return written;
    };
    restore = () => {
      consumers.addCredential = addCredential;
    };

    const failed = await rotate(user, only.credential.id);
    assert.equal(failed.statusCode, 502, failed.body);
    assert.ok(!('secret' in JSON.parse(failed.body)), 'no secret was handed out');

    // The previous key is gone, so its row is not reactivated, and the
    // replacement is left as the pair's only entry for its owner to revoke.
    assert.equal(await statusOf(only.credential.id), 'retiring', 'not reactivated');
    const stored = harness.edge.consumers.get(`nexus/${consumerId}`);
    assert.equal(stored?.credentials.keyauth?.length, 1);
    assert.equal(credentialWrites(consumerId, 'DELETE').length, 0, 'nothing was deleted');
  });

  it('refuses a revoke or rotation decided from an untagged read (dsf F1)', async () => {
    const user = await client();
    const first = await issue(user);
    const second = await issue(user);
    const consumerId = first.credential.ferrum_consumer_id;
    const appendsBefore = credentialWrites(consumerId, 'POST').length;

    // Edge's cached fallback after a failed store read issues no tag.
    harness.edge.setConsumerTagIssued(false);
    const revoked = await revoke(user, first.credential.id);
    assert.equal(revoked.statusCode, 502, revoked.body);
    assert.equal(errorOf(revoked.body).code, 'EDGE_ERROR');
    const rotated = await rotate(user, second.credential.id);
    assert.equal(rotated.statusCode, 502, rotated.body);
    assert.ok(!('secret' in JSON.parse(rotated.body)), 'no secret was handed out');

    assert.equal(credentialWrites(consumerId, 'DELETE').length, 0, 'nothing was deleted');
    assert.equal(credentialWrites(consumerId, 'POST').length, appendsBefore, 'nothing appended');
    assert.deepEqual(labelled(consumerId, { first, second }), ['first', 'second']);
    assert.equal(await statusOf(first.credential.id), 'active');
    assert.equal(await statusOf(second.credential.id), 'active');
  });

  it('Edge v0.9.20: a failed re-read reclaims nothing (sol F2)', async () => {
    harness.edge.setCredentialIfMatch('unsupported');
    const user = await client();
    const only = await issue(user);
    const consumerId = only.credential.ferrum_consumer_id;
    const appendsBefore = credentialWrites(consumerId, 'POST').length;

    // Another writer appends a key after the rotation's read, so the array
    // has exactly the length the rotation's own append would have left; then
    // the fallback's re-read of the consumer fails. Nothing of the rotation's
    // was appended, so nothing may be taken back: a reclaim would read the
    // other writer's key as the rotation's and delete it.
    afterNextTaggedRead(consumerId, () => {
      const stored = harness.edge.consumers.get(`nexus/${consumerId}`);
      assert.ok(stored);
      stored.credentials.keyauth = [...(stored.credentials.keyauth ?? []), { key: FOREIGN_KEY }];
      stored.updated_at = new Date(Date.now() + 60_000).toISOString();
      harness.edge.queueFailure(503, { error: 'unavailable' }, `/consumers/${consumerId}`, 'GET');
    });
    const failed = await rotate(user, only.credential.id);
    assert.equal(failed.statusCode, 502, failed.body);
    assert.ok(!('secret' in JSON.parse(failed.body)), 'no secret was handed out');

    assert.deepEqual(labelled(consumerId, { foreign: FOREIGN_KEY, only }), ['only', 'foreign']);
    assert.equal(await statusOf(only.credential.id), 'active');
    assert.equal(credentialWrites(consumerId, 'POST').length, appendsBefore + 1);
    assert.equal(credentialWrites(consumerId, 'DELETE').length, 0, 'nothing was taken back');
  });

  it('a rotation keeps the previous key when its fresh read shows another change', async () => {
    const user = await client();
    const only = await issue(user);
    const consumerId = only.credential.ferrum_consumer_id;

    // Another writer adds a key right after the rotation's own append lands,
    // so the array is no longer the one the append left.
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

    const failed = await rotate(user, only.credential.id);
    assert.equal(failed.statusCode, 409, failed.body);
    assert.equal(errorOf(failed.body).code, 'CONFLICT');
    assert.ok(!('secret' in JSON.parse(failed.body)), 'no secret was handed out');

    // The previous key was never deleted, and the replacement was taken back
    // by its identity, not by the position the other writer moved.
    assert.deepEqual(labelled(consumerId, { foreign: FOREIGN_KEY, only }), ['foreign', 'only']);
    assert.equal(await statusOf(only.credential.id), 'active');
    assert.equal(credentialWrites(consumerId, 'DELETE').length, 1, 'only the take-back');
  });

  it('takes nothing back after Edge certainly refused the append (dsf round 2)', async () => {
    const user = await client();
    const only = await issue(user);
    const consumerId = only.credential.ferrum_consumer_id;

    // Another writer appends right after the portal's read, filling the type
    // to the gateway's cap of two: Edge refuses the portal's append with a
    // definite `400`. The array is now exactly one entry longer than the
    // index the append was given, so a positional take-back would delete the
    // other writer's key.
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
    assert.notEqual(refused.statusCode, 201, refused.body);
    assert.ok(!('secret' in JSON.parse(refused.body)), 'no secret was handed out');

    assert.deepEqual(labelled(consumerId, { foreign: FOREIGN_KEY, only }), ['only', 'foreign']);
    assert.equal(credentialWrites(consumerId, 'DELETE').length, 0, 'nothing was taken back');
    assert.equal(
      harness.edge.callsTo('GET', `/consumers/${consumerId}/verification`).length,
      0,
      'nothing was even looked for',
    );
    const rollback = (await harness.auditRows('credential.append_rollback')).filter(
      (row) => row.details.consumer_id === consumerId,
    );
    assert.equal(rollback.length, 0);
  });
});
