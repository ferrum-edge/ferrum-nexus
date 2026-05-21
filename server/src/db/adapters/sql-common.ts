/**
 * Helpers shared between the PostgreSQL and MySQL adapters.
 *
 * Both speak parameterized SQL; the main differences we paper over are:
 *  - Placeholder syntax (`$1, $2, ...` vs `?`).
 *  - JSON column handling (pg returns JS values, mysql2 returns either parsed
 *    JS values when configured or strings when not).
 *  - Boolean handling (mysql exposes TINYINT(1) values as 0/1 numbers).
 */

export type SqlDialect = 'postgres' | 'mysql';

export interface SqlClient {
  /** Execute a query and return the rows. */
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Execute a query and return the first row, or null. */
  one<T>(sql: string, params?: unknown[]): Promise<T | null>;
  /** Execute a write and return rows-affected. */
  exec(sql: string, params?: unknown[]): Promise<number>;
}

export function placeholder(dialect: SqlDialect, n: number): string {
  return dialect === 'postgres' ? `$${n}` : '?';
}

export function buildPlaceholders(dialect: SqlDialect, count: number, startAt = 1): string {
  return Array.from({ length: count }, (_, i) => placeholder(dialect, startAt + i)).join(', ');
}

export function asBool(value: unknown): boolean {
  return value === 1 || value === true || value === 'true' || value === '1';
}

export function asJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === 'object') return value as T;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return value as T;
    }
  }
  return value as T;
}

export function toIsoString(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return String(value);
}

/**
 * Per-dialect emitters for the small set of constructs that genuinely differ
 * between Postgres and MySQL. Built as small, explicit helpers rather than a
 * blanket regex rewriter so the differences are visible at the call site.
 */

/** Case-insensitive LIKE that works on every default collation. */
export function caseInsensitiveLike(dialect: SqlDialect, column: string, paramRef: string): string {
  // Postgres has the dedicated ILIKE operator. For MySQL/SQLite we lower-case
  // both sides — the caller is expected to pre-lower the bound parameter so
  // we don't double-evaluate LOWER() on it for every row.
  return dialect === 'postgres' ? `${column} ILIKE ${paramRef}` : `LOWER(${column}) LIKE ${paramRef}`;
}

/** Quote an identifier that collides with a reserved word (`key`, etc). */
export function ident(dialect: SqlDialect, name: string): string {
  return dialect === 'postgres' ? name : `\`${name}\``;
}

/**
 * Generate an `INSERT ... ON DUPLICATE KEY UPDATE` (MySQL) or
 * `INSERT ... ON CONFLICT DO UPDATE` (Postgres) statement. The caller
 * supplies the column list and the value-placeholder list; the UPDATE clause
 * is generated from the same column list so the two stay in sync.
 *
 * `conflictKeys` are the column(s) used to detect the conflict (typically the
 * primary key or a unique index).
 */
export function buildUpsert(
  dialect: SqlDialect,
  table: string,
  columns: string[],
  conflictKeys: string[],
  startingPlaceholder = 1,
): string {
  const quotedTable = ident(dialect, table);
  const quotedColumns = columns.map((c) => ident(dialect, c)).join(', ');
  const placeholders = buildPlaceholders(dialect, columns.length, startingPlaceholder);
  const updates = columns
    .filter((c) => !conflictKeys.includes(c))
    .map((c) => {
      const col = ident(dialect, c);
      return dialect === 'postgres' ? `${col} = EXCLUDED.${col}` : `${col} = VALUES(${col})`;
    })
    .join(', ');
  if (dialect === 'postgres') {
    const conflict = conflictKeys.map((c) => ident(dialect, c)).join(', ');
    return `INSERT INTO ${quotedTable} (${quotedColumns}) VALUES (${placeholders}) ON CONFLICT (${conflict}) DO UPDATE SET ${updates}`;
  }
  return `INSERT INTO ${quotedTable} (${quotedColumns}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${updates}`;
}

/** `INSERT IGNORE` for MySQL / `ON CONFLICT DO NOTHING` for Postgres. */
export function buildInsertIgnore(
  dialect: SqlDialect,
  table: string,
  columns: string[],
  startingPlaceholder = 1,
): string {
  const quotedTable = ident(dialect, table);
  const quotedColumns = columns.map((c) => ident(dialect, c)).join(', ');
  const placeholders = buildPlaceholders(dialect, columns.length, startingPlaceholder);
  if (dialect === 'postgres') {
    return `INSERT INTO ${quotedTable} (${quotedColumns}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;
  }
  return `INSERT IGNORE INTO ${quotedTable} (${quotedColumns}) VALUES (${placeholders})`;
}
