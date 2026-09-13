/**
 * Two cards of the admin settings page.
 *
 * **Registration** used to contradict the policy it was editing: `allowed_roles`
 * is enforced on every registration and is now published to the sign-up form by
 * `GET /api/branding`, but the card advertised the `REGISTRABLE_ROLES` constant
 * and its save payload omitted the field entirely — so an administrator who
 * narrowed the policy through the API saw a card that disagreed with the
 * server, and could not narrow it from the browser at all.
 *
 * **CAPTCHA** used to be able to lock the whole portal out: saving an enabled
 * configuration made register and login demand a token from everyone, this
 * administrator included, with nothing checking that the site key, the secret
 * and the vendor script actually worked. The card now mints a token from the
 * values in the form and submits it as `captcha_token`, which is what the
 * server's activation self-test requires (ferrum-nexus#252).
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdminSettingsResponse, CaptchaAdminSettings, Role } from '@ferrum-nexus/shared';
import { CaptchaCard, RegistrationCard } from './AdminSettingsPage';

const update = vi.hoisted(() => vi.fn());

// The page pulls every settings hook; only the card under test is rendered, so
// the rest are stood in with inert shapes.
vi.mock('../../hooks/useAdminSettings', () => ({
  useAdminSettings: () => ({ isLoading: true, data: undefined }),
  useUpdateAdminSettings: () => ({ mutate: update, isPending: false }),
  useSmtpTest: () => ({ mutate: vi.fn(), isPending: false }),
  useEmailTemplates: () => ({ isLoading: true, data: undefined }),
  useEmailTemplate: () => ({ isLoading: true, data: undefined }),
  useUpdateEmailTemplate: () => ({ mutate: vi.fn(), isPending: false }),
  useMassEmail: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('../../stores/toast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock('../../stores/auth', () => ({ useAuth: () => ({ canSuperAdmin: true }) }));

/** Props the real widget takes; only the two the card passes are used here. */
interface StubWidgetProps {
  config: { enabled: boolean; provider: string; site_key: string | null };
  onToken: (token: string | null) => void;
}

// The real widget injects a vendor script and renders a cross-origin iframe.
// The card's contract with it is "hand back a token", so that is what is stubbed.
vi.mock('../../components/auth/CaptchaWidget', async () => {
  const { createElement } = await import('react');
  return {
    CaptchaWidget: ({ config, onToken }: StubWidgetProps) =>
      createElement(
        'button',
        { type: 'button', onClick: () => onToken(`solved-for-${config.site_key}`) },
        'solve the challenge',
      ),
  };
});

function settingsWith(
  allowed: Role[],
  captcha: Partial<CaptchaAdminSettings> = {},
): AdminSettingsResponse {
  return {
    branding: {
      portal_name: 'Acme Developer Portal',
      logo_data_url: null,
      primary_color: '#4f46e5',
      accent_color: '#22d3ee',
      default_theme: 'dark',
      tagline: null,
      support_email: null,
    },
    captcha: {
      enabled: false,
      provider: 'none',
      site_key: null,
      secret_set: false,
      enforcement: 'enforced',
      ...captcha,
    },
    smtp: {
      host: null,
      port: 587,
      secure: false,
      username: null,
      password_set: false,
      from_address: null,
    },
    registration: {
      open_registration: true,
      require_email_verification: false,
      allowed_roles: allowed,
    },
    gateway: { public_url: null },
  };
}

/** A stored configuration that is complete but switched off. */
const READY_TO_ENABLE: Partial<CaptchaAdminSettings> = {
  enabled: false,
  provider: 'turnstile',
  site_key: 'public-site',
  secret_set: true,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('registration policy card', () => {
  it('reflects the stored policy rather than the constant', () => {
    render(<RegistrationCard settings={settingsWith(['client'])} />);
    expect(screen.getByLabelText('Client')).toBeChecked();
    expect(screen.getByLabelText('Provider')).not.toBeChecked();
  });

  it('saves the roles it shows', () => {
    render(<RegistrationCard settings={settingsWith(['client'])} />);
    fireEvent.click(screen.getByLabelText('Provider'));
    fireEvent.click(screen.getByRole('button', { name: 'Save registration settings' }));

    expect(update).toHaveBeenCalledWith(
      {
        registration: {
          open_registration: true,
          require_email_verification: false,
          allowed_roles: ['client', 'provider'],
        },
      },
      expect.any(Object),
    );
  });

  it('warns when the policy would leave nobody able to register', () => {
    render(<RegistrationCard settings={settingsWith(['client'])} />);
    fireEvent.click(screen.getByLabelText('Client'));
    expect(screen.getByRole('alert')).toHaveTextContent(/cannot complete at all/);
  });
});

describe('CAPTCHA activation card', () => {
  const save = (): HTMLElement => screen.getByRole('button', { name: 'Save CAPTCHA settings' });

  it('will not save an activation until the challenge has been solved', () => {
    render(<CaptchaCard settings={settingsWith(['client'], READY_TO_ENABLE)} />);
    // Nothing is changing yet, so no self-test is asked for.
    expect(screen.queryByRole('button', { name: /Test this CAPTCHA/ })).toBeNull();

    fireEvent.click(screen.getByLabelText('Require a CAPTCHA challenge'));
    expect(save()).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /Test this CAPTCHA/ }));
    fireEvent.click(screen.getByRole('button', { name: 'solve the challenge' }));
    expect(save()).toBeEnabled();

    fireEvent.click(save());
    expect(update).toHaveBeenCalledWith(
      {
        captcha: {
          enabled: true,
          provider: 'turnstile',
          site_key: 'public-site',
          captcha_token: 'solved-for-public-site',
        },
      },
      expect.any(Object),
    );
  });

  it('drops a token whose configuration the form has moved away from', () => {
    render(<CaptchaCard settings={settingsWith(['client'], READY_TO_ENABLE)} />);
    fireEvent.click(screen.getByLabelText('Require a CAPTCHA challenge'));
    fireEvent.click(screen.getByRole('button', { name: /Test this CAPTCHA/ }));
    fireEvent.click(screen.getByRole('button', { name: 'solve the challenge' }));
    expect(save()).toBeEnabled();

    fireEvent.change(screen.getByLabelText('Site key'), { target: { value: 'another-site' } });
    expect(save()).toBeDisabled();
    expect(screen.getByRole('button', { name: /Test this CAPTCHA/ })).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
  });

  it('needs no challenge to re-save a configuration that is not moving', () => {
    const stored = { ...READY_TO_ENABLE, enabled: true };
    render(<CaptchaCard settings={settingsWith(['client'], stored)} />);
    expect(screen.queryByRole('button', { name: /Test this CAPTCHA/ })).toBeNull();
    fireEvent.click(save());
    expect(update).toHaveBeenCalledWith(
      { captcha: { enabled: true, provider: 'turnstile', site_key: 'public-site' } },
      expect.any(Object),
    );
  });

  it('says so when the server is running with enforcement switched off', () => {
    const stored = { ...READY_TO_ENABLE, enabled: true, enforcement: 'disabled' as const };
    render(<CaptchaCard settings={settingsWith(['client'], stored)} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/NEXUS_CAPTCHA_ENFORCEMENT=disabled/);
  });
});
