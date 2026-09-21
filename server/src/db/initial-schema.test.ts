import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { openSqliteDatabase } from './adapters/sqlite/index.js';
import { loadMigrations, splitSqlStatements } from './migrate.js';

describe('buildout schema baseline', () => {
  it('ships one complete initial schema for each SQL dialect', () => {
    for (const dialect of ['sqlite', 'pg', 'mysql'] as const) {
      const files = loadMigrations(dialect);
      assert.deepEqual(
        files.map((file) => file.id),
        ['001_initial'],
      );
      const statements = splitSqlStatements(files[0]!.sql);
      assert.ok(statements.length > 0);
      assert.ok(statements.every((statement) => /^CREATE\s/.test(statement)));
      const tables = statements.flatMap((statement) => {
        const match = /^CREATE TABLE IF NOT EXISTS (\w+)/.exec(statement);
        return match ? [match[1]] : [];
      });
      assert.deepEqual(tables.sort(), [
        'access_requests',
        'api_plugins',
        'api_specs',
        'api_viewers',
        'apis',
        'app_settings',
        'audit_logs',
        'consumers',
        'credential_metadata',
        'edge_leases',
        'email_outbox',
        'email_templates',
        'email_token_issue_claims',
        'email_verification_tokens',
        'gateway_identities',
        'gateway_teardown_jobs',
        'grants',
        'message_threads',
        'messages',
        'notifications',
        'organizations',
        'sessions',
        'users',
      ]);
    }
  });

  it('initializes current defaults and constraints without incremental ALTERs', () => {
    const db = openSqliteDatabase(':memory:');
    try {
      db.exec(loadMigrations('sqlite')[0]!.sql);
      db.exec(`
        INSERT INTO users (id, email, password_hash, display_name, role, created_at, updated_at)
          VALUES ('u', 'user@example.test', 'unused', 'User', 'client', 'now', 'now');
        INSERT INTO message_threads (id, subject, created_by, participant_a, created_at, updated_at)
          VALUES ('t', 'Subject', 'u', 'u', 'now', 'now');
        INSERT INTO messages (id, thread_id, sender_user_id, body, created_at, updated_at)
          VALUES ('m', 't', 'u', 'Message', 'now', 'now');
        INSERT INTO email_outbox (id, to_email, subject, body_html, body_text, created_at, updated_at)
          VALUES ('e', 'user@example.test', 'Subject', '<p>Body</p>', 'Body', 'now', 'now');
        INSERT INTO gateway_teardown_jobs (id, user_id, created_at, updated_at)
          VALUES ('j', 'u', 'now', 'now');
        INSERT INTO credential_metadata
          (id, user_id, ferrum_consumer_id, credential_type, ferrum_credential_id,
           fingerprint, last4, edge_ordinal, created_at, updated_at)
          VALUES ('c', 'u', 'consumer', 'keyauth', 'keyauth:0', 'fp', '1234', 1, 'now', 'now');
      `);
      assert.deepEqual(db.prepare('SELECT broadcast FROM messages').get(), { broadcast: 0 });
      for (const table of ['email_outbox', 'gateway_teardown_jobs']) {
        assert.deepEqual(db.prepare(`SELECT generation FROM ${table}`).get(), { generation: '' });
      }
      assert.throws(() => db.exec('UPDATE messages SET broadcast = 2'), /CHECK constraint failed/);
      assert.throws(() => db.exec('UPDATE email_outbox SET generation = NULL'), /NOT NULL/);
      assert.throws(
        () =>
          db.exec(`
        INSERT INTO credential_metadata
          (id, user_id, ferrum_consumer_id, credential_type, ferrum_credential_id,
           fingerprint, last4, edge_ordinal, created_at, updated_at)
          VALUES ('c2', 'u', 'consumer', 'keyauth', 'keyauth:1', 'fp2', '5678', 1, 'now', 'now')
      `),
        /UNIQUE constraint failed/,
      );
      assert.deepEqual(db.pragma('foreign_key_check'), []);
    } finally {
      db.close();
    }
  });
});
