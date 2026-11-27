/**
 * The frozen base schema: the baseline every database starts from.
 *
 * Each backend has one base schema — `schema/base.sql` (SQLite),
 * `schema/base.pg.sql` (PostgreSQL), `schema/base.mysql.sql` (MySQL) and
 * `BASE_INDEXES` in the MongoDB adapter. It is the Ferrum Nexus 1.0 baseline,
 * unchanged since v0.6.0 first shipped it, and it is **frozen**: from 1.0.0
 * onward it is never edited, and every schema change ships as a numbered
 * forward migration (`migrate.ts`, `migrations/`). `frozen-baseline.test.ts`
 * fails on any change to these artifacts.
 *
 * A database records its schema in the `schema_migrations` table (for
 * MongoDB, the collection of the same name): {@link BASE_SCHEMA_ID} for the
 * baseline, then one entry per forward migration applied on top of it. The
 * rules that read and extend that ledger at startup live in `migrate.ts`
 * (docs/operations.md, "Schema and upgrades").
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { NexusError } from '../lib/errors.js';

const CRLF = /\r\n/g;

/**
 * Name of the bookkeeping table/collection every adapter maintains. The
 * pre-0.6 migration runner used the same name, so a database an earlier
 * release created is recognised by its migration ids and refused.
 */
export const SCHEMA_LEDGER_TABLE = 'schema_migrations';

/**
 * The ledger id of the frozen baseline. v0.6.0 first recorded it, and the
 * baseline has not changed since, so Nexus 1.0 opens a database v0.6.0
 * created. **Never change it**: a schema change is a forward migration.
 */
export const BASE_SCHEMA_ID = '000_base_v0_6';

/** SQL dialect variant of the base schema and of each migration. */
export type SchemaDialect = 'sqlite' | 'pg' | 'mysql';

/** One backend's base schema. */
export interface BaseSchema {
  /** What the ledger records for this schema: {@link BASE_SCHEMA_ID}. */
  id: string;
  /** Where the schema came from, for error messages. */
  source: string;
  /** Full SQL text (several statements); empty for MongoDB. */
  sql: string;
}

/** Where operators read the policy; named in every refusal. */
export const SCHEMA_POLICY_DOC = 'docs/operations.md, "Schema and upgrades"';

/**
 * SHA-256 (hex) of a schema artifact's text with CRLF line endings normalised
 * to LF, so `shasum -a 256 <file>` on an LF checkout reproduces it.
 */
export function artifactChecksum(text: string): string {
  return createHash('sha256').update(text.replace(CRLF, '\n')).digest('hex');
}

/* ── Loading the base schema ────────────────────────────────────────────── */

/** The base schema file of each SQL dialect, inside {@link schemaDir}. */
export const BASE_SCHEMA_FILE: Readonly<Record<SchemaDialect, string>> = {
  sqlite: 'base.sql',
  pg: 'base.pg.sql',
  mysql: 'base.mysql.sql',
};

/** SQL assets beside this module, in both source and compiled builds. */
export function schemaDir(): string {
  return fileURLToPath(new URL('./schema/', import.meta.url));
}

/** Read a dialect's base schema from {@link schemaDir}. */
export function loadBaseSchema(dialect: SchemaDialect): BaseSchema {
  const filename = BASE_SCHEMA_FILE[dialect];
  const sql = readFileSync(join(schemaDir(), filename), 'utf8');
  const statements = splitSqlStatements(sql);
  if (statements.length === 0) {
    throw new NexusError('INTERNAL', `The ${dialect} base schema ${filename} is empty`);
  }
  return { id: BASE_SCHEMA_ID, source: filename, sql };
}

const BASE_TABLE = /^CREATE TABLE IF NOT EXISTS\s+([a-z][a-z0-9_]*)/i;

/** The tables a SQL base schema creates, in file order. */
export function baseTables(schema: BaseSchema): string[] {
  return splitSqlStatements(schema.sql).flatMap((statement) => {
    const table = BASE_TABLE.exec(statement)?.[1];
    return table === undefined ? [] : [table];
  });
}

/* ── SQL helpers for adapters whose driver runs one statement at a time ─── */

/**
 * Split a schema or migration file into individual statements.
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
