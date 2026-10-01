/**
 * Bounded comparison keys for provider-written text: enum values, property
 * and `required` names, and parameter `in` and `name`, as the two revision
 * comparisons (`spec-changes.ts`, `spec-diff.ts`) hold them in maps and sets.
 *
 * A key made of the text itself costs the text's length every time a new copy
 * of it is hashed, and again every time two equal copies are compared. Worse,
 * V8 hashes a string longer than 16 383 code units by its length alone, so k
 * distinct long texts of one length all collide, and putting them in one set
 * costs k² times their length. So a text longer than
 * {@link MAX_VERBATIM_KEY_LENGTH} is keyed by its length and a SHA-256 digest
 * of its UTF-16 code units: making the key reads the text once, every later
 * hash or comparison reads a few dozen characters, and two different texts
 * share a key only if SHA-256 collides. Callers make each key once per array,
 * schema or parameter object and charge its text to their budget then
 * ({@link KEY_CODE_UNITS_PER_UNIT}).
 */

import { createHash } from 'node:crypto';

/** Longest text used as its own key, in UTF-16 code units. */
export const MAX_VERBATIM_KEY_LENGTH = 64;

/**
 * Code units of text made into keys that one work unit pays for. Keying reads
 * each code unit once, about as cheap per character as anything a comparison
 * does, so a unit buys as much work here as one schema pair or property does.
 */
export const KEY_CODE_UNITS_PER_UNIT = 256;

/**
 * `text` as a comparison key of bounded length. Two texts get the same key
 * exactly when they are equal (barring a SHA-256 collision), and a short text
 * never shares a key with a long one.
 */
export function compactSpecKey(text: string): string {
  if (text.length <= MAX_VERBATIM_KEY_LENGTH) return `=${text}`;
  // UTF-16 code units, not UTF-8: a lone surrogate survives the encoding, so
  // two texts that differ only in one still get different digests.
  const digest = createHash('sha256').update(text, 'utf16le').digest('base64');
  return `#${text.length}:${digest}`;
}
