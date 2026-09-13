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
 *
 * Two things sit outside that stored configuration:
 *
 * - **Enforcement** (`NEXUS_CAPTCHA_ENFORCEMENT`, {@link CaptchaServiceDeps.enforcement})
 *   is the operator's break-glass switch. CAPTCHA fails closed, so a wrong site
 *   key, a secret that no longer decrypts or an unreachable vendor refuses
 *   every password login — the enabling super admin's included — and recovery
 *   used to mean editing `app_settings` by hand (ferrum-nexus#252).
 *   `disabled` makes {@link CaptchaService.verify} a no-op and hides the widget
 *   without touching a stored setting. It comes from the environment and can
 *   never be set through the API.
 * - **The activation self-test** ({@link CaptchaService.selfTest}) is how a
 *   settings write proves the configuration it is about to store actually
 *   works, before the portal starts demanding a token on every sign-in.
 */

import { request } from 'undici';

import type {
  CaptchaEnforcement,
  CaptchaProvider,
  CaptchaPublicConfig,
} from '@ferrum-nexus/shared';

import type { NexusStore } from '../db/store.js';
import type { NexusCrypto } from '../lib/crypto.js';
import { captchaFailed, captchaSelfTestFailed } from '../lib/errors.js';

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

/**
 * What {@link CaptchaService.verify} actually did, for the caller's audit row.
 *
 * `bypassed` is the one that matters: the stored configuration demanded a
 * token and `NEXUS_CAPTCHA_ENFORCEMENT=disabled` waived it, which every
 * `auth.login` and `auth.register` row written in that state has to say.
 */
export type CaptchaVerifyOutcome = 'not_required' | 'verified' | 'bypassed';

/** The configuration a {@link CaptchaService.selfTest} proves before it is stored. */
export interface CaptchaSelfTestInput {
  /** Vendor of the configuration being saved, never `none`. */
  provider: Exclude<CaptchaProvider, 'none'>;
  /**
   * The site key being saved.
   *
   * Forwarded to hCaptcha, whose secret is account-scoped and may cover many
   * site keys, so the token is bound to *this* one rather than to any site the
   * account owns. Turnstile and reCAPTCHA pair a secret with a single site key,
   * so they are not sent it.
   */
  siteKey: string;
  /** The secret being saved — the new one when the patch carries it, else the stored one. */
  secret: string;
  /** Token minted by the widget rendered with that same configuration. */
  token: string | undefined;
  /** Forwarded to the vendor as `remoteip`, exactly as a login would. */
  remoteIp?: string | null;
}

/** CAPTCHA configuration and verification. */
export interface CaptchaService {
  /** Widget configuration safe to hand to the browser (never the secret). */
  getPublicConfig(): Promise<CaptchaPublicConfig>;
  /** Whether a token is required on register/login right now. */
  isEnabled(): Promise<boolean>;
  /** Whether the stored configuration applies at all (`NEXUS_CAPTCHA_ENFORCEMENT`). */
  getEnforcement(): CaptchaEnforcement;
  /**
   * Verify a vendor token. A no-op when CAPTCHA is disabled or enforcement is
   * off; otherwise throws `CAPTCHA_FAILED` for a missing, rejected, or
   * unverifiable token. The outcome says which of those happened.
   */
  verify(token: string | undefined, remoteIp?: string | null): Promise<CaptchaVerifyOutcome>;
  /**
   * Prove a CAPTCHA configuration before an admin's settings write adopts it.
   *
   * Runs the **same** vendor verification a login does, against the
   * configuration in the patch rather than the stored one — for hCaptcha the
   * site key travels with it, so an account-scoped secret cannot bless a token
   * minted for some other site of the same account — and throws
   * `CAPTCHA_SELF_TEST_FAILED` when there is no token, the vendor rejects it,
   * or the vendor cannot be reached. Unlike {@link CaptchaService.verify} it
   * ignores enforcement: a portal recovering under the break-glass switch must
   * still be able to prove a fixed configuration before turning the switch off.
   */
  selfTest(input: CaptchaSelfTestInput): Promise<void>;
}

/** Dependencies of {@link createCaptchaService}. */
export interface CaptchaServiceDeps {
  store: NexusStore;
  crypto: NexusCrypto;
  /**
   * `NEXUS_CAPTCHA_ENFORCEMENT`; defaults to `enforced`.
   *
   * Never read from the store, and never writable through the API — see the
   * module header for why the operator's break-glass switch lives outside the
   * configuration it disables.
   */
  enforcement?: CaptchaEnforcement;
  /** Override the network call in tests. */
  transport?: CaptchaTransport;
  /** Optional logger for vendor error codes. */
  log?: (obj: Record<string, unknown>, message: string) => void;
}

/**
 * Shortest gap between two "CAPTCHA enforcement is off" warnings.
 *
 * Login and register are unauthenticated, so one line per bypassed request
 * would let anonymous traffic set the log rate. The startup banner is the loud
 * signal; this is the periodic reminder that the portal is still running that
 * way, and the `captcha_bypassed` audit detail is the per-request record.
 */
const BYPASS_LOG_INTERVAL_MS = 60_000;

/** Build the CAPTCHA service. */
export function createCaptchaService(deps: CaptchaServiceDeps): CaptchaService {
  const transport = deps.transport ?? undiciCaptchaTransport;
  const enforcement: CaptchaEnforcement = deps.enforcement ?? 'enforced';
  let lastBypassLogAt = 0;

  async function readSettings(): Promise<StoredCaptchaSettings> {
    const row = await deps.store.settings.get(CAPTCHA_SETTINGS_KEY);
    if (!row || row.value === null || typeof row.value !== 'object') return DEFAULT_SETTINGS;
    const value = row.value as Partial<StoredCaptchaSettings>;
    return {
      enabled: value.enabled === true,
      provider: (value.provider ?? 'none') as CaptchaProvider,
      site_key:
        typeof value.site_key === 'string' && value.site_key.trim() ? value.site_key.trim() : null,
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

  function isConfigured(settings: StoredCaptchaSettings): boolean {
    return settings.enabled && settings.provider !== 'none';
  }

  async function isActive(settings: StoredCaptchaSettings): Promise<boolean> {
    return (
      enforcement === 'enforced' &&
      isConfigured(settings) &&
      settings.site_key !== null &&
      (await deps.store.settings.get(CAPTCHA_SECRET_SETTINGS_KEY)) !== null
    );
  }

  /**
   * Run the vendor call both {@link CaptchaService.verify} and the self-test share.
   *
   * `sitekey` is hCaptcha-only, and deliberately so. Turnstile and reCAPTCHA
   * issue a secret per site, so verifying the token already proves which site
   * key minted it; hCaptcha's secret is account-scoped and may cover many site
   * keys, and its `siteverify` takes the optional `sitekey` parameter precisely
   * to bind the two. Sending it to the other two vendors would be an unknown
   * field on a closed form.
   */
  async function askVendor(
    provider: Exclude<CaptchaProvider, 'none'>,
    secret: string,
    token: string,
    remoteIp: string | null,
    siteKey: string | null = null,
  ): Promise<CaptchaVerifyResult> {
    const params = new URLSearchParams({ secret, response: token });
    if (remoteIp) params.set('remoteip', remoteIp);
    if (provider === 'hcaptcha' && siteKey) params.set('sitekey', siteKey);
    return transport(CAPTCHA_VERIFY_URLS[provider], params);
  }

  return {
    async getPublicConfig(): Promise<CaptchaPublicConfig> {
      const settings = await readSettings();
      const active = await isActive(settings);
      return {
        enabled: active,
        provider: settings.provider,
        site_key: active ? settings.site_key : null,
      };
    },

    async isEnabled(): Promise<boolean> {
      return isActive(await readSettings());
    },

    getEnforcement: () => enforcement,

    async verify(
      token: string | undefined,
      remoteIp: string | null = null,
    ): Promise<CaptchaVerifyOutcome> {
      const settings = await readSettings();
      if (!isConfigured(settings)) return 'not_required';

      // The break-glass branch, before anything can fail closed: the stored
      // configuration is exactly what an operator cannot fix while it is
      // locking them out, so nothing here reads it further.
      if (enforcement === 'disabled') {
        const now = Date.now();
        if (now - lastBypassLogAt >= BYPASS_LOG_INTERVAL_MS) {
          lastBypassLogAt = now;
          deps.log?.(
            { provider: settings.provider },
            'NEXUS_CAPTCHA_ENFORCEMENT=disabled: the stored CAPTCHA configuration is not ' +
              'being applied to register or login; unset it once the configuration is fixed',
          );
        }
        return 'bypassed';
      }

      const secret = await readSecret();
      if (!settings.site_key || !secret?.trim()) {
        // Configured as enabled but unusable — fail closed rather than letting
        // registrations through unverified.
        throw captchaFailed('CAPTCHA is enabled but not fully configured');
      }
      if (!token || token.trim() === '') throw captchaFailed('CAPTCHA response is required');

      const provider = settings.provider as Exclude<CaptchaProvider, 'none'>;
      let result: CaptchaVerifyResult;
      try {
        // No `sitekey` here: this token came from the widget the portal itself
        // rendered from `settings.site_key`, and the write path already proved
        // that pair against the vendor. Binding it again could only turn a
        // proven configuration into a login failure — the lockout this whole
        // module exists to prevent.
        result = await askVendor(provider, secret, token, remoteIp);
      } catch (error) {
        deps.log?.(
          { provider, error: error instanceof Error ? error.message : null },
          'CAPTCHA provider could not be reached',
        );
        throw captchaFailed('CAPTCHA could not be verified, please try again');
      }

      if (!result.success) {
        deps.log?.({ provider, errors: result.errors }, 'CAPTCHA rejected');
        throw captchaFailed();
      }
      return 'verified';
    },

    async selfTest(input: CaptchaSelfTestInput): Promise<void> {
      const token = input.token;
      if (!token || token.trim() === '') {
        throw captchaSelfTestFailed(
          'token_required',
          'Turning CAPTCHA on, or changing its provider, site key or secret key, requires a ' +
            'captcha_token minted by the configuration being saved, so the portal cannot start ' +
            'demanding a challenge it is unable to verify',
        );
      }

      let result: CaptchaVerifyResult;
      try {
        result = await askVendor(
          input.provider,
          input.secret,
          token,
          input.remoteIp ?? null,
          input.siteKey,
        );
      } catch (error) {
        deps.log?.(
          { provider: input.provider, error: error instanceof Error ? error.message : null },
          'CAPTCHA provider could not be reached during an activation self-test',
        );
        throw captchaSelfTestFailed(
          'provider_unreachable',
          'The CAPTCHA provider could not be reached to verify the configuration, so it was ' +
            'not saved. Check outbound network access from the portal and try again',
        );
      }

      if (!result.success) {
        deps.log?.(
          { provider: input.provider, errors: result.errors },
          'CAPTCHA activation self-test rejected',
        );
        throw captchaSelfTestFailed(
          'rejected',
          'The CAPTCHA provider rejected the challenge solved for this configuration, so it ' +
            'was not saved. Check the site key and secret key belong to the same site',
        );
      }
    },
  };
}
