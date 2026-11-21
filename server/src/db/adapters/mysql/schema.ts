/**
 * Creating the MySQL base schema, serialized across application instances.
 *
 * MySQL DDL commits on its own, outside any transaction, so the base schema
 * cannot be created atomically with its ledger row. Instead every statement
 * of `schema/base.mysql.sql` is a replayable `CREATE TABLE IF NOT EXISTS` with
 * its keys and constraints inline (MySQL has no `CREATE INDEX IF NOT EXISTS`),
 * and the ledger row is written last: a start interrupted part-way finds an
 * empty ledger, replays the file — the tables it already created are skipped
 * — and records it. One database advisory lock covers the ledger reads, every
 * statement and the ledger write, so two instances starting together create
 * the schema once.
 */
import { createHash } from 'node:crypto';
import type mysql from 'mysql2/promise';
import { nowIso } from '../../../lib/ids.js';
import {
  ensureBaseSchema,
  loadBaseSchema,
  SCHEMA_LEDGER_TABLE,
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
        async ensureLedger() {
          await connection.query(`CREATE TABLE IF NOT EXISTS ${SCHEMA_LEDGER_TABLE} (
          id VARCHAR(191) NOT NULL, applied_at VARCHAR(32) NOT NULL, PRIMARY KEY (id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`);
        },
        async listRecorded() {
          const [recorded] = await connection.query<mysql.RowDataPacket[]>(
            `SELECT id FROM ${SCHEMA_LEDGER_TABLE}`,
          );
          return recorded.map((row) => String(row.id));
        },
        createBaseSchema: (base) => createBaseSchema(connection, base),
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
