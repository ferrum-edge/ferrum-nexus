/**
 * Reading a setting together with the rows that belong to it.
 *
 * Some configuration spans two `app_settings` rows: the SMTP connection and
 * its encrypted password, the CAPTCHA provider and its secret. The settings
 * writer commits both in one transaction, but a reader that fetches them one
 * after the other can still straddle that commit and pair the old connection
 * with the new secret. That presents one relay's credential to another.
 *
 * Every writer of a dependent row also writes the anchor row in the same
 * transaction, so the anchor's generation (its value and `updated_at`) moves
 * whenever a dependent row does. {@link readBoundToSetting} reads the anchor,
 * then everything that depends on it, then the anchor again, and keeps the
 * result only when the anchor did not move in between. A read that keeps
 * straddling writes gives up rather than returning a mixed pair. This needs
 * no snapshot isolation, so it holds on every adapter, and it opens no
 * transaction around the caller's external I/O.
 */

import { isDeepStrictEqual } from 'node:util';

import type { NexusStore, SettingRecord } from '../db/store.js';
import { conflict } from './errors.js';

/** How many times a read that straddled a write is retried. */
export const SETTING_GENERATION_ATTEMPTS = 5;

/** Whether two reads of one row saw the same committed generation. */
function sameGeneration(a: SettingRecord | null, b: SettingRecord | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.updated_at === b.updated_at &&
    a.encrypted === b.encrypted &&
    isDeepStrictEqual(a.value, b.value)
  );
}

/**
 * Run `read` against one generation of the setting `key`: it receives the
 * anchor row and reads whatever depends on it, and its result is returned only
 * if `key` was unchanged across the whole read.
 */
export async function readBoundToSetting<T>(
  store: Pick<NexusStore, 'settings'>,
  key: string,
  read: (anchor: SettingRecord | null) => Promise<T>,
  attempts = SETTING_GENERATION_ATTEMPTS,
): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const before = await store.settings.get(key);
    const result = await read(before);
    const after = await store.settings.get(key);
    if (sameGeneration(before, after)) return result;
  }
  throw conflict(`The ${key} setting kept changing while it was being read; retry`, {
    setting: key,
  });
}
