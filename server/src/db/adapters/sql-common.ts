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
      return fallback;
    }
  }
  return fallback;
}

export function toIsoString(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return String(value);
}
