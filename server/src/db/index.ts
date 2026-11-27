/**
 * Store factory — the one place that knows which adapter backs which driver.
 */

import type { NexusConfig } from '../config/index.js';
import { NexusError } from '../lib/errors.js';
import { createMongoStore, type MongoMigrationStep } from './adapters/mongodb/index.js';
import { createMysqlStore } from './adapters/mysql/index.js';
import { createPostgresStore } from './adapters/postgres/index.js';
import { createSqliteStore } from './adapters/sqlite/index.js';
import type { SqlMigration } from './migrate.js';
import type { NexusStore } from './store.js';

/**
 * Forward migrations that replace the shipped ones, per backend. A **test
 * seam**: the upgrade tests register a probe migration through it. Production
 * never passes it, so every backend applies what `db/migrations/` and
 * `MONGO_MIGRATIONS` ship.
 */
export interface MigrationOverrides {
  sqlite?: readonly SqlMigration[];
  pg?: readonly SqlMigration[];
  mysql?: readonly SqlMigration[];
  mongodb?: readonly MongoMigrationStep[];
}

/** Options for {@link createStore}. */
export interface StoreOptions {
  /** See {@link MigrationOverrides}; tests only. */
  migrations?: MigrationOverrides;
}

/**
 * Build the {@link NexusStore} for a configuration.
 *
 * The caller is responsible for `await store.init()` and `await store.migrate()`
 * (which creates the base schema in an empty database, applies pending forward
 * migrations and refuses a database this build cannot run against; see
 * `migrate.ts`) before handing the store to services. `init()` is also where a
 * driver validates its deployment — notably the MongoDB replica-set check.
 */
export function createStore(config: NexusConfig, options: StoreOptions = {}): NexusStore {
  const migrations = options.migrations ?? {};
  switch (config.db.driver) {
    case 'sqlite':
      return createSqliteStore(config, migrations.sqlite);
    case 'postgres':
      return createPostgresStore(config, migrations.pg);
    case 'mysql':
      return createMysqlStore(config, migrations.mysql);
    case 'mongodb':
      return createMongoStore(config, migrations.mongodb);
    default: {
      const exhaustive: never = config.db.driver;
      throw new NexusError('INTERNAL', `Unknown database driver: ${String(exhaustive)}`);
    }
  }
}

export type { NexusStore } from './store.js';
