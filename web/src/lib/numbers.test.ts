import { describe, expect, it } from 'vitest';
import { parseWholeNumber } from './numbers';

describe('parseWholeNumber (issue #597)', () => {
  it.each([
    ['1000', 1000],
    [' 42 ', 42],
    ['1e3', 1000],
    ['100e1', 1000],
    ['1E3', 1000],
    ['1.5e1', 15],
    ['2.0', 2],
    ['+7', 7],
    ['-3', -3],
    ['0', 0],
  ])('reads %j as %d', (raw, expected) => {
    expect(parseWholeNumber(raw)).toBe(expected);
  });

  it.each([
    '',
    '   ',
    '1.5',
    '1e-1',
    'abc',
    '12abc',
    '0x10',
    '0b1',
    'Infinity',
    '1e400',
    '.',
    'e3',
  ])('refuses %j rather than truncating it', (raw) => {
    expect(parseWholeNumber(raw)).toBeNull();
  });

  it('refuses integers past the safe range', () => {
    expect(parseWholeNumber(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseWholeNumber('9007199254740993')).toBeNull();
  });
});
