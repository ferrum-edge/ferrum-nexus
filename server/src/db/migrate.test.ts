/**
 * A failed migration names itself (issue #678).
 *
 * The upgrade runbook says a failed migration "names the migration", but the
 * runner used to pass the bare driver error through, so an operator saw only
 * the SQL error. These check the runner's error on a real SQLite driver and
 * with a stub driver for the cases a driver cannot easily produce.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { conflict } from '../lib/errors.js';
import { createSqliteMigrationDriver, openSqliteDatabase } from './adapters/sqlite/index.js';
import { runMigrations, type MigrationDriver, type MigrationFile } from './migrate.js';

const NAMES_BROKEN_MIGRATION = /^Migration 002_broken failed: .*no such table: missing_table/;

function file(id: string, sql: string): MigrationFile {
  return { id, filename: `${id}.sql`, sql };
}

/** A driver whose `applyMigration` throws `failure` for `failingId`. */
function stubDriver(failingId: string, failure: unknown): MigrationDriver & { applied: string[] } {
  const applied: string[] = [];
  return {
    applied,
    async ensureMigrationsTable() {},
    async listApplied() {
      return [];
    },
    async applyMigration(migration) {
      if (migration.id === failingId) throw failure;
      applied.push(migration.id);
    },
  };
}

describe('runMigrations failures', () => {
  it('names the failed migration and keeps the earlier ones applied', async () => {
    const db = openSqliteDatabase(':memory:');
    try {
      const driver = createSqliteMigrationDriver(db);
      const migrations = [
        file('001_ok', 'CREATE TABLE kept (id TEXT PRIMARY KEY);'),
        file('002_broken', 'ALTER TABLE missing_table ADD COLUMN extra TEXT;'),
        file('003_later', 'CREATE TABLE never (id TEXT PRIMARY KEY);'),
      ];
      await assert.rejects(runMigrations(driver, migrations), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, NAMES_BROKEN_MIGRATION);
        assert.ok(error.cause instanceof Error, 'the driver error is kept as the cause');
        return true;
      });
      assert.deepEqual(await driver.listApplied(), ['001_ok']);
    } finally {
      db.close();
    }
  });

  it('keeps the driver error, code included, as the cause', async () => {
    const driverError = Object.assign(new Error('Lock wait timeout exceeded'), {
      code: 'ER_LOCK_WAIT_TIMEOUT',
    });
    const driver = stubDriver('002_slow', driverError);
    await assert.rejects(
      runMigrations(driver, [file('001_ok', ''), file('002_slow', ''), file('003_later', '')]),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, 'Migration 002_slow failed: Lock wait timeout exceeded');
        assert.equal(error.cause, driverError);
        return true;
      },
    );
    assert.deepEqual(driver.applied, ['001_ok']);
  });

  it('passes a NexusError through unchanged', async () => {
    const refusal = conflict('Another migrator holds the lock');
    const driver = stubDriver('001_refused', refusal);
    await assert.rejects(runMigrations(driver, [file('001_refused', '')]), (error: unknown) => {
      assert.equal(error, refusal);
      return true;
    });
  });

  it('names a migration that threw something other than an Error', async () => {
    const driver = stubDriver('001_odd', 'plain string failure');
    await assert.rejects(runMigrations(driver, [file('001_odd', '')]), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'Migration 001_odd failed: plain string failure');
      return true;
    });
  });
});
