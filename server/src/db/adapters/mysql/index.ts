/**
 * MySQL implementation of {@link NexusStore} (`mysql2/promise`).
 *
 * All query logic lives in `adapters/sql-repos.ts`; this module contributes
 * only what is genuinely MySQL-specific:
 *
 * - a `mysql2` pool built from `config.db.url`, pinned to `utf8mb4` so the
 *   `utf8mb4_bin` schema round-trips text unchanged;
 * - an {@link SqlExecutor} that runs statements through {@link formatSql}
 *   (`"ident"` → `` `ident` ``, which is what lets the shared repos say
 *   `"key"` — a reserved word here and not in PostgreSQL) and reports
 *   `affectedRows` as the affected row count;
 * - the migration runner, applying the `.mysql.sql` files and recording them in
 *   `schema_migrations` under the same protocol as the sqlite adapter. MySQL
 *   has no transactional DDL, so a migration's statements are applied
 *   sequentially and the bookkeeping row is written last — a crash mid-way
 *   leaves the migration unrecorded, and the `CREATE TABLE IF NOT EXISTS`
 *   spelling used throughout makes the retry idempotent.
 * - `transaction()`, a real `START TRANSACTION`/`COMMIT`/`ROLLBACK` on a
 *   dedicated connection checked out of the pool for the duration of the body.
 *   Nested `transaction()` calls join the outer one, and bodies are serialised,
 *   both handled by the shared `SqlStore` shell.
 *
 * Statements go through `pool.query` rather than `pool.execute`: the repos
 * build SQL dynamically (filters, `IN` lists), so a server-side prepared
 * statement per shape would be churn rather than reuse, and `query`'s
 * client-side escaping sidesteps the prepared-protocol's refusal to bind
 * `LIMIT`/`OFFSET` placeholders.
 */

import mysql from 'mysql2/promise';

import type { DbDriver } from '@ferrum-nexus/shared';

import type { NexusConfig } from '../../../config/index.js';
import { nowIso } from '../../../lib/ids.js';
import {
  loadMigrations,
  runMigrations,
  SCHEMA_MIGRATIONS_TABLE,
  splitSqlStatements,
  type MigrationDriver,
  type MigrationFile,
} from '../../migrate.js';
import type { NexusStore, StoreHealth } from '../../store.js';
import { formatSql, type Row, type SqlExecutor, type SqlParam } from '../sql-common.js';
import { createSqlStore, type SqlStoreBackend } from '../sql-repos.js';

type MysqlPool = mysql.Pool;
type MysqlConnection = mysql.PoolConnection;

/** Anything that answers `query` — the pool itself or one checked-out connection. */
interface MysqlQueryable {
  query(sql: string, params?: unknown[]): Promise<[unknown, unknown]>;
}

/** Rows for a SELECT, or a header carrying `affectedRows` for everything else. */
function affectedRows(result: unknown): number {
  if (result && typeof result === 'object' && 'affectedRows' in result) {
    return Number((result as { affectedRows: unknown }).affectedRows ?? 0);
  }
  return 0;
}

/** Wrap a pool or connection as the executor `sql-repos.ts` is written against. */
function mysqlExecutor(queryable: MysqlQueryable): SqlExecutor {
  return {
    dialect: 'mysql',
    async query(sql: string, params: SqlParam[] = []): Promise<Row[]> {
      const [rows] = await queryable.query(formatSql(sql, 'mysql'), params);
      return Array.isArray(rows) ? (rows as Row[]) : [];
    },
    async execute(sql: string, params: SqlParam[] = []): Promise<number> {
      const [result] = await queryable.query(formatSql(sql, 'mysql'), params);
      return affectedRows(result);
    },
  };
}

function createMigrationDriver(pool: MysqlPool): MigrationDriver {
  return {
    async ensureMigrationsTable(): Promise<void> {
      await pool.query(
        `CREATE TABLE IF NOT EXISTS ${SCHEMA_MIGRATIONS_TABLE} (
           id VARCHAR(191) NOT NULL,
           applied_at VARCHAR(32) NOT NULL,
           PRIMARY KEY (id)
         ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
      );
    },
    async listApplied(): Promise<string[]> {
      const [rows] = await pool.query(`SELECT id FROM ${SCHEMA_MIGRATIONS_TABLE}`);
      return Array.isArray(rows) ? (rows as { id: string }[]).map((row) => String(row.id)) : [];
    },
    async applyMigration(migration: MigrationFile): Promise<void> {
      // DDL is not transactional in MySQL; record the migration only once every
      // statement has succeeded, so a failure leaves it pending for a retry.
      for (const statement of splitSqlStatements(migration.sql)) {
        await pool.query(statement);
      }
      await pool.query(`INSERT INTO ${SCHEMA_MIGRATIONS_TABLE} (id, applied_at) VALUES (?, ?)`, [
        migration.id,
        nowIso(),
      ]);
    },
  };
}

/** The MySQL {@link SqlStoreBackend}. */
class MysqlBackend implements SqlStoreBackend {
  readonly driver: DbDriver = 'mysql';

  readonly pool: SqlExecutor;

  private readonly db: MysqlPool;

  private closed = false;

  constructor(db: MysqlPool) {
    this.db = db;
    this.pool = mysqlExecutor(db);
  }

  async init(): Promise<void> {
    // Fail fast on an unreachable server or bad credentials rather than on the
    // first user request.
    const connection = await this.db.getConnection();
    connection.release();
  }

  async migrate(): Promise<void> {
    await runMigrations(createMigrationDriver(this.db), loadMigrations('mysql'));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.db.end();
  }

  async healthCheck(): Promise<StoreHealth> {
    const started = Date.now();
    try {
      await this.db.query('SELECT 1');
      return { ok: true, latencyMs: Date.now() - started, error: null };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        error: error instanceof Error ? error.message : 'unknown error',
      };
    }
  }

  async withTransaction<T>(fn: (exec: SqlExecutor) => Promise<T>): Promise<T> {
    const connection: MysqlConnection = await this.db.getConnection();
    try {
      await connection.beginTransaction();
      try {
        const result = await fn(mysqlExecutor(connection));
        await connection.commit();
        return result;
      } catch (error) {
        await connection.rollback().catch(() => undefined);
        throw error;
      }
    } finally {
      connection.release();
    }
  }
}

/**
 * Build the MySQL store from `config.db.url`.
 *
 * The caller still owns `init()` and `migrate()`, exactly as for sqlite.
 */
export function createMysqlStore(config: NexusConfig): NexusStore {
  const pool = mysql.createPool({
    uri: config.db.url,
    charset: 'utf8mb4_general_ci',
    // A transaction holds one connection for the whole body, and the store
    // serialises bodies, so a small pool is plenty — but leave headroom for
    // concurrent non-transactional reads.
    connectionLimit: 10,
    waitForConnections: true,
    // Every statement is a single statement with bound parameters; allowing
    // more would widen the injection surface for no benefit.
    multipleStatements: false,
    // Timestamps are ISO-8601 *strings* in VARCHAR columns, never DATETIME, so
    // there is nothing for the driver to convert — but keep it explicit.
    dateStrings: true,
  });
  return createSqlStore(new MysqlBackend(pool));
}
