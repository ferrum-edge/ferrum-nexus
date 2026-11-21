/**
 * The base schema rule: create it in an empty database, accept a database
 * already at it, refuse any other (docs/operations.md, "Schema and upgrades
 * before 1.0"). Checked on a real SQLite driver; the smoke suite checks the
 * refusal on every backend.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { conflict, isNexusError } from '../lib/errors.js';
import { createSqliteSchemaDriver, openSqliteDatabase } from './adapters/sqlite/index.js';
import { mongoBaseSchema } from './adapters/mongodb/index.js';
import {
  canonicalStatement,
  ensureBaseSchema,
  loadBaseSchema,
  SchemaBusyError,
  schemaClaim,
  schemaFingerprint,
  SCHEMA_LEDGER_TABLE,
  type BaseSchema,
  type SchemaDriver,
} from './schema.js';

const BASE_ID = /^base_[0-9a-f]{16}$/;
const NO_UPGRADE_PATH = /no upgrade path before 1\.0/;
const RECREATE = /new, empty database/;
const NO_RECORD = /already holds Ferrum Nexus tables \(users\) but no record/;
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
        id: schemaFingerprint(['CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY)']),
        source: 'earlier.sql',
        sql: 'CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY);',
        tables: ['users'],
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
        tables: ['kept'],
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

  it('refuses a ledger holding this schema plus anything else', async () => {
    const db = openSqliteDatabase(':memory:');
    try {
      const schema = loadBaseSchema('sqlite');
      const driver = createSqliteSchemaDriver(db);
      await ensureBaseSchema(driver, schema);
      db.prepare(`INSERT INTO ${SCHEMA_LEDGER_TABLE} VALUES ('001_initial', 'then')`).run();
      await assert.rejects(ensureBaseSchema(driver, schema), NO_UPGRADE_PATH);
      assert.deepEqual(ledger(db), ['001_initial', schema.id].sort());
    } finally {
      db.close();
    }
  });

  it("refuses the schema's tables with no record, creating nothing", async () => {
    const db = openSqliteDatabase(':memory:');
    try {
      // What an earlier version's first start leaves if it stops before
      // recording anything (or tables made by hand).
      db.exec('CREATE TABLE users (id TEXT PRIMARY KEY)');
      const schema = loadBaseSchema('sqlite');
      await assert.rejects(ensureBaseSchema(createSqliteSchemaDriver(db), schema), (error) => {
        assert.ok(isNexusError(error));
        assert.match(error.message, NO_RECORD);
        assert.match(error.message, NO_UPGRADE_PATH);
        return true;
      });
      assert.deepEqual(tables(db), [SCHEMA_LEDGER_TABLE, 'users']);
      assert.deepEqual(ledger(db), []);
    } finally {
      db.close();
    }
  });

  it("finishes this build's own interrupted creation, and refuses another build's", async () => {
    const schema = loadBaseSchema('sqlite');
    for (const [claim, finishes] of [
      [schemaClaim(schema), true],
      [`creating:base_0000000000000000`, false],
    ] as const) {
      const db = openSqliteDatabase(':memory:');
      try {
        const driver = createSqliteSchemaDriver(db);
        await driver.ensureLedger();
        db.prepare(`INSERT INTO ${SCHEMA_LEDGER_TABLE} VALUES (?, 'now')`).run(claim);
        if (finishes) {
          assert.deepEqual(await ensureBaseSchema(driver, schema), { created: true });
          assert.ok(tables(db).includes('access_gateway_jobs'));
        } else {
          await assert.rejects(ensureBaseSchema(driver, schema), NO_UPGRADE_PATH);
          assert.deepEqual(ledger(db), [claim]);
        }
      } finally {
        db.close();
      }
    }
  });

  it('accepts the record a peer wrote while this start lost the creation race', async () => {
    const schema = loadBaseSchema('sqlite');
    for (const busy of [false, true]) {
      const recorded: string[] = [];
      let reads = 0;
      const driver: SchemaDriver = {
        async ensureLedger() {},
        async listRecorded() {
          reads += 1;
          // The peer finishes on the third read after this start failed.
          if (busy && reads >= 4) return [schema.id];
          return [...recorded];
        },
        async existingTables() {
          return [];
        },
        async createBaseSchema() {
          if (busy) throw new SchemaBusyError();
          // The peer committed first, and this start's own insert collided.
          recorded.push(schema.id);
          throw new Error('duplicate key');
        },
      };
      assert.deepEqual(await ensureBaseSchema(driver, schema, { pollMs: 1 }), {
        created: false,
      });
    }
  });

  it('refuses when a different build recorded its schema at the same moment', async () => {
    const schema = loadBaseSchema('sqlite');
    const recorded: string[] = [];
    const driver: SchemaDriver = {
      async ensureLedger() {},
      async listRecorded() {
        return [...recorded];
      },
      async existingTables() {
        return [];
      },
      async createBaseSchema(base) {
        recorded.push('base_0000000000000000', base.id);
      },
    };
    await assert.rejects(ensureBaseSchema(driver, schema), NO_UPGRADE_PATH);
  });

  it('passes a NexusError from the driver through unchanged', async () => {
    const refusal = conflict('Another instance holds the lock');
    const driver: SchemaDriver = {
      async ensureLedger() {},
      async listRecorded() {
        return [];
      },
      async existingTables() {
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

describe('base schema fingerprint', () => {
  it('is stable for a backend, distinct across backends, and shaped base_<hex>', () => {
    const ids = (['sqlite', 'pg', 'mysql'] as const).map((dialect) => {
      const { id } = loadBaseSchema(dialect);
      assert.match(id, BASE_ID);
      assert.equal(loadBaseSchema(dialect).id, id);
      return id;
    });
    const mongo = mongoBaseSchema().id;
    assert.match(mongo, BASE_ID);
    assert.equal(mongoBaseSchema().id, mongo);
    assert.equal(new Set([...ids, mongo]).size, 4);
  });

  it('changes the MongoDB fingerprint with its indexes', () => {
    assert.notEqual(mongoBaseSchema([]).id, mongoBaseSchema().id);
  });

  it('ignores whitespace outside literals, but not a changed statement or literal', () => {
    const fingerprint = (...statements: string[]): string =>
      schemaFingerprint(statements.map(canonicalStatement));
    const a = fingerprint("CREATE TABLE t (a TEXT DEFAULT 'two  words')");
    assert.equal(fingerprint("  CREATE TABLE t\n  (a   TEXT\tDEFAULT 'two  words')  "), a);
    assert.notEqual(fingerprint("CREATE TABLE t (a TEXT DEFAULT 'two words')"), a);
    assert.notEqual(fingerprint("CREATE TABLE t (a TEXT NOT NULL DEFAULT 'two  words')"), a);
    assert.notEqual(
      fingerprint("CREATE TABLE t (a TEXT DEFAULT 'two  words')", 'CREATE TABLE u (b TEXT)'),
      a,
    );
  });
});
