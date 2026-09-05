/**
 * `npm run migrate --workspace server`
 *
 * Loads the environment, builds the configured store, applies every pending
 * migration and exits. The server also migrates on boot, so this exists for
 * deployments that run schema changes as a separate step.
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
    process.stdout.write(`Migrations applied (driver: ${store.driver}).\n`);
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
