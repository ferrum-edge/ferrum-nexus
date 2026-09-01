/**
 * Small SQL helpers shared by the SQLite repositories.
 *
 * These are deliberately generic (`Row = Record<string, unknown>`, positional
 * parameters) so the PostgreSQL and MySQL adapters can port the same shapes
 * with only the placeholder syntax and the conflict-code mapping changed.
 */

import type { Database } from 'better-sqlite3';

import { clampPageSize } from '@ferrum-nexus/shared';
import { NexusError, conflict } from '../../../lib/errors.js';
import type { ListOptions } from '../../store.js';

/** An untyped result row; every repo decodes it into a record type immediately. */
export type Row = Record<string, unknown>;

/** A bindable SQLite parameter. */
export type Param = string | number | bigint | Buffer | null;

/** SQLite constraint codes that mean "a uniqueness rule was violated". */
const UNIQUE_CONSTRAINT_CODES = new Set([
  'SQLITE_CONSTRAINT_UNIQUE',
  'SQLITE_CONSTRAINT_PRIMARYKEY',
]);

/**
 * Run `fn`, translating a SQLite uniqueness violation into
 * `NexusError('CONFLICT', message)`. Every write goes through this so no
 * driver-specific error ever escapes the adapter.
 */
export function mapConflict<T>(message: string, fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && UNIQUE_CONSTRAINT_CODES.has(code)) {
      throw conflict(message);
    }
    if (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT_FOREIGNKEY')) {
      throw conflict(`${message} (referenced record does not exist or is still in use)`);
    }
    throw error;
  }
}

/** Fetch a single row, or `undefined`. */
export function queryOne(db: Database, sql: string, params: Param[] = []): Row | undefined {
  const row = db.prepare(sql).get(...params);
  return (row ?? undefined) as Row | undefined;
}

/** Fetch every matching row. */
export function queryAll(db: Database, sql: string, params: Param[] = []): Row[] {
  return db.prepare(sql).all(...params) as Row[];
}

/** Execute a statement and return the number of rows it changed. */
export function execute(db: Database, sql: string, params: Param[] = []): number {
  return db.prepare(sql).run(...params).changes;
}

/** Fetch a single scalar count. */
export function queryCount(db: Database, sql: string, params: Param[] = []): number {
  const row = queryOne(db, sql, params);
  return row ? Number(row.count ?? 0) : 0;
}

/* ── Column decoding ────────────────────────────────────────────────────── */

/** Decode a NOT NULL text column. */
export function text(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

/** Decode a nullable text column. */
export function textOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}

/** Decode a 0/1 integer column into a boolean. */
export function bool(value: unknown): boolean {
  return value === 1 || value === true || value === '1';
}

/** Decode a numeric column. */
export function int(value: unknown): number {
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

/** Encode an optional string, normalising `undefined` to SQL NULL. */
export function encodeNullable(value: unknown): Param {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'string') return value;
  return String(value);
}

/* ── Statement building ─────────────────────────────────────────────────── */

/** A `WHERE` fragment plus its bound parameters. */
export interface WhereClause {
  sql: string;
  params: Param[];
}

/** Accumulates `AND`-joined conditions, skipping filters that were not supplied. */
export class WhereBuilder {
  private readonly conditions: string[] = [];
  private readonly values: Param[] = [];

  /** Add `condition` with its parameters when `value` is neither undefined nor null. */
  add(value: unknown, condition: string, ...params: Param[]): this {
    if (value === undefined) return this;
    this.conditions.push(condition);
    this.values.push(...params);
    return this;
  }

  /** Add a condition unconditionally. */
  always(condition: string, ...params: Param[]): this {
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

  /** Add a case-insensitive `LIKE` across one or more columns. */
  addSearch(term: string | undefined, columns: string[]): this {
    if (term === undefined || term.trim() === '' || columns.length === 0) return this;
    const needle = `%${term
      .trim()
      .toLowerCase()
      .replace(/[%_]/g, (c) => `\\${c}`)}%`;
    const parts = columns.map((column) => `lower(coalesce(${column}, '')) LIKE ? ESCAPE '\\'`);
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
export function insertParts(columns: Record<string, Param | undefined>): {
  names: string;
  placeholders: string;
  params: Param[];
} {
  const entries = Object.entries(columns).filter(
    (entry): entry is [string, Param] => entry[1] !== undefined,
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
  columns: Record<string, Param | undefined>,
): { sql: string; params: Param[] } | null {
  const entries = Object.entries(columns).filter(
    (entry): entry is [string, Param] => entry[1] !== undefined,
  );
  if (entries.length === 0) return null;
  return {
    sql: entries.map(([name]) => `${name} = ?`).join(', '),
    params: entries.map(([, value]) => value),
  };
}

/** Re-export so repositories can throw a store-level conflict without another import. */
export { NexusError };
