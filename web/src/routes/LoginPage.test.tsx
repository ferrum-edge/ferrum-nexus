/**
 * The sign-in page under each login policy.
 *
 * `GET /api/auth/sso` says which single sign-on providers to offer and whether
 * the password form still works. A provider button is a full navigation to
 * the server's start route, and a refused sign-in comes back as
 * `?sso_error=<reason>`, which the page turns into a message from a fixed set.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ERROR_CODES, type SsoPublicConfigResponse } from '@ferrum-nexus/shared';
import { SSO_ERROR_MESSAGES } from '../lib/sso-errors';

const CAPTCHA = { enabled: false, provider: 'none', site_key: null };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubApi(sso: SsoPublicConfigResponse): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/branding')) {
        return Promise.resolve(
          json({
            portal_name: 'Acme Developer Portal',
            logo_data_url: null,
            primary_color: '#f97316',
            accent_color: '#60a5fa',
            default_theme: 'dark',
            tagline: null,
            support_email: null,
            captcha: CAPTCHA,
            bootstrap_required: false,
          }),
        );
      }
      if (url.startsWith('/api/auth/captcha')) return Promise.resolve(json(CAPTCHA));
      if (url.startsWith('/api/auth/sso')) return Promise.resolve(json(sso));
      return Promise.resolve(
        json({ error: { code: ERROR_CODES.UNAUTHORIZED, message: 'no session' } }, 401),
      );
    }),
  );
}

/** Render the app on `path` with a fresh query cache (see `RegisterPage.test.tsx`). */
async function renderLogin(sso: SsoPublicConfigResponse, path = '/login'): Promise<void> {
  stubApi(sso);
  vi.resetModules();
  const { App } = await import('../App');
  window.history.pushState({}, '', path);
  render(<App />);
  await screen.findByRole('heading', { name: 'Sign in' });
}

const PROVIDERS = [{ id: 'corp', display_name: 'Corporate SSO' }];

describe('LoginPage single sign-on', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.history.pushState({}, '', '/');
  });

  it('offers a button per provider beside the password form', async () => {
    await renderLogin({
      policy: 'local_and_sso',
      password_login: 'enabled',
      registration_enabled: true,
      providers: PROVIDERS,
    });
    const button = await screen.findByRole('link', { name: /Continue with Corporate SSO/ });
    expect(button).toHaveAttribute('href', '/api/auth/sso/corp/start');
    expect(screen.getByLabelText(/^Password/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Register' })).toBeInTheDocument();
  });

  it('hides the password form and registration under sso_only', async () => {
    await renderLogin({
      policy: 'sso_only',
      password_login: 'disabled',
      registration_enabled: false,
      providers: PROVIDERS,
    });
    expect(
      await screen.findByRole('link', { name: /Continue with Corporate SSO/ }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Password/)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Register' })).not.toBeInTheDocument();
  });

  it('keeps a break-glass password form behind a link', async () => {
    await renderLogin({
      policy: 'sso_only',
      password_login: 'break_glass',
      registration_enabled: false,
      providers: PROVIDERS,
    });
    const reveal = await screen.findByRole('button', {
      name: 'Administrator sign-in with a password',
    });
    expect(screen.queryByLabelText(/^Password/)).not.toBeInTheDocument();
    fireEvent.click(reveal);
    expect(await screen.findByLabelText(/^Password/)).toBeInTheDocument();
    expect(screen.getByText(/open to super admins only/)).toBeInTheDocument();
  });

  it('explains a refused single sign-on', async () => {
    await renderLogin(
      {
        policy: 'local_and_sso',
        password_login: 'enabled',
        registration_enabled: true,
        providers: PROVIDERS,
      },
      '/login?sso_error=email_not_verified',
    );
    expect(await screen.findByText(SSO_ERROR_MESSAGES.email_not_verified)).toBeInTheDocument();
  });

  it('shows nothing for a reason it does not know', async () => {
    await renderLogin(
      {
        policy: 'local_and_sso',
        password_login: 'enabled',
        registration_enabled: true,
        providers: PROVIDERS,
      },
      '/login?sso_error=not-a-reason',
    );
    await screen.findByRole('link', { name: /Continue with Corporate SSO/ });
    for (const message of Object.values(SSO_ERROR_MESSAGES)) {
      expect(screen.queryByText(message)).not.toBeInTheDocument();
    }
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
