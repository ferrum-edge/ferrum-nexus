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

import type { UserRepo } from '../db/store.js';
import { buildTestApp, type TestApp, type TestSession } from './helpers.js';

function errorCode(body: string): string {
  return (JSON.parse(body) as ApiErrorBody).error.code;
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
