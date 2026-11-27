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
import { mongoMigration, type MongoMigrationStep } from './adapters/mongodb/index.js';
import { createSqliteSchemaDriver, openSqliteDatabase } from './adapters/sqlite/index.js';
import {
  ensureSchema,
  loadMigrations,
  refuseTransactionControl,
  schemaBusyError,
  sqlMigration,
  topLevelStatements,
  validateMigrations,
  verifyShippedMigrations,
  type LedgerEntry,
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
const INTERRUPTED = /That upgrade was interrupted part-way \(017_widget_name in progress\)/;
const NEVER_RECORDS = /holds migrations in progress/;
const INCOMPLETE = /migrations do not match the migrations it ships/;
const PENDING =
  /needs schema migrations this release ships \(016_widgets\).*run the migrate command once/s;
const RESUME =
  /interrupted part-way \(017_widget_name in progress\).*run the migrate command again/s;
const BUSY = /holds the test schema migration lock/;
const IN_TRANSACTION = /cannot run inside its migration transaction/;
const NOT_PLAIN_KEY = /not a plain object of field directions/;
const NOT_COVERED = /options the checksum cannot cover/;
const NOT_EMPTY = /not a new, empty database/;
const MODIFIED = /The image or installation is modified/;
const INJECTED = /injected interruption/;
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
      assert.deepEqual(ledgerColumns(db), ['id', 'applied_at', 'checksum', 'state']);
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
        assert.deepEqual(error.details, {
          unknown: [WIDGET_NAME.id],
          inProgress: [],
          known: [WIDGETS.id],
        });
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
      async createBaseSchema() {
        return true;
      },
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

/**
 * A backend that cannot commit a migration with its ledger row (the shape of
 * MySQL and MongoDB), in memory: it records an in-progress marker first and
 * can be told to stop part-way through a migration.
 */
function nonTransactionalDriver(): SchemaDriver<SqlMigration> & {
  ledger: Map<string, LedgerEntry>;
  began: string[];
  ran: string[];
  failNext: boolean;
  lockHeldByOther: boolean;
  locks: number;
  /** Runs as the lock is taken: what a peer did between the first read and the lock. */
  beforeLock: () => void;
  /** Runs after each migration: what a peer did between this run's transactions. */
  afterApply: () => void;
} {
  const ledger = new Map<string, LedgerEntry>();
  const driver = {
    ledger,
    began: [] as string[],
    ran: [] as string[],
    failNext: false,
    lockHeldByOther: false,
    locks: 0,
    beforeLock: (): void => undefined,
    afterApply: (): void => undefined,
    async acquireLock(): Promise<() => Promise<void>> {
      if (driver.lockHeldByOther) throw schemaBusyError('test');
      driver.beforeLock();
      driver.locks += 1;
      return async () => undefined;
    },
    async lockHeld(): Promise<boolean> {
      return driver.lockHeldByOther;
    },
    async ensureLedger(): Promise<void> {},
    async listRecorded(): Promise<LedgerEntry[]> {
      return [...ledger.values()].map((entry) => ({ ...entry }));
    },
    async createBaseSchema(schema: BaseSchema): Promise<boolean> {
      ledger.set(schema.id, { id: schema.id, checksum: null });
      return true;
    },
    async prepareLedger(): Promise<void> {},
    async beginMigration(migration: SqlMigration): Promise<void> {
      driver.began.push(migration.id);
      ledger.set(migration.id, {
        id: migration.id,
        checksum: migration.checksum,
        inProgress: true,
      });
    },
    async applyMigration(migration: SqlMigration): Promise<void> {
      driver.ran.push(migration.id);
      if (driver.failNext) {
        driver.failNext = false;
        throw new Error('injected interruption');
      }
      const entry = ledger.get(migration.id);
      assert.equal(entry?.inProgress, true, 'applied only after it was begun');
      ledger.set(migration.id, { id: migration.id, checksum: migration.checksum });
      driver.afterApply();
    },
  };
  return driver;
}

describe('migrations on a backend without transactional DDL', () => {
  it('records an interrupted migration in progress, refuses builds without it, then resumes', async () => {
    const driver = nonTransactionalDriver();
    const schema = loadBaseSchema('sqlite');
    await ensureSchema(driver, schema, [WIDGETS]);
    driver.failNext = true;
    await assert.rejects(ensureSchema(driver, schema, [WIDGETS, WIDGET_NAME]), INJECTED);
    assert.deepEqual(driver.ledger.get(WIDGET_NAME.id), {
      id: WIDGET_NAME.id,
      checksum: WIDGET_NAME.checksum,
      inProgress: true,
    });

    // The release before it does not know the id: it refuses, naming the interruption.
    await assert.rejects(ensureSchema(driver, schema, [WIDGETS]), (error: unknown) => {
      assert.ok(isNexusError(error));
      assert.match(error.message, NEWER);
      assert.match(error.message, INTERRUPTED);
      assert.deepEqual(error.details, {
        unknown: [WIDGET_NAME.id],
        inProgress: [WIDGET_NAME.id],
        known: [WIDGETS.id],
      });
      return true;
    });
    // A build whose copy of the migration differs refuses too.
    const edited = sqlMigration(WIDGET_NAME.id, WIDGET_NAME.source, 'SELECT 2;');
    await assert.rejects(ensureSchema(driver, schema, [WIDGETS, edited]), MISMATCH);

    // The same build resumes it without recording it again, then marks it applied.
    driver.began.length = 0;
    driver.ran.length = 0;
    assert.deepEqual(await ensureSchema(driver, schema, [WIDGETS, WIDGET_NAME]), {
      created: false,
      applied: [WIDGET_NAME.id],
    });
    assert.deepEqual(driver.began, []);
    assert.deepEqual(driver.ran, [WIDGET_NAME.id]);
    assert.deepEqual(driver.ledger.get(WIDGET_NAME.id), {
      id: WIDGET_NAME.id,
      checksum: WIDGET_NAME.checksum,
    });
  });

  it('refuses a migration in progress that is not the next one', async () => {
    const driver = nonTransactionalDriver();
    const schema = loadBaseSchema('sqlite');
    await ensureSchema(driver, schema, []);
    driver.ledger.set(WIDGET_NAME.id, {
      id: WIDGET_NAME.id,
      checksum: WIDGET_NAME.checksum,
      inProgress: true,
    });
    await assert.rejects(ensureSchema(driver, schema, [WIDGETS, WIDGET_NAME]), OUT_OF_ORDER);
  });

  it('refuses an in-progress marker on a backend that never records one', async () => {
    const db = v060Database();
    try {
      const driver = createSqliteSchemaDriver(db);
      const schema = loadBaseSchema('sqlite');
      await ensureSchema(driver, schema, [WIDGETS]);
      db.prepare(`UPDATE ${SCHEMA_LEDGER_TABLE} SET state = 'in_progress' WHERE id = ?`).run(
        WIDGETS.id,
      );
      await assert.rejects(ensureSchema(driver, schema, [WIDGETS]), NEVER_RECORDS);
    } finally {
      db.close();
    }
  });
});

describe('shipped migrations', () => {
  const manifest = [
    {
      id: WIDGETS.id,
      sha256: { sqlite: WIDGETS.checksum, pg: 'x', mysql: 'x', mongodb: 'x' },
    },
  ];

  it('accept exactly the packaged files the manifest lists', () => {
    verifyShippedMigrations([WIDGETS], 'sqlite', manifest);
    verifyShippedMigrations([], 'sqlite', []);
  });

  it('refuse a package missing a migration file, or carrying an extra one', () => {
    assert.throws(() => verifyShippedMigrations([], 'sqlite', manifest), INCOMPLETE);
    assert.throws(
      () => verifyShippedMigrations([WIDGETS, WIDGET_NAME], 'sqlite', manifest),
      INCOMPLETE,
    );
  });

  it('refuse a packaged file whose checksum differs from the manifest', () => {
    assert.throws(() => verifyShippedMigrations([WIDGETS], 'pg', manifest), MODIFIED);
  });
});

describe('server startup', () => {
  it('creates a completely empty database, baseline and migrations, in one go', async () => {
    const db = openSqliteDatabase(':memory:');
    try {
      const result = await ensureSchema(
        createSqliteSchemaDriver(db),
        loadBaseSchema('sqlite'),
        [WIDGETS, WIDGET_NAME],
        { mode: 'startup' },
      );
      assert.deepEqual(result, { created: true, applied: [WIDGETS.id, WIDGET_NAME.id] });
      assert.deepEqual(
        ledger(db).map((entry) => entry.id),
        [BASE_SCHEMA_ID, WIDGETS.id, WIDGET_NAME.id],
      );
    } finally {
      db.close();
    }
  });

  it('refuses an existing database with migrations pending, changing nothing', async () => {
    const db = v060Database();
    try {
      await assert.rejects(
        ensureSchema(createSqliteSchemaDriver(db), loadBaseSchema('sqlite'), [WIDGETS], {
          mode: 'startup',
        }),
        (error: unknown) => {
          assert.ok(isNexusError(error));
          assert.match(error.message, PENDING);
          assert.deepEqual(error.details, {
            pending: [WIDGETS.id],
            inProgress: [],
            lockHeld: false,
          });
          return true;
        },
      );
      assert.deepEqual(ledgerColumns(db), ['id', 'applied_at']);
      assert.equal(tables(db).includes('widgets'), false);
    } finally {
      db.close();
    }
  });

  it('refuses an interrupted upgrade, telling the operator to run migrate again', async () => {
    const driver = nonTransactionalDriver();
    const schema = loadBaseSchema('sqlite');
    await ensureSchema(driver, schema, [WIDGETS]);
    driver.failNext = true;
    await assert.rejects(ensureSchema(driver, schema, [WIDGETS, WIDGET_NAME]), INJECTED);
    await assert.rejects(
      ensureSchema(driver, schema, [WIDGETS, WIDGET_NAME], { mode: 'startup' }),
      (error: unknown) => isNexusError(error) && RESUME.test(error.message),
    );
  });
});

describe('the migration lock', () => {
  it('is taken only when there is work, and a held lock refuses a second migrator', async () => {
    const driver = nonTransactionalDriver();
    const schema = loadBaseSchema('sqlite');
    await ensureSchema(driver, schema, [WIDGETS]);
    assert.equal(driver.locks, 1);
    // Nothing pending: the ledger is read, no lock is taken, nothing is written.
    await ensureSchema(driver, schema, [WIDGETS]);
    assert.equal(driver.locks, 1);

    driver.lockHeldByOther = true;
    await assert.rejects(ensureSchema(driver, schema, [WIDGETS, WIDGET_NAME]), (error) => {
      assert.ok(isNexusError(error));
      assert.equal(error.code, 'CONFLICT');
      assert.match(error.message, BUSY);
      return true;
    });
    assert.equal(driver.ledger.has(WIDGET_NAME.id), false, 'nothing was recorded');
  });
});

describe('migration statements', () => {
  const migration = (sql: string): SqlMigration => sqlMigration('016_probe', 'probe.sql', sql);

  it('refuse transaction control that would end the migration transaction', () => {
    for (const sql of [
      'CREATE TABLE a (id TEXT); COMMIT;',
      'BEGIN; CREATE TABLE a (id TEXT);',
      'SAVEPOINT s; CREATE TABLE a (id TEXT);',
      'start  transaction; CREATE TABLE a (id TEXT);',
      'ROLLBACK',
      'VACUUM;',
    ]) {
      assert.throws(() => refuseTransactionControl(migration(sql), 'sqlite'), IN_TRANSACTION, sql);
      assert.throws(() => refuseTransactionControl(migration(sql), 'pg'), IN_TRANSACTION, sql);
    }
    assert.throws(
      () => refuseTransactionControl(migration('CREATE INDEX CONCURRENTLY ix ON a (id);'), 'pg'),
      IN_TRANSACTION,
    );
  });

  it('accept the same words inside quotes, comments and statement bodies', () => {
    const pg = migration(`
      -- COMMIT; in a comment
      /* BEGIN; in a block comment */
      CREATE TABLE a (note TEXT DEFAULT 'COMMIT; inside a string');
      DO $$
      BEGIN
        UPDATE a SET note = 'x';
      END
      $$;
      CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; END;
    `);
    refuseTransactionControl(pg, 'pg');
    assert.equal(topLevelStatements(pg.sql, 'pg').length, 3);
    const sqlite = migration(`
      CREATE TABLE a (id TEXT, n INT);
      CREATE TRIGGER t AFTER INSERT ON a BEGIN
        UPDATE a SET n = CASE WHEN n IS NULL THEN 0 ELSE n END;
      END;
    `);
    refuseTransactionControl(sqlite, 'sqlite');
    assert.equal(topLevelStatements(sqlite.sql, 'sqlite').length, 2);
  });
});

describe('MongoDB step checksums', () => {
  const step = (key: Record<string, 1 | -1>): MongoMigrationStep => ({
    id: '016_probe',
    indexes: [{ collection: 'users', name: 'ix_probe', key }],
  });

  it('change with every part of an index, key fields and their order included', () => {
    const base = mongoMigration(step({ a: 1, b: 1 })).checksum;
    assert.notEqual(mongoMigration(step({ a: 1, c: 1 })).checksum, base);
    assert.notEqual(mongoMigration(step({ b: 1, a: 1 })).checksum, base);
    assert.notEqual(mongoMigration(step({ a: 1, b: -1 })).checksum, base);
    assert.equal(mongoMigration(step({ a: 1, b: 1 })).checksum, base);
  });

  it('refuse an index key the checksum could not see', () => {
    const mapped: MongoMigrationStep = {
      id: '016_probe',
      indexes: [{ collection: 'users', name: 'ix_probe', key: new Map([['a', 1]]) }],
    };
    assert.throws(() => mongoMigration(mapped), NOT_PLAIN_KEY);
  });
});

describe('runner edge cases', () => {
  it('lets startup apply migrations only to a database it created itself', async () => {
    const driver = nonTransactionalDriver();
    const schema = loadBaseSchema('sqlite');
    // Empty at the first read; a peer records the baseline before the lock is taken.
    driver.beforeLock = () => driver.ledger.set(schema.id, { id: schema.id, checksum: null });
    await assert.rejects(
      ensureSchema(driver, schema, [WIDGETS], { mode: 'startup' }),
      (error: unknown) => isNexusError(error) && PENDING.test(error.message),
    );
    assert.equal(driver.ledger.has(WIDGETS.id), false, 'startup applied nothing');
  });

  it('refuses success when a newer migrator recorded more meanwhile', async () => {
    const driver = nonTransactionalDriver();
    const schema = loadBaseSchema('sqlite');
    await ensureSchema(driver, schema, []);
    driver.afterApply = () => driver.ledger.set('018_newer', { id: '018_newer', checksum: 'peer' });
    await assert.rejects(ensureSchema(driver, schema, [WIDGETS]), NEWER);
  });

  it('initialises from an empty ledger v0.6.0 left behind', async () => {
    const db = openSqliteDatabase(':memory:');
    try {
      db.exec(
        `CREATE TABLE ${SCHEMA_LEDGER_TABLE} (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`,
      );
      const result = await ensureSchema(
        createSqliteSchemaDriver(db),
        loadBaseSchema('sqlite'),
        [WIDGETS],
        { mode: 'startup' },
      );
      assert.deepEqual(result, { created: true, applied: [WIDGETS.id] });
      assert.deepEqual(ledgerColumns(db), ['id', 'applied_at', 'checksum', 'state']);
      assert.deepEqual(
        ledger(db).map((entry) => entry.id),
        [BASE_SCHEMA_ID, WIDGETS.id],
      );
    } finally {
      db.close();
    }
  });

  it('refuses an empty ledger beside tables the schema would create', async () => {
    const db = openSqliteDatabase(':memory:');
    try {
      db.exec(`
        CREATE TABLE ${SCHEMA_LEDGER_TABLE} (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
        CREATE TABLE users (id TEXT PRIMARY KEY);
      `);
      await assert.rejects(
        ensureSchema(createSqliteSchemaDriver(db), loadBaseSchema('sqlite'), [WIDGETS]),
        (error: unknown) => isNexusError(error) && NOT_EMPTY.test(error.message),
      );
      assert.deepEqual(tables(db), [SCHEMA_LEDGER_TABLE, 'users']);
    } finally {
      db.close();
    }
  });

  it('refuses at once, never waiting, while another SQLite connection writes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-sqlite-lock-'));
    const path = join(dir, 'nexus.sqlite');
    const db = openSqliteDatabase(path);
    const other = openSqliteDatabase(path);
    try {
      const driver = createSqliteSchemaDriver(db);
      const schema = loadBaseSchema('sqlite');
      await ensureSchema(driver, schema, []);
      other.exec('BEGIN IMMEDIATE');
      const started = Date.now();
      await assert.rejects(ensureSchema(driver, schema, [WIDGETS]), (error: unknown) => {
        assert.ok(isNexusError(error), String(error));
        assert.equal(error.code, 'CONFLICT');
        return true;
      });
      assert.ok(Date.now() - started < 2_000, 'did not wait out the busy timeout');
      other.exec('ROLLBACK');
      await ensureSchema(driver, schema, [WIDGETS]);
      assert.equal(ledger(db).at(-1)?.id, WIDGETS.id);
    } finally {
      other.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('transaction boundaries by dialect', () => {
  const migration = (sql: string): SqlMigration => sqlMigration('016_probe', 'probe.sql', sql);

  it('refuse prepared transactions and statements that act outside the transaction', () => {
    for (const sql of [
      "PREPARE TRANSACTION 'x';",
      'ALTER SYSTEM SET work_mem = 1;',
      'DISCARD ALL;',
      "CREATE TABLESPACE t LOCATION '/tmp';",
      'REINDEX DATABASE nexus;',
      "COMMIT PREPARED 'x';",
    ]) {
      assert.throws(() => refuseTransactionControl(migration(sql), 'pg'), IN_TRANSACTION, sql);
    }
    for (const sql of ['PRAGMA foreign_keys = OFF;', "ATTACH 'x.db' AS x;", 'DETACH x;']) {
      assert.throws(() => refuseTransactionControl(migration(sql), 'sqlite'), IN_TRANSACTION, sql);
    }
  });

  it('end a SQLite block comment at the first closing delimiter, unlike PostgreSQL', () => {
    const sql = 'CREATE TABLE a (id TEXT); /* outer /* inner */ COMMIT; /* tail */';
    assert.throws(() => refuseTransactionControl(migration(sql), 'sqlite'), IN_TRANSACTION);
    refuseTransactionControl(migration(sql), 'pg');
  });

  it('read PostgreSQL backslash-escaped strings whole', () => {
    refuseTransactionControl(
      migration("CREATE TABLE a (note TEXT DEFAULT E'it\\'s; COMMIT;');"),
      'pg',
    );
  });
});

describe('MongoDB index specs', () => {
  const step = (filter: Record<string, unknown> | undefined): MongoMigrationStep => ({
    id: '016_probe',
    indexes: [
      {
        collection: 'users',
        name: 'ix_probe',
        key: { a: 1 },
        ...(filter === undefined ? {} : { partialFilterExpression: filter }),
      },
    ],
  });

  it('change the checksum with the partial filter', () => {
    const plain = mongoMigration(step(undefined)).checksum;
    const active = mongoMigration(step({ status: 'active' })).checksum;
    assert.notEqual(active, plain);
    assert.notEqual(mongoMigration(step({ status: 'revoked' })).checksum, active);
  });

  it('refuse a filter or option the checksum could not cover', () => {
    assert.throws(() => mongoMigration(step({ created_at: new Date(0) })), NOT_COVERED);
    const extra = {
      id: '016_probe',
      indexes: [{ collection: 'users', name: 'ix_probe', key: { a: 1 }, sparse: true }],
    } as unknown as MongoMigrationStep;
    assert.throws(() => mongoMigration(extra), NOT_COVERED);
  });
});
