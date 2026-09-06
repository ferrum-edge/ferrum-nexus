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
            if (!['query', 'execute', 'commit'].includes(String(member))) return original.bind(targetConnection);
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
    const [rows] = await pool.query<mysql.RowDataPacket[]>(`SHOW CREATE TABLE \`${table.TABLE_NAME}\``);
    definitions.push(String(rows[0]!['Create Table']));
  }
  return definitions;
}

async function seedCredentials(pool: mysql.Pool): Promise<void> {
  await pool.query(`INSERT INTO users
    (id, email, password_hash, display_name, role, status, email_verified, created_at, updated_at)
    VALUES ('fixture-user', 'fixture@example.test', 'unused', 'Fixture', 'client', 'active', 1, '2026-01-01', '2026-01-01')`);
  for (const [id, consumer, created] of [
    ['first', 'ordered', '2026-01-01'], ['second', 'ordered', '2026-01-02'],
    ['ambiguous-a', 'ambiguous', '2026-01-01'], ['ambiguous-b', 'ambiguous', '2026-01-01'],
  ]) {
    await pool.execute(`INSERT INTO credential_metadata
      (id, user_id, ferrum_consumer_id, credential_type, ferrum_credential_id,
       fingerprint, last4, status, created_at, updated_at)
      VALUES (?, 'fixture-user', ?, 'keyauth', ?, ?, 'test', 'active', ?, ?)`,
    [id, consumer, id, id, created, created]);
  }
}

async function restartAndVerify(pool: mysql.Pool, url: string, expected: string[], credentials: boolean) {
  // A fresh pool/connection cannot rely on any state from the interrupted runner.
  const restarted = mysql.createPool(url);
  try {
    await runMysqlMigrations(restarted);
    const [ledger] = await restarted.query<mysql.RowDataPacket[]>('SELECT id FROM schema_migrations ORDER BY id');
    assert.deepEqual(ledger.map((row) => row.id), migrations.map((migration) => migration.id));
    const [before] = await restarted.query('SELECT * FROM schema_migrations ORDER BY id');
    await runMysqlMigrations(restarted);
    const [after] = await restarted.query('SELECT * FROM schema_migrations ORDER BY id');
    assert.deepEqual(after, before);
    assert.deepEqual(await schema(restarted), expected);
    const [preserved] = await pool.query<mysql.RowDataPacket[]>("SELECT name FROM organizations WHERE id = 'preserved'");
    assert.equal(preserved[0]?.name, 'Survives restart');
    if (credentials) {
      const [rows] = await restarted.query<mysql.RowDataPacket[]>('SELECT id, edge_ordinal FROM credential_metadata ORDER BY id');
      assert.deepEqual(rows.map((row) => [row.id, row.edge_ordinal]), [
        ['ambiguous-a', null], ['ambiguous-b', null], ['first', 1], ['second', 2],
      ]);
    }
  } finally {
    await restarted.end();
  }
}

describe('MySQL committed migration recovery', { skip: !adminUrl, timeout: 600_000 }, () => {
  it('resumes every shipped DDL/backfill boundary and missing ledger without losing rows', async () => {
    const expected = await fixture(async (pool) => {
      await runMysqlMigrations(pool);
      return schema(pool);
    });
    for (const [index, migration] of migrations.entries()) {
      const statements = splitSqlStatements(migration.sql);
      const boundaries = [...statements.map((_, step) => step), 'ledger'] as const;
      for (const boundary of boundaries) {
        await fixture(async (pool, url) => {
          await runMysqlMigrations(pool, migrations.slice(0, index));
          // Legacy installations had only the migration ledger, no step journal.
          await pool.query('DROP TABLE schema_migration_steps');
          const credentials = index > 0;
          if (credentials) await seedCredentials(pool);
          let fired = false;
          let backfillCommitted = false;
          const faulty = intercept(pool, (method, sql, params, after) => {
            if (fired) return;
            const ledger = boundary === 'ledger' && method === 'execute' && !after &&
              sql.startsWith('INSERT INTO schema_migrations ') && (params as string[])[0] === migration.id;
            const statement = typeof boundary === 'number' ? statements[boundary] : undefined;
            if (statement?.startsWith('UPDATE ') && method === 'query' && after && normalize(sql) === normalize(statement)) {
              backfillCommitted = true;
              return;
            }
            const step = statement && !statement.startsWith('UPDATE ') && method === 'query' && after && normalize(sql) === normalize(statement);
            if (ledger || step || (backfillCommitted && method === 'commit' && after)) {
              fired = true;
              throw new Error(interruption);
            }
          });
          await assert.rejects(() => runMysqlMigrations(faulty), new RegExp(interruption), `${migration.id}:${boundary}`);
          assert.ok(fired, `${migration.id}:${boundary}`);
          await pool.query("INSERT INTO organizations VALUES ('preserved', 'Survives restart', NULL, '2026-01-01', '2026-01-01')");
          await restartAndVerify(pool, url, expected, credentials);
        });
      }
    }
  });

  it('recovers the original 002 state with no journal and rejects wrong existing definitions', async () => {
    for (const incompatible of [false, true]) {
      await fixture(async (pool) => {
        await runMysqlMigrations(pool, migrations.slice(0, 1));
        await pool.query('DROP TABLE schema_migration_steps');
        await pool.query(splitSqlStatements(migrations[1]!.sql)[0]!);
        if (incompatible) await pool.query('ALTER TABLE apis MODIFY upstream_url VARCHAR(100) NULL');
        if (incompatible) {
          await assert.rejects(() => runMysqlMigrations(pool), /schema mismatch at apis.upstream_url/);
          const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT id FROM schema_migrations WHERE id = '002_api_upstream_and_cors'");
          assert.equal(rows.length, 0);
        } else {
          await runMysqlMigrations(pool);
          await runMysqlMigrations(pool);
        }
      });
    }
  });

  it('rejects partial ALTER state and an index with the right name but wrong columns', async () => {
    for (const partial of [false, true]) {
      await fixture(async (pool) => {
        await runMysqlMigrations(pool, migrations.slice(0, 2));
        await pool.query(splitSqlStatements(migrations[2]!.sql)[0]!);
        await pool.query('ALTER TABLE email_verification_tokens DROP INDEX ix_verification_tokens_user_purpose');
        if (!partial) await pool.query('ALTER TABLE email_verification_tokens ADD INDEX ix_verification_tokens_user_purpose (purpose, user_id)');
        await assert.rejects(() => runMysqlMigrations(pool), /schema mismatch/);
      });
    }
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
