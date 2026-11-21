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
 * On every start, before anything reads the data:
 *
 * - a ledger holding exactly this build's fingerprint means the schema is
 *   current: do nothing;
 * - an empty or missing ledger in a database that holds none of the schema's
 *   tables means a new database: create the base schema and record its
 *   fingerprint;
 * - on a driver that cannot create the schema in one transaction (MySQL,
 *   MongoDB), a ledger holding this build's *claim* (`creating:<fingerprint>`)
 *   means a creation by this build stopped part-way: finish it;
 * - anything else — an earlier release's migration ids, the fingerprint or
 *   claim of a base schema this build does not have, or the schema's tables
 *   with no record at all — fails fast, leaving the schema and data as they
 *   were.
 *
 * Creation has a single winner per database. Each driver creates the schema
 * inside an exclusive section (a transaction-scoped advisory lock, an
 * immediate SQLite transaction, the MySQL advisory lock, or a MongoDB claim on
 * one fixed ledger key) and re-reads the ledger there before any DDL. A start
 * that finds another start got there first changes nothing and classifies the
 * database again: the same build's schema is accepted, any other is refused.
 *
 * Because the fingerprint is computed from the schema's statements, editing
 * the base schema changes it, so a database created before the edit is
 * refused rather than run against tables that no longer match the code.
 * Comments and runs of whitespace outside quoted literals are not part of the
 * fingerprint.
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

/** The ledger entry a non-atomic driver holds while it creates the schema. */
export function schemaClaim(schema: BaseSchema): string {
  return `creating:${schema.id}`;
}

/** The primitives an adapter provides to {@link ensureBaseSchema}. */
export interface SchemaDriver {
  /**
   * Whether the driver writes {@link schemaClaim} entries (it cannot create
   * the schema in one transaction). Only such a driver may resume one.
   */
  readonly writesClaims: boolean;
  /** Entries in the ledger, in any order; empty when there is no ledger. */
  listRecorded(): Promise<string[]>;
  /** Which of `schema.tables` already exist in the database. */
  existingTables(schema: BaseSchema): Promise<string[]>;
  /**
   * Create the ledger (if missing) and the base schema, and record the
   * schema's id, inside an exclusive section. Before any DDL, re-read the
   * ledger there and require it to be empty, with none of `schema.tables`
   * present (or, with `resume: true`, to hold exactly this build's
   * claim); otherwise change nothing and throw {@link SchemaRaceError}. A driver with transactional DDL does all of it
   * atomically. One without writes the claim before its first DDL, makes
   * every statement replayable, and publishes the id last. A driver that
   * finds a peer of this build already creating the schema throws
   * {@link SchemaBusyError}.
   */
  createBaseSchema(schema: BaseSchema, options: { resume: boolean }): Promise<void>;
}

/** Thrown by a driver when another instance is creating the same schema. */
export class SchemaBusyError extends Error {
  constructor(message = 'Another instance is creating the base schema', options?: ErrorOptions) {
    super(message, options);
    this.name = 'SchemaBusyError';
  }
}

/** Thrown by a driver whose exclusive re-read found the database changed. */
export class SchemaRaceError extends Error {
  constructor(message = 'The database changed while the base schema was being created') {
    super(message);
    this.name = 'SchemaRaceError';
  }
}

/** What {@link ensureBaseSchema} did. */
export interface SchemaResult {
  /** `true` when this call created (or finished creating) the schema. */
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
/** Re-classifications after a lost race; the second one normally decides. */
const MAX_RACES = 3;
/** Re-reads of a ledger that does not yet show this start's publication. */
const VERIFY_RETRIES = 20;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The ledger records exactly `schema`. */
function isCurrent(recorded: readonly string[], schema: BaseSchema): boolean {
  return recorded.length === 1 && recorded[0] === schema.id;
}

/** The ledger shows this build's own interrupted creation: exactly its claim. */
function isResumable(
  recorded: readonly string[],
  schema: BaseSchema,
  driver: SchemaDriver,
): boolean {
  return driver.writesClaims && recorded.length === 1 && recorded[0] === schemaClaim(schema);
}

/** What to do with the database as it is now; a refusal throws. */
async function classify(
  driver: SchemaDriver,
  schema: BaseSchema,
): Promise<'current' | { resume: boolean }> {
  const decide = (recorded: readonly string[]): 'current' | { resume: true } | null => {
    if (isCurrent(recorded, schema)) return 'current';
    if (isResumable(recorded, schema, driver)) return { resume: true };
    if (recorded.length > 0) throw olderSchemaError(recorded, schema);
    return null;
  };
  const first = decide(await driver.listRecorded());
  if (first !== null) return first;
  const existing = await driver.existingTables(schema);
  if (existing.length === 0) return { resume: false };
  // The two reads are not one snapshot: a peer may have created (or begun
  // creating) the schema between them. Its tables never appear before its
  // record or claim does, so a second look at the ledger tells them apart
  // from tables nobody recorded.
  const second = decide(await driver.listRecorded());
  if (second !== null) return second;
  throw unrecordedSchemaError(existing, schema);
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
  for (let races = 0; ; races += 1) {
    const state = await classify(driver, schema);
    if (state === 'current') return { created: false };
    try {
      await driver.createBaseSchema(schema, state);
    } catch (error) {
      // Another start got there first and this one changed nothing: look again.
      if (error instanceof SchemaRaceError && races < MAX_RACES) continue;
      if (await peerCreated(driver, schema, error, options)) return { created: false };
      // A peer that stopped mid-creation leaves its claim; look again and
      // resume it.
      if (error instanceof SchemaBusyError && races < MAX_RACES) continue;
      throw schemaFailure(schema, error);
    }
    let recorded = await driver.listRecorded();
    // A read that still shows this build's own claim lags the publication
    // the driver just had acknowledged; give it a moment before deciding.
    for (let check = 0; isResumable(recorded, schema, driver) && check < VERIFY_RETRIES; check++) {
      await sleep(options.pollMs ?? DEFAULT_POLL_MS);
      recorded = await driver.listRecorded();
    }
    if (!isCurrent(recorded, schema)) throw olderSchemaError(recorded, schema);
    return { created: true };
  }
}

/**
 * Whether a failed creation lost to a peer that created this schema. A
 * {@link SchemaBusyError} means the peer is still at it, so wait for its
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
  while (Date.now() < deadline) {
    await sleep(options.pollMs ?? DEFAULT_POLL_MS);
    const recorded = await read();
    if (isCurrent(recorded, schema)) return true;
    if (!isResumable(recorded, schema, driver)) return false;
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
