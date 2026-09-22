import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import mysql from 'mysql2/promise';
import { runMysqlMigrations } from '../db/adapters/mysql/migrations.js';
import { loadMigrations, splitSqlStatements } from '../db/migrate.js';

const adminUrl = process.env.NEXUS_TEST_MYSQL_URL;
const migrations = loadMigrations('mysql');
const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const interruption = 'fixture interruption at committed migration boundary';

type Fault = (method: string, sql: string, params: unknown, after: boolean) => void;
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
              fault(String(member), String(args[0] ?? ''), args[1], false);
              const result = await original.apply(targetConnection, args);
              fault(String(member), String(args[0] ?? ''), args[1], true);
              return result;
            };
          },
        });
      };
    },
  });
}

async function fixture<T>(body: (pool: mysql.Pool, url: string) => Promise<T>): Promise<T> {
  const database = `nexus_recovery_${randomUUID().replace(/-/g, '')}`;
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

async function restartAndVerify(pool: mysql.Pool, url: string, expected: string[]): Promise<void> {
  // A fresh pool/connection cannot rely on any state from the interrupted runner.
  const restarted = mysql.createPool(url);
  try {
    await runMysqlMigrations(restarted);
    const [ledger] = await restarted.query<mysql.RowDataPacket[]>(
      'SELECT id FROM schema_migrations ORDER BY id',
    );
    assert.deepEqual(
      ledger.map((row) => row.id),
      migrations.map((migration) => migration.id),
    );
    const [before] = await restarted.query('SELECT * FROM schema_migrations ORDER BY id');
    await runMysqlMigrations(restarted);
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

describe('MySQL baseline initialization', { skip: !adminUrl, timeout: 600_000 }, () => {
  it('resumes after every committed CREATE and before recording the baseline', async () => {
    const expected = await fixture(async (pool) => {
      await runMysqlMigrations(pool);
      return schema(pool);
    });
    const migration = migrations[0]!;
    const statements = splitSqlStatements(migration.sql);
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
        await assert.rejects(() => runMysqlMigrations(faulty), new RegExp(interruption));
        assert.ok(fired, boundary);
        // The first CREATE installs organizations. Replaying the incomplete
        // baseline must preserve data already in a successfully created table.
        await pool.query(`INSERT INTO organizations (id, name, created_at, updated_at)
          VALUES ('preserved', 'Survives restart', '2026-01-01', '2026-01-01')`);
        await restartAndVerify(pool, url, expected);
      });
    }
  });

  it('rejects non-replayable schema changes before creating application tables', async () => {
    await fixture(async (pool) => {
      await assert.rejects(
        () =>
          runMysqlMigrations(pool, [
            {
              ...migrations[0]!,
              sql: migrations[0]!.sql + '\nALTER TABLE users ADD COLUMN obsolete TEXT;',
            },
          ]),
        /must contain only CREATE TABLE IF NOT EXISTS/,
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

  it('serializes two independent migrators and releases the lock after failure', async () => {
    await fixture(async (pool, url) => {
      const second = mysql.createPool(url);
      try {
        await Promise.all([runMysqlMigrations(pool), runMysqlMigrations(second)]);
        const [rows] = await pool.query<mysql.RowDataPacket[]>('SELECT id FROM schema_migrations');
        assert.equal(rows.length, migrations.length);
        // The interruption matrix also re-enters after each failed lock owner.
        await runMysqlMigrations(second);
      } finally {
        await second.end();
      }
    });
  });
});
