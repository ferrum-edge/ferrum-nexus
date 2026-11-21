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
// Until 1.0 each SQL dialect has exactly one base schema and no migrations
// (docs/operations.md, "Schema and upgrades before 1.0"). The image must carry
// those three files and nothing from the pre-0.6 migration chain, and the
// SQLite schema must build every table the stores write.
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const serverDir = process.cwd();
const require = createRequire(resolve(serverDir, 'package.json'));
const Database = require('better-sqlite3');
const { loadBaseSchema, schemaDir } = await import(
  pathToFileURL(resolve(serverDir, 'dist/db/schema.js')).href
);

assert.ok(Number(process.versions.napi) >= 10);
assert.deepEqual(readdirSync(schemaDir()).sort(), ['base.mysql.sql', 'base.pg.sql', 'base.sql']);
assert.equal(existsSync(resolve(serverDir, 'dist/db/migrations')), false);
const ids = new Set();
for (const dialect of ['sqlite', 'pg', 'mysql']) {
  const { id } = loadBaseSchema(dialect);
  assert.match(id, /^base_[0-9a-f]{16}$/);
  ids.add(id);
}
assert.equal(ids.size, 3);

const db = new Database(':memory:');
db.exec(loadBaseSchema('sqlite').sql);
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
