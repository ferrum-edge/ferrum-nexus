/**
 * `npm run migrate --workspace server`
 *
 * Loads the environment, builds the configured store, creates the base schema
 * in an empty database, applies every pending forward migration in order, and
 * exits. The server does the same on boot, so this exists for deployments that
 * upgrade the schema as a separate step, with every instance stopped.
 *
 * A database this build cannot run against — created before v0.6.0, upgraded
 * by a newer release, or recording a migration whose checksum differs from
 * this build's — is refused unchanged with an error saying what to do
 * (`migrate.ts`; docs/operations.md, "Schema and upgrades").
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
