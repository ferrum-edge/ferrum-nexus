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
 *   applying each forward migration, each in one transaction with its ledger
 *   row (PostgreSQL has transactional DDL, so a statement and its ledger row
 *   commit or roll back together), all under a session advisory lock so two
 *   instances starting together migrate once;
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
  ensureSchema,
  loadMigrations,
  type LedgerEntry,
  type SchemaDriver,
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
 * The session advisory lock that serializes schema work across instances:
 * a fixed 64-bit key (advisory locks are already scoped to one database).
 */
const SCHEMA_LOCK_KEY = BigInt.asIntN(
  64,
  BigInt(`0x${createHash('sha256').update('ferrum-nexus:schema').digest('hex').slice(0, 16)}`),
).toString();
const MAX_SCHEMA_LOCK_WAIT_MS = 30_000;
const SCHEMA_LOCK_POLL_MS = 250;

/** Run `work` in one transaction on `client`. */
async function inTransaction(client: PgClient, work: () => Promise<void>): Promise<void> {
  await client.query('BEGIN');
  try {
    await work();
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

/** Whether the ledger has the `checksum` column (a v0.6.0 ledger does not). */
async function ledgerHasChecksum(client: PgClient): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1 AND column_name = 'checksum'`,
    [SCHEMA_LEDGER_TABLE],
  );
  return result.rows.length > 0;
}

/**
 * The PostgreSQL schema primitives over one checked-out client, which must
 * hold the schema lock ({@link ensurePostgresSchema}); exported for tests.
 */
export function createPostgresSchemaDriver(client: PgClient): SchemaDriver<SqlMigration> {
  return {
    async ensureLedger(): Promise<void> {
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${SCHEMA_LEDGER_TABLE} (
           id TEXT PRIMARY KEY,
           applied_at TEXT NOT NULL,
           checksum TEXT
         )`,
      );
    },
    async listRecorded(): Promise<LedgerEntry[]> {
      const columns = (await ledgerHasChecksum(client)) ? 'id, checksum' : 'id';
      const result = await client.query(`SELECT ${columns} FROM ${SCHEMA_LEDGER_TABLE}`);
      return (result.rows as { id: unknown; checksum?: unknown }[]).map((row) => ({
        id: String(row.id),
        checksum: typeof row.checksum === 'string' ? row.checksum : null,
      }));
    },
    async createBaseSchema(schema: BaseSchema): Promise<void> {
      await inTransaction(client, async () => {
        for (const statement of splitSqlStatements(schema.sql)) {
          await client.query(statement);
        }
        await client.query(`INSERT INTO ${SCHEMA_LEDGER_TABLE} (id, applied_at) VALUES ($1, $2)`, [
          schema.id,
          nowIso(),
        ]);
      });
    },
    async prepareLedger(): Promise<void> {
      await client.query(
        `ALTER TABLE ${SCHEMA_LEDGER_TABLE} ADD COLUMN IF NOT EXISTS checksum TEXT`,
      );
    },
    async applyMigration(migration: SqlMigration): Promise<void> {
      await inTransaction(client, async () => {
        for (const statement of splitSqlStatements(migration.sql)) {
          await client.query(statement);
        }
        await client.query(
          `INSERT INTO ${SCHEMA_LEDGER_TABLE} (id, applied_at, checksum) VALUES ($1, $2, $3)`,
          [migration.id, nowIso(), migration.checksum],
        );
      });
    },
  };
}

/** Take the schema lock on `client`, waiting up to `waitMs`. */
async function acquireSchemaLock(client: PgClient, waitMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const result = await client.query('SELECT pg_try_advisory_lock($1::bigint) AS acquired', [
      SCHEMA_LOCK_KEY,
    ]);
    if ((result.rows[0] as { acquired?: unknown } | undefined)?.acquired === true) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, SCHEMA_LOCK_POLL_MS));
  }
}

/**
 * Bring the database to this build's schema (`migrate.ts`). One client owns
 * the advisory lock, every ledger read, the base schema, each migration, and
 * the release; a second instance starting at the same time waits for the
 * lock, then finds the work done. `migrations` defaults to the shipped ones;
 * the upgrade tests pass their own.
 */
export async function ensurePostgresSchema(
  pool: PgPool,
  migrations: readonly SqlMigration[] = loadMigrations('pg'),
  options: { lockWaitMs?: number } = {},
): Promise<SchemaResult> {
  const waitMs = options.lockWaitMs ?? MAX_SCHEMA_LOCK_WAIT_MS;
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > MAX_SCHEMA_LOCK_WAIT_MS) {
    throw new RangeError('PostgreSQL schema lock wait must be an integer from 0 to 30000 ms');
  }
  const client = await pool.connect();
  let locked = false;
  let reusable = true;
  try {
    try {
      locked = await acquireSchemaLock(client, waitMs);
    } catch (error) {
      // Acquisition can land server-side before a transport error reaches us;
      // ending the session is the only certain release.
      reusable = false;
      throw error;
    }
    if (!locked) {
      throw new Error(
        'PostgreSQL schema setup is busy; retry after the other instance finishes migrating',
      );
    }
    return await ensureSchema(createPostgresSchemaDriver(client), loadBaseSchema('pg'), migrations);
  } finally {
    if (locked) {
      try {
        await client.query('SELECT pg_advisory_unlock($1::bigint)', [SCHEMA_LOCK_KEY]);
      } catch {
        reusable = false;
      }
    }
    // Cleanup must not hide a schema failure. A session whose unlock could not
    // be confirmed is destroyed, which releases its advisory locks.
    client.release(reusable ? undefined : true);
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

  async migrate(): Promise<void> {
    await ensurePostgresSchema(this.db, this.migrations ?? loadMigrations('pg'));
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
