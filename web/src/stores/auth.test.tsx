import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ERROR_CODES,
  THEME_DEFAULT_STORAGE_KEY,
  THEME_STORAGE_KEY,
  type BrandingResponse,
  type User,
} from '@ferrum-nexus/shared';
import { ApiError, authApi } from '../lib/api';
import { deriveAccentScale, deriveInfoScale, parseHex } from '../lib/color';
import { BrandingStyles } from '../components/layout/BrandingStyles';
import { queryKeys } from '../hooks/keys';
import { useBranding } from '../hooks/useBranding';
import { useCredentials } from '../hooks/useCredentials';
import { AuthProvider, useAuth } from './auth';
import { ThemeProvider } from './theme';

const alice: User = {
  id: 'alice',
  email: 'alice@example.test',
  display_name: 'Alice',
  role: 'client',
  org_id: null,
  company: null,
  phone: null,
  status: 'active',
  email_verified: true,
  last_login_at: null,
  created_at: '2026-09-08T00:00:00.000Z',
  updated_at: '2026-09-08T00:00:00.000Z',
};
const bob: User = { ...alice, id: 'bob', display_name: 'Bob', email: 'bob@example.test' };
let observedByBob: string[];
let client: QueryClient;

function Credentials(): ReactElement {
  const { user } = useAuth();
  const query = useCredentials();
  const contents = JSON.stringify(query.data ?? null);
  if (user?.id === 'bob') observedByBob.push(contents);
  return <div data-testid="credentials">{contents}</div>;
}

function Session(): ReactElement {
  const auth = useAuth();
  return (
    <>
      <p>{auth.user?.display_name ?? auth.status}</p>
      <button onClick={() => void auth.refresh()}>Refresh</button>
      <button onClick={() => void auth.logout()}>Logout</button>
      <button onClick={() => void authApi.me().catch(() => undefined)}>Probe</button>
      <button onClick={() => void auth.login({ email: bob.email, password: 'test-password-long' })}>
        Login Bob
      </button>
      {auth.status === 'authenticated' ? <Credentials /> : null}
    </>
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function setup(): { expire: () => void; finishBob: () => void } {
  let principal = alice;
  let expired = false;
  let finishBob = (): void => undefined;
  const bobCredentials = new Promise<Response>((resolve) => {
    finishBob = () => resolve(json({ items: [], total: 0 }));
  });
  observedByBob = [];
  client = new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000, retry: false } },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/auth/login') {
        principal = bob;
        expired = false;
        return Promise.resolve(json({ user: bob }));
      }
      if (url === '/api/auth/logout') return Promise.resolve(json({ ok: true }));
      if (url === '/api/auth/me') {
        return Promise.resolve(
          expired
            ? json({ error: { code: ERROR_CODES.UNAUTHORIZED, message: 'Expired' } }, 401)
            : json({ user: principal, capabilities: null }),
        );
      }
      if (url.startsWith('/api/credentials')) {
        if (principal.id === 'bob') return bobCredentials;
        return Promise.resolve(
          json({ items: [{ id: 'alice-credential', label: 'Alice private metadata' }], total: 1 }),
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <Session />
      </AuthProvider>
    </QueryClientProvider>,
  );
  return { expire: () => (expired = true), finishBob };
}

afterEach(() => {
  cleanup();
  client.clear();
  localStorage.clear();
  document.documentElement.removeAttribute('style');
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-radius');
  document.documentElement.removeAttribute('data-sidebar');
  document.title = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function BrandingName(): ReactElement {
  const { data } = useBranding();
  return <span>{data?.portal_name}</span>;
}

function BrandingSession(): ReactElement {
  const { status } = useAuth();
  return (
    <>
      <span>{status}</span>
      {status === 'authenticated' ? <BrandingName /> : null}
    </>
  );
}

describe.each(['light', 'dark'] as const)('authenticated branding in %s theme', (theme) => {
  it.each([
    [320, 'auth'],
    [1280, 'auth'],
    [320, 'branding'],
    [1280, 'branding'],
  ] as const)('applies the saved palette at %ipx when %s resolves first', async (width, first) => {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
    localStorage.setItem(THEME_DEFAULT_STORAGE_KEY, theme);
    vi.stubGlobal('innerWidth', width);
    document.title = 'Ferrum Nexus';
    const branding: BrandingResponse = {
      portal_name: 'Saved QA Portal',
      logo_data_url: null,
      primary_color: '#2563eb',
      accent_color: '#38bdf8',
      default_theme: theme,
      tagline: null,
      support_email: null,
      radius: 'md',
      font_preset: 'system',
      sidebar_style: 'surface',
      login_layout: 'split',
      footer_text: null,
      footer_links: [],
      captcha: { enabled: false, provider: 'none', site_key: null },
      registration: { open_registration: true, allowed_roles: ['client', 'provider'] },
      bootstrap_required: false,
    };
    let finishAuth = (): void => undefined;
    let finishBranding = (): void => undefined;
    const authResponse = new Promise<void>((resolve) => {
      finishAuth = resolve;
    });
    const brandingResponse = new Promise<void>((resolve) => {
      finishBranding = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/auth/me') {
          return authResponse.then(() => json({ user: alice, capabilities: null }));
        }
        if (url === '/api/branding') return brandingResponse.then(() => json(branding));
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['credentials'], 'private metadata');
    client.setQueryData(['branding', 'private'], 'not a public query');
    client.getMutationCache().build(client, { mutationKey: ['private-mutation'] });
    render(
      <ThemeProvider>
        <QueryClientProvider client={client}>
          <AuthProvider>
            <BrandingStyles />
            <BrandingSession />
          </AuthProvider>
        </QueryClientProvider>
      </ThemeProvider>,
    );
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/branding', expect.anything()));
    const originalQuery = client.getQueryCache().find({ queryKey: queryKeys.branding });
    if (first === 'branding') {
      await act(async () => finishBranding());
      await waitFor(() => expect(document.title).toBe(branding.portal_name));
    }
    await act(async () => finishAuth());
    expect(await screen.findByText('authenticated')).toBeInTheDocument();
    expect(client.getQueryData(['credentials'])).toBeUndefined();
    expect(client.getQueryData(['branding', 'private'])).toBeUndefined();
    expect(client.getMutationCache().getAll()).toHaveLength(0);
    if (first === 'auth') await act(async () => finishBranding());
    // The authenticated reader models the sidebar/settings mounting after auth.
    // With clear(), it sees a replacement query while BrandingStyles stays stale.
    expect(await screen.findByText(branding.portal_name)).toBeInTheDocument();
    const tokens = {
      ...deriveAccentScale(parseHex(branding.primary_color)!, theme),
      ...deriveInfoScale(parseHex(branding.accent_color)!, theme),
    };
    await waitFor(() => {
      expect(document.title).toBe(branding.portal_name);
      expect(document.documentElement).toHaveAttribute('data-theme', theme);
      for (const [name, value] of Object.entries(tokens)) {
        expect(document.documentElement.style.getPropertyValue(name)).toBe(value);
      }
    });
    expect(client.getQueryCache().find({ queryKey: queryKeys.branding })).toBe(originalQuery);
    // Subsequent settings saves must still reach the original mounted observer.
    act(() => {
      client.setQueryData(queryKeys.branding, { ...branding, portal_name: 'Renamed portal' });
    });
    await waitFor(() => expect(document.title).toBe('Renamed portal'));
  });
});

describe('session cache isolation', () => {
  it.each(['Refresh', 'Logout', 'Probe'])(
    'removes Alice credentials before Bob signs in after %s',
    async (path) => {
      const { expire, finishBob } = setup();
      await waitFor(() => {
        expect(screen.getByTestId('credentials')).toHaveTextContent('alice-credential');
      });
      client.setQueryData(queryKeys.branding, { portal_name: 'Public portal' });
      client.setQueryData(queryKeys.captcha, { enabled: false });
      client.getMutationCache().build(client, { mutationKey: ['alice-mutation'] });
      expire();
      fireEvent.click(screen.getByRole('button', { name: path }));
      expect(await screen.findByText('unauthenticated')).toBeInTheDocument();
      expect(client.getQueryCache().getAll()).toHaveLength(2);
      expect(client.getQueryData(queryKeys.branding)).toEqual({ portal_name: 'Public portal' });
      expect(client.getQueryData(queryKeys.captcha)).toEqual({ enabled: false });
      expect(client.getMutationCache().getAll()).toHaveLength(0);
      // Even data populated while signed out must not survive the next sign-in.
      client.setQueryData(['anonymous'], 'signed-out data');
      fireEvent.click(screen.getByRole('button', { name: 'Login Bob' }));
      expect(await screen.findByText('Bob')).toBeInTheDocument();
      expect(client.getQueryData(['anonymous'])).toBeUndefined();
      expect(observedByBob.length).toBeGreaterThan(0);
      expect(observedByBob.every((contents) => !contents.includes('alice-credential'))).toBe(true);
      await act(async () => finishBob());
      await waitFor(() => {
        expect(screen.getByTestId('credentials')).toHaveTextContent('"items":[]');
      });
      expect(observedByBob.every((contents) => !contents.includes('alice-credential'))).toBe(true);
    },
  );

  it('preserves Alice and her cache on a transient refresh failure', async () => {
    setup();
    await waitFor(() => {
      expect(screen.getByTestId('credentials')).toHaveTextContent('alice-credential');
    });
    const probe = vi
      .spyOn(authApi, 'meSilent')
      .mockRejectedValue(new ApiError(ERROR_CODES.INTERNAL, 'Temporarily unavailable', 503));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(probe).toHaveBeenCalledOnce());
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByTestId('credentials')).toHaveTextContent('alice-credential');
    expect(client.getQueryCache().getAll()).toHaveLength(1);
  });
});
