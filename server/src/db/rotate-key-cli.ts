/**
 * `npm run rotate-secret-key`
 *
 * Re-encrypts the encrypted `app_settings` rows from `NEXUS_SECRET_KEY_PREVIOUS`
 * to `NEXUS_SECRET_KEY`, so a master-key rotation does not lock administrators
 * out of a CAPTCHA-enabled portal or silently drop the SMTP password. Both keys
 * come from the environment, never from arguments, so neither appears in a
 * process listing or a shell history line. Run it with the server stopped (or
 * against a database no running instance is using), then start the server with
 * the new key. See `docs/operations.md` §7.
 */

import { pathToFileURL } from 'node:url';

import { rotateEncryptedSettings } from '../admin/rotate-key.js';
import { environmentWithEnvFile, readEnvFile } from '../config/env-file.js';
import { loadConfig } from '../config/index.js';
import { createCrypto } from '../lib/crypto.js';
import { isNexusError } from '../lib/errors.js';
import { createStore } from './index.js';

const MIN_KEY_LENGTH = 32;
const ALLOW_ENV_MISMATCH = '--allow-env-mismatch';

/**
 * Refuse to rotate when the `.env` file the CLI loaded declares a different
 * `NEXUS_SECRET_KEY` than the key the rotation would re-encrypt under.
 *
 * The real environment wins over `.env`, so an operator who exports a fresh key
 * in the shell while a `.env` beside it still names the old one would write
 * every setting under a key only that shell knows, and a restart reading the
 * file could no longer decrypt them. The message names the file and both roles,
 * and never prints a key value.
 */
export function assertEnvFileKeyConsistent(
  file: string | null,
  effectiveSecretKey: string,
  allowEnvMismatch: boolean,
): void {
  if (file === null || allowEnvMismatch) return;
  const fileKey = readEnvFile(file).NEXUS_SECRET_KEY;
  if (fileKey !== undefined && fileKey !== effectiveSecretKey) {
    throw new Error(
      `The .env file at ${file} declares a different NEXUS_SECRET_KEY than the key this ` +
        'rotation would re-encrypt under. The .env value is what the server will load on ' +
        'restart; the effective value came from the shell environment. Update the ' +
        'NEXUS_SECRET_KEY in that file to the new key first, or re-run with ' +
        `${ALLOW_ENV_MISMATCH} when that file is not the configuration this deployment reads.`,
    );
  }
}

async function main(): Promise<void> {
  const { env, file } = environmentWithEnvFile();
  const previous = env.NEXUS_SECRET_KEY_PREVIOUS;
  if (previous === undefined || previous.length < MIN_KEY_LENGTH) {
    throw new Error(
      'NEXUS_SECRET_KEY_PREVIOUS must be set to the key the database was last written with ' +
        `(at least ${MIN_KEY_LENGTH} characters)`,
    );
  }
  // `loadConfig` validates the *new* key the same way the server does.
  const config = loadConfig(env);
  assertEnvFileKeyConsistent(file, config.secretKey, process.argv.includes(ALLOW_ENV_MISMATCH));
  if (config.secretKey === previous) {
    throw new Error('NEXUS_SECRET_KEY is the same as NEXUS_SECRET_KEY_PREVIOUS; nothing to rotate');
  }
  const store = createStore(config);
  try {
    await store.init();
    await store.migrate();
    const summary = await rotateEncryptedSettings(
      store,
      createCrypto(previous),
      createCrypto(config.secretKey),
    );
    process.stdout.write(
      `Re-encrypted ${summary.rotated} setting(s) under the new NEXUS_SECRET_KEY` +
        (summary.keys.length > 0 ? ` (${summary.keys.join(', ')})` : '') +
        `; ${summary.skipped} plaintext row(s) untouched (driver: ${store.driver}).\n` +
        'Start the server with the new key now. Every session and unused email token is ' +
        'invalid under it; passwords are unaffected.\n',
    );
  } finally {
    await store.close();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  main().catch((error: unknown) => {
    if (isNexusError(error)) {
      process.stderr.write(`${error.message}\n`);
    } else {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
    process.exitCode = 1;
  });
}
