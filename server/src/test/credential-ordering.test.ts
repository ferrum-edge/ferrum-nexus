/**
 * Gateway credential positions follow the append ordinal, not the clock (#77).
 *
 * Edge addresses a consumer's credentials of one type only by array index, and
 * Nexus used to reconstruct that index by sorting metadata rows on `created_at`
 * then `id`. Two appends inside one millisecond therefore sorted by a random
 * UUID, and a clock stepped backwards between two appends put the later one
 * first — either way `DELETE /{type}/{index}` removed *another* live key while
 * the requested row was marked revoked. The report's probe: two keys, the
 * second stamped one millisecond earlier, `DELETE` of the first returns 200,
 * the first secret keeps working and the second is gone.
 *
 * These tests reproduce both clocks deterministically by shaping the metadata
 * row of an append — a chosen UUID, a chosen timestamp — without touching
 * anything the service itself does, then prove that revoking or rotating
 * either of the two credentials removes exactly the targeted secret from the
 * mock gateway, for every credential type, at the cap and through a failed
 * rotation. The second half covers rows that predate the ordinal: a lone one
 * is still addressable, two sharing a type are refused until an administrator
 * reconciles the consumer, and the account recovers afterwards.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  consumerUsernameForUser,
  type ApiErrorBody,
  type CredentialType,
  type IssueCredentialResponse,
  type ListCredentialsResponse,
  type ListNotificationsResponse,
  type ReconcileCredentialsResponse,
  type RotateCredentialResponse,
  type ShowOnceSecret,
} from '@ferrum-nexus/shared';

import type { CreateInput, CredentialRecord } from '../db/store.js';
import { buildTestApp, type TestApp, type TestSession } from './helpers.js';

const TYPES: readonly CredentialType[] = ['keyauth', 'basicauth', 'jwt'];

/** The field each type's Edge entry carries its material in. */
const ENTRY_FIELD: Record<CredentialType, string> = {
  keyauth: 'key',
  basicauth: 'password',
  jwt: 'secret',
};

/** The plaintext a show-once payload carries, for comparison with the gateway. */
function materialOf(secret: ShowOnceSecret): string {
  switch (secret.type) {
    case 'keyauth':
      return secret.key ?? '';
    case 'basicauth':
      return secret.password ?? '';
    case 'jwt':
      return secret.jwt_secret ?? '';
    default:
      return '';
  }
}

function errorOf(body: string): ApiErrorBody['error'] {
  return (JSON.parse(body) as ApiErrorBody).error;
}

/** How the metadata row of one append is stamped. */
interface RowShape {
  id?: string;
  created_at?: string;
  /** A row written before the ordinal existed whose order was not recoverable. */
  edge_ordinal?: null;
}

const STAMP = '2026-09-05T12:00:00.000Z';
const EARLIER = '2026-09-05T11:59:59.000Z';

/**
 * The two clocks from the report, as the row shapes of a first and a second
 * append. `nonce` keeps the chosen ids unique across users.
 */
const SKEWS: Record<string, (nonce: number) => [RowShape, RowShape]> = {
  'equal timestamps with the later id sorting first': (nonce) => [
    { id: `ffffffff-0000-4000-8000-${String(nonce).padStart(12, '0')}`, created_at: STAMP },
    { id: `00000000-0000-4000-8000-${String(nonce).padStart(12, '0')}`, created_at: STAMP },
  ],
  'a clock stepped backwards between the appends': () => [
    { created_at: STAMP },
    { created_at: EARLIER },
  ],
};

describe('credential positions follow the append ordinal', () => {
  let harness: TestApp;
  /** First account, therefore `super_admin`. */
  let founder: TestSession;
  let nonce = 0;

  before(async () => {
    harness = await buildTestApp();
    founder = await harness.registerUser({ email: 'ordinal-founder@example.test' });
  });

  after(async () => {
    await harness.close();
  });

  async function client(): Promise<TestSession> {
    nonce += 1;
    return harness.registerUser({ email: `ordinal-${nonce}@example.test`, role: 'client' });
  }

  /**
   * Issue one credential whose metadata row is shaped as `shape` says.
   *
   * The service passes neither id nor timestamp to the store, so the row is
   * shaped by wrapping the store's `create` for exactly one call — the seam the
   * lifecycle tests use to make the insert fail. Everything the service does,
   * including the ordinal the store assigns, is untouched.
   */
  async function issueShaped(
    actor: TestSession,
    type: CredentialType,
    shape: RowShape,
  ): Promise<IssueCredentialResponse> {
    const real = harness.store.credentials.create.bind(harness.store.credentials);
    harness.store.credentials.create = async (input: CreateInput<CredentialRecord>) => {
      harness.store.credentials.create = real;
      return real({ ...input, ...shape });
    };
    try {
      const response = await harness.authed(actor, {
        method: 'POST',
        url: '/api/credentials',
        payload: { credential_type: type },
      });
      assert.equal(response.statusCode, 201, response.body);
      return response.json<IssueCredentialResponse>();
    } finally {
      harness.store.credentials.create = real;
    }
  }

  async function issue(actor: TestSession, type: CredentialType): Promise<IssueCredentialResponse> {
    return issueShaped(actor, type, {});
  }

  /** Two credentials of one type, stamped by `skew` — the account is at the cap. */
  async function issuePair(
    actor: TestSession,
    type: CredentialType,
    skew: string,
  ): Promise<[IssueCredentialResponse, IssueCredentialResponse]> {
    const shapes = SKEWS[skew];
    assert.ok(shapes);
    const [firstShape, secondShape] = shapes(nonce);
    const first = await issueShaped(actor, type, firstShape);
    const second = await issueShaped(actor, type, secondShape);
    // The clocks say otherwise, but the ordinal records the true append order.
    assert.equal(first.credential.edge_ordinal, 1);
    assert.equal(second.credential.edge_ordinal, 2);
    return [first, second];
  }

  /** Plaintext material live on the mock gateway for a user and type, in array order. */
  function liveMaterial(userId: string, type: CredentialType): string[] {
    const consumer = harness.edge.consumerByUsername(consumerUsernameForUser(userId));
    return (consumer?.credentials[type] ?? []).map((entry) => String(entry[ENTRY_FIELD[type]]));
  }

  async function statusOf(credentialId: string): Promise<string | undefined> {
    return (await harness.store.credentials.findById(credentialId))?.status;
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

  for (const type of TYPES) {
    for (const skew of Object.keys(SKEWS)) {
      for (const target of ['first', 'second'] as const) {
        it(`${type}: revoke ${target} of two under ${skew}`, async () => {
          const user = await client();
          const [first, second] = await issuePair(user, type, skew);
          const victim = target === 'first' ? first : second;
          const survivor = target === 'first' ? second : first;

          const response = await revoke(user, victim.credential.id);
          assert.equal(response.statusCode, 200, response.body);

          assert.deepEqual(
            liveMaterial(user.user.id, type),
            [materialOf(survivor.secret)],
            'the gateway keeps exactly the other secret',
          );
          assert.equal(await statusOf(victim.credential.id), 'revoked');
          assert.equal(await statusOf(survivor.credential.id), 'active');

          // The survivor is still addressable at its new index…
          const again = await revoke(user, survivor.credential.id);
          assert.equal(again.statusCode, 200, again.body);
          assert.deepEqual(liveMaterial(user.user.id, type), []);
          // …and an ordinal is never reused, even once every slot is free.
          const next = await issue(user, type);
          assert.equal(next.credential.edge_ordinal, 3);
        });

        it(`${type}: rotate ${target} of two under ${skew}`, async () => {
          const user = await client();
          const [first, second] = await issuePair(user, type, skew);
          const victim = target === 'first' ? first : second;
          const survivor = target === 'first' ? second : first;

          // Two live credentials is the cap, so this is the delete-then-append
          // path: the wrong index here would take the survivor's entry.
          const response = await rotate(user, victim.credential.id);
          assert.equal(response.statusCode, 200, response.body);
          const body = response.json<RotateCredentialResponse>();

          assert.deepEqual(
            liveMaterial(user.user.id, type),
            [materialOf(survivor.secret), materialOf(body.secret)],
            'the survivor keeps its slot and the replacement is appended after it',
          );
          assert.equal(body.previous.id, victim.credential.id);
          assert.equal(body.previous.status, 'revoked');
          assert.equal(body.credential.rotated_from_id, victim.credential.id);
          assert.equal(body.credential.edge_ordinal, 3);
          assert.equal(await statusOf(survivor.credential.id), 'active');

          // Both live rows resolve to the right entries afterwards.
          const dropSurvivor = await revoke(user, survivor.credential.id);
          assert.equal(dropSurvivor.statusCode, 200, dropSurvivor.body);
          assert.deepEqual(liveMaterial(user.user.id, type), [materialOf(body.secret)]);
        });
      }
    }

    it(`${type}: failed rotation at the cap under skew leaves the survivor intact`, async () => {
      const user = await client();
      const [first, second] = await issuePair(
        user,
        type,
        'equal timestamps with the later id sorting first',
      );

      // At the cap the old entry is deleted first; the append then fails.
      harness.edge.queueFailure(503, { error: 'down' }, '/credentials/', 'POST');
      const failed = await rotate(user, first.credential.id);
      assert.equal(failed.statusCode, 502, failed.body);
      assert.match(failed.body, /previous credential was removed/i);

      assert.deepEqual(
        liveMaterial(user.user.id, type),
        [materialOf(second.secret)],
        'the entry that went was the one being rotated, not its neighbour',
      );
      assert.equal(await statusOf(first.credential.id), 'revoked');
      assert.equal(await statusOf(second.credential.id), 'active');

      // The survivor can still be pulled, which is what an incident needs.
      const revoked = await revoke(user, second.credential.id);
      assert.equal(revoked.statusCode, 200, revoked.body);
      assert.deepEqual(liveMaterial(user.user.id, type), []);
    });
  }

  describe('rows that predate the ordinal', () => {
    function reconcile(actor: TestSession, payload: Record<string, unknown>) {
      return harness.authed(actor, {
        method: 'POST',
        url: '/api/admin/credentials/reconcile',
        payload,
      });
    }

    for (const type of TYPES) {
      it(`${type}: two legacy rows are refused until an admin reconciles them`, async () => {
        const user = await client();
        const first = await issueShaped(user, type, { edge_ordinal: null, created_at: STAMP });
        const second = await issueShaped(user, type, { edge_ordinal: null, created_at: STAMP });
        assert.equal(first.credential.edge_ordinal, null);
        const both = [materialOf(first.secret), materialOf(second.secret)];
        const consumerId = first.credential.ferrum_consumer_id;

        // Neither can be addressed by index: nothing on either side says which
        // entry is which, so the answer is a refusal, not a guess.
        for (const target of [first, second]) {
          const revoked = await revoke(user, target.credential.id);
          assert.equal(revoked.statusCode, 409, revoked.body);
          assert.equal(errorOf(revoked.body).code, 'CONFLICT');
          assert.match(errorOf(revoked.body).message, /reconcile this consumer/);

          const rotated = await rotate(user, target.credential.id);
          assert.equal(rotated.statusCode, 409, rotated.body);
          assert.ok(!('secret' in JSON.parse(rotated.body)), 'no secret was handed out');
        }
        assert.deepEqual(liveMaterial(user.user.id, type), both, 'the gateway is untouched');
        assert.equal(await statusOf(first.credential.id), 'active');
        assert.equal(await statusOf(second.credential.id), 'active');
        const rows = await harness.store.credentials.list({ user_id: user.user.id });
        assert.equal(rows.total, 2, 'the refused rotations left no rows behind');

        // The documented repair: clear the type on both sides.
        const response = await reconcile(founder, {
          consumer_id: consumerId,
          credential_type: type,
          reason: 'legacy rows share a timestamp',
        });
        assert.equal(response.statusCode, 200, response.body);
        assert.deepEqual(response.json<ReconcileCredentialsResponse>(), {
          consumer_id: consumerId,
          credential_type: type,
          revoked_credentials: 2,
          gateway_cleared: true,
        });
        assert.deepEqual(liveMaterial(user.user.id, type), []);
        assert.equal(await statusOf(first.credential.id), 'revoked');
        assert.equal(await statusOf(second.credential.id), 'revoked');

        const audit = (await harness.auditRows('credential.reconcile')).find(
          (row) => row.target_id === consumerId && row.details.credential_type === type,
        );
        assert.ok(audit, 'the reconciliation is audited against the consumer');
        assert.equal(audit.actor_user_id, founder.user.id);
        assert.equal(audit.details.revoked_credentials, 2);
        assert.equal(audit.details.reason, 'legacy rows share a timestamp');
        assert.deepEqual(audit.details.owner_user_ids, [user.user.id]);

        const bell = await harness.authed(user, {
          method: 'GET',
          url: '/api/notifications?type=system',
        });
        const notices = bell.json<ListNotificationsResponse>().items;
        assert.ok(
          notices.some((item) => item.title === 'Gateway credentials reset'),
          'the account holder is told',
        );

        // The account recovers: fresh credentials carry ordinals and work.
        const fresh = await issue(user, type);
        assert.equal(fresh.credential.edge_ordinal, 1);
        assert.deepEqual(liveMaterial(user.user.id, type), [materialOf(fresh.secret)]);
        const revoked = await revoke(user, fresh.credential.id);
        assert.equal(revoked.statusCode, 200, revoked.body);
        assert.deepEqual(liveMaterial(user.user.id, type), []);
      });
    }

    it('a lone legacy row is index 0 and stays addressable beside ordinal rows', async () => {
      const user = await client();
      const legacy = await issueShaped(user, 'keyauth', { edge_ordinal: null, created_at: STAMP });
      // Stamped *earlier* than the legacy row: the ordinal, not the clock,
      // must put it second.
      const later = await issueShaped(user, 'keyauth', { created_at: EARLIER });
      assert.equal(later.credential.edge_ordinal, 1);

      const dropLater = await revoke(user, later.credential.id);
      assert.equal(dropLater.statusCode, 200, dropLater.body);
      assert.deepEqual(liveMaterial(user.user.id, 'keyauth'), [materialOf(legacy.secret)]);
      assert.equal(await statusOf(legacy.credential.id), 'active');

      const rotated = await rotate(user, legacy.credential.id);
      assert.equal(rotated.statusCode, 200, rotated.body);
      const body = rotated.json<RotateCredentialResponse>();
      assert.deepEqual(liveMaterial(user.user.id, 'keyauth'), [materialOf(body.secret)]);
      assert.equal(await statusOf(legacy.credential.id), 'revoked');
    });

    it('lists a legacy row ahead of ordinal rows regardless of timestamps', async () => {
      const user = await client();
      const legacy = await issueShaped(user, 'jwt', { edge_ordinal: null, created_at: STAMP });
      const later = await issueShaped(user, 'jwt', { created_at: EARLIER });
      const rows = await harness.store.credentials.listByConsumer(
        legacy.credential.ferrum_consumer_id,
        'jwt',
      );
      assert.deepEqual(
        rows.map((row) => row.id),
        [legacy.credential.id, later.credential.id],
      );
    });

    it('reconciliation is admin-only, validated, and tolerates a missing consumer', async () => {
      const user = await client();
      const issued = await issue(user, 'keyauth');
      const consumerId = issued.credential.ferrum_consumer_id;

      const forbidden = await reconcile(user, {
        consumer_id: consumerId,
        credential_type: 'keyauth',
      });
      assert.equal(forbidden.statusCode, 403, forbidden.body);
      assert.deepEqual(liveMaterial(user.user.id, 'keyauth'), [materialOf(issued.secret)]);

      const invalid = await reconcile(founder, {
        consumer_id: consumerId,
        credential_type: 'hmac',
      });
      assert.equal(invalid.statusCode, 400, invalid.body);
      assert.equal(errorOf(invalid.body).code, 'VALIDATION_FAILED');

      // A consumer Edge no longer has: nothing to clear there, rows still settle.
      const gone = await reconcile(founder, {
        consumer_id: 'no-such-consumer',
        credential_type: 'keyauth',
      });
      assert.equal(gone.statusCode, 200, gone.body);
      assert.deepEqual(gone.json<ReconcileCredentialsResponse>(), {
        consumer_id: 'no-such-consumer',
        credential_type: 'keyauth',
        revoked_credentials: 0,
        gateway_cleared: false,
      });

      // Only the named type is touched.
      const other = await issue(user, 'jwt');
      const cleared = await reconcile(founder, { consumer_id: consumerId, credential_type: 'jwt' });
      assert.equal(cleared.statusCode, 200, cleared.body);
      assert.equal(cleared.json<ReconcileCredentialsResponse>().revoked_credentials, 1);
      assert.deepEqual(liveMaterial(user.user.id, 'jwt'), []);
      assert.deepEqual(liveMaterial(user.user.id, 'keyauth'), [materialOf(issued.secret)]);
      assert.equal(await statusOf(other.credential.id), 'revoked');
      assert.equal(await statusOf(issued.credential.id), 'active');

      const listed = await harness.authed(user, { method: 'GET', url: '/api/credentials' });
      const items = listed.json<ListCredentialsResponse>().items;
      assert.equal(items.filter((item) => item.status === 'active').length, 1);
    });
  });
});
