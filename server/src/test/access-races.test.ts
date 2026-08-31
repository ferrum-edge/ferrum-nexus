/**
 * The access workflow under concurrency.
 *
 * Everything here interleaves two operations on purpose: a decision is held at
 * the point where it has already read a `pending` request, the competing
 * decision is run to completion, and only then is the first one let go. Calling
 * the two endpoints one after another proves nothing — the bugs these tests
 * cover are precisely the ones a sequential call cannot reach.
 *
 * The interleaving is driven by wrapping one store method for the duration of a
 * test. That is deliberately *below* the service under test and *above* the
 * database, so the service runs exactly as it does in production.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  aclGroupForApi,
  consumerUsernameForUser,
  type ApiErrorBody,
  type ApproveAccessRequestResponse,
  type CreateAccessRequestResponse,
  type PublishApiResponse,
} from '@ferrum-nexus/shared';

import type { AccessRequestRepo, GrantRepo, NexusStore } from '../db/store.js';
import { SAMPLE_SPEC_YAML, buildTestApp, type TestApp, type TestSession } from './helpers.js';

function errorCode(body: string): string {
  return (JSON.parse(body) as ApiErrorBody).error.code;
}

/** A promise plus the function that settles it. */
function latch(): { wait: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

describe('access workflow under concurrency', () => {
  let harness: TestApp;
  let provider: TestSession;
  let clientCounter = 0;

  async function publish(slug: string): Promise<string> {
    const response = await harness.authed(provider, {
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
    return response.json<PublishApiResponse>().api.id;
  }

  /** A brand-new client, so each test starts with no Edge consumer of its own. */
  async function freshClient(): Promise<TestSession> {
    clientCounter += 1;
    return harness.registerUser({ email: `race-client${clientCounter}@example.test` });
  }

  async function request(actor: TestSession, apiId: string): Promise<string> {
    const response = await harness.authed(actor, {
      method: 'POST',
      url: '/api/access-requests',
      payload: { api_id: apiId, justification: 'Racing the decision endpoints.' },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<CreateAccessRequestResponse>().access_request.id;
  }

  function groupsOf(userId: string): string[] | null {
    const consumer = harness.edge.consumerByUsername(consumerUsernameForUser(userId));
    return consumer ? consumer.acl_groups : null;
  }

  /**
   * Hold the **first** `accessRequests.findById` at the moment it has read the
   * row, so the caller that made it is parked with a stale `pending` in hand.
   *
   * Returns the latch that reports it got there, and the one that lets it go.
   */
  function holdFirstRequestRead(): {
    parked: Promise<void>;
    release: () => void;
    restore: () => void;
  } {
    const repo: AccessRequestRepo = harness.store.accessRequests;
    const real = repo.findById.bind(repo);
    const arrived = latch();
    const proceed = latch();
    let seen = 0;

    repo.findById = async (id) => {
      const row = await real(id);
      seen += 1;
      if (seen === 1) {
        arrived.open();
        await proceed.wait;
      }
      return row;
    };

    return {
      parked: arrived.wait,
      release: proceed.open,
      restore: () => {
        repo.findById = real;
      },
    };
  }

  before(async () => {
    harness = await buildTestApp();
    await harness.registerUser({ email: 'race-founder@example.test' });
    provider = await harness.registerUser({
      email: 'race-provider@example.test',
      role: 'provider',
    });
  });

  after(async () => {
    await harness.close();
  });

  /* ── Finding 8: decisions are compare-and-set ─────────────────────────── */

  it('a cancellation that lands after an approval loses instead of hiding live access', async () => {
    const apiId = await publish('race-cancel-after-approve');
    const client = await freshClient();
    const requestId = await request(client, apiId);
    const group = aclGroupForApi(apiId);

    const hold = holdFirstRequestRead();
    let cancelStatus = 0;
    let cancelBody = '';
    try {
      // The cancellation reads a pending request and stops there.
      const cancelling = harness.authed(client, {
        method: 'POST',
        url: `/api/access-requests/${requestId}/cancel`,
      });
      await hold.parked;

      // The approval runs all the way through in the meantime: grant row,
      // ACL group, the lot.
      const approved = await harness.authed(provider, {
        method: 'POST',
        url: `/api/access-requests/${requestId}/approve`,
        payload: {},
      });
      assert.equal(approved.statusCode, 200, approved.body);
      const grantId = approved.json<ApproveAccessRequestResponse>().grant.id;

      // Only now does the cancellation get to write.
      hold.release();
      const cancelled = await cancelling;
      cancelStatus = cancelled.statusCode;
      cancelBody = cancelled.body;

      assert.equal(cancelStatus, 409, cancelBody);
      assert.equal(errorCode(cancelBody), 'CONFLICT');

      const stored = await harness.store.accessRequests.findById(requestId);
      assert.equal(stored?.status, 'approved', 'the decision that provisioned the gateway stands');

      const grant = await harness.store.grants.findById(grantId);
      assert.equal(grant?.status, 'active');
      assert.deepEqual(
        groupsOf(client.user.id),
        [group],
        'the live grant’s ACL group is still on the consumer',
      );
    } finally {
      hold.restore();
    }
  });

  it('an approval that lands after a cancellation never touches the gateway', async () => {
    const apiId = await publish('race-approve-after-cancel');
    const client = await freshClient();
    const requestId = await request(client, apiId);

    const hold = holdFirstRequestRead();
    try {
      // The approval reads a pending request and stops before the gateway.
      const approving = harness.authed(provider, {
        method: 'POST',
        url: `/api/access-requests/${requestId}/approve`,
        payload: {},
      });
      await hold.parked;

      const cancelled = await harness.authed(client, {
        method: 'POST',
        url: `/api/access-requests/${requestId}/cancel`,
      });
      assert.equal(cancelled.statusCode, 200, cancelled.body);

      hold.release();
      const approved = await approving;
      assert.equal(approved.statusCode, 409, approved.body);
      assert.equal(errorCode(approved.body), 'CONFLICT');

      const stored = await harness.store.accessRequests.findById(requestId);
      assert.equal(stored?.status, 'cancelled');
      assert.equal(
        await harness.store.grants.findActiveByApiAndUser(apiId, client.user.id),
        null,
        'the loser created no grant',
      );
      assert.equal(
        groupsOf(client.user.id),
        null,
        'the loser did not even provision a consumer, let alone an ACL group',
      );
    } finally {
      hold.restore();
    }
  });

  it('a denial that lands after a cancellation loses the same way', async () => {
    const apiId = await publish('race-deny-after-cancel');
    const client = await freshClient();
    const requestId = await request(client, apiId);

    const hold = holdFirstRequestRead();
    try {
      const denying = harness.authed(provider, {
        method: 'POST',
        url: `/api/access-requests/${requestId}/deny`,
        payload: { decision_note: 'No.' },
      });
      await hold.parked;

      const cancelled = await harness.authed(client, {
        method: 'POST',
        url: `/api/access-requests/${requestId}/cancel`,
      });
      assert.equal(cancelled.statusCode, 200, cancelled.body);

      hold.release();
      const denied = await denying;
      assert.equal(denied.statusCode, 409, denied.body);
      assert.equal(errorCode(denied.body), 'CONFLICT');
      assert.equal((await harness.store.accessRequests.findById(requestId))?.status, 'cancelled');
    } finally {
      hold.restore();
    }
  });

  /* ── Finding 5: an approval that cannot commit gives the gateway back ─── */

  it('takes the ACL group back when the grant row cannot be written', async () => {
    const apiId = await publish('race-grant-write-fails');
    const client = await freshClient();
    const requestId = await request(client, apiId);

    const grants: GrantRepo = harness.store.grants;
    const realCreate = grants.create.bind(grants);
    grants.create = async () => {
      throw new Error('grant storage is unavailable');
    };

    try {
      const approved = await harness.authed(provider, {
        method: 'POST',
        url: `/api/access-requests/${requestId}/approve`,
        payload: {},
      });
      assert.equal(approved.statusCode, 500, approved.body);
    } finally {
      grants.create = realCreate;
    }

    assert.deepEqual(
      groupsOf(client.user.id),
      [],
      'the consumer keeps no access the portal has no grant for',
    );
    assert.equal(
      await harness.store.grants.findActiveByApiAndUser(apiId, client.user.id),
      null,
      'no grant was created',
    );
    assert.equal(
      (await harness.store.accessRequests.findById(requestId))?.status,
      'pending',
      'the request is back in the provider’s inbox to try again',
    );

    const rollback = (await harness.auditRows('access.approve_rollback')).find(
      (row) => row.target_id === requestId,
    );
    assert.ok(rollback, 'the compensation is audited');
    assert.equal(rollback?.details.acl_group_removed, aclGroupForApi(apiId));
    assert.equal(rollback?.details.request_released, true);

    // And the retry works, which is the whole point of putting it back.
    const retried = await harness.authed(provider, {
      method: 'POST',
      url: `/api/access-requests/${requestId}/approve`,
      payload: {},
    });
    assert.equal(retried.statusCode, 200, retried.body);
    assert.deepEqual(groupsOf(client.user.id), [aclGroupForApi(apiId)]);
  });

  it('leaves the ACL group alone when another approval already owns it', async () => {
    const apiId = await publish('race-grant-write-half-fails');
    const client = await freshClient();
    const requestId = await request(client, apiId);
    const group = aclGroupForApi(apiId);

    // The grant commits, but the approval never learns it did. That is the
    // shape of a lost acknowledgement, and it is also how a *concurrent*
    // approval looks to the compensation: by the time it goes to clean up, an
    // active grant owns the group. Stripping it would revoke real access.
    const store = harness.store;
    const realTransaction = store.transaction.bind(store);
    store.transaction = async <T>(fn: (tx: NexusStore) => Promise<T>): Promise<T> => {
      await realTransaction(fn);
      throw new Error('the connection dropped after the commit');
    };

    try {
      const approved = await harness.authed(provider, {
        method: 'POST',
        url: `/api/access-requests/${requestId}/approve`,
        payload: {},
      });
      assert.equal(approved.statusCode, 500, approved.body);
    } finally {
      store.transaction = realTransaction;
    }

    assert.deepEqual(
      groupsOf(client.user.id),
      [group],
      'compensation must not revoke the access a live grant owns',
    );
    const rollback = (await harness.auditRows('access.approve_rollback')).find(
      (row) => row.target_id === requestId,
    );
    assert.equal(rollback?.details.acl_group_kept, group);
    assert.ok(rollback?.details.kept_for_grant_id, 'the audit row names the grant it deferred to');
  });
});
