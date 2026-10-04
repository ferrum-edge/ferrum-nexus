/** Replayable MySQL schema upgrades, serialized across application instances. */
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
const ADD_COLUMN = /^ALTER TABLE ([a-z][a-z0-9_]*) ADD COLUMN ([a-z][a-z0-9_]*) (.+)$/i;
const STRING_COLUMN = /^(VARCHAR\([1-9][0-9]*\)) (NULL|NOT NULL DEFAULT '')$/i;

interface AddColumn {
  statement: string;
  table: string;
  column: string;
  type: string;
  nullable: boolean;
}

/** Only additive string columns with replay-verifiable definitions are supported. */
function migrationSteps(migration: MigrationFile): (string | AddColumn)[] {
  return splitSqlStatements(migration.sql).map((statement) => {
    if (/^CREATE TABLE IF NOT EXISTS\s/i.test(statement)) return statement;
    const match = ADD_COLUMN.exec(statement);
    const definition = match && STRING_COLUMN.exec(match[3]!);
    if (!match || !definition) {
      throw new Error(`MySQL migration ${migration.id} contains unsupported non-replayable DDL`);
    }
    return {
      statement,
      table: match[1]!,
      column: match[2]!,
      type: definition[1]!.toLowerCase(),
      nullable: definition[2]!.toUpperCase() === 'NULL',
    };
  });
}

async function columnExists(connection: mysql.PoolConnection, step: AddColumn): Promise<boolean> {
  const [rows] = await connection.execute<mysql.RowDataPacket[]>(
    `SELECT c.COLUMN_TYPE, c.IS_NULLABLE, c.COLUMN_DEFAULT, c.EXTRA,
            c.COLLATION_NAME, t.TABLE_COLLATION
       FROM information_schema.COLUMNS c
       JOIN information_schema.TABLES t
         ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
      WHERE c.TABLE_SCHEMA = DATABASE() AND c.TABLE_NAME = ? AND c.COLUMN_NAME = ?`,
    [step.table, step.column],
  );
  const column = rows[0];
  if (!column) return false;
  if (
    String(column.COLUMN_TYPE).toLowerCase() !== step.type ||
    column.IS_NULLABLE !== (step.nullable ? 'YES' : 'NO') ||
    column.COLUMN_DEFAULT !== (step.nullable ? null : '') ||
    column.EXTRA !== '' ||
    column.COLLATION_NAME !== column.TABLE_COLLATION
  ) {
    throw new Error(
      `MySQL migration column ${step.table}.${step.column} has an incompatible definition`,
    );
  }
  return true;
}

async function applyMigration(
  connection: mysql.PoolConnection,
  migration: MigrationFile,
): Promise<void> {
  // MySQL DDL commits independently of the ledger. The buildout baseline uses
  // replayable CREATEs; additive columns are checked against live metadata on
  // every replay. Validate the whole file before applying any of it. The same
  // database advisory lock covers metadata reads, DDL and the ledger write.
  const steps = migrationSteps(migration);
  for (const step of steps) {
    if (typeof step === 'string') {
      await connection.query(step);
    } else if (!(await columnExists(connection, step))) {
      await connection.query(step.statement);
      if (!(await columnExists(connection, step))) {
        throw new Error(`MySQL migration failed to add ${step.table}.${step.column}`);
      }
    }
  }
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
