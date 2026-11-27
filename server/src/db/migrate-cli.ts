/**
 * `npm run migrate` (from a checkout) or `node server/dist/db/migrate-cli.js`
 * (in the image): the migrate command.
 *
 * Loads the environment, builds the configured store, creates the schema in an
 * empty database or applies every pending forward migration in order, and
 * exits. It is the only thing that upgrades a database: server startup creates
 * an empty one but refuses to start while migrations are pending. Run it once
 * per upgrade, with every Nexus instance stopped, after a backup.
 *
 * It takes an exclusive migration lock and refuses, exiting non-zero, while
 * another migrator holds it. `--force-unlock` first clears a lock a crashed
 * migrator left behind (MongoDB only; the other backends' locks end with
 * their session): use it only after confirming no migrator is running.
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

const USAGE = 'Usage: migrate-cli [--force-unlock]';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => arg !== '--force-unlock');
  if (unknown.length > 0) {
    process.stderr.write(`Unknown argument ${unknown[0]}. ${USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  const forceUnlock = args.includes('--force-unlock');
  // The documented quickstart edits a root `.env`; exported variables win.
  const { env, file } = environmentWithEnvFile();
  if (file !== null) process.stdout.write(`Loaded ${file}\n`);
  const config = loadConfig(env);
  const store = createStore(config);
  try {
    await store.init();
    if (forceUnlock) {
      process.stdout.write('Clearing any migration lock a crashed migrator left behind.\n');
    }
    await store.migrate({ mode: 'migrate', forceUnlock });
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
