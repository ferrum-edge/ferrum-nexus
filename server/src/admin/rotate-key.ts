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
import type { KeyedSerializer } from '../lib/keyed-serializer.js';

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
  // Before the recorded one-time binding a row may still be legacy `v1`;
  // after it, an unbound row is a transplant candidate and is refused here
  // exactly as runtime reads refuse it, so rotation cannot launder it into a
  // valid bound blob.
  const legacyAllowed = !(await legacyBindingRecorded(store));
  const rewritten: { key: string; value: string; encrypted: true }[] = [];
  const unreadable: string[] = [];
  for (const row of encrypted) {
    try {
      const blob = String(row.value);
      const plain = legacyAllowed
        ? previous.decryptLegacySetting<unknown>(row.key, blob)
        : previous.decryptJson<unknown>(row.key, blob);
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

/** The lease the one-time legacy binding runs under, across instances. */
export const SETTINGS_BINDING_LOCK_KEY = 'settings:encryption-binding';

/** Whether the one-time legacy binding has been recorded. */
async function legacyBindingRecorded(store: NexusStore): Promise<boolean> {
  const recorded = await store.auditLogs.list(
    { action: AuditAction.SETTINGS_ENCRYPTION_BOUND },
    { limit: 1 },
  );
  return recorded.items.length > 0;
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
  /** Legacy rows another writer replaced or deleted first; left as they are. */
  changed: string[];
  /**
   * After the conversion was recorded: every `v1` row still present, which
   * reads refuse. (Before it, a `v1` row the key cannot open aborts the
   * conversion instead.)
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
 * `app_settings` and append-only. Once that row exists neither a start nor
 * `rotate-secret-key` reads a `v1` row again, so a `v1` blob written into a
 * row afterwards — a pre-upgrade copy of another setting's secret — is never
 * re-bound to the row it was moved to; it stays refused.
 *
 * It runs under {@link SETTINGS_BINDING_LOCK_KEY} and re-checks the marker
 * there, so instances starting together convert once and write one marker,
 * which commits in a transaction the lease fences. Each row is replaced with
 * an atomic compare-and-set on its exact legacy value
 * ({@link SettingRepo.replaceEncryptedIfMatches}), so a secret another writer
 * saved or deleted in the meantime is never overwritten with the stale one.
 */
export async function bindLegacyEncryptedSettings(
  store: NexusStore,
  crypto: NexusCrypto,
  audit: AuditService,
  locks: KeyedSerializer,
): Promise<BindingSummary> {
  return locks(SETTINGS_BINDING_LOCK_KEY, async () => {
    // Prepared outside the transaction: decrypting is pure, and a row the key
    // cannot open stops the conversion before anything is written or
    // recorded, so a start with the wrong key leaves the next start with the
    // right one free to convert.
    const legacy = (await store.settings.all()).filter(
      (row) => row.encrypted && isLegacySettingBlob(row.value),
    );
    if (await legacyBindingRecorded(store)) {
      return {
        alreadyRecorded: true,
        bound: [],
        changed: [],
        unreadable: legacy.map((row) => row.key),
      };
    }
    const plans: { key: string; blob: string; bound: string }[] = [];
    const unreadable: string[] = [];
    for (const row of legacy) {
      const blob = String(row.value);
      try {
        const plain = crypto.decryptLegacySetting<unknown>(row.key, blob);
        plans.push({ key: row.key, blob, bound: crypto.encryptJson(row.key, plain) });
      } catch {
        unreadable.push(row.key);
      }
    }
    if (unreadable.length > 0) {
      throw new NexusError(
        'VALIDATION_FAILED',
        `${unreadable.length} legacy encrypted setting(s) do not open with NEXUS_SECRET_KEY ` +
          `(${unreadable.join(', ')}). Nothing was converted or recorded. Start with the key ` +
          'they were written under, or delete those rows and re-enter the secrets after start.',
        { keys: unreadable },
      );
    }
    // One transaction, opened under the lease and fenced by it at commit: the
    // marker re-check, every conditional replacement and the marker itself
    // commit together or not at all, so a converter that stalled past the
    // lease cannot write after another instance recorded completion.
    return store.transaction(async (tx) => {
      const summary: BindingSummary = {
        alreadyRecorded: false,
        bound: [],
        changed: [],
        unreadable: [],
      };
      if (await legacyBindingRecorded(tx)) return { ...summary, alreadyRecorded: true };
      for (const plan of plans) {
        if (await tx.settings.replaceEncryptedIfMatches(plan.key, plan.blob, plan.bound)) {
          summary.bound.push(plan.key);
        } else {
          summary.changed.push(plan.key);
        }
      }
      await audit.forStore(tx).record(
        SYSTEM_ACTOR,
        AuditAction.SETTINGS_ENCRYPTION_BOUND,
        { type: 'settings', id: null },
        { bound_keys: summary.bound, changed_keys: summary.changed },
      );
      return summary;
    });
  });
}
