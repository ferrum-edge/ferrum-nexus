import { describe, expect, it } from 'vitest';
import {
  contrastRatio,
  deriveAccentScale,
  deriveInfoScale,
  parseHex,
  readableForeground,
  toHex,
  type Rgb,
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

  it('keeps the brand tint independent of the adjusted text', () => {
    const base = parseHex('#38bdf8')!;
    const light = deriveInfoScale(base, 'light');
    const dark = deriveInfoScale(base, 'dark');
    expect(light['--info']).not.toBe('#38bdf8');
    expect(light['--info-soft']).toBe('rgb(56 189 248 / 0.12)');
    expect(dark['--info']).toBe('#38bdf8');
    expect(dark['--info-soft']).toBe('rgb(56 189 248 / 0.16)');
  });
});

/** Composite the emitted CSS tint in sRGB, as rendered over a solid surface. */
function compositeTint(tint: string, surface: string): Rgb {
  const match = /^rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)$/.exec(tint);
  if (!match) throw new Error(`Unexpected tint: ${tint}`);
  const alpha = Number(match[4]);
  const background = parseHex(surface)!;
  return {
    r: Number(match[1]) * alpha + background.r * (1 - alpha),
    g: Number(match[2]) * alpha + background.g * (1 - alpha),
    b: Number(match[3]) * alpha + background.b * (1 - alpha),
  };
}

describe('informational badge contrast', () => {
  // Surface, base, hover, elevated and inset tokens from globals.css.
  const surfaces = {
    light: ['#ffffff', '#f4f6f9', '#f8fafc', '#f1f4f8'],
    dark: ['#12151b', '#0a0c10', '#161a21', '#181c24', '#0d1015'],
  };

  it('reproduces the default light badge failure before foreground derivation', () => {
    const background = compositeTint('rgb(56 189 248 / 0.12)', '#ffffff');
    expect(contrastRatio(parseHex('#38bdf8')!, background)).toBeLessThan(2);
    expect(contrastRatio(parseHex('#000')!, parseHex('#fff')!)).toBe(21);
  });

  describe.each(['light', 'dark'] as const)('%s theme', (theme) => {
    it.each([
      '#38bdf8',
      '#22d3ee',
      '#2563eb',
      '#f97316',
      '#ffff00',
      '#00ff00',
      '#ff00ff',
      '#dc2626',
      '#777777',
      '#ffffff',
      '#000000',
      '#101419',
    ])('reaches 4.5:1 for %s on every badge surface', (hex) => {
      const scale = deriveInfoScale(parseHex(hex)!, theme);
      const foreground = parseHex(scale['--info'])!;
      for (const surface of surfaces[theme]) {
        const background = compositeTint(scale['--info-soft'], surface);
        expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5);
      }
    });
  });

  it('also provides readable default CSS fallbacks before branding loads', () => {
    for (const surface of surfaces.light) {
      const background = compositeTint('rgb(56 189 248 / 0.12)', surface);
      expect(contrastRatio(parseHex('#0369a1')!, background)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
