/**
 * CAPTCHA verification for registration. The provider, site key, and secret
 * are configured through the admin settings UI. If CAPTCHA is disabled this is
 * a no-op.
 *
 * Supported providers: Cloudflare Turnstile, Google reCAPTCHA, hCaptcha. They
 * share a similar form-encoded POST verify shape.
 */

import { badRequest } from '../lib/errors.js';
import type { SettingsService } from '../admin/settings-service.js';

const VERIFY_URLS: Record<string, string> = {
  turnstile: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
  recaptcha: 'https://www.google.com/recaptcha/api/siteverify',
  hcaptcha: 'https://hcaptcha.com/siteverify',
};

export async function verifyCaptchaIfEnabled(
  settings: SettingsService,
  token: string | undefined,
  ip: string | null,
): Promise<void> {
  const cfg = (await settings.full()).captcha;
  if (!cfg.enabled) return;
  if (!token) throw badRequest('captcha_required', 'CAPTCHA token missing');
  const secret = await settings.captchaSecret();
  if (!cfg.provider || !secret) {
    throw badRequest('captcha_misconfigured', 'CAPTCHA is enabled but not configured');
  }
  const url = VERIFY_URLS[cfg.provider];
  if (!url) throw badRequest('captcha_misconfigured', 'Unknown CAPTCHA provider');
  const params = new URLSearchParams({ secret, response: token });
  if (ip) params.set('remoteip', ip);
  const res = await fetch(url, {
    method: 'POST',
    body: params,
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {
    throw badRequest('captcha_failed', 'CAPTCHA verification service is unreachable');
  });
  if (!res.ok) throw badRequest('captcha_failed', `CAPTCHA verify HTTP ${res.status}`);
  const data = (await res.json()) as { success?: boolean };
  if (!data.success) throw badRequest('captcha_failed', 'CAPTCHA verification failed');
}
