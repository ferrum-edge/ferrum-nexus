/**
 * Creating the MySQL base schema, serialized across application instances.
 *
 * MySQL DDL commits on its own, outside any transaction, so the base schema
 * cannot be created atomically with its ledger row. Instead:
 *
 * - every statement of `schema/base.mysql.sql` is a replayable
 *   `CREATE TABLE IF NOT EXISTS` with its keys and constraints inline (MySQL
 *   has no `CREATE INDEX IF NOT EXISTS`), checked before any of them runs;
 * - the ledger first gets this build's claim (`creating:<fingerprint>`), then
 *   the tables are created, and one `UPDATE` replaces the claim with the
 *   fingerprint. A start interrupted part-way leaves the claim, so the next
 *   start of the same build replays the file (tables it already created are
 *   skipped, with their rows) and records it, while tables some other version
 *   left with no claim are refused (`ensureBaseSchema`).
 *
 * One database advisory lock covers the ledger reads, the claim, every
 * statement and the final record, so two instances starting together create
 * the schema once.
 */
import { createHash } from 'node:crypto';
import type mysql from 'mysql2/promise';
import { nowIso } from '../../../lib/ids.js';
import {
  ensureBaseSchema,
  loadBaseSchema,
  schemaClaim,
  SCHEMA_LEDGER_TABLE,
  SchemaRaceError,
  splitSqlStatements,
  type BaseSchema,
} from '../../schema.js';

const WHITESPACE_RUN = /\s+/g;
const CREATE_TABLE_IF_NOT_EXISTS = /^CREATE TABLE IF NOT EXISTS\s/i;
const MAX_LOCK_WAIT_TIMEOUT_SECONDS = 30;

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

/** `ER_NO_SUCH_TABLE`: the ledger does not exist yet. */
const NO_SUCH_TABLE = 1146;

/** The ledger's ids, or none when there is no ledger yet. */
async function readLedger(connection: mysql.PoolConnection): Promise<string[]> {
  try {
    const [recorded] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT id FROM ${SCHEMA_LEDGER_TABLE}`,
    );
    return recorded.map((row) => String(row.id));
  } catch (error) {
    if ((error as { errno?: unknown }).errno === NO_SUCH_TABLE) return [];
    throw error;
  }
}

async function tablesPresent(
  connection: mysql.PoolConnection,
  schema: BaseSchema,
): Promise<string[]> {
  if (schema.tables.length === 0) return [];
  const [tables] = await connection.query<mysql.RowDataPacket[]>(
    `SELECT TABLE_NAME AS name FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?)`,
    [[...schema.tables]],
  );
  return tables.map((row) => String(row.name));
}

async function createBaseSchema(
  connection: mysql.PoolConnection,
  schema: BaseSchema,
  resume: boolean,
): Promise<void> {
  const statements = replayableStatements(schema);
  const claim = schemaClaim(schema);
  await connection.query(`CREATE TABLE IF NOT EXISTS ${SCHEMA_LEDGER_TABLE} (
    id VARCHAR(191) NOT NULL, applied_at VARCHAR(32) NOT NULL, PRIMARY KEY (id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`);
  // The advisory lock already makes this start the only creator; the
  // re-read keeps the driver contract the other adapters follow.
  const recorded = await readLedger(connection);
  if (resume) {
    if (recorded.length !== 1 || recorded[0] !== claim) throw new SchemaRaceError();
  } else {
    if (recorded.length > 0 || (await tablesPresent(connection, schema)).length > 0) {
      throw new SchemaRaceError();
    }
    await connection.execute(`INSERT INTO ${SCHEMA_LEDGER_TABLE} (id, applied_at) VALUES (?, ?)`, [
      claim,
      nowIso(),
    ]);
  }
  for (const statement of statements) await connection.query(statement);
  const [result] = await connection.execute<mysql.ResultSetHeader>(
    `UPDATE ${SCHEMA_LEDGER_TABLE} SET id = ?, applied_at = ? WHERE id = ?`,
    [schema.id, nowIso(), claim],
  );
  if (result.affectedRows !== 1) {
    throw new Error(`The MySQL schema claim ${claim} disappeared before it could be recorded`);
  }
}

/** One connection owns the advisory lock, ledger reads, all statements, and release. */
export async function ensureMysqlSchema(
  pool: mysql.Pool,
  schema: BaseSchema = loadBaseSchema('mysql'),
  options: { lockWaitTimeoutSeconds?: number } = {},
): Promise<void> {
  // Tests may shorten the wait, but no caller may weaken the production cap.
  const lockWaitTimeout = options.lockWaitTimeoutSeconds ?? MAX_LOCK_WAIT_TIMEOUT_SECONDS;
  if (
    !Number.isInteger(lockWaitTimeout) ||
    lockWaitTimeout < 1 ||
    lockWaitTimeout > MAX_LOCK_WAIT_TIMEOUT_SECONDS
  ) {
    throw new RangeError('MySQL schema lock wait timeout must be an integer from 1 to 30');
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
    const name = `nexus:schema:${digest(rows[0].db).slice(0, 32)}`;
    // Acquisition can commit server-side before a transport error reaches us.
    lockName = name;
    const [locks] = await connection.execute<mysql.RowDataPacket[]>(
      'SELECT GET_LOCK(?, 30) AS acquired',
      [name],
    );
    if (Number(locks[0]?.acquired) !== 1) {
      throw new Error(
        'MySQL schema setup is busy; retry after the other instance finishes creating it',
      );
    }
    await ensureBaseSchema(
      {
        writesClaims: true,
        listRecorded: () => readLedger(connection),
        existingTables: (base) => tablesPresent(connection, base),
        createBaseSchema: (base, { resume }) => createBaseSchema(connection, base, resume),
      },
      schema,
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
