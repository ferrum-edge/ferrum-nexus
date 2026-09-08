import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createMemoryHistory } from '@tanstack/react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ERROR_CODES } from '@ferrum-nexus/shared';
import { App } from './App';
import { router } from './router';

const branding = {
  portal_name: 'Test portal',
  logo_data_url: null,
  primary_color: '#f97316',
  accent_color: '#60a5fa',
  default_theme: 'dark',
  tagline: null,
  support_email: null,
  captcha: { enabled: false, provider: 'none', site_key: null },
  bootstrap_required: false,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubApi(authenticated: boolean, status: number, message: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method !== 'GET') {
        const code = status === 401 ? ERROR_CODES.UNAUTHORIZED : ERROR_CODES.VALIDATION_FAILED;
        return Promise.resolve(json({ error: { code, message } }, status));
      }
      if (url === '/api/auth/me') {
        return Promise.resolve(
          authenticated
            ? json({
                user: {
                  id: 'admin',
                  display_name: 'Admin',
                  email: 'admin@example.test',
                  role: 'super_admin',
                  status: 'active',
                  email_verified: true,
                  created_at: '2026-09-08T00:00:00.000Z',
                  last_login_at: null,
                },
                capabilities: null,
              })
            : json({ error: { code: ERROR_CODES.UNAUTHORIZED, message: 'No session' } }, 401),
        );
      }
      if (url === '/api/branding') return Promise.resolve(json(branding));
      if (url === '/api/auth/captcha') return Promise.resolve(json(branding.captcha));
      if (url === '/api/admin/settings') {
        return Promise.resolve(json({ branding, gateway: { public_url: null } }));
      }
      return Promise.resolve(json({ items: [], total: 0, unread_count: 0 }));
    }),
  );
}

async function openApp(path: string): Promise<void> {
  router.update({ history: createMemoryHistory({ initialEntries: [path] }) });
  render(<App />);
  await act(async () => {
    await router.load();
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('App mutation error policy', () => {
  it('shows a settings PUT 400 in the gateway form and toast', async () => {
    const message =
      'gateway.public_url must be an absolute http(s) origin with no path, query string or ' +
      'credentials, e.g. https://api.example.com';
    stubApi(true, 400, message);
    await openApp('/admin/settings');
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Gateway' }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.change(await screen.findByLabelText('Public gateway URL'), {
      target: { value: 'api.example.com/gateway' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save gateway' }));
    expect(await screen.findByText('Request failed')).toBeInTheDocument();
    expect(within(screen.getByRole('tabpanel')).getByRole('alert')).toHaveTextContent(message);
    expect(fetch).toHaveBeenCalledWith(
      '/api/admin/settings',
      expect.objectContaining({ method: 'PUT' }),
    );
  });

  it.each([
    [400, 'Request validation failed'],
    [413, 'Request body is too large'],
    [415, 'Unsupported media type'],
    [422, 'Invalid request content'],
  ])('shows a profile PATCH %s with the server message', async (status, message) => {
    stubApi(true, status, message);
    await openApp('/profile');
    const input = await screen.findByLabelText(/^Display name/);
    fireEvent.change(input, { target: { value: '   ' } });
    const form = input.closest('form');
    expect(form).not.toBeNull();
    fireEvent.submit(form!);
    expect(await screen.findByText('Request failed')).toBeInTheDocument();
    expect(within(form!).getByRole('alert')).toHaveTextContent(message);
    expect(fetch).toHaveBeenCalledWith(
      '/api/users/me',
      expect.objectContaining({ method: 'PATCH' }),
    );
  });

  it.each([
    ['/login', 'Sign in'],
    ['/register', 'Create an account'],
    ['/forgot-password', 'Reset your password'],
    ['/reset-password?token=test-token', 'Choose a new password'],
  ])('keeps %s validation errors inline only', async (path, heading) => {
    const message = 'The submitted fields are invalid';
    stubApi(false, 400, message);
    await openApp(path);
    expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument();
    for (const input of screen.queryAllByLabelText(/password/i)) {
      fireEvent.change(input, { target: { value: 'test-password-long-enough' } });
    }
    const form = document.querySelector('form');
    expect(form).not.toBeNull();
    fireEvent.submit(form!);
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(screen.queryByText('Request failed')).not.toBeInTheDocument();
    expect(screen.queryByText('Could not load data')).not.toBeInTheDocument();
  });

  it('tears down an unauthorized mutation without a failure toast', async () => {
    stubApi(true, 401, 'Session expired');
    await openApp('/profile');
    const input = await screen.findByLabelText(/^Display name/);
    fireEvent.submit(input.closest('form')!);
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByText('Request failed')).not.toBeInTheDocument();
  });
});
