/**
 * Pluggable CAPTCHA verification for registration and login.
 *
 * Configuration lives in `app_settings`, not in the environment, because
 * admins change it from the UI:
 *
 * - `captcha` (plaintext) — `{ enabled, provider, site_key }`
 * - `captcha.secret_key` (AES-256-GCM encrypted) — the vendor secret
 *
 * When CAPTCHA is disabled, or the provider is `none`, verification is a
 * no-op and `getPublicConfig()` reports `enabled: false` so the SPA renders no
 * widget.
 */

import { request } from 'undici';

import type { CaptchaProvider, CaptchaPublicConfig } from '@ferrum-nexus/shared';

import type { NexusStore } from '../db/store.js';
import type { NexusCrypto } from '../lib/crypto.js';
import { captchaFailed } from '../lib/errors.js';

/** `app_settings` key holding the plaintext CAPTCHA configuration. */
export const CAPTCHA_SETTINGS_KEY = 'captcha';

/** `app_settings` key holding the encrypted vendor secret. */
export const CAPTCHA_SECRET_SETTINGS_KEY = 'captcha.secret_key';

/** Vendor verification endpoints. */
export const CAPTCHA_VERIFY_URLS: Readonly<Record<Exclude<CaptchaProvider, 'none'>, string>> = {
  turnstile: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
  hcaptcha: 'https://api.hcaptcha.com/siteverify',
  recaptcha: 'https://www.google.com/recaptcha/api/siteverify',
};

/** Shape of the stored `captcha` setting. */
export interface StoredCaptchaSettings {
  enabled: boolean;
  provider: CaptchaProvider;
  site_key: string | null;
}

const DEFAULT_SETTINGS: StoredCaptchaSettings = {
  enabled: false,
  provider: 'none',
  site_key: null,
};

/** Normalised vendor response. */
export interface CaptchaVerifyResult {
  success: boolean;
  /** Vendor error codes, for logging only. */
  errors: string[];
}

/**
 * Performs the HTTP call to the vendor. Injectable so tests never touch the
 * network.
 */
export type CaptchaTransport = (
  url: string,
  params: URLSearchParams,
) => Promise<CaptchaVerifyResult>;

/** Default transport: form-encoded POST via undici with a 5 second budget. */
export const undiciCaptchaTransport: CaptchaTransport = async (url, params) => {
  const response = await request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
    signal: AbortSignal.timeout(5_000),
  });
  const raw = await response.body.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const payload = (parsed ?? {}) as { success?: unknown; 'error-codes'?: unknown };
  const errors = Array.isArray(payload['error-codes'])
    ? payload['error-codes'].map((code) => String(code))
    : [];
  return { success: payload.success === true, errors };
};

/** CAPTCHA configuration and verification. */
export interface CaptchaService {
  /** Widget configuration safe to hand to the browser (never the secret). */
  getPublicConfig(): Promise<CaptchaPublicConfig>;
  /** Whether a token is required on register/login right now. */
  isEnabled(): Promise<boolean>;
  /**
   * Verify a vendor token. A no-op when CAPTCHA is disabled; otherwise throws
   * `CAPTCHA_FAILED` for a missing, rejected, or unverifiable token.
   */
  verify(token: string | undefined, remoteIp?: string | null): Promise<void>;
}

/** Dependencies of {@link createCaptchaService}. */
export interface CaptchaServiceDeps {
  store: NexusStore;
  crypto: NexusCrypto;
  /** Override the network call in tests. */
  transport?: CaptchaTransport;
  /** Optional logger for vendor error codes. */
  log?: (obj: Record<string, unknown>, message: string) => void;
}

/** Build the CAPTCHA service. */
export function createCaptchaService(deps: CaptchaServiceDeps): CaptchaService {
  const transport = deps.transport ?? undiciCaptchaTransport;

  async function readSettings(): Promise<StoredCaptchaSettings> {
    const row = await deps.store.settings.get(CAPTCHA_SETTINGS_KEY);
    if (!row || row.value === null || typeof row.value !== 'object') return DEFAULT_SETTINGS;
    const value = row.value as Partial<StoredCaptchaSettings>;
    return {
      enabled: value.enabled === true,
      provider: (value.provider ?? 'none') as CaptchaProvider,
      site_key: typeof value.site_key === 'string' ? value.site_key : null,
    };
  }

  async function readSecret(): Promise<string | null> {
    const row = await deps.store.settings.get(CAPTCHA_SECRET_SETTINGS_KEY);
    if (!row) return null;
    if (!row.encrypted) return typeof row.value === 'string' ? row.value : null;
    try {
      const decrypted = deps.crypto.decryptJson<unknown>(String(row.value));
      return typeof decrypted === 'string' ? decrypted : null;
    } catch {
      return null;
    }
  }

  function isActive(settings: StoredCaptchaSettings): boolean {
    return settings.enabled && settings.provider !== 'none';
  }

  return {
    async getPublicConfig(): Promise<CaptchaPublicConfig> {
      const settings = await readSettings();
      const active = isActive(settings);
      return {
        enabled: active,
        provider: settings.provider,
        site_key: active ? settings.site_key : null,
      };
    },

    async isEnabled(): Promise<boolean> {
      return isActive(await readSettings());
    },

    async verify(token: string | undefined, remoteIp: string | null = null): Promise<void> {
      const settings = await readSettings();
      if (!isActive(settings)) return;
      if (!token || token.trim() === '') throw captchaFailed('CAPTCHA response is required');

      const secret = await readSecret();
      if (!secret) {
        // Configured as enabled but unusable — fail closed rather than letting
        // registrations through unverified.
        throw captchaFailed('CAPTCHA is enabled but not fully configured');
      }

      const url = CAPTCHA_VERIFY_URLS[settings.provider as Exclude<CaptchaProvider, 'none'>];
      const params = new URLSearchParams({ secret, response: token });
      if (remoteIp) params.set('remoteip', remoteIp);

      let result: CaptchaVerifyResult;
      try {
        result = await transport(url, params);
      } catch (error) {
        deps.log?.(
          { provider: settings.provider, error: error instanceof Error ? error.message : null },
          'CAPTCHA provider could not be reached',
        );
        throw captchaFailed('CAPTCHA could not be verified, please try again');
      }

      if (!result.success) {
        deps.log?.({ provider: settings.provider, errors: result.errors }, 'CAPTCHA rejected');
        throw captchaFailed();
      }
    },
  };
}
