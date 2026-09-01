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

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { internal } from '../lib/errors.js';

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
 * second time.
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
    await driver.applyMigration(migration);
    result.applied.push(migration.id);
  }
  return result;
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

/**
 * Directory holding the `.sql` files.
 *
 * Resolved relative to this module so it works from `src/` under tsx and from
 * `dist/` after `tsc`. When the compiled tree does not carry the `.sql` files
 * (plain `tsc` does not copy assets), it falls back to the source tree.
 */
export function migrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'migrations'),
    resolve(here, '..', '..', 'src', 'db', 'migrations'),
    resolve(here, '..', '..', '..', 'src', 'db', 'migrations'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw internal(`Could not locate the migrations directory (looked in ${candidates.join(', ')})`);
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
