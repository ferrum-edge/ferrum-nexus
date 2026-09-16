import { useEffect } from 'react';
import { useBranding } from '../../hooks/useBranding';
import { useTheme } from '../../stores/theme';
import { deriveAccentScale, deriveInfoScale, parseHex } from '../../lib/color';
import { loadFontPreset } from '../../lib/fonts';

/**
 * Applies admin-configured branding to `<html>`.
 *
 * Colours: the whole `--accent-*` scale (hover, active, readable foreground,
 * soft tint, focus ring, glow) is derived from `primary_color` for the theme
 * currently applied, and `--info-*` from `accent_color`. Writing only
 * `--accent` used to leave the tints on the built-in ember default, which
 * produced orange highlights under indigo icons.
 *
 * Appearance presets land as attributes (`data-radius`, `data-sidebar`) the
 * stylesheet keys on, and the typeface preset swaps `--font-sans-stack` after
 * its (self-hosted) face has loaded.
 *
 * Values are validated as hex before being written so a bad setting can never
 * inject arbitrary CSS. The favicon follows the logo when one is configured.
 */
export function BrandingStyles(): null {
  const { data } = useBranding();
  const { resolved, setPortalDefault } = useTheme();
  const primary = data?.primary_color;
  const secondary = data?.accent_color;
  const logo = data?.logo_data_url ?? null;
  const portalName = data?.portal_name;
  const defaultTheme = data?.default_theme;
  const radius = data?.radius ?? 'md';
  const sidebarStyle = data?.sidebar_style ?? 'surface';
  const fontPreset = data?.font_preset ?? 'system';

  useEffect(() => {
    const root = document.documentElement;
    const primaryRgb = primary ? parseHex(primary) : null;
    const secondaryRgb = secondary ? parseHex(secondary) : null;

    const accent = primaryRgb ? deriveAccentScale(primaryRgb, resolved) : null;
    const info = secondaryRgb ? deriveInfoScale(secondaryRgb, resolved) : null;

    const applied: string[] = [];
    for (const scale of [accent, info]) {
      if (!scale) continue;
      for (const [name, value] of Object.entries(scale)) {
        root.style.setProperty(name, value);
        applied.push(name);
      }
    }
    return () => {
      for (const name of applied) root.style.removeProperty(name);
    };
  }, [primary, secondary, resolved]);

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-radius', radius);
    root.setAttribute('data-sidebar', sidebarStyle);
  }, [radius, sidebarStyle]);

  useEffect(() => {
    let cancelled = false;
    void loadFontPreset(fontPreset).then((stack) => {
      if (!cancelled) document.documentElement.style.setProperty('--font-sans-stack', stack);
    });
    return () => {
      cancelled = true;
    };
  }, [fontPreset]);

  useEffect(() => {
    if (portalName) document.title = portalName;
  }, [portalName]);

  useEffect(() => {
    if (defaultTheme) setPortalDefault(defaultTheme);
  }, [defaultTheme, setPortalDefault]);

  useEffect(() => {
    if (!logo) return;
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    const previous = link.href;
    link.href = logo;
    return () => {
      if (link) link.href = previous;
    };
  }, [logo]);

  return null;
}
