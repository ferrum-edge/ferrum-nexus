/**
 * Parse the complete text of a number field as a whole number.
 *
 * `Number.parseInt` reads digits up to the first character it does not
 * understand, so `1e3` (which a number input accepts and means 1000) became
 * 1 and `100e1` became 100: a quota or timeout other than the one typed, and
 * still in range (issue #597). This reads the whole value, and refuses
 * anything that is not exactly a finite safe integer — a fraction, a blank,
 * stray text, or a hexadecimal or binary literal — instead of truncating it.
 */
export function parseWholeNumber(raw: string): number | null {
  const text = raw.trim();
  // Decimal notation only, optionally with an exponent: what a number input
  // produces. `Number` alone would also take `0x10`, `0b1` and `Infinity`.
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}
