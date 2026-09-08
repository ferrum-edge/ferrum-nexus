import assert from 'node:assert/strict';
import { it } from 'node:test';

import { openSqliteDatabase } from './adapters/sqlite/index.js';
import { loadMigrations } from './migrate.js';

it('014 preserves legacy pending, sending, sent and failed outbox rows', () => {
  const db = openSqliteDatabase(':memory:');
  try {
    const migrations = loadMigrations('sqlite');
    const migration = migrations.find((entry) => entry.id === '014_outbox_generation');
    assert.ok(migration);
    for (const entry of migrations.filter((entry) => entry.id < migration.id)) db.exec(entry.sql);
    const at = '2026-09-01T00:00:00.000Z';
    for (const status of ['pending', 'sending', 'sent', 'failed']) {
      db.prepare(
        `INSERT INTO email_outbox
         (id, to_email, subject, body_html, body_text, status, attempts, next_attempt_at,
          last_error, idempotency_key, created_at, updated_at)
         VALUES (?, ?, 'Legacy', '<p>x</p>', 'x', ?, 3, ?, ?, ?, ?, ?)`,
      ).run(
        `outbox-${status}`,
        `${status}@example.test`,
        status,
        status === 'sent' || status === 'failed' ? null : at,
        status === 'failed' ? 'relay refused' : null,
        `legacy:${status}`,
        at,
        at,
      );
    }
    const before = db.prepare('SELECT * FROM email_outbox ORDER BY id').all();
    // The production SQLite runner also encloses each migration in a transaction.
    db.transaction(() => db.exec(migration.sql))();
    const after = db.prepare('SELECT * FROM email_outbox ORDER BY id').all();
    assert.deepEqual(
      after,
      before.map((row) => ({ ...(row as Record<string, unknown>), generation: '' })),
    );
  } finally {
    db.close();
  }
});
