/**
 * Branding tab: hex validation before submit, and the class/container
 * structure that keeps cards inside a 320px viewport.
 *
 * jsdom cannot measure layout, so overflow at 320px is asserted structurally
 * (min-w-0 / max-w-full / wrapping / inner scroller) rather than in pixels.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdminSettingsResponse } from '@ferrum-nexus/shared';
import { BrandingTab } from './BrandingTab';

const update = vi.hoisted(() => vi.fn());

vi.mock('../../../hooks/useAdminSettings', () => ({
  useUpdateAdminSettings: () => ({ mutate: update, isPending: false }),
}));
vi.mock('../../../stores/toast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../lib/fonts', () => ({
  loadFontPreset: () => Promise.resolve('sans-serif'),
  fontStackFor: () => 'sans-serif',
}));

/** Props the real `LabeledSelect` takes; only the four the tab passes are used. */
interface StubSelectProps {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
}

vi.mock('../../../components/ui/Select', async () => {
  const { createElement } = await import('react');
  return {
    LabeledSelect: ({ label, value, onValueChange, options }: StubSelectProps) =>
      createElement(
        'label',
        null,
        label,
        createElement(
          'select',
          {
            value,
            onChange: (event: { target: { value: string } }) => onValueChange(event.target.value),
          },
          options.map((option) =>
            createElement('option', { key: option.value, value: option.value }, option.label),
          ),
        ),
      ),
  };
});

function settings(): AdminSettingsResponse {
  return {
    branding: {
      portal_name: 'Ferrum QA Portal',
      logo_data_url: null,
      primary_color: '#4f46e5',
      accent_color: '#22d3ee',
      default_theme: 'dark',
      tagline: null,
      support_email: null,
      radius: 'md',
      font_preset: 'system',
      sidebar_style: 'surface',
      login_layout: 'split',
      footer_text: null,
      footer_links: [],
    },
    captcha: {
      enabled: false,
      provider: 'none',
      site_key: null,
      secret_set: false,
      enforcement: 'enforced',
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
      allowed_roles: ['client', 'provider'],
    },
    gateway: { public_url: null },
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('branding colour validation', () => {
  it('blocks five-digit hex before any request', () => {
    render(<BrandingTab settings={settings()} />);
    fireEvent.change(screen.getByLabelText('Primary colour hex value'), {
      target: { value: '#12345' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save branding' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/3- or 6-digit CSS hex/);
    expect(update).not.toHaveBeenCalled();
  });

  it('blocks seven-digit hex before any request', () => {
    render(<BrandingTab settings={settings()} />);
    fireEvent.change(screen.getByLabelText('Accent colour hex value'), {
      target: { value: '#1234567' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save branding' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/3- or 6-digit CSS hex/);
    expect(update).not.toHaveBeenCalled();
  });

  it('sends accepted colours as lowercase #rrggbb', () => {
    render(<BrandingTab settings={settings()} />);
    fireEvent.change(screen.getByLabelText('Primary colour hex value'), {
      target: { value: '#fff' },
    });
    fireEvent.change(screen.getByLabelText('Accent colour hex value'), {
      target: { value: '#2563EB' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save branding' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        branding: expect.objectContaining({
          primary_color: '#ffffff',
          accent_color: '#2563eb',
        }),
      }),
      expect.any(Object),
    );
  });
});

describe('narrow viewport layout structure', () => {
  it('lets grid children, colour inputs and the preview shrink', () => {
    render(<BrandingTab settings={settings()} />);
    const layout = screen.getByTestId('branding-layout');
    expect(layout.className).toMatch(/\bmin-w-0\b/);
    expect(layout.className).toMatch(/\bmax-w-full\b/);
    expect(layout.className).toContain('minmax(0,1fr)');
    expect(layout.className).toContain('minmax(0,22rem)');
    for (const child of Array.from(layout.children)) {
      expect(child.className).toMatch(/\bmin-w-0\b/);
      expect(child.className).toMatch(/\bmax-w-full\b/);
    }

    const hex = screen.getByLabelText('Primary colour hex value');
    expect(hex).toHaveClass('min-w-0', 'w-full', 'max-w-full');
    expect(screen.getByTestId('primary-color-row').className).toMatch(/\bmin-w-0\b/);
    expect(screen.getByTestId('accent-color-row').className).toMatch(/\bmax-w-full\b/);

    const preview = screen.getByTestId('branding-preview');
    expect(preview.className).toMatch(/\bmin-w-0\b/);
    expect(preview.className).toMatch(/\bmax-w-full\b/);
    expect(preview.querySelector('.overflow-x-auto')).not.toBeNull();
    expect(screen.getByLabelText('dark theme preview').className).toMatch(/\bmin-w-0\b/);
    expect(screen.getByLabelText('dark theme preview').className).toMatch(/\bmax-w-full\b/);
    expect(screen.getByLabelText('light theme preview').querySelector('.flex-wrap')).not.toBeNull();
  });
});
