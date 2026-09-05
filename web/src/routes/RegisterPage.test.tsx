/**
 * The sign-up form's bootstrap branch.
 *
 * `GET /api/branding` says whether the portal still has zero accounts. While it
 * does, the first registration elects the super_admin and the server demands
 * the operator's bootstrap token, so the form has to ask for it and send it —
 * otherwise the only way to create the founding account is by hand with curl.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ERROR_CODES, type RegisterRequest } from '@ferrum-nexus/shared';

const CAPTCHA = { enabled: false, provider: 'none', site_key: null };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Stub the public endpoints and record every registration attempt. */
function stubApi(bootstrapRequired: boolean): { bodies: RegisterRequest[] } {
  const bodies: RegisterRequest[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
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
            bootstrap_required: bootstrapRequired,
          }),
        );
      }
      if (url.startsWith('/api/auth/captcha')) return Promise.resolve(json(CAPTCHA));
      if (url.startsWith('/api/auth/register')) {
        bodies.push(JSON.parse(String(init?.body)) as RegisterRequest);
        return Promise.resolve(
          json(
            {
              user: {
                id: 'user-1',
                email: 'founder@example.test',
                display_name: 'Founder',
                role: 'super_admin',
                email_verified: true,
              },
              email_verification_required: false,
            },
            201,
          ),
        );
      }
      return Promise.resolve(
        json({ error: { code: ERROR_CODES.UNAUTHORIZED, message: 'no session' } }, 401),
      );
    }),
  );
  return { bodies };
}

/**
 * Render the app on `/register` and wait for the lazily-loaded page.
 *
 * `App` owns a module-level `QueryClient`, so the branding answer of one case
 * would otherwise stay cached for the next. Re-importing it after
 * `vi.resetModules()` gives each case its own client and its own cache.
 */
async function renderRegisterPage(bootstrapRequired: boolean): Promise<{
  bodies: RegisterRequest[];
}> {
  const stub = stubApi(bootstrapRequired);
  vi.resetModules();
  const { App } = await import('../App');
  window.history.pushState({}, '', '/register');
  render(<App />);
  await screen.findByRole('heading', { name: 'Create an account' });
  return stub;
}

describe('RegisterPage bootstrap token', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.history.pushState({}, '', '/');
  });

  it('asks for the token on an empty portal and sends it', async () => {
    const { bodies } = await renderRegisterPage(true);

    expect(screen.getByText(/becomes its super-admin/)).toBeInTheDocument();
    const token = await screen.findByLabelText(/^Bootstrap token/);
    expect(token).toHaveAttribute('type', 'password');
    expect(screen.getByText(/NEXUS_BOOTSTRAP_TOKEN/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/^Display name/), { target: { value: 'Founder' } });
    fireEvent.change(screen.getByLabelText(/^Email/), {
      target: { value: 'founder@example.test' },
    });
    fireEvent.change(screen.getByLabelText(/^Password/), {
      target: { value: 'correct-horse-battery-staple' },
    });
    fireEvent.change(token, { target: { value: 'bootstrap-token-0123456789' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]?.bootstrap_token).toBe('bootstrap-token-0123456789');
    expect(bodies[0]?.email).toBe('founder@example.test');
  });

  it('hides the field once the portal has accounts', async () => {
    const { bodies } = await renderRegisterPage(false);

    expect(screen.queryByLabelText(/^Bootstrap token/)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/^Display name/), { target: { value: 'Joiner' } });
    fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: 'joiner@example.test' } });
    fireEvent.change(screen.getByLabelText(/^Password/), {
      target: { value: 'correct-horse-battery-staple' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).not.toHaveProperty('bootstrap_token');
  });
});
