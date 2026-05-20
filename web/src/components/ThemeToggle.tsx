import { useEffect, useState } from 'react';
import { Sun, Moon, Monitor } from 'lucide-react';
import { getStoredTheme, setTheme, type ThemeMode } from '../lib/theme.js';

export function ThemeToggle() {
  const [mode, setMode] = useState<ThemeMode>(() => getStoredTheme());

  useEffect(() => {
    setTheme(mode);
  }, [mode]);

  const next: Record<ThemeMode, ThemeMode> = {
    system: 'light',
    light: 'dark',
    dark: 'system',
  };

  return (
    <button
      type="button"
      className="btn-secondary"
      title={`Theme: ${mode}`}
      onClick={() => setMode(next[mode])}
    >
      {mode === 'light' ? <Sun size={16} /> : mode === 'dark' ? <Moon size={16} /> : <Monitor size={16} />}
    </button>
  );
}
