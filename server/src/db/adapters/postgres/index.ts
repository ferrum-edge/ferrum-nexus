import { Pool, type PoolClient } from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ResolvedConfig } from '../../../config/index.js';
import type { NexusStore } from '../../store.js';
import { buildSqlRepos } from '../sql-repos.js';
import type { SqlClient } from '../sql-common.js';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(here, '../../migrations');

export async function createPostgresStore(config: ResolvedConfig): Promise<NexusStore> {
  if (!config.db.url) throw new Error('NEXUS_DB_URL is required for postgres');
  const pool = new Pool({ connectionString: config.db.url, max: 10 });

  const clientFor = (pgc: PoolClient): SqlClient => ({
    async query<T>(sql: string, params: unknown[] = []) {
      const res = await pgc.query(sql, params);
      return res.rows as T[];
    },
    async one<T>(sql: string, params: unknown[] = []) {
      const res = await pgc.query(sql, params);
      return ((res.rows[0] as T | undefined) ?? null) as T | null;
    },
    async exec(sql: string, params: unknown[] = []) {
      const res = await pgc.query(sql, params);
      return res.rowCount ?? 0;
    },
  });

  const poolClient: SqlClient = {
    async query<T>(sql: string, params: unknown[] = []) {
      const res = await pool.query(sql, params);
      return res.rows as T[];
    },
    async one<T>(sql: string, params: unknown[] = []) {
      const res = await pool.query(sql, params);
      return ((res.rows[0] as T | undefined) ?? null) as T | null;
    },
    async exec(sql: string, params: unknown[] = []) {
      const res = await pool.query(sql, params);
      return res.rowCount ?? 0;
    },
  };

  const repos = buildSqlRepos(poolClient, 'postgres');

  const migrate = async (): Promise<void> => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`
        CREATE TABLE IF NOT EXISTS _migrations (
          id TEXT PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      const appliedRows = await c.query<{ id: string }>('SELECT id FROM _migrations');
      const applied = new Set(appliedRows.rows.map((row) => row.id));
      const files = readdirSync(MIGRATIONS_DIR)
        .filter((file) => /^\d+_.+\.pg\.sql$/.test(file))
        .sort();
      for (const file of files) {
        const id = file.replace(/\.pg\.sql$/, '');
        if (applied.has(id)) continue;
        await c.query(readFileSync(resolve(MIGRATIONS_DIR, file), 'utf8'));
        await c.query('INSERT INTO _migrations (id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
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
    driver: 'postgres',
    ...repos,
    async transaction<T>(fn: (tx: NexusStore) => Promise<T>): Promise<T> {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const txRepos = buildSqlRepos(clientFor(c), 'postgres');
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
