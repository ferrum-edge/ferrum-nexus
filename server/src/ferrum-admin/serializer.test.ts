/**
 * The cross-instance half of `createKeyedSerializer`.
 *
 * Every test here builds **two** serializers over **one** SQLite store, which
 * is the two-Nexus-instances-one-database topology in miniature: the in-process
 * queues are separate (that is the point — they are what used to be the only
 * lock), so anything that orders the two can only be the `edge_leases` row.
 *
 * `client.test.ts` covers the queue on its own, with no lease repository at
 * all, and that stays the documented single-writer behaviour.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { loadConfig } from '../config/index.js';
import { createStore } from '../db/index.js';
import type { LeaseRepo, NexusStore } from '../db/store.js';
import { isNexusError } from '../lib/errors.js';
import { nowIso } from '../lib/ids.js';
import {
  createKeyedSerializer,
  type KeyedSerializer,
  type KeyedSerializerOptions,
} from './index.js';

const SECRET = 'serializer-lease-test-secret-0123456789';

/** Fast lease settings — the production defaults would make this suite a minute. */
const FAST: KeyedSerializerOptions = { ttlMs: 1_000, waitMs: 2_000, pollMs: 5 };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Park a holder until the test explicitly releases it — not a timer. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function yieldTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * A lease table that remembers the token each acquisition wrote and never
 * renews: the holder it serves is one whose renewals stopped landing — the
 * stall issue #384 is about — and the token is what the test needs to expire
 * that holder's row the way the TTL would.
 */
function stallingLeases(inner: LeaseRepo): { repo: LeaseRepo; tokens: Map<string, string> } {
  const tokens = new Map<string, string>();
  return {
    tokens,
    repo: {
      acquire: async (key, owner, expiresAt, now) => {
        const acquired = await inner.acquire(key, owner, expiresAt, now);
        if (acquired) tokens.set(key, owner);
        return acquired;
      },
      release: (key, owner) => inner.release(key, owner),
      renew: async () => false,
      verify: (key, owner) => inner.verify(key, owner),
      deleteExpired: (now) => inner.deleteExpired(now),
    },
  };
}

/** Long past, so a lease renewed to it has lapsed. */
const LAPSED = '2020-01-01T00:00:00.000Z';

/** Far off, so a lease taken until then outlives the test. */
const HELD = '2099-01-01T00:00:00.000Z';

describe('createKeyedSerializer — cross-instance leases', () => {
  let store: NexusStore;
  let keySeed = 0;

  /** A fresh key per test, so nothing leaks between them. */
  function freshKey(): string {
    keySeed += 1;
    return `proxy:test-${keySeed}`;
  }

  /**
   * One "Nexus instance": its own queue, the shared lease table. The name is
   * only a label for the reader — every acquisition writes its own token.
   */
  function instance(_name: string, overrides: KeyedSerializerOptions = {}): KeyedSerializer {
    return createKeyedSerializer({ leases: store.leases, ...FAST, ...overrides });
  }

  before(async () => {
    store = createStore(
      loadConfig({
        NEXUS_SECRET_KEY: SECRET,
        FERRUM_ADMIN_JWT_SECRET: SECRET,
        NEXUS_ENV: 'test',
        NEXUS_DB_DRIVER: 'sqlite',
        NEXUS_SQLITE_PATH: ':memory:',
      }),
    );
    await store.init();
    await store.migrate();
  });

  after(async () => {
    await store.close();
  });

  beforeEach(async () => {
    await store.leases.deleteExpired('9999-01-01T00:00:00.000Z');
  });

  it('holds a second instance out of the same key until the first finishes', async () => {
    const key = freshKey();
    const a = instance('instance-a');
    const b = instance('instance-b');
    const order: string[] = [];
    let aFinishedAt = 0;
    let bStartedAt = 0;
    let bEntered = false;
    const aHolds = deferred();
    const releaseA = deferred();

    const first = a(key, async () => {
      order.push('a:start');
      aHolds.resolve();
      await releaseA.promise;
      order.push('a:end');
      aFinishedAt = Date.now();
    });
    // Wait until A is inside the section (lease taken), not for a timer that
    // can resume after A has already finished.
    await aHolds.promise;
    const second = b(key, async () => {
      bEntered = true;
      order.push('b:start');
      bStartedAt = Date.now();
      order.push('b:end');
    });

    for (let i = 0; i < 5; i += 1) {
      await yieldTurn();
      assert.equal(bEntered, false, 'B must not enter while A still holds the lease');
    }

    releaseA.resolve();
    await Promise.all([first, second]);

    assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'b:end']);
    assert.ok(
      bStartedAt >= aFinishedAt,
      `B started at ${bStartedAt} but A only finished at ${aFinishedAt}`,
    );
  });

  it('lets a second instance run a different key immediately', async () => {
    const held = freshKey();
    const other = freshKey();
    const a = instance('instance-a');
    const b = instance('instance-b');
    const order: string[] = [];
    const aHolds = deferred();
    const releaseA = deferred();

    const first = a(held, async () => {
      order.push('a:start');
      aHolds.resolve();
      await releaseA.promise;
      order.push('a:end');
    });
    await aHolds.promise;
    await b(other, async () => {
      order.push('b:ran');
    });
    // B finished while A is still parked inside its section.
    assert.deepEqual(order, ['a:start', 'b:ran']);

    releaseA.resolve();
    await first;
    assert.deepEqual(order, ['a:start', 'b:ran', 'a:end']);
  });

  it('takes over a lease whose holder expired', async () => {
    const key = freshKey();
    // A crashed instance leaves exactly this: a row nobody will ever release.
    assert.equal(
      await store.leases.acquire(key, 'crashed-instance', '2020-01-01T00:00:00.000Z', nowIso()),
      true,
    );

    const started = Date.now();
    assert.equal(await instance('survivor')(key, async () => 'ran'), 'ran');
    assert.ok(Date.now() - started < 500, 'an expired lease should not be waited out');
  });

  it('reports a CONFLICT when the wait times out', async () => {
    const key = freshKey();
    const a = instance('instance-a');
    const b = instance('instance-b', { waitMs: 60 });
    const aHolds = deferred();
    const releaseA = deferred();

    const first = a(key, async () => {
      aHolds.resolve();
      await releaseA.promise;
    });
    await aHolds.promise;

    await assert.rejects(
      () => b(key, async () => 'never'),
      (error: unknown) => {
        assert.ok(isNexusError(error));
        assert.equal(error.code, 'CONFLICT');
        assert.match(error.message, /another portal instance/i);
        assert.match(error.message, /retry/i);
        return true;
      },
    );

    releaseA.resolve();
    await first;
  });

  it('releases the lease whether the section resolves or throws', async () => {
    const key = freshKey();
    const a = instance('instance-a');
    const b = instance('instance-b', { waitMs: 0 });

    await a(key, async () => 'done');
    assert.equal(await b(key, async () => 'free after success'), 'free after success');

    await assert.rejects(() => a(key, () => Promise.reject(new Error('boom'))), /boom/);
    // `waitMs: 0` gives the lease exactly one attempt, so this only passes if
    // the failed section had already released it.
    assert.equal(await b(key, async () => 'free after throw'), 'free after throw');
  });

  it('renews a section that outlives the lease TTL', async () => {
    const key = freshKey();
    // TTL 60ms means the renewal timer fires every 30ms; the section runs for
    // several TTLs, so without renewal the lease would lapse mid-flight.
    const a = instance('instance-a', { ttlMs: 60 });
    const b = instance('instance-b', { waitMs: 0 });
    const aHolds = deferred();
    const releaseA = deferred();

    let stolen: unknown = null;
    const long = a(key, async () => {
      aHolds.resolve();
      await sleep(300);
      // Still ours: nothing has expired, and nobody could take it.
      stolen = await store.leases.acquire(key, 'instance-b', '2099-01-01T00:00:00.000Z', nowIso());
      await releaseA.promise;
      return 'finished';
    });

    await aHolds.promise;
    // Elapsed TTLs are the behaviour under test here, not overlap. The
    // deferred above is what keeps A from finishing if this timer overruns.
    await sleep(200);
    await assert.rejects(() => b(key, async () => 'never'), /another portal instance/i);

    releaseA.resolve();
    assert.equal(await long, 'finished');
    assert.equal(stolen, false, 'the renewed lease was still live 300ms into a 60ms TTL');
  });
  /* ── Fencing (issue #384) ───────────────────────────────────────────── */

  let emailSeed = 0;

  /** A transaction that writes one user row, so a rollback is observable. */
  async function writeUser(): Promise<string> {
    emailSeed += 1;
    const email = `fenced-${emailSeed}@example.test`;
    await store.transaction(async (tx) => {
      await tx.users.create({
        email,
        password_hash: 'scrypt:16384:8:1:c2FsdA==:aGFzaA==',
        display_name: 'Fenced',
        role: 'client',
        status: 'active',
        email_verified: false,
      });
    });
    return email;
  }

  /** Assert `error` is the fence's refusal. */
  function isLeaseLost(error: unknown): boolean {
    assert.ok(isNexusError(error));
    assert.equal(error.code, 'CONFLICT');
    assert.match(error.message, /another portal instance/i);
    assert.match(error.message, /retry/i);
    return true;
  }

  it('writes a fresh owner token for every acquisition', async () => {
    const key = freshKey();
    const { repo, tokens } = stallingLeases(store.leases);
    const a = createKeyedSerializer({ leases: repo, ...FAST });

    const seen: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      await a(key, async () => {
        const token = tokens.get(key);
        assert.ok(token);
        seen.push(token);
      });
    }
    assert.notEqual(seen[0], seen[1], 'one process, two acquisitions, two tokens');
  });

  it('commits a transaction whose section still holds its key', async () => {
    const key = freshKey();
    const email = await instance('instance-a')(key, () => writeUser());
    assert.ok(await store.users.findByEmail(email));
  });

  it('rolls back a transaction whose lease was taken over while its holder stalled', async () => {
    const key = freshKey();
    const { repo, tokens } = stallingLeases(store.leases);
    const a = createKeyedSerializer({ leases: repo, ...FAST });
    let email = '';

    await assert.rejects(
      () =>
        a(key, async () => {
          const token = tokens.get(key);
          assert.ok(token);
          // The stall: A's lease lapses, and instance B takes the key and acts.
          assert.equal(await store.leases.renew(key, token, LAPSED), true);
          assert.equal(await store.leases.acquire(key, 'instance-b', HELD, nowIso()), true);
          // A resumes and writes as though it still held the key.
          email = `fenced-stale-${keySeed}@example.test`;
          await store.transaction(async (tx) => {
            await tx.users.create({
              email,
              password_hash: 'scrypt:16384:8:1:c2FsdA==:aGFzaA==',
              display_name: 'Stale',
              role: 'client',
              status: 'active',
              email_verified: false,
            });
          });
        }),
      isLeaseLost,
    );

    assert.equal(await store.users.findByEmail(email), null, 'the stale write never committed');
    assert.equal(
      await store.leases.release(key, 'instance-b'),
      true,
      "the stale holder's release left the new owner's row alone",
    );
  });

  it('commits for a holder whose lease lapsed but was never taken over', async () => {
    // Nobody can have acted under the key without acquiring it, which would
    // have replaced the token — so the lapsed holder is still the only one.
    const key = freshKey();
    const { repo, tokens } = stallingLeases(store.leases);
    const a = createKeyedSerializer({ leases: repo, ...FAST });

    const email = await a(key, async () => {
      const token = tokens.get(key);
      assert.ok(token);
      assert.equal(await store.leases.renew(key, token, LAPSED), true);
      return writeUser();
    });
    assert.ok(await store.users.findByEmail(email));
  });

  it('fences a transaction by every key its nested sections hold', async () => {
    const outer = freshKey();
    const inner = freshKey();
    const { repo, tokens } = stallingLeases(store.leases);
    const a = createKeyedSerializer({ leases: repo, ...FAST });

    await assert.rejects(
      () =>
        a(outer, () =>
          a(inner, async () => {
            const token = tokens.get(outer);
            assert.ok(token);
            // Only the *outer* key changes hands; the inner one is still held.
            assert.equal(await store.leases.renew(outer, token, LAPSED), true);
            assert.equal(await store.leases.acquire(outer, 'instance-b', HELD, nowIso()), true);
            await writeUser();
          }),
        ),
      isLeaseLost,
    );
    assert.equal(await store.leases.release(outer, 'instance-b'), true);
  });

  it('leaves unfenced the work a section merely started and outlived', async () => {
    const key = freshKey();
    const later = deferred();
    let detached: Promise<string> | undefined;

    await instance('instance-a')(key, async () => {
      // Started inside the section, run after it: it never held the key, so
      // the key changing hands afterwards is none of its business.
      detached = later.promise.then(() => writeUser());
    });
    assert.equal(await store.leases.acquire(key, 'instance-b', HELD, nowIso()), true);
    later.resolve();

    assert.ok(detached);
    const email = await detached;
    assert.ok(await store.users.findByEmail(email));
    assert.equal(await store.leases.release(key, 'instance-b'), true);
  });
});
