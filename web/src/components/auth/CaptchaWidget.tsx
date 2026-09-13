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

/** Bound on the vendor `<script>` fetch itself, not the later global poll. */
const SCRIPT_LOAD_TIMEOUT_MS = 10_000;

const VENDOR_GLOBAL_POLL_MS = 150;
const VENDOR_GLOBAL_POLL_ATTEMPTS = 20;

/**
 * In-flight loads keyed by script URL. Settled outcomes are not stored here:
 * success is recorded on the tag (`data-loaded="true"`), and failure deletes
 * the entry so a later mount can retry.
 */
const inflightScripts = new Map<string, Promise<void>>();

function readVendorApi(globalName: string): CaptchaVendorApi | null {
  // The vendor attaches an untyped global; it is validated structurally here.
  const candidate = (window as unknown as Record<string, unknown>)[globalName];
  if (candidate && typeof candidate === 'object' && 'render' in candidate) {
    const { render } = candidate as { render: unknown };
    if (typeof render === 'function') return candidate as CaptchaVendorApi;
  }
  return null;
}

function scriptElement(src: string): HTMLScriptElement | null {
  return document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
}

/**
 * Load a vendor script once per URL, sharing one in-flight Promise across
 * concurrent mounts (sign-in and register in the same SPA document).
 *
 * On failure the tag is removed rather than keeping a rejected Promise. The
 * `error` event does not replay, so a later form that attached fresh `load` /
 * `error` listeners to a dead tag would wait forever with no widget and no
 * failure note. Dropping the tag lets the next mount retry, which is what a
 * transient network blip needs; a sticky rejected state would report immediately
 * but never recover without a full document reload.
 *
 * The load itself is bounded: a script that never emits `load` or `error`
 * is treated as the same failure (visible note + `onToken(null)`). Listeners
 * and the timeout are cleared when the Promise settles. Widget unmount does
 * not abort a shared load — another form may still be waiting.
 */
function loadScript(src: string): Promise<void> {
  const existing = scriptElement(src);
  if (existing?.dataset.loaded === 'true') return Promise.resolve();

  const inflight = inflightScripts.get(src);
  if (inflight) return inflight;

  // Leftover tag from a previous error or timeout: events will not replay, so
  // attaching new listeners would hang. Remove it and fetch again.
  existing?.remove();

  const promise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.defer = true;

    let settled = false;

    const finish = (error: Error | null): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      script.removeEventListener('load', onLoad);
      script.removeEventListener('error', onError);
      if (error) {
        script.remove();
        inflightScripts.delete(src);
        reject(error);
        return;
      }
      script.dataset.loaded = 'true';
      inflightScripts.delete(src);
      resolve();
    };

    const onLoad = (): void => finish(null);
    const onError = (): void => finish(new Error('script failed to load'));
    const timeoutId = window.setTimeout(() => {
      finish(new Error('script failed to load'));
    }, SCRIPT_LOAD_TIMEOUT_MS);

    script.addEventListener('load', onLoad);
    script.addEventListener('error', onError);
    document.head.appendChild(script);
  });

  inflightScripts.set(src, promise);
  return promise;
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
    let pollTimer: number | undefined;
    const container = containerRef.current;
    if (!container) return;

    const globalName = VENDOR_GLOBALS[provider];
    const source = VENDOR_SCRIPTS[provider];

    const reportFailure = (): void => {
      if (cancelled) return;
      setFailed(true);
      onToken(null);
    };

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
            reportFailure();
            return;
          }
          pollTimer = window.setTimeout(() => attempt(remaining - 1), VENDOR_GLOBAL_POLL_MS);
        };
        attempt(VENDOR_GLOBAL_POLL_ATTEMPTS);
      })
      .catch(() => {
        reportFailure();
      });

    return () => {
      cancelled = true;
      if (pollTimer !== undefined) window.clearTimeout(pollTimer);
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
