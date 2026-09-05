/**
 * Bootstrap atomicity and recovery (#80).
 *
 * The founding registration used to be three separately committed writes —
 * create the account, claim the election, promote — and a failure between the
 * first and the last left a portal with users and no super admin that the
 * documented bootstrap flow could no longer reach, because "bootstrap" meant
 * "no users". These tests inject a failure after each write the founder's
 * transaction makes and check that nothing survives it and that the very next
 * attempt succeeds; that a portal already stranded by the old code is
 * recoverable through the token and only through the token; and that a fresh
 * server process over the same database, or a second instance racing for the
 * seat, behaves the same way.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type { LightMyRequestResponse } from 'fastify';

import { SESSION_COOKIE, type ApiErrorBody } from '@ferrum-nexus/shared';

import { SUPER_ADMIN_CLAIM_KEY } from '../auth/service.js';
import type { NexusStore, UserRecord } from '../db/store.js';
import { nowIso } from '../lib/ids.js';
import { faultInjectingStore, type FaultInjectingStore } from './fault-injection.js';
import {
  buildTestApp,
  cookieValue,
  TEST_BOOTSTRAP_TOKEN,
  TEST_PASSWORD,
  type TestApp,
} from './helpers.js';

function errorCode(body: string): string {
  return (JSON.parse(body) as ApiErrorBody).error.code;
}

interface RegisteredUser {
  id: string;
  role: string;
  email_verified: boolean;
}

/** `POST /api/auth/register` against `harness` with whatever the case needs. */
function register(
  harness: TestApp,
  email: string,
  payload: Record<string, unknown> = {},
): Promise<LightMyRequestResponse> {
  return harness.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: {
      email,
      password: TEST_PASSWORD,
      display_name: 'Candidate',
      role: 'client',
      ...payload,
    },
  });
}

/** The public signal the sign-up form keys off. */
async function bootstrapRequired(harness: TestApp): Promise<boolean> {
  const response = await harness.app.inject({ method: 'GET', url: '/api/branding' });
  assert.equal(response.statusCode, 200);
  return response.json<{ bootstrap_required: boolean }>().bootstrap_required;
}

/** The founder's transaction left nothing behind and the seat is still open. */
async function assertSeatStillOpen(harness: TestApp, email: string): Promise<void> {
  assert.equal(await harness.store.users.count(), 0, 'no account survived the rollback');
  assert.equal(await harness.store.users.findByEmail(email), null);
  assert.equal(await harness.store.settings.get(SUPER_ADMIN_CLAIM_KEY), null, 'no claim survived');
  assert.equal((await harness.auditRows('auth.register')).length, 0, 'no audit row survived');
  assert.equal(await harness.store.users.countActiveSuperAdmins(), 0);
  assert.equal(await bootstrapRequired(harness), true, 'the portal still advertises bootstrap');
}

/**
 * The state the old code left behind: an account that was created with the
 * role it asked for, a claim recorded in its name, and a promotion that never
 * landed.
 */
async function strandPortal(store: NexusStore): Promise<UserRecord> {
  const stranded = await store.users.create({
    email: 'stranded@example.test',
    password_hash: 'scrypt:16384:8:1:c2FsdA==:aGFzaA==',
    display_name: 'Stranded Founder',
    role: 'client',
    status: 'active',
    email_verified: true,
  });
  await store.settings.set(SUPER_ADMIN_CLAIM_KEY, { user_id: stranded.id, claimed_at: nowIso() });
  return stranded;
}

describe('bootstrap atomicity', () => {
  let harness: TestApp;
  let faults: FaultInjectingStore;

  before(async () => {
    harness = await buildTestApp({
      wrapStore: (store) => {
        faults = faultInjectingStore(store);
        return faults.store;
      },
    });
  });

  after(async () => {
    await harness.close();
  });

  it('rolls the founder back when the claim record cannot be written', async () => {
    // The account insert has succeeded by the time this fires.
    faults.failNext('settings', 'set');
    const response = await register(harness, 'founder@example.test', {
      bootstrap_token: TEST_BOOTSTRAP_TOKEN,
    });

    assert.equal(response.statusCode, 500, response.body);
    assert.equal(cookieValue(response, SESSION_COOKIE), undefined, 'no session is issued');
    assert.deepEqual(faults.pending(), [], 'the failing write was reached');
    await assertSeatStillOpen(harness, 'founder@example.test');
  });

  it('rolls the founder back when the audit row cannot be written', async () => {
    // Account and claim have both succeeded by the time this fires.
    faults.failNext('auditLogs', 'create');
    const response = await register(harness, 'founder@example.test', {
      bootstrap_token: TEST_BOOTSTRAP_TOKEN,
    });

    assert.equal(response.statusCode, 500, response.body);
    assert.deepEqual(faults.pending(), [], 'the failing write was reached');
    await assertSeatStillOpen(harness, 'founder@example.test');
  });

  it('seats the founder on the next attempt', async () => {
    const response = await register(harness, 'founder@example.test', {
      bootstrap_token: TEST_BOOTSTRAP_TOKEN,
    });

    assert.equal(response.statusCode, 201, response.body);
    const user = response.json<{ user: RegisteredUser }>().user;
    assert.equal(user.role, 'super_admin');
    assert.equal(user.email_verified, true);
    assert.ok(cookieValue(response, SESSION_COOKIE), 'the founder lands signed in');

    const claim = await harness.store.settings.get(SUPER_ADMIN_CLAIM_KEY);
    assert.equal((claim?.value as { user_id: string }).user_id, user.id);
    assert.equal(await harness.store.users.countActiveSuperAdmins(), 1);
    assert.equal(await bootstrapRequired(harness), false);

    const audit = await harness.auditRows('auth.register');
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.details.first_user, true);
    assert.equal(audit[0]?.actor_role, 'super_admin');
  });

  it('writes ordinary registrations atomically too, and never a second founder', async () => {
    faults.failNext('auditLogs', 'create');
    const failed = await register(harness, 'member@example.test', {
      bootstrap_token: TEST_BOOTSTRAP_TOKEN,
    });
    assert.equal(failed.statusCode, 500, failed.body);
    assert.equal(await harness.store.users.findByEmail('member@example.test'), null);

    const retried = await register(harness, 'member@example.test', {
      bootstrap_token: TEST_BOOTSTRAP_TOKEN,
    });
    assert.equal(retried.statusCode, 201, retried.body);
    assert.equal(retried.json<{ user: RegisteredUser }>().user.role, 'client');
    assert.equal(await harness.store.users.countActiveSuperAdmins(), 1);
  });
});

describe('bootstrap recovery of a stranded portal', () => {
  let harness: TestApp;
  let stranded: UserRecord;

  before(async () => {
    harness = await buildTestApp();
    stranded = await strandPortal(harness.store);
  });

  after(async () => {
    await harness.close();
  });

  it('advertises bootstrap although accounts exist', async () => {
    assert.equal(await harness.store.users.count(), 1);
    assert.equal(await bootstrapRequired(harness), true);
  });

  it('refuses ordinary registration and wrong tokens, writing nothing', async () => {
    const plain = await register(harness, 'joiner@example.test');
    assert.equal(plain.statusCode, 403, plain.body);
    assert.equal(errorCode(plain.body), 'FORBIDDEN');
    assert.match(plain.body, /bootstrap token/);

    const wrong = await register(harness, 'guesser@example.test', {
      bootstrap_token: `${TEST_BOOTSTRAP_TOKEN}x`,
    });
    assert.equal(wrong.statusCode, 403, wrong.body);

    assert.equal(await harness.store.users.count(), 1, 'only the stranded account exists');
    const claim = await harness.store.settings.get(SUPER_ADMIN_CLAIM_KEY);
    assert.equal((claim?.value as { user_id: string }).user_id, stranded.id, 'claim untouched');
  });

  it('seats a super admin through the token and replaces the stale claim', async () => {
    const response = await register(harness, 'operator@example.test', {
      bootstrap_token: TEST_BOOTSTRAP_TOKEN,
    });

    assert.equal(response.statusCode, 201, response.body);
    const user = response.json<{ user: RegisteredUser }>().user;
    assert.equal(user.role, 'super_admin');
    assert.equal(user.email_verified, true);

    const claim = await harness.store.settings.get(SUPER_ADMIN_CLAIM_KEY);
    assert.equal((claim?.value as { user_id: string }).user_id, user.id);
    assert.equal(await harness.store.users.countActiveSuperAdmins(), 1);
    assert.equal(await bootstrapRequired(harness), false);

    // The stranded account is left exactly as it was: recovery adds an
    // administrator, it does not promote whoever happened to be first.
    const untouched = await harness.store.users.findById(stranded.id);
    assert.equal(untouched?.role, 'client');
  });

  it('treats the token as inert once the seat is taken', async () => {
    const replay = await register(harness, 'replayer@example.test', {
      bootstrap_token: TEST_BOOTSTRAP_TOKEN,
    });
    assert.equal(replay.statusCode, 201, replay.body);
    assert.equal(replay.json<{ user: RegisteredUser }>().user.role, 'client');
    assert.equal(await harness.store.users.countActiveSuperAdmins(), 1);
  });
});

describe('bootstrap across restarts and instances', () => {
  it('a fresh server over the same database recovers from a failed founder', async () => {
    let faults!: FaultInjectingStore;
    let database!: NexusStore;
    const crashed = await buildTestApp({
      wrapStore: (store) => {
        database = store;
        faults = faultInjectingStore(store);
        return faults.store;
      },
    });
    // A second app over the same store models the restarted process: new
    // services, new lock owner, same rows.
    const restarted = await buildTestApp({ store: database, edge: crashed.edge });

    try {
      faults.failNext('settings', 'set');
      const failed = await register(crashed, 'founder@example.test', {
        bootstrap_token: TEST_BOOTSTRAP_TOKEN,
      });
      assert.equal(failed.statusCode, 500, failed.body);
      await assertSeatStillOpen(crashed, 'founder@example.test');
      assert.equal(await bootstrapRequired(restarted), true);

      const recovered = await register(restarted, 'founder@example.test', {
        bootstrap_token: TEST_BOOTSTRAP_TOKEN,
      });
      assert.equal(recovered.statusCode, 201, recovered.body);
      assert.equal(recovered.json<{ user: RegisteredUser }>().user.role, 'super_admin');
      assert.equal(await bootstrapRequired(crashed), false, 'both processes see the founder');
      assert.equal(await bootstrapRequired(restarted), false);
    } finally {
      await restarted.close();
      await crashed.close();
    }
  });

  it('two instances racing for the seat produce exactly one super admin', async () => {
    const first = await buildTestApp();
    const second = await buildTestApp({ store: first.store, edge: first.edge });

    try {
      // Three candidates per instance, every one holding the operator's token,
      // all hashing at once and then contending for the lock.
      const payload = { bootstrap_token: TEST_BOOTSTRAP_TOKEN };
      const inFlight: Promise<LightMyRequestResponse>[] = [];
      [first, second].forEach((instance, which) => {
        for (let index = 0; index < 3; index += 1) {
          inFlight.push(register(instance, `racer-${which}-${index}@example.test`, payload));
        }
      });
      const responses = await Promise.all(inFlight);
      for (const response of responses) assert.equal(response.statusCode, 201, response.body);

      const users = responses.map((response) => response.json<{ user: RegisteredUser }>().user);
      const founders = users.filter((user) => user.role === 'super_admin');
      assert.equal(founders.length, 1, users.map((user) => user.role).join(', '));
      for (const loser of users.filter((user) => user.role !== 'super_admin')) {
        assert.equal(loser.role, 'client', 'losers keep the role they asked for');
      }

      assert.equal(await first.store.users.countActiveSuperAdmins(), 1);
      const claim = await first.store.settings.get(SUPER_ADMIN_CLAIM_KEY);
      assert.equal((claim?.value as { user_id: string }).user_id, founders[0]?.id);
      assert.equal(await bootstrapRequired(second), false);
    } finally {
      await second.close();
      await first.close();
    }
  });
});
