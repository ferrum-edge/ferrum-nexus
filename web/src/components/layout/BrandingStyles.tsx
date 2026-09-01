import { useEffect } from 'react';
import { useBranding } from '../../hooks/useBranding';

/** Matches `#rgb` / `#rrggbb`, the only forms accepted from branding settings. */
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * Applies admin-configured branding colours by overriding the accent tokens on
 * `<html>`. Values are validated as hex before being written so a bad setting
 * can never inject arbitrary CSS.
 */
export function BrandingStyles(): null {
  const { data } = useBranding();
  const primary = data?.primary_color;
  const accent = data?.accent_color;

  useEffect(() => {
    const root = document.documentElement;
    if (primary && HEX.test(primary)) {
      root.style.setProperty('--accent', primary);
      root.style.setProperty('--accent-hover', primary);
      root.style.setProperty('--accent-active', primary);
    }
    if (accent && HEX.test(accent)) {
      root.style.setProperty('--info', accent);
    }
  }, [primary, accent]);

  return null;
}
