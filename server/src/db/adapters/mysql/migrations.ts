/** MySQL DDL recovery. Writers must be stopped during upgrades (operations.md). */
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

const STEPS = 'schema_migration_steps';
const normalizedSql = (sql: string): string => sql.replace(/\s+/g, ' ').trim();
const digest = (text: string): string => createHash('sha256').update(text).digest('hex');

interface Column {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
}
interface Index {
  name: string;
  columns: string[];
  unique: boolean;
}
interface Guard {
  sql: string;
  table: string;
  columns?: Column[];
  indexes?: Index[];
  check?: { name: string; clause: string };
}
const textColumn = (name: string): Column => ({
  name,
  type: 'text',
  nullable: true,
  default: null,
});

// Exact statement matching makes a changed/new ALTER fail closed until its
// recovery postconditions are reviewed too. Never swallow duplicate-name errors.
const guards: Guard[] = [
  {
    sql: "ALTER TABLE gateway_teardown_jobs ADD COLUMN generation VARCHAR(64) NOT NULL DEFAULT ''",
    table: 'gateway_teardown_jobs',
    columns: [{ name: 'generation', type: 'varchar(64)', nullable: false, default: '' }],
  },
  {
    sql: "ALTER TABLE email_outbox ADD COLUMN generation VARCHAR(64) NOT NULL DEFAULT ''",
    table: 'email_outbox',
    columns: [{ name: 'generation', type: 'varchar(64)', nullable: false, default: '' }],
  },
  {
    sql: 'ALTER TABLE apis ADD COLUMN upstream_url TEXT NULL, ADD COLUMN cors_json TEXT NULL',
    table: 'apis',
    columns: [textColumn('upstream_url'), textColumn('cors_json')],
  },
  {
    sql: "ALTER TABLE email_verification_tokens ADD COLUMN purpose VARCHAR(32) NOT NULL DEFAULT 'email_verification', ADD KEY ix_verification_tokens_user_purpose (user_id, purpose)",
    table: 'email_verification_tokens',
    columns: [
      { name: 'purpose', type: 'varchar(32)', nullable: false, default: 'email_verification' },
    ],
    indexes: [
      {
        name: 'ix_verification_tokens_user_purpose',
        columns: ['user_id', 'purpose'],
        unique: false,
      },
    ],
  },
  {
    sql: 'ALTER TABLE apis ADD COLUMN allowed_methods_json TEXT NULL, ADD COLUMN timeouts_json TEXT NULL, ADD COLUMN circuit_breaker TINYINT NOT NULL DEFAULT 0',
    table: 'apis',
    columns: [
      textColumn('allowed_methods_json'),
      textColumn('timeouts_json'),
      { name: 'circuit_breaker', type: 'tinyint', nullable: false, default: '0' },
    ],
  },
  {
    sql: "ALTER TABLE apis ADD COLUMN spec_enforcement VARCHAR(32) NOT NULL DEFAULT 'docs_only', ADD CONSTRAINT ck_apis_spec_enforcement CHECK (spec_enforcement IN ('docs_only', 'routes'))",
    table: 'apis',
    columns: [
      { name: 'spec_enforcement', type: 'varchar(32)', nullable: false, default: 'docs_only' },
    ],
    check: {
      name: 'ck_apis_spec_enforcement',
      clause: "spec_enforcement IN ('docs_only', 'routes')",
    },
  },
  {
    sql: 'ALTER TABLE messages ADD INDEX ix_messages_sender (sender_user_id, created_at)',
    table: 'messages',
    indexes: [
      { name: 'ix_messages_sender', columns: ['sender_user_id', 'created_at'], unique: false },
    ],
  },
  {
    sql: 'ALTER TABLE credential_metadata ADD COLUMN edge_ordinal INT DEFAULT NULL',
    table: 'credential_metadata',
    columns: [{ name: 'edge_ordinal', type: 'int', nullable: true, default: null }],
  },
  {
    sql: 'ALTER TABLE credential_metadata ADD UNIQUE KEY ux_credentials_ordinal (ferrum_consumer_id, credential_type, edge_ordinal)',
    table: 'credential_metadata',
    indexes: [
      {
        name: 'ux_credentials_ordinal',
        columns: ['ferrum_consumer_id', 'credential_type', 'edge_ordinal'],
        unique: true,
      },
    ],
  },
];

function mismatch(table: string, name: string): never {
  throw new Error(
    `MySQL migration schema mismatch at ${table}.${name}; stop writers and follow the migration recovery runbook`,
  );
}

function checkExpression(value: string): string {
  // Metadata escapes literal delimiters. Normalize only SQL decoration outside
  // literals: case and whitespace inside the enum values are significant.
  const parts = value.replace(/\\'/g, "'").match(/'[^']*'|[^']+/g) ?? [];
  return parts
    .map((part) =>
      part.startsWith("'")
        ? part
        : part
            .replace(/_utf8mb4\b/g, '')
            .replace(/[\s`()]/g, '')
            .toLowerCase(),
    )
    .join('');
}

async function alreadyApplied(connection: mysql.PoolConnection, guard: Guard): Promise<boolean> {
  const present: boolean[] = [];
  for (const expected of guard.columns ?? []) {
    const [rows] = await connection.execute<mysql.RowDataPacket[]>(
      `SELECT COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLLATION_NAME, EXTRA
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [guard.table, expected.name],
    );
    const row = rows[0];
    present.push(row !== undefined);
    if (!row) continue;
    const type = String(row.COLUMN_TYPE).replace(/^(tinyint|int)\(\d+\)$/, '$1');
    const columnDefault = row.COLUMN_DEFAULT == null ? null : String(row.COLUMN_DEFAULT);
    if (
      type !== expected.type ||
      (row.IS_NULLABLE === 'YES') !== expected.nullable ||
      columnDefault !== expected.default ||
      row.EXTRA !== '' ||
      (/text|varchar/.test(type) && row.COLLATION_NAME !== 'utf8mb4_bin')
    ) {
      mismatch(guard.table, expected.name);
    }
  }
  for (const expected of guard.indexes ?? []) {
    const [rows] = await connection.execute<mysql.RowDataPacket[]>(
      `SELECT COLUMN_NAME, NON_UNIQUE, SUB_PART, INDEX_TYPE, IS_VISIBLE, EXPRESSION
         FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?
        ORDER BY SEQ_IN_INDEX`,
      [guard.table, expected.name],
    );
    present.push(rows.length > 0);
    if (rows.length === 0) continue;
    if (
      rows.length !== expected.columns.length ||
      rows.some(
        (row, index) =>
          row.COLUMN_NAME !== expected.columns[index] ||
          Number(row.NON_UNIQUE) !== (expected.unique ? 0 : 1) ||
          row.SUB_PART !== null ||
          row.EXPRESSION !== null ||
          row.INDEX_TYPE !== 'BTREE' ||
          row.IS_VISIBLE !== 'YES',
      )
    )
      mismatch(guard.table, expected.name);
  }
  if (guard.check) {
    const [rows] = await connection.execute<mysql.RowDataPacket[]>(
      `SELECT cc.CHECK_CLAUSE, tc.ENFORCED
         FROM information_schema.TABLE_CONSTRAINTS tc
         JOIN information_schema.CHECK_CONSTRAINTS cc
           ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
        WHERE tc.CONSTRAINT_SCHEMA = DATABASE() AND tc.TABLE_NAME = ? AND tc.CONSTRAINT_NAME = ?`,
      [guard.table, guard.check.name],
    );
    present.push(rows.length > 0);
    if (
      rows.length > 0 &&
      (rows.length !== 1 ||
        rows[0]!.ENFORCED !== 'YES' ||
        checkExpression(String(rows[0]!.CHECK_CLAUSE)) !== checkExpression(guard.check.clause))
    ) {
      mismatch(guard.table, guard.check.name);
    }
  }
  if (present.some(Boolean) && !present.every(Boolean)) mismatch(guard.table, 'partial ALTER');
  return present.length > 0 && present.every(Boolean);
}

async function applyMigration(
  connection: mysql.PoolConnection,
  migration: MigrationFile,
): Promise<void> {
  const statements = splitSqlStatements(migration.sql);
  for (const [step, statement] of statements.entries()) {
    const hash = digest(statement);
    const [recorded] = await connection.execute<mysql.RowDataPacket[]>(
      `SELECT statement_hash FROM ${STEPS} WHERE migration_id = ? AND step = ?`,
      [migration.id, step],
    );
    const guard = guards.find((entry) => normalizedSql(entry.sql) === normalizedSql(statement));
    if (recorded[0]) {
      if (recorded[0].statement_hash !== hash) {
        throw new Error(
          `MySQL migration ${migration.id} step ${step} changed after it was applied`,
        );
      }
      if (guard && !(await alreadyApplied(connection, guard)))
        mismatch(guard.table, 'recorded step');
      continue;
    }
    const checkpoint = () =>
      connection.execute(
        `INSERT INTO ${STEPS} (migration_id, step, statement_hash, applied_at) VALUES (?, ?, ?, ?)`,
        [migration.id, step, hash, nowIso()],
      );
    if (guard) {
      // This also recovers legacy databases with committed DDL and no step journal.
      if (!(await alreadyApplied(connection, guard))) await connection.query(statement);
      if (!(await alreadyApplied(connection, guard))) mismatch(guard.table, 'ALTER postcondition');
      await checkpoint();
    } else if (/^CREATE TABLE IF NOT EXISTS\s/i.test(statement)) {
      // Shipped CREATEs include their indexes/constraints in one atomic DDL.
      await connection.query(statement);
      await checkpoint();
    } else if (
      migration.id === '011_credential_ordinal' &&
      step === 1 &&
      /^UPDATE credential_metadata AS cm\s/.test(statement)
    ) {
      // The deterministic legacy backfill and its progress record commit together.
      // A replay after a legacy interruption is safe while old writers are stopped.
      await connection.beginTransaction();
      try {
        await connection.query(statement);
        await checkpoint();
        await connection.commit();
      } catch (error) {
        // A failed rollback must not return an uncertain transaction to the pool.
        await connection.rollback().catch(() => connection.destroy());
        throw error;
      }
    } else {
      throw new Error(
        `MySQL migration ${migration.id} step ${step} needs reviewed recovery postconditions`,
      );
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
          await connection.query(`CREATE TABLE IF NOT EXISTS ${STEPS} (
          migration_id VARCHAR(191) NOT NULL, step INT NOT NULL,
          statement_hash CHAR(64) NOT NULL, applied_at VARCHAR(32) NOT NULL,
          PRIMARY KEY (migration_id, step)
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
