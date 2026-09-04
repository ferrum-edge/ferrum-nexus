/**
 * The last-active-`super_admin` invariant, under concurrency.
 *
 * The rule is a count of *other* super admins followed by a write to this one,
 * and the interesting failure is not "can I demote the only one" — the existing
 * suites cover that — but "can two administrators demote each other at the same
 * instant". Each test therefore parks both requests at the moment they have
 * counted, lets them both go, and checks the portal still has an administrator.
 *
 * Both entry points are exercised: the ordinary `PATCH /api/users/:id` route
 * and god mode's `disable-user`, which repeats the rule rather than routing
 * through it.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type { ApiErrorBody, User } from '@ferrum-nexus/shared';

import type { NexusStore, UserRepo } from '../db/store.js';
import { buildTestApp, type TestApp, type TestSession } from './helpers.js';

function errorCode(body: string): string {
  return (JSON.parse(body) as ApiErrorBody).error.code;
}

/** A re-arming meeting point: every `width` arrivals are released together. */
interface Rendezvous {
  /** Park until `width` callers have arrived, or `timeoutMs` has passed. */
  meet(): Promise<void>;
  /** Release everyone parked and stop timing out. */
  dispose(): void;
}

/**
 * Park callers in groups of `width`.
 *
 * The timeout is what makes this usable on both sides of the fix: with the lock
 * in place the losing request never reaches its count — it is waiting on the
 * lease — so the group never fills and the timer lets the winner through.
 */
function rendezvous(width: number, timeoutMs: number): Rendezvous {
  let waiting = 0;
  let open: () => void = () => undefined;
  let gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let timer: NodeJS.Timeout | null = null;

  function release(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    const releaseGroup = open;
    waiting = 0;
    gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    releaseGroup();
  }

  return {
    async meet(): Promise<void> {
      const mine = gate;
      waiting += 1;
      if (waiting >= width) release();
      else if (timer === null) {
        timer = setTimeout(release, timeoutMs);
        timer.unref?.();
      }
      await mine;
    },
    dispose(): void {
      release();
    },
  };
}

describe('the last active super_admin, under concurrency', () => {
  let harness: TestApp;
  let founder: TestSession;

  /**
   * Hold the first `n` `countActiveSuperAdmins` calls until all `n` have
   * arrived, then let them all read.
   *
   * Both racing requests count before either writes, which is exactly the
   * window the invariant has to survive — and, importantly, the barrier sits on
   * the *advisory* pre-check outside the transaction, so it cannot deadlock the
   * serialised transaction body where the authoritative count lives.
   */
  function barrierOnFirstCounts(n: number): () => void {
    const repo: UserRepo = harness.store.users;
    const real = repo.countActiveSuperAdmins.bind(repo);
    let arrived = 0;
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });

    repo.countActiveSuperAdmins = async (excludeUserId) => {
      arrived += 1;
      if (arrived <= n) {
        if (arrived === n) open();
        await gate;
      }
      return real(excludeUserId);
    };

    return () => {
      repo.countActiveSuperAdmins = real;
    };
  }

  /** Register an account and promote it to `super_admin` through the API. */
  async function makeSuperAdmin(email: string): Promise<TestSession> {
    const session = await harness.registerUser({ email });
    const promoted = await harness.authed(founder, {
      method: 'PATCH',
      url: `/api/users/${session.user.id}`,
      payload: { role: 'super_admin' },
    });
    assert.equal(promoted.statusCode, 200, promoted.body);
    return { ...session, user: promoted.json<{ user: User }>().user };
  }

  before(async () => {
    harness = await buildTestApp();
    founder = await harness.registerUser({ email: 'lsa-founder@example.test' });
    assert.equal(founder.user.role, 'super_admin');
  });

  after(async () => {
    await harness.close();
  });

  it('refuses one of two simultaneous demotions instead of emptying the role', async () => {
    const other = await makeSuperAdmin('lsa-peer-demote@example.test');
    assert.equal(await harness.store.users.countActiveSuperAdmins(), 2);

    const restore = barrierOnFirstCounts(2);
    let outcomes: { status: number; body: string }[];
    try {
      const responses = await Promise.all([
        harness.authed(founder, {
          method: 'PATCH',
          url: `/api/users/${other.user.id}`,
          payload: { role: 'client' },
        }),
        harness.authed(other, {
          method: 'PATCH',
          url: `/api/users/${founder.user.id}`,
          payload: { role: 'client' },
        }),
      ]);
      outcomes = responses.map((response) => ({
        status: response.statusCode,
        body: response.body,
      }));
    } finally {
      restore();
    }

    const succeeded = outcomes.filter((outcome) => outcome.status === 200);
    const refused = outcomes.filter((outcome) => outcome.status === 409);
    assert.equal(succeeded.length, 1, `expected exactly one demotion to win: ${outcomes[0]?.body}`);
    assert.equal(refused.length, 1);
    assert.equal(errorCode(refused[0]?.body ?? ''), 'LAST_SUPER_ADMIN');

    assert.equal(
      await harness.store.users.countActiveSuperAdmins(),
      1,
      'the portal is never left without an administrator',
    );

    // Put the second seat back for the god-mode case below.
    const survivor =
      (await harness.store.users.findById(founder.user.id))?.role === 'super_admin'
        ? founder
        : other;
    assert.equal((await harness.store.users.findById(survivor.user.id))?.role, 'super_admin');
  });

  it('refuses one of two simultaneous god-mode disables', async () => {
    // Whichever account survived the previous test is the one that can promote.
    const rows = await harness.store.users.listRecipients({
      role: 'super_admin',
      status: 'active',
    });
    assert.equal(rows.length, 1);
    const survivorEmail = rows[0]?.email ?? '';
    founder = await harness.loginUser(survivorEmail);

    const other = await makeSuperAdmin('lsa-peer-disable@example.test');
    assert.equal(await harness.store.users.countActiveSuperAdmins(), 2);

    const restore = barrierOnFirstCounts(2);
    let outcomes: { status: number; body: string }[];
    try {
      const responses = await Promise.all([
        harness.authed(founder, {
          method: 'POST',
          url: '/api/admin/god/disable-user',
          payload: { user_id: other.user.id, reason: 'racing', revoke_grants: false },
        }),
        harness.authed(other, {
          method: 'POST',
          url: '/api/admin/god/disable-user',
          payload: { user_id: founder.user.id, reason: 'racing', revoke_grants: false },
        }),
      ]);
      outcomes = responses.map((response) => ({
        status: response.statusCode,
        body: response.body,
      }));
    } finally {
      restore();
    }

    const succeeded = outcomes.filter((outcome) => outcome.status === 200);
    const refused = outcomes.filter((outcome) => outcome.status === 409);
    assert.equal(succeeded.length, 1, `expected exactly one disable to win: ${outcomes[0]?.body}`);
    assert.equal(refused.length, 1);
    assert.equal(errorCode(refused[0]?.body ?? ''), 'LAST_SUPER_ADMIN');

    assert.equal(
      await harness.store.users.countActiveSuperAdmins(),
      1,
      'god mode cannot lock the portal out of its own administration either',
    );
  });
});

/**
 * The same invariant, but between two Nexus **instances** over one database.
 *
 * The tests above are safe on one process for a reason that does not generalise:
 * a store's transaction bodies are serialised by that store object, so the
 * loser re-counts after the winner committed. A multi-instance deployment has
 * one store object per process and no such ordering — two instances against one
 * PostgreSQL each opened a transaction, each counted the *other* super admin,
 * and both committed. The fix is the `users:super-admins` lease every instance
 * contends for.
 *
 * **SQLite is single-instance by definition** — one file, one connection, no
 * second process — so it cannot host the literal topology. What it can host is
 * the part that matters: two apps, each with its own lock owner and its own
 * transaction scope, over one database. {@link separateInstance} supplies the
 * missing half by giving each app a store facade whose `transaction` does not
 * serialise against the other's, which is exactly the guarantee two connection
 * pools fail to give each other. The lease primitive itself is covered per
 * adapter by the cross-adapter smoke suite.
 */
describe('the last active super_admin across two instances', () => {
  let owner: TestApp;
  let alpha: TestApp;
  let beta: TestApp;

  /**
   * A store facade that behaves like a *different* process's store.
   *
   * Everything is delegated to the real store — the same tables, the same
   * `leases` rows — except `transaction`, which runs the body without joining
   * the shared queue. Two facades therefore interleave their count-then-write
   * the way two pools do, and only a lock in the database can order them.
   */
  function separateInstance(store: NexusStore, gate: Rendezvous): NexusStore {
    const facade = Object.create(store) as NexusStore;
    Object.defineProperty(facade, 'transaction', {
      value: <T>(fn: (tx: NexusStore) => Promise<T>): Promise<T> => fn(facade),
    });
    // Per-instance so each app's own counts are the ones being parked.
    Object.defineProperty(facade, 'users', {
      value: {
        ...store.users,
        countActiveSuperAdmins: async (excludeUserId?: string): Promise<number> => {
          await gate.meet();
          return store.users.countActiveSuperAdmins(excludeUserId);
        },
      } satisfies UserRepo,
    });
    return facade;
  }

  /** Give the portal two active super admins, whoever survived the last case. */
  async function twoSuperAdmins(): Promise<[TestSession, TestSession]> {
    const rows = await owner.store.users.listRecipients({
      role: 'super_admin',
      status: 'active',
    });
    assert.ok(rows.length >= 1, 'a super admin must survive every case');
    const incumbent = await owner.loginUser(rows[0]?.email ?? '');
    const peer = await owner.registerUser();
    const promoted = await owner.authed(incumbent, {
      method: 'PATCH',
      url: `/api/users/${peer.user.id}`,
      payload: { role: 'super_admin' },
    });
    assert.equal(promoted.statusCode, 200, promoted.body);
    assert.equal(await owner.store.users.countActiveSuperAdmins(), 2);
    return [incumbent, { ...peer, user: promoted.json<{ user: User }>().user }];
  }

  /** Assert exactly one winner, a `LAST_SUPER_ADMIN` loser and a surviving admin. */
  async function assertOneWinner(responses: { statusCode: number; body: string }[]): Promise<void> {
    const succeeded = responses.filter((response) => response.statusCode === 200);
    const refused = responses.filter((response) => response.statusCode === 409);
    assert.equal(
      succeeded.length,
      1,
      `expected exactly one to win: ${responses.map((r) => `${r.statusCode} ${r.body}`).join(' | ')}`,
    );
    assert.equal(refused.length, 1);
    assert.equal(errorCode(refused[0]?.body ?? ''), 'LAST_SUPER_ADMIN');
    assert.equal(
      await owner.store.users.countActiveSuperAdmins(),
      1,
      'the portal is never left without an administrator',
    );
  }

  const gate: Rendezvous = rendezvous(2, 250);

  before(async () => {
    owner = await buildTestApp();
    const founder = await owner.registerUser({ email: 'two-instance-founder@example.test' });
    assert.equal(founder.user.role, 'super_admin');
    alpha = await buildTestApp({
      store: separateInstance(owner.store, gate),
      edge: owner.edge,
    });
    beta = await buildTestApp({
      store: separateInstance(owner.store, gate),
      edge: owner.edge,
    });
  });

  after(async () => {
    gate.dispose();
    await alpha.close();
    await beta.close();
    await owner.close();
  });

  it('refuses one of two demotions issued on different instances', async () => {
    const [first, second] = await twoSuperAdmins();
    const responses = await Promise.all([
      alpha.authed(first, {
        method: 'PATCH',
        url: `/api/users/${second.user.id}`,
        payload: { role: 'client' },
      }),
      beta.authed(second, {
        method: 'PATCH',
        url: `/api/users/${first.user.id}`,
        payload: { role: 'client' },
      }),
    ]);
    await assertOneWinner(responses);
  });

  it('refuses one of two disables issued on different instances', async () => {
    const [first, second] = await twoSuperAdmins();
    const responses = await Promise.all([
      alpha.authed(first, {
        method: 'PATCH',
        url: `/api/users/${second.user.id}`,
        payload: { status: 'disabled' },
      }),
      beta.authed(second, {
        method: 'PATCH',
        url: `/api/users/${first.user.id}`,
        payload: { status: 'disabled' },
      }),
    ]);
    await assertOneWinner(responses);
  });

  it('orders a demotion on one instance against a god-mode disable on the other', async () => {
    const [first, second] = await twoSuperAdmins();
    const responses = await Promise.all([
      alpha.authed(first, {
        method: 'PATCH',
        url: `/api/users/${second.user.id}`,
        payload: { role: 'client' },
      }),
      beta.authed(second, {
        method: 'POST',
        url: '/api/admin/god/disable-user',
        payload: {
          user_id: first.user.id,
          reason: 'racing across instances',
          revoke_grants: false,
        },
      }),
    ]);
    await assertOneWinner(responses);
  });
});
