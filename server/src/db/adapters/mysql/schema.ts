/**
 * The MySQL schema: the frozen base schema and forward migrations, serialized
 * across application instances.
 *
 * MySQL DDL commits on its own, outside any transaction, so neither the base
 * schema nor a migration can be applied atomically with its ledger row.
 * Instead every change is replayable and the ledger row is written last:
 *
 * - every statement of `schema/base.mysql.sql` is a `CREATE TABLE IF NOT
 *   EXISTS` with its keys and constraints inline (MySQL has no `CREATE INDEX
 *   IF NOT EXISTS`), so a start interrupted part-way finds an empty ledger,
 *   replays the file — the tables it already created are skipped — and
 *   records it;
 * - a forward migration may contain only statements whose finished state can
 *   be read back from `information_schema` (see {@link migrationSteps}), each
 *   changing a different object. It is recorded **in progress** before its
 *   first statement and marked applied after its last, so an interrupted
 *   upgrade stays visible to every later start: a build that does not know
 *   the id refuses the database, and one that does resumes it. On a resume
 *   each step is checked first: one that already landed with exactly the
 *   intended definition is skipped, one with any other definition is refused.
 *   The whole file is validated before any of it runs.
 *
 * When there is work, one database advisory lock (`GET_LOCK`, never waited
 * for) covers the ledger re-read, every statement and the ledger writes: a
 * second migrator is refused rather than interleaved. The lock belongs to the
 * session, so a crashed migrator cannot leave it held. The pre-0.6 migration
 * runner used the same lock name; the replay checks are its, minus the steps
 * only its released migrations needed.
 */
import { createHash } from 'node:crypto';
import type mysql from 'mysql2/promise';
import { nowIso } from '../../../lib/ids.js';
import {
  ensureSchema,
  loadShippedMigrations,
  schemaBusyError,
  type LedgerEntry,
  type SchemaOptions,
  type SchemaResult,
  type SqlMigration,
} from '../../migrate.js';
import {
  loadBaseSchema,
  SCHEMA_LEDGER_TABLE,
  splitSqlStatements,
  type BaseSchema,
} from '../../schema.js';

const WHITESPACE_RUN = /\s+/g;
const CREATE_TABLE_IF_NOT_EXISTS = /^CREATE TABLE IF NOT EXISTS\s/i;
const INDEX_COLUMN = /^([a-z][a-z0-9_]*)(?: (ASC|DESC))?$/i;
const CHARSET_INTRODUCER = /^_[a-z0-9]+/i;
const QUOTED_STRING_LITERAL = /^\\?'((?:[^'\\]|\\.)*?)\\?'$/s;
const BACKSLASH_ESCAPE = /\\(.)/g;
const MAX_LOCK_WAIT_TIMEOUT_SECONDS = 30;

const ADD_COLUMN = /^ALTER TABLE ([a-z][a-z0-9_]*) ADD COLUMN ([a-z][a-z0-9_]*) (.+)$/i;
const STRING_COLUMN = /^(VARCHAR\([1-9][0-9]*\)) (NULL|NOT NULL DEFAULT '')$/i;
/** Nullable JSON text additions are replay-verified like string columns. */
const NULLABLE_LONGTEXT_COLUMN = /^LONGTEXT DEFAULT NULL$/i;
const INTEGER_COLUMN = /^INT NOT NULL DEFAULT ([0-9]+)$/i;
const CREATE_INDEX = /^CREATE INDEX ([a-z][a-z0-9_]*) ON ([a-z][a-z0-9_]*) \((.+)\)$/i;
/**
 * Widening an existing text column to LONGTEXT, keeping its nullability and
 * default. Only these three spellings, so the replay check knows exactly what
 * a finished change looks like.
 */
const WIDEN_TO_LONGTEXT =
  /^ALTER TABLE ([a-z][a-z0-9_]*) MODIFY COLUMN ([a-z][a-z0-9_]*) LONGTEXT (NOT NULL DEFAULT \('\{\}'\)|NOT NULL|DEFAULT NULL)$/i;
/** A 0/1 CHECK on a boolean column. Only this shape, so the replay check can compare it. */
const ADD_BOOLEAN_CHECK =
  /^ALTER TABLE ([a-z][a-z0-9_]*) ADD CONSTRAINT ([a-z][a-z0-9_]*) CHECK \(([a-z][a-z0-9_]*) IN \(0, 1\)\)$/i;
/** What `information_schema.CHECK_CONSTRAINTS` adds around a condition. */
const CHECK_CLAUSE_NOISE = /[`\s]/g;
/** The column types a widening may start from. */
const WIDENABLE_TYPES = new Set(['text', 'longtext']);
const WIDENABLE_VARCHAR = /^varchar\([1-9][0-9]*\)$/;

const digest = (text: string): string => createHash('sha256').update(text).digest('hex');

/**
 * The base schema's statements, refused as a whole — before any of them runs —
 * unless every one is a replayable `CREATE TABLE IF NOT EXISTS`.
 */
export function replayableStatements(schema: BaseSchema): string[] {
  const statements = splitSqlStatements(schema.sql);
  for (const statement of statements) {
    if (!CREATE_TABLE_IF_NOT_EXISTS.test(statement.replace(WHITESPACE_RUN, ' ').trim())) {
      throw new Error(
        `The MySQL base schema ${schema.source} contains a statement that is not a replayable ` +
          'CREATE TABLE IF NOT EXISTS',
      );
    }
  }
  return statements;
}

/* ── Replay-verifiable migration steps ──────────────────────────────────── */

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

/** A replayable statement: a `CREATE TABLE IF NOT EXISTS` (as text) or a checked change. */
interface AddTable {
  kind: 'table';
  /** The statement as written (it may span lines). */
  statement: string;
  table: string;
}

/** A replayable migration statement and what it changes. */
export type MigrationStep = AddTable | AddColumn | AddIndex | WidenColumn | AddCheck;

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
 * Parse a MySQL migration into replay-verifiable steps, refusing the whole
 * file if any statement is not one of: a plain `CREATE TABLE` of a new table,
 * `ALTER TABLE … ADD COLUMN` (a `VARCHAR(n) NULL`, `VARCHAR(n) NOT NULL
 * DEFAULT ''`, `INT NOT NULL DEFAULT n` or `LONGTEXT DEFAULT NULL` column),
 * `CREATE INDEX`, a LONGTEXT widening, or a boolean CHECK, each on a
 * different object. `IF [NOT] EXISTS` forms are refused: MySQL would skip such
 * a statement without comparing the definition already there. Arbitrary DML is
 * never accepted: MySQL could commit it before the ledger row is written, and
 * a replay would run it again. A migration that needs another kind of
 * statement extends this parser with its replay check first.
 */
export function migrationSteps(migration: SqlMigration): MigrationStep[] {
  const steps = parseSteps(migration);
  refuseRepeatedTargets(migration, steps);
  return steps;
}

const CREATE_TABLE = /^CREATE TABLE ([a-z][a-z0-9_]*) ?\(/i;
const IF_EXISTS = /\bIF (NOT )?EXISTS\b/i;

/**
 * Refuse a file that changes one object twice (a column added then widened,
 * two indexes of one name, one table created twice). Each step's replay check
 * compares the live schema with that step's own end state, which a later step
 * on the same object would have changed, so a replay after an interruption
 * would refuse the file. Dependent changes go in separate migrations.
 */
function refuseRepeatedTargets(migration: SqlMigration, steps: readonly MigrationStep[]): void {
  const seen = new Set<string>();
  for (const step of steps) {
    const target = stepTarget(step);
    if (seen.has(target)) {
      throw new Error(
        `MySQL migration ${migration.id} changes ${target} twice; put dependent changes in ` +
          'separate migrations',
      );
    }
    seen.add(target);
  }
}

/** The schema object a step creates or changes, for {@link refuseRepeatedTargets}. */
function stepTarget(step: MigrationStep): string {
  switch (step.kind) {
    case 'table':
      return `table ${step.table}`.toLowerCase();
    case 'column':
    case 'widen':
      return `column ${step.table}.${step.column}`.toLowerCase();
    case 'index':
      return `index ${step.table}.${step.name}`.toLowerCase();
    case 'check':
      return `check ${step.name}`.toLowerCase();
  }
}

/** Parse every statement of a migration into a step, refusing unsupported ones. */
function parseSteps(migration: SqlMigration): MigrationStep[] {
  return splitSqlStatements(migration.sql).map<MigrationStep>((sql) => {
    const statement = sql.replace(WHITESPACE_RUN, ' ').trim();
    if (IF_EXISTS.test(statement)) {
      throw new Error(
        `MySQL migration ${migration.id} uses an IF [NOT] EXISTS form, which MySQL skips ` +
          'without comparing the existing definition; write the plain statement',
      );
    }
    const table = CREATE_TABLE.exec(statement);
    if (table) return { kind: 'table', statement: sql, table: table[1]! };
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
 * replay after an interruption finds it done and skips it rather than
 * rebuilding the table again. A column that is neither a widenable type nor
 * the finished LONGTEXT, or whose nullability, default, generation or
 * collation differs, is refused rather than converted.
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

/** Whether a table of this name exists. */
async function tableExists(connection: mysql.PoolConnection, table: string): Promise<boolean> {
  const [rows] = await connection.execute<mysql.RowDataPacket[]>(
    'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    [table],
  );
  return rows.length > 0;
}

/**
 * Whether one step already landed with exactly its intended definition. A
 * table counts as landed when it exists: `beginMigration` refused the
 * migration unless every table it creates was absent, and the migration lock
 * excludes other writers, so a table found on a resume is this migration's.
 */
function stepPresent(connection: mysql.PoolConnection, step: MigrationStep): Promise<boolean> {
  switch (step.kind) {
    case 'table':
      return tableExists(connection, step.table);
    case 'column':
      return columnExists(connection, step);
    case 'widen':
      return columnWidened(connection, step);
    case 'check':
      return checkExists(connection, step);
    case 'index':
      return indexExists(connection, step);
  }
}

/* ── The driver ─────────────────────────────────────────────────────────── */

async function createBaseSchema(
  connection: mysql.PoolConnection,
  schema: BaseSchema,
): Promise<void> {
  for (const statement of replayableStatements(schema)) await connection.query(statement);
  await connection.execute(`INSERT INTO ${SCHEMA_LEDGER_TABLE} (id, applied_at) VALUES (?, ?)`, [
    schema.id,
    nowIso(),
  ]);
}

/** Record a migration in progress, after validating the whole file. */
async function beginMigration(
  connection: mysql.PoolConnection,
  migration: SqlMigration,
): Promise<void> {
  for (const step of migrationSteps(migration)) {
    if (step.kind === 'table' && (await tableExists(connection, step.table))) {
      throw new Error(
        `MySQL migration ${migration.id} creates table ${step.table}, which already exists; a ` +
          'migration creates only new tables',
      );
    }
  }
  await connection.execute(
    `INSERT INTO ${SCHEMA_LEDGER_TABLE} (id, applied_at, checksum, state) ` +
      "VALUES (?, ?, ?, 'in_progress')",
    [migration.id, nowIso(), migration.checksum],
  );
}

/**
 * Run (or resume) a migration recorded in progress, then mark it applied. Every
 * checked step is skipped when it already landed with its intended definition,
 * so a resume after an interruption finishes the file.
 */
async function applyMigration(
  connection: mysql.PoolConnection,
  migration: SqlMigration,
): Promise<void> {
  // Validate the whole file before applying any of it.
  const steps = migrationSteps(migration);
  for (const step of steps) {
    if (await stepPresent(connection, step)) continue;
    await connection.query(step.statement);
    if (!(await stepPresent(connection, step))) {
      throw new Error(`MySQL migration ${migration.id} failed to change ${step.table}`);
    }
  }
  const [result] = await connection.execute<mysql.ResultSetHeader>(
    `UPDATE ${SCHEMA_LEDGER_TABLE} SET state = 'applied', applied_at = ? ` +
      "WHERE id = ? AND checksum = ? AND state = 'in_progress'",
    [nowIso(), migration.id, migration.checksum],
  );
  if (result.affectedRows !== 1) {
    throw new Error(`MySQL migration ${migration.id} lost its in-progress ledger entry`);
  }
}

/** The ledger's columns (a v0.6.0 ledger has only `id` and `applied_at`). */
async function ledgerColumns(connection: mysql.PoolConnection): Promise<Set<string>> {
  const [rows] = await connection.execute<mysql.RowDataPacket[]>(
    `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [SCHEMA_LEDGER_TABLE],
  );
  return new Set(rows.map((row) => String(row.name)));
}

/** Options for {@link ensureMysqlSchema}. */
export interface MysqlSchemaOptions extends SchemaOptions {
  /** Tests may shorten the metadata-lock wait (1 to 30 s); nothing may lengthen it. */
  lockWaitTimeoutSeconds?: number;
  /** Forward migrations to apply; the shipped ones by default. A test seam. */
  migrations?: readonly SqlMigration[];
}

/** The advisory lock name for a database: the pre-0.6 runner's, so old and new serialize. */
export function mysqlSchemaLockName(database: string): string {
  return `nexus:migrations:${digest(database).slice(0, 32)}`;
}

/**
 * Bring the database to this build's schema (`migrate.ts`). One connection
 * owns the advisory lock, ledger reads, every statement, and the release.
 */
export async function ensureMysqlSchema(
  pool: mysql.Pool,
  schema: BaseSchema = loadBaseSchema('mysql'),
  options: MysqlSchemaOptions = {},
): Promise<SchemaResult> {
  // Tests may shorten the wait, but no caller may weaken the production cap.
  const lockWaitTimeout = options.lockWaitTimeoutSeconds ?? MAX_LOCK_WAIT_TIMEOUT_SECONDS;
  if (
    !Number.isInteger(lockWaitTimeout) ||
    lockWaitTimeout < 1 ||
    lockWaitTimeout > MAX_LOCK_WAIT_TIMEOUT_SECONDS
  ) {
    throw new RangeError('MySQL schema lock wait timeout must be an integer from 1 to 30');
  }
  const migrations = options.migrations ?? loadShippedMigrations('mysql');
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
      throw new Error('MySQL schema setup could not read the session lock wait timeout');
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
      throw new Error('MySQL schema setup requires a selected database');
    const name = mysqlSchemaLockName(rows[0].db);
    return await ensureSchema(
      {
        // Taken only when there is work, without waiting: a second migrator
        // is refused. The session ends the lock, so a crash cannot leave it
        // held; it is released below.
        async acquireLock() {
          // Acquisition can commit server-side before a transport error reaches us.
          lockName = name;
          const [locks] = await connection.execute<mysql.RowDataPacket[]>(
            'SELECT GET_LOCK(?, 0) AS acquired',
            [name],
          );
          if (Number(locks[0]?.acquired) !== 1) {
            lockName = undefined;
            throw schemaBusyError('MySQL');
          }
          return async () => undefined;
        },
        async lockHeld() {
          const [used] = await connection.execute<mysql.RowDataPacket[]>(
            'SELECT IS_USED_LOCK(?) AS holder',
            [name],
          );
          return used[0]?.holder !== null && used[0]?.holder !== undefined;
        },
        async ensureLedger() {
          await connection.query(`CREATE TABLE IF NOT EXISTS ${SCHEMA_LEDGER_TABLE} (
          id VARCHAR(191) NOT NULL, applied_at VARCHAR(32) NOT NULL, checksum VARCHAR(64) NULL,
          state VARCHAR(16) NULL, PRIMARY KEY (id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`);
        },
        async listRecorded(): Promise<LedgerEntry[]> {
          const present = await ledgerColumns(connection);
          const columns = ['id', 'checksum', 'state'].filter((column) => present.has(column));
          const [recorded] = await connection.query<mysql.RowDataPacket[]>(
            `SELECT ${columns.join(', ')} FROM ${SCHEMA_LEDGER_TABLE}`,
          );
          return recorded.map((row) => ({
            id: String(row.id),
            checksum: typeof row.checksum === 'string' ? row.checksum : null,
            inProgress: row.state === 'in_progress',
          }));
        },
        createBaseSchema: (base) => createBaseSchema(connection, base),
        async prepareLedger() {
          // Under the advisory lock, so no other instance alters it meanwhile.
          const present = await ledgerColumns(connection);
          if (!present.has('checksum')) {
            await connection.query(
              `ALTER TABLE ${SCHEMA_LEDGER_TABLE} ADD COLUMN checksum VARCHAR(64) NULL`,
            );
          }
          if (!present.has('state')) {
            await connection.query(
              `ALTER TABLE ${SCHEMA_LEDGER_TABLE} ADD COLUMN state VARCHAR(16) NULL`,
            );
          }
        },
        beginMigration: (migration) => beginMigration(connection, migration),
        applyMigration: (migration) => applyMigration(connection, migration),
      },
      schema,
      migrations,
      { mode: options.mode ?? 'migrate' },
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
    // Cleanup must not hide a schema failure. Discard any connection whose
    // advisory-lock release or session restoration could not be confirmed.
    if (reusable) connection.release();
    else connection.destroy();
  }
}
