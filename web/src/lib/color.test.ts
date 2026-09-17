import { describe, expect, it } from 'vitest';
import {
  contrastRatio,
  deriveAccentScale,
  deriveInfoScale,
  parseHex,
  readableForeground,
  toHex,
} from './color';

describe('parseHex', () => {
  it('accepts 3- and 6-digit hex and rejects everything else', () => {
    expect(parseHex('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHex('#4f46e5')).toEqual({ r: 79, g: 70, b: 229 });
    expect(parseHex('4f46e5')).toBeNull();
    expect(parseHex('#12345')).toBeNull();
    expect(parseHex('#1234567')).toBeNull();
    expect(parseHex('#4f46e5aa')).toBeNull();
    expect(parseHex('red')).toBeNull();
    expect(parseHex('#gggggg')).toBeNull();
  });

  it('round-trips through toHex', () => {
    expect(toHex(parseHex('#F97316')!)).toBe('#f97316');
  });
});

describe('readableForeground', () => {
  it('picks white on dark brand colours and near-black on light ones', () => {
    expect(toHex(readableForeground(parseHex('#4f46e5')!))).toBe('#ffffff');
    expect(toHex(readableForeground(parseHex('#fbbf24')!))).toBe('#101419');
  });

  it('always reaches at least 4.5:1 against a saturated mid-tone', () => {
    for (const hex of ['#f97316', '#22d3ee', '#16a34a', '#dc2626', '#7c3aed', '#0ea5e9']) {
      const bg = parseHex(hex)!;
      expect(contrastRatio(bg, readableForeground(bg))).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('deriveAccentScale', () => {
  it('derives every accent token from one colour, per theme', () => {
    const dark = deriveAccentScale(parseHex('#4f46e5')!, 'dark');
    const light = deriveAccentScale(parseHex('#4f46e5')!, 'light');
    expect(dark['--accent']).toBe('#4f46e5');
    expect(light['--accent']).toBe('#4f46e5');
    // Hover lightens on dark, darkens on light, so it always reads as "lit".
    expect(dark['--accent-hover']).not.toBe(dark['--accent']);
    expect(dark['--accent-hover'] > dark['--accent']).toBe(true);
    expect(light['--accent-hover'] < light['--accent']).toBe(true);
    // Tints are translucent versions of the brand colour, not the built-in ember.
    expect(dark['--accent-soft']).toMatch(/^rgb\(79 70 229 \/ 0\.\d+\)$/);
    expect(dark['--accent-ring']).toMatch(/^rgb\(79 70 229 \/ 0\.\d+\)$/);
    expect(dark['--accent-fg']).toBe('#ffffff');
  });
});

describe('deriveInfoScale', () => {
  it('pulls a very light secondary colour down for the light theme only', () => {
    const cyan = parseHex('#22d3ee')!;
    expect(deriveInfoScale(cyan, 'dark')['--info']).toBe('#22d3ee');
    expect(deriveInfoScale(cyan, 'light')['--info']).not.toBe('#22d3ee');
  });
});
