import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { THEME_DEFAULT_STORAGE_KEY, THEME_STORAGE_KEY } from '@ferrum-nexus/shared';
import { ThemeProvider, useTheme } from './theme';

let api: ReturnType<typeof useTheme> | null = null;

function Probe(): ReactElement {
  api = useTheme();
  return <span data-testid="resolved">{api.resolved}</span>;
}

function stubMatchMedia(prefersLight: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query.includes('light') ? prefersLight : !prefersLight,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

describe('ThemeProvider', () => {
  beforeEach(() => {
    localStorage.clear();
    stubMatchMedia(false);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    api = null;
  });

  it('follows the system until a portal default or user choice arrives', () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('resolved')).toHaveTextContent('dark');
    expect(api?.hasUserPreference).toBe(false);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it("applies the portal's default theme and caches it for the bootstrap script", () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    act(() => api?.setPortalDefault('light'));
    expect(screen.getByTestId('resolved')).toHaveTextContent('light');
    expect(localStorage.getItem(THEME_DEFAULT_STORAGE_KEY)).toBe('light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(api?.hasUserPreference).toBe(false);
  });

  it("does not let the portal default override the user's own choice", () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    act(() => api?.setPortalDefault('light'));
    expect(screen.getByTestId('resolved')).toHaveTextContent('dark');
    expect(api?.hasUserPreference).toBe(true);
  });

  it('toggling persists a user preference that survives a portal default change', () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    act(() => api?.toggle());
    expect(screen.getByTestId('resolved')).toHaveTextContent('light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    act(() => api?.setPortalDefault('dark'));
    expect(screen.getByTestId('resolved')).toHaveTextContent('light');
  });

  it('reads a cached portal default on the next visit', () => {
    localStorage.setItem(THEME_DEFAULT_STORAGE_KEY, 'light');
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('resolved')).toHaveTextContent('light');
  });
});
