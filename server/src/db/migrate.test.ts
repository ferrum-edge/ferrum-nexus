/**
 * The schema rules every adapter applies at `migrate()` (`migrate.ts`;
 * docs/operations.md, "Schema and upgrades"): create the frozen baseline in an
 * empty database, apply forward migrations in order with their checksums, and
 * refuse — changing nothing — a database created before v0.6.0, one a newer
 * release upgraded, and one whose recorded checksums differ. Checked on a real
 * SQLite driver; `test/schema-upgrade.test.ts` checks the same on every
 * backend from a v0.6.0 database.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { conflict, isNexusError } from '../lib/errors.js';
import { createSqliteSchemaDriver, openSqliteDatabase } from './adapters/sqlite/index.js';
import {
  ensureSchema,
  loadMigrations,
  sqlMigration,
  validateMigrations,
  type SchemaDriver,
  type SqlMigration,
} from './migrate.js';
import { BASE_SCHEMA_ID, loadBaseSchema, SCHEMA_LEDGER_TABLE, type BaseSchema } from './schema.js';

const OLDER = /no upgrade path from releases before v0\.6\.0/;
const RECREATE = /new, empty database/;
const NEWER = /a newer release upgraded it\. Downgrades are not supported/;
const MISMATCH = /A released migration never changes/;
const OUT_OF_ORDER = /Migrations apply only in id order/;
const NAMES_FAILED_SCHEMA = /^Creating the base schema base_test failed: .*no such table: missing/;
const NAMES_FAILED_MIGRATION = /^Schema migration 017_broken failed: .*no such table: missing/;
const MALFORMED = /Malformed schema migration id/;
const ORDER = /repeated or out of order/;

/** What a v0.5.2 database records: the released pre-0.6 migration chain. */
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

type Db = ReturnType<typeof openSqliteDatabase>;

const WIDGETS = sqlMigration(
  '016_widgets',
  '016_widgets.sql',
  'CREATE TABLE widgets (id TEXT PRIMARY KEY);',
);
const WIDGET_NAME = sqlMigration(
  '017_widget_name',
  '017_widget_name.sql',
  "ALTER TABLE widgets ADD COLUMN name TEXT NOT NULL DEFAULT '';",
);

function tables(db: Db): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => (row as { name: string }).name);
}

function ledger(db: Db): { id: string; checksum: string | null }[] {
  return db.prepare(`SELECT id, checksum FROM ${SCHEMA_LEDGER_TABLE} ORDER BY id`).all() as {
    id: string;
    checksum: string | null;
  }[];
}

function ledgerColumns(db: Db): string[] {
  return db
    .prepare(`PRAGMA table_info(${SCHEMA_LEDGER_TABLE})`)
    .all()
    .map((row) => (row as { name: string }).name);
}

/** A database as v0.6.0 left it: the base schema and its two-column ledger. */
function v060Database(): Db {
  const db = openSqliteDatabase(':memory:');
  db.exec(loadBaseSchema('sqlite').sql);
  db.exec(`CREATE TABLE ${SCHEMA_LEDGER_TABLE} (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  db.prepare(`INSERT INTO ${SCHEMA_LEDGER_TABLE} VALUES (?, 'then')`).run(BASE_SCHEMA_ID);
  return db;
}

describe('ensureSchema', () => {
  it('creates the baseline in an empty database, then leaves it alone', async () => {
    const db = openSqliteDatabase(':memory:');
    try {
      const schema = loadBaseSchema('sqlite');
      const driver = createSqliteSchemaDriver(db);
      assert.deepEqual(await ensureSchema(driver, schema, []), { created: true, applied: [] });
      assert.deepEqual(ledger(db), [{ id: BASE_SCHEMA_ID, checksum: null }]);
      assert.ok(tables(db).includes('access_gateway_jobs'));

      const before = tables(db);
      assert.deepEqual(await ensureSchema(driver, schema, []), { created: false, applied: [] });
      assert.deepEqual(tables(db), before);
      assert.deepEqual(ledger(db), [{ id: BASE_SCHEMA_ID, checksum: null }]);
    } finally {
      db.close();
    }
  });

  it('creates the baseline and every migration in a new database', async () => {
    const db = openSqliteDatabase(':memory:');
    try {
      const result = await ensureSchema(createSqliteSchemaDriver(db), loadBaseSchema('sqlite'), [
        WIDGETS,
        WIDGET_NAME,
      ]);
      assert.deepEqual(result, { created: true, applied: [WIDGETS.id, WIDGET_NAME.id] });
      assert.deepEqual(ledger(db), [
        { id: BASE_SCHEMA_ID, checksum: null },
        { id: WIDGETS.id, checksum: WIDGETS.checksum },
        { id: WIDGET_NAME.id, checksum: WIDGET_NAME.checksum },
      ]);
      db.prepare("INSERT INTO widgets (id) VALUES ('w')").run();
      assert.deepEqual(db.prepare('SELECT id, name FROM widgets').get(), { id: 'w', name: '' });
    } finally {
      db.close();
    }
  });

  it('opens a v0.6.0 database unchanged, then migrates it in order, once', async () => {
    const db = v060Database();
    try {
      const driver = createSqliteSchemaDriver(db);
      const schema = loadBaseSchema('sqlite');
      // No pending migration: nothing is written, not even the checksum column.
      assert.deepEqual(await ensureSchema(driver, schema, []), { created: false, applied: [] });
      assert.deepEqual(ledgerColumns(db), ['id', 'applied_at']);

      assert.deepEqual(await ensureSchema(driver, schema, [WIDGETS]), {
        created: false,
        applied: [WIDGETS.id],
      });
      assert.deepEqual(ledgerColumns(db), ['id', 'applied_at', 'checksum']);
      assert.deepEqual(await ensureSchema(driver, schema, [WIDGETS, WIDGET_NAME]), {
        created: false,
        applied: [WIDGET_NAME.id],
      });
      assert.deepEqual(await ensureSchema(driver, schema, [WIDGETS, WIDGET_NAME]), {
        created: false,
        applied: [],
      });
      assert.deepEqual(ledger(db), [
        { id: BASE_SCHEMA_ID, checksum: null },
        { id: WIDGETS.id, checksum: WIDGETS.checksum },
        { id: WIDGET_NAME.id, checksum: WIDGET_NAME.checksum },
      ]);
      const applied = db
        .prepare(`SELECT applied_at FROM ${SCHEMA_LEDGER_TABLE} WHERE id = ?`)
        .get(WIDGETS.id) as { applied_at: string };
      assert.ok(!Number.isNaN(Date.parse(applied.applied_at)), applied.applied_at);
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
        ensureSchema(createSqliteSchemaDriver(db), schema, [WIDGETS]),
        (error: unknown) => {
          assert.ok(isNexusError(error));
          assert.equal(error.code, 'INTERNAL');
          assert.match(error.message, OLDER);
          assert.match(error.message, RECREATE);
          assert.ok(error.message.includes('001_initial'), error.message);
          assert.ok(error.message.includes('and 9 more'), error.message);
          assert.ok(error.message.includes(schema.id), error.message);
          assert.deepEqual(error.details, { recorded: OLDER_RELEASE_LEDGER, expected: schema.id });
          return true;
        },
      );
      assert.deepEqual(tables(db), [SCHEMA_LEDGER_TABLE, 'users']);
      assert.deepEqual(ledgerColumns(db), ['id', 'applied_at']);
    } finally {
      db.close();
    }
  });

  it('refuses a database created from a pre-release base schema generation', async () => {
    const db = openSqliteDatabase(':memory:');
    try {
      const driver = createSqliteSchemaDriver(db);
      const earlier: BaseSchema = {
        id: '000_base_v0_5_test',
        source: 'earlier.sql',
        sql: 'CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY);',
      };
      await ensureSchema(driver, earlier, []);
      await assert.rejects(ensureSchema(driver, loadBaseSchema('sqlite'), []), OLDER);
      assert.deepEqual(ledger(db), [{ id: earlier.id, checksum: null }]);
    } finally {
      db.close();
    }
  });

  it('refuses a database a newer release migrated (downgrade), changing nothing', async () => {
    const db = v060Database();
    try {
      const driver = createSqliteSchemaDriver(db);
      const schema = loadBaseSchema('sqlite');
      await ensureSchema(driver, schema, [WIDGETS, WIDGET_NAME]);
      const before = ledger(db);
      await assert.rejects(ensureSchema(driver, schema, [WIDGETS]), (error: unknown) => {
        assert.ok(isNexusError(error));
        assert.match(error.message, NEWER);
        assert.ok(error.message.includes(WIDGET_NAME.id), error.message);
        assert.deepEqual(error.details, { unknown: [WIDGET_NAME.id], known: [WIDGETS.id] });
        return true;
      });
      // The shipped build knows no migration at all: it refuses as well.
      await assert.rejects(ensureSchema(driver, schema, []), NEWER);
      assert.deepEqual(ledger(db), before);
    } finally {
      db.close();
    }
  });

  it('refuses a recorded migration whose checksum changed', async () => {
    const db = v060Database();
    try {
      const driver = createSqliteSchemaDriver(db);
      const schema = loadBaseSchema('sqlite');
      await ensureSchema(driver, schema, [WIDGETS]);
      const edited = sqlMigration(
        WIDGETS.id,
        WIDGETS.source,
        'CREATE TABLE widgets (id TEXT PRIMARY KEY, extra TEXT);',
      );
      await assert.rejects(ensureSchema(driver, schema, [edited, WIDGET_NAME]), (error) => {
        assert.ok(isNexusError(error));
        assert.match(error.message, MISMATCH);
        assert.deepEqual(error.details, {
          id: WIDGETS.id,
          recorded: WIDGETS.checksum,
          expected: edited.checksum,
        });
        return true;
      });
      assert.deepEqual(
        ledger(db).map((entry) => entry.id),
        [BASE_SCHEMA_ID, WIDGETS.id],
        'nothing after the refusal was applied',
      );
    } finally {
      db.close();
    }
  });

  it('refuses a ledger that skips a migration', async () => {
    const db = v060Database();
    try {
      const driver = createSqliteSchemaDriver(db);
      const schema = loadBaseSchema('sqlite');
      const earlierWidgets = sqlMigration('015_widgets', '015_widgets.sql', WIDGETS.sql);
      await ensureSchema(driver, schema, [WIDGETS]);
      // A build that inserted a migration before one already applied.
      const inserted = sqlMigration('016_aaa_inserted', '016_aaa_inserted.sql', 'SELECT 1;');
      await assert.rejects(ensureSchema(driver, schema, [inserted, WIDGETS]), OUT_OF_ORDER);
      await assert.rejects(ensureSchema(driver, schema, [earlierWidgets]), NEWER);
    } finally {
      db.close();
    }
  });

  it('names a failed migration, rolls it back, and keeps the earlier ones', async () => {
    const db = v060Database();
    try {
      const driver = createSqliteSchemaDriver(db);
      const broken = sqlMigration(
        '017_broken',
        '017_broken.sql',
        'CREATE TABLE kept (id TEXT PRIMARY KEY); ALTER TABLE missing ADD COLUMN extra TEXT;',
      );
      await assert.rejects(
        ensureSchema(driver, loadBaseSchema('sqlite'), [WIDGETS, broken]),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, NAMES_FAILED_MIGRATION);
          assert.ok(error.cause instanceof Error, 'the driver error is kept as the cause');
          return true;
        },
      );
      assert.deepEqual(
        ledger(db).map((entry) => entry.id),
        [BASE_SCHEMA_ID, WIDGETS.id],
      );
      assert.equal(tables(db).includes('kept'), false, 'the failed migration rolled back');
    } finally {
      db.close();
    }
  });

  it('names the base schema when creating it fails, and records nothing', async () => {
    const db = openSqliteDatabase(':memory:');
    try {
      const driver = createSqliteSchemaDriver(db);
      const broken: BaseSchema = {
        id: 'base_test',
        source: 'broken.sql',
        sql: 'CREATE TABLE kept (id TEXT PRIMARY KEY); ALTER TABLE missing ADD COLUMN extra TEXT;',
      };
      await assert.rejects(ensureSchema(driver, broken, []), (error: unknown) => {
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

  it("refuses a ledger id stored as a BLOB, even with the baseline's bytes", async () => {
    const db = openSqliteDatabase(':memory:');
    try {
      db.exec(
        `CREATE TABLE ${SCHEMA_LEDGER_TABLE} (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`,
      );
      db.prepare(`INSERT INTO ${SCHEMA_LEDGER_TABLE} VALUES (?, 'then')`).run(
        Buffer.from(BASE_SCHEMA_ID, 'utf8'),
      );
      await assert.rejects(
        ensureSchema(createSqliteSchemaDriver(db), loadBaseSchema('sqlite'), []),
        OLDER,
      );
    } finally {
      db.close();
    }
  });

  it('passes a NexusError from the driver through unchanged', async () => {
    const refusal = conflict('Another instance holds the lock');
    const driver: SchemaDriver<SqlMigration> = {
      async ensureLedger() {},
      async listRecorded() {
        return [{ id: BASE_SCHEMA_ID, checksum: null }];
      },
      async createBaseSchema() {},
      async prepareLedger() {},
      async applyMigration() {
        throw refusal;
      },
    };
    await assert.rejects(ensureSchema(driver, loadBaseSchema('sqlite'), [WIDGETS]), (error) => {
      assert.equal(error, refusal);
      return true;
    });
  });
});

describe('migration lists', () => {
  it('refuses malformed, repeated or out-of-order ids before touching the database', () => {
    assert.throws(() => validateMigrations([sqlMigration('16_short', 'x', '')], BASE_SCHEMA_ID));
    assert.throws(
      () => validateMigrations([sqlMigration('016-dash', 'x', '')], BASE_SCHEMA_ID),
      MALFORMED,
    );
    assert.throws(() => validateMigrations([WIDGETS, WIDGETS], BASE_SCHEMA_ID), ORDER);
    assert.throws(() => validateMigrations([WIDGET_NAME, WIDGETS], BASE_SCHEMA_ID), ORDER);
    assert.throws(
      () => validateMigrations([sqlMigration('000_a', 'x', '')], BASE_SCHEMA_ID),
      ORDER,
    );
    validateMigrations([WIDGETS, WIDGET_NAME], BASE_SCHEMA_ID);
  });

  it('loads each dialect from its own files, with checksums, in id order', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-migrations-'));
    try {
      writeFileSync(join(dir, '017_b.sql'), 'SELECT 2;');
      writeFileSync(join(dir, '016_a.sql'), 'SELECT 1;\r\n');
      writeFileSync(join(dir, '016_a.pg.sql'), 'SELECT 1;');
      writeFileSync(join(dir, '016_a.mysql.sql'), 'SELECT 1;');
      writeFileSync(join(dir, 'notes.txt'), 'ignored');
      const sqlite = loadMigrations('sqlite', dir);
      assert.deepEqual(
        sqlite.map((migration) => [migration.id, migration.source]),
        [
          ['016_a', '016_a.sql'],
          ['017_b', '017_b.sql'],
        ],
      );
      // CRLF is normalised, so a checkout's line endings never change a checksum.
      assert.equal(sqlite[0]?.checksum, sqlMigration('016_a', 'x', 'SELECT 1;\n').checksum);
      assert.deepEqual(
        loadMigrations('pg', dir).map((migration) => migration.id),
        ['016_a'],
      );
      assert.deepEqual(
        loadMigrations('mysql', dir).map((migration) => migration.id),
        ['016_a'],
      );
      assert.deepEqual(loadMigrations('sqlite', join(dir, 'absent')), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
