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
// The released migrations must lead, unchanged and in order; a pending one
// after them is allowed. The per-dialect id list is pinned exactly by
// server/src/db/initial-schema.test.ts.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const serverDir = process.cwd();
const require = createRequire(resolve(serverDir, 'package.json'));
const Database = require('better-sqlite3');
const { loadMigrations } = await import(
  pathToFileURL(resolve(serverDir, 'dist/db/migrate.js')).href
);

assert.ok(Number(process.versions.napi) >= 10);
const priorityHashes = {
  sqlite: '0ffa16cce8d5a154877a1dadffc52b8ac3ad4cc8346d637b008ded2ec5fde31e',
  pg: '6bd48d66f70cd8b949dc168991e822db31ae49d3734b3cbcee81115b0d6c8b35',
  mysql: '633e786effcf93732d5b53987e42e3118bf789394b57295a3764440a69cddc16',
};
for (const dialect of ['sqlite', 'pg', 'mysql']) {
  const files = loadMigrations(dialect);
  const ids = files.map((file) => file.id);
  assert.deepEqual(ids.slice(0, 13), [
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
  ]);
  assert.deepEqual(ids, [...new Set(ids)].sort());
  const priority = files.find((file) => file.id === '009_outbox_priority');
  assert.ok(priority);
  assert.equal(createHash('sha256').update(priority.sql).digest('hex'), priorityHashes[dialect]);
}

const db = new Database(':memory:');
for (const file of loadMigrations('sqlite')) db.exec(file.sql);
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
