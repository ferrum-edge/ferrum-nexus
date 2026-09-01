/**
 * PostgreSQL implementation of {@link NexusStore} (`pg`).
 *
 * All query logic lives in `adapters/sql-repos.ts`; this module contributes
 * only what is genuinely PostgreSQL-specific:
 *
 * - a `pg.Pool` built from `config.db.url`;
 * - an {@link SqlExecutor} that runs statements through
 *   {@link formatSql} (`?` → `$1 … $n`) and reports `rowCount` as the affected
 *   row count;
 * - the migration runner, applying the `.pg.sql` files and recording them in
 *   `schema_migrations` under the same protocol as the sqlite adapter —
 *   PostgreSQL has transactional DDL, so each migration's statements and its
 *   bookkeeping row commit or roll back together;
 * - `transaction()`, which is a real `BEGIN`/`COMMIT`/`ROLLBACK` on a
 *   dedicated client checked out of the pool for the duration of the body.
 *   Nested `transaction()` calls join the outer one, and bodies are serialised,
 *   both handled by the shared `SqlStore` shell.
 */

import pg from 'pg';

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

const { Pool } = pg;
type PgPool = pg.Pool;
type PgClient = pg.PoolClient;

/** Anything that answers `query` — the pool itself or one checked-out client. */
interface PgQueryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

/** Wrap a pool or client as the executor `sql-repos.ts` is written against. */
function pgExecutor(queryable: PgQueryable): SqlExecutor {
  return {
    dialect: 'pg',
    async query(sql: string, params: SqlParam[] = []): Promise<Row[]> {
      const result = await queryable.query(formatSql(sql, 'pg'), params);
      return result.rows as Row[];
    },
    async execute(sql: string, params: SqlParam[] = []): Promise<number> {
      const result = await queryable.query(formatSql(sql, 'pg'), params);
      return result.rowCount ?? 0;
    },
  };
}

function createMigrationDriver(pool: PgPool): MigrationDriver {
  return {
    async ensureMigrationsTable(): Promise<void> {
      await pool.query(
        `CREATE TABLE IF NOT EXISTS ${SCHEMA_MIGRATIONS_TABLE} (
           id TEXT PRIMARY KEY,
           applied_at TEXT NOT NULL
         )`,
      );
    },
    async listApplied(): Promise<string[]> {
      const result = await pool.query(`SELECT id FROM ${SCHEMA_MIGRATIONS_TABLE}`);
      return (result.rows as { id: string }[]).map((row) => String(row.id));
    },
    async applyMigration(migration: MigrationFile): Promise<void> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const statement of splitSqlStatements(migration.sql)) {
          await client.query(statement);
        }
        await client.query(
          `INSERT INTO ${SCHEMA_MIGRATIONS_TABLE} (id, applied_at) VALUES ($1, $2)`,
          [migration.id, nowIso()],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

/** The PostgreSQL {@link SqlStoreBackend}. */
class PostgresBackend implements SqlStoreBackend {
  readonly driver: DbDriver = 'postgres';

  readonly pool: SqlExecutor;

  private readonly db: PgPool;

  private closed = false;

  constructor(db: PgPool) {
    this.db = db;
    this.pool = pgExecutor(db);
  }

  async init(): Promise<void> {
    // Fail fast on an unreachable server or bad credentials rather than on the
    // first user request.
    const client = await this.db.connect();
    client.release();
  }

  async migrate(): Promise<void> {
    await runMigrations(createMigrationDriver(this.db), loadMigrations('pg'));
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
    const client: PgClient = await this.db.connect();
    try {
      await client.query('BEGIN');
      try {
        const result = await fn(pgExecutor(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    } finally {
      client.release();
    }
  }
}

/**
 * Build the PostgreSQL store from `config.db.url`.
 *
 * The caller still owns `init()` and `migrate()`, exactly as for sqlite.
 */
export function createPostgresStore(config: NexusConfig): NexusStore {
  const pool = new Pool({
    connectionString: config.db.url,
    // A transaction holds one client for the whole body, and the store
    // serialises bodies, so a small pool is plenty — but leave headroom for
    // concurrent non-transactional reads.
    max: 10,
    idleTimeoutMillis: 30_000,
  });
  // `pg` emits `error` on idle clients dropped by the server; without a
  // listener that becomes an unhandled exception and takes the process down.
  pool.on('error', () => undefined);
  return createSqlStore(new PostgresBackend(pool));
}
