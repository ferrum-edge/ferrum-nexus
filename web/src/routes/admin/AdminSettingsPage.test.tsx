/**
 * The registration card, which used to contradict the policy it was editing.
 *
 * `allowed_roles` is enforced on every registration and is now published to the
 * sign-up form by `GET /api/branding`, but the card advertised the
 * `REGISTRABLE_ROLES` constant and its save payload omitted the field entirely
 * — so an administrator who narrowed the policy through the API saw a card that
 * disagreed with the server, and could not narrow it from the browser at all.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdminSettingsResponse, Role } from '@ferrum-nexus/shared';
import { RegistrationCard } from './AdminSettingsPage';

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

function settingsWith(allowed: Role[]): AdminSettingsResponse {
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
    captcha: { enabled: false, provider: 'none', site_key: null, secret_set: false },
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
