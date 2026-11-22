/**
 * `npm run migrate --workspace server`
 *
 * Loads the environment, builds the configured store, creates the base schema
 * in an empty database (or confirms an existing one is at it) and exits. The
 * server does the same on boot, so this exists for deployments that create the
 * schema as a separate step.
 *
 * It never upgrades a database: before 1.0 there is no upgrade path, and a
 * database created by an earlier version is refused with an error telling the
 * operator to recreate it (`schema.ts`; docs/operations.md, "Schema and
 * upgrades before 1.0").
 */

import { environmentWithEnvFile } from '../config/env-file.js';
import { loadConfig } from '../config/index.js';
import { isNexusError } from '../lib/errors.js';
import { createStore } from './index.js';

async function main(): Promise<void> {
  // The documented quickstart edits a root `.env`; exported variables win.
  const { env, file } = environmentWithEnvFile();
  if (file !== null) process.stdout.write(`Loaded ${file}\n`);
  const config = loadConfig(env);
  const store = createStore(config);
  try {
    await store.init();
    await store.migrate();
    process.stdout.write(`Schema ready (driver: ${store.driver}).\n`);
  } finally {
    await store.close();
  }
}

main().catch((error: unknown) => {
  if (isNexusError(error)) {
    process.stderr.write(`${error.message}\n`);
  } else {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
  }
  process.exitCode = 1;
});
