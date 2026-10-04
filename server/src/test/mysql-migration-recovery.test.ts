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

describe('MySQL migration recovery', { skip: !adminUrl, timeout: 600_000 }, () => {
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
        /unsupported non-replayable DDL/,
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

  it('replays additive columns across DDL and ledger interruptions, preserving data', async () => {
    const expected = await fixture(async (pool) => {
      await runMysqlMigrations(pool);
      return schema(pool);
    });
    const pending = migrations.filter((migration) =>
      ['007_outbox_recipient', '008_email_lifecycle_fence'].includes(migration.id),
    );
    assert.equal(pending.length, 2);
    for (const migration of pending) {
      for (const boundary of ['ddl', 'before-ledger', 'after-ledger']) {
        await fixture(async (pool, url) => {
          await runMysqlMigrations(
            pool,
            migrations.filter((file) => file.id < migration.id),
          );
          await pool.query(`INSERT INTO organizations (id, name, created_at, updated_at)
            VALUES ('preserved', 'Survives restart', '2026-01-01', '2026-01-01')`);
          await pool.query(`INSERT INTO users
            (id, email, password_hash, display_name, role, created_at, updated_at)
            VALUES ('retained-user', 'retained@example.test', 'retained-hash', 'Retained',
                    'client', '2026-01-01', '2026-01-02')`);
          await pool.query(`INSERT INTO email_outbox
            (id, to_email, subject, body_html, body_text, attempts, generation,
             created_at, updated_at)
            VALUES ('retained-mail', 'retained@example.test', 'Private subject', '<p>Private</p>',
                    'Private', 2, 'retained-generation', '2026-01-01', '2026-01-02')`);
          const userSql =
            'SELECT id, email, password_hash, role, created_at, updated_at FROM users';
          const mailSql =
            'SELECT id, to_email, subject, body_html, body_text, status, attempts, generation, ' +
            'created_at, updated_at FROM email_outbox';
          const [usersBefore] = await pool.query(userSql);
          const [mailBefore] = await pool.query(mailSql);
          let fired = false;
          const faulty = intercept(pool, (method, sql, params, after) => {
            if (fired) return;
            const ddl =
              boundary === 'ddl' &&
              method === 'query' &&
              after &&
              splitSqlStatements(migration.sql).some((step) => normalize(step) === normalize(sql));
            const ledger =
              boundary !== 'ddl' &&
              method === 'execute' &&
              after === (boundary === 'after-ledger') &&
              sql.startsWith('INSERT INTO schema_migrations ') &&
              Array.isArray(params) &&
              params[0] === migration.id;
            if (ddl || ledger) {
              fired = true;
              throw new Error(interruption);
            }
          });
          await assert.rejects(() => runMysqlMigrations(faulty), new RegExp(interruption));
          assert.ok(fired, `${migration.id}: ${boundary}`);
          // Work committed after the ALTER must survive a replay too. Existing
          // release fixtures separately assert the new columns' defaults.
          await pool.query("UPDATE email_outbox SET recipient_user_id = 'retained-user'");
          const retainedFence =
            migration.id === '008_email_lifecycle_fence' ? 'retained-fence' : '';
          if (retainedFence) {
            await pool.query("UPDATE users SET email_lifecycle_fence = 'retained-fence'");
          }
          await restartAndVerify(pool, url, expected);
          const [usersAfter] = await pool.query(userSql);
          const [mailAfter] = await pool.query(mailSql);
          assert.deepEqual(usersAfter, usersBefore);
          assert.deepEqual(mailAfter, mailBefore);
          const [bindings] = await pool.query<mysql.RowDataPacket[]>(
            `SELECT u.email_lifecycle_fence, e.recipient_user_id
               FROM users u JOIN email_outbox e ON e.to_email = u.email`,
          );
          assert.deepEqual(
            bindings.map((row) => ({ ...row })),
            [{ email_lifecycle_fence: retainedFence, recipient_user_id: 'retained-user' }],
          );
        });
      }
    }
  });

  it('refuses incompatible columns without recording the migration', async () => {
    for (const definition of [
      'VARCHAR(35) NULL',
      "VARCHAR(36) NOT NULL DEFAULT ''",
      "VARCHAR(36) NULL DEFAULT 'unexpected'",
      'VARCHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL',
      'VARCHAR(36) GENERATED ALWAYS AS (to_email) VIRTUAL',
    ]) {
      await fixture(async (pool) => {
        await runMysqlMigrations(
          pool,
          migrations.filter((file) => file.id < '007_outbox_recipient'),
        );
        await pool.query(`ALTER TABLE email_outbox ADD COLUMN recipient_user_id ${definition}`);
        const [before] = await pool.query('SELECT * FROM schema_migrations ORDER BY id');
        await assert.rejects(() => runMysqlMigrations(pool), /has an incompatible definition/);
        const [after] = await pool.query('SELECT * FROM schema_migrations ORDER BY id');
        assert.deepEqual(after, before);
      });
    }
  });

  it('serializes independent upgrades of a populated released schema', async () => {
    await fixture(async (pool, url) => {
      await runMysqlMigrations(
        pool,
        migrations.filter((file) => file.id < '007_outbox_recipient'),
      );
      await pool.query(`INSERT INTO organizations (id, name, created_at, updated_at)
        VALUES ('preserved', 'Survives restart', '2026-01-01', '2026-01-01')`);
      const second = mysql.createPool(url);
      let fired = false;
      let next: Promise<void> | null = null;
      const faulty = intercept(pool, (method, sql, _params, after) => {
        if (method === 'execute' && after && sql.startsWith('SELECT GET_LOCK(')) {
          next = runMysqlMigrations(second);
        }
        if (!fired && method === 'query' && after && sql.startsWith('ALTER TABLE ')) {
          fired = true;
          throw new Error(interruption);
        }
      });
      try {
        // Start the second pool while the first owns the advisory lock. It
        // must resume the committed ALTER after the failing owner releases it.
        await assert.rejects(() => runMysqlMigrations(faulty), new RegExp(interruption));
        assert.ok(next, 'the peer started while the failing runner held its advisory lock');
        await next;
        assert.ok(fired);
        await restartAndVerify(pool, url, await schema(pool));
      } finally {
        await second.end();
      }
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
