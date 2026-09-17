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
import type { NexusStore } from '../db/store.js';
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

describe('createKeyedSerializer — cross-instance leases', () => {
  let store: NexusStore;
  let keySeed = 0;

  /** A fresh key per test, so nothing leaks between them. */
  function freshKey(): string {
    keySeed += 1;
    return `proxy:test-${keySeed}`;
  }

  /** One "Nexus instance": its own queue, the shared lease table. */
  function instance(owner: string, overrides: KeyedSerializerOptions = {}): KeyedSerializer {
    return createKeyedSerializer({ leases: store.leases, owner, ...FAST, ...overrides });
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
});
