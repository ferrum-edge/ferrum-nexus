/**
 * Re-encrypt every encrypted `app_settings` row under a new master key.
 *
 * `NEXUS_SECRET_KEY` derives the AES-256-GCM key that protects the SMTP
 * password and the CAPTCHA secret. Rotating it without this step leaves those
 * rows undecryptable: SMTP then sends no password at all (it once fell back to
 * the environment's and presented it to the stored relay — issue #342), and
 * CAPTCHA — which fails closed — locks every administrator out before they can
 * re-enter the secret. This is the offline step that makes rotation complete:
 * read each blob with the previous key, write it back under the new one, all in
 * one transaction.
 *
 * It is deliberately all-or-nothing. A row that the previous key cannot open
 * is a wrong key or an already-rotated database, and either way writing the
 * rows that *did* open would leave the settings half under each key — worse
 * than the failure it reports. Nothing here logs a value; callers get counts.
 */

import type { NexusStore } from '../db/store.js';
import { isLegacySettingBlob, type NexusCrypto } from '../lib/crypto.js';
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
      // A row not yet re-bound by a start of this release is still `v1`.
      const plain = previous.decryptLegacySetting<unknown>(row.key, String(row.value));
      rewritten.push({ key: row.key, value: next.encryptJson(row.key, plain), encrypted: true });
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

/** What {@link bindLegacyEncryptedSettings} did. */
export interface BindingSummary {
  /** Legacy rows re-encrypted bound to their own key. */
  bound: string[];
  /**
   * Legacy rows the current key does not open (a key rotated without
   * `rotate-key`). Left as they are: they were unreadable before too.
   */
  unreadable: string[];
}

/**
 * Re-encrypt every unbound legacy (`v1`) `app_settings` blob as a `v2` blob
 * bound to its own row key — the forward step for GHSA-qm46-qg94-mpg7.
 *
 * Runtime reads refuse `v1` (a storage-layer writer could move one between
 * rows), so this runs at every start before any service reads a setting, and
 * is a no-op once nothing legacy is left. Each row is rewritten in its own
 * transaction, and only if it still holds the blob that was read: a value an
 * administrator saved in the meantime is never overwritten with a stale one.
 */
export async function bindLegacyEncryptedSettings(
  store: NexusStore,
  crypto: NexusCrypto,
): Promise<BindingSummary> {
  const summary: BindingSummary = { bound: [], unreadable: [] };
  for (const row of await store.settings.all()) {
    if (!row.encrypted || !isLegacySettingBlob(row.value)) continue;
    const legacy = row.value;
    let bound: string;
    try {
      bound = crypto.encryptJson(row.key, crypto.decryptLegacySetting<unknown>(row.key, legacy));
    } catch {
      summary.unreadable.push(row.key);
      continue;
    }
    const written = await store.transaction(async (tx) => {
      const current = await tx.settings.get(row.key);
      if (!current?.encrypted || current.value !== legacy) return false;
      await tx.settings.set(row.key, bound, true);
      return true;
    });
    if (written) summary.bound.push(row.key);
  }
  return summary;
}
