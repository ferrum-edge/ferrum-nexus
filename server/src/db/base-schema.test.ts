import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createSqliteSchemaDriver, openSqliteDatabase } from './adapters/sqlite/index.js';
import { ensureBaseSchema, loadBaseSchema, splitSqlStatements } from './schema.js';

const CREATE_STATEMENT = /^CREATE\s/;
const CREATE_TABLE_IF_NOT_EXISTS = /^CREATE TABLE IF NOT EXISTS (\w+)/;
const CHECK_CONSTRAINT_FAILED = /CHECK constraint failed/;
const NOT_NULL = /NOT NULL/;
const UNIQUE_CONSTRAINT_FAILED = /UNIQUE constraint failed/;
const UNIQUE_CONSTRAINT_FAILED_PRIMARY = /UNIQUE constraint failed|PRIMARY KEY/;

/** A fresh in-memory SQLite database at the base schema. */
function baseDatabase(): ReturnType<typeof openSqliteDatabase> {
  const db = openSqliteDatabase(':memory:');
  db.exec(loadBaseSchema('sqlite').sql);
  return db;
}

describe('base schema', () => {
  it('ships one complete base schema for each SQL dialect, with the same tables', () => {
    for (const dialect of ['sqlite', 'pg', 'mysql'] as const) {
      const statements = splitSqlStatements(loadBaseSchema(dialect).sql);
      assert.ok(statements.length > 0);
      assert.ok(statements.every((statement) => CREATE_STATEMENT.test(statement)));
      if (dialect === 'mysql') {
        // MySQL DDL commits on its own, so its schema must be replayable as a
        // whole: only CREATE TABLE IF NOT EXISTS, with every index inline.
        assert.ok(statements.every((statement) => CREATE_TABLE_IF_NOT_EXISTS.test(statement)));
      }
      const tables = statements.flatMap((statement) => {
        const match = CREATE_TABLE_IF_NOT_EXISTS.exec(statement);
        return match ? [match[1]] : [];
      });
      assert.deepEqual(tables.sort(), [
        'access_gateway_jobs',
        'access_requests',
        'account_recovery_jobs',
        'api_gateway_plugins',
        'api_plugins',
        'api_spec_changes',
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
        'user_email_proofs',
        'user_identities',
        'user_notification_preferences',
        'user_password_locks',
        'users',
      ]);
    }
  });

  it('creates every column the stores write, with its default', () => {
    const db = baseDatabase();
    try {
      db.exec(`
        INSERT INTO users (id, email, password_hash, display_name, role, created_at, updated_at)
          VALUES ('u', 'user@example.test', 'unused', 'User', 'provider', 'now', 'now');
        INSERT INTO apis (id, name, slug, owner_user_id, namespace, version, auth_plugin,
                          created_at, updated_at)
          VALUES ('a', 'API', 'api', 'u', 'ferrum', '1.0.0', 'key_auth', 'now', 'now');
        INSERT INTO access_requests (id, api_id, user_id, justification, created_at, updated_at)
          VALUES ('r', 'a', 'u', 'Because', 'now', 'now');
        INSERT INTO grants (id, api_id, user_id, acl_group, granted_by, created_at, updated_at)
          VALUES ('g', 'a', 'u', 'group', 'u', 'now', 'now');
        INSERT INTO email_outbox (id, to_email, subject, body_html, body_text, created_at, updated_at)
          VALUES ('e', 'user@example.test', 'Subject', '<p>Body</p>', 'Body', 'now', 'now');
      `);
      assert.deepEqual(db.prepare('SELECT email_lifecycle_fence FROM users').get(), {
        email_lifecycle_fence: '',
      });
      assert.deepEqual(db.prepare('SELECT agents_json FROM apis').get(), { agents_json: null });
      assert.deepEqual(
        db
          .prepare('SELECT requested_tools_json, approved_tools_json, grant_id FROM access_requests')
          .get(),
        { requested_tools_json: null, approved_tools_json: null, grant_id: null },
      );
      assert.deepEqual(db.prepare('SELECT approved_tools_json FROM grants').get(), {
        approved_tools_json: null,
      });
      // Mail is normal priority (1) and unbound unless the writer says otherwise.
      assert.deepEqual(db.prepare('SELECT recipient_user_id, priority FROM email_outbox').get(), {
        recipient_user_id: null,
        priority: 1,
      });
      for (const table of ['account_recovery_jobs', 'access_gateway_jobs']) {
        assert.deepEqual(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get(), { n: 0 });
      }
    } finally {
      db.close();
    }
  });

  it('initializes current defaults and constraints', () => {
    const db = baseDatabase();
    try {
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
      assert.throws(() => db.exec('UPDATE messages SET broadcast = 2'), CHECK_CONSTRAINT_FAILED);
      assert.throws(() => db.exec('UPDATE email_outbox SET generation = NULL'), NOT_NULL);
      assert.throws(
        () =>
          db.exec(`
        INSERT INTO credential_metadata
          (id, user_id, ferrum_consumer_id, credential_type, ferrum_credential_id,
           fingerprint, last4, edge_ordinal, created_at, updated_at)
          VALUES ('c2', 'u', 'consumer', 'keyauth', 'keyauth:1', 'fp2', '5678', 1, 'now', 'now')
      `),
        UNIQUE_CONSTRAINT_FAILED,
      );
      assert.deepEqual(db.pragma('foreign_key_check'), []);
    } finally {
      db.close();
    }
  });

  it('keys first-class plugin ownership by API and role', () => {
    const db = baseDatabase();
    try {
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
        UNIQUE_CONSTRAINT_FAILED_PRIMARY,
      );
      assert.throws(
        () =>
          db.exec(`
        INSERT INTO api_gateway_plugins (api_id, role, ferrum_plugin_config_id, created_at, updated_at)
          VALUES ('a', 'palette', 'other', 'now', 'now')
      `),
        CHECK_CONSTRAINT_FAILED,
      );
      // Deleting the API takes its ownership record with it.
      db.exec("DELETE FROM apis WHERE id = 'a'");
      assert.deepEqual(db.prepare('SELECT COUNT(*) AS n FROM api_gateway_plugins').get(), { n: 0 });
    } finally {
      db.close();
    }
  });

  it("indexes messages so a thread's newest message is one index seek", async () => {
    // InnoDB already suffixes secondary indexes with the primary key, so MySQL
    // keeps `ix_messages_thread (thread_id, created_at)`, which is
    // `(thread_id, created_at, id)` there.
    assert.match(loadBaseSchema('mysql').sql, /KEY ix_messages_thread \(thread_id, created_at\)/);
    assert.match(
      loadBaseSchema('pg').sql,
      /ix_messages_thread_latest ON messages \(thread_id, created_at, id\)/,
    );

    const db = openSqliteDatabase(':memory:');
    try {
      await ensureBaseSchema(createSqliteSchemaDriver(db), loadBaseSchema('sqlite'));
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'messages'")
        .all()
        .map((row) => (row as { name: string }).name);
      assert.ok(indexes.includes('ix_messages_thread_latest'));
      assert.equal(indexes.includes('ix_messages_thread'), false);

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

  it('keeps one change summary per revision, outliving the revision itself', () => {
    const db = baseDatabase();
    try {
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
      assert.throws(() => insert('c2', 'pruned-revision', 3), UNIQUE_CONSTRAINT_FAILED);
      assert.throws(() => insert('c3', 'other-revision', 2), UNIQUE_CONSTRAINT_FAILED);
      assert.throws(() => insert('c4', 'third-revision', 4, 'publish'), CHECK_CONSTRAINT_FAILED);
      // Deleting the API takes its history with it.
      db.exec("DELETE FROM apis WHERE id = 'a'");
      assert.deepEqual(db.prepare('SELECT COUNT(*) AS n FROM api_spec_changes').get(), { n: 0 });
    } finally {
      db.close();
    }
  });

  it('keys identity-provider links, proofs and password locks to the account', () => {
    const db = baseDatabase();
    try {
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
        UNIQUE_CONSTRAINT_FAILED,
      );
      // …one identity per account at a provider…
      assert.throws(
        () => link('k', 'u', 'corp', 'https://a.example', 'subject-2'),
        UNIQUE_CONSTRAINT_FAILED,
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
        CHECK_CONSTRAINT_FAILED,
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
