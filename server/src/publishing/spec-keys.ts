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
 * schema or parameter object and charge its text to their budget then, through
 * a {@link KeyTextCharge}.
 */

import { createHash } from 'node:crypto';

import { SPEC_KEY_CODE_UNITS_PER_UNIT } from '@ferrum-nexus/shared';

/** Longest text used as its own key, in UTF-16 code units. */
export const MAX_VERBATIM_KEY_LENGTH = 64;

/**
 * What keying provider text costs one comparison, charged to its budget.
 *
 * Per object, a charge rounded up would cost at least a unit for every short
 * name, so a document of many small parameters would pay a unit per parameter
 * for a few characters each. So the charge runs on the comparison's total:
 * each call spends the whole units that total has newly passed, and
 * {@link KeyTextCharge.settle} spends the part unit left at the end. Keying
 * costs `ceil(total / SPEC_KEY_CODE_UNITS_PER_UNIT)` units in all.
 */
export interface KeyTextCharge {
  /** Pay for keying `codeUnits` more code units. */
  charge(codeUnits: number): void;
  /** Pay for the part unit the total has passed, once the keying is done. */
  settle(): void;
}

/** A {@link KeyTextCharge} spending through `spend`, which may throw. */
export function createKeyTextCharge(spend: (units: number) => void): KeyTextCharge {
  let total = 0;
  let charged = 0;
  const spendUpTo = (units: number): void => {
    const due = units - charged;
    if (due <= 0) return;
    charged = units;
    spend(due);
  };
  return {
    charge(codeUnits) {
      total += codeUnits;
      spendUpTo(Math.floor(total / SPEC_KEY_CODE_UNITS_PER_UNIT));
    },
    settle() {
      spendUpTo(Math.ceil(total / SPEC_KEY_CODE_UNITS_PER_UNIT));
    },
  };
}

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
