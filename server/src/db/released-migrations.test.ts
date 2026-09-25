/**
 * The released-migration guard (issue #286).
 *
 * A database a release created is upgraded by applying the migrations it has
 * not recorded yet — so a released migration that changes afterwards is one
 * that existing databases will never see, and fresh and upgraded installs
 * silently diverge. These checks fail that change in CI. See
 * `released-migrations.ts` for the manifest and its rules.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { MONGO_MIGRATIONS } from './adapters/mongodb/index.js';
import { loadMigrations, migrationsDir } from './migrate.js';
import {
  RELEASED_MIGRATIONS,
  type ReleasedMigration,
  type ReleasedMigrationBackend,
} from './released-migrations.js';

const BACKENDS: readonly ReleasedMigrationBackend[] = ['sqlite', 'pg', 'mysql', 'mongodb'];

const SQL_SUFFIX = { sqlite: '.sql', pg: '.pg.sql', mysql: '.mysql.sql' } as const;

const POLICY = 'docs/operations.md, "Schema versioning and upgrades"';

/** Where a backend's frozen artifact for `id` lives. */
function artifactPath(id: string, backend: ReleasedMigrationBackend): string {
  if (backend === 'mongodb') {
    return join(fileURLToPath(new URL('./released/', import.meta.url)), `${id}.mongodb.json`);
  }
  return join(migrationsDir(), `${id}${SQL_SUFFIX[backend]}`);
}

/** SHA-256 of a text file with CRLF normalised to LF. */
function checksum(path: string): string {
  const text = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  return createHash('sha256').update(text).digest('hex');
}

/** Every migration id a backend applies, in the order the runner applies them. */
function migrationIds(backend: ReleasedMigrationBackend): string[] {
  if (backend === 'mongodb') {
    return MONGO_MIGRATIONS.map((step) => step.id).sort((a, b) => a.localeCompare(b));
  }
  return loadMigrations(backend).map((file) => file.id);
}

/** What to do about a changed artifact, which depends on whether it has shipped. */
function remedy(
  entry: ReleasedMigration,
  backend: ReleasedMigrationBackend,
  actual: string,
): string {
  if (entry.release === null) {
    return (
      `${entry.id} is the buildout baseline awaiting the first supported release. If this ` +
      `edit is intended, set its ${backend} checksum in server/src/db/released-migrations.ts ` +
      `to ${actual} in the same change.`
    );
  }
  return (
    `${entry.id} shipped in ${entry.release} and is immutable: databases created by that ` +
    `release will never re-run it. Revert the edit and add a new forward migration instead ` +
    `(${POLICY}).`
  );
}

/** The same, for a MongoDB step whose indexes no longer match its snapshot. */
function mongoRemedy(entry: ReleasedMigration): string {
  if (entry.release === null) {
    return (
      `${entry.id}'s MongoDB indexes changed. If this edit is intended, update ` +
      `server/src/db/released/${entry.id}.mongodb.json to match, then its mongodb checksum.`
    );
  }
  return (
    `${entry.id} shipped in ${entry.release}; its MongoDB indexes are immutable. Add a new ` +
    `step to MONGO_MIGRATIONS instead (${POLICY}).`
  );
}

/** An index definition, from code or from a snapshot, before canonicalisation. */
interface IndexLike {
  collection: unknown;
  name: unknown;
  key: unknown;
  unique?: unknown;
  partialFilterExpression?: unknown;
}

/** A committed `released/<id>.mongodb.json` snapshot. */
interface MongoSnapshot {
  id: string;
  indexes: IndexLike[];
}

/**
 * Comparable form of an index. The key becomes an ordered list of entries
 * because a compound index's field order is part of the index — `{ a, b }` and
 * `{ b, a }` are different indexes, which a plain deep-equal of the two
 * objects would not notice.
 */
function canonicalIndex(index: IndexLike): unknown {
  const key = index.key;
  assert.ok(
    key !== null && typeof key === 'object' && !Array.isArray(key) && !(key instanceof Map),
    `index ${String(index.name)} must declare its key as a plain object`,
  );
  return {
    collection: index.collection,
    name: index.name,
    key: Object.entries(key),
    unique: index.unique === true,
    partialFilterExpression: index.partialFilterExpression ?? null,
  };
}

describe('released migrations', () => {
  it('lists each released migration once, in id order, with well-formed checksums', () => {
    assert.ok(RELEASED_MIGRATIONS.length > 0, 'the baseline must be listed');
    let pendingSeen = false;
    RELEASED_MIGRATIONS.forEach((entry, index) => {
      const previous = RELEASED_MIGRATIONS[index - 1];
      if (previous) {
        assert.ok(previous.id.localeCompare(entry.id) < 0, `${entry.id} is out of order`);
      }
      if (entry.release === null) {
        pendingSeen = true;
      } else {
        assert.ok(!pendingSeen, `${entry.id} is released after an unreleased migration`);
        assert.match(entry.release, /^v\d+\.\d+\.\d+$/, `${entry.id} names a release tag`);
      }
      for (const backend of BACKENDS) {
        assert.match(entry.sha256[backend], /^[0-9a-f]{64}$/, `${entry.id} ${backend} checksum`);
      }
    });
  });

  it('keeps every released migration exactly as it shipped', () => {
    for (const entry of RELEASED_MIGRATIONS) {
      for (const backend of BACKENDS) {
        const path = artifactPath(entry.id, backend);
        assert.ok(
          existsSync(path),
          `${entry.id} (${backend}) is listed as released but ${path} is missing. Released ` +
            `migrations are never deleted or renamed (${POLICY}).`,
        );
        const actual = checksum(path);
        assert.equal(actual, entry.sha256[backend], remedy(entry, backend, actual));
      }
    }
  });

  it('applies the same migration ids on every backend', () => {
    const sqlite = migrationIds('sqlite');
    for (const backend of BACKENDS) {
      assert.deepEqual(
        migrationIds(backend),
        sqlite,
        `${backend} must implement exactly the migration ids SQLite does`,
      );
    }
  });

  it('only adds migrations after the released ones', () => {
    const released = RELEASED_MIGRATIONS.map((entry) => entry.id);
    for (const backend of BACKENDS) {
      const ids = migrationIds(backend);
      // A new migration that sorts before a released id would be applied out
      // of order on an upgraded database and in order on a fresh one.
      assert.deepEqual(
        ids.slice(0, released.length),
        released,
        `${backend}: released migrations must stay the leading, unchanged prefix; give a new ` +
          `migration an id after ${released.at(-1) ?? 'the baseline'} (${POLICY}).`,
      );
    }
  });

  it('keeps each released MongoDB step equal to its frozen snapshot', () => {
    for (const entry of RELEASED_MIGRATIONS) {
      const step = MONGO_MIGRATIONS.find((candidate) => candidate.id === entry.id);
      assert.ok(step, `MongoDB has no step for released migration ${entry.id}`);
      const text = readFileSync(artifactPath(entry.id, 'mongodb'), 'utf8');
      const snapshot = JSON.parse(text) as MongoSnapshot;
      assert.equal(snapshot.id, entry.id);
      assert.deepEqual(
        step.indexes.map(canonicalIndex),
        snapshot.indexes.map(canonicalIndex),
        mongoRemedy(entry),
      );
    }
  });
});
