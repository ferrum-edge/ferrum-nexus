/**
 * The retry policy, and the store shell that drives it.
 *
 * The engine-level halves of this — a real InnoDB deadlock, a real MongoDB
 * write conflict — live in the cross-adapter suite, which needs real servers.
 * What is provable without one is everything either side of the driver: which
 * errors count as "run it again", how many times and how long apart, that a
 * body really is re-run and committed once, and that nothing driver-shaped
 * reaches a caller when the budget runs out.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MongoServerError } from 'mongodb';

import type { DbDriver } from '@ferrum-nexus/shared';

import { isNexusError, NexusError } from '../../lib/errors.js';
import type { StoreHealth } from '../store.js';
import type { SqlExecutor } from './sql-common.js';
import { createSqlStore, type SqlStoreBackend } from './sql-repos.js';
import {
  isMongoTransactionContentionError,
  isMysqlRetryableTransactionError,
  isPostgresRetryableTransactionError,
  runWithTransactionRetry,
  TRANSACTION_RETRY_ATTEMPTS,
  TRANSACTION_RETRY_BASE_DELAY_MS,
  TRANSACTION_RETRY_MAX_DELAY_MS,
  transactionRetryDelayMs,
} from './transaction-retry.js';

/* ── Error fixtures ─────────────────────────────────────────────────────── */

/** What mysql2 raises when InnoDB picks this connection as the deadlock victim. */
function mysqlDeadlock(): Error {
  return Object.assign(
    new Error('Deadlock found when trying to get lock; try restarting transaction'),
    { code: 'ER_LOCK_DEADLOCK', errno: 1213, sqlState: '40001' },
  );
}

/** What `pg` raises for a serialization failure. */
function postgresSerializationFailure(): Error {
  return Object.assign(new Error('could not serialize access due to concurrent update'), {
    code: '40001',
  });
}

/* ── Classification ─────────────────────────────────────────────────────── */

describe('transaction retry — classification', () => {
  it('MySQL: deadlock victims and lock wait timeouts are retryable', () => {
    assert.equal(isMysqlRetryableTransactionError(mysqlDeadlock()), true);
    assert.equal(
      isMysqlRetryableTransactionError(
        Object.assign(new Error('Lock wait timeout exceeded'), {
          code: 'ER_LOCK_WAIT_TIMEOUT',
          errno: 1205,
          sqlState: 'HY000',
        }),
      ),
      true,
      'a lock wait timeout carries no 40001, so the code is what classifies it',
    );
    assert.equal(
      isMysqlRetryableTransactionError(Object.assign(new Error('victim'), { errno: 1213 })),
      true,
      'errno alone is enough',
    );
    assert.equal(
      isMysqlRetryableTransactionError(
        Object.assign(new Error('rolled back'), { sqlState: '40001' }),
      ),
      true,
      'SQLSTATE alone is enough',
    );
  });

  it('MySQL: a duplicate key, a dropped connection and a plain error are not', () => {
    assert.equal(
      isMysqlRetryableTransactionError(
        Object.assign(new Error('Duplicate entry'), {
          code: 'ER_DUP_ENTRY',
          errno: 1062,
          sqlState: '23000',
        }),
      ),
      false,
    );
    assert.equal(
      isMysqlRetryableTransactionError(
        Object.assign(new Error('Connection lost'), { code: 'PROTOCOL_CONNECTION_LOST' }),
      ),
      false,
    );
    assert.equal(isMysqlRetryableTransactionError(new Error('boom')), false);
    assert.equal(isMysqlRetryableTransactionError(null), false);
    assert.equal(isMysqlRetryableTransactionError('40001'), false);
  });

  it('PostgreSQL: only the class-40 serialization codes are retryable', () => {
    assert.equal(isPostgresRetryableTransactionError(postgresSerializationFailure()), true);
    assert.equal(
      isPostgresRetryableTransactionError(
        Object.assign(new Error('deadlock detected'), { code: '40P01' }),
      ),
      true,
    );
    assert.equal(
      isPostgresRetryableTransactionError(
        Object.assign(new Error('duplicate key value'), { code: '23505' }),
      ),
      false,
    );
    assert.equal(isPostgresRetryableTransactionError(new Error('boom')), false);
  });

  it('MongoDB: transient labels, write conflicts and an expired budget are contention', () => {
    const conflictError = new MongoServerError({
      message: 'Write conflict during plan execution',
      code: 112,
      errorLabels: ['TransientTransactionError'],
    });
    assert.equal(isMongoTransactionContentionError(conflictError), true);
    assert.equal(
      isMongoTransactionContentionError(new MongoServerError({ message: 'conflict', code: 112 })),
      true,
      'the write conflict code classifies even without the label',
    );
    assert.equal(
      isMongoTransactionContentionError({ errorLabels: ['UnknownTransactionCommitResult'] }),
      true,
      'a commit whose result is unknown is the other half of the envelope',
    );
    assert.equal(
      isMongoTransactionContentionError({ name: 'MongoOperationTimeoutError' }),
      true,
      'this is how the wall-clock budget expires',
    );
    assert.equal(
      isMongoTransactionContentionError(
        new MongoServerError({ message: 'duplicate key', code: 11000 }),
      ),
      false,
    );
    assert.equal(isMongoTransactionContentionError(new Error('boom')), false);
  });
});

/* ── Backoff ────────────────────────────────────────────────────────────── */

describe('transaction retry — backoff', () => {
  it('grows exponentially, stays inside the jitter band and is capped', () => {
    for (const attempt of [1, 2, 3, 4, 5, 6, 10, 20]) {
      const step = Math.min(
        TRANSACTION_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
        TRANSACTION_RETRY_MAX_DELAY_MS,
      );
      assert.equal(transactionRetryDelayMs(attempt, () => 0), Math.round(step / 2));
      assert.equal(transactionRetryDelayMs(attempt, () => 1), step);
      const middle = transactionRetryDelayMs(attempt, () => 0.5);
      assert.ok(middle >= step / 2 && middle <= step, `attempt ${attempt} stays in the band`);
    }
  });

  it('two victims of one deadlock do not wake up together', () => {
    const first = transactionRetryDelayMs(3, () => 0.1);
    const second = transactionRetryDelayMs(3, () => 0.9);
    assert.notEqual(first, second);
  });
});

/* ── The loop ───────────────────────────────────────────────────────────── */

describe('transaction retry — the loop', () => {
  const retryable = isMysqlRetryableTransactionError;

  it('re-runs a body the engine rolled back and returns its result', async () => {
    let attempts = 0;
    const slept: number[] = [];
    const result = await runWithTransactionRetry(
      async () => {
        attempts += 1;
        if (attempts === 1) throw mysqlDeadlock();
        return 'committed';
      },
      {
        driver: 'mysql',
        retryable,
        random: () => 0.5,
        sleep: async (ms) => {
          slept.push(ms);
        },
      },
    );
    assert.equal(result, 'committed');
    assert.equal(attempts, 2);
    assert.equal(slept.length, 1, 'one backoff, between the two attempts');
  });

  it('gives up after the attempt budget, keeping the driver error as the cause', async () => {
    let attempts = 0;
    const cause = mysqlDeadlock();
    const error = await runWithTransactionRetry(
      async () => {
        attempts += 1;
        throw cause;
      },
      { driver: 'mysql', retryable, sleep: async () => undefined },
    ).then(
      () => null,
      (thrown: unknown) => thrown,
    );

    assert.equal(attempts, TRANSACTION_RETRY_ATTEMPTS);
    assert.ok(isNexusError(error), 'no driver error reaches the caller');
    assert.equal((error as NexusError).code, 'CONFLICT');
    assert.deepEqual((error as NexusError).details, {
      reason: 'transaction_contention',
      driver: 'mysql',
      attempts: TRANSACTION_RETRY_ATTEMPTS,
    });
    assert.equal((error as NexusError).cause, cause);
  });

  it('runs a body exactly once under { retry: false } and still translates the error', async () => {
    let attempts = 0;
    await assert.rejects(
      runWithTransactionRetry(
        async () => {
          attempts += 1;
          throw mysqlDeadlock();
        },
        { driver: 'mysql', retryable, retry: false, sleep: async () => undefined },
      ),
      (error: unknown) => isNexusError(error) && error.code === 'CONFLICT',
    );
    assert.equal(attempts, 1);
  });

  it('passes anything else through untouched, including a body NexusError', async () => {
    const raised = new NexusError('NOT_FOUND', 'gone');
    await assert.rejects(
      runWithTransactionRetry(async () => Promise.reject(raised), { driver: 'mysql', retryable }),
      (error: unknown) => error === raised,
    );

    let attempts = 0;
    await assert.rejects(
      runWithTransactionRetry(
        async () => {
          attempts += 1;
          throw Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY', errno: 1062 });
        },
        { driver: 'mysql', retryable },
      ),
      (error: unknown) => !isNexusError(error),
    );
    assert.equal(attempts, 1, 'a uniqueness violation is not contention');
  });
});

/* ── Through the SQL store shell ────────────────────────────────────────── */

/** A backend whose transactions fail on demand, without a database behind it. */
class ScriptedBackend implements SqlStoreBackend {
  readonly driver: DbDriver = 'mysql';

  readonly pool: SqlExecutor = {
    dialect: 'mysql',
    query: async () => [],
    execute: async () => 0,
  };

  /** One entry per attempt that should be rolled back instead of committed. */
  failures: unknown[] = [];

  commits = 0;

  rollbacks = 0;

  async init(): Promise<void> {}

  async migrate(): Promise<void> {}

  async close(): Promise<void> {}

  async healthCheck(): Promise<StoreHealth> {
    return { ok: true, latencyMs: 0, error: null };
  }

  async withTransaction<T>(fn: (exec: SqlExecutor) => Promise<T>): Promise<T> {
    const result = await fn(this.pool);
    if (this.failures.length > 0) {
      // The engine rejected the commit: the attempt's work is gone by the time
      // the caller sees the error, which is what makes a retry safe.
      this.rollbacks += 1;
      throw this.failures.shift();
    }
    this.commits += 1;
    return result;
  }

  isRetryableTransactionError(error: unknown): boolean {
    return isMysqlRetryableTransactionError(error);
  }
}

describe('transaction retry — through the store shell', () => {
  it('re-runs the body and commits exactly once', async () => {
    const backend = new ScriptedBackend();
    backend.failures = [mysqlDeadlock()];
    const store = createSqlStore(backend);

    let bodyRuns = 0;
    const value = await store.transaction(async () => {
      bodyRuns += 1;
      return bodyRuns;
    });

    assert.equal(bodyRuns, 2, 'the deadlocked attempt ran, then the body ran again');
    assert.equal(value, 2, 'the caller gets the attempt that committed');
    assert.equal(backend.rollbacks, 1);
    assert.equal(backend.commits, 1, 'exactly one commit, never two');
  });

  it('keeps bodies serialised while retrying', async () => {
    const backend = new ScriptedBackend();
    backend.failures = [mysqlDeadlock()];
    const store = createSqlStore(backend);
    const order: string[] = [];

    const first = store.transaction(async () => {
      order.push('first');
      await Promise.resolve();
      order.push('first done');
    });
    const second = store.transaction(async () => {
      order.push('second');
    });
    await Promise.all([first, second]);

    assert.deepEqual(order, ['first', 'first done', 'first', 'first done', 'second']);
  });

  it('surfaces a CONFLICT once the budget is spent, never the driver error', async () => {
    const backend = new ScriptedBackend();
    backend.failures = Array.from({ length: TRANSACTION_RETRY_ATTEMPTS }, () => mysqlDeadlock());
    const store = createSqlStore(backend);

    let bodyRuns = 0;
    await assert.rejects(
      store.transaction(async () => {
        bodyRuns += 1;
      }),
      (error: unknown) => isNexusError(error) && error.code === 'CONFLICT',
    );
    assert.equal(bodyRuns, TRANSACTION_RETRY_ATTEMPTS);
    assert.equal(backend.commits, 0);
  });

  it('honours { retry: false } for a body that must not run twice', async () => {
    const backend = new ScriptedBackend();
    backend.failures = [mysqlDeadlock()];
    const store = createSqlStore(backend);

    let bodyRuns = 0;
    await assert.rejects(
      store.transaction(
        async () => {
          bodyRuns += 1;
        },
        { retry: false },
      ),
      (error: unknown) => isNexusError(error) && error.code === 'CONFLICT',
    );
    assert.equal(bodyRuns, 1, 'the body ran exactly once');
  });

  it('leaves a nested transaction to the body it is already inside', async () => {
    const backend = new ScriptedBackend();
    backend.failures = [mysqlDeadlock()];
    const store = createSqlStore(backend);

    let inner = 0;
    await store.transaction(async (tx) => {
      await tx.transaction(async () => {
        inner += 1;
      });
    });

    assert.equal(inner, 2, 'the nested body re-runs with the outer one, not on its own');
    assert.equal(backend.commits, 1);
  });
});
