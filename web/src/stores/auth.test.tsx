import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ERROR_CODES, type User } from '@ferrum-nexus/shared';
import { ApiError, authApi } from '../lib/api';
import { useCredentials } from '../hooks/useCredentials';
import { AuthProvider, useAuth } from './auth';

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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('session cache isolation', () => {
  it.each(['Refresh', 'Logout', 'Probe'])(
    'removes Alice credentials before Bob signs in after %s',
    async (path) => {
      const { expire, finishBob } = setup();
      await waitFor(() => {
        expect(screen.getByTestId('credentials')).toHaveTextContent('alice-credential');
      });
      expire();
      fireEvent.click(screen.getByRole('button', { name: path }));
      expect(await screen.findByText('unauthenticated')).toBeInTheDocument();
      expect(client.getQueryCache().getAll()).toHaveLength(0);
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
