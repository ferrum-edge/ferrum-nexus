/**
 * Expired sessions and single-use links are purged (issue #338), and so are
 * expired gateway leases (issue #675).
 *
 * The store always had `deleteExpired` for both tables, but nothing called
 * either, so every session and every verification/reset link ever issued stayed
 * in the database for good. These drive the composed worker one pass at a time
 * and check it deletes exactly the rows past their `expires_at`.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createExpirySweepWorker } from '../auth/expiry-sweep.js';
import type { NexusStore } from '../db/store.js';
import { isoInSeconds, newId, nowIso } from '../lib/ids.js';
import { buildTestApp, type TestApp, type TestSession } from './helpers.js';

describe('expiry sweep', () => {
  let harness: TestApp;
  let owner: TestSession;

  before(async () => {
    harness = await buildTestApp();
    owner = await harness.registerUser();
  });

  after(async () => {
    await harness?.close();
  });

  async function seedSession(expiresInSeconds: number): Promise<string> {
    const crypto = harness.app.nexus.crypto;
    const hash = crypto.hashToken(crypto.newSessionToken());
    await harness.store.sessions.create({
      token_hash: hash,
      user_id: owner.user.id,
      csrf_token: crypto.newSessionToken(),
      expires_at: isoInSeconds(expiresInSeconds),
      ip: null,
      user_agent: null,
    });
    return hash;
  }

  async function seedToken(
    purpose: 'email_verification' | 'password_reset',
    expiresInSeconds: number,
  ): Promise<string> {
    const crypto = harness.app.nexus.crypto;
    const hash = crypto.hashToken(crypto.newSessionToken());
    await harness.store.verificationTokens.create({
      user_id: owner.user.id,
      token_hash: hash,
      purpose,
      expires_at: isoInSeconds(expiresInSeconds),
    });
    return hash;
  }

  /** A lease row under a fresh key, as a holder that never released it leaves it. */
  async function seedLease(expiresInSeconds: number): Promise<{ key: string; owner: string }> {
    const lease = { key: `sweep-test:${newId()}`, owner: newId() };
    const acquired = await harness.store.leases.acquire(
      lease.key,
      lease.owner,
      isoInSeconds(expiresInSeconds),
      nowIso(),
    );
    assert.equal(acquired, true);
    return lease;
  }

  it('is composed, and idle under NEXUS_ENV=test until a test ticks it', () => {
    assert.equal(harness.services.expirySweep.isRunning(), false);
  });

  it('deletes expired sessions and tokens and keeps the live ones', async () => {
    const expiredSession = await seedSession(-60);
    const liveSession = await seedSession(3600);
    const expiredReset = await seedToken('password_reset', -60);
    const expiredVerification = await seedToken('email_verification', -1);
    const liveReset = await seedToken('password_reset', 3600);
    // A lease left behind by a crashed holder or a failed release, for a key
    // nothing acquires again (a deleted consumer's, say), and a held one.
    const expiredLease = await seedLease(-60);
    const liveLease = await seedLease(3600);

    const result = await harness.services.expirySweep.tick();
    assert.deepEqual(result, { sessions: 1, verificationTokens: 2, leases: 1 });

    assert.equal(await harness.store.sessions.findByTokenHash(expiredSession), null);
    assert.ok(await harness.store.sessions.findByTokenHash(liveSession));
    assert.equal(
      await harness.store.verificationTokens.findByTokenHash(expiredReset, 'password_reset'),
      null,
    );
    assert.equal(
      await harness.store.verificationTokens.findByTokenHash(
        expiredVerification,
        'email_verification',
      ),
      null,
    );
    assert.ok(await harness.store.verificationTokens.findByTokenHash(liveReset, 'password_reset'));
    assert.equal(await harness.store.leases.verify(expiredLease.key, expiredLease.owner), false);
    assert.equal(await harness.store.leases.verify(liveLease.key, liveLease.owner), true);
    assert.equal(await harness.store.leases.release(liveLease.key, liveLease.owner), true);

    // The session the owner signed in with is untouched and still works.
    const me = await harness.authed(owner, { method: 'GET', url: '/api/auth/me' });
    assert.equal(me.statusCode, 200, me.body);

    // A second pass has nothing left to do.
    assert.deepEqual(await harness.services.expirySweep.tick(), {
      sessions: 0,
      verificationTokens: 0,
      leases: 0,
    });
  });

  it('logs a failing table and still sweeps the other', async () => {
    const expired = await seedToken('email_verification', -60);
    const failing: NexusStore = Object.create(harness.store) as NexusStore;
    Object.defineProperty(failing, 'sessions', {
      value: {
        ...harness.store.sessions,
        deleteExpired: async (): Promise<number> => {
          throw new Error('injected sweep failure');
        },
      },
    });
    const logged: string[] = [];
    const worker = createExpirySweepWorker({
      store: failing,
      log: (obj) => logged.push(String(obj.table)),
    });

    assert.deepEqual(await worker.tick(), { sessions: 0, verificationTokens: 1, leases: 0 });
    assert.deepEqual(logged, ['sessions']);
    assert.equal(
      await harness.store.verificationTokens.findByTokenHash(expired, 'email_verification'),
      null,
    );
  });

  it('runs a pass on start and stops cleanly', async () => {
    const expired = await seedSession(-60);
    const worker = createExpirySweepWorker({ store: harness.store, intervalMs: 60_000 });
    worker.start();
    worker.start();
    assert.equal(worker.isRunning(), true);
    await worker.stop();
    assert.equal(worker.isRunning(), false);
    // `stop()` waited for the pass `start()` kicked off.
    assert.equal(await harness.store.sessions.findByTokenHash(expired), null);
    await worker.stop();
  });
});
