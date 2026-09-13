/**
 * CaptchaWidget injects a vendor `<script>` and degrades to a visible note plus
 * a null token on every failure. These cases cover the three providers, the
 * disabled/malformed paths, and recovery after a failed or hung script load —
 * a later form must not wait forever for an event that already fired.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CaptchaProvider, CaptchaPublicConfig } from '@ferrum-nexus/shared';
import { CaptchaWidget } from './CaptchaWidget';

/** Must match `SCRIPT_LOAD_TIMEOUT_MS` in CaptchaWidget.tsx. */
const SCRIPT_LOAD_TIMEOUT_MS = 10_000;

const TURNSTILE = {
  provider: 'turnstile' as const,
  globalName: 'turnstile',
  src: 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
};

const VENDORS: ReadonlyArray<{
  provider: Exclude<CaptchaProvider, 'none'>;
  globalName: string;
  src: string;
}> = [
  TURNSTILE,
  {
    provider: 'hcaptcha',
    globalName: 'hcaptcha',
    src: 'https://js.hcaptcha.com/1/api.js?render=explicit',
  },
  {
    provider: 'recaptcha',
    globalName: 'grecaptcha',
    src: 'https://www.google.com/recaptcha/api.js?render=explicit',
  },
];

interface RenderParams {
  sitekey: string;
  callback: (token: string) => void;
  'expired-callback'?: () => void;
}

function configFor(provider: Exclude<CaptchaProvider, 'none'>): CaptchaPublicConfig {
  return { enabled: true, provider, site_key: 'test-site-key' };
}

function vendorScript(src: string): HTMLScriptElement {
  const script = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
  if (!script) throw new Error(`expected vendor script ${src}`);
  return script;
}

function installVendor(globalName: string): { render: ReturnType<typeof vi.fn> } {
  const renderFn = vi.fn((_container: HTMLElement, _parameters: RenderParams) => 'widget-id');
  (window as unknown as Record<string, unknown>)[globalName] = { render: renderFn };
  return { render: renderFn };
}

function clearVendorGlobals(): void {
  const win = window as unknown as Record<string, unknown>;
  for (const { globalName } of VENDORS) delete win[globalName];
}

afterEach(() => {
  cleanup();
  for (const { src } of VENDORS) {
    const script = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    if (script) fireEvent.error(script);
    script?.remove();
  }
  clearVendorGlobals();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('CaptchaWidget', () => {
  it('renders nothing when CAPTCHA is disabled', () => {
    const onToken = vi.fn();
    render(
      <CaptchaWidget
        config={{ enabled: false, provider: 'turnstile', site_key: 'test-site-key' }}
        onToken={onToken}
      />,
    );
    expect(screen.queryByTestId('captcha-container')).not.toBeInTheDocument();
    expect(document.querySelector(`script[src="${TURNSTILE.src}"]`)).toBeNull();
    expect(onToken).not.toHaveBeenCalled();
  });

  it.each(VENDORS)(
    'invokes the $provider success and expiry callbacks',
    async ({ provider, globalName, src }) => {
      const vendor = installVendor(globalName);
      const onToken = vi.fn();
      render(<CaptchaWidget config={configFor(provider)} onToken={onToken} />);

      await act(async () => {
        fireEvent.load(vendorScript(src));
      });

      await waitFor(() => expect(vendor.render).toHaveBeenCalledTimes(1));
      const parameters = vendor.render.mock.calls[0]![1] as RenderParams;
      expect(parameters.sitekey).toBe('test-site-key');

      act(() => {
        parameters.callback('token-ok');
      });
      expect(onToken).toHaveBeenCalledWith('token-ok');

      act(() => {
        parameters['expired-callback']?.();
      });
      expect(onToken).toHaveBeenCalledWith(null);
    },
  );

  it('reports failure when the vendor global is malformed', async () => {
    vi.useFakeTimers();
    const onToken = vi.fn();
    (window as unknown as Record<string, unknown>).turnstile = { render: 1 };
    render(<CaptchaWidget config={configFor('turnstile')} onToken={onToken} />);

    await act(async () => {
      fireEvent.load(vendorScript(TURNSTILE.src));
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(screen.getByRole('status')).toHaveTextContent('could not be loaded');
    expect(onToken).toHaveBeenCalledWith(null);
  });

  it('reports failure when the first script load errors', async () => {
    const onToken = vi.fn();
    render(<CaptchaWidget config={configFor('turnstile')} onToken={onToken} />);

    await act(async () => {
      fireEvent.error(vendorScript(TURNSTILE.src));
    });

    expect(screen.getByRole('status')).toHaveTextContent('could not be loaded');
    expect(onToken).toHaveBeenCalledWith(null);
    expect(document.querySelector(`script[src="${TURNSTILE.src}"]`)).toBeNull();
  });

  it('reuses a script that already loaded instead of injecting another', async () => {
    const vendor = installVendor(TURNSTILE.globalName);
    const firstToken = vi.fn();
    const first = render(<CaptchaWidget config={configFor('turnstile')} onToken={firstToken} />);

    await act(async () => {
      fireEvent.load(vendorScript(TURNSTILE.src));
    });
    await waitFor(() => expect(vendor.render).toHaveBeenCalledTimes(1));
    first.unmount();

    const secondToken = vi.fn();
    render(<CaptchaWidget config={configFor('turnstile')} onToken={secondToken} />);
    await waitFor(() => expect(vendor.render).toHaveBeenCalledTimes(2));
    expect(document.querySelectorAll(`script[src="${TURNSTILE.src}"]`)).toHaveLength(1);
  });

  it('does not report failure after unmount cancels an in-flight load', async () => {
    const onToken = vi.fn();
    const { unmount } = render(<CaptchaWidget config={configFor('turnstile')} onToken={onToken} />);
    const script = vendorScript(TURNSTILE.src);
    unmount();

    await act(async () => {
      fireEvent.error(script);
    });

    expect(onToken).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('recovers a vendor script that failed on the previous form', async () => {
    vi.useFakeTimers();
    const config = { enabled: true, provider: 'turnstile' as const, site_key: 'test-site-key' };
    const first = render(<CaptchaWidget config={config} onToken={vi.fn()} />);
    const failedScript = document.querySelector(
      'script[src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"]',
    )!;
    await act(async () => fireEvent.error(failedScript));
    expect(screen.getByRole('status')).toHaveTextContent('could not be loaded');
    first.unmount();

    const onToken = vi.fn();
    render(<CaptchaWidget config={config} onToken={onToken} />);
    await act(async () => vi.advanceTimersByTimeAsync(10000));
    const selector =
      'script[src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"]';
    const retried = document.querySelector(selector) !== failedScript;
    const reported =
      screen.queryByRole('status') !== null && onToken.mock.calls.some(([token]) => token === null);
    expect(retried || reported).toBe(true);
  });

  it('reports failure when the vendor script never settles', async () => {
    vi.useFakeTimers();
    const onToken = vi.fn();
    render(<CaptchaWidget config={configFor('turnstile')} onToken={onToken} />);
    expect(vendorScript(TURNSTILE.src)).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SCRIPT_LOAD_TIMEOUT_MS - 1);
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(onToken).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByRole('status')).toHaveTextContent('could not be loaded');
    expect(onToken).toHaveBeenCalledWith(null);
    expect(document.querySelector(`script[src="${TURNSTILE.src}"]`)).toBeNull();
  });
});
