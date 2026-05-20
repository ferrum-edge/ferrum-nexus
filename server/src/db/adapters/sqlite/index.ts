import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ResolvedConfig } from '../../../config/index.js';
import type { NexusStore } from '../../store.js';
import { buildSqliteRepos } from './repos.js';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(here, '../../migrations');

export async function createSqliteStore(config: ResolvedConfig): Promise<NexusStore> {
  const file = config.db.url ?? './data/nexus.sqlite';
  if (file !== ':memory:') {
    mkdirSync(dirname(file), { recursive: true });
  }
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  const migrate = async (): Promise<void> => {
    const sql = readFileSync(resolve(MIGRATIONS_DIR, '001_initial.sql'), 'utf8');
    db.exec(sql);
    db.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    const stmt = db.prepare(
      'INSERT OR IGNORE INTO _migrations (id, applied_at) VALUES (?, ?)',
    );
    stmt.run('001_initial', new Date().toISOString());
  };

  // better-sqlite3 prepares statements eagerly, so the schema must exist
  // before we build the repository statement bag. Apply the migration first.
  await migrate();

  const repos = buildSqliteRepos(db);

  const store: NexusStore = {
    driver: 'sqlite',
    ...repos,
    async transaction<T>(fn: (tx: NexusStore) => Promise<T>): Promise<T> {
      // better-sqlite3 transactions are sync; we use BEGIN IMMEDIATE so the
      // callback can still be async (we just need atomicity of the writes
      // inside it within this connection).
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn(store);
        db.exec('COMMIT');
        return result;
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // ignore rollback errors
        }
        throw err;
      }
    },
    async migrate() {
      await migrate();
    },
    async close() {
      db.close();
    },
  };

  return store;
}
