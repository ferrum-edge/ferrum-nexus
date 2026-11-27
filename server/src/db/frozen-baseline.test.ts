/**
 * The frozen baseline (docs/operations.md, "Schema and upgrades").
 *
 * From Ferrum Nexus 1.0.0 onward the base schema never changes: a database
 * created from it never reads it again, so an edit would make new and
 * upgraded databases diverge. Every schema change is a numbered forward
 * migration instead. These checks fail the edit in CI.
 *
 * The constants below are the SHA-256 of each backend's base schema artifact
 * (the SQL file's text with CRLF normalised to LF, so `shasum -a 256 <file>`
 * on an LF checkout reproduces it; for MongoDB, the canonical JSON of
 * `BASE_INDEXES`). **Never update them**: revert the edit and add a migration.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  fixtureDir,
  V0_6_0_BASE_INDEXES,
  V0_6_0_FIXTURE_SHA256,
  V0_6_0_LEDGER_ID,
  v060BaseSql,
} from '../test/fixtures/v0.6.0-schema/index.js';
import {
  BASE_INDEXES,
  canonicalIndexes,
  MONGO_BASE_SCHEMA,
  MONGO_MIGRATIONS,
} from './adapters/mongodb/index.js';
import { loadMigrations, migrationsDir } from './migrate.js';
import {
  artifactChecksum,
  BASE_SCHEMA_FILE,
  BASE_SCHEMA_ID,
  loadBaseSchema,
  schemaDir,
  splitSqlStatements,
  type SchemaDialect,
} from './schema.js';

/** The frozen 1.0 baseline. Never edit these values. */
const FROZEN_BASELINE_SHA256 = {
  sqlite: 'e00ea06876aad9dac252dadaf5e23a688994d67879ae6817c978f7a64537f0fa',
  pg: 'e7110f6701d45ddf0a33818ac5fe60dcee0daf1c13141804c8446bbb43cb5866',
  mysql: '5338acb2b6f2abc72c308b9cdd34b4beaab87530c67a2a9ffbfb85cedca8c27b',
  mongodb: 'e9737ebdf9af7aeac769396ffd2afec2d86074631c656872d021820469b84b1c',
} as const;

const DIALECTS: readonly SchemaDialect[] = ['sqlite', 'pg', 'mysql'];

/** The last id of the pre-0.6 migration chain; new migrations number after it. */
const LAST_PRE_0_6_NUMBER = 15;

const MIGRATION_FILE = /^(\d{3,})_[a-z0-9_]+(\.pg|\.mysql)?\.sql$/;

const ADD_A_MIGRATION =
  'The base schema is frozen from Ferrum Nexus 1.0.0 onward. Revert this edit and add a ' +
  'numbered forward migration instead: server/src/db/migrations/NNN_description.sql, ' +
  '.pg.sql and .mysql.sql, plus a MONGO_MIGRATIONS step of the same id ' +
  '(docs/operations.md, "Schema and upgrades"). Never update the frozen checksum.';

describe('frozen baseline', () => {
  it('keeps the ledger id v0.6.0 recorded, so 1.0 opens a v0.6.0 database', () => {
    assert.equal(BASE_SCHEMA_ID, V0_6_0_LEDGER_ID);
    for (const dialect of DIALECTS) assert.equal(loadBaseSchema(dialect).id, BASE_SCHEMA_ID);
    assert.equal(MONGO_BASE_SCHEMA.id, BASE_SCHEMA_ID);
  });

  it('keeps every SQL base schema byte for byte', () => {
    for (const dialect of DIALECTS) {
      const file = BASE_SCHEMA_FILE[dialect];
      const actual = artifactChecksum(readFileSync(join(schemaDir(), file), 'utf8'));
      assert.equal(
        actual,
        FROZEN_BASELINE_SHA256[dialect],
        `server/src/db/schema/${file} changed (its SHA-256 is now ${actual}). ${ADD_A_MIGRATION}`,
      );
    }
  });

  it('keeps the MongoDB base indexes', () => {
    const actual = artifactChecksum(JSON.stringify(canonicalIndexes(BASE_INDEXES)));
    assert.equal(
      actual,
      FROZEN_BASELINE_SHA256.mongodb,
      `BASE_INDEXES in server/src/db/adapters/mongodb/index.ts changed (its canonical ` +
        `SHA-256 is now ${actual}). ${ADD_A_MIGRATION}`,
    );
  });

  it('is exactly the schema v0.6.0 shipped, statement for statement', () => {
    for (const dialect of DIALECTS) {
      assert.deepEqual(
        splitSqlStatements(loadBaseSchema(dialect).sql),
        splitSqlStatements(v060BaseSql(dialect)),
        `${BASE_SCHEMA_FILE[dialect]} no longer matches v0.6.0. ${ADD_A_MIGRATION}`,
      );
    }
    assert.deepEqual(
      canonicalIndexes(BASE_INDEXES),
      canonicalIndexes(V0_6_0_BASE_INDEXES),
      `BASE_INDEXES no longer matches v0.6.0. ${ADD_A_MIGRATION}`,
    );
  });

  it('never changes the frozen v0.6.0 fixture', () => {
    for (const [file, expected] of Object.entries(V0_6_0_FIXTURE_SHA256)) {
      const actual = artifactChecksum(readFileSync(join(fixtureDir(), file), 'utf8'));
      assert.equal(
        actual,
        expected,
        `server/src/test/fixtures/v0.6.0-schema/${file} records what v0.6.0 shipped and is ` +
          'never edited. Restore it from the v0.6.0 tag.',
      );
    }
  });
});

describe('forward migrations', () => {
  it('ship under recognised names only', () => {
    if (!existsSync(migrationsDir())) return;
    for (const file of readdirSync(migrationsDir())) {
      assert.match(file, MIGRATION_FILE, `unexpected file server/src/db/migrations/${file}`);
    }
  });

  it('implement the same ids on every backend, numbered after the pre-0.6 chain', () => {
    const ids = loadMigrations('sqlite').map((migration) => migration.id);
    for (const dialect of DIALECTS) {
      assert.deepEqual(
        loadMigrations(dialect).map((migration) => migration.id),
        ids,
        `${dialect} must ship exactly the migration ids SQLite does`,
      );
    }
    assert.deepEqual(
      MONGO_MIGRATIONS.map((step) => step.id),
      ids,
      'MONGO_MIGRATIONS must declare exactly the migration ids the SQL dialects ship',
    );
    for (const id of ids) {
      // 001 to 015 name the pre-0.6 chain in databases that are refused; reusing
      // a number would make a ledger ambiguous to the people reading it.
      assert.ok(
        Number.parseInt(id, 10) > LAST_PRE_0_6_NUMBER,
        `${id}: number new migrations from 016 on`,
      );
    }
  });
});
