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

import { rotateEncryptedSettings } from '../admin/rotate-key.js';
import { environmentWithEnvFile } from '../config/env-file.js';
import { loadConfig } from '../config/index.js';
import { createCrypto } from '../lib/crypto.js';
import { isNexusError } from '../lib/errors.js';
import { createStore } from './index.js';

const MIN_KEY_LENGTH = 32;

async function main(): Promise<void> {
  const { env } = environmentWithEnvFile();
  const previous = env.NEXUS_SECRET_KEY_PREVIOUS;
  if (previous === undefined || previous.length < MIN_KEY_LENGTH) {
    throw new Error(
      'NEXUS_SECRET_KEY_PREVIOUS must be set to the key the database was last written with ' +
        `(at least ${MIN_KEY_LENGTH} characters)`,
    );
  }
  // `loadConfig` validates the *new* key the same way the server does.
  const config = loadConfig(env);
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

main().catch((error: unknown) => {
  if (isNexusError(error)) {
    process.stderr.write(`${error.message}\n`);
  } else {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exitCode = 1;
});
