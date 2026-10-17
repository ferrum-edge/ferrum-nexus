/**
 * Reading a setting together with the rows that belong to it.
 *
 * Some configuration spans several `app_settings` rows: the SMTP connection
 * and its encrypted password, the CAPTCHA provider and its secret, the single
 * sign-on providers and their client secrets. The settings writer commits
 * them together, but a reader that fetches them one after the other can
 * straddle that commit and pair the old destination with the new secret,
 * which presents one relay's (or vendor's, or issuer's) credential to another.
 *
 * {@link readBoundToSetting} reads the anchor row, then runs the caller's
 * reads through a store that records every other settings row they fetch,
 * then reads the anchor and each recorded row again. The result is kept only
 * if every one of them is unchanged. Secrets are encrypted with a fresh nonce
 * on every write, so a rewritten secret never compares equal to the one it
 * replaced, even when the configuration around it is written back to an
 * identical value within the same millisecond. A read that keeps straddling
 * writes gives up rather than returning a mixed pair. This needs no snapshot
 * isolation, so it holds on every adapter, and it opens no transaction around
 * the caller's external I/O.
 */

import { isDeepStrictEqual } from 'node:util';

import type { NexusStore, SettingRecord } from '../db/store.js';
import { conflict } from './errors.js';

/** How many times a read that straddled a write is retried. */
export const SETTING_GENERATION_ATTEMPTS = 5;

/** Whether two reads of one row saw the same committed value. */
function sameRow(a: SettingRecord | null, b: SettingRecord | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.updated_at === b.updated_at &&
    a.encrypted === b.encrypted &&
    isDeepStrictEqual(a.value, b.value)
  );
}

/**
 * `store`, with every `settings.get` it answers recorded in `seen`. Every
 * observation is kept, including repeats of a key: recording only the first
 * would let a later read of the same row go unvalidated, so a value that
 * appears and is removed again between two reads of it (absent, then present,
 * then absent) would pair the middle value with the restored configuration.
 */
function recording(
  store: NexusStore,
  seen: Map<string, (SettingRecord | null)[]>,
): NexusStore {
  const settings = new Proxy(store.settings, {
    get(target, property) {
      const value = Reflect.get(target, property) as unknown;
      if (property !== 'get' || typeof value !== 'function') {
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async (key: string): Promise<SettingRecord | null> => {
        const row = await (value as (key: string) => Promise<SettingRecord | null>).call(
          target,
          key,
        );
        const observations = seen.get(key);
        if (observations === undefined) seen.set(key, [row]);
        else observations.push(row);
        return row;
      };
    },
  });
  return new Proxy(store, {
    get(target, property) {
      if (property === 'settings') return settings;
      const value = Reflect.get(target, property) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * Run `read` against one generation of the setting `key` and the rows read
 * with it. `read` receives the anchor row and a store to do its reads through;
 * its result is returned only if the anchor and every settings row it read were
 * unchanged across the whole read.
 */
export async function readBoundToSetting<T>(
  store: NexusStore,
  key: string,
  read: (anchor: SettingRecord | null, reader: NexusStore) => Promise<T>,
  attempts = SETTING_GENERATION_ATTEMPTS,
): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const anchor = await store.settings.get(key);
    const seen = new Map<string, (SettingRecord | null)[]>([[key, [anchor]]]);
    const result = await read(anchor, recording(store, seen));
    let unchanged = true;
    for (const [seenKey, observations] of seen) {
      const current = await store.settings.get(seenKey);
      if (!observations.every((row) => sameRow(row, current))) {
        unchanged = false;
        break;
      }
    }
    if (unchanged) return result;
  }
  throw conflict(`The ${key} setting kept changing while it was being read; retry`, {
    setting: key,
  });
}
