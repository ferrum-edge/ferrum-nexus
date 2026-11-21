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
 * - a ledger holding exactly this build's fingerprint means the schema is
 *   current: do nothing;
 * - an empty ledger in a database that holds none of the schema's tables
 *   means a new database: create the base schema and record its fingerprint
 *   (atomically where the driver has transactional DDL);
 * - a ledger holding only this build's *claim* (`creating:<fingerprint>`)
 *   means a creation by this build stopped part-way, on a driver that cannot
 *   create the schema atomically: finish it;
 * - anything else — an earlier release's migration ids, the fingerprint or
 *   claim of a base schema this build does not have, or the schema's tables
 *   with no record at all — fails fast before any service touches the data,
 *   leaving the schema and data as they were.
 *
 * Because the fingerprint is computed from the schema's statements, editing
 * the base schema changes it, so a database created before the edit is
 * refused rather than run against tables that no longer match the code.
 * Comments and runs of whitespace outside quoted literals are not part of the
 * fingerprint.
 *
 * Two instances starting on one empty database at once both succeed: the
 * loser of the creation race finds the winner's record and accepts it.
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
  /** Every table (MongoDB: collection) the schema defines. */
  tables: readonly string[];
}

/** The ledger row a non-atomic driver writes before its first DDL. */
export function schemaClaim(schema: BaseSchema): string {
  return `creating:${schema.id}`;
}

/** The primitives an adapter provides to {@link ensureBaseSchema}. */
export interface SchemaDriver {
  /** Create the ledger table if it does not exist. Must be idempotent. */
  ensureLedger(): Promise<void>;
  /** Ids recorded in the ledger, in any order. */
  listRecorded(): Promise<string[]>;
  /** Which of `schema.tables` already exist in the database. */
  existingTables(schema: BaseSchema): Promise<string[]>;
  /**
   * Create the base schema **and** record its id. A driver with
   * transactional DDL does both atomically. One without writes
   * {@link schemaClaim} before its first DDL, makes every statement
   * replayable, and replaces the claim with the id last; with
   * `resume: true` the claim is already there and the schema is replayed.
   * A driver that finds a peer of this build already creating the schema
   * throws {@link SchemaBusyError}.
   */
  createBaseSchema(schema: BaseSchema, options: { resume: boolean }): Promise<void>;
}

/** Thrown by a driver when another instance is creating the same schema. */
export class SchemaBusyError extends Error {
  constructor(message = 'Another instance is creating the base schema') {
    super(message);
    this.name = 'SchemaBusyError';
  }
}

/** What {@link ensureBaseSchema} did. */
export interface SchemaResult {
  /** `true` when this call created the schema in an empty database. */
  created: boolean;
}

/** How long a start waits for a peer that is creating the same schema. */
export interface SchemaWaitOptions {
  /** Total wait; default 60 s. */
  peerWaitMs?: number;
  /** Poll interval; default 250 ms. */
  pollMs?: number;
}

/** Where operators read the policy; named in every refusal. */
export const SCHEMA_POLICY_DOC = 'docs/operations.md, "Schema and upgrades before 1.0"';

const DEFAULT_PEER_WAIT_MS = 60_000;
const DEFAULT_POLL_MS = 250;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The ledger shows `schema` created: its id, and at most its own leftover claim. */
function isCurrent(recorded: readonly string[], schema: BaseSchema): boolean {
  const claim = schemaClaim(schema);
  return recorded.includes(schema.id) && recorded.every((id) => id === schema.id || id === claim);
}

/**
 * Create the base schema in an empty database, accept a database already at
 * it, and refuse any other.
 *
 * Idempotent: a second call against the same database changes nothing.
 */
export async function ensureBaseSchema(
  driver: SchemaDriver,
  schema: BaseSchema,
  options: SchemaWaitOptions = {},
): Promise<SchemaResult> {
  try {
    await driver.ensureLedger();
  } catch {
    // Two first starts can race to create the ledger table itself (PostgreSQL
    // reports the loser's duplicate catalog row); the second try finds it.
    await sleep(options.pollMs ?? DEFAULT_POLL_MS);
    await driver.ensureLedger();
  }
  let recorded = await driver.listRecorded();
  if (isCurrent(recorded, schema)) return { created: false };
  const claim = schemaClaim(schema);
  let resume = recorded.length === 1 && recorded[0] === claim;
  if (recorded.length > 0 && !resume) throw olderSchemaError(recorded, schema);

  if (!resume) {
    const existing = await driver.existingTables(schema);
    if (existing.length > 0) {
      // A peer of this build may have created (or be creating) the schema
      // since the ledger was read: its tables and its record or claim land
      // before this second read.
      recorded = await driver.listRecorded();
      if (isCurrent(recorded, schema)) return { created: false };
      if (recorded.length === 1 && recorded[0] === claim) resume = true;
      else if (recorded.length > 0) throw olderSchemaError(recorded, schema);
      else throw unrecordedSchemaError(existing, schema);
    }
  }

  try {
    await driver.createBaseSchema(schema, { resume });
  } catch (error) {
    if (await peerCreated(driver, schema, error, options)) return { created: false };
    throw schemaFailure(schema, error);
  }
  // A different build creating its own schema on the same empty database at
  // the same moment would leave two records; refuse rather than run on it.
  recorded = await driver.listRecorded();
  if (!isCurrent(recorded, schema)) throw olderSchemaError(recorded, schema);
  return { created: true };
}

/**
 * Whether a failed creation lost a race to a peer that created this schema.
 * A {@link SchemaBusyError} means the peer is still at it, so wait for its
 * record; any other failure is a peer's only if its record is already there.
 */
async function peerCreated(
  driver: SchemaDriver,
  schema: BaseSchema,
  error: unknown,
  options: SchemaWaitOptions,
): Promise<boolean> {
  const read = (): Promise<string[]> => driver.listRecorded().catch(() => []);
  if (isCurrent(await read(), schema)) return true;
  if (!(error instanceof SchemaBusyError)) return false;
  const deadline = Date.now() + (options.peerWaitMs ?? DEFAULT_PEER_WAIT_MS);
  const claim = schemaClaim(schema);
  while (Date.now() < deadline) {
    await sleep(options.pollMs ?? DEFAULT_POLL_MS);
    const recorded = await read();
    if (isCurrent(recorded, schema)) return true;
    if (!recorded.every((id) => id === claim)) return false;
  }
  return false;
}

/** How many recorded ids a refusal quotes before summarising the rest. */
const QUOTED_IDS = 4;

/** `a, b, c, d and 9 more` */
function quote(ids: readonly string[]): string {
  const quoted = ids.slice(0, QUOTED_IDS).join(', ');
  return ids.length > QUOTED_IDS ? `${quoted} and ${ids.length - QUOTED_IDS} more` : quoted;
}

const WHAT_TO_DO =
  'Ferrum Nexus has no upgrade path before 1.0: a database created by an earlier version is ' +
  'never migrated, and its schema and data were not changed. Back up anything you need, then ' +
  'start this version against a new, empty database (or drop and recreate this one). ' +
  `See ${SCHEMA_POLICY_DOC}.`;

/**
 * The refusal for a database this build did not create: one created by an
 * earlier release (its ledger holds that release's migration ids) or from an
 * earlier version of the base schema. It says what was found, that nothing
 * was changed, and what the operator does next.
 */
export function olderSchemaError(recorded: readonly string[], schema: BaseSchema): NexusError {
  const sorted = [...recorded].sort();
  return new NexusError(
    'INTERNAL',
    `This database was created by a different Ferrum Nexus schema (it records ` +
      `${quote(sorted)}; this build's schema is ${schema.id}). ${WHAT_TO_DO}`,
    { recorded: sorted, expected: schema.id },
  );
}

/**
 * The refusal for a database that holds the schema's tables but no record of
 * creating them: an earlier version's database whose own first start stopped
 * before recording anything, or tables made by hand.
 */
export function unrecordedSchemaError(tables: readonly string[], schema: BaseSchema): NexusError {
  const sorted = [...tables].sort();
  return new NexusError(
    'INTERNAL',
    `This database already holds Ferrum Nexus tables (${quote(sorted)}) but no record of the ` +
      `schema that created them, so this build (schema ${schema.id}) cannot tell what they ` +
      `are. ${WHAT_TO_DO}`,
    { recorded: [], tables: sorted, expected: schema.id },
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

const WHITESPACE = /\s/;
const CREATE_TABLE = /^CREATE TABLE IF NOT EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)/i;

/** SQL assets beside this module, in both source and compiled builds. */
export function schemaDir(): string {
  return fileURLToPath(new URL('./schema/', import.meta.url));
}

/**
 * One statement in canonical form: every run of whitespace outside a
 * single-quoted literal becomes one space, and the ends are trimmed. Literal
 * contents are kept byte for byte, so `'two  words'` and `'two words'` stay
 * different.
 */
export function canonicalStatement(statement: string): string {
  let out = '';
  let inString = false;
  let pendingSpace = false;
  for (const char of statement) {
    if (inString) {
      out += char;
      if (char === "'") inString = false;
      continue;
    }
    if (WHITESPACE.test(char)) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) out += ' ';
    pendingSpace = false;
    out += char;
    if (char === "'") inString = true;
  }
  return out;
}

/**
 * `base_` plus the first 16 hex digits of the SHA-256 of `parts`, which the
 * caller passes already canonical: the same schema always yields the same id,
 * and any change to a part yields another.
 */
export function schemaFingerprint(parts: readonly string[]): string {
  return `base_${createHash('sha256').update(parts.join(';\n')).digest('hex').slice(0, 16)}`;
}

/** The tables a list of `CREATE TABLE IF NOT EXISTS` statements defines. */
function tablesOf(statements: readonly string[]): string[] {
  return statements.flatMap((statement) => {
    const match = CREATE_TABLE.exec(statement);
    return match?.[1] ? [match[1]] : [];
  });
}

/** Read a dialect's base schema from {@link schemaDir}. */
export function loadBaseSchema(dialect: SchemaDialect): BaseSchema {
  const filename = FILE_FOR[dialect];
  const sql = readFileSync(join(schemaDir(), filename), 'utf8');
  const statements = splitSqlStatements(sql).map(canonicalStatement);
  if (statements.length === 0) {
    throw new NexusError('INTERNAL', `The ${dialect} base schema ${filename} is empty`);
  }
  return { id: schemaFingerprint(statements), source: filename, sql, tables: tablesOf(statements) };
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
