import { createPool, type PoolConnection, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ResolvedConfig } from '../../../config/index.js';
import type { NexusStore } from '../../store.js';
import { buildSqlRepos } from '../sql-repos.js';
import type { SqlClient } from '../sql-common.js';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(here, '../../migrations');

export async function createMysqlStore(config: ResolvedConfig): Promise<NexusStore> {
  if (!config.db.url) throw new Error('NEXUS_DB_URL is required for mysql');
  const pool = createPool({ uri: config.db.url, connectionLimit: 10, supportBigNumbers: true });

  const wrap = (run: (sql: string, params: unknown[]) => Promise<unknown[]>): SqlClient => ({
    async query<T>(sql: string, params: unknown[] = []) {
      const rows = (await run(sql, params)) as T[];
      return rows;
    },
    async one<T>(sql: string, params: unknown[] = []) {
      const rows = (await run(sql, params)) as T[];
      return rows[0] ?? null;
    },
    async exec(sql: string, params: unknown[] = []) {
      const result = (await run(sql, params)) as unknown as ResultSetHeader & { affectedRows?: number };
      return result.affectedRows ?? 0;
    },
  });

  const poolRun = async (sql: string, params: unknown[]): Promise<unknown[]> => {
    const [rows] = await pool.query<RowDataPacket[] | ResultSetHeader>(sql, params);
    return rows as unknown as unknown[];
  };

  const poolClient = wrap(poolRun);
  const repos = buildSqlRepos(poolClient, 'mysql');

  const splitStatements = (sql: string): string[] =>
    sql
      .split(/;\s*\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

  const migrate = async (): Promise<void> => {
    const c = await pool.getConnection();
    try {
      await c.query('START TRANSACTION');
      await c.query(`
        CREATE TABLE IF NOT EXISTS _migrations (
          id VARCHAR(64) PRIMARY KEY,
          applied_at DATETIME NOT NULL
        )
      `);
      const [appliedRows] = await c.query<RowDataPacket[]>('SELECT id FROM _migrations');
      const applied = new Set(appliedRows.map((row) => row.id as string));
      const files = readdirSync(MIGRATIONS_DIR)
        .filter((file) => /^\d+_.+\.mysql\.sql$/.test(file))
        .sort();
      for (const file of files) {
        const id = file.replace(/\.mysql\.sql$/, '');
        if (applied.has(id)) continue;
        for (const stmt of splitStatements(readFileSync(resolve(MIGRATIONS_DIR, file), 'utf8'))) {
          await c.query(stmt);
        }
        await c.query('INSERT IGNORE INTO _migrations (id, applied_at) VALUES (?, ?)', [
          id,
          new Date(),
        ]);
      }
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    } finally {
      c.release();
    }
  };

  const store: NexusStore = {
    driver: 'mysql',
    ...repos,
    async transaction<T>(fn: (tx: NexusStore) => Promise<T>): Promise<T> {
      const c: PoolConnection = await pool.getConnection();
      try {
        await c.query('START TRANSACTION');
        const txRun = async (sql: string, params: unknown[]): Promise<unknown[]> => {
          const [rows] = await c.query<RowDataPacket[] | ResultSetHeader>(sql, params);
          return rows as unknown as unknown[];
        };
        const txRepos = buildSqlRepos(wrap(txRun), 'mysql');
        const txStore: NexusStore = { ...store, ...txRepos };
        const result = await fn(txStore);
        await c.query('COMMIT');
        return result;
      } catch (err) {
        await c.query('ROLLBACK');
        throw err;
      } finally {
        c.release();
      }
    },
    async migrate() {
      await migrate();
    },
    async close() {
      await pool.end();
    },
  };

  return store;
}
