/**
 * FROZEN FIXTURE — NEVER EDIT ANYTHING IN THIS DIRECTORY.
 *
 * A Ferrum Nexus v0.6.0 database, as data, for the upgrade tests
 * (`schema-upgrade.test.ts`):
 *
 * - `base.sql`, `base.pg.sql`, `base.mysql.sql`: byte-for-byte
 *   `git show v0.6.0:server/src/db/schema/<file>`;
 * - `mongodb-base-indexes.ts`: v0.6.0's `BASE_INDEXES`, copied verbatim;
 * - {@link V0_6_0_LEDGER_DDL}: the `schema_migrations` table v0.6.0's adapters
 *   created (`id` and `applied_at` only), and {@link V0_6_0_LEDGER_ID}, the one
 *   entry v0.6.0 recorded.
 *
 * These describe what is already deployed, so they never change, whatever the
 * live schema does. `frozen-baseline.test.ts` pins each file's checksum in
 * {@link V0_6_0_FIXTURE_SHA256}.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { SchemaDialect } from '../../../db/schema.js';

export { V0_6_0_BASE_INDEXES } from './mongodb-base-indexes.js';

/** The ledger id v0.6.0 recorded for its base schema. */
export const V0_6_0_LEDGER_ID = '000_base_v0_6';

/** The ledger table v0.6.0 created, per dialect (from its adapters' `ensureLedger`). */
export const V0_6_0_LEDGER_DDL: Readonly<Record<SchemaDialect, string>> = {
  sqlite:
    'CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
  pg: 'CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
  mysql:
    'CREATE TABLE IF NOT EXISTS schema_migrations (id VARCHAR(191) NOT NULL, ' +
    'applied_at VARCHAR(32) NOT NULL, PRIMARY KEY (id)) ' +
    'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin',
};

/** The fixture files, with the SHA-256 each must keep forever. */
export const V0_6_0_FIXTURE_SHA256: Readonly<Record<string, string>> = {
  'base.sql': '6a210341546b9628292bda6e90aa104dd02584c372b25490148fc8c281a0bb4e',
  'base.pg.sql': '16134a96b09fe31c4a508ad125fe31d1340f78ba5662c57728365fd1d8844b45',
  'base.mysql.sql': '47c01e8c3f28d54cba7ade2fccf1a7ecae792e979f18f91666d6b121b727db39',
  'mongodb-base-indexes.ts': 'cd49e14c5f0c92cf2f3a25e6c2bba9a734be4ed466bdd39987280990b32a2e38',
};

const FILE_FOR: Readonly<Record<SchemaDialect, string>> = {
  sqlite: 'base.sql',
  pg: 'base.pg.sql',
  mysql: 'base.mysql.sql',
};

/** This directory, in the source tree the tests run from. */
export function fixtureDir(): string {
  return fileURLToPath(new URL('./', import.meta.url));
}

/** v0.6.0's base schema SQL for a dialect. */
export function v060BaseSql(dialect: SchemaDialect): string {
  return readFileSync(join(fixtureDir(), FILE_FOR[dialect]), 'utf8');
}
