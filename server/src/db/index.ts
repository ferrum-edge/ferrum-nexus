/**
 * Store factory — the one place that knows which adapter backs which driver.
 */

import type { NexusConfig } from '../config/index.js';
import { NexusError } from '../lib/errors.js';
import { createMongoStore } from './adapters/mongodb/index.js';
import { createMysqlStore } from './adapters/mysql/index.js';
import { createPostgresStore } from './adapters/postgres/index.js';
import { createSqliteStore } from './adapters/sqlite/index.js';
import type { NexusStore } from './store.js';

/**
 * Build the {@link NexusStore} for a configuration.
 *
 * The caller is responsible for `await store.init()` and `await store.migrate()`
 * before handing the store to services. `init()` is also where a driver
 * validates its deployment — notably the MongoDB replica-set check.
 */
export function createStore(config: NexusConfig): NexusStore {
  switch (config.db.driver) {
    case 'sqlite':
      return createSqliteStore(config);
    case 'postgres':
      return createPostgresStore(config);
    case 'mysql':
      return createMysqlStore(config);
    case 'mongodb':
      return createMongoStore(config);
    default: {
      const exhaustive: never = config.db.driver;
      throw new NexusError('INTERNAL', `Unknown database driver: ${String(exhaustive)}`);
    }
  }
}

export type { NexusStore } from './store.js';
