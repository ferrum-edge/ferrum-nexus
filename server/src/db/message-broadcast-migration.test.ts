/**
 * Migration 017 against a table that already has rows.
 *
 * `broadcast` is a `NOT NULL DEFAULT 0` column added to a live `messages`
 * table, and `countBySenderSince` filters on it — so a portal that upgrades
 * with a year of correspondence in the table has to keep every one of those
 * rows countable. A default the adapter read back as `null`, or a filter that
 * silently excluded pre-migration rows, would hand every existing account a
 * fresh daily allowance at the moment of the upgrade.
 *
 * The 016 test next door checks the same shape for the outbox. This one goes
 * one step further and reads the row back through the store, because the column
 * is an integer on disk and a boolean in the {@link NexusStore} contract, and
 * the question is what the *service* sees.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { loadConfig } from '../config/index.js';
import { openSqliteDatabase } from './adapters/sqlite/index.js';
import { createStore } from './index.js';
import { loadMigrations } from './migrate.js';
import type { NexusStore } from './store.js';

/** The migration under test; never renumber it. */
const MIGRATION_ID = '017_message_broadcast';

/** Timestamp every seeded row carries, comfortably inside a 24-hour window. */
const AT = '2026-09-01T00:00:00.000Z';

/** Ids of the rows the pre-017 schema is seeded with. */
const SENDER = 'legacy-sender';
const RECIPIENT = 'legacy-recipient';
const THREAD = 'legacy-thread';
const MESSAGE = 'legacy-message';

describe('017 leaves the messages a portal already had', () => {
  let directory: string;
  let path: string;
  let store: NexusStore;

  before(async () => {
    directory = mkdtempSync(join(tmpdir(), 'nexus-017-'));
    path = join(directory, 'messages.sqlite');

    // Everything up to 016, then a message row — the state an upgrading portal
    // is actually in when 017 runs.
    const db = openSqliteDatabase(path);
    try {
      const migrations = loadMigrations('sqlite');
      const migration = migrations.find((entry) => entry.id === MIGRATION_ID);
      assert.ok(migration, `${MIGRATION_ID} is still there under that id`);
      db.exec(
        `CREATE TABLE IF NOT EXISTS schema_migrations (
           id TEXT PRIMARY KEY,
           applied_at TEXT NOT NULL
         )`,
      );
      const record = db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)');
      for (const entry of migrations.filter((entry) => entry.id < migration.id)) {
        db.exec(entry.sql);
        record.run(entry.id, AT);
      }

      const user = db.prepare(
        `INSERT INTO users
         (id, email, password_hash, display_name, role, status, email_verified,
          created_at, updated_at)
         VALUES (?, ?, 'scrypt:16384:8:1:c2FsdA==:aGFzaA==', ?, ?, 'active', 1, ?, ?)`,
      );
      user.run(SENDER, 'legacy-sender@example.test', 'Legacy Sender', 'client', AT, AT);
      user.run(RECIPIENT, 'legacy-recipient@example.test', 'Legacy Recipient', 'provider', AT, AT);
      db.prepare(
        `INSERT INTO message_threads
         (id, subject, api_id, created_by, participant_a, participant_b, last_message_at,
          created_at, updated_at)
         VALUES (?, 'Before the upgrade', NULL, ?, ?, ?, ?, ?, ?)`,
      ).run(THREAD, SENDER, SENDER, RECIPIENT, AT, AT, AT);
      db.prepare(
        `INSERT INTO messages (id, thread_id, sender_user_id, body, created_at, updated_at)
         VALUES (?, ?, ?, 'An ordinary message from before 017', ?, ?)`,
      ).run(MESSAGE, THREAD, SENDER, AT, AT);
    } finally {
      db.close();
    }

    // The real runner applies 017 (and anything after it) to that database.
    store = createStore(
      loadConfig({
        NEXUS_SECRET_KEY: 'message-broadcast-migration-secret-0123',
        FERRUM_ADMIN_JWT_SECRET: 'message-broadcast-migration-secret-0123',
        NEXUS_ENV: 'test',
        NEXUS_DB_DRIVER: 'sqlite',
        NEXUS_SQLITE_PATH: path,
      }),
    );
    await store.init();
    await store.migrate();
  });

  after(async () => {
    await store?.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('reads a pre-migration row back as an ordinary, non-broadcast message', async () => {
    const message = await store.messages.findById(MESSAGE);
    assert.ok(message, 'the row survived the migration');
    assert.equal(message.broadcast, false, 'a real boolean, never null or undefined');
    assert.equal(message.body, 'An ordinary message from before 017');
  });

  it('still counts it against its sender’s daily budget', async () => {
    assert.equal(
      await store.messages.countBySenderSince(SENDER, new Date(0).toISOString()),
      1,
      'the upgrade does not hand an existing account a fresh allowance',
    );
  });

  it('lists it with the flag alongside a broadcast row written after the upgrade', async () => {
    await store.messages.create({
      thread_id: THREAD,
      sender_user_id: SENDER,
      body: 'An announcement after the upgrade',
      broadcast: true,
    });
    const page = await store.messages.listByThread(THREAD, { limit: 50 });
    assert.deepEqual(
      page.items.map((item) => item.broadcast),
      [false, true],
      'the pre-migration row and the new one are told apart',
    );
    assert.equal(
      await store.messages.countBySenderSince(SENDER, new Date(0).toISOString()),
      1,
      'and only the ordinary one is counted',
    );
  });
});
