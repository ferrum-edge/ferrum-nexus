import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ERROR_CODES } from '@ferrum-nexus/shared';
import { App, describeError } from './App';
import { ApiError } from './lib/api';

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
              bootstrap_required: false,
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
    // Required fields render an asterisk inside the label, hence the pattern.
    expect(await screen.findByLabelText(/^Email/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Password/)).toBeInTheDocument();
    // Branding is applied to the public shell.
    expect(await screen.findByText('Acme Developer Portal')).toBeInTheDocument();
    // Nothing from the authenticated shell leaks into the public page.
    expect(screen.queryByRole('navigation', { name: 'Primary' })).not.toBeInTheDocument();
  });
});

describe('describeError', () => {
  const edgeError = (message: string, details?: unknown): ApiError =>
    new ApiError(ERROR_CODES.EDGE_ERROR, message, 502, details);

  it('appends the gateway’s own reason so a provider can act on it', () => {
    const error = edgeError('The gateway rejected the request', {
      status: 400,
      gateway_message: 'FERRUM_BASIC_AUTH_HMAC_SECRET must be set',
    });
    expect(describeError(error)).toBe(
      'The gateway rejected the request — FERRUM_BASIC_AUTH_HMAC_SECRET must be set',
    );
  });

  it('does not repeat a reason the message already carries', () => {
    const error = edgeError('The gateway rejected the request: listen_path already exists', {
      status: 409,
      gateway_message: 'listen_path already exists',
    });
    expect(describeError(error)).toBe(
      'The gateway rejected the request: listen_path already exists',
    );
  });

  it('falls back to the message when there is no gateway detail', () => {
    expect(describeError(edgeError('The gateway rejected the request', { status: 500 }))).toBe(
      'The gateway rejected the request',
    );
    expect(describeError(new Error('boom'))).toBe('boom');
    expect(describeError('not an error')).toBe('Unexpected error');
  });
});
