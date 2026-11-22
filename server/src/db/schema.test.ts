/**
 * The base schema rule: create it in an empty database, accept a database
 * already at it, refuse any other (docs/operations.md, "Schema and upgrades
 * before 1.0"). Checked on a real SQLite driver; the smoke suite checks the
 * refusal on every backend.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { conflict, isNexusError } from '../lib/errors.js';
import { MONGO_BASE_SCHEMA } from './adapters/mongodb/index.js';
import { createSqliteSchemaDriver, openSqliteDatabase } from './adapters/sqlite/index.js';
import {
  BASE_SCHEMA_ID,
  ensureBaseSchema,
  loadBaseSchema,
  SCHEMA_LEDGER_TABLE,
  type BaseSchema,
  type SchemaDriver,
} from './schema.js';

const NO_UPGRADE_PATH = /no upgrade path before 1\.0/;
const RECREATE = /new, empty database/;
const NAMES_FAILED_SCHEMA = /^Creating the base schema base_test failed: .*no such table: missing/;

/** What a v0.5.2 database records: the released migration chain. */
const OLDER_RELEASE_LEDGER = [
  '001_initial',
  '002_api_gateway_plugins',
  '003_messages_thread_latest',
  '004_api_spec_changes',
  '005_notification_preferences',
  '006_user_identities',
  '007_outbox_recipient',
  '008_email_lifecycle_fence',
  '009_outbox_priority',
  '010_api_agents',
  '011_mcp_tool_subsets',
  '012_access_request_grant',
  '013_account_recovery_jobs',
];

function tables(db: ReturnType<typeof openSqliteDatabase>): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => (row as { name: string }).name);
}

function ledger(db: ReturnType<typeof openSqliteDatabase>): string[] {
  return db
    .prepare(`SELECT id FROM ${SCHEMA_LEDGER_TABLE} ORDER BY id`)
    .all()
    .map((row) => (row as { id: string }).id);
}

describe('ensureBaseSchema', () => {
  it('creates the base schema in an empty database, then leaves it alone', async () => {
    const db = openSqliteDatabase(':memory:');
    try {
      const schema = loadBaseSchema('sqlite');
      const driver = createSqliteSchemaDriver(db);
      assert.deepEqual(await ensureBaseSchema(driver, schema), { created: true });
      assert.deepEqual(ledger(db), [schema.id]);
      assert.ok(tables(db).includes('access_gateway_jobs'));

      const before = tables(db);
      assert.deepEqual(await ensureBaseSchema(driver, schema), { created: false });
      assert.deepEqual(tables(db), before);
      assert.deepEqual(ledger(db), [schema.id]);
    } finally {
      db.close();
    }
  });

  it('refuses a database an earlier release created, changing nothing', async () => {
    const db = openSqliteDatabase(':memory:');
    try {
      db.exec(`
        CREATE TABLE ${SCHEMA_LEDGER_TABLE} (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
        CREATE TABLE users (id TEXT PRIMARY KEY);
      `);
      const insert = db.prepare(`INSERT INTO ${SCHEMA_LEDGER_TABLE} VALUES (?, 'then')`);
      for (const id of OLDER_RELEASE_LEDGER) insert.run(id);

      const schema = loadBaseSchema('sqlite');
      await assert.rejects(
        ensureBaseSchema(createSqliteSchemaDriver(db), schema),
        (error: unknown) => {
          assert.ok(isNexusError(error));
          assert.equal(error.code, 'INTERNAL');
          assert.match(error.message, NO_UPGRADE_PATH);
          assert.match(error.message, RECREATE);
          assert.ok(error.message.includes('001_initial'), error.message);
          assert.ok(error.message.includes('and 9 more'), error.message);
          assert.ok(error.message.includes(schema.id), error.message);
          assert.deepEqual(error.details, { recorded: OLDER_RELEASE_LEDGER, expected: schema.id });
          return true;
        },
      );
      assert.deepEqual(tables(db), [SCHEMA_LEDGER_TABLE, 'users']);
      assert.deepEqual(ledger(db), OLDER_RELEASE_LEDGER);
    } finally {
      db.close();
    }
  });

  it('refuses a database created from an earlier version of the base schema', async () => {
    const db = openSqliteDatabase(':memory:');
    try {
      const driver = createSqliteSchemaDriver(db);
      const earlier: BaseSchema = {
        id: '000_base_v0_5_test',
        source: 'earlier.sql',
        sql: 'CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY);',
      };
      await ensureBaseSchema(driver, earlier);
      await assert.rejects(ensureBaseSchema(driver, loadBaseSchema('sqlite')), NO_UPGRADE_PATH);
      assert.deepEqual(ledger(db), [earlier.id]);
    } finally {
      db.close();
    }
  });

  it('names the schema when creating it fails, and records nothing', async () => {
    const db = openSqliteDatabase(':memory:');
    try {
      const driver = createSqliteSchemaDriver(db);
      const broken: BaseSchema = {
        id: 'base_test',
        source: 'broken.sql',
        sql: 'CREATE TABLE kept (id TEXT PRIMARY KEY); ALTER TABLE missing ADD COLUMN extra TEXT;',
      };
      await assert.rejects(ensureBaseSchema(driver, broken), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, NAMES_FAILED_SCHEMA);
        assert.ok(error.cause instanceof Error, 'the driver error is kept as the cause');
        return true;
      });
      // SQLite creates the schema in one transaction: nothing is left behind.
      assert.deepEqual(tables(db), [SCHEMA_LEDGER_TABLE]);
      assert.deepEqual(ledger(db), []);
    } finally {
      db.close();
    }
  });

  it('refuses a ledger holding this generation plus anything else', async () => {
    const db = openSqliteDatabase(':memory:');
    try {
      const schema = loadBaseSchema('sqlite');
      const driver = createSqliteSchemaDriver(db);
      await ensureBaseSchema(driver, schema);
      db.prepare(`INSERT INTO ${SCHEMA_LEDGER_TABLE} VALUES ('001_initial', 'then')`).run();
      await assert.rejects(ensureBaseSchema(driver, schema), NO_UPGRADE_PATH);
      assert.deepEqual(ledger(db), [schema.id, '001_initial'].sort());
    } finally {
      db.close();
    }
  });

  it("refuses a ledger id stored as a BLOB, even with the generation's bytes", async () => {
    const db = openSqliteDatabase(':memory:');
    try {
      const schema = loadBaseSchema('sqlite');
      db.exec(
        `CREATE TABLE ${SCHEMA_LEDGER_TABLE} (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`,
      );
      db.prepare(`INSERT INTO ${SCHEMA_LEDGER_TABLE} VALUES (?, 'then')`).run(
        Buffer.from(schema.id, 'utf8'),
      );
      await assert.rejects(ensureBaseSchema(createSqliteSchemaDriver(db), schema), NO_UPGRADE_PATH);
    } finally {
      db.close();
    }
  });

  it('passes a NexusError from the driver through unchanged', async () => {
    const refusal = conflict('Another instance holds the lock');
    const driver: SchemaDriver = {
      async ensureLedger() {},
      async listRecorded() {
        return [];
      },
      async createBaseSchema() {
        throw refusal;
      },
    };
    await assert.rejects(ensureBaseSchema(driver, loadBaseSchema('sqlite')), (error) => {
      assert.equal(error, refusal);
      return true;
    });
  });
});

describe('base schema generation', () => {
  it('is the one id every backend records', () => {
    assert.match(BASE_SCHEMA_ID, /^000_base_v\d+_\d+$/);
    for (const dialect of ['sqlite', 'pg', 'mysql'] as const) {
      assert.equal(loadBaseSchema(dialect).id, BASE_SCHEMA_ID);
    }
    assert.equal(MONGO_BASE_SCHEMA.id, BASE_SCHEMA_ID);
  });
});
