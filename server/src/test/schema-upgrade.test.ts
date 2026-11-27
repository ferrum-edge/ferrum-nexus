/**
 * Upgrading a Ferrum Nexus v0.6.0 database, on every backend
 * (docs/operations.md, "Schema and upgrades").
 *
 * Each case builds a database exactly as v0.6.0 left it — the frozen v0.6.0
 * base schema (`fixtures/v0.6.0-schema/`), v0.6.0's two-column ledger holding
 * `000_base_v0_6`, and representative rows in v0.6.0's physical shape — then
 * starts the current code against it:
 *
 * - the shipped build's migrate command applies exactly the shipped
 *   migrations (none in the 1.0 baseline, when it changes nothing at all: no
 *   ledger row, ledger column, table, collection or index) and the store
 *   serves and updates the rows;
 * - a probe migration numbered after the last shipped one, registered through
 *   the test seam (`createStore`'s `migrations` option), applies on top of
 *   them, is recorded once with its checksum, and changes nothing on a
 *   restart; on PostgreSQL its dollar-quoted body reaches the server intact;
 * - server startup refuses the database while the probe is pending, changing
 *   nothing, and accepts it once the migrate command has applied it;
 * - a migrate command started while another migrator holds the lock is
 *   refused (`CONFLICT`), changing nothing (PostgreSQL, MySQL, MongoDB);
 * - the shipped build, which does not know the probe, then refuses the
 *   database unchanged (a downgrade);
 * - SQLite and PostgreSQL roll a failing migration back with its ledger row;
 *   MongoDB records an interrupted step in progress, every other build refuses
 *   it, and the same build resumes it; a lock a crashed MongoDB migrator left
 *   stays until `--force-unlock`. MySQL's interrupted-migration resume is in
 *   `mysql-schema-recovery.test.ts`.
 *
 * SQLite always runs. PostgreSQL, MySQL and MongoDB run when
 * `NEXUS_TEST_POSTGRES_URL`, `NEXUS_TEST_MYSQL_URL` or `NEXUS_TEST_MONGO_URL`
 * is set, as the CI `store-contracts` lanes do, each in a throwaway database.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { MongoClient, type Db, type Document } from 'mongodb';
import mysql from 'mysql2/promise';
import pg from 'pg';

import type { DbDriver } from '@ferrum-nexus/shared';

import { loadConfig, type NexusConfig } from '../config/index.js';
import {
  MONGO_MIGRATIONS,
  SCHEMA_LOCK_COLLECTION,
  SCHEMA_LOCK_ID,
  type MongoMigrationStep,
} from '../db/adapters/mongodb/index.js';
import { mysqlSchemaLockName } from '../db/adapters/mysql/schema.js';
import { SCHEMA_LOCK_KEY } from '../db/adapters/postgres/index.js';
import { openSqliteDatabase } from '../db/adapters/sqlite/index.js';
import { createStore, type MigrationOverrides } from '../db/index.js';
import { loadShippedMigrations, sqlMigration } from '../db/migrate.js';
import { MIGRATION_MANIFEST } from '../db/migration-manifest.js';
import { splitSqlStatements, type SchemaDialect } from '../db/schema.js';
import { isNexusError } from '../lib/errors.js';
import {
  V0_6_0_BASE_INDEXES,
  V0_6_0_LEDGER_DDL,
  V0_6_0_LEDGER_ID,
  v060BaseSql,
} from './fixtures/v0.6.0-schema/index.js';

const SECRET = 'schema-upgrade-secret-0123456789abcdef';
const HYPHENS = /-/g;
const NEWER = /a newer release upgraded it\. Downgrades are not supported/;
const INTERRUPTED = /That upgrade was interrupted part-way/;
const FAILED = /^Schema migration \S+ failed: /;
const BUSY = /holds the \w+ schema migration lock/;
const FORCE_UNLOCK = /--force-unlock/;
const NOT_EMPTY = /not a new, empty database/;
const PENDING = /needs schema migrations this release ships.*run the migrate command once/s;
const THEN = '2026-11-01T00:00:00.000Z';
const PROBE_NOTE = 'migrated; ok';

/** The ids after the last shipped migration (016 while none ships). */
const NEXT_NUMBER = Number.parseInt(MIGRATION_MANIFEST.at(-1)?.id ?? '015', 10) + 1;
const PROBE_ID = `${String(NEXT_NUMBER).padStart(3, '0')}_upgrade_probe`;

/** An `assert.rejects` validator matching the error's message (not `String(error)`). */
function withMessage(pattern: RegExp): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof Error, String(error));
    assert.match(error.message, pattern);
    return true;
  };
}

/** The shipped migration ids of a backend: what its shipped build applies. */
function shippedIds(dialect: SchemaDialect | 'mongodb'): string[] {
  if (dialect === 'mongodb') return MONGO_MIGRATIONS.map((step) => step.id);
  return loadShippedMigrations(dialect).map((migration) => migration.id);
}

/* ── The probe migration, one artifact per backend ─────────────────────── */

const PROBE_SQL: Readonly<Record<SchemaDialect, string>> = {
  sqlite: `
    -- A comment; with a semicolon.
    CREATE TABLE IF NOT EXISTS upgrade_probe (id TEXT PRIMARY KEY, note TEXT NOT NULL DEFAULT '');
    ALTER TABLE users ADD COLUMN upgrade_probe_note TEXT;
    CREATE INDEX ix_upgrade_probe_users ON users (upgrade_probe_note);
    UPDATE users SET upgrade_probe_note = '${PROBE_NOTE}' WHERE upgrade_probe_note IS NULL;
  `,
  // A dollar-quoted body with semicolons inside: the file must reach
  // PostgreSQL whole, not split on every semicolon.
  pg: `
    -- A comment; with a semicolon.
    CREATE TABLE IF NOT EXISTS upgrade_probe (id TEXT PRIMARY KEY, note TEXT NOT NULL DEFAULT '');
    ALTER TABLE users ADD COLUMN upgrade_probe_note TEXT;
    CREATE INDEX ix_upgrade_probe_users ON users (upgrade_probe_note);
    DO $$
    BEGIN
      UPDATE users SET upgrade_probe_note = '${PROBE_NOTE}' WHERE upgrade_probe_note IS NULL;
    END
    $$;
  `,
  // Only replay-verifiable statements (`db/adapters/mysql/schema.ts`).
  mysql: `
    CREATE TABLE upgrade_probe (
      id VARCHAR(64) NOT NULL, note VARCHAR(64) NOT NULL DEFAULT '', PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
    ALTER TABLE users ADD COLUMN upgrade_probe_note VARCHAR(64) NULL;
    CREATE INDEX ix_upgrade_probe_users ON users (upgrade_probe_note);
  `,
};

const MONGO_PROBE: MongoMigrationStep = {
  id: PROBE_ID,
  indexes: [
    { collection: 'users', name: 'ix_upgrade_probe_users', key: { upgrade_probe_note: 1 } },
  ],
  updates: [
    {
      collection: 'users',
      filter: { upgrade_probe_note: { $exists: false } },
      update: { $set: { upgrade_probe_note: PROBE_NOTE } },
    },
  ],
};

/** `migrations` on one backend, through the `createStore` test seam. */
function sqlOverrides(
  dialect: SchemaDialect,
  migrations: ReturnType<typeof sqlMigration>[],
): MigrationOverrides {
  if (dialect === 'sqlite') return { sqlite: migrations };
  return dialect === 'pg' ? { pg: migrations } : { mysql: migrations };
}

/** The shipped migrations plus the probe. */
function probeOverrides(dialect: SchemaDialect | 'mongodb'): MigrationOverrides {
  if (dialect === 'mongodb') return { mongodb: [...MONGO_MIGRATIONS, MONGO_PROBE] };
  const probe = sqlMigration(PROBE_ID, `${PROBE_ID} (${dialect})`, PROBE_SQL[dialect]);
  return sqlOverrides(dialect, [...loadShippedMigrations(dialect), probe]);
}

/** The shipped migrations plus a probe that fails after its first statement. */
function brokenOverrides(dialect: 'sqlite' | 'pg'): MigrationOverrides {
  const broken = sqlMigration(
    PROBE_ID,
    `${PROBE_ID} (broken, ${dialect})`,
    'CREATE TABLE upgrade_probe_partial (id TEXT PRIMARY KEY);\n' +
      'SELECT * FROM upgrade_probe_missing_table;\n',
  );
  return sqlOverrides(dialect, [...loadShippedMigrations(dialect), broken]);
}

/* ── Representative v0.6.0 rows ─────────────────────────────────────────── */

/** The rows, as SQL v0.6.0's adapters would have written them. */
function seedStatements(dialect: SchemaDialect): string[] {
  const key = dialect === 'mysql' ? '`key`' : '"key"';
  const user = (id: string, email: string, role: string, verified: number): string =>
    'INSERT INTO users (id, email, password_hash, display_name, role, email_verified, ' +
    `created_at, updated_at) VALUES ('${id}', '${email}', 'hash-${id}', 'Name ${id}', ` +
    `'${role}', ${verified}, '${THEN}', '${THEN}')`;
  return [
    user('u-admin', 'admin@example.test', 'super_admin', 1),
    user('u-provider', 'provider@example.test', 'provider', 1),
    user('u-client', 'client@example.test', 'client', 0),
    'INSERT INTO apis (id, name, slug, owner_user_id, namespace, version, auth_plugin, ' +
      `requestable, created_at, updated_at) VALUES ('api-1', 'Weather', 'weather', ` +
      `'u-provider', 'ferrum', '1.0.0', 'key_auth', 1, '${THEN}', '${THEN}')`,
    'INSERT INTO grants (id, api_id, user_id, acl_group, granted_by, created_at, updated_at) ' +
      `VALUES ('g-1', 'api-1', 'u-client', 'nexus:api:api-1:approved', 'u-admin', ` +
      `'${THEN}', '${THEN}')`,
    `INSERT INTO app_settings (${key}, value_json, encrypted, created_at, updated_at) ` +
      `VALUES ('upgrade.portal_name', '"Upgrade Portal"', 0, '${THEN}', '${THEN}')`,
  ];
}

/** The same rows, as v0.6.0's MongoDB adapter would have written them. */
function seedDocuments(): Record<string, Document[]> {
  const user = (id: string, email: string, role: string, verified: boolean): Document => ({
    _id: id,
    email,
    password_hash: `hash-${id}`,
    display_name: `Name ${id}`,
    role,
    org_id: null,
    company: null,
    phone: null,
    status: 'active',
    email_verified: verified,
    last_login_at: null,
    created_at: THEN,
    updated_at: THEN,
    email_lifecycle_fence: '',
  });
  return {
    users: [
      user('u-admin', 'admin@example.test', 'super_admin', true),
      user('u-provider', 'provider@example.test', 'provider', true),
      user('u-client', 'client@example.test', 'client', false),
    ],
    apis: [
      {
        _id: 'api-1',
        name: 'Weather',
        name_lower: 'weather',
        slug: 'weather',
        slug_lower: 'weather',
        description: null,
        owner_user_id: 'u-provider',
        ferrum_proxy_id: null,
        upstream_url: null,
        namespace: 'ferrum',
        version: '1.0.0',
        spec_format: 'openapi',
        requestable: true,
        auth_plugin: 'key_auth',
        rate_limit: null,
        cors: null,
        allowed_methods: null,
        timeouts: null,
        circuit_breaker: false,
        spec_enforcement: 'docs_only',
        agents: null,
        status: 'published',
        visibility: 'public',
        gateway_state: 'deployed',
        created_at: THEN,
        updated_at: THEN,
      },
    ],
    grants: [
      {
        _id: 'g-1',
        api_id: 'api-1',
        user_id: 'u-client',
        application_id: null,
        access_request_id: null,
        acl_group: 'nexus:api:api-1:approved',
        approved_tools: null,
        status: 'active',
        granted_by: 'u-admin',
        revoked_by: null,
        revoked_at: null,
        created_at: THEN,
        updated_at: THEN,
      },
    ],
    app_settings: [
      {
        _id: 'upgrade.portal_name',
        value: 'Upgrade Portal',
        encrypted: false,
        created_at: THEN,
        updated_at: THEN,
      },
    ],
  };
}

/* ── Targets: one v0.6.0 database per case ──────────────────────────────── */

/** One ledger row as read back, `checksum` and `state` absent from a v0.6.0 ledger. */
interface LedgerRow {
  id: string;
  checksum: string | null;
  state: string | null;
  applied_at: string;
}

interface V060Database {
  config: NexusConfig;
  /** The migration ids the shipped build of this backend applies. */
  shipped: string[];
  overrides: MigrationOverrides;
  /** The account `u-admin`'s `upgrade_probe_note` after the probe, and what it should be. */
  probeNote: () => Promise<unknown>;
  expectedProbeNote: string | null;
  /** SQLite and PostgreSQL: whether a table exists, for the rollback case. */
  hasTable?: (name: string) => Promise<boolean>;
  /** MongoDB: run `work` against the database, for the MongoDB-only cases. */
  withMongo?: <T>(work: (db: Db) => Promise<T>) => Promise<T>;
  ledger: () => Promise<LedgerRow[]>;
  /** The ledger's columns (SQL), or `null` for MongoDB's schemaless documents. */
  ledgerColumns: () => Promise<string[] | null>;
  /** Whether the probe's index exists. */
  probeIndexed: () => Promise<boolean>;
  /** Every table or collection, column and index: what a no-op must leave alone. */
  schemaObjects: () => Promise<string[]>;
  /** Hold the migration lock as another migrator would; returns its release. */
  holdLock?: () => Promise<() => Promise<void>>;
  /**
   * SQLite and PostgreSQL: run a SQL script against the database, and reduce
   * it to what v0.6.0 left when it stopped before its first commit (its
   * empty, two-column ledger and nothing else).
   */
  exec?: (sql: string) => Promise<void>;
  resetToEmptyLedger?: () => Promise<void>;
  drop: () => Promise<void>;
}

function config(driver: DbDriver, url: string, sqlitePath = ':memory:'): NexusConfig {
  return loadConfig({
    NEXUS_SECRET_KEY: SECRET,
    FERRUM_ADMIN_JWT_SECRET: SECRET,
    NEXUS_ENV: 'test',
    NEXUS_DB_DRIVER: driver,
    NEXUS_DB_URL: url,
    NEXUS_SQLITE_PATH: sqlitePath,
  });
}

function throwawayDbName(): string {
  return `nexus_upgrade_${randomUUID().replace(HYPHENS, '').slice(0, 16)}`;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function ledgerRow(row: Record<string, unknown>): LedgerRow {
  return {
    id: String(row.id ?? row._id),
    checksum: typeof row.checksum === 'string' ? row.checksum : null,
    state: typeof row.state === 'string' ? row.state : null,
    applied_at: String(row.applied_at),
  };
}

async function v060Sqlite(): Promise<V060Database> {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-upgrade-'));
  const path = join(dir, 'nexus.sqlite');
  const db = openSqliteDatabase(path);
  try {
    db.exec(v060BaseSql('sqlite'));
    db.exec(V0_6_0_LEDGER_DDL.sqlite);
    db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(
      V0_6_0_LEDGER_ID,
      THEN,
    );
    for (const statement of seedStatements('sqlite')) db.exec(statement);
  } finally {
    db.close();
  }
  const read = <T>(work: (reader: ReturnType<typeof openSqliteDatabase>) => T): T => {
    const reader = openSqliteDatabase(path);
    try {
      return work(reader);
    } finally {
      reader.close();
    }
  };
  const columns = (): string[] =>
    read((reader) =>
      reader
        .prepare('PRAGMA table_info(schema_migrations)')
        .all()
        .map((row) => (row as { name: string }).name),
    );
  return {
    config: config('sqlite', '', path),
    shipped: shippedIds('sqlite'),
    overrides: probeOverrides('sqlite'),
    probeNote: async () =>
      read(
        (reader) =>
          (
            reader.prepare("SELECT upgrade_probe_note FROM users WHERE id = 'u-admin'").get() as {
              upgrade_probe_note: unknown;
            }
          ).upgrade_probe_note,
      ),
    expectedProbeNote: PROBE_NOTE,
    hasTable: async (name) =>
      read(
        (reader) =>
          reader
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
            .all(name).length === 1,
      ),
    ledger: async () =>
      read((reader) =>
        reader
          .prepare('SELECT * FROM schema_migrations ORDER BY id')
          .all()
          .map((row) => ledgerRow(row as Record<string, unknown>)),
      ),
    ledgerColumns: async () => columns(),
    probeIndexed: async () =>
      read(
        (reader) =>
          reader
            .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
            .all('ix_upgrade_probe_users').length === 1,
      ),
    schemaObjects: async () =>
      read((reader) => [
        ...reader
          .prepare("SELECT type || ':' || name AS object FROM sqlite_master ORDER BY 1")
          .all()
          .map((row) => String((row as { object: unknown }).object)),
        ...columns().map((column) => `ledger column:${column}`),
      ]),
    holdLock: async () => {
      const holder = openSqliteDatabase(path);
      holder.exec('BEGIN IMMEDIATE');
      return async () => {
        holder.exec('ROLLBACK');
        holder.close();
      };
    },
    exec: async (sql) => {
      const writer = openSqliteDatabase(path);
      try {
        writer.exec(sql);
      } finally {
        writer.close();
      }
    },
    resetToEmptyLedger: async () => {
      const writer = openSqliteDatabase(path);
      try {
        writer.pragma('foreign_keys = OFF');
        const names = writer
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
          )
          .all()
          .map((row) => String((row as { name: unknown }).name));
        for (const name of names) writer.exec(`DROP TABLE "${name}"`);
        writer.exec(V0_6_0_LEDGER_DDL.sqlite);
      } finally {
        writer.close();
      }
    },
    drop: async () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function v060Postgres(adminUrl: string): Promise<V060Database> {
  const database = throwawayDbName();
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${database}"`);
  await admin.end();
  const url = withDatabase(adminUrl, database);
  const query = async (sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      return (await client.query(sql, params)).rows as Record<string, unknown>[];
    } finally {
      await client.end();
    }
  };
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    for (const statement of splitSqlStatements(v060BaseSql('pg'))) await client.query(statement);
    await client.query(V0_6_0_LEDGER_DDL.pg);
    await client.query('INSERT INTO schema_migrations (id, applied_at) VALUES ($1, $2)', [
      V0_6_0_LEDGER_ID,
      THEN,
    ]);
    for (const statement of seedStatements('pg')) await client.query(statement);
  } finally {
    await client.end();
  }
  return {
    config: config('postgres', url),
    shipped: shippedIds('pg'),
    overrides: probeOverrides('pg'),
    probeNote: async () =>
      (await query("SELECT upgrade_probe_note FROM users WHERE id = 'u-admin'"))[0]
        ?.upgrade_probe_note,
    expectedProbeNote: PROBE_NOTE,
    hasTable: async (name) =>
      (
        await query(
          'SELECT 1 FROM information_schema.tables ' +
            'WHERE table_schema = current_schema() AND table_name = $1',
          [name],
        )
      ).length === 1,
    ledger: async () => (await query('SELECT * FROM schema_migrations ORDER BY id')).map(ledgerRow),
    ledgerColumns: async () =>
      (
        await query(
          'SELECT column_name FROM information_schema.columns ' +
            "WHERE table_schema = current_schema() AND table_name = 'schema_migrations' " +
            'ORDER BY ordinal_position',
        )
      ).map((row) => String(row.column_name)),
    probeIndexed: async () =>
      (
        await query('SELECT indexname FROM pg_indexes WHERE indexname = $1', [
          'ix_upgrade_probe_users',
        ])
      ).length === 1,
    schemaObjects: async () =>
      (
        await query(
          "SELECT 'table:' || table_name AS object FROM information_schema.tables " +
            'WHERE table_schema = current_schema() ' +
            "UNION ALL SELECT 'column:' || table_name || '.' || column_name " +
            'FROM information_schema.columns WHERE table_schema = current_schema() ' +
            "UNION ALL SELECT 'index:' || indexname FROM pg_indexes " +
            'WHERE schemaname = current_schema() ORDER BY 1',
        )
      ).map((row) => String(row.object)),
    holdLock: async () => {
      const holder = new pg.Client({ connectionString: url });
      await holder.connect();
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock($1::bigint)', [SCHEMA_LOCK_KEY]);
      return async () => {
        await holder.query('ROLLBACK');
        await holder.end();
      };
    },
    exec: async (sql) => {
      await query(sql);
    },
    resetToEmptyLedger: async () => {
      await query('DROP SCHEMA public CASCADE');
      await query('CREATE SCHEMA public');
      await query(V0_6_0_LEDGER_DDL.pg);
    },
    drop: async () => {
      const cleaner = new pg.Client({ connectionString: adminUrl });
      await cleaner.connect();
      await cleaner.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      await cleaner.end();
    },
  };
}

async function v060Mysql(adminUrl: string): Promise<V060Database> {
  const database = throwawayDbName();
  const admin = await mysql.createConnection(adminUrl);
  await admin.query(`CREATE DATABASE \`${database}\``);
  await admin.end();
  const url = withDatabase(adminUrl, database);
  const query = async (sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> => {
    const connection = await mysql.createConnection(url);
    try {
      const [rows] = await connection.query<mysql.RowDataPacket[]>(sql, params);
      return rows as Record<string, unknown>[];
    } finally {
      await connection.end();
    }
  };
  const connection = await mysql.createConnection(url);
  try {
    for (const statement of splitSqlStatements(v060BaseSql('mysql'))) {
      await connection.query(statement);
    }
    await connection.query(V0_6_0_LEDGER_DDL.mysql);
    await connection.execute('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)', [
      V0_6_0_LEDGER_ID,
      THEN,
    ]);
    for (const statement of seedStatements('mysql')) await connection.query(statement);
  } finally {
    await connection.end();
  }
  return {
    config: config('mysql', url),
    shipped: shippedIds('mysql'),
    overrides: probeOverrides('mysql'),
    // A MySQL migration changes no data (its DML could commit before its ledger row).
    probeNote: async () =>
      (await query("SELECT upgrade_probe_note FROM users WHERE id = 'u-admin'"))[0]
        ?.upgrade_probe_note,
    expectedProbeNote: null,
    ledger: async () => (await query('SELECT * FROM schema_migrations ORDER BY id')).map(ledgerRow),
    ledgerColumns: async () =>
      (
        await query(
          'SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS ' +
            "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'schema_migrations' " +
            'ORDER BY ORDINAL_POSITION',
        )
      ).map((row) => String(row.name)),
    probeIndexed: async () =>
      (
        await query(
          'SELECT INDEX_NAME FROM information_schema.STATISTICS ' +
            'WHERE TABLE_SCHEMA = DATABASE() AND INDEX_NAME = ?',
          ['ix_upgrade_probe_users'],
        )
      ).length === 1,
    schemaObjects: async () =>
      (
        await query(
          "SELECT CONCAT('table:', TABLE_NAME) AS object FROM information_schema.TABLES " +
            'WHERE TABLE_SCHEMA = DATABASE() ' +
            "UNION ALL SELECT CONCAT('column:', TABLE_NAME, '.', COLUMN_NAME) " +
            'FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() ' +
            "UNION ALL SELECT DISTINCT CONCAT('index:', TABLE_NAME, '.', INDEX_NAME) " +
            'FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() ORDER BY 1',
        )
      ).map((row) => String(row.object)),
    holdLock: async () => {
      const holder = await mysql.createConnection(url);
      await holder.query('SELECT GET_LOCK(?, 5)', [mysqlSchemaLockName(database)]);
      return async () => {
        await holder.query('SELECT RELEASE_LOCK(?)', [mysqlSchemaLockName(database)]);
        await holder.end();
      };
    },
    drop: async () => {
      const cleaner = await mysql.createConnection(adminUrl);
      await cleaner.query(`DROP DATABASE IF EXISTS \`${database}\``);
      await cleaner.end();
    },
  };
}

async function v060Mongo(baseUrl: string): Promise<V060Database> {
  const database = throwawayDbName();
  const url = withDatabase(baseUrl, database);
  const withDb = async <T>(work: (db: Db) => Promise<T>): Promise<T> => {
    const client = new MongoClient(url);
    await client.connect();
    try {
      return await work(client.db(database));
    } finally {
      await client.close();
    }
  };
  await withDb(async (db) => {
    for (const index of V0_6_0_BASE_INDEXES) {
      await db.collection(index.collection).createIndex(index.key, {
        name: index.name,
        ...(index.unique === true ? { unique: true } : {}),
        ...(index.partialFilterExpression
          ? { partialFilterExpression: index.partialFilterExpression }
          : {}),
      });
    }
    await db
      .collection('schema_migrations')
      .insertOne({ _id: V0_6_0_LEDGER_ID, applied_at: THEN } as Document);
    for (const [collection, docs] of Object.entries(seedDocuments())) {
      await db.collection(collection).insertMany(docs);
    }
  });
  return {
    config: config('mongodb', url),
    shipped: shippedIds('mongodb'),
    overrides: probeOverrides('mongodb'),
    probeNote: () =>
      withDb(
        async (db) =>
          (await db.collection('users').findOne({ _id: 'u-admin' } as Document))
            ?.upgrade_probe_note,
      ),
    expectedProbeNote: PROBE_NOTE,
    withMongo: withDb,
    ledger: () =>
      withDb(async (db) =>
        (await db.collection('schema_migrations').find({}).sort({ _id: 1 }).toArray()).map((doc) =>
          ledgerRow(doc as Record<string, unknown>),
        ),
      ),
    ledgerColumns: async () => null,
    probeIndexed: () =>
      withDb(async (db) =>
        (await db.collection('users').indexes()).some(
          (index) => index.name === 'ix_upgrade_probe_users',
        ),
      ),
    schemaObjects: () =>
      withDb(async (db) => {
        const objects: string[] = [];
        for (const { name } of await db.listCollections({}, { nameOnly: true }).toArray()) {
          objects.push(`collection:${name}`);
          for (const index of await db.collection(name).indexes()) {
            objects.push(`index:${name}.${String(index.name)}`);
          }
        }
        return objects.sort();
      }),
    holdLock: async () => {
      await withDb((db) =>
        db.collection(SCHEMA_LOCK_COLLECTION).insertOne({
          _id: SCHEMA_LOCK_ID,
          owner: 'another-migrator',
          acquired_at: THEN,
        } as Document),
      );
      return () =>
        withDb((db) =>
          db
            .collection(SCHEMA_LOCK_COLLECTION)
            .deleteOne({ _id: SCHEMA_LOCK_ID } as Document)
            .then(() => undefined),
        );
    },
    drop: () => withDb((db) => db.dropDatabase().then(() => undefined)),
  };
}

/* ── The cases ──────────────────────────────────────────────────────────── */

/** Open the store, hand it to `work`, and always close it. */
async function withStore<T>(
  target: V060Database,
  overrides: MigrationOverrides | undefined,
  work: (store: ReturnType<typeof createStore>) => Promise<T>,
): Promise<T> {
  const store = createStore(target.config, overrides ? { migrations: overrides } : {});
  try {
    await store.init();
    return await work(store);
  } finally {
    await store.close();
  }
}

/** Assert that `migrate()` refuses the database as one a newer release changed. */
async function assertRefusedAsNewer(
  target: V060Database,
  overrides: MigrationOverrides | undefined,
  extra?: RegExp,
): Promise<void> {
  await withStore(target, overrides, async (store) => {
    await assert.rejects(store.migrate(), (error: unknown) => {
      assert.ok(isNexusError(error), String(error));
      assert.match(error.message, NEWER);
      assert.ok(error.message.includes(PROBE_ID), error.message);
      if (extra) assert.match(error.message, extra);
      return true;
    });
  });
}

function registerUpgrade(
  label: string,
  url: string | undefined,
  variable: string | null,
  build: (url: string) => Promise<V060Database>,
): void {
  describe(`upgrade from v0.6.0 — ${label}`, () => {
    if (variable !== null && (url === undefined || url.trim() === '')) {
      it(`skipped — set ${variable} to run against a real ${label} server`, {
        skip: `${variable} is not set`,
      });
      return;
    }
    const open = (): Promise<V060Database> => build(url ?? '');

    it('opens a v0.6.0 database, applies only the shipped migrations, and serves its rows', async () => {
      const target = await open();
      try {
        const before = await target.ledger();
        const columns = await target.ledgerColumns();
        const objects = await target.schemaObjects();
        await withStore(target, undefined, async (store) => {
          await store.migrate();
          const ledger = await target.ledger();
          assert.deepEqual(
            ledger.map((row) => row.id),
            [V0_6_0_LEDGER_ID, ...target.shipped],
          );
          if (target.shipped.length === 0) {
            // Nothing to apply: nothing is written, not to the ledger, its
            // shape, or anything else (no lock table or collection either).
            assert.deepEqual(ledger, before);
            assert.deepEqual(await target.ledgerColumns(), columns);
            assert.deepEqual(await target.schemaObjects(), objects);
          }

          const admin = await store.users.findById('u-admin');
          assert.equal(admin?.role, 'super_admin');
          assert.equal(admin?.email_verified, true);
          assert.equal(await store.users.countActiveSuperAdmins(), 1);
          // The case-insensitive unique email index v0.6.0 built still answers.
          assert.equal((await store.users.findByEmail('PROVIDER@example.test'))?.id, 'u-provider');
          const api = await store.apis.findBySlug('WEATHER');
          assert.equal(api?.id, 'api-1');
          assert.equal(api?.owner_user_id, 'u-provider');
          assert.equal(api?.requestable, true);
          const grant = await store.grants.findById('g-1');
          assert.equal(grant?.status, 'active');
          assert.equal(grant?.acl_group, 'nexus:api:api-1:approved');
          assert.equal((await store.settings.get('upgrade.portal_name'))?.value, 'Upgrade Portal');

          // …and takes writes.
          await store.settings.set('upgrade.after', { ok: true });
          assert.deepEqual((await store.settings.get('upgrade.after'))?.value, { ok: true });
          await store.users.update('u-client', { display_name: 'Renamed' });
          assert.equal((await store.users.findById('u-client'))?.display_name, 'Renamed');
        });
        // A second start is a no-op.
        const afterFirst = await target.ledger();
        await withStore(target, undefined, (store) => store.migrate());
        assert.deepEqual(await target.ledger(), afterFirst);
      } finally {
        await target.drop();
      }
    });

    it('applies a later migration once, then refuses the build that does not know it', async () => {
      const target = await open();
      try {
        await withStore(target, target.overrides, async (store) => {
          await store.migrate();
          // The rows written before the migration are still there.
          assert.equal((await store.users.findById('u-admin'))?.role, 'super_admin');
          assert.equal((await store.apis.findBySlug('weather'))?.id, 'api-1');
        });
        const after = await target.ledger();
        assert.deepEqual(
          after.map((row) => row.id),
          [V0_6_0_LEDGER_ID, ...target.shipped, PROBE_ID],
        );
        const probe = after.at(-1);
        assert.equal(after[0]?.checksum, null, 'the baseline row keeps its v0.6.0 shape');
        assert.ok(probe?.checksum?.length === 64, 'the migration is recorded with its checksum');
        assert.equal(probe?.state, 'applied');
        assert.ok(!Number.isNaN(Date.parse(probe?.applied_at ?? '')), 'and when it applied');
        assert.ok(await target.probeIndexed());
        assert.equal(await target.probeNote(), target.expectedProbeNote);
        const columns = await target.ledgerColumns();
        if (columns !== null) {
          assert.ok(columns.includes('checksum') && columns.includes('state'), columns.join());
        }

        // Restarting the same build applies nothing.
        await withStore(target, target.overrides, (store) => store.migrate());
        assert.deepEqual(await target.ledger(), after);

        // The shipped build does not know the probe: that is a downgrade.
        await assertRefusedAsNewer(target, undefined);
        assert.deepEqual(await target.ledger(), after);
      } finally {
        await target.drop();
      }
    });

    it('refuses to start with migrations pending, until the migrate command applies them', async () => {
      const target = await open();
      try {
        await withStore(target, undefined, (store) => store.migrate());
        const before = await target.ledger();
        const objects = await target.schemaObjects();
        // Startup knows the probe but never applies it.
        await withStore(target, target.overrides, async (store) => {
          await assert.rejects(store.migrate({ mode: 'startup' }), withMessage(PENDING));
        });
        assert.deepEqual(await target.ledger(), before);
        assert.deepEqual(await target.schemaObjects(), objects);
        // The migrate command applies it; startup then accepts the database.
        await withStore(target, target.overrides, (store) => store.migrate());
        await withStore(target, target.overrides, (store) => store.migrate({ mode: 'startup' }));
        assert.equal((await target.ledger()).at(-1)?.id, PROBE_ID);
        // A build that does not know the probe refuses to start.
        await withStore(target, undefined, async (store) => {
          await assert.rejects(store.migrate({ mode: 'startup' }), withMessage(NEWER));
        });
      } finally {
        await target.drop();
      }
    });

    it('refuses a second migrator while another holds the lock', async () => {
      const target = await open();
      try {
        const before = await target.ledger();
        const release = await target.holdLock!();
        try {
          await withStore(target, target.overrides, async (store) => {
            await assert.rejects(store.migrate(), (error: unknown) => {
              assert.ok(isNexusError(error), String(error));
              assert.equal(error.code, 'CONFLICT');
              assert.match(error.message, BUSY);
              return true;
            });
          });
          assert.deepEqual(await target.ledger(), before);
        } finally {
          await release();
        }
        await withStore(target, target.overrides, (store) => store.migrate());
        assert.equal((await target.ledger()).at(-1)?.id, PROBE_ID);
      } finally {
        await target.drop();
      }
    });

    if (label === 'sqlite' || label === 'postgres') {
      it('initialises from an empty v0.6.0 ledger, but not beside existing tables', async () => {
        const target = await open();
        try {
          // A ledger with no rows next to the tables the schema would create.
          await target.exec!('DELETE FROM schema_migrations');
          await withStore(target, target.overrides, async (store) => {
            await assert.rejects(store.migrate({ mode: 'startup' }), withMessage(NOT_EMPTY));
          });
          assert.deepEqual(await target.ledger(), []);
          // What v0.6.0 leaves if it stops before its first commit: the empty ledger alone.
          await target.resetToEmptyLedger!();
          await withStore(target, target.overrides, (store) => store.migrate({ mode: 'startup' }));
          assert.deepEqual(
            (await target.ledger()).map((row) => row.id),
            [V0_6_0_LEDGER_ID, ...target.shipped, PROBE_ID],
          );
          assert.ok(await target.probeIndexed());
        } finally {
          await target.drop();
        }
      });

      const dialect = label === 'sqlite' ? 'sqlite' : 'pg';
      it('rolls a failing migration back with its ledger row', async () => {
        const target = await open();
        try {
          await withStore(target, undefined, (store) => store.migrate());
          const before = await target.ledger();
          await withStore(target, brokenOverrides(dialect), async (store) => {
            await assert.rejects(store.migrate(), withMessage(FAILED));
          });
          assert.deepEqual(await target.ledger(), before);
          assert.equal(await target.hasTable?.('upgrade_probe_partial'), false);
          // The fixed migration then applies.
          await withStore(target, target.overrides, (store) => store.migrate());
          assert.equal((await target.ledger()).at(-1)?.id, PROBE_ID);
        } finally {
          await target.drop();
        }
      });
    }

    if (label === 'mongodb') registerMongoCases(open);
  });
}

/** MongoDB: interrupted steps and a lock a crashed migrator left behind. */
function registerMongoCases(open: () => Promise<V060Database>): void {
  it('records an interrupted step in progress, refuses other builds, and resumes it', async () => {
    const target = await open();
    const mongo = target.withMongo!;
    try {
      // A unique index the data violates stops the step part-way.
      await mongo((db) =>
        db.collection('upgrade_probe_items').insertMany([
          { _id: 'a', code: 'same' },
          { _id: 'b', code: 'same' },
        ] as Document[]),
      );
      const step: MongoMigrationStep = {
        id: PROBE_ID,
        indexes: [
          {
            collection: 'upgrade_probe_items',
            name: 'ux_upgrade_probe_items_code',
            key: { code: 1 },
            unique: true,
          },
        ],
        updates: MONGO_PROBE.updates ?? [],
      };
      const overrides: MigrationOverrides = { mongodb: [...MONGO_MIGRATIONS, step] };
      await withStore(target, overrides, async (store) => {
        await assert.rejects(store.migrate(), withMessage(FAILED));
      });
      const interrupted = await target.ledger();
      assert.equal(interrupted.at(-1)?.id, PROBE_ID);
      assert.equal(interrupted.at(-1)?.state, 'in_progress');

      // Every build that does not know the step refuses the half-upgraded database.
      await assertRefusedAsNewer(target, undefined, INTERRUPTED);
      // The same build resumes it once the cause is fixed.
      await mongo((db) => db.collection('upgrade_probe_items').deleteOne({ _id: 'b' } as Document));
      await withStore(target, overrides, (store) => store.migrate());
      const resumed = await target.ledger();
      assert.equal(resumed.at(-1)?.state, 'applied');
      assert.equal(resumed.at(-1)?.checksum, interrupted.at(-1)?.checksum);
      assert.equal(await target.probeNote(), PROBE_NOTE);
    } finally {
      await target.drop();
    }
  });

  it("keeps a crashed migrator's lock until --force-unlock clears it", async () => {
    const target = await open();
    try {
      // A lock no running migrator holds: what a crash leaves behind.
      await target.holdLock!();
      await withStore(target, target.overrides, async (store) => {
        await assert.rejects(store.migrate(), withMessage(FORCE_UNLOCK));
      });
      await withStore(target, target.overrides, (store) => store.migrate({ forceUnlock: true }));
      assert.equal((await target.ledger()).at(-1)?.id, PROBE_ID);
      const locks = await target.withMongo!((db) =>
        db.collection(SCHEMA_LOCK_COLLECTION).countDocuments({}),
      );
      assert.equal(locks, 0, 'the migrator released its own lock');
    } finally {
      await target.drop();
    }
  });
}

if (process.env.NEXUS_TEST_SKIP_SQLITE === 'true') {
  describe('upgrade from v0.6.0 — sqlite', () => {
    it('skipped — NEXUS_TEST_SKIP_SQLITE=true; `npm test` runs it', {
      skip: 'NEXUS_TEST_SKIP_SQLITE is true',
    });
  });
} else {
  registerUpgrade('sqlite', '', null, () => v060Sqlite());
}
registerUpgrade(
  'postgres',
  process.env.NEXUS_TEST_POSTGRES_URL,
  'NEXUS_TEST_POSTGRES_URL',
  v060Postgres,
);
registerUpgrade('mysql', process.env.NEXUS_TEST_MYSQL_URL, 'NEXUS_TEST_MYSQL_URL', v060Mysql);
registerUpgrade('mongodb', process.env.NEXUS_TEST_MONGO_URL, 'NEXUS_TEST_MONGO_URL', v060Mongo);
