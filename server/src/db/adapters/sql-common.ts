/**
 * Dialect shims shared by the two asynchronous SQL adapters (PostgreSQL and
 * MySQL).
 *
 * The point of this module is that {@link ../sql-repos.js sql-repos.ts} can be
 * written **once**, against a single SQL text. Every statement in there is
 * spelled in the portable subset:
 *
 * - positional `?` placeholders, translated to `$1 … $n` for `pg`;
 * - `"double quoted"` identifiers, translated to backticks for MySQL (only
 *   `"key"` actually needs it — `KEY` is reserved in MySQL and not in
 *   PostgreSQL);
 * - `POSITION(? IN lower(coalesce(col, '')))` for the case-insensitive
 *   substring filters, which avoids `LIKE … ESCAPE '\'` — the one construct
 *   whose *literal spelling* differs between the two servers, because MySQL
 *   treats backslash as an escape inside string literals and PostgreSQL does
 *   not.
 *
 * Row decoding mirrors `adapters/sqlite/sql.ts` exactly, so a record built here
 * is indistinguishable from one built by the reference adapter: booleans come
 * back as real booleans from 0/1 storage, `*_json` columns come back parsed,
 * and absent columns come back as `null` rather than `undefined`.
 */

import { clampPageSize } from '@ferrum-nexus/shared';

import { conflict, NexusError } from '../../lib/errors.js';
import type { ListOptions } from '../store.js';

/** Which server a statement is being prepared for. */
export type SqlDialect = 'pg' | 'mysql';

/** An untyped result row; every repo decodes it into a record type immediately. */
export type Row = Record<string, unknown>;

/** A bindable parameter. Both drivers accept these natively. */
export type SqlParam = string | number | boolean | null;

/**
 * The minimum a driver must expose for {@link ../sql-repos.js sql-repos.ts} to
 * work. Both a pool and a single checked-out transaction connection implement
 * it, which is how the repos become transaction-aware without knowing it.
 */
export interface SqlExecutor {
  /** Which dialect to format statements for. */
  readonly dialect: SqlDialect;
  /** Run a statement and return its rows (empty for non-SELECTs). */
  query(sql: string, params?: SqlParam[]): Promise<Row[]>;
  /** Run a statement and return the number of rows it affected. */
  execute(sql: string, params?: SqlParam[]): Promise<number>;
}

/**
 * Runs `fn` against an executor that is inside a transaction.
 *
 * Repos use it for the handful of operations that must be atomic on their own
 * (`apiSpecs.create`, `apiSpecs.setCurrent`, `emailOutbox.claimDue`,
 * `notifications.createMany`, `settings.setMany`). When the repos are already
 * transaction-scoped this simply hands back the same executor, which is what
 * makes those operations compose inside a caller's `store.transaction`.
 */
export type SqlTransactionRunner = <T>(fn: (exec: SqlExecutor) => Promise<T>) => Promise<T>;

/* ── Statement formatting ───────────────────────────────────────────────── */

/**
 * Translate the portable SQL spelling into `dialect`.
 *
 * Single-quoted literals are passed through untouched, so a `?` or a `"` that
 * happens to sit inside a literal is never mistaken for a placeholder or an
 * identifier delimiter.
 */
export function formatSql(sql: string, dialect: SqlDialect): string {
  let out = '';
  let placeholder = 0;
  let inString = false;
  let inIdent = false;

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i] ?? '';

    if (inString) {
      out += char;
      if (char === "'") {
        if (sql[i + 1] === "'") {
          out += "'";
          i += 1;
        } else {
          inString = false;
        }
      }
      continue;
    }

    if (inIdent) {
      if (char === '"') {
        inIdent = false;
        out += dialect === 'mysql' ? '`' : '"';
      } else {
        out += char;
      }
      continue;
    }

    if (char === "'") {
      inString = true;
      out += char;
      continue;
    }
    if (char === '"') {
      inIdent = true;
      out += dialect === 'mysql' ? '`' : '"';
      continue;
    }
    if (char === '?' && dialect === 'pg') {
      placeholder += 1;
      out += `$${placeholder}`;
      continue;
    }
    out += char;
  }

  return out;
}

/* ── Error translation ──────────────────────────────────────────────────── */

/** PostgreSQL SQLSTATE / MySQL errno pairs that mean "uniqueness was violated". */
function isUniqueViolation(error: unknown): boolean {
  const { code, errno } = error as { code?: unknown; errno?: unknown };
  return code === '23505' || code === 'ER_DUP_ENTRY' || errno === 1062;
}

/** …and the pairs that mean "a foreign key check failed". */
function isForeignKeyViolation(error: unknown): boolean {
  const { code, errno } = error as { code?: unknown; errno?: unknown };
  return (
    code === '23503' ||
    code === 'ER_NO_REFERENCED_ROW_2' ||
    code === 'ER_ROW_IS_REFERENCED_2' ||
    errno === 1451 ||
    errno === 1452
  );
}

/**
 * Run `fn`, translating a driver uniqueness/foreign-key error into
 * `NexusError('CONFLICT', …)`. The async counterpart of the sqlite adapter's
 * `mapConflict`; every write goes through it so no driver-specific error ever
 * escapes an adapter.
 */
export async function mapSqlConflict<T>(message: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict(message);
    if (isForeignKeyViolation(error)) {
      throw conflict(`${message} (referenced record does not exist or is still in use)`);
    }
    throw error;
  }
}

/* ── Column decoding ────────────────────────────────────────────────────── */

/** Decode a NOT NULL text column. */
export function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Buffer) return value.toString('utf8');
  return String(value ?? '');
}

/** Decode a nullable text column. */
export function textOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}

/**
 * Decode a 0/1 column into a boolean.
 *
 * PostgreSQL hands back `SMALLINT` as a number, MySQL hands back `TINYINT` as a
 * number, and both can hand back a string for a widened type — all three are
 * accepted, as they are in the sqlite adapter.
 */
export function bool(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'bigint') return value !== 0n;
  return value === '1' || value === 'true';
}

/** Decode a numeric column. PostgreSQL returns `COUNT(*)` as a string. */
export function int(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return Number(value ?? 0);
}

/** Decode a JSON text column, falling back when it is null or unparsable. */
export function json<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value as T;
  try {
    const parsed: unknown = JSON.parse(value);
    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
}

/* ── Column encoding ────────────────────────────────────────────────────── */

/** Encode a boolean as 0/1. */
export function encodeBool(value: unknown): number {
  return value ? 1 : 0;
}

/** Encode a structured value as JSON text (`null` stays SQL NULL). */
export function encodeJson(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

/* ── Query helpers ──────────────────────────────────────────────────────── */

/** Fetch a single row, or `undefined`. */
export async function queryOne(
  exec: SqlExecutor,
  sql: string,
  params: SqlParam[] = [],
): Promise<Row | undefined> {
  const rows = await exec.query(sql, params);
  return rows[0];
}

/** Fetch every matching row. */
export async function queryAll(
  exec: SqlExecutor,
  sql: string,
  params: SqlParam[] = [],
): Promise<Row[]> {
  return exec.query(sql, params);
}

/**
 * Fetch a single scalar count.
 *
 * Repos alias the aggregate `AS cnt` rather than `AS count`, which keeps the
 * column name away from the function name on both servers.
 */
export async function queryCount(
  exec: SqlExecutor,
  sql: string,
  params: SqlParam[] = [],
): Promise<number> {
  const row = await queryOne(exec, sql, params);
  return row ? int(row.cnt ?? 0) : 0;
}

/** Execute a statement and return the number of rows it affected. */
export async function execute(
  exec: SqlExecutor,
  sql: string,
  params: SqlParam[] = [],
): Promise<number> {
  return exec.execute(sql, params);
}

/* ── Statement building ─────────────────────────────────────────────────── */

/** A `WHERE` fragment plus its bound parameters. */
export interface WhereClause {
  sql: string;
  params: SqlParam[];
}

/**
 * Accumulates `AND`-joined conditions, skipping filters that were not supplied.
 *
 * Behaviourally identical to the sqlite `WhereBuilder`; the only difference is
 * {@link SqlWhereBuilder.addSearch}, which uses `POSITION(… IN …)` instead of
 * `LIKE … ESCAPE`. The two are equivalent: the sqlite version escapes `%` and
 * `_` so the term is matched literally, which is what `POSITION` does anyway.
 */
export class SqlWhereBuilder {
  private readonly conditions: string[] = [];
  private readonly values: SqlParam[] = [];

  /** Add `condition` with its parameters when `value` is not `undefined`. */
  add(value: unknown, condition: string, ...params: SqlParam[]): this {
    if (value === undefined) return this;
    this.conditions.push(condition);
    this.values.push(...params);
    return this;
  }

  /** Add a condition unconditionally. */
  always(condition: string, ...params: SqlParam[]): this {
    this.conditions.push(condition);
    this.values.push(...params);
    return this;
  }

  /** Add an `IN (...)` condition; an empty list produces an always-false condition. */
  addIn(column: string, values: readonly string[] | undefined): this {
    if (values === undefined) return this;
    if (values.length === 0) {
      this.conditions.push('1 = 0');
      return this;
    }
    this.conditions.push(`${column} IN (${values.map(() => '?').join(', ')})`);
    this.values.push(...values);
    return this;
  }

  /** Add a case-insensitive substring match across one or more columns. */
  addSearch(term: string | undefined, columns: string[]): this {
    if (term === undefined || term.trim() === '' || columns.length === 0) return this;
    const needle = term.trim().toLowerCase();
    const parts = columns.map((column) => `POSITION(? IN lower(coalesce(${column}, ''))) > 0`);
    this.conditions.push(`(${parts.join(' OR ')})`);
    for (let i = 0; i < parts.length; i += 1) this.values.push(needle);
    return this;
  }

  /** Materialise the clause. Returns an empty `sql` when nothing was added. */
  build(): WhereClause {
    if (this.conditions.length === 0) return { sql: '', params: [] };
    return { sql: ` WHERE ${this.conditions.join(' AND ')}`, params: [...this.values] };
  }
}

/** Normalised pagination: a clamped limit and a non-negative offset. */
export interface Page {
  limit: number;
  offset: number;
}

/** Clamp caller-supplied pagination into safe bounds. */
export function page(options: ListOptions | undefined): Page {
  const limit = clampPageSize(options?.limit);
  const rawOffset = options?.offset ?? 0;
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
  return { limit, offset };
}

/**
 * Build the column list, placeholders and values of an INSERT from a record of
 * already-encoded columns, dropping `undefined` entries.
 */
export function insertParts(columns: Record<string, SqlParam | undefined>): {
  names: string;
  placeholders: string;
  params: SqlParam[];
} {
  const entries = Object.entries(columns).filter(
    (entry): entry is [string, SqlParam] => entry[1] !== undefined,
  );
  return {
    names: entries.map(([name]) => name).join(', '),
    placeholders: entries.map(() => '?').join(', '),
    params: entries.map(([, value]) => value),
  };
}

/**
 * Build a `SET` fragment from a record of already-encoded columns, dropping
 * `undefined` entries. Returns `null` when nothing would be updated.
 */
export function setParts(
  columns: Record<string, SqlParam | undefined>,
): { sql: string; params: SqlParam[] } | null {
  const entries = Object.entries(columns).filter(
    (entry): entry is [string, SqlParam] => entry[1] !== undefined,
  );
  if (entries.length === 0) return null;
  return {
    sql: entries.map(([name]) => `${name} = ?`).join(', '),
    params: entries.map(([, value]) => value),
  };
}

/**
 * Build an "insert, or overwrite the listed columns" statement.
 *
 * This is the one place where the two dialects genuinely disagree on syntax
 * rather than on spelling: PostgreSQL has `ON CONFLICT (…) DO UPDATE SET
 * col = EXCLUDED.col`, MySQL has `AS new_row … ON DUPLICATE KEY UPDATE
 * col = new_row.col` (the row-alias form, which replaced the deprecated
 * `VALUES(col)` in MySQL 8.0.19).
 *
 * @param table          Target table.
 * @param columns        Every column being inserted, in parameter order.
 * @param conflictColumn The unique column that decides insert-vs-update. Pass
 *                       it already quoted when it needs quoting.
 * @param updateColumns  Columns to overwrite when the row already exists.
 */
export function upsertSql(
  dialect: SqlDialect,
  table: string,
  columns: string[],
  conflictColumn: string,
  updateColumns: string[],
): string {
  const placeholders = columns.map(() => '?').join(', ');
  const head = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`;
  if (dialect === 'pg') {
    const assignments = updateColumns.map((column) => `${column} = EXCLUDED.${column}`).join(', ');
    return `${head} ON CONFLICT (${conflictColumn}) DO UPDATE SET ${assignments}`;
  }
  const assignments = updateColumns.map((column) => `${column} = new_row.${column}`).join(', ');
  return `${head} AS new_row ON DUPLICATE KEY UPDATE ${assignments}`;
}

/**
 * `SELECT … FOR UPDATE SKIP LOCKED` suffix.
 *
 * Both servers support it (PostgreSQL since 9.5, MySQL since 8.0); it is what
 * lets two outbox workers claim disjoint batches without serialising on each
 * other, replacing the whole-database lock the sqlite adapter gets for free.
 */
export const FOR_UPDATE_SKIP_LOCKED = ' FOR UPDATE SKIP LOCKED';

/** Re-export so repositories can throw a store-level error without another import. */
export { NexusError };
