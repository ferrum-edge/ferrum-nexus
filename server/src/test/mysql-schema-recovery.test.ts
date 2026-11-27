/**
 * Creating the MySQL base schema across interruptions and concurrent starts.
 * MySQL DDL commits on its own, so the schema is a file of replayable
 * `CREATE TABLE IF NOT EXISTS` statements, recorded last, under one database
 * advisory lock (`db/adapters/mysql/schema.ts`). These run when
 * `NEXUS_TEST_MYSQL_URL` is set, as the CI `store-contracts (mysql)` lane does.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import mysql from 'mysql2/promise';
import {
  ensureMysqlSchema,
  migrationSteps,
  mysqlSchemaLockName,
} from '../db/adapters/mysql/schema.js';
import { sqlMigration } from '../db/migrate.js';
import { loadBaseSchema, splitSqlStatements } from '../db/schema.js';

const WHITESPACE_RUN = /\s+/g;
const HYPHENS = /-/g;
const NOT_REPLAYABLE = /not a replayable CREATE TABLE IF NOT EXISTS/;
const NEWER = /a newer release upgraded it/;
const INTERRUPTED = /interrupted part-way/;
const TWICE = /changes column users\.probe_note twice/;
const UNSUPPORTED = /unsupported non-replayable DDL/;
const IF_EXISTS = /uses an IF \[NOT\] EXISTS form/;
const BUSY = /holds the MySQL schema migration lock/;

/**
 * A forward migration using every statement kind a MySQL migration may
 * contain, each on its own object.
 */
const PROBE = sqlMigration(
  '016_recovery_probe',
  '016_recovery_probe.mysql.sql',
  `
  CREATE TABLE recovery_probe (
    id VARCHAR(64) NOT NULL, note TEXT NULL, PRIMARY KEY (id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
  ALTER TABLE users ADD COLUMN recovery_probe_note VARCHAR(64) NULL;
  CREATE INDEX ix_recovery_probe_users ON users (recovery_probe_note);
  ALTER TABLE recovery_probe MODIFY COLUMN note LONGTEXT DEFAULT NULL;
  ALTER TABLE users ADD COLUMN recovery_probe_flag INT NOT NULL DEFAULT 0;
  ALTER TABLE users ADD CONSTRAINT ck_users_recovery_probe_flag CHECK (recovery_probe_flag IN (0, 1));
  `,
);

const adminUrl = process.env.NEXUS_TEST_MYSQL_URL;
const base = loadBaseSchema('mysql');
const normalize = (sql: string) => sql.replace(WHITESPACE_RUN, ' ').trim();
const interruption = 'fixture interruption at a committed schema boundary';
const INTERRUPTION = new RegExp(interruption);

type Fault = (
  method: string,
  sql: string,
  params: unknown,
  after: boolean,
  connection: mysql.PoolConnection,
) => void | Promise<void>;
function intercept(pool: mysql.Pool, fault: Fault): mysql.Pool {
  return new Proxy(pool, {
    get(target, property) {
      if (property !== 'getConnection') return Reflect.get(target, property);
      return async () => {
        const connection = await pool.getConnection();
        return new Proxy(connection, {
          get(targetConnection, member) {
            const original = Reflect.get(targetConnection, member);
            if (typeof original !== 'function') return original;
            if (!['query', 'execute', 'commit'].includes(String(member)))
              return original.bind(targetConnection);
            return async (...args: unknown[]) => {
              await fault(String(member), String(args[0] ?? ''), args[1], false, targetConnection);
              const result = await original.apply(targetConnection, args);
              await fault(String(member), String(args[0] ?? ''), args[1], true, targetConnection);
              return result;
            };
          },
        });
      };
    },
  });
}

async function fixture<T>(body: (pool: mysql.Pool, url: string) => Promise<T>): Promise<T> {
  const database = `nexus_recovery_${randomUUID().replace(HYPHENS, '')}`;
  const admin = await mysql.createConnection(adminUrl!);
  const target = new URL(adminUrl!);
  target.pathname = `/${database}`;
  await admin.query(`CREATE DATABASE \`${database}\``);
  const pool = mysql.createPool(target.toString());
  try {
    return await body(pool, target.toString());
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE \`${database}\``);
    await admin.end();
  }
}

async function schema(pool: mysql.Pool): Promise<string[]> {
  const [tables] = await pool.query<mysql.RowDataPacket[]>(
    'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME',
  );
  const definitions: string[] = [];
  for (const table of tables) {
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      `SHOW CREATE TABLE \`${table.TABLE_NAME}\``,
    );
    definitions.push(String(rows[0]!['Create Table']));
  }
  return definitions;
}

async function sessionState(pool: mysql.Pool): Promise<{ id: number; lockWaitTimeout: number }> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    'SELECT CONNECTION_ID() AS id, @@SESSION.lock_wait_timeout AS lock_wait_timeout',
  );
  return { id: Number(rows[0]?.id), lockWaitTimeout: Number(rows[0]?.lock_wait_timeout) };
}

async function assertSchemaLockAvailable(pool: mysql.Pool, url: string): Promise<void> {
  const database = new URL(url).pathname.slice(1);
  const digest = createHash('sha256').update(database).digest('hex').slice(0, 32);
  const name = `nexus:migrations:${digest}`;
  const observer = await pool.getConnection();
  try {
    // A discarded connection may take a moment to disconnect server-side.
    const [locks] = await observer.execute<mysql.RowDataPacket[]>(
      'SELECT GET_LOCK(?, 5) AS acquired',
      [name],
    );
    assert.equal(Number(locks[0]?.acquired), 1, 'the creator no longer owns the advisory lock');
  } finally {
    try {
      await observer.execute('SELECT RELEASE_LOCK(?)', [name]);
    } finally {
      observer.release();
    }
  }
}

async function restartAndVerify(pool: mysql.Pool, url: string, expected: string[]): Promise<void> {
  // A fresh pool/connection cannot rely on any state from the interrupted runner.
  const restarted = mysql.createPool(url);
  try {
    await ensureMysqlSchema(restarted);
    const [ledger] = await restarted.query<mysql.RowDataPacket[]>(
      'SELECT id FROM schema_migrations ORDER BY id',
    );
    assert.deepEqual(
      ledger.map((row) => row.id),
      [base.id],
    );
    const [before] = await restarted.query('SELECT * FROM schema_migrations ORDER BY id');
    await ensureMysqlSchema(restarted);
    const [after] = await restarted.query('SELECT * FROM schema_migrations ORDER BY id');
    assert.deepEqual(after, before);
    assert.deepEqual(await schema(restarted), expected);
    const [preserved] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT name FROM organizations WHERE id = 'preserved'",
    );
    assert.equal(preserved[0]?.name, 'Survives restart');
  } finally {
    await restarted.end();
  }
}

/** Drop every table, leaving the fixture database empty. */
async function resetDatabase(pool: mysql.Pool): Promise<void> {
  const [tables] = await pool.query<mysql.RowDataPacket[]>(
    'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()',
  );
  // One connection: FOREIGN_KEY_CHECKS is per session.
  const connection = await pool.getConnection();
  try {
    await connection.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const table of tables) {
      await connection.query(`DROP TABLE \`${String(table.TABLE_NAME)}\``);
    }
    await connection.query('SET FOREIGN_KEY_CHECKS = 1');
  } finally {
    connection.release();
  }
}

describe('MySQL base schema recovery', { skip: !adminUrl, timeout: 600_000 }, () => {
  it('resumes after every committed CREATE and before recording the schema', async () => {
    const expected = await fixture(async (pool) => {
      await ensureMysqlSchema(pool);
      return schema(pool);
    });
    const statements = splitSqlStatements(base.sql);
    for (const boundary of [...statements, 'ledger']) {
      await fixture(async (pool, url) => {
        let fired = false;
        const faulty = intercept(pool, (method, sql, _params, after) => {
          if (fired) return;
          const ledger =
            boundary === 'ledger' &&
            method === 'execute' &&
            !after &&
            sql.startsWith('INSERT INTO schema_migrations ');
          const ddl = method === 'query' && after && normalize(sql) === normalize(boundary);
          if (ledger || ddl) {
            fired = true;
            throw new Error(interruption);
          }
        });
        await assert.rejects(() => ensureMysqlSchema(faulty), INTERRUPTION);
        assert.ok(fired, boundary);
        // The first CREATE installs organizations. Replaying the incomplete
        // schema must preserve data already in a successfully created table.
        await pool.query(`INSERT INTO organizations (id, name, created_at, updated_at)
          VALUES ('preserved', 'Survives restart', '2026-01-01', '2026-01-01')`);
        await restartAndVerify(pool, url, expected);
      });
    }
  });

  it('rejects a non-replayable statement before creating application tables', async () => {
    await fixture(async (pool) => {
      await assert.rejects(
        () =>
          ensureMysqlSchema(pool, {
            ...base,
            sql: base.sql + '\nALTER TABLE users ADD COLUMN obsolete TEXT;',
          }),
        NOT_REPLAYABLE,
      );
      const [rows] = await pool.query<mysql.RowDataPacket[]>(
        'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()',
      );
      assert.deepEqual(
        rows.map((row) => row.TABLE_NAME),
        ['schema_migrations'],
      );
    });
  });

  it('caps schema metadata waits and restores successful sessions', async () => {
    await fixture(async (pool, url) => {
      const creator = mysql.createPool({ uri: url, connectionLimit: 1 });
      const operations = [
        'CREATE TABLE',
        'SELECT id, checksum, state FROM schema_migrations',
        'INSERT INTO schema_migrations',
      ];
      const observed = new Set<string>();
      try {
        for (const [round, original] of [123, 1].entries()) {
          // Each round starts from an empty database, so both create the schema.
          if (round > 0) await resetDatabase(pool);
          await creator.query('SET SESSION lock_wait_timeout = ?', [original]);
          const before = await sessionState(creator);
          const checked = intercept(creator, async (_method, sql, _params, after, connection) => {
            const operation = operations.find((prefix) => sql.startsWith(prefix));
            if (after || !operation) return;
            const [settings] = await connection.query<mysql.RowDataPacket[]>(
              'SELECT @@SESSION.lock_wait_timeout AS lock_wait_timeout',
            );
            assert.equal(Number(settings[0]?.lock_wait_timeout), Math.min(original, 30));
            observed.add(operation);
          });
          await ensureMysqlSchema(checked);
          assert.deepEqual(await sessionState(creator), before);
          await assertSchemaLockAvailable(pool, url);
        }
        for (const operation of operations) assert.ok(observed.has(operation), operation);
        for (const invalid of [0, 31, 1.5]) {
          await assert.rejects(
            () => ensureMysqlSchema(creator, base, { lockWaitTimeoutSeconds: invalid }),
            RangeError,
          );
        }
      } finally {
        await creator.end();
      }
    });
  });

  it('restores the session when the timeout SET acknowledgement is lost', async () => {
    await fixture(async (pool, url) => {
      const creator = mysql.createPool({ uri: url, connectionLimit: 1 });
      try {
        await creator.query('SET SESSION lock_wait_timeout = 123');
        const before = await sessionState(creator);
        let fired = false;
        const faulty = intercept(creator, (method, sql, params, after) => {
          if (
            !fired &&
            method === 'query' &&
            after &&
            sql === 'SET SESSION lock_wait_timeout = ?' &&
            Array.isArray(params) &&
            params[0] === 30
          ) {
            fired = true;
            throw new Error(interruption);
          }
        });
        await assert.rejects(() => ensureMysqlSchema(faulty), INTERRUPTION);
        assert.ok(fired);
        assert.deepEqual(await sessionState(creator), before);
        const [tables] = await pool.query<mysql.RowDataPacket[]>(
          'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()',
        );
        assert.equal(tables.length, 0);
        await ensureMysqlSchema(creator);
      } finally {
        await creator.end();
      }
    });
  });

  it('discards uncertain sessions after failed schema cleanup', async () => {
    for (const cleanup of ['restore', 'release']) {
      for (const after of [false, true]) {
        await fixture(async (pool, url) => {
          const creator = mysql.createPool({ uri: url, connectionLimit: 1 });
          try {
            await creator.query('SET SESSION lock_wait_timeout = 123');
            const before = await sessionState(creator);
            const aborted = new Error(interruption);
            aborted.name = 'AbortError';
            let fired = false;
            const faulty = intercept(creator, (method, sql, params, completed) => {
              if (
                method === 'query' &&
                !completed &&
                sql.startsWith('CREATE TABLE IF NOT EXISTS organizations')
              ) {
                throw aborted;
              }
              const restore =
                cleanup === 'restore' &&
                sql === 'SET SESSION lock_wait_timeout = ?' &&
                Array.isArray(params) &&
                params[0] === 123;
              const release = cleanup === 'release' && sql.startsWith('SELECT RELEASE_LOCK(');
              if (completed === after && ((method === 'query' && restore) || release)) {
                fired = true;
                throw new Error('fixture cleanup failure');
              }
            });
            await assert.rejects(
              () => ensureMysqlSchema(faulty),
              (error: unknown) => error instanceof Error && error.cause === aborted,
            );
            assert.ok(fired, `${cleanup}: ${after ? 'lost acknowledgement' : 'before write'}`);
            const replacement = await sessionState(creator);
            assert.notEqual(replacement.id, before.id, 'the uncertain session was discarded');
            const [settings] = await pool.query<mysql.RowDataPacket[]>(
              'SELECT @@GLOBAL.lock_wait_timeout AS lock_wait_timeout',
            );
            assert.equal(replacement.lockWaitTimeout, Number(settings[0]?.lock_wait_timeout));
            await assertSchemaLockAvailable(pool, url);
            const [ledgerAfter] = await pool.query('SELECT * FROM schema_migrations ORDER BY id');
            assert.deepEqual(ledgerAfter, [], 'nothing was recorded');
            await ensureMysqlSchema(creator);
          } finally {
            await creator.end();
          }
        });
      }
    }
  });

  it('refuses a peer that starts during a failed creation, then a restart finishes it', async () => {
    const expected = await fixture(async (pool) => {
      await ensureMysqlSchema(pool);
      return schema(pool);
    });
    await fixture(async (pool, url) => {
      const second = mysql.createPool(url);
      let fired = false;
      let peer: Promise<unknown> | null = null;
      const faulty = intercept(pool, (method, sql, _params, after) => {
        if (method === 'execute' && after && sql.startsWith('SELECT GET_LOCK(')) {
          // Started while the first owns the lock: refused at once, never queued.
          peer = ensureMysqlSchema(second).then(
            () => 'finished',
            (error: unknown) => error,
          );
        }
        if (
          !fired &&
          method === 'query' &&
          after &&
          sql.startsWith('CREATE TABLE IF NOT EXISTS users')
        ) {
          fired = true;
          throw new Error(interruption);
        }
      });
      try {
        await assert.rejects(() => ensureMysqlSchema(faulty), INTERRUPTION);
        assert.ok(peer, 'the peer started while the failing creator held its advisory lock');
        const outcome = await peer;
        assert.ok(outcome instanceof Error && BUSY.test(outcome.message), String(outcome));
        assert.ok(fired);
        await pool.query(`INSERT INTO organizations (id, name, created_at, updated_at)
          VALUES ('preserved', 'Survives restart', '2026-01-01', '2026-01-01')`);
        await restartAndVerify(pool, url, expected);
      } finally {
        await second.end();
      }
    });
  });

  it('refuses a second migrator while the lock is held, and the lock is free afterwards', async () => {
    await fixture(async (pool, url) => {
      const holder = await pool.getConnection();
      const name = mysqlSchemaLockName(new URL(url).pathname.slice(1));
      try {
        await holder.query('SELECT GET_LOCK(?, 5)', [name]);
        await assert.rejects(
          () => ensureMysqlSchema(pool),
          (error: unknown) => error instanceof Error && BUSY.test(error.message),
        );
      } finally {
        await holder.query('SELECT RELEASE_LOCK(?)', [name]);
        holder.release();
      }
      await ensureMysqlSchema(pool);
      const [rows] = await pool.query<mysql.RowDataPacket[]>('SELECT id FROM schema_migrations');
      assert.deepEqual(
        rows.map((row) => row.id),
        [base.id],
      );
      await assertSchemaLockAvailable(pool, url);
    });
  });
});

describe('MySQL migration preflight', () => {
  it('refuses a file that changes one object twice, before any of it runs', () => {
    const twice = sqlMigration(
      '016_twice',
      '016_twice.mysql.sql',
      'ALTER TABLE users ADD COLUMN probe_note VARCHAR(64) NULL;\n' +
        'ALTER TABLE users MODIFY COLUMN probe_note LONGTEXT DEFAULT NULL;\n',
    );
    assert.throws(() => migrationSteps(twice), TWICE);
  });

  it('refuses data changes and other statements it cannot verify on a replay', () => {
    const update = sqlMigration('016_update', 'x', "UPDATE users SET company = 'x';");
    assert.throws(() => migrationSteps(update), UNSUPPORTED);
  });

  it('refuses IF [NOT] EXISTS forms, which would hide a different definition', () => {
    const create = sqlMigration(
      '016_create',
      'x',
      'CREATE TABLE IF NOT EXISTS widgets (id VARCHAR(64) NOT NULL, PRIMARY KEY (id));',
    );
    assert.throws(() => migrationSteps(create), IF_EXISTS);
  });

  it('accepts every supported statement kind', () => {
    assert.equal(migrationSteps(PROBE).length, 6);
  });
});

describe('MySQL forward migration recovery', { skip: !adminUrl, timeout: 600_000 }, () => {
  it('resumes a migration interrupted after every committed statement', async () => {
    const expected = await fixture(async (pool) => {
      await ensureMysqlSchema(pool, base, { migrations: [PROBE] });
      return schema(pool);
    });
    const statements = splitSqlStatements(PROBE.sql);
    for (const boundary of [...statements, 'ledger']) {
      await fixture(async (pool, url) => {
        await ensureMysqlSchema(pool, base, { migrations: [] });
        let fired = false;
        const faulty = intercept(pool, (method, sql, _params, after) => {
          if (fired) return;
          const ledger =
            boundary === 'ledger' &&
            method === 'execute' &&
            !after &&
            sql.startsWith("UPDATE schema_migrations SET state = 'applied'");
          const ddl = method === 'query' && after && normalize(sql) === normalize(boundary);
          if (ledger || ddl) {
            fired = true;
            throw new Error(interruption);
          }
        });
        await assert.rejects(
          () => ensureMysqlSchema(faulty, base, { migrations: [PROBE] }),
          INTERRUPTION,
        );
        assert.ok(fired, boundary);
        const [marker] = await pool.query<mysql.RowDataPacket[]>(
          'SELECT id, state, checksum FROM schema_migrations WHERE id = ?',
          [PROBE.id],
        );
        assert.deepEqual(
          marker.map((row) => [row.id, row.state, row.checksum]),
          [[PROBE.id, 'in_progress', PROBE.checksum]],
          boundary,
        );
        // A build that does not know the migration refuses the half-upgraded database.
        await assert.rejects(
          () => ensureMysqlSchema(pool, base, { migrations: [] }),
          (error: unknown) =>
            error instanceof Error && NEWER.test(error.message) && INTERRUPTED.test(error.message),
        );
        // The same build resumes it from a fresh pool.
        const restarted = mysql.createPool(url);
        try {
          await ensureMysqlSchema(restarted, base, { migrations: [PROBE] });
          await ensureMysqlSchema(restarted, base, { migrations: [PROBE] });
        } finally {
          await restarted.end();
        }
        const [ledger] = await pool.query<mysql.RowDataPacket[]>(
          'SELECT id, state FROM schema_migrations ORDER BY id',
        );
        assert.deepEqual(
          ledger.map((row) => [row.id, row.state]),
          [
            [base.id, null],
            [PROBE.id, 'applied'],
          ],
          boundary,
        );
        assert.deepEqual(await schema(pool), expected, boundary);
      });
    }
  });
});
