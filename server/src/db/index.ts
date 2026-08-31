/**
 * Store factory — the one place that knows which adapter backs which driver.
 */

import type { NexusConfig } from '../config/index.js';
import { NexusError } from '../lib/errors.js';
import { createSqliteStore } from './adapters/sqlite/index.js';
import type { NexusStore } from './store.js';

/**
 * Build the {@link NexusStore} for a configuration.
 *
 * The caller is responsible for `await store.init()` and `await store.migrate()`
 * before handing the store to services.
 */
export function createStore(config: NexusConfig): NexusStore {
  switch (config.db.driver) {
    case 'sqlite':
      return createSqliteStore(config);
    // TODO(adapters): replace these three branches with
    //   case 'postgres': return createPostgresStore(config);
    //   case 'mysql':    return createMysqlStore(config);
    //   case 'mongodb':  return createMongoStore(config);
    // once db/adapters/{postgres,mysql,mongodb}/index.ts land. Everything else
    // in the server is already driver-agnostic — only this switch changes.
    case 'postgres':
    case 'mysql':
    case 'mongodb':
      throw new NexusError(
        'INTERNAL',
        `The '${config.db.driver}' database adapter is not yet wired up; set NEXUS_DB_DRIVER=sqlite`,
      );
    default: {
      const exhaustive: never = config.db.driver;
      throw new NexusError('INTERNAL', `Unknown database driver: ${String(exhaustive)}`);
    }
  }
}

export type { NexusStore } from './store.js';
