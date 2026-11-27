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
 * - the schema primitives (`migrate.ts`): creating `schema/base.pg.sql` and
 *   applying each forward migration file as one script, each in one
 *   transaction with its ledger row (PostgreSQL has transactional DDL), and
 *   each transaction holding a transaction-scoped advisory lock, so a second
 *   migrator is refused rather than interleaved;
 * - `transaction()`, which is a real `BEGIN`/`COMMIT`/`ROLLBACK` on a
 *   dedicated client checked out of the pool for the duration of the body.
 *   Nested `transaction()` calls join the outer one, and bodies are serialised,
 *   both handled by the shared `SqlStore` shell;
 * - the classification of the class-40 SQLSTATEs — `40001` serialization
 *   failure and `40P01` deadlock detected — that PostgreSQL uses to say a
 *   transaction was rolled back for contention and should be run again. The
 *   shell retries those; see `adapters/transaction-retry.ts`.
 */

import { createHash } from 'node:crypto';

import pg from 'pg';

import type { DbDriver } from '@ferrum-nexus/shared';

import type { NexusConfig } from '../../../config/index.js';
import { nowIso } from '../../../lib/ids.js';
import {
  checksumMismatchError,
  ensureSchema,
  loadShippedMigrations,
  refuseTransactionControl,
  schemaBusyError,
  type LedgerEntry,
  type SchemaDriver,
  type SchemaOptions,
  type SchemaResult,
  type SqlMigration,
} from '../../migrate.js';
import {
  loadBaseSchema,
  SCHEMA_LEDGER_TABLE,
  splitSqlStatements,
  type BaseSchema,
} from '../../schema.js';
import type { NexusStore, StoreHealth } from '../../store.js';
import { formatSql, type Row, type SqlExecutor, type SqlParam } from '../sql-common.js';
import { createSqlStore, type SqlStoreBackend } from '../sql-repos.js';
import { isPostgresRetryableTransactionError } from '../transaction-retry.js';

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

/**
 * The advisory lock key that serializes schema work across instances: a fixed
 * 64-bit key (advisory locks are already scoped to one database). Taken
 * transaction-scoped (`pg_try_advisory_xact_lock`) inside every schema
 * transaction, so it is released with the transaction even through a pooler.
 * Exported for the tests that hold it.
 */
export const SCHEMA_LOCK_KEY = BigInt.asIntN(
  64,
  BigInt(`0x${createHash('sha256').update('ferrum-nexus:schema').digest('hex').slice(0, 16)}`),
).toString();

/**
 * Run `work` in one transaction on `client`, holding the schema lock; refuse
 * at once (never wait) when another migrator holds it.
 */
async function inSchemaTransaction(client: PgClient, work: () => Promise<void>): Promise<void> {
  await client.query('BEGIN');
  try {
    const result = await client.query('SELECT pg_try_advisory_xact_lock($1::bigint) AS acquired', [
      SCHEMA_LOCK_KEY,
    ]);
    if ((result.rows[0] as { acquired?: unknown } | undefined)?.acquired !== true) {
      throw schemaBusyError('PostgreSQL');
    }
    await work();
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

/** The ledger's columns (a v0.6.0 ledger has only `id` and `applied_at`). */
async function ledgerColumns(client: PgClient): Promise<Set<string>> {
  const result = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1`,
    [SCHEMA_LEDGER_TABLE],
  );
  return new Set((result.rows as { column_name: unknown }[]).map((row) => String(row.column_name)));
}

/** Whether the ledger holds any row; read inside a schema transaction. */
async function ledgerEmpty(client: PgClient): Promise<boolean> {
  const result = await client.query(`SELECT 1 FROM ${SCHEMA_LEDGER_TABLE} LIMIT 1`);
  return result.rows.length === 0;
}

/** Create the base schema and record it, inside the caller's transaction. */
async function createBase(client: PgClient, schema: BaseSchema): Promise<void> {
  for (const statement of splitSqlStatements(schema.sql)) {
    await client.query(statement);
  }
  await client.query(`INSERT INTO ${SCHEMA_LEDGER_TABLE} (id, applied_at) VALUES ($1, $2)`, [
    schema.id,
    nowIso(),
  ]);
}

/** Run one migration file and record it, inside the caller's transaction. */
async function runMigration(client: PgClient, migration: SqlMigration): Promise<void> {
  // The whole file in one parameterless query: PostgreSQL parses it itself
  // (simple protocol), so dollar-quoted bodies, and semicolons in strings or
  // comments, reach it intact. `refuseTransactionControl` has already
  // refused anything that would end this transaction.
  await client.query(migration.sql);
  await client.query(
    `INSERT INTO ${SCHEMA_LEDGER_TABLE} (id, applied_at, checksum, state) ` +
      "VALUES ($1, $2, $3, 'applied')",
    [migration.id, nowIso(), migration.checksum],
  );
}

/**
 * The PostgreSQL schema primitives over one dedicated client. Every write
 * runs in a transaction that holds the schema lock and re-reads the ledger
 * under it; exported for tests.
 */
export function createPostgresSchemaDriver(client: PgClient): SchemaDriver<SqlMigration> {
  return {
    async ensureLedger(): Promise<void> {
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${SCHEMA_LEDGER_TABLE} (
           id TEXT PRIMARY KEY,
           applied_at TEXT NOT NULL,
           checksum TEXT,
           state TEXT
         )`,
      );
    },
    async listRecorded(): Promise<LedgerEntry[]> {
      const present = await ledgerColumns(client);
      const columns = ['id', 'checksum', 'state'].filter((column) => present.has(column));
      const result = await client.query(`SELECT ${columns.join(', ')} FROM ${SCHEMA_LEDGER_TABLE}`);
      return (result.rows as { id: unknown; checksum?: unknown; state?: unknown }[]).map((row) => ({
        id: String(row.id),
        checksum: typeof row.checksum === 'string' ? row.checksum : null,
        inProgress: row.state === 'in_progress',
      }));
    },
    async createBaseSchema(schema: BaseSchema): Promise<void> {
      await inSchemaTransaction(client, async () => {
        if (await ledgerEmpty(client)) await createBase(client, schema);
      });
    },
    async createFresh(schema: BaseSchema, migrations: readonly SqlMigration[]): Promise<void> {
      // One transaction: another instance sees an empty database or a complete one.
      await inSchemaTransaction(client, async () => {
        if (!(await ledgerEmpty(client))) return;
        await createBase(client, schema);
        for (const migration of migrations) await runMigration(client, migration);
      });
    },
    async prepareLedger(): Promise<void> {
      await inSchemaTransaction(client, async () => {
        await client.query(
          `ALTER TABLE ${SCHEMA_LEDGER_TABLE} ADD COLUMN IF NOT EXISTS checksum TEXT, ` +
            'ADD COLUMN IF NOT EXISTS state TEXT',
        );
      });
    },
    async applyMigration(migration: SqlMigration): Promise<void> {
      await inSchemaTransaction(client, async () => {
        // Re-read under the lock: another migrator may have applied it since.
        const existing = await client.query(
          `SELECT checksum FROM ${SCHEMA_LEDGER_TABLE} WHERE id = $1`,
          [migration.id],
        );
        const row = existing.rows[0] as { checksum?: unknown } | undefined;
        if (row !== undefined) {
          const checksum = typeof row.checksum === 'string' ? row.checksum : null;
          if (checksum === migration.checksum) return;
          throw checksumMismatchError({ id: migration.id, checksum }, migration);
        }
        await runMigration(client, migration);
      });
    },
  };
}

/**
 * Bring the database to this build's schema (`migrate.ts`) over one dedicated
 * client checked out for the whole run. The schema lock is transaction-scoped,
 * so this works through a session pooler or a direct connection; a
 * transaction-mode pooler is not supported for the migrate command
 * (docs/operations.md). `migrations` defaults to the shipped ones; the
 * upgrade tests pass their own.
 */
export async function ensurePostgresSchema(
  pool: PgPool,
  migrations: readonly SqlMigration[] = loadShippedMigrations('pg'),
  options: SchemaOptions = {},
): Promise<SchemaResult> {
  for (const migration of migrations) refuseTransactionControl(migration, 'pg');
  const client = await pool.connect();
  try {
    return await ensureSchema(
      createPostgresSchemaDriver(client),
      loadBaseSchema('pg'),
      migrations,
      {
        mode: options.mode ?? 'migrate',
      },
    );
  } finally {
    client.release();
  }
}

/** The PostgreSQL {@link SqlStoreBackend}. */
class PostgresBackend implements SqlStoreBackend {
  readonly driver: DbDriver = 'postgres';

  readonly pool: SqlExecutor;

  private readonly db: PgPool;

  private closed = false;

  /** Forward migrations `migrate()` applies; `undefined` means the shipped ones. */
  private readonly migrations: readonly SqlMigration[] | undefined;

  constructor(db: PgPool, migrations?: readonly SqlMigration[]) {
    this.db = db;
    this.pool = pgExecutor(db);
    this.migrations = migrations;
  }

  async init(): Promise<void> {
    // Fail fast on an unreachable server or bad credentials rather than on the
    // first user request.
    const client = await this.db.connect();
    client.release();
  }

  async migrate(options: SchemaOptions = {}): Promise<void> {
    await ensurePostgresSchema(this.db, this.migrations ?? loadShippedMigrations('pg'), options);
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

  isRetryableTransactionError(error: unknown): boolean {
    return isPostgresRetryableTransactionError(error);
  }
}

/**
 * Build the PostgreSQL store from `config.db.url`.
 *
 * The caller still owns `init()` and `migrate()`, exactly as for sqlite.
 * `migrations` replaces the shipped forward migrations; it is a test seam and
 * production never passes it.
 */
export function createPostgresStore(
  config: NexusConfig,
  migrations?: readonly SqlMigration[],
): NexusStore {
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
  return createSqlStore(new PostgresBackend(pool, migrations));
}
