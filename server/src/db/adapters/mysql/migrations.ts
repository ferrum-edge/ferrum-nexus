/** Replayable MySQL baseline initialization, serialized across application instances. */
import { createHash } from 'node:crypto';
import type mysql from 'mysql2/promise';
import { nowIso } from '../../../lib/ids.js';
import {
  loadMigrations,
  runMigrations,
  SCHEMA_MIGRATIONS_TABLE,
  splitSqlStatements,
  type MigrationFile,
} from '../../migrate.js';

const digest = (text: string): string => createHash('sha256').update(text).digest('hex');

async function applyMigration(
  connection: mysql.PoolConnection,
  migration: MigrationFile,
): Promise<void> {
  const statements = splitSqlStatements(migration.sql);
  // MySQL DDL commits independently of the ledger. The buildout baseline uses
  // only replayable CREATEs, with all indexes and constraints inline per table.
  // Validate the whole file before applying any of it.
  if (statements.some((statement) => !/^CREATE TABLE IF NOT EXISTS\s/i.test(statement))) {
    throw new Error(`MySQL baseline ${migration.id} must contain only CREATE TABLE IF NOT EXISTS`);
  }
  for (const statement of statements) await connection.query(statement);
  await connection.execute(
    `INSERT INTO ${SCHEMA_MIGRATIONS_TABLE} (id, applied_at) VALUES (?, ?)`,
    [migration.id, nowIso()],
  );
}

/** One connection owns the advisory lock, ledger reads, all steps, and release. */
export async function runMysqlMigrations(
  pool: mysql.Pool,
  migrations: MigrationFile[] = loadMigrations('mysql'),
): Promise<void> {
  const connection = await pool.getConnection();
  let lockName: string | undefined;
  let reusable = true;
  try {
    const [rows] = await connection.query<mysql.RowDataPacket[]>('SELECT DATABASE() AS db');
    if (typeof rows[0]?.db !== 'string')
      throw new Error('MySQL migrations require a selected database');
    const name = `nexus:migrations:${digest(rows[0].db).slice(0, 32)}`;
    // Acquisition can commit server-side before a transport error reaches us.
    lockName = name;
    const [locks] = await connection.execute<mysql.RowDataPacket[]>(
      'SELECT GET_LOCK(?, 30) AS acquired',
      [name],
    );
    if (Number(locks[0]?.acquired) !== 1) {
      throw new Error('MySQL migrations are busy; retry after the other migrator finishes');
    }
    await runMigrations(
      {
        async ensureMigrationsTable() {
          await connection.query(`CREATE TABLE IF NOT EXISTS ${SCHEMA_MIGRATIONS_TABLE} (
          id VARCHAR(191) NOT NULL, applied_at VARCHAR(32) NOT NULL, PRIMARY KEY (id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`);
        },
        async listApplied() {
          const [applied] = await connection.query<mysql.RowDataPacket[]>(
            `SELECT id FROM ${SCHEMA_MIGRATIONS_TABLE}`,
          );
          return applied.map((row) => String(row.id));
        },
        applyMigration: (migration) => applyMigration(connection, migration),
      },
      migrations,
    );
  } finally {
    if (lockName) {
      try {
        const [released] = await connection.execute<mysql.RowDataPacket[]>(
          'SELECT RELEASE_LOCK(?) AS released',
          [lockName],
        );
        reusable = Number(released[0]?.released) === 1;
      } catch {
        reusable = false;
      }
    }
    // Never return a possibly lock-owning connection to the general pool.
    if (reusable) connection.release();
    else connection.destroy();
  }
}
