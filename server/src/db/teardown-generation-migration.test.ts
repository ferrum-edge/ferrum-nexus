import assert from 'node:assert/strict';
import { it } from 'node:test';

import { openSqliteDatabase } from './adapters/sqlite/index.js';
import { loadMigrations } from './migrate.js';

it('013 preserves legacy pending, sending and completed teardown rows', () => {
  const db = openSqliteDatabase(':memory:');
  try {
    const migrations = loadMigrations('sqlite');
    const migration = migrations.find((entry) => entry.id === '013_teardown_generation');
    assert.ok(migration);
    for (const entry of migrations.filter((entry) => entry.id < migration.id)) db.exec(entry.sql);
    const at = '2026-09-01T00:00:00.000Z';
    for (const status of ['pending', 'sending', 'done']) {
      db.prepare(
        `INSERT INTO users
         (id, email, password_hash, display_name, role, status, email_verified, created_at, updated_at)
         VALUES (?, ?, 'unused', 'Legacy', 'client', 'disabled', 1, ?, ?)`,
      ).run(status, `${status}@example.test`, at, at);
      db.prepare(
        `INSERT INTO gateway_teardown_jobs
         (id, user_id, status, attempts, next_attempt_at, last_error, requested_by,
          created_at, updated_at, completed_at)
         VALUES (?, ?, ?, 7, ?, ?, NULL, ?, ?, ?)`,
      ).run(
        `job-${status}`,
        status,
        status,
        status === 'done' ? null : at,
        status === 'done' ? null : 'unavailable',
        at,
        at,
        status === 'done' ? at : null,
      );
    }
    const before = db.prepare('SELECT * FROM gateway_teardown_jobs ORDER BY id').all();
    // The production SQLite runner also encloses each migration in a transaction.
    db.transaction(() => db.exec(migration.sql))();
    const after = db.prepare('SELECT * FROM gateway_teardown_jobs ORDER BY id').all();
    assert.deepEqual(
      after,
      before.map((row) => ({ ...(row as Record<string, unknown>), generation: '' })),
    );
  } finally {
    db.close();
  }
});
