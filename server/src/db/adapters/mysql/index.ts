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
 *   `affectedRows` as the matched row count for UPDATEs (CLIENT_FOUND_ROWS);
 * - the serialized, resumable migration runner in `migrations.ts`;
 * - `transaction()`, a real `START TRANSACTION`/`COMMIT`/`ROLLBACK` on a
 *   dedicated connection checked out of the pool for the duration of the body.
 *   Nested `transaction()` calls join the outer one, and bodies are serialised,
 *   both handled by the shared `SqlStore` shell;
 * - the classification of InnoDB's "run it again" errors. Two transactions that
 *   each insert a child row and then update its parent take the foreign key's
 *   **S** lock before the row's **X** lock and deadlock; InnoDB rolls one of
 *   them back with `ER_LOCK_DEADLOCK` (SQLSTATE `40001`), which is a request to
 *   retry, not a failure of the request. The shell retries it — see
 *   `adapters/transaction-retry.ts` for the policy and the re-runnability
 *   contract it puts on transaction bodies.
 *
 * Repository statements go through `execute`, so parameters are bound by the
 * server-side prepared-statement protocol rather than escaped into SQL text.
 * This remains safe regardless of the server's string-literal SQL mode (for
 * example, `NO_BACKSLASH_ESCAPES`).
 */

import mysql from 'mysql2/promise';

import type { DbDriver } from '@ferrum-nexus/shared';

import type { NexusConfig } from '../../../config/index.js';
import { runMysqlMigrations } from './migrations.js';
import type { NexusStore, StoreHealth } from '../../store.js';
import { formatSql, type Row, type SqlExecutor, type SqlParam } from '../sql-common.js';
import { createSqlStore, type SqlStoreBackend } from '../sql-repos.js';
import { isMysqlRetryableTransactionError } from '../transaction-retry.js';

type MysqlPool = mysql.Pool;
type MysqlConnection = mysql.PoolConnection;

/** Anything that answers `execute` — the pool itself or one checked-out connection. */
type MysqlQueryable = Pick<MysqlPool, 'execute'>;

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
      const [rows] = await queryable.execute(formatSql(sql, 'mysql'), params);
      return Array.isArray(rows) ? (rows as Row[]) : [];
    },
    async execute(sql: string, params: SqlParam[] = []): Promise<number> {
      const [result] = await queryable.execute(formatSql(sql, 'mysql'), params);
      return affectedRows(result);
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
    await runMysqlMigrations(this.db);
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
        // Explicit even for a deadlock victim, whose transaction the server has
        // already rolled back: a lock wait timeout rolls back only the
        // statement, and the shell may run the body again on this same pool.
        await connection.rollback().catch(() => undefined);
        throw error;
      }
    } finally {
      connection.release();
    }
  }

  isRetryableTransactionError(error: unknown): boolean {
    return isMysqlRetryableTransactionError(error);
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
    // Conditional UPDATEs must count matches, including identical values.
    // mysql2 defaults to FOUND_ROWS; pin it so URI flags cannot disable it.
    flags: ['FOUND_ROWS'],
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
