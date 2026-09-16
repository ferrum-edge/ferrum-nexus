import type { BrandingFontPreset } from '@ferrum-nexus/shared';

/**
 * Typeface presets.
 *
 * Fonts are self-hosted (`@fontsource-variable/*`) so the strict `font-src
 * 'self'` CSP holds, and each face is imported lazily so a portal on the
 * `system` preset never downloads a font file. The stack is written to
 * `--font-sans-stack`, which the stylesheet's `--font-sans` reads.
 */

const SYSTEM_STACK =
  "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

const STACKS: Readonly<Record<BrandingFontPreset, string>> = {
  system: SYSTEM_STACK,
  inter: `'Inter Variable', ${SYSTEM_STACK}`,
  manrope: `'Manrope Variable', ${SYSTEM_STACK}`,
};

const loaded = new Set<BrandingFontPreset>();

/** Load the face for `preset` (once) and return its CSS font stack. */
export async function loadFontPreset(preset: BrandingFontPreset): Promise<string> {
  if (preset !== 'system' && !loaded.has(preset)) {
    if (preset === 'inter') await import('@fontsource-variable/inter');
    else if (preset === 'manrope') await import('@fontsource-variable/manrope');
    loaded.add(preset);
  }
  return STACKS[preset] ?? SYSTEM_STACK;
}

/** The CSS stack for `preset` without loading anything (for previews and SSR-free paths). */
export function fontStackFor(preset: BrandingFontPreset): string {
  return STACKS[preset] ?? SYSTEM_STACK;
}
