#!/usr/bin/env node
// Checks the database schemas bundled in the production image, and that the
// image's better-sqlite3 loads and can build the SQLite schema. Run inside the
// image from the server package (`docker run --workdir /app/server ...
// node /tmp/check-image-schema.mjs`); modules resolve from the working
// directory, the way the server resolves them.
//
// This lives in the repository rather than inline in ci.yml because pull
// requests run main's ci.yml (the trusted required workflow), while their
// checkout is the pull request's own code. A change to the schema layout can
// update this file in the same pull request; an inline check could only
// change after the layout it describes had merged.
//
// Each SQL dialect has one frozen base schema, and every later schema change
// is a numbered forward migration (docs/operations.md, "Schema and upgrades").
// The image must carry exactly the three base schema files, the same
// migration ids for every dialect (none yet), and nothing from the pre-0.6
// migration chain; the SQLite schema plus its migrations must build every
// table the stores write.
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const serverDir = process.cwd();
const require = createRequire(resolve(serverDir, 'package.json'));
const Database = require('better-sqlite3');
const { BASE_SCHEMA_ID, loadBaseSchema, schemaDir } = await import(
  pathToFileURL(resolve(serverDir, 'dist/db/schema.js')).href
);
const { loadShippedMigrations, migrationsDir } = await import(
  pathToFileURL(resolve(serverDir, 'dist/db/migrate.js')).href
);
const { MIGRATION_MANIFEST } = await import(
  pathToFileURL(resolve(serverDir, 'dist/db/migration-manifest.js')).href
);
const { MONGO_MIGRATIONS, mongoMigration } = await import(
  pathToFileURL(resolve(serverDir, 'dist/db/adapters/mongodb/index.js')).href
);

assert.ok(Number(process.versions.napi) >= 10);
assert.deepEqual(readdirSync(schemaDir()).sort(), ['base.mysql.sql', 'base.pg.sql', 'base.sql']);
assert.equal(BASE_SCHEMA_ID, '000_base_v0_6');
for (const dialect of ['sqlite', 'pg', 'mysql']) {
  assert.equal(loadBaseSchema(dialect).id, BASE_SCHEMA_ID);
}

// Every migration the compiled code ships must be packaged, unaltered, for
// every dialect. The expected list is the compiled manifest, not the files, so
// a package missing every migration file fails here. `loadShippedMigrations`
// is the same check the server runs at startup.
const expectedIds = MIGRATION_MANIFEST.map((entry) => entry.id);
for (const dialect of ['sqlite', 'pg', 'mysql']) {
  const shipped = loadShippedMigrations(dialect);
  assert.deepEqual(
    shipped.map((migration) => migration.id),
    expectedIds,
    dialect,
  );
  for (const [index, migration] of shipped.entries()) {
    assert.equal(migration.checksum, MIGRATION_MANIFEST[index].sha256[dialect], migration.source);
  }
}
assert.deepEqual(
  MONGO_MIGRATIONS.map((step) => step.id),
  expectedIds,
);
for (const [index, step] of MONGO_MIGRATIONS.entries()) {
  assert.equal(mongoMigration(step).checksum, MIGRATION_MANIFEST[index].sha256.mongodb, step.id);
}
// The pre-0.6 chain (001_initial to 015_access_gateway_jobs) must not come back.
const PRE_0_6 = /^0(0[1-9]|1[0-5])_/;
assert.ok(
  expectedIds.every((id) => !PRE_0_6.test(id)),
  expectedIds.join(', '),
);
if (existsSync(migrationsDir())) {
  // Every file is one dialect's variant of a shipped id.
  assert.equal(readdirSync(migrationsDir()).length, expectedIds.length * 3);
}

const db = new Database(':memory:');
db.exec(loadBaseSchema('sqlite').sql);
for (const migration of loadShippedMigrations('sqlite')) db.exec(migration.sql);
assert.deepEqual(db.prepare('SELECT agents_json FROM apis').all(), []);
assert.deepEqual(db.prepare('SELECT generation FROM email_outbox').all(), []);
assert.deepEqual(db.prepare('SELECT recipient_user_id FROM email_outbox').all(), []);
assert.deepEqual(db.prepare('SELECT priority FROM email_outbox').all(), []);
assert.deepEqual(db.prepare('SELECT email_lifecycle_fence FROM users').all(), []);
assert.deepEqual(db.prepare('SELECT role FROM api_gateway_plugins').all(), []);
assert.deepEqual(db.prepare('SELECT spec_id FROM api_spec_changes').all(), []);
assert.deepEqual(db.prepare('SELECT user_id FROM user_notification_preferences').all(), []);
assert.deepEqual(db.prepare('SELECT id FROM user_identities').all(), []);
assert.deepEqual(
  db.prepare('SELECT generation, unblocked_at FROM account_recovery_jobs').all(),
  [],
);
assert.deepEqual(db.prepare('SELECT subject_id FROM access_gateway_jobs').all(), []);
assert.deepEqual(db.prepare('SELECT user_id FROM user_email_proofs').all(), []);
assert.deepEqual(db.prepare('SELECT user_id FROM user_password_locks').all(), []);
assert.deepEqual(
  db
    .prepare('SELECT name FROM sqlite_master WHERE type = ? AND name LIKE ? ORDER BY name')
    .all('index', 'ix_messages_thread%'),
  [{ name: 'ix_messages_thread_latest' }],
);
assert.deepEqual(db.prepare('SELECT 1 AS ok').get(), { ok: 1 });
db.close();
process.stdout.write('The production image carries the expected schemas.\n');
