/**
 * Driver-agnostic migration runner.
 *
 * Every adapter records applied migrations in a `schema_migrations` table (or,
 * for MongoDB, a collection of the same name) with one row per migration id.
 * The adapter supplies the three primitives in {@link MigrationDriver}; the
 * ordering, idempotency and "already applied" logic live here so all four
 * adapters behave identically.
 *
 * Migration files live in `db/migrations/` and are named
 * `NNN_description.sql` (SQLite), `NNN_description.pg.sql` (PostgreSQL) and
 * `NNN_description.mysql.sql` (MySQL). The numeric prefix plus the description
 * is the migration **id**, so the same logical migration shares one id across
 * dialects and a database can never be migrated twice.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { internal, isNexusError } from '../lib/errors.js';

/** Name of the bookkeeping table/collection every adapter maintains. */
export const SCHEMA_MIGRATIONS_TABLE = 'schema_migrations';

/** SQL dialect variant of a migration file. */
export type MigrationDialect = 'sqlite' | 'pg' | 'mysql';

/** One migration, loaded from disk. */
export interface MigrationFile {
  /** Stable id shared across dialects, e.g. `001_initial`. */
  id: string;
  /** File name the SQL was read from. */
  filename: string;
  /** Full SQL text (possibly several statements). */
  sql: string;
}

/** The three primitives an adapter must provide to run migrations. */
export interface MigrationDriver {
  /** Create `schema_migrations` if it does not exist. Must be idempotent. */
  ensureMigrationsTable(): Promise<void>;
  /** Ids already recorded, in any order. */
  listApplied(): Promise<string[]>;
  /**
   * Execute one migration **and** record its id, atomically where the driver
   * supports DDL transactions. Called only for ids not already applied.
   */
  applyMigration(migration: MigrationFile): Promise<void>;
}

/** Outcome of a {@link runMigrations} pass. */
export interface MigrationResult {
  /** Ids applied during this run, in order. */
  applied: string[];
  /** Ids that were already recorded. */
  skipped: string[];
}

/**
 * Apply every migration that has not been recorded yet, in id order.
 *
 * Idempotent: running it twice against the same database applies nothing the
 * second time. A migration that fails stops the run with an error naming it
 * ({@link migrationFailure}); the ones before it stay applied.
 */
export async function runMigrations(
  driver: MigrationDriver,
  migrations: MigrationFile[],
): Promise<MigrationResult> {
  await driver.ensureMigrationsTable();
  const applied = new Set(await driver.listApplied());
  const result: MigrationResult = { applied: [], skipped: [] };

  for (const migration of [...migrations].sort((a, b) => a.id.localeCompare(b.id))) {
    if (applied.has(migration.id)) {
      result.skipped.push(migration.id);
      continue;
    }
    try {
      await driver.applyMigration(migration);
    } catch (error) {
      throw migrationFailure(migration.id, error);
    }
    result.applied.push(migration.id);
  }
  return result;
}

/**
 * The error a failed migration surfaces as: one that names it, as the upgrade
 * runbook promises (docs/operations.md, "Upgrade failures and rollback").
 *
 * A bare driver error (`column "priority" of relation "email_outbox" already
 * exists`) does not say which migration ran it, so anything other than a
 * `NexusError` is wrapped, keeping the original as `cause` for its driver code
 * and stack. A `NexusError` is passed on unchanged: it carries its own code
 * and message.
 */
function migrationFailure(id: string, error: unknown): unknown {
  if (isNexusError(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`Migration ${id} failed: ${message}`, { cause: error });
}

/* ── Loading migration files ────────────────────────────────────────────── */

const SQLITE_FILE = /^(\d{3,}_[a-z0-9_]+)\.sql$/;
const PG_FILE = /^(\d{3,}_[a-z0-9_]+)\.pg\.sql$/;
const MYSQL_FILE = /^(\d{3,}_[a-z0-9_]+)\.mysql\.sql$/;

function patternFor(dialect: MigrationDialect): RegExp {
  if (dialect === 'pg') return PG_FILE;
  if (dialect === 'mysql') return MYSQL_FILE;
  return SQLITE_FILE;
}

/** SQL assets beside this module, in both source and compiled builds. */
export function migrationsDir(): string {
  return fileURLToPath(new URL('./migrations/', import.meta.url));
}

/** Read every migration for a dialect from {@link migrationsDir}, sorted by id. */
export function loadMigrations(dialect: MigrationDialect): MigrationFile[] {
  const dir = migrationsDir();
  const pattern = patternFor(dialect);
  const files: MigrationFile[] = [];

  for (const filename of readdirSync(dir).sort()) {
    const match = pattern.exec(filename);
    if (!match) continue;
    const id = match[1];
    if (id === undefined) continue;
    files.push({ id, filename, sql: readFileSync(join(dir, filename), 'utf8') });
  }

  if (files.length === 0) {
    throw internal(`No ${dialect} migrations found in ${dir}`);
  }
  return files.sort((a, b) => a.id.localeCompare(b.id));
}

/* ── SQL helpers for adapters whose driver runs one statement at a time ─── */

/**
 * Split a migration file into individual statements.
 *
 * Handles `--` line comments and single-quoted literals (including `''`
 * escapes). Adapters that can execute a whole script at once (better-sqlite3's
 * `exec`) do not need this; `pg` and `mysql2` do.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inString = false;
  let inLineComment = false;

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i] ?? '';
    const next = sql[i + 1] ?? '';

    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false;
        current += char;
      }
      continue;
    }
    if (inString) {
      current += char;
      if (char === "'") {
        if (next === "'") {
          current += next;
          i += 1;
        } else {
          inString = false;
        }
      }
      continue;
    }
    if (char === '-' && next === '-') {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (char === "'") {
      inString = true;
      current += char;
      continue;
    }
    if (char === ';') {
      const trimmed = current.trim();
      if (trimmed.length > 0) statements.push(trimmed);
      current = '';
      continue;
    }
    current += char;
  }

  const tail = current.trim();
  if (tail.length > 0) statements.push(tail);
  return statements;
}
