import type { NexusStore } from './store.js';
import type { ResolvedConfig } from '../config/index.js';
import { createSqliteStore } from './adapters/sqlite/index.js';
import { createPostgresStore } from './adapters/postgres/index.js';
import { createMysqlStore } from './adapters/mysql/index.js';
import { createMongoStore } from './adapters/mongodb/index.js';

export async function createStore(config: ResolvedConfig): Promise<NexusStore> {
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
      throw new Error(`Unsupported NEXUS_DB_DRIVER: ${String(exhaustive)}`);
    }
  }
}

export type { NexusStore } from './store.js';
