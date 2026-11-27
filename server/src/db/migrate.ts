/**
 * Forward-only schema migrations on top of the frozen baseline.
 *
 * Every adapter records its schema in the `schema_migrations` ledger (for
 * MongoDB, the collection of the same name): the frozen baseline's id,
 * `BASE_SCHEMA_ID`, then one row per forward migration with its
 * checksum and when it was applied. The adapter supplies the primitives in
 * {@link SchemaDriver}; the ordering, refusal and "already applied" rules live
 * here so all four adapters behave identically (docs/operations.md, "Schema
 * and upgrades").
 *
 * Two callers, two modes ({@link ensureSchema}):
 *
 * - **the migrate command** (`migrate-cli.ts`, mode `'migrate'`) creates an
 *   empty database and applies pending migrations to an existing one. The
 *   operator runs it once per upgrade, with every Nexus instance stopped,
 *   after a backup. It takes an exclusive lock and never waits for or takes
 *   over another migrator's: a second migrator refuses.
 * - **server startup** (mode `'startup'`) creates a completely empty database
 *   (no ledger rows at all) the same way, so a first start needs no separate
 *   step, but never changes an existing one: unless the ledger equals this
 *   build's migrations exactly, it refuses to start and says what to run.
 *
 * Reading the ledger:
 *
 * - an empty ledger means a new database: create the base schema and record
 *   `BASE_SCHEMA_ID`, then apply every migration;
 * - a ledger without the baseline id was not created by Nexus v0.6.0 or later
 *   (a pre-0.6 migration chain, or another schema): refuse it;
 * - a ledger entry this build does not know means a newer release upgraded the
 *   database: refuse it, because downgrades are not supported;
 * - a recorded migration whose checksum differs from this build's means the
 *   migration was edited after it shipped (or the ledger was): refuse it;
 * - otherwise apply the migrations the ledger lacks, in id order, each one
 *   recorded in the same transaction as its changes where the backend has
 *   transactional DDL.
 *
 * Every refusal happens before anything is written, so a refused database is
 * left exactly as it was.
 *
 * Where a migration cannot commit with its ledger row (MySQL DDL, MongoDB
 * steps), the driver records the migration **in progress** before its first
 * change, and marks it applied only after its last. An interrupted upgrade
 * therefore leaves its id in the ledger: a build that does not know the id
 * refuses the database as one a newer release changed (and v0.6.0 refuses any
 * ledger but its baseline), while a build that knows it, with the same
 * checksum, resumes it. Each step of such a migration checks the live schema
 * before it changes anything, so resuming is safe.
 *
 * The shipped migrations are listed, with their checksums, in
 * `migration-manifest.ts`. {@link loadShippedMigrations} refuses to run when a
 * SQL file is missing, extra or altered, so a packaging mistake stops startup
 * instead of silently skipping a migration.
 *
 * SQL migration files live in `db/migrations/` and are named
 * `NNN_description.sql` (SQLite), `NNN_description.pg.sql` (PostgreSQL) and
 * `NNN_description.mysql.sql` (MySQL). The numeric prefix plus the
 * description is the migration **id**, shared across dialects; MongoDB
 * declares the step of the same id in `MONGO_MIGRATIONS`. No migration ships
 * with the baseline: the directory is created by the first schema change
 * after 1.0.0.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { NexusError, isNexusError } from '../lib/errors.js';
import {
  MIGRATION_MANIFEST,
  type MigrationBackend,
  type MigrationManifestEntry,
} from './migration-manifest.js';
import {
  artifactChecksum,
  SCHEMA_POLICY_DOC,
  type BaseSchema,
  type SchemaDialect,
} from './schema.js';

/** One forward migration, for any backend. */
export interface Migration {
  /** Stable id shared across backends, e.g. `016_add_widget_column`. */
  id: string;
  /** Where the migration came from, for error messages. */
  source: string;
  /** SHA-256 (hex) of this backend's artifact; the ledger records it. */
  checksum: string;
}

/** A SQL migration, loaded from `db/migrations/`. */
export interface SqlMigration extends Migration {
  /** Full SQL text (possibly several statements). */
  sql: string;
}

/** One ledger row. `checksum` is `null` for the baseline's row. */
export interface LedgerEntry {
  id: string;
  checksum: string | null;
  /** `true` while a non-transactional migration has started but not finished. */
  inProgress?: boolean;
}

/**
 * Which caller {@link ensureSchema} serves: the migrate command (creates and
 * upgrades) or server startup (creates an empty database, otherwise only
 * verifies).
 */
export type SchemaMode = 'migrate' | 'startup';

/** Options for `NexusStore.migrate`. */
export interface SchemaOptions {
  /** Default `'migrate'`. Server startup passes `'startup'`. */
  mode?: SchemaMode;
  /**
   * Clear a migration lock a crashed migrator left behind before starting
   * (the migrate command's `--force-unlock`). Only MongoDB keeps a lock that
   * can outlive its holder; the other backends' locks end with their session.
   */
  forceUnlock?: boolean;
}

/** The primitives an adapter provides to {@link ensureSchema}. */
export interface SchemaDriver<M extends Migration = Migration> {
  /** Create the ledger if it does not exist. Must be idempotent. */
  ensureLedger(): Promise<void>;
  /** Every ledger row, in any order. */
  listRecorded(): Promise<LedgerEntry[]>;
  /**
   * Create the base schema **and** record its id, atomically where the
   * driver supports DDL transactions. Called only on an empty ledger, and a
   * no-op if another instance recorded the baseline meanwhile.
   */
  createBaseSchema(schema: BaseSchema): Promise<void>;
  /**
   * Where the backend has transactional DDL: create the base schema and apply
   * every migration in **one** transaction, so another instance sees either
   * an empty database or a complete one. Used instead of
   * {@link createBaseSchema} plus each migration when the ledger is empty.
   */
  createFresh?(schema: BaseSchema, migrations: readonly M[]): Promise<void>;
  /**
   * Take the exclusive migration lock, or refuse at once (a `CONFLICT`) when
   * another migrator holds it: never wait for it, never take it over. Returns
   * its release. Backends that lock inside each transaction instead leave this
   * out.
   */
  acquireLock?(): Promise<() => Promise<void>>;
  /** Whether another migrator holds the lock right now; for refusal messages. */
  lockHeld?(): Promise<boolean>;
  /**
   * Give the ledger its `checksum` and `state` columns if it lacks them (a
   * ledger v0.6.0 created has only `id` and `applied_at`). Called only once
   * every check passed and at least one migration is about to be applied.
   * Idempotent, and safe when two instances call it at once.
   */
  prepareLedger(): Promise<void>;
  /**
   * For a backend that cannot commit a migration with its ledger row: record
   * the migration as in progress, with its checksum, before its first change.
   * Not called when the ledger already holds it in progress (a resume).
   * Backends with transactional DDL leave this out.
   */
  beginMigration?(migration: M): Promise<void>;
  /**
   * Execute one migration and record it applied, with its checksum and time —
   * atomically where the driver supports DDL transactions, otherwise by
   * marking its in-progress entry applied after the last change. Called only
   * for ids the ledger lacks (or holds in progress), in order.
   */
  applyMigration(migration: M): Promise<void>;
}

/** What {@link ensureSchema} did. */
export interface SchemaResult {
  /** `true` when this call created the base schema in an empty database. */
  created: boolean;
  /** Ids of the migrations this call applied, in order. */
  applied: string[];
}

/** A migration id: a numeric prefix of at least three digits, then a name. */
const MIGRATION_ID = /^\d{3,}_[a-z0-9_]+$/;

/** How many ids a refusal quotes before summarising the rest. */
const QUOTED_IDS = 4;

/**
 * Bring a database to this build's schema: create the baseline (and every
 * migration) in an empty one, refuse one this build cannot run against, and,
 * in `'migrate'` mode, apply the migrations the ledger lacks. Writes nothing
 * when there is nothing to do: the ledger is read first, and the lock taken
 * only when there is work. Idempotent.
 */
export async function ensureSchema<M extends Migration>(
  driver: SchemaDriver<M>,
  base: BaseSchema,
  migrations: readonly M[],
  options: { mode?: SchemaMode } = {},
): Promise<SchemaResult> {
  const mode = options.mode ?? 'migrate';
  validateMigrations(migrations, base.id);
  await driver.ensureLedger();
  const initial = await driver.listRecorded();
  const fresh = initial.length === 0;
  if (!fresh) {
    const pending = pendingMigrations(initial, base, migrations);
    if (pending.length === 0) return { created: false, applied: [] };
    if (mode === 'startup') {
      throw notMigratedError(pending, initial, (await driver.lockHeld?.()) === true);
    }
  }
  const release = driver.acquireLock === undefined ? undefined : await driver.acquireLock();
  try {
    return await applySchema(driver, base, migrations, mode === 'migrate' || fresh);
  } finally {
    await release?.();
  }
}

/** The locked half of {@link ensureSchema}: re-read the ledger, then do the work. */
async function applySchema<M extends Migration>(
  driver: SchemaDriver<M>,
  base: BaseSchema,
  migrations: readonly M[],
  mayApply: boolean,
): Promise<SchemaResult> {
  let recorded = await driver.listRecorded();
  let created = false;
  if (recorded.length === 0) {
    try {
      if (driver.createFresh !== undefined) {
        await driver.createFresh(base, migrations);
      } else {
        await driver.createBaseSchema(base);
      }
    } catch (error) {
      throw schemaFailure(base, error);
    }
    created = true;
    recorded = await driver.listRecorded();
  }
  const pending = pendingMigrations(recorded, base, migrations);
  // A fresh database created in one transaction already holds every migration.
  const applied: string[] =
    created && driver.createFresh !== undefined ? migrations.map((migration) => migration.id) : [];
  if (pending.length === 0) return { created, applied };
  if (!mayApply) throw notMigratedError(pending, recorded, false);
  const resuming = new Set(
    recorded.filter((entry) => entry.inProgress === true).map((entry) => entry.id),
  );
  if (resuming.size > 0 && driver.beginMigration === undefined) {
    throw new NexusError(
      'INTERNAL',
      `The schema ledger holds migrations in progress (${quote([...resuming])}), which this ` +
        `backend never records. Its schema and data were not changed. See ${SCHEMA_POLICY_DOC}.`,
      { inProgress: [...resuming].sort() },
    );
  }
  await driver.prepareLedger();
  for (const migration of pending) {
    try {
      if (driver.beginMigration !== undefined && !resuming.has(migration.id)) {
        await driver.beginMigration(migration);
      }
      await driver.applyMigration(migration);
    } catch (error) {
      throw migrationFailure(migration, error);
    }
    applied.push(migration.id);
  }
  return { created, applied };
}

/**
 * The migrations a database with `recorded` in its ledger still needs, in
 * order — or the refusal that says why this build must not touch it.
 */
export function pendingMigrations<M extends Migration>(
  recorded: readonly LedgerEntry[],
  base: BaseSchema,
  migrations: readonly M[],
): M[] {
  if (!recorded.some((entry) => entry.id === base.id)) {
    throw olderSchemaError(
      recorded.map((entry) => entry.id),
      base,
    );
  }
  const known = new Map(migrations.map((migration) => [migration.id, migration]));
  const unknown = recorded.filter((entry) => entry.id !== base.id && !known.has(entry.id));
  if (unknown.length > 0) throw newerSchemaError(unknown, migrations);
  for (const entry of recorded) {
    const migration = known.get(entry.id);
    if (migration !== undefined && entry.checksum !== migration.checksum) {
      throw checksumMismatchError(entry, migration);
    }
  }
  // A migration in progress still needs applying; anything recorded after the
  // first migration that does is a gap.
  const done = new Set(
    recorded.filter((entry) => entry.inProgress !== true).map((entry) => entry.id),
  );
  const seen = new Set(recorded.map((entry) => entry.id));
  const firstPending = migrations.findIndex((migration) => !done.has(migration.id));
  if (firstPending === -1) return [];
  const appliedLater = migrations
    .slice(firstPending + 1)
    .filter((migration) => seen.has(migration.id))
    .map((migration) => migration.id);
  const missing = migrations[firstPending];
  if (appliedLater.length > 0 && missing !== undefined) {
    throw outOfOrderError(missing.id, appliedLater);
  }
  return migrations.filter((migration) => !done.has(migration.id));
}

/**
 * Refuse a migration list this build should never have shipped: a malformed
 * or repeated id, ids out of order, or one that would sort before the
 * baseline. A programming error, caught on the first start of any test.
 */
export function validateMigrations(migrations: readonly Migration[], baseId: string): void {
  let previous = baseId;
  for (const migration of migrations) {
    if (!MIGRATION_ID.test(migration.id)) {
      throw new NexusError('INTERNAL', `Malformed schema migration id '${migration.id}'`);
    }
    if (compareIds(migration.id, previous) <= 0) {
      throw new NexusError(
        'INTERNAL',
        `Schema migration '${migration.id}' is repeated or out of order (after '${previous}')`,
      );
    }
    previous = migration.id;
  }
}

/** Order ids by code point, so the order never depends on the host's locale. */
export function compareIds(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/* ── Refusals ───────────────────────────────────────────────────────────── */

function quote(ids: readonly string[]): string {
  const sorted = [...ids].sort();
  const quoted = sorted.slice(0, QUOTED_IDS).join(', ');
  return sorted.length > QUOTED_IDS ? `${quoted} and ${sorted.length - QUOTED_IDS} more` : quoted;
}

/**
 * The refusal for a database whose ledger lacks the baseline: one created by
 * v0.5.2 or earlier (its ledger holds that release's migration ids), or by
 * something other than Nexus.
 */
export function olderSchemaError(recorded: readonly string[], schema: BaseSchema): NexusError {
  const sorted = [...recorded].sort();
  return new NexusError(
    'INTERNAL',
    `This database was not created by Ferrum Nexus v0.6.0 or later (its schema ledger records ` +
      `${quote(sorted)}; v0.6.0 and later record the baseline ${schema.id}). There is no ` +
      `upgrade path from releases before v0.6.0, and its schema and data were not changed. ` +
      `Back up anything you need, then start this version against a new, empty database ` +
      `(or drop and recreate this one). See ${SCHEMA_POLICY_DOC}.`,
    { recorded: sorted, expected: schema.id },
  );
}

/**
 * The refusal for a database a newer release upgraded, or started upgrading:
 * downgrades are not supported.
 */
export function newerSchemaError(
  unknown: readonly LedgerEntry[],
  migrations: readonly Migration[],
): NexusError {
  const sorted = unknown.map((entry) => entry.id).sort();
  const inProgress = unknown
    .filter((entry) => entry.inProgress === true)
    .map((entry) => entry.id)
    .sort();
  const interrupted =
    inProgress.length > 0
      ? ` That upgrade was interrupted part-way (${quote(inProgress)} in progress): finish it ` +
        `with the same release before anything else.`
      : '';
  return new NexusError(
    'INTERNAL',
    `This database records schema migrations this build of Ferrum Nexus does not know ` +
      `(${quote(sorted)}): a newer release upgraded it. Downgrades are not supported, and ` +
      `its schema and data were not changed.${interrupted} Run the release that upgraded it, ` +
      `or a newer one, or restore the backup taken before that upgrade. Never edit ` +
      `schema_migrations to get past this check. See ${SCHEMA_POLICY_DOC}.`,
    { unknown: sorted, inProgress, known: migrations.map((migration) => migration.id) },
  );
}

/** The command operators run to apply migrations, quoted in refusals. */
const MIGRATE_COMMAND = 'node server/dist/db/migrate-cli.js (npm run migrate from a checkout)';

/**
 * Server startup's refusal for a database that needs migrations this build
 * ships: startup never applies them.
 */
export function notMigratedError(
  pending: readonly Migration[],
  recorded: readonly LedgerEntry[],
  lockHeld: boolean,
): NexusError {
  const ids = pending.map((migration) => migration.id);
  const interrupted = recorded
    .filter((entry) => entry.inProgress === true && ids.includes(entry.id))
    .map((entry) => entry.id);
  const next = lockHeld
    ? 'Another instance is migrating it right now; start again once it has finished.'
    : interrupted.length > 0
      ? `An upgrade by this release was interrupted part-way (${quote(interrupted)} in ` +
        `progress). With every Nexus instance stopped, run the migrate command again with ` +
        `this same release: ${MIGRATE_COMMAND}.`
      : `With every Nexus instance stopped and a backup taken, run the migrate command once: ` +
        `${MIGRATE_COMMAND}. Then start the server.`;
  return new NexusError(
    'INTERNAL',
    `This database needs schema migrations this release ships (${quote(ids)}), and the ` +
      `server never applies migrations at startup; nothing was changed. ${next} See ` +
      `${SCHEMA_POLICY_DOC}.`,
    { pending: ids, inProgress: interrupted, lockHeld },
  );
}

/** The refusal when another migrator holds the migration lock. */
export function schemaBusyError(backend: string, detail = ''): NexusError {
  return new NexusError(
    'CONFLICT',
    `Another Nexus instance holds the ${backend} schema migration lock${detail}, so nothing ` +
      `was changed. Wait for it to finish, then run the command (or start the server) again. ` +
      `See ${SCHEMA_POLICY_DOC}.`,
    { reason: 'schema_lock_held' },
  );
}

/** The refusal for a recorded migration whose shipped artifact changed. */
export function checksumMismatchError(entry: LedgerEntry, migration: Migration): NexusError {
  return new NexusError(
    'INTERNAL',
    `Schema migration ${migration.id} was applied to this database with checksum ` +
      `${entry.checksum ?? '(none)'}, but this build's ${migration.source} has checksum ` +
      `${migration.checksum}. A released migration never changes, so this build or the ` +
      `ledger was modified. Its schema and data were not changed. Run an official release, ` +
      `or restore the backup taken before the upgrade. See ${SCHEMA_POLICY_DOC}.`,
    { id: migration.id, recorded: entry.checksum, expected: migration.checksum },
  );
}

/** The refusal for a ledger with a gap: migrations only ever apply in order. */
export function outOfOrderError(missing: string, appliedLater: readonly string[]): NexusError {
  return new NexusError(
    'INTERNAL',
    `Schema migration ${missing} has not been applied to this database, but later ` +
      `migrations (${quote(appliedLater)}) have. Migrations apply only in id order, so this ` +
      `build added a migration before one that already shipped. Its schema and data were not ` +
      `changed. Run an official release. See ${SCHEMA_POLICY_DOC}.`,
    { missing, appliedLater: [...appliedLater].sort() },
  );
}

/**
 * The error a failed base schema creation surfaces as. A bare driver error
 * does not say what was running, so anything other than a `NexusError` is
 * wrapped, keeping the original as `cause` for its driver code and stack.
 */
function schemaFailure(schema: BaseSchema, error: unknown): unknown {
  if (isNexusError(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`Creating the base schema ${schema.id} failed: ${message}`, { cause: error });
}

/**
 * The error a failed migration surfaces as: one that names it, as the upgrade
 * runbook promises. A `NexusError` is passed on unchanged.
 */
function migrationFailure(migration: Migration, error: unknown): unknown {
  if (isNexusError(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`Schema migration ${migration.id} failed: ${message}`, { cause: error });
}

/* ── Statements a migration may not contain ──────────────────────────── */

const TRANSACTION_CONTROL =
  /^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|START\s+TRANSACTION|END|ABORT|VACUUM)\b/i;
/** PostgreSQL statements that cannot run inside a transaction block. */
const PG_OUTSIDE_TRANSACTION = /\bCONCURRENTLY\b|^CREATE\s+DATABASE\b|^DROP\s+DATABASE\b/i;
const CREATE_HEAD = /^CREATE\b/i;
const BLOCK_OPEN = /\b(BEGIN|CASE)\b/gi;
const BLOCK_CLOSE = /\bEND\b/gi;
const DOLLAR_TAG = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;
const WHITESPACE_RUN = /\s+/g;

/** Net `BEGIN`/`CASE` … `END` nesting in a `CREATE` statement's unquoted text. */
function blockDepth(statement: string): number {
  if (!CREATE_HEAD.test(statement)) return 0;
  return (statement.match(BLOCK_OPEN)?.length ?? 0) - (statement.match(BLOCK_CLOSE)?.length ?? 0);
}

/**
 * A SQL script's top-level statements with every comment and quoted text
 * blanked out (`'…'`, `"…"` and PostgreSQL `$tag$…$tag$` become `''`), for
 * checking what each statement is. A semicolon inside quotes, inside a
 * comment, or inside the `BEGIN … END` body of a `CREATE TRIGGER` or
 * `BEGIN ATOMIC` function does not end a statement.
 */
export function topLevelStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let i = 0;
  const skipQuoted = (quote: string): void => {
    i += 1;
    while (i < sql.length) {
      if (sql[i] === quote) {
        if (sql[i + 1] === quote) {
          i += 2;
          continue;
        }
        break;
      }
      i += 1;
    }
    current += "''";
  };
  while (i < sql.length) {
    const char = sql[i] ?? '';
    const next = sql[i + 1] ?? '';
    if (char === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      current += ' ';
      continue;
    }
    if (char === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth += 1;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      current += ' ';
      continue;
    }
    if (char === "'" || char === '"') {
      skipQuoted(char);
      i += 1;
      continue;
    }
    if (char === '$') {
      const tag = DOLLAR_TAG.exec(sql.slice(i))?.[0];
      if (tag !== undefined) {
        const close = sql.indexOf(tag, i + tag.length);
        i = close === -1 ? sql.length : close + tag.length;
        current += "''";
        continue;
      }
    }
    if (char === ';') {
      const statement = current.trim();
      if (blockDepth(statement) > 0) {
        current += ';';
        i += 1;
        continue;
      }
      if (statement.length > 0) statements.push(statement);
      current = '';
      i += 1;
      continue;
    }
    current += char;
    i += 1;
  }
  const tail = current.trim();
  if (tail.length > 0) statements.push(tail);
  return statements;
}

/**
 * Refuse a SQLite or PostgreSQL migration containing a statement that would
 * end, nest or escape the transaction the runner applies it in (`BEGIN`,
 * `COMMIT`, `ROLLBACK`, `SAVEPOINT`, `VACUUM`, and on PostgreSQL anything
 * `CONCURRENTLY` or `CREATE DATABASE`): a `COMMIT` part-way would leave changes
 * without their ledger row. Called before anything runs.
 */
export function refuseTransactionControl(migration: SqlMigration, dialect: 'sqlite' | 'pg'): void {
  for (const statement of topLevelStatements(migration.sql)) {
    const head = statement.replace(WHITESPACE_RUN, ' ').slice(0, 60);
    if (
      TRANSACTION_CONTROL.test(statement) ||
      (dialect === 'pg' && PG_OUTSIDE_TRANSACTION.test(statement))
    ) {
      throw new NexusError(
        'INTERNAL',
        `Schema migration ${migration.id} (${migration.source}) contains a statement that ` +
          `cannot run inside its migration transaction: ${head}. Migrations run in one ` +
          `transaction with their ledger row; remove transaction control from the file.`,
        { id: migration.id, statement: head },
      );
    }
  }
}

/* ── Loading SQL migration files ────────────────────────────────────────── */

const FILE_PATTERN: Readonly<Record<SchemaDialect, RegExp>> = {
  sqlite: /^(\d{3,}_[a-z0-9_]+)\.sql$/,
  pg: /^(\d{3,}_[a-z0-9_]+)\.pg\.sql$/,
  mysql: /^(\d{3,}_[a-z0-9_]+)\.mysql\.sql$/,
};

/** SQL migration files beside this module, in both source and compiled builds. */
export function migrationsDir(): string {
  return fileURLToPath(new URL('./migrations/', import.meta.url));
}

/** Build a SQL migration from its file name and text, computing its checksum. */
export function sqlMigration(id: string, source: string, sql: string): SqlMigration {
  return { id, source, sql, checksum: artifactChecksum(sql) };
}

/**
 * Read every migration for a dialect from `dir` (default
 * {@link migrationsDir}), sorted by id. A missing directory means no
 * migrations, which is what the baseline ships with.
 */
export function loadMigrations(
  dialect: SchemaDialect,
  dir: string = migrationsDir(),
): SqlMigration[] {
  if (!existsSync(dir)) return [];
  const pattern = FILE_PATTERN[dialect];
  const files: SqlMigration[] = [];
  for (const filename of readdirSync(dir).sort()) {
    const id = pattern.exec(filename)?.[1];
    if (id === undefined) continue;
    files.push(sqlMigration(id, filename, readFileSync(join(dir, filename), 'utf8')));
  }
  return files.sort((a, b) => compareIds(a.id, b.id));
}

/**
 * Check that `migrations` are exactly the shipped ones for `dialect` (a SQL
 * dialect or `mongodb`), by id, order and checksum. Production calls it on
 * every `migrate()` that uses the shipped migrations: through
 * {@link loadShippedMigrations} for SQL, and in the MongoDB adapter.
 */
export function verifyShippedMigrations(
  migrations: readonly Migration[],
  dialect: MigrationBackend,
  manifest: readonly MigrationManifestEntry[] = MIGRATION_MANIFEST,
): void {
  const expected = manifest.map((entry) => entry.id);
  const found = migrations.map((migration) => migration.id);
  const missing = expected.filter((id) => !found.includes(id));
  const extra = found.filter((id) => !expected.includes(id));
  const order = found.join(',') === expected.join(',');
  if (missing.length > 0 || extra.length > 0 || !order) {
    const where = dialect === 'mongodb' ? 'MONGO_MIGRATIONS' : migrationsDir();
    throw new NexusError(
      'INTERNAL',
      `This build's ${dialect} migrations do not match the migrations it ships ` +
        `(missing: ${missing.length > 0 ? quote(missing) : 'none'}; unexpected: ` +
        `${extra.length > 0 ? quote(extra) : 'none'}) in ${where}. The image or ` +
        `installation is incomplete or modified; nothing was changed. Reinstall an official ` +
        `release. See ${SCHEMA_POLICY_DOC}.`,
      { dialect, missing, extra },
    );
  }
  for (const entry of manifest) {
    const migration = migrations.find((candidate) => candidate.id === entry.id);
    if (migration !== undefined && migration.checksum !== entry.sha256[dialect]) {
      throw new NexusError(
        'INTERNAL',
        `This build's ${migration.source} has checksum ${migration.checksum}, but the ` +
          `release ships ${entry.sha256[dialect]}. The image or installation is modified; ` +
          `nothing was changed. Reinstall an official release. See ${SCHEMA_POLICY_DOC}.`,
        { dialect, id: entry.id, found: migration.checksum, expected: entry.sha256[dialect] },
      );
    }
  }
}

/**
 * The shipped migrations for a dialect, read from {@link migrationsDir} and
 * checked against `migration-manifest.ts` (see {@link verifyShippedMigrations}).
 * What every adapter's `migrate()` applies unless a test overrides it.
 */
export function loadShippedMigrations(dialect: SchemaDialect): SqlMigration[] {
  const migrations = loadMigrations(dialect);
  verifyShippedMigrations(migrations, dialect);
  return migrations;
}
