/**
 * Re-encrypt every encrypted `app_settings` row under a new master key.
 *
 * `NEXUS_SECRET_KEY` derives the AES-256-GCM key that protects the SMTP
 * password and the CAPTCHA secret. Rotating it used to mean those rows simply
 * stopped decrypting: `readEncryptedSetting` returns `null` on failure, so SMTP
 * fell back to the environment and CAPTCHA — which fails closed — locked every
 * administrator out before they could re-enter the secret. This is the offline
 * step that makes rotation complete: read each blob with the previous key,
 * write it back under the new one, all in one transaction.
 *
 * It is deliberately all-or-nothing. A row that the previous key cannot open
 * is a wrong key or an already-rotated database, and either way writing the
 * rows that *did* open would leave the settings half under each key — worse
 * than the failure it reports. Nothing here logs a value; callers get counts.
 */

import type { NexusStore } from '../db/store.js';
import type { NexusCrypto } from '../lib/crypto.js';
import { NexusError } from '../lib/errors.js';

/** What {@link rotateEncryptedSettings} did. */
export interface RotationSummary {
  /** Encrypted rows rewritten under the new key. */
  rotated: number;
  /** Rows that are not encrypted and were left alone. */
  skipped: number;
  /** The keys that were rotated, for the operator's log — never their values. */
  keys: string[];
}

/**
 * Rotate the encrypted settings from `previous` to `next`.
 *
 * @throws NexusError `VALIDATION_FAILED` when any encrypted row does not open
 *   with `previous`; nothing has been written in that case.
 */
export async function rotateEncryptedSettings(
  store: NexusStore,
  previous: NexusCrypto,
  next: NexusCrypto,
): Promise<RotationSummary> {
  const rows = await store.settings.all();
  const encrypted = rows.filter((row) => row.encrypted);
  const rewritten: { key: string; value: string; encrypted: true }[] = [];
  const unreadable: string[] = [];
  for (const row of encrypted) {
    try {
      const plain = previous.decryptJson<unknown>(String(row.value));
      rewritten.push({ key: row.key, value: next.encryptJson(plain), encrypted: true });
    } catch {
      unreadable.push(row.key);
    }
  }
  if (unreadable.length > 0) {
    throw new NexusError(
      'VALIDATION_FAILED',
      `${unreadable.length} encrypted setting(s) do not open with NEXUS_SECRET_KEY_PREVIOUS ` +
        `(${unreadable.join(', ')}); nothing was changed. Check that the previous key is the one ` +
        'the database was last written with, and that this rotation has not already run.',
      { keys: unreadable },
    );
  }
  if (rewritten.length > 0) {
    await store.transaction(async (tx) => {
      await tx.settings.setMany(rewritten);
    });
  }
  return {
    rotated: rewritten.length,
    skipped: rows.length - encrypted.length,
    keys: rewritten.map((row) => row.key),
  };
}
