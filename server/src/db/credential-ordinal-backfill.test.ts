/**
 * `011_credential_ordinal` backfill, run against the real SQLite migration.
 *
 * Rows written before the ordinal existed are numbered from the old
 * `(created_at, id)` sort only where that sort is unambiguous — no two live
 * rows of one consumer and type share a timestamp. An ambiguous group is left
 * NULL throughout, which is what makes the credentials service refuse to act on
 * those rows until an administrator reconciles the consumer. Revoked rows do
 * not occupy a gateway slot, so a timestamp they share with a live row is not
 * an ambiguity.
 *
 * The schema is built by applying every migration *before* 011, inserting rows
 * with the old column set, then applying the rest — so the statement under test
 * is the shipped one, not a re-typed copy.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type { Database } from 'better-sqlite3';

import { openSqliteDatabase } from './adapters/sqlite/index.js';
import {
  loadMigrations,
  runMigrations,
  SCHEMA_MIGRATIONS_TABLE,
  type MigrationDriver,
  type MigrationFile,
} from './migrate.js';

const ORDINAL_MIGRATION = '011_credential_ordinal';

function driverFor(db: Database): MigrationDriver {
  return {
    async ensureMigrationsTable(): Promise<void> {
      db.exec(
        `CREATE TABLE IF NOT EXISTS ${SCHEMA_MIGRATIONS_TABLE} (
           id TEXT PRIMARY KEY,
           applied_at TEXT NOT NULL
         )`,
      );
    },
    async listApplied(): Promise<string[]> {
      const rows = db.prepare(`SELECT id FROM ${SCHEMA_MIGRATIONS_TABLE}`).all();
      return (rows as { id: string }[]).map((row) => row.id);
    },
    async applyMigration(migration: MigrationFile): Promise<void> {
      db.exec(migration.sql);
      db.prepare(`INSERT INTO ${SCHEMA_MIGRATIONS_TABLE} (id, applied_at) VALUES (?, ?)`).run(
        migration.id,
        '2026-09-05T00:00:00.000Z',
      );
    },
  };
}

type Status = 'active' | 'revoked';

/** Insert a row exactly as the pre-011 schema held it: no ordinal column at all. */
function insertLegacy(
  db: Database,
  id: string,
  consumer: string,
  type: 'keyauth' | 'basicauth' | 'jwt',
  createdAt: string,
  status: Status,
): void {
  db.prepare(
    `INSERT INTO credential_metadata
       (id, user_id, ferrum_consumer_id, credential_type, ferrum_credential_id, fingerprint,
        last4, label, status, rotated_from_id, created_at, updated_at)
     VALUES (?, 'user-1', ?, ?, ?, ?, 'abcd', NULL, ?, NULL, ?, ?)`,
  ).run(
    id,
    consumer,
    type,
    `${consumer}/credentials/${type}`,
    `fp-${id}`,
    status,
    createdAt,
    createdAt,
  );
}

function ordinalsOf(db: Database, consumer: string, type: string): Record<string, number | null> {
  const rows = db
    .prepare(
      `SELECT id, edge_ordinal FROM credential_metadata
        WHERE ferrum_consumer_id = ? AND credential_type = ? ORDER BY id`,
    )
    .all(consumer, type) as { id: string; edge_ordinal: number | null }[];
  return Object.fromEntries(rows.map((row) => [row.id, row.edge_ordinal]));
}

const T0 = '2026-09-01T10:00:00.000Z';
const T1 = '2026-09-01T10:00:01.000Z';
const T2 = '2026-09-01T10:00:02.000Z';

describe('011_credential_ordinal backfill (SQLite)', () => {
  let db: Database;

  before(async () => {
    db = openSqliteDatabase(':memory:');
    // The rows under test reference no real user; the migration is what is
    // being exercised, not the foreign keys around it.
    db.pragma('foreign_keys = OFF');

    const migrations = loadMigrations('sqlite');
    const before011 = migrations.filter((migration) => migration.id < ORDINAL_MIGRATION);
    const from011 = migrations.filter((migration) => migration.id >= ORDINAL_MIGRATION);
    assert.ok(from011.some((migration) => migration.id === ORDINAL_MIGRATION));
    await runMigrations(driverFor(db), before011);

    // Distinct live timestamps: the old sort is the append order, so it is kept.
    insertLegacy(db, 'a-2', 'c-distinct', 'keyauth', T0, 'active');
    insertLegacy(db, 'a-1', 'c-distinct', 'keyauth', T1, 'active');
    insertLegacy(db, 'a-3', 'c-distinct', 'keyauth', T2, 'revoked');
    // Two live rows in one millisecond: unrecoverable, left NULL as a group.
    insertLegacy(db, 'b-1', 'c-distinct', 'jwt', T0, 'active');
    insertLegacy(db, 'b-2', 'c-distinct', 'jwt', T0, 'active');
    insertLegacy(db, 'b-3', 'c-distinct', 'jwt', T1, 'active');
    // A revoked row sharing a live row's timestamp holds no slot: not ambiguous.
    insertLegacy(db, 'c-1', 'c-revoked', 'keyauth', T0, 'active');
    insertLegacy(db, 'c-2', 'c-revoked', 'keyauth', T0, 'revoked');
    insertLegacy(db, 'c-3', 'c-revoked', 'keyauth', T1, 'active');
    // The same type on another consumer is a separate group entirely.
    insertLegacy(db, 'd-1', 'c-other', 'jwt', T0, 'active');

    const result = await runMigrations(driverFor(db), from011);
    assert.ok(result.applied.includes(ORDINAL_MIGRATION));
  });

  after(() => {
    db.close();
  });

  it('numbers unambiguous groups from the old sort, revoked rows included', () => {
    assert.deepEqual(ordinalsOf(db, 'c-distinct', 'keyauth'), { 'a-2': 1, 'a-1': 2, 'a-3': 3 });
  });

  it('leaves a group with two live rows in one millisecond entirely unresolved', () => {
    assert.deepEqual(ordinalsOf(db, 'c-distinct', 'jwt'), {
      'b-1': null,
      'b-2': null,
      'b-3': null,
    });
  });

  it('does not count a revoked row sharing a timestamp as an ambiguity', () => {
    // `(created_at, id)` order: c-1 and c-2 share T0 and sort by id.
    assert.deepEqual(ordinalsOf(db, 'c-revoked', 'keyauth'), { 'c-1': 1, 'c-2': 2, 'c-3': 3 });
  });

  it('scopes the ambiguity to one consumer and type', () => {
    assert.deepEqual(ordinalsOf(db, 'c-other', 'jwt'), { 'd-1': 1 });
  });

  it('rejects a second row claiming an assigned ordinal but allows any number of NULLs', () => {
    const insert = db.prepare(
      `INSERT INTO credential_metadata
         (id, user_id, ferrum_consumer_id, credential_type, ferrum_credential_id, fingerprint,
          last4, label, status, rotated_from_id, edge_ordinal, created_at, updated_at)
       VALUES (?, 'user-1', 'c-distinct', ?, 'x', ?, 'abcd', NULL, 'active', NULL, ?, ?, ?)`,
    );
    assert.throws(
      () => insert.run('dup-1', 'keyauth', 'fp-dup-1', 1, T2, T2),
      /UNIQUE constraint failed/,
    );
    insert.run('null-1', 'jwt', 'fp-null-1', null, T2, T2);
    insert.run('null-2', 'jwt', 'fp-null-2', null, T2, T2);
    assert.equal(ordinalsOf(db, 'c-distinct', 'jwt')['null-2'], null);
  });

  it('applies nothing the second time', async () => {
    const again = await runMigrations(driverFor(db), loadMigrations('sqlite'));
    assert.deepEqual(again.applied, []);
  });
});
