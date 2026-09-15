/**
 * Theme store.
 *
 * Persists the user's preference under `nexus:theme` (THEME_STORAGE_KEY) and
 * reflects the *resolved* theme onto `<html data-theme>`. `public/theme-boot
 * strap.js` performs the same resolution before first paint to avoid a flash.
 *
 * Until the user picks something, the portal's configured `default_theme`
 * applies. It arrives with the branding payload and is cached under
 * `nexus:theme-default` (THEME_DEFAULT_STORAGE_KEY) so the bootstrap script can
 * honour it on the next visit too.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  THEME_DEFAULT_STORAGE_KEY,
  THEME_STORAGE_KEY,
  type ThemePreference,
} from '@ferrum-nexus/shared';

/** The two themes the stylesheet actually implements. */
export type ResolvedTheme = 'dark' | 'light';

interface ThemeContextValue {
  /** What applies right now, including `system`: the user's pick or the portal default. */
  preference: ThemePreference;
  /** What is actually applied right now. */
  resolved: ResolvedTheme;
  /** Whether the user has chosen a theme themselves (as opposed to inheriting the default). */
  hasUserPreference: boolean;
  setPreference: (preference: ThemePreference) => void;
  /** Flip between dark and light, leaving `system` behind. */
  toggle: () => void;
  /** Adopt the portal's configured default; ignored once the user has chosen. */
  setPortalDefault: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function isPreference(value: unknown): value is ThemePreference {
  return value === 'dark' || value === 'light' || value === 'system';
}

function readStored(key: string): ThemePreference | null {
  try {
    const stored = localStorage.getItem(key);
    return isPreference(stored) ? stored : null;
  } catch {
    /* Storage can be disabled; fall back to the default. */
    return null;
  }
}

function writeStored(key: string, value: ThemePreference): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Storage can be disabled; the in-memory value still applies. */
  }
}

function systemTheme(): ResolvedTheme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function ThemeProvider({ children }: { children: ReactNode }): ReactElement {
  const [userPreference, setUserPreference] = useState<ThemePreference | null>(() =>
    readStored(THEME_STORAGE_KEY),
  );
  const [portalDefault, setPortalDefaultState] = useState<ThemePreference>(
    () => readStored(THEME_DEFAULT_STORAGE_KEY) ?? 'system',
  );
  const [systemResolved, setSystemResolved] = useState<ResolvedTheme>(systemTheme);

  const preference = userPreference ?? portalDefault;
  const resolved: ResolvedTheme = preference === 'system' ? systemResolved : preference;

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = (): void => setSystemResolved(query.matches ? 'light' : 'dark');
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolved);
  }, [resolved]);

  const setPreference = useCallback((next: ThemePreference) => {
    setUserPreference(next);
    writeStored(THEME_STORAGE_KEY, next);
  }, []);

  const toggle = useCallback(() => {
    setPreference(resolved === 'light' ? 'dark' : 'light');
  }, [resolved, setPreference]);

  const setPortalDefault = useCallback((next: ThemePreference) => {
    setPortalDefaultState(next);
    writeStored(THEME_DEFAULT_STORAGE_KEY, next);
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      preference,
      resolved,
      hasUserPreference: userPreference !== null,
      setPreference,
      toggle,
      setPortalDefault,
    }),
    [preference, resolved, userPreference, setPreference, toggle, setPortalDefault],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** Access the theme store; throws when used outside {@link ThemeProvider}. */
export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used within a ThemeProvider');
  return context;
}
