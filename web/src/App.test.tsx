import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ERROR_CODES } from '@ferrum-nexus/shared';
import { App } from './App';

/**
 * Smoke test for the whole provider + router composition: an unauthenticated
 * visitor must land on the sign-in page without any route crashing.
 */
function stubApi(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/branding')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              portal_name: 'Acme Developer Portal',
              logo_data_url: null,
              primary_color: '#f97316',
              accent_color: '#60a5fa',
              default_theme: 'dark',
              tagline: 'APIs for everyone',
              support_email: null,
              captcha: { enabled: false, provider: 'none', site_key: null },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      if (url.startsWith('/api/auth/captcha')) {
        return Promise.resolve(
          new Response(JSON.stringify({ enabled: false, provider: 'none', site_key: null }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({ error: { code: ERROR_CODES.UNAUTHORIZED, message: 'no session' } }),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    }),
  );
}

describe('App', () => {
  beforeEach(stubApi);

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('redirects an unauthenticated visitor to the sign-in page', async () => {
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(await screen.findByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    // Branding is applied to the public shell.
    expect(await screen.findByText('Acme Developer Portal')).toBeInTheDocument();
    // Nothing from the authenticated shell leaks into the public page.
    expect(screen.queryByRole('navigation', { name: 'Primary' })).not.toBeInTheDocument();
  });
});
