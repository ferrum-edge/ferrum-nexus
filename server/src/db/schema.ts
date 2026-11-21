/**
 * The base schema, and the one rule every adapter applies to it.
 *
 * **There are no migrations before Ferrum Nexus 1.0.** Each backend has one
 * base schema — `schema/base.sql` (SQLite), `schema/base.pg.sql`
 * (PostgreSQL), `schema/base.mysql.sql` (MySQL) and the index list in the
 * MongoDB adapter — and a new database is created directly at it. A schema
 * change edits the base schema; there is no upgrade path between pre-1.0
 * releases, and a database created by an earlier version is refused, never
 * migrated (docs/operations.md, "Schema and upgrades before 1.0").
 *
 * Every adapter records the schema it created in a `schema_migrations` table
 * (for MongoDB, a collection), as one row whose id is a fingerprint of that
 * schema's statements. The table keeps the name the pre-0.6 migration ledger
 * used on purpose: a database an earlier release created still carries its
 * migration ids there, which is how {@link ensureBaseSchema} recognises it
 * and refuses it instead of creating tables over it.
 *
 * On every start:
 *
 * - an empty ledger means a new database: create the base schema and record
 *   its fingerprint (atomically where the driver has transactional DDL);
 * - a ledger holding exactly this build's fingerprint means the schema is
 *   current: do nothing;
 * - anything else — an earlier release's migration ids, or the fingerprint
 *   of a base schema this build no longer has — fails fast with
 *   {@link olderSchemaError}, before any service touches the data.
 *
 * Because the fingerprint is computed from the schema's statements, editing
 * the base schema changes it, so a database created before the edit is
 * refused rather than run against tables that no longer match the code.
 * Comments and whitespace are not part of the fingerprint.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { NexusError, isNexusError } from '../lib/errors.js';

/**
 * Name of the bookkeeping table/collection every adapter maintains. Shared
 * with the pre-0.6 migration ledger so an older database is recognised.
 */
export const SCHEMA_LEDGER_TABLE = 'schema_migrations';

/** SQL dialect variant of the base schema. */
export type SchemaDialect = 'sqlite' | 'pg' | 'mysql';

/** One backend's base schema. */
export interface BaseSchema {
  /** `base_<fingerprint>`: what the ledger records for this schema. */
  id: string;
  /** Where the schema came from, for error messages. */
  source: string;
  /** Full SQL text (several statements); empty for MongoDB. */
  sql: string;
}

/** The primitives an adapter provides to {@link ensureBaseSchema}. */
export interface SchemaDriver {
  /** Create the ledger table if it does not exist. Must be idempotent. */
  ensureLedger(): Promise<void>;
  /** Ids recorded in the ledger, in any order. */
  listRecorded(): Promise<string[]>;
  /**
   * Create the base schema **and** record its id, atomically where the
   * driver supports DDL transactions. Called only on an empty ledger.
   */
  createBaseSchema(schema: BaseSchema): Promise<void>;
}

/** What {@link ensureBaseSchema} did. */
export interface SchemaResult {
  /** `true` when this call created the schema in an empty database. */
  created: boolean;
}

/** Where operators read the policy; named in every refusal. */
export const SCHEMA_POLICY_DOC = 'docs/operations.md, "Schema and upgrades before 1.0"';

/**
 * Create the base schema in an empty database, accept a database already at
 * it, and refuse any other.
 *
 * Idempotent: a second call against the same database changes nothing.
 */
export async function ensureBaseSchema(
  driver: SchemaDriver,
  schema: BaseSchema,
): Promise<SchemaResult> {
  await driver.ensureLedger();
  const recorded = await driver.listRecorded();
  if (recorded.length === 1 && recorded[0] === schema.id) return { created: false };
  if (recorded.length > 0) throw olderSchemaError(recorded, schema);
  try {
    await driver.createBaseSchema(schema);
  } catch (error) {
    throw schemaFailure(schema, error);
  }
  return { created: true };
}

/** How many recorded ids a refusal quotes before summarising the rest. */
const QUOTED_IDS = 4;

/**
 * The refusal for a database this build did not create: one created by an
 * earlier release (its ledger holds that release's migration ids) or from an
 * earlier version of the base schema. It says what was found, that nothing
 * was changed, and what the operator does next.
 */
export function olderSchemaError(recorded: readonly string[], schema: BaseSchema): NexusError {
  const sorted = [...recorded].sort();
  const quoted = sorted.slice(0, QUOTED_IDS).join(', ');
  const more = sorted.length > QUOTED_IDS ? ` and ${sorted.length - QUOTED_IDS} more` : '';
  return new NexusError(
    'INTERNAL',
    `This database was created by a different Ferrum Nexus schema (it records ${quoted}${more}; ` +
      `this build's schema is ${schema.id}). Ferrum Nexus has no upgrade path before 1.0: a ` +
      `database created by an earlier version is never migrated, and nothing was changed. ` +
      `Back up anything you need, then start this version against a new, empty database ` +
      `(or drop and recreate this one). See ${SCHEMA_POLICY_DOC}.`,
    { recorded: sorted, expected: schema.id },
  );
}

/**
 * The error a failed schema creation surfaces as. A bare driver error does
 * not say what was running, so anything other than a `NexusError` is wrapped,
 * keeping the original as `cause` for its driver code and stack.
 */
function schemaFailure(schema: BaseSchema, error: unknown): unknown {
  if (isNexusError(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`Creating the base schema ${schema.id} failed: ${message}`, { cause: error });
}

/* ── Loading the base schema ────────────────────────────────────────────── */

const FILE_FOR: Record<SchemaDialect, string> = {
  sqlite: 'base.sql',
  pg: 'base.pg.sql',
  mysql: 'base.mysql.sql',
};

const WHITESPACE_RUN = /\s+/g;

/** SQL assets beside this module, in both source and compiled builds. */
export function schemaDir(): string {
  return fileURLToPath(new URL('./schema/', import.meta.url));
}

/**
 * `base_` plus the first 16 hex digits of the SHA-256 of `parts`, each part
 * whitespace-normalised: the same schema always yields the same id, and any
 * change to a statement yields another.
 */
export function schemaFingerprint(parts: readonly string[]): string {
  const canonical = parts.map((part) => part.replace(WHITESPACE_RUN, ' ').trim()).join(';\n');
  return `base_${createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`;
}

/** Read a dialect's base schema from {@link schemaDir}. */
export function loadBaseSchema(dialect: SchemaDialect): BaseSchema {
  const filename = FILE_FOR[dialect];
  const sql = readFileSync(join(schemaDir(), filename), 'utf8');
  const statements = splitSqlStatements(sql);
  if (statements.length === 0) {
    throw new NexusError('INTERNAL', `The ${dialect} base schema ${filename} is empty`);
  }
  return { id: schemaFingerprint(statements), source: filename, sql };
}

/* ── SQL helpers for adapters whose driver runs one statement at a time ─── */

/**
 * Split a schema file into individual statements.
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
