/**
 * CAPTCHA widget for the login and register forms.
 *
 * Nothing renders unless `GET /api/auth/captcha` reports the feature enabled.
 * The vendor script is injected at that point (never bundled), and every
 * failure path degrades to a visible note plus a `null` token — the server
 * remains the authority on whether a token was required.
 */

import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { CaptchaProvider, CaptchaPublicConfig } from '@ferrum-nexus/shared';

/** The subset of each vendor's global API that this widget uses. */
interface CaptchaVendorApi {
  render: (
    container: HTMLElement,
    parameters: {
      sitekey: string;
      callback: (token: string) => void;
      'expired-callback'?: () => void;
    },
  ) => unknown;
}

const VENDOR_SCRIPTS: Readonly<Record<Exclude<CaptchaProvider, 'none'>, string>> = {
  turnstile: 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
  hcaptcha: 'https://js.hcaptcha.com/1/api.js?render=explicit',
  recaptcha: 'https://www.google.com/recaptcha/api.js?render=explicit',
};

const VENDOR_GLOBALS: Readonly<Record<Exclude<CaptchaProvider, 'none'>, string>> = {
  turnstile: 'turnstile',
  hcaptcha: 'hcaptcha',
  recaptcha: 'grecaptcha',
};

function readVendorApi(globalName: string): CaptchaVendorApi | null {
  // The vendor attaches an untyped global; it is validated structurally here.
  const candidate = (window as unknown as Record<string, unknown>)[globalName];
  if (candidate && typeof candidate === 'object' && 'render' in candidate) {
    const { render } = candidate as { render: unknown };
    if (typeof render === 'function') return candidate as CaptchaVendorApi;
  }
  return null;
}

function loadScript(src: string): Promise<void> {
  const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
  if (existing) {
    if (existing.dataset.loaded === 'true') return Promise.resolve();
    return new Promise((resolve, reject) => {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('script failed to load')));
    });
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.defer = true;
    script.addEventListener('load', () => {
      script.dataset.loaded = 'true';
      resolve();
    });
    script.addEventListener('error', () => reject(new Error('script failed to load')));
    document.head.appendChild(script);
  });
}

export interface CaptchaWidgetProps {
  config: CaptchaPublicConfig | undefined;
  /** Receives the vendor token, or `null` when it expires or cannot load. */
  onToken: (token: string | null) => void;
}

/** Renders the configured CAPTCHA vendor's widget, or nothing when disabled. */
export function CaptchaWidget({ config, onToken }: CaptchaWidgetProps): ReactElement | null {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);

  const provider = config?.provider ?? 'none';
  const siteKey = config?.site_key ?? null;
  const enabled = Boolean(config?.enabled) && provider !== 'none' && siteKey !== null;

  useEffect(() => {
    // `enabled` already narrows `provider` away from 'none' and `siteKey` away
    // from null (aliased-condition narrowing).
    if (!enabled) return;
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;

    const globalName = VENDOR_GLOBALS[provider];
    const source = VENDOR_SCRIPTS[provider];

    void loadScript(source)
      .then(() => {
        if (cancelled) return;
        // Vendors publish their global slightly after the script's load event.
        const attempt = (remaining: number): void => {
          if (cancelled) return;
          const api = readVendorApi(globalName);
          if (api) {
            container.innerHTML = '';
            api.render(container, {
              sitekey: siteKey,
              callback: (token: string) => onToken(token),
              'expired-callback': () => onToken(null),
            });
            return;
          }
          if (remaining === 0) {
            setFailed(true);
            onToken(null);
            return;
          }
          window.setTimeout(() => attempt(remaining - 1), 150);
        };
        attempt(20);
      })
      .catch(() => {
        if (cancelled) return;
        setFailed(true);
        onToken(null);
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, provider, siteKey, onToken]);

  if (!enabled) return null;

  return (
    <div className="flex flex-col gap-1.5">
      <div ref={containerRef} data-testid="captcha-container" />
      {failed ? (
        <p className="text-xs text-warning" role="status">
          The CAPTCHA widget could not be loaded. You can still submit the form; the server will
          reject the request if a challenge is required.
        </p>
      ) : null}
    </div>
  );
}
