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
 * On every start ({@link ensureSchema}):
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
}

/** The primitives an adapter provides to {@link ensureSchema}. */
export interface SchemaDriver<M extends Migration = Migration> {
  /** Create the ledger if it does not exist. Must be idempotent. */
  ensureLedger(): Promise<void>;
  /** Every ledger row, in any order. */
  listRecorded(): Promise<LedgerEntry[]>;
  /**
   * Create the base schema **and** record its id, atomically where the
   * driver supports DDL transactions. Called only on an empty ledger.
   */
  createBaseSchema(schema: BaseSchema): Promise<void>;
  /**
   * Give the ledger its `checksum` column if it lacks one (a ledger v0.6.0
   * created has only `id` and `applied_at`). Called only once every check
   * passed and at least one migration is about to be applied. Idempotent.
   */
  prepareLedger(): Promise<void>;
  /**
   * Execute one migration **and** record its id, checksum and time,
   * atomically where the driver supports DDL transactions. Called only for
   * ids the ledger lacks, in order.
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
 * Bring a database to this build's schema: create the baseline in an empty
 * one, refuse one this build cannot run against, and apply the migrations the
 * ledger lacks. Idempotent: a second call against the same database changes
 * nothing.
 */
export async function ensureSchema<M extends Migration>(
  driver: SchemaDriver<M>,
  base: BaseSchema,
  migrations: readonly M[],
): Promise<SchemaResult> {
  validateMigrations(migrations, base.id);
  await driver.ensureLedger();
  let recorded = await driver.listRecorded();
  let created = false;
  if (recorded.length === 0) {
    try {
      await driver.createBaseSchema(base);
    } catch (error) {
      throw schemaFailure(base, error);
    }
    created = true;
    recorded = [{ id: base.id, checksum: null }];
  }
  const pending = pendingMigrations(recorded, base, migrations);
  const applied: string[] = [];
  if (pending.length === 0) return { created, applied };
  await driver.prepareLedger();
  for (const migration of pending) {
    try {
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
  const unknown = recorded
    .map((entry) => entry.id)
    .filter((id) => id !== base.id && !known.has(id));
  if (unknown.length > 0) throw newerSchemaError(unknown, migrations);
  for (const entry of recorded) {
    const migration = known.get(entry.id);
    if (migration !== undefined && entry.checksum !== migration.checksum) {
      throw checksumMismatchError(entry, migration);
    }
  }
  const done = new Set(recorded.map((entry) => entry.id));
  const firstPending = migrations.findIndex((migration) => !done.has(migration.id));
  if (firstPending === -1) return [];
  const appliedLater = migrations
    .slice(firstPending + 1)
    .filter((migration) => done.has(migration.id))
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

/** The refusal for a database a newer release upgraded: downgrades are not supported. */
export function newerSchemaError(
  unknown: readonly string[],
  migrations: readonly Migration[],
): NexusError {
  const sorted = [...unknown].sort();
  return new NexusError(
    'INTERNAL',
    `This database records schema migrations this build of Ferrum Nexus does not know ` +
      `(${quote(sorted)}): a newer release upgraded it. Downgrades are not supported, and ` +
      `its schema and data were not changed. Run the release that upgraded it, or a newer ` +
      `one, or restore the backup taken before that upgrade. Never edit schema_migrations to ` +
      `get past this check. See ${SCHEMA_POLICY_DOC}.`,
    { unknown: sorted, known: migrations.map((migration) => migration.id) },
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
