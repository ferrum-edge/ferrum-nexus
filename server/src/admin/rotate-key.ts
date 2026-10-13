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

import { AuditAction, SYSTEM_ACTOR, type AuditService } from '../audit/service.js';
import type { NexusStore, SettingRepo } from '../db/store.js';
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
  /**
   * `true` when an earlier start already recorded the one-time conversion,
   * so this start converted nothing.
   */
  alreadyRecorded: boolean;
  /** Legacy rows re-encrypted bound to their own key. */
  bound: string[];
  /**
   * Legacy rows left as they are: the current key does not open them (a key
   * rotated without `rotate-key`), another writer changed them first, or —
   * after the conversion was recorded — any `v1` row at all, which reads
   * refuse. They were unreadable before too.
   */
  unreadable: string[];
}

/**
 * The one-time forward step for GHSA-qm46-qg94-mpg7: re-encrypt every unbound
 * legacy (`v1`) `app_settings` blob as a `v2` blob bound to its own row key,
 * then record that it ran.
 *
 * Runtime reads refuse `v1` (a storage-layer writer could move one between
 * rows). The conversion runs at the first start of a release with the binding
 * and is recorded as a `settings.encryption_bound` audit row, outside
 * `app_settings` and append-only. Once that row exists no start converts
 * again, so a `v1` blob written into a row afterwards — a pre-upgrade copy of
 * another setting's secret — is never re-bound to the row it was moved to; it
 * stays refused.
 *
 * Each row is replaced with an atomic compare-and-set on its exact legacy
 * value ({@link SettingRepo.replaceEncryptedIfMatches}), so a secret another
 * instance saved or deleted in the meantime is never overwritten with the
 * stale one.
 */
export async function bindLegacyEncryptedSettings(
  store: NexusStore,
  crypto: NexusCrypto,
  audit: AuditService,
): Promise<BindingSummary> {
  const rows = await store.settings.all();
  const legacy = rows.filter((row) => row.encrypted && isLegacySettingBlob(row.value));
  const recorded = await store.auditLogs.list(
    { action: AuditAction.SETTINGS_ENCRYPTION_BOUND },
    { limit: 1 },
  );
  if (recorded.items.length > 0) {
    return { alreadyRecorded: true, bound: [], unreadable: legacy.map((row) => row.key) };
  }
  const summary: BindingSummary = { alreadyRecorded: false, bound: [], unreadable: [] };
  for (const row of legacy) {
    const blob = String(row.value);
    let bound: string;
    try {
      bound = crypto.encryptJson(row.key, crypto.decryptLegacySetting<unknown>(row.key, blob));
    } catch {
      summary.unreadable.push(row.key);
      continue;
    }
    if (await store.settings.replaceEncryptedIfMatches(row.key, blob, bound)) {
      summary.bound.push(row.key);
    } else {
      summary.unreadable.push(row.key);
    }
  }
  await store.transaction(async (tx) => {
    await audit.forStore(tx).record(
      SYSTEM_ACTOR,
      AuditAction.SETTINGS_ENCRYPTION_BOUND,
      { type: 'settings', id: null },
      { bound_keys: summary.bound, unreadable_keys: summary.unreadable },
    );
  });
  return summary;
}
