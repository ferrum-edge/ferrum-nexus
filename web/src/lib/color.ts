/**
 * Small colour utilities for deriving a full accent scale from one brand hex.
 *
 * Branding stores a single `primary_color`; the stylesheet needs hover/active
 * shades, a readable foreground, and translucent "soft"/"ring" variants. All of
 * that is computed here so an operator's colour choice never leaves half the
 * palette on the built-in default (which is what produced orange tints under
 * indigo icons before).
 */

import { BRANDING_HEX_COLOR, normalizeBrandingHexColor } from '@ferrum-nexus/shared';

/** Matches `#rgb` / `#rrggbb`, the only forms accepted from branding settings. */
export const HEX_COLOR = BRANDING_HEX_COLOR;

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface Hsl {
  /** 0–360 */
  h: number;
  /** 0–1 */
  s: number;
  /** 0–1 */
  l: number;
}

/** Parse a hex colour; `null` when it is not a 3- or 6-digit hex string. */
export function parseHex(input: string): Rgb | null {
  const hex = normalizeBrandingHexColor(input);
  if (!hex) return null;
  const value = Number.parseInt(hex.slice(1), 16);
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function channel(value: number): string {
  return Math.round(Math.min(255, Math.max(0, value)))
    .toString(16)
    .padStart(2, '0');
}

/** Serialise to lowercase `#rrggbb`. */
export function toHex({ r, g, b }: Rgb): string {
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

export function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
  else if (max === gn) h = ((bn - rn) / d + 2) * 60;
  else h = ((rn - gn) / d + 4) * 60;
  return { h, s, l };
}

export function hslToRgb({ h, s, l }: Hsl): Rgb {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  let rn = 0;
  let gn = 0;
  let bn = 0;
  if (hue < 60) [rn, gn, bn] = [c, x, 0];
  else if (hue < 120) [rn, gn, bn] = [x, c, 0];
  else if (hue < 180) [rn, gn, bn] = [0, c, x];
  else if (hue < 240) [rn, gn, bn] = [0, x, c];
  else if (hue < 300) [rn, gn, bn] = [x, 0, c];
  else [rn, gn, bn] = [c, 0, x];
  return { r: (rn + m) * 255, g: (gn + m) * 255, b: (bn + m) * 255 };
}

/** Shift lightness by `delta` (−1…1), keeping hue and saturation. */
export function shiftLightness(rgb: Rgb, delta: number): Rgb {
  const hsl = rgbToHsl(rgb);
  return hslToRgb({ ...hsl, l: clamp01(hsl.l + delta) });
}

/** WCAG relative luminance (0 = black, 1 = white). */
export function relativeLuminance({ r, g, b }: Rgb): number {
  const lin = (v: number): number => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two colours (1–21). */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [light, dark] = la > lb ? [la, lb] : [lb, la];
  return (light + 0.05) / (dark + 0.05);
}

const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const NEAR_BLACK: Rgb = { r: 16, g: 20, b: 25 };

/** The foreground (white or near-black) with the better contrast on `bg`. */
export function readableForeground(bg: Rgb): Rgb {
  return contrastRatio(bg, WHITE) >= contrastRatio(bg, NEAR_BLACK) ? WHITE : NEAR_BLACK;
}

/** `rgb(r g b / alpha)` for use as a translucent tint. */
export function withAlpha({ r, g, b }: Rgb, alpha: number): string {
  return `rgb(${Math.round(r)} ${Math.round(g)} ${Math.round(b)} / ${alpha})`;
}

/** Every CSS custom property derived from one accent colour. */
export interface AccentScale {
  '--accent': string;
  '--accent-hover': string;
  '--accent-active': string;
  '--accent-fg': string;
  '--accent-soft': string;
  '--accent-ring': string;
  '--accent-glow': string;
}

/**
 * Derive the accent token set for one theme.
 *
 * Hover moves *towards* the theme's background contrast direction: lighter on a
 * dark theme, darker on a light one, so a button always reads as "lit up" on
 * hover. Tints are translucent so they sit naturally on any surface.
 */
export function deriveAccentScale(base: Rgb, theme: 'dark' | 'light'): AccentScale {
  const direction = theme === 'dark' ? 1 : -1;
  const hover = shiftLightness(base, 0.07 * direction);
  const active = shiftLightness(base, -0.05 * direction);
  return {
    '--accent': toHex(base),
    '--accent-hover': toHex(hover),
    '--accent-active': toHex(active),
    '--accent-fg': toHex(readableForeground(base)),
    '--accent-soft': withAlpha(base, theme === 'dark' ? 0.16 : 0.12),
    '--accent-ring': withAlpha(base, theme === 'dark' ? 0.45 : 0.35),
    '--accent-glow': withAlpha(base, theme === 'dark' ? 0.28 : 0.18),
  };
}

/** Derived tokens for the secondary emphasis colour (`--info`). */
export interface InfoScale {
  '--info': string;
  '--info-soft': string;
}

export function deriveInfoScale(base: Rgb, theme: 'dark' | 'light'): InfoScale {
  // A very light secondary colour (e.g. cyan) is unreadable as text on a white
  // surface, so pull it down a little in the light theme.
  const readable =
    theme === 'light' && relativeLuminance(base) > 0.45 ? shiftLightness(base, -0.22) : base;
  return {
    '--info': toHex(readable),
    '--info-soft': withAlpha(base, theme === 'dark' ? 0.16 : 0.12),
  };
}
