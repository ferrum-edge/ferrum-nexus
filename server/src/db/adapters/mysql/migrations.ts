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

const WHITESPACE_RUN = /\s+/g;
const CREATE_TABLE_IF_NOT_EXISTS = /^CREATE TABLE IF NOT EXISTS\s/i;
const INDEX_COLUMN = /^([a-z][a-z0-9_]*)(?: (ASC|DESC))?$/i;
const CHARSET_INTRODUCER = /^_[a-z0-9]+/i;
const QUOTED_STRING_LITERAL = /^\\?'((?:[^'\\]|\\.)*?)\\?'$/s;
const BACKSLASH_ESCAPE = /\\(.)/g;

const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
const ADD_COLUMN = /^ALTER TABLE ([a-z][a-z0-9_]*) ADD COLUMN ([a-z][a-z0-9_]*) (.+)$/i;
const STRING_COLUMN = /^(VARCHAR\([1-9][0-9]*\)) (NULL|NOT NULL DEFAULT '')$/i;
/** Nullable JSON text additions are replay-verified like existing string columns. */
const NULLABLE_LONGTEXT_COLUMN = /^LONGTEXT DEFAULT NULL$/i;
const INTEGER_COLUMN = /^INT NOT NULL DEFAULT ([0-9]+)$/i;
const CREATE_INDEX = /^CREATE INDEX ([a-z][a-z0-9_]*) ON ([a-z][a-z0-9_]*) \((.+)\)$/i;
/**
 * Widening an existing text column to LONGTEXT, keeping its nullability and
 * default (`014_mysql_text_capacity`). Only these three spellings, so the
 * replay check below knows exactly what a finished change looks like.
 */
const WIDEN_TO_LONGTEXT =
  /^ALTER TABLE ([a-z][a-z0-9_]*) MODIFY COLUMN ([a-z][a-z0-9_]*) LONGTEXT (NOT NULL DEFAULT \('\{\}'\)|NOT NULL|DEFAULT NULL)$/i;
/**
 * A 0/1 CHECK on a boolean column (`014_mysql_text_capacity` adds the
 * `apis.circuit_breaker` one the other dialects' baselines declare). Only this
 * shape, so the replay check below can compare the finished constraint.
 */
const ADD_BOOLEAN_CHECK =
  /^ALTER TABLE ([a-z][a-z0-9_]*) ADD CONSTRAINT ([a-z][a-z0-9_]*) CHECK \(([a-z][a-z0-9_]*) IN \(0, 1\)\)$/i;
/** What `information_schema.CHECK_CONSTRAINTS` adds around a condition. */
const CHECK_CLAUSE_NOISE = /[`\s]/g;
/** The column types a widening may start from: what earlier releases created. */
const WIDENABLE_TYPES = new Set(['text', 'longtext']);
const WIDENABLE_VARCHAR = /^varchar\([1-9][0-9]*\)$/;
// This assignment is idempotent, and changes no delivery state. Do not accept
// arbitrary DML here: MySQL can commit it before the ledger is recorded.
const OUTBOX_PRIORITY_BACKFILL =
  'UPDATE email_outbox SET priority = 2 WHERE priority = 1 AND ' +
  "(SUBSTR(idempotency_key, 1, 7) = 'verify:' OR " +
  "SUBSTR(idempotency_key, 1, 6) = 'reset:')";
const MAX_LOCK_WAIT_TIMEOUT_SECONDS = 30;

interface AddColumn {
  kind: 'column';
  statement: string;
  table: string;
  column: string;
  type: string;
  nullable: boolean;
  defaultValue: string | null;
  stringColumn: boolean;
}

interface WidenColumn {
  kind: 'widen';
  statement: string;
  table: string;
  column: string;
  nullable: boolean;
  /** Whether the column carries the `('{}')` expression default. */
  jsonDefault: boolean;
}

interface AddIndex {
  kind: 'index';
  statement: string;
  table: string;
  name: string;
  columns: { name: string; direction: 'A' | 'D' }[];
}

interface AddCheck {
  kind: 'check';
  statement: string;
  table: string;
  name: string;
  /** The condition as {@link checkClause} normalises it. */
  clause: string;
}

type MigrationStep = string | AddColumn | AddIndex | WidenColumn | AddCheck;

/**
 * A CHECK condition without identifier quotes, whitespace, case or enclosing
 * parentheses: `circuit_breaker IN (0, 1)` and MySQL's own
 * ``(`circuit_breaker` in (0,1))`` both become `circuit_breakerin(0,1)`.
 */
function checkClause(text: string): string {
  let clause = text.replace(CHECK_CLAUSE_NOISE, '').toLowerCase();
  while (clause.startsWith('(') && clause.endsWith(')')) clause = clause.slice(1, -1);
  return clause;
}

/**
 * Only replay-verifiable additions, LONGTEXT widenings, boolean CHECKs and the
 * idempotent priority backfill are supported.
 */
function migrationSteps(migration: MigrationFile): MigrationStep[] {
  return splitSqlStatements(migration.sql).map<MigrationStep>((sql) => {
    const statement = sql.replace(WHITESPACE_RUN, ' ').trim();
    if (CREATE_TABLE_IF_NOT_EXISTS.test(statement)) return sql;
    if (migration.id === '009_outbox_priority' && statement === OUTBOX_PRIORITY_BACKFILL) {
      return statement;
    }
    const widen = WIDEN_TO_LONGTEXT.exec(statement);
    if (widen) {
      return {
        kind: 'widen',
        statement,
        table: widen[1]!,
        column: widen[2]!,
        nullable: widen[3]!.toUpperCase() === 'DEFAULT NULL',
        jsonDefault: widen[3]!.toUpperCase().includes('DEFAULT ('),
      };
    }
    const check = ADD_BOOLEAN_CHECK.exec(statement);
    if (check) {
      return {
        kind: 'check',
        statement,
        table: check[1]!,
        name: check[2]!,
        clause: checkClause(`${check[3]!} IN (0, 1)`),
      };
    }
    const index = CREATE_INDEX.exec(statement);
    if (index) {
      const columns = index[3]!.split(',').map((column) => {
        const match = INDEX_COLUMN.exec(column.trim());
        if (!match) throw new Error(`MySQL migration ${migration.id} has unsupported index DDL`);
        return {
          name: match[1]!,
          direction: match[2]?.toUpperCase() === 'DESC' ? ('D' as const) : ('A' as const),
        };
      });
      return { kind: 'index', statement, table: index[2]!, name: index[1]!, columns };
    }
    const match = ADD_COLUMN.exec(statement);
    const definition = match && STRING_COLUMN.exec(match[3]!);
    const integer = match && INTEGER_COLUMN.exec(match[3]!);
    const nullableText = match !== null && NULLABLE_LONGTEXT_COLUMN.test(match[3]!);
    if (!match || (!definition && !integer && !nullableText)) {
      throw new Error(`MySQL migration ${migration.id} contains unsupported non-replayable DDL`);
    }
    const nullable = nullableText || definition?.[2]?.toUpperCase() === 'NULL';
    return {
      kind: 'column',
      statement,
      table: match[1]!,
      column: match[2]!,
      type: nullableText ? 'longtext' : definition ? definition[1]!.toLowerCase() : 'int',
      nullable,
      defaultValue: nullableText ? null : definition ? (nullable ? null : '') : integer![1]!,
      stringColumn: nullableText || definition !== null,
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
    (column.COLUMN_DEFAULT === null ? null : String(column.COLUMN_DEFAULT)) !== step.defaultValue ||
    column.EXTRA !== '' ||
    column.COLLATION_NAME !== (step.stringColumn ? column.TABLE_COLLATION : null)
  ) {
    throw new Error(
      `MySQL migration column ${step.table}.${step.column} has an incompatible definition`,
    );
  }
  return true;
}

/**
 * The string literal an expression default such as `('{}')` evaluates to, as
 * `information_schema.COLUMNS.COLUMN_DEFAULT` reports it (`_utf8mb4\'{}\'`,
 * with or without the introducer and the parentheses), or `null` for anything
 * that is not exactly one string literal.
 */
function expressionDefaultLiteral(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let text = value.trim();
  while (text.startsWith('(') && text.endsWith(')')) text = text.slice(1, -1).trim();
  text = text.replace(CHARSET_INTRODUCER, '');
  const match = QUOTED_STRING_LITERAL.exec(text);
  if (!match) return null;
  return match[1]!.replace(BACKSLASH_ESCAPE, '$1');
}

/**
 * Whether a widening already landed. `MODIFY COLUMN` commits on its own, so a
 * replay after an interruption finds it done; it is skipped rather than
 * rebuilding the table again. A column that is neither the type an earlier
 * release created nor the finished LONGTEXT, or whose nullability, default,
 * generation or collation differs, is refused rather than converted.
 */
async function columnWidened(
  connection: mysql.PoolConnection,
  step: WidenColumn,
): Promise<boolean> {
  const [rows] = await connection.execute<mysql.RowDataPacket[]>(
    `SELECT c.COLUMN_TYPE, c.IS_NULLABLE, c.COLUMN_DEFAULT, c.EXTRA, c.GENERATION_EXPRESSION,
            c.COLLATION_NAME, t.TABLE_COLLATION
       FROM information_schema.COLUMNS c
       JOIN information_schema.TABLES t
         ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
      WHERE c.TABLE_SCHEMA = DATABASE() AND c.TABLE_NAME = ? AND c.COLUMN_NAME = ?`,
    [step.table, step.column],
  );
  const column = rows[0];
  const type = String(column?.COLUMN_TYPE ?? '').toLowerCase();
  if (
    !column ||
    !(WIDENABLE_TYPES.has(type) || WIDENABLE_VARCHAR.test(type)) ||
    column.IS_NULLABLE !== (step.nullable ? 'YES' : 'NO') ||
    column.COLLATION_NAME !== column.TABLE_COLLATION ||
    // A generated column, or one with a default other than the one expected,
    // is not the column an earlier release created, whatever its type.
    String(column.GENERATION_EXPRESSION ?? '') !== '' ||
    column.EXTRA !== (step.jsonDefault ? 'DEFAULT_GENERATED' : '') ||
    (step.jsonDefault
      ? expressionDefaultLiteral(column.COLUMN_DEFAULT) !== '{}'
      : column.COLUMN_DEFAULT !== null)
  ) {
    throw new Error(
      `MySQL migration column ${step.table}.${step.column} has an incompatible definition`,
    );
  }
  return type === 'longtext';
}

/**
 * Whether a CHECK already landed. `ADD CONSTRAINT` commits on its own, so a
 * replay after an interruption finds it and skips it. A constraint of that name
 * on another table, not enforced, or with another condition is refused.
 */
async function checkExists(connection: mysql.PoolConnection, step: AddCheck): Promise<boolean> {
  const [rows] = await connection.execute<mysql.RowDataPacket[]>(
    `SELECT t.TABLE_NAME, t.ENFORCED, c.CHECK_CLAUSE
       FROM information_schema.TABLE_CONSTRAINTS t
       JOIN information_schema.CHECK_CONSTRAINTS c
         ON c.CONSTRAINT_SCHEMA = t.CONSTRAINT_SCHEMA AND c.CONSTRAINT_NAME = t.CONSTRAINT_NAME
      WHERE t.CONSTRAINT_SCHEMA = DATABASE() AND t.CONSTRAINT_TYPE = 'CHECK'
        AND t.CONSTRAINT_NAME = ?`,
    [step.name],
  );
  const constraint = rows[0];
  if (!constraint) return false;
  if (
    rows.length !== 1 ||
    constraint.TABLE_NAME !== step.table ||
    constraint.ENFORCED !== 'YES' ||
    checkClause(String(constraint.CHECK_CLAUSE)) !== step.clause
  ) {
    throw new Error(
      `MySQL migration check ${step.table}.${step.name} has an incompatible definition`,
    );
  }
  return true;
}

async function indexExists(connection: mysql.PoolConnection, step: AddIndex): Promise<boolean> {
  const [rows] = await connection.execute<mysql.RowDataPacket[]>(
    `SELECT COLUMN_NAME, COLLATION, NON_UNIQUE, SUB_PART, INDEX_TYPE, IS_VISIBLE, EXPRESSION
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?
      ORDER BY SEQ_IN_INDEX`,
    [step.table, step.name],
  );
  if (rows.length === 0) return false;
  if (
    rows.length !== step.columns.length ||
    rows.some((row, i) => {
      const column = step.columns[i]!;
      return (
        row.COLUMN_NAME !== column.name ||
        row.COLLATION !== column.direction ||
        Number(row.NON_UNIQUE) !== 1 ||
        row.SUB_PART !== null ||
        row.INDEX_TYPE !== 'BTREE' ||
        row.IS_VISIBLE !== 'YES' ||
        row.EXPRESSION !== null
      );
    })
  ) {
    throw new Error(
      `MySQL migration index ${step.table}.${step.name} has an incompatible definition`,
    );
  }
  return true;
}

async function applyMigration(
  connection: mysql.PoolConnection,
  migration: MigrationFile,
): Promise<void> {
  // MySQL DDL commits independently of the ledger. The buildout baseline uses
  // replayable CREATEs; additive columns and indexes are checked against live
  // metadata on every replay. Validate the whole file before applying any of
  // it. The same database advisory lock covers metadata, DDL and the ledger.
  const steps = migrationSteps(migration);
  for (const step of steps) {
    if (typeof step === 'string') {
      await connection.query(step);
    } else {
      const present = () =>
        step.kind === 'column'
          ? columnExists(connection, step)
          : step.kind === 'widen'
            ? columnWidened(connection, step)
            : step.kind === 'check'
              ? checkExists(connection, step)
              : indexExists(connection, step);
      if (!(await present())) {
        await connection.query(step.statement);
        if (!(await present())) {
          throw new Error(`MySQL migration failed to change ${step.table}`);
        }
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
  options: { lockWaitTimeoutSeconds?: number } = {},
): Promise<void> {
  // Tests may shorten the wait, but no caller may weaken the production cap.
  const lockWaitTimeout = options.lockWaitTimeoutSeconds ?? MAX_LOCK_WAIT_TIMEOUT_SECONDS;
  if (
    !Number.isInteger(lockWaitTimeout) ||
    lockWaitTimeout < 1 ||
    lockWaitTimeout > MAX_LOCK_WAIT_TIMEOUT_SECONDS
  ) {
    throw new RangeError('MySQL migration lock wait timeout must be an integer from 1 to 30');
  }
  const connection = await pool.getConnection();
  let lockName: string | undefined;
  let originalLockWaitTimeout: number | undefined;
  let reusable = true;
  try {
    const [settings] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT @@SESSION.lock_wait_timeout AS lock_wait_timeout',
    );
    const original = Number(settings[0]?.lock_wait_timeout);
    if (!Number.isInteger(original) || original < 1 || original > 31_536_000) {
      throw new Error('MySQL migrations could not read the session lock wait timeout');
    }
    // SET can land before its acknowledgement is lost. Arm restoration first.
    // This bounds each metadata-lock acquisition, including CREATEs and ledger
    // queries; GET_LOCK's separate timeout only bounds advisory-lock acquisition.
    originalLockWaitTimeout = original;
    await connection.query('SET SESSION lock_wait_timeout = ?', [
      Math.min(original, lockWaitTimeout),
    ]);
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
        if (Number(released[0]?.released) !== 1) reusable = false;
      } catch {
        reusable = false;
      }
    }
    if (originalLockWaitTimeout !== undefined) {
      try {
        await connection.query('SET SESSION lock_wait_timeout = ?', [originalLockWaitTimeout]);
      } catch {
        reusable = false;
      }
    }
    // Cleanup must not hide a migration failure. Discard any connection whose
    // advisory-lock release or session restoration could not be confirmed.
    if (reusable) connection.release();
    else connection.destroy();
  }
}
