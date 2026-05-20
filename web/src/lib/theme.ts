export type ThemeMode = 'system' | 'light' | 'dark';

const KEY = 'nexus.theme';

export function getStoredTheme(): ThemeMode {
  const stored = localStorage.getItem(KEY);
  return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
}

export function applyTheme(mode: ThemeMode): void {
  const resolved =
    mode === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : mode;
  document.documentElement.classList.toggle('dark', resolved === 'dark');
}

export function setTheme(mode: ThemeMode): void {
  localStorage.setItem(KEY, mode);
  applyTheme(mode);
}

export function initThemeFromDefault(defaultMode: ThemeMode): void {
  const explicit = localStorage.getItem(KEY);
  applyTheme((explicit as ThemeMode | null) ?? defaultMode);
}
