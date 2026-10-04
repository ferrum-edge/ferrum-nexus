import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createSqliteMigrationDriver, openSqliteDatabase } from './adapters/sqlite/index.js';
import { loadMigrations, runMigrations, splitSqlStatements } from './migrate.js';

describe('buildout schema baseline', () => {
  it('ships one complete initial schema for each SQL dialect', () => {
    for (const dialect of ['sqlite', 'pg', 'mysql'] as const) {
      const files = loadMigrations(dialect);
      assert.deepEqual(
        files.map((file) => file.id),
        [
          '001_initial',
          '002_api_gateway_plugins',
          '003_messages_thread_latest',
          '004_api_spec_changes',
          '005_notification_preferences',
          '006_user_identities',
          '007_outbox_recipient',
          '008_email_lifecycle_fence',
          '009_outbox_priority',
        ],
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
        'applications',
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

  it('adds the first-class plugin ownership table as a replayable forward migration', () => {
    for (const dialect of ['sqlite', 'pg', 'mysql'] as const) {
      const forward = loadMigrations(dialect).find((file) => file.id === '002_api_gateway_plugins');
      assert.ok(forward, `${dialect} ships 002_api_gateway_plugins`);
      // This migration is replayable without metadata checks.
      const statements = splitSqlStatements(forward.sql);
      assert.deepEqual(
        statements.map((statement) => /^CREATE TABLE IF NOT EXISTS (\w+)/.exec(statement)?.[1]),
        ['api_gateway_plugins'],
      );
    }

    const db = openSqliteDatabase(':memory:');
    try {
      for (const file of loadMigrations('sqlite')) db.exec(file.sql);
      db.exec(`
        INSERT INTO users (id, email, password_hash, display_name, role, created_at, updated_at)
          VALUES ('u', 'user@example.test', 'unused', 'User', 'provider', 'now', 'now');
        INSERT INTO apis (id, name, slug, owner_user_id, namespace, version, auth_plugin,
                          created_at, updated_at)
          VALUES ('a', 'API', 'api', 'u', 'ferrum', '1.0.0', 'key_auth', 'now', 'now');
        INSERT INTO api_gateway_plugins (api_id, role, ferrum_plugin_config_id, created_at, updated_at)
          VALUES ('a', 'rate_limit', 'config', 'now', 'now');
        -- A role recorded as owning no config.
        INSERT INTO api_gateway_plugins (api_id, role, ferrum_plugin_config_id, created_at, updated_at)
          VALUES ('a', 'cors', NULL, 'now', 'now');
      `);
      assert.throws(
        () =>
          db.exec(`
        INSERT INTO api_gateway_plugins (api_id, role, ferrum_plugin_config_id, created_at, updated_at)
          VALUES ('a', 'rate_limit', 'other', 'now', 'now')
      `),
        /UNIQUE constraint failed|PRIMARY KEY/,
      );
      assert.throws(
        () =>
          db.exec(`
        INSERT INTO api_gateway_plugins (api_id, role, ferrum_plugin_config_id, created_at, updated_at)
          VALUES ('a', 'palette', 'other', 'now', 'now')
      `),
        /CHECK constraint failed/,
      );
      // Deleting the API takes its ownership record with it.
      db.exec("DELETE FROM apis WHERE id = 'a'");
      assert.deepEqual(db.prepare('SELECT COUNT(*) AS n FROM api_gateway_plugins').get(), { n: 0 });
    } finally {
      db.close();
    }
  });

  it("replaces the messages thread index with one that serves a thread's newest message", async () => {
    // InnoDB already suffixes secondary indexes with the primary key, so the
    // MySQL step is intentionally empty, which its runner accepts.
    const mysqlStep = loadMigrations('mysql').find(
      (file) => file.id === '003_messages_thread_latest',
    );
    assert.ok(mysqlStep, 'mysql ships 003_messages_thread_latest');
    assert.deepEqual(splitSqlStatements(mysqlStep.sql), []);

    const db = openSqliteDatabase(':memory:');
    try {
      await runMigrations(createSqliteMigrationDriver(db), loadMigrations('sqlite'));
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'messages'")
        .all()
        .map((row) => (row as { name: string }).name);
      assert.ok(indexes.includes('ix_messages_thread_latest'));
      assert.equal(indexes.includes('ix_messages_thread'), false, 'the old index is dropped');

      // The per-thread subquery of `findLatestByThreads`: the `id` tie-break
      // comes from the index, not from a temporary sort of the thread.
      const plan = db
        .prepare(
          'EXPLAIN QUERY PLAN SELECT n.id FROM messages AS n WHERE n.thread_id = ? ' +
            'ORDER BY n.created_at DESC, n.id DESC LIMIT 1',
        )
        .all('t')
        .map((row) => String((row as { detail: unknown }).detail));
      assert.ok(
        plan.some((detail) => detail.includes('ix_messages_thread_latest')),
        plan.join('\n'),
      );
      assert.equal(
        plan.some((detail) => detail.includes('TEMP B-TREE')),
        false,
        plan.join('\n'),
      );
    } finally {
      db.close();
    }
  });

  it('adds the revision change history as a replayable forward migration', () => {
    const mysqlStep = loadMigrations('mysql').find((file) => file.id === '004_api_spec_changes');
    assert.ok(mysqlStep, 'mysql ships 004_api_spec_changes');
    // This migration is replayable without metadata checks.
    assert.deepEqual(
      splitSqlStatements(mysqlStep.sql).map(
        (statement) => /^CREATE TABLE IF NOT EXISTS (\w+)/.exec(statement)?.[1],
      ),
      ['api_spec_changes'],
    );

    const db = openSqliteDatabase(':memory:');
    try {
      for (const file of loadMigrations('sqlite')) db.exec(file.sql);
      const sql =
        'INSERT INTO api_spec_changes (id, api_id, spec_id, kind, version, revision_seq, ' +
        'report_json, created_at, updated_at) ' +
        "VALUES (?, 'a', ?, ?, '2.0.0', ?, '{}', 'now', 'now')";
      const insert = (id: string, specId: string, seq: number, kind = 'update'): void => {
        db.prepare(sql).run(id, specId, kind, seq);
      };
      db.exec(`
        INSERT INTO users (id, email, password_hash, display_name, role, created_at, updated_at)
          VALUES ('u', 'user@example.test', 'unused', 'User', 'provider', 'now', 'now');
        INSERT INTO apis (id, name, slug, owner_user_id, namespace, version, auth_plugin,
                          created_at, updated_at)
          VALUES ('a', 'API', 'api', 'u', 'ferrum', '1.0.0', 'key_auth', 'now', 'now');
      `);
      // No foreign key to the revision: the summary outlives its document.
      insert('c1', 'pruned-revision', 2);
      assert.throws(() => insert('c2', 'pruned-revision', 3), /UNIQUE constraint failed/);
      assert.throws(() => insert('c3', 'other-revision', 2), /UNIQUE constraint failed/);
      assert.throws(() => insert('c4', 'third-revision', 4, 'publish'), /CHECK constraint failed/);
      // Deleting the API takes its history with it.
      db.exec("DELETE FROM apis WHERE id = 'a'");
      assert.deepEqual(db.prepare('SELECT COUNT(*) AS n FROM api_spec_changes').get(), { n: 0 });
    } finally {
      db.close();
    }
  });

  it('adds identity-provider links, proofs and password locks as a replayable migration', () => {
    for (const dialect of ['sqlite', 'pg', 'mysql'] as const) {
      const forward = loadMigrations(dialect).find((file) => file.id === '006_user_identities');
      assert.ok(forward, `${dialect} ships 006_user_identities`);
      // This migration is replayable without metadata checks.
      const statements = splitSqlStatements(forward.sql);
      assert.deepEqual(
        statements.map((statement) => /^CREATE TABLE IF NOT EXISTS (\w+)/.exec(statement)?.[1]),
        ['user_identities', 'user_email_proofs', 'user_password_locks'],
      );
    }

    const db = openSqliteDatabase(':memory:');
    try {
      for (const file of loadMigrations('sqlite')) db.exec(file.sql);
      const link = (id: string, user: string, provider: string, issuer: string, sub: string) =>
        db
          .prepare(
            'INSERT INTO user_identities (id, user_id, provider_id, issuer, subject, ' +
              "created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'now', 'now')",
          )
          .run(id, user, provider, issuer, sub);
      db.exec(`
        INSERT INTO users (id, email, password_hash, display_name, role, created_at, updated_at)
          VALUES ('u', 'user@example.test', 'unused', 'User', 'client', 'now', 'now');
        INSERT INTO users (id, email, password_hash, display_name, role, created_at, updated_at)
          VALUES ('v', 'other@example.test', 'unused', 'Other', 'client', 'now', 'now');
      `);
      link('i', 'u', 'corp', 'https://a.example', 'subject-1');
      // One account per subject at a provider and issuer…
      assert.throws(
        () => link('j', 'v', 'corp', 'https://a.example', 'subject-1'),
        /UNIQUE constraint failed/,
      );
      // …one identity per account at a provider…
      assert.throws(
        () => link('k', 'u', 'corp', 'https://a.example', 'subject-2'),
        /UNIQUE constraint failed/,
      );
      // …and the same subject under another issuer is another identity.
      link('l', 'v', 'corp', 'https://b.example', 'subject-1');
      // Subjects are compared case-sensitively, as OpenID Connect requires.
      link('m', 'v', 'partner', 'https://a.example', 'SUBJECT-1');
      const first = db.prepare("SELECT provisioned FROM user_identities WHERE id = 'i'").get();
      assert.deepEqual(first, { provisioned: 0 });

      db.exec(`
        INSERT INTO user_email_proofs (user_id, email, method, proven_at, created_at, updated_at)
          VALUES ('u', 'user@example.test', 'verification_link', 'now', 'now', 'now');
      `);
      assert.throws(
        () =>
          db.exec(`
        INSERT INTO user_email_proofs (user_id, email, method, proven_at, created_at, updated_at)
          VALUES ('v', 'other@example.test', 'said-so', 'now', 'now', 'now')
      `),
        /CHECK constraint failed/,
      );
      db.exec(`
        INSERT INTO user_password_locks (user_id, provider_id, created_at)
          VALUES ('u', 'corp', 'now');
      `);
      // Deleting the account takes its links, its proof and its lock with it.
      db.exec("DELETE FROM users WHERE id = 'u'");
      const remaining = db.prepare('SELECT id FROM user_identities ORDER BY id').all();
      assert.deepEqual(remaining, [{ id: 'l' }, { id: 'm' }]);
      assert.deepEqual(db.prepare('SELECT COUNT(*) AS n FROM user_email_proofs').get(), { n: 0 });
      assert.deepEqual(db.prepare('SELECT COUNT(*) AS n FROM user_password_locks').get(), { n: 0 });
    } finally {
      db.close();
    }
  });
});
