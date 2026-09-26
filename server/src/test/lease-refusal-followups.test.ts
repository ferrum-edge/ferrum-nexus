/**
 * Follow-ups to the transactional audit rows (issue #402).
 *
 * 1. A consumer repair whose relink the lease fence refused kept the consumer
 *    it had recreated — rightly, since another instance may already be issuing
 *    onto it — but then stopped: no `gateway.consumer_repair` row, the old
 *    credential rows still `active`, and every later pass reading the consumer
 *    as `present`, so no later repair would ever revoke them. It now takes the
 *    keys again and completes itself, and a second refusal says so in its own
 *    log line.
 * 2. A retirement whose gateway delete provably never applied went back to
 *    `active` with no completion for its `credential.revoke_start` row.
 * 3. A revocation rollback whose transaction committed but lost its
 *    acknowledgement restored the grant again and wrote a second
 *    `access.revoke_rollback` row.
 * 4. The fence-refusal branches themselves: a refused grant restore remains
 *    revoked, and the consumer is kept during a repair.
 * 5. Follow-ups (issue #408): a resumed repair that another instance already
 *    completed and recorded is not recorded twice, and a lost acknowledgement
 *    whose audit row cannot be read back takes the documented fallback.
 * 6. A withdrawn retirement is conditional on the row still being `retiring`,
 *    and one whose transaction failed for any other reason is retried as one
 *    transaction that moves the row and records it together (issue #409).
 *    The fence alone keeps a refused withdrawal's row `retiring`, and the
 *    retry that commits is the one that moved and recorded it (issue #413).
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  aclGroupForApi,
  consumerUsernameForUser,
  type IssueCredentialResponse,
  type PublishApiResponse,
  type RepairGatewayReferencesResponse,
  type RepairedGatewayConsumer,
} from '@ferrum-nexus/shared';

import { AuditAction } from '../audit/service.js';
import type { CredentialRepo, NexusStore, TransactionOptions } from '../db/store.js';
import { isoInSeconds, newId, nowIso } from '../lib/ids.js';
import { LEASE_LOST_MESSAGE } from '../lib/lease-fence.js';
import { buildTestApp, SAMPLE_SPEC_YAML, type TestApp, type TestSession } from './helpers.js';

/** The owner another portal instance takes a lapsed lease under. */
const OTHER_INSTANCE = 'other-instance';

/** What one committed transaction did to the credential a withdrawal targets. */
interface WithdrawalCommit {
  /** Its conditional move found the row `retiring` and put it back. */
  moved: boolean;
  /** It wrote a `credential.revoke_rollback` row for the credential. */
  recorded: boolean;
}

describe('lease refusals and lost acknowledgements after the audit move (#402)', () => {
  let harness: TestApp;
  let superAdmin: TestSession;
  let provider: TestSession;
  let nonce = 0;
  const logLines: string[] = [];
  /** Undo every patch a test installs, whether or not it passed. */
  let restorePatches: (() => void)[] = [];

  beforeEach(async () => {
    logLines.length = 0;
    restorePatches = [];
    harness = await buildTestApp({
      deps: {
        logger: {
          level: 'warn',
          stream: {
            write(line: string): void {
              logLines.push(line);
            },
          },
        },
      },
    });
    superAdmin = await harness.registerUser({ email: 'followups-super@example.test' });
    provider = await harness.registerUser({
      email: 'followups-provider@example.test',
      role: 'provider',
    });
  });

  afterEach(async () => {
    for (const undo of restorePatches.reverse()) undo();
    await harness.close();
  });

  function logged(fragment: string): boolean {
    return logLines.some((line) => line.includes(fragment));
  }

  async function client(): Promise<TestSession> {
    nonce += 1;
    return harness.registerUser({
      email: `followups-client-${nonce}@example.test`,
      role: 'client',
    });
  }

  async function issueKey(session: TestSession): Promise<IssueCredentialResponse> {
    const response = await harness.authed(session, {
      method: 'POST',
      url: '/api/credentials',
      payload: { credential_type: 'keyauth' },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<IssueCredentialResponse>();
  }

  /**
   * Let every lease lapse and hand `key` to another instance — what a section
   * that stalled past the TTL comes back to.
   */
  async function takeOver(key: string): Promise<void> {
    await harness.store.leases.deleteExpired('9999-01-01T00:00:00.000Z');
    assert.equal(
      await harness.store.leases.acquire(key, OTHER_INSTANCE, isoInSeconds(600), nowIso()),
      true,
    );
  }

  /** Commit the first transaction that adds an `action` row for `targetId`, then lose its ack. */
  function loseAcknowledgementOf(action: string, targetId: string): () => boolean {
    const store = harness.store;
    const realTransaction = store.transaction.bind(store);
    const rows = (): Promise<number> => store.auditLogs.count({ action, target_id: targetId });
    let dropped = false;
    store.transaction = async <T>(
      fn: (tx: NexusStore) => Promise<T>,
      options?: TransactionOptions,
    ): Promise<T> => {
      const before = await rows();
      const result = await realTransaction(fn, options);
      if (!dropped && (await rows()) > before) {
        dropped = true;
        throw new Error('the connection dropped after the commit');
      }
      return result;
    };
    restorePatches.push(() => {
      store.transaction = realTransaction;
    });
    return () => dropped;
  }

  /**
   * Count every conditional withdrawal of `credentialId` a transaction body
   * attempts, and note what each committed transaction that attempted one did.
   * With `failFirst`, the first transaction that would commit a
   * `credential.revoke_rollback` row for it fails before its commit instead,
   * with an error that is not a lease refusal.
   */
  function watchWithdrawals(
    credentialId: string,
    failFirst = false,
  ): { attempts: () => number; committed: () => WithdrawalCommit[] } {
    const store = harness.store;
    const realTransaction = store.transaction.bind(store);
    let attempts = 0;
    let failed = !failFirst;
    const committed: WithdrawalCommit[] = [];
    const rollbacksIn = (tx: NexusStore): Promise<number> =>
      tx.auditLogs.count({
        action: AuditAction.CREDENTIAL_REVOKE_ROLLBACK,
        target_id: credentialId,
      });
    store.transaction = async <T>(
      fn: (tx: NexusStore) => Promise<T>,
      options?: TransactionOptions,
    ): Promise<T> => {
      // The body may be re-run; only its last run is the one that committed.
      const runs: WithdrawalCommit[] = [];
      const result = await realTransaction(async (tx) => {
        const run: WithdrawalCommit = { moved: false, recorded: false };
        const attemptsBefore = attempts;
        const credentials: CredentialRepo = {
          ...tx.credentials,
          updateIfStatus: async (id, expected, patch) => {
            const row = await tx.credentials.updateIfStatus(id, expected, patch);
            if (id === credentialId) {
              attempts += 1;
              if (row !== null) run.moved = true;
            }
            return row;
          },
        };
        const spied = new Proxy(tx, {
          get(target, property): unknown {
            if (property === 'credentials') return credentials;
            const value: unknown = Reflect.get(target, property);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        const before = await rollbacksIn(tx);
        const bodyResult = await fn(spied);
        const after = await rollbacksIn(tx);
        run.recorded = after > before;
        if (!failed && after > 0) {
          failed = true;
          throw new Error('the connection dropped before the commit');
        }
        if (attempts > attemptsBefore) runs.push(run);
        return bodyResult;
      }, options);
      const last = runs.at(-1);
      if (last) committed.push(last);
      return result;
    };
    restorePatches.push(() => {
      store.transaction = realTransaction;
    });
    return { attempts: () => attempts, committed: () => committed };
  }

  /* ── 1 and 4: a consumer repair the lease fence refused ───────────────── */

  /** A client holding one key on a consumer the gateway then lost. */
  async function orphanedClient(): Promise<{
    session: TestSession;
    credentialId: string;
    consumerId: string;
  }> {
    const session = await client();
    const issued = await issueKey(session);
    // A rebuilt gateway: every consumer the portal created is gone.
    harness.edge.consumers.clear();
    return {
      session,
      credentialId: issued.credential.id,
      consumerId: issued.credential.ferrum_consumer_id,
    };
  }

  /**
   * Count entries into the stale consumer id's key, and hand that key back
   * from the other instance as the repair's second pass asks for it.
   */
  function releaseOnSecondPass(consumerId: string): () => number {
    const serialize = harness.edgeClient.serializePerKey.bind(harness.edgeClient);
    let entries = 0;
    harness.edgeClient.serializePerKey = async (key, work) => {
      if (key === consumerId) {
        entries += 1;
        if (entries === 2) {
          assert.equal(
            await harness.store.leases.release(consumerId, OTHER_INSTANCE),
            true,
            'the stale pass left the new holder’s lease alone',
          );
        }
      }
      return serialize(key, work);
    };
    restorePatches.push(() => {
      harness.edgeClient.serializePerKey = serialize;
    });
    return () => entries;
  }

  async function repairAccount(userId: string): Promise<RepairedGatewayConsumer> {
    const response = await harness.authed(superAdmin, {
      method: 'POST',
      url: '/api/admin/gateway/repair',
      payload: { user_ids: [userId], reason: 'lease refusal' },
    });
    assert.equal(response.statusCode, 200, response.body);
    const entries = response.json<RepairGatewayReferencesResponse>().consumers;
    assert.equal(entries.length, 1);
    const [entry] = entries;
    assert.ok(entry);
    return entry;
  }

  async function repairRows(userId: string) {
    return (await harness.auditRows(AuditAction.GATEWAY_CONSUMER_REPAIR)).filter(
      (row) => row.target_id === userId,
    );
  }

  it('completes a repair whose relink the fence refused, keeping the consumer', async () => {
    const { session, credentialId, consumerId } = await orphanedClient();
    const username = consumerUsernameForUser(session.user.id);
    const entries = releaseOnSecondPass(consumerId);

    // The repair stalls past the TTL right after recreating the consumer.
    // Another instance takes the key and issues a key onto the consumer it
    // finds, writing that key's row, before the stale relink reaches commit.
    const newer: { id: string | null } = { id: null };
    const consumers = harness.edgeClient.consumers;
    const ensure = consumers.ensure.bind(consumers);
    consumers.ensure = async (body, subject) => {
      const result = await ensure(body, subject);
      if (result.created && newer.id === null) {
        await takeOver(consumerId);
        const stored = harness.edge.consumerByUsername(username);
        assert.ok(stored, 'the repair recreated the consumer');
        stored.credentials.keyauth = [...(stored.credentials.keyauth ?? []), { key: 'newer-key' }];
        const row = await harness.store.credentials.create({
          user_id: session.user.id,
          application_id: null,
          ferrum_consumer_id: consumerId,
          credential_type: 'keyauth',
          ferrum_credential_id: `${consumerId}/credentials/keyauth`,
          fingerprint: `fp-${newId()}`,
          last4: 'ewer',
          status: 'active',
        });
        newer.id = row.id;
      }
      return result;
    };
    restorePatches.push(() => {
      consumers.ensure = ensure;
    });

    const repaired = await repairAccount(session.user.id);
    assert.equal(entries(), 2, 'the repair took the keys a second time');
    const newerRowId = newer.id;
    assert.ok(newerRowId, 'the other instance issued onto the recreated consumer');

    assert.equal(repaired.error, null);
    assert.equal(repaired.ferrum_consumer_id, consumerId);
    assert.equal(repaired.credentials_requiring_reissue, 1);
    assert.ok(
      logged('A consumer repair lost its lease after recreating the consumer'),
      'the refusal is logged',
    );

    // The consumer the other instance issued onto is still there, with its key.
    const stored = harness.edge.consumerByUsername(username);
    assert.ok(stored, 'the recreated consumer was kept');
    assert.equal(stored.id, consumerId);
    const keys = (stored.credentials.keyauth ?? []).map((entry) => String(entry.key));
    assert.deepEqual(keys, ['newer-key'], 'the key issued onto it since is still live');

    // Only the row that named an entry of the lost consumer is revoked.
    assert.equal((await harness.store.credentials.findById(credentialId))?.status, 'revoked');
    assert.equal((await harness.store.credentials.findById(newerRowId))?.status, 'active');

    const rows = await repairRows(session.user.id);
    assert.equal(rows.length, 1, 'the repair is recorded exactly once');
    assert.equal(rows[0]?.details.resumed, true);
    assert.deepEqual(rows[0]?.details.revoked_credential_ids, [credentialId]);
    assert.equal(rows[0]?.details.consumer_id, consumerId);
    assert.equal(rows[0]?.details.reason, 'lease refusal');

    // And nothing is left for a later pass to report.
    const report = await harness.services.reconciliation.scan();
    assert.ok(!report.orphaned_consumers.some((orphan) => orphan.user_id === session.user.id));
  });

  it('keeps the consumer and says so when the completion is refused as well', async () => {
    const { session, credentialId, consumerId } = await orphanedClient();
    const username = consumerUsernameForUser(session.user.id);
    const entries = releaseOnSecondPass(consumerId);

    const consumers = harness.edgeClient.consumers;
    const ensure = consumers.ensure.bind(consumers);
    let stalls = 0;
    consumers.ensure = async (body, subject) => {
      const result = await ensure(body, subject);
      if (result.created && stalls === 0) {
        stalls += 1;
        await takeOver(consumerId);
      }
      return result;
    };
    // The second pass stalls too, right after finding the consumer it kept.
    const get = consumers.get.bind(consumers);
    consumers.get = async (id) => {
      const found = await get(id);
      if (id === consumerId && entries() === 2 && stalls === 1) {
        stalls += 1;
        await takeOver(consumerId);
      }
      return found;
    };
    restorePatches.push(() => {
      consumers.ensure = ensure;
      consumers.get = get;
    });

    const repaired = await repairAccount(session.user.id);
    assert.equal(stalls, 2, 'both passes lost their lease');
    assert.equal(
      await harness.store.leases.release(consumerId, OTHER_INSTANCE),
      true,
      'the stale completion left the new holder’s lease alone',
    );

    assert.equal(repaired.error, LEASE_LOST_MESSAGE);
    assert.ok(
      logged('A consumer repair that lost its lease could not be completed'),
      'the unfinished repair has its own log line',
    );
    // Kept rather than deleted: another instance may be issuing onto it.
    assert.equal(harness.edge.consumerByUsername(username)?.id, consumerId);
    // Nothing of the portal half committed.
    assert.equal((await harness.store.credentials.findById(credentialId))?.status, 'active');
    assert.equal((await repairRows(session.user.id)).length, 0);
  });

  /**
   * Once the repair recreates the consumer, and before its relink reaches the
   * commit, hand `consumerId`'s key to another instance and let `other` act as
   * that instance did.
   */
  function stallAfterRecreating(consumerId: string, other: () => Promise<void>): () => boolean {
    const consumers = harness.edgeClient.consumers;
    const ensure = consumers.ensure.bind(consumers);
    let stalled = false;
    consumers.ensure = async (body, subject) => {
      const result = await ensure(body, subject);
      if (result.created && !stalled) {
        stalled = true;
        await takeOver(consumerId);
        await other();
      }
      return result;
    };
    restorePatches.push(() => {
      consumers.ensure = ensure;
    });
    return () => stalled;
  }

  /** A `gateway.consumer_repair` row as another instance's repair writes one. */
  async function recordRepair(
    userId: string,
    consumerId: string,
    revoked: string[],
  ): Promise<void> {
    await harness.store.auditLogs.create({
      actor_user_id: superAdmin.user.id,
      actor_role: 'super_admin',
      action: AuditAction.GATEWAY_CONSUMER_REPAIR,
      target_type: 'user',
      target_id: userId,
      details: { consumer_id: consumerId, revoked_credential_ids: revoked },
      ip: null,
    });
  }

  /** Repair `userId`, and assert that the resumed pass recorded its own row. */
  async function assertResumedRowRecorded(
    userId: string,
    consumerId: string,
    rows: number,
  ): Promise<void> {
    const repaired = await repairAccount(userId);
    assert.equal(repaired.error, null);
    assert.equal(repaired.ferrum_consumer_id, consumerId);
    assert.equal(repaired.credentials_requiring_reissue, 0);
    const recorded = await repairRows(userId);
    assert.equal(recorded.length, rows);
    const resumed = recorded.filter((row) => row.details.resumed === true);
    assert.equal(resumed.length, 1, 'the resumed repair is recorded');
    assert.equal(resumed[0]?.details.consumer_id, consumerId);
    assert.deepEqual(resumed[0]?.details.revoked_credential_ids, []);
  }

  it('does not record a repair twice when another instance completed it first', async () => {
    const { session, credentialId, consumerId } = await orphanedClient();
    const username = consumerUsernameForUser(session.user.id);
    const entries = releaseOnSecondPass(consumerId);

    // A second repair of the same account started while this one held the
    // keys, found the consumer this one recreated once the lease lapsed, and
    // committed the revocation and its own repair row first.
    const stalled = stallAfterRecreating(consumerId, async () => {
      await harness.store.credentials.update(credentialId, { status: 'revoked' });
      await recordRepair(session.user.id, consumerId, [credentialId]);
    });

    const repaired = await repairAccount(session.user.id);
    assert.ok(stalled(), 'the repair lost its lease after recreating the consumer');
    assert.equal(entries(), 2, 'the repair took the keys a second time');

    assert.equal(repaired.error, 'The gateway consumer already exists; nothing to repair');
    assert.equal(repaired.ferrum_consumer_id, consumerId);
    assert.equal(repaired.credentials_requiring_reissue, 0);
    assert.equal(harness.edge.consumerByUsername(username)?.id, consumerId, 'the consumer is kept');
    assert.equal((await harness.store.credentials.findById(credentialId))?.status, 'revoked');

    const rows = await repairRows(session.user.id);
    assert.equal(rows.length, 1, 'the other instance’s row is the only record of the repair');
    assert.equal(rows[0]?.details.resumed, undefined);
  });

  it('still records a resumed repair whose rows were revoked without one', async () => {
    const { session, credentialId, consumerId } = await orphanedClient();
    const entries = releaseOnSecondPass(consumerId);

    // The stale row was revoked in the meantime, but nothing recorded a repair.
    const stalled = stallAfterRecreating(consumerId, async () => {
      await harness.store.credentials.update(credentialId, { status: 'revoked' });
    });

    const repaired = await repairAccount(session.user.id);
    assert.ok(stalled(), 'the repair lost its lease after recreating the consumer');
    assert.equal(entries(), 2, 'the repair took the keys a second time');

    assert.equal(repaired.error, null);
    assert.equal(repaired.ferrum_consumer_id, consumerId);
    assert.equal(repaired.credentials_requiring_reissue, 0);
    const rows = await repairRows(session.user.id);
    assert.equal(rows.length, 1, 'the repair is recorded once');
    assert.equal(rows[0]?.details.resumed, true);
    assert.deepEqual(rows[0]?.details.revoked_credential_ids, []);
  });

  it('records a resumed repair when a newer repair row does not list its stale row', async () => {
    const { session, credentialId, consumerId } = await orphanedClient();
    const entries = releaseOnSecondPass(consumerId);

    // The stale row was revoked some other way, and an unrelated repair of
    // the same consumer recorded since revoked none of its rows.
    const stalled = stallAfterRecreating(consumerId, async () => {
      await harness.store.credentials.update(credentialId, { status: 'revoked' });
      await recordRepair(session.user.id, consumerId, []);
    });

    await assertResumedRowRecorded(session.user.id, consumerId, 2);
    assert.ok(stalled(), 'the repair lost its lease after recreating the consumer');
    assert.equal(entries(), 2, 'the repair took the keys a second time');
  });

  it('records a resumed repair when the only other repair row predates it', async () => {
    const { session, credentialId, consumerId } = await orphanedClient();
    // A repair of this consumer recorded before this one began.
    await recordRepair(session.user.id, consumerId, []);
    const entries = releaseOnSecondPass(consumerId);

    const stalled = stallAfterRecreating(consumerId, async () => {
      await harness.store.credentials.update(credentialId, { status: 'revoked' });
    });

    await assertResumedRowRecorded(session.user.id, consumerId, 2);
    assert.ok(stalled(), 'the repair lost its lease after recreating the consumer');
    assert.equal(entries(), 2, 'the repair took the keys a second time');
  });

  it('records a resumed repair that had no stale rows to revoke', async () => {
    const { session, credentialId, consumerId } = await orphanedClient();
    // Nothing was live when the consumer was recreated.
    await harness.store.credentials.update(credentialId, { status: 'revoked' });
    const entries = releaseOnSecondPass(consumerId);

    // A repair row for the consumer since then covers every stale row
    // vacuously; that is no evidence the repair was already recorded.
    const stalled = stallAfterRecreating(consumerId, async () => {
      await recordRepair(session.user.id, consumerId, []);
    });

    await assertResumedRowRecorded(session.user.id, consumerId, 2);
    assert.ok(stalled(), 'the repair lost its lease after recreating the consumer');
    assert.equal(entries(), 2, 'the repair took the keys a second time');
  });

  /** A client holding two keys on a consumer the gateway then lost. */
  async function orphanedClientWithTwoKeys(): Promise<{
    session: TestSession;
    credentialIds: [string, string];
    consumerId: string;
  }> {
    const session = await client();
    const first = await issueKey(session);
    const second = await issueKey(session);
    assert.equal(second.credential.ferrum_consumer_id, first.credential.ferrum_consumer_id);
    harness.edge.consumers.clear();
    return {
      session,
      credentialIds: [first.credential.id, second.credential.id],
      consumerId: first.credential.ferrum_consumer_id,
    };
  }

  it('does not record a repair that two rows for its consumer completed together', async () => {
    const { session, credentialIds, consumerId } = await orphanedClientWithTwoKeys();
    const [firstId, secondId] = credentialIds;
    const entries = releaseOnSecondPass(consumerId);

    // Two repairs of this consumer each revoked one of its stale rows; a row
    // for a different consumer lists both, and counts for nothing here.
    const stalled = stallAfterRecreating(consumerId, async () => {
      await harness.store.credentials.update(firstId, { status: 'revoked' });
      await harness.store.credentials.update(secondId, { status: 'revoked' });
      await recordRepair(session.user.id, newId(), [firstId, secondId]);
      await recordRepair(session.user.id, consumerId, [firstId]);
      await recordRepair(session.user.id, consumerId, [secondId]);
    });

    const repaired = await repairAccount(session.user.id);
    assert.ok(stalled(), 'the repair lost its lease after recreating the consumer');
    assert.equal(entries(), 2, 'the repair took the keys a second time');

    assert.equal(repaired.error, 'The gateway consumer already exists; nothing to repair');
    assert.equal(repaired.ferrum_consumer_id, consumerId);
    assert.equal(repaired.credentials_requiring_reissue, 0);
    const rows = await repairRows(session.user.id);
    assert.equal(rows.length, 3, 'only the other instances’ rows record the repair');
    assert.ok(rows.every((row) => row.details.resumed === undefined));
  });

  it('records a resumed repair when only another consumer’s row lists a stale row', async () => {
    const { session, credentialIds, consumerId } = await orphanedClientWithTwoKeys();
    const [firstId, secondId] = credentialIds;
    const entries = releaseOnSecondPass(consumerId);

    // One stale row is covered by a repair of this consumer; the other only by
    // a row for a different consumer, which is no record of this repair.
    const stalled = stallAfterRecreating(consumerId, async () => {
      await harness.store.credentials.update(firstId, { status: 'revoked' });
      await harness.store.credentials.update(secondId, { status: 'revoked' });
      await recordRepair(session.user.id, consumerId, [firstId]);
      await recordRepair(session.user.id, newId(), [secondId]);
    });

    await assertResumedRowRecorded(session.user.id, consumerId, 3);
    assert.ok(stalled(), 'the repair lost its lease after recreating the consumer');
    assert.equal(entries(), 2, 'the repair took the keys a second time');
  });

  /* ── 3 and 4: a revocation rollback ───────────────────────────────────── */

  /** A client approved for a fresh API, with the grant and the API's proxy. */
  async function grantee(): Promise<{
    session: TestSession;
    apiId: string;
    proxyId: string;
    grantId: string;
  }> {
    nonce += 1;
    const published = await harness.authed(provider, {
      method: 'POST',
      url: '/api/apis',
      payload: {
        name: `Follow-up ${nonce}`,
        slug: `follow-up-${nonce}`,
        spec: SAMPLE_SPEC_YAML,
        auth_plugin: 'key_auth',
        requestable: true,
        visibility: 'public',
      },
    });
    assert.equal(published.statusCode, 201, published.body);
    const apiId = published.json<PublishApiResponse>().api.id;
    const proxyId = (await harness.store.apis.findById(apiId))?.ferrum_proxy_id;
    assert.ok(proxyId);

    const session = await client();
    const requested = await harness.authed(session, {
      method: 'POST',
      url: '/api/access-requests',
      payload: { api_id: apiId, justification: 'Integration access' },
    });
    assert.equal(requested.statusCode, 201, requested.body);
    const requestId = requested.json<{ access_request: { id: string } }>().access_request.id;
    const approved = await harness.authed(provider, {
      method: 'POST',
      url: `/api/access-requests/${requestId}/approve`,
      payload: {},
    });
    assert.equal(approved.statusCode, 200, approved.body);
    const grant = await harness.store.grants.findActiveByApiAndUser(apiId, session.user.id, null);
    assert.ok(grant);
    return { session, apiId, proxyId, grantId: grant.id };
  }

  function groupsOf(userId: string): string[] | undefined {
    return harness.edge.consumerByUsername(consumerUsernameForUser(userId))?.acl_groups;
  }

  function revoke(grantId: string) {
    return harness.authed(provider, {
      method: 'POST',
      url: `/api/grants/${grantId}/revoke`,
      payload: { reason: 'Follow-up' },
    });
  }

  function countAudit(action: string, targetId: string): Promise<number> {
    return harness.store.auditLogs.count({ action, target_id: targetId });
  }

  /** Make the gateway refuse the next write to `userId`'s consumer. */
  function refuseNextConsumerWrite(userId: string): void {
    const consumer = harness.edge.consumerByUsername(consumerUsernameForUser(userId));
    assert.ok(consumer);
    harness.edge.queueFailure(500, { error: 'refused' }, `/consumers/${consumer.id}`, 'PUT');
  }

  it('does not restore a grant outside the fence when its rollback is refused', async () => {
    const { session, apiId, proxyId, grantId } = await grantee();
    const key = `proxy:${proxyId}`;
    refuseNextConsumerWrite(session.user.id);

    // The revocation stalls past the TTL at the gateway step, after its claim
    // committed; another instance takes the proxy key, so the rollback's
    // combined write is refused at commit.
    const provisioner = harness.services.credentials.provisioner;
    const mutate = provisioner.mutateAclGroups.bind(provisioner);
    let stalled = false;
    provisioner.mutateAclGroups = async (...args) => {
      if (!stalled) {
        stalled = true;
        await takeOver(key);
      }
      return mutate(...args);
    };
    restorePatches.push(() => {
      provisioner.mutateAclGroups = mutate;
    });

    const failed = await revoke(grantId);
    assert.ok(stalled, 'the revocation reached the gateway');
    assert.equal(failed.statusCode, 502, failed.body);
    assert.equal(
      await harness.store.leases.release(key, OTHER_INSTANCE),
      true,
      "the stale rollback left the new holder's lease alone",
    );

    // The stale holder must not restore outside the fence: an administrative
    // teardown may have skipped the claimed row and removed this group while
    // the provider's gateway request was stalled.
    assert.deepEqual(groupsOf(session.user.id), [aclGroupForApi(apiId)]);
    assert.equal((await harness.store.grants.findById(grantId))?.status, 'revoked');
    assert.equal(await countAudit(AuditAction.ACCESS_REVOKE, grantId), 1);
    assert.equal(await countAudit(AuditAction.ACCESS_REVOKE_ROLLBACK, grantId), 0);
    assert.ok(logged('Could not return a failed revocation'), 'the refusal is logged');

    const retried = await revoke(grantId);
    assert.equal(retried.statusCode, 409, retried.body);
    assert.equal((await harness.store.grants.findById(grantId))?.status, 'revoked');
  });

  it('records a rollback that lost its acknowledgement exactly once', async () => {
    const { session, apiId, grantId } = await grantee();
    refuseNextConsumerWrite(session.user.id);
    const dropped = loseAcknowledgementOf(AuditAction.ACCESS_REVOKE_ROLLBACK, grantId);

    const failed = await revoke(grantId);
    assert.equal(failed.statusCode, 502, failed.body);
    assert.ok(dropped(), 'the rollback committed and its acknowledgement was lost');

    assert.deepEqual(groupsOf(session.user.id), [aclGroupForApi(apiId)]);
    assert.equal((await harness.store.grants.findById(grantId))?.status, 'active');
    assert.equal(await countAudit(AuditAction.ACCESS_REVOKE, grantId), 1);
    assert.equal(
      await countAudit(AuditAction.ACCESS_REVOKE_ROLLBACK, grantId),
      1,
      'the committed rollback is not recorded a second time',
    );
    assert.ok(logged('though its acknowledgement was lost'));
  });

  it('falls back to a second rollback row when the committed row cannot be read', async () => {
    const { session, apiId, grantId } = await grantee();
    refuseNextConsumerWrite(session.user.id);
    const dropped = loseAcknowledgementOf(AuditAction.ACCESS_REVOKE_ROLLBACK, grantId);

    // The read that would find the committed rollback row fails as well.
    const auditLogs = harness.store.auditLogs;
    const list = auditLogs.list.bind(auditLogs);
    let unreadable = false;
    auditLogs.list = async (filter, options) => {
      if (dropped() && !unreadable && filter.target_id === grantId) {
        unreadable = true;
        throw new Error('the audit log could not be read');
      }
      return list(filter, options);
    };
    restorePatches.push(() => {
      auditLogs.list = list;
    });

    const failed = await revoke(grantId);
    assert.equal(failed.statusCode, 502, failed.body);
    assert.ok(dropped(), 'the rollback committed and its acknowledgement was lost');
    assert.ok(unreadable, 'the lookup for the committed row failed');
    assert.ok(logged('retrying alone'), 'the fallback is taken');

    // The grant went back once, with the group still on the consumer.
    assert.deepEqual(groupsOf(session.user.id), [aclGroupForApi(apiId)]);
    assert.equal((await harness.store.grants.findById(grantId))?.status, 'active');
    assert.equal(await countAudit(AuditAction.ACCESS_REVOKE, grantId), 1);
    // The documented cost of the fallback: the rollback is recorded twice,
    // and both rows say the grant is back.
    const rows = (await harness.auditRows(AuditAction.ACCESS_REVOKE_ROLLBACK)).filter(
      (row) => row.target_id === grantId,
    );
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.details.grant_restored === true));

    const retried = await revoke(grantId);
    assert.equal(retried.statusCode, 200, retried.body);
    assert.equal((await harness.store.grants.findById(grantId))?.status, 'revoked');
  });

  /* ── 2: a retirement whose delete provably never applied ──────────────── */

  it('completes the start row when a delete provably never applied', async () => {
    const session = await client();
    const first = await issueKey(session);
    await issueKey(session);
    const credentialId = first.credential.id;
    harness.edge.queueFailure(503, { error: 'down' }, '/credentials/keyauth/', 'DELETE');

    const failed = await harness.authed(session, {
      method: 'DELETE',
      url: `/api/credentials/${credentialId}`,
    });
    assert.equal(failed.statusCode, 502, failed.body);
    assert.equal((await harness.store.credentials.findById(credentialId))?.status, 'active');
    assert.equal(await countAudit(AuditAction.CREDENTIAL_REVOKE_START, credentialId), 1);
    assert.equal(await countAudit(AuditAction.CREDENTIAL_REVOKE, credentialId), 0);
    const rows = (await harness.auditRows(AuditAction.CREDENTIAL_REVOKE_ROLLBACK)).filter(
      (row) => row.target_id === credentialId,
    );
    assert.equal(rows.length, 1, 'the start has its completion');
    assert.equal(rows[0]?.details.operation, 'revoke');
    assert.equal(rows[0]?.details.consumer_id, first.credential.ferrum_consumer_id);
    assert.equal(rows[0]?.details.last4, first.credential.last4);
  });

  it('retries a withdrawal that failed before its commit as one atomic move', async () => {
    const session = await client();
    const first = await issueKey(session);
    const credentialId = first.credential.id;
    harness.edge.queueFailure(503, { error: 'down' }, '/credentials/keyauth/', 'DELETE');
    const { attempts, committed } = watchWithdrawals(credentialId, true);

    const failed = await harness.authed(session, {
      method: 'DELETE',
      url: `/api/credentials/${credentialId}`,
    });
    assert.equal(failed.statusCode, 502, failed.body);
    assert.equal((await harness.store.credentials.findById(credentialId))?.status, 'active');
    assert.equal(
      attempts(),
      2,
      'the failed transaction and one retry that moved the row and recorded it together',
    );
    assert.deepEqual(
      committed(),
      [{ moved: true, recorded: true }],
      'the one committed withdrawal moved the row and wrote its rollback row together',
    );
    assert.equal(await countAudit(AuditAction.CREDENTIAL_REVOKE_START, credentialId), 1);
    assert.equal(
      await countAudit(AuditAction.CREDENTIAL_REVOKE_ROLLBACK, credentialId),
      1,
      'the rolled-back attempt left no row and the retry wrote exactly one',
    );
  });

  /**
   * Revoke `credentialId` with a delete that provably never applies, and let
   * the revocation stall past the TTL once it has read the array that proves
   * it: another instance takes the consumer key, runs `meanwhile`, and still
   * holds the key when the withdrawal reaches its commit.
   */
  async function revokeWithFencedWithdrawal(
    session: TestSession,
    credentialId: string,
    consumerId: string,
    meanwhile: () => Promise<void>,
  ): Promise<{ attempts: number; committed: WithdrawalCommit[] }> {
    harness.edge.queueFailure(503, { error: 'down' }, '/credentials/keyauth/', 'DELETE');
    const consumers = harness.edgeClient.consumers;
    const get = consumers.get.bind(consumers);
    let stalled = false;
    consumers.get = async (id) => {
      const live = await get(id);
      if (!stalled && harness.edge.callsTo('DELETE', '/credentials/keyauth/').length > 0) {
        stalled = true;
        await takeOver(consumerId);
        await meanwhile();
      }
      return live;
    };
    restorePatches.push(() => {
      consumers.get = get;
    });
    const { attempts, committed } = watchWithdrawals(credentialId);

    const failed = await harness.authed(session, {
      method: 'DELETE',
      url: `/api/credentials/${credentialId}`,
    });
    assert.ok(stalled, 'the revocation reached the gateway');
    assert.equal(failed.statusCode, 502, failed.body);
    assert.equal(
      await harness.store.leases.release(consumerId, OTHER_INSTANCE),
      true,
      "the stale withdrawal left the new holder's lease alone",
    );
    return { attempts: attempts(), committed: committed() };
  }

  it('keeps a key another instance revoked when the fence refuses the withdrawal', async () => {
    const session = await client();
    const first = await issueKey(session);
    const credentialId = first.credential.id;
    const consumerId = first.credential.ferrum_consumer_id;

    // The other instance completes the revocation before the withdrawal commits.
    const { attempts, committed } = await revokeWithFencedWithdrawal(
      session,
      credentialId,
      consumerId,
      async () => {
        await harness.store.credentials.update(credentialId, { status: 'revoked' });
      },
    );
    assert.equal(
      attempts,
      1,
      'the refusal ends the withdrawal at once; no retry is attempted under a lost lease',
    );
    assert.deepEqual(committed, []);
    assert.equal(
      (await harness.store.credentials.findById(credentialId))?.status,
      'revoked',
      'the refused withdrawal does not bring a revoked key back',
    );
    assert.equal(await countAudit(AuditAction.CREDENTIAL_REVOKE_ROLLBACK, credentialId), 0);
  });

  it('leaves a retiring key retiring when the fence refuses the withdrawal', async () => {
    const session = await client();
    const first = await issueKey(session);
    const credentialId = first.credential.id;
    const consumerId = first.credential.ferrum_consumer_id;

    // The other instance takes the key but leaves the row `retiring`, so the
    // status condition alone would let the move back through: only the fence
    // stops it.
    const { attempts, committed } = await revokeWithFencedWithdrawal(
      session,
      credentialId,
      consumerId,
      async () => {
        assert.equal((await harness.store.credentials.findById(credentialId))?.status, 'retiring');
      },
    );
    assert.equal(
      attempts,
      1,
      'the refusal ends the withdrawal at once; no retry is attempted under a lost lease',
    );
    assert.deepEqual(committed, [], 'the refused withdrawal committed nothing');
    assert.equal(
      (await harness.store.credentials.findById(credentialId))?.status,
      'retiring',
      'the fence, not the status condition, kept the row retiring',
    );
    assert.equal(await countAudit(AuditAction.CREDENTIAL_REVOKE_START, credentialId), 1);
    assert.equal(await countAudit(AuditAction.CREDENTIAL_REVOKE_ROLLBACK, credentialId), 0);
  });

  it('records a withdrawn retirement that lost its acknowledgement exactly once', async () => {
    const session = await client();
    const first = await issueKey(session);
    const credentialId = first.credential.id;
    harness.edge.queueFailure(503, { error: 'down' }, '/credentials/keyauth/', 'DELETE');
    const dropped = loseAcknowledgementOf(AuditAction.CREDENTIAL_REVOKE_ROLLBACK, credentialId);

    const failed = await harness.authed(session, {
      method: 'DELETE',
      url: `/api/credentials/${credentialId}`,
    });
    assert.equal(failed.statusCode, 502, failed.body);
    assert.ok(dropped(), 'the withdrawal committed and its acknowledgement was lost');
    assert.equal((await harness.store.credentials.findById(credentialId))?.status, 'active');
    assert.equal(await countAudit(AuditAction.CREDENTIAL_REVOKE_ROLLBACK, credentialId), 1);
  });
});
