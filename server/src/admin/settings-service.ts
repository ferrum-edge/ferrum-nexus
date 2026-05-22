/**
 * Admin-managed runtime settings: branding, CAPTCHA, sender, registration mode.
 *
 * Sensitive values (SMTP password, CAPTCHA secret) are encrypted with the
 * server's secret key before storage and decrypted on read.
 */

import { z } from 'zod';
import type { NexusStore } from '../db/store.js';
import type { ResolvedConfig } from '../config/index.js';
import { decryptSetting, encryptSetting } from '../lib/crypto.js';
import type { AppPublicSettings, BrandingSettings, CaptchaSettings } from '@ferrum-nexus/shared';

const KEYS = {
  branding: 'branding',
  captcha: 'captcha',
  registrationEnabled: 'registrationEnabled',
  emailVerificationRequired: 'emailVerificationRequired',
  registrationAllowedEmailDomains: 'registrationAllowedEmailDomains',
  registrationRequiresAdminApproval: 'registrationRequiresAdminApproval',
  emailFrom: 'emailFrom',
  smtpHost: 'smtpHost',
  smtpPort: 'smtpPort',
  smtpUsername: 'smtpUsername',
  smtpPasswordEnc: 'smtpPasswordEnc',
  smtpSecure: 'smtpSecure',
  captchaSecretEnc: 'captchaSecretEnc',
} as const;

export const BrandingInput = z.object({
  productName: z.string().min(1).max(64),
  logoUrl: z.string().url().nullable(),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  defaultTheme: z.enum(['system', 'light', 'dark']),
  supportEmail: z.string().email().nullable(),
  footerNotice: z.string().max(500).nullable(),
});

export const CaptchaInput = z.object({
  enabled: z.boolean(),
  provider: z.enum(['turnstile', 'recaptcha', 'hcaptcha']).nullable(),
  siteKey: z.string().nullable(),
  secret: z.string().optional(),
});

export const SenderInput = z.object({
  from: z.string().min(3),
  smtpHost: z.string().nullable(),
  smtpPort: z.number().int().positive().nullable(),
  smtpUsername: z.string().nullable(),
  smtpPassword: z.string().optional(),
  smtpSecure: z.boolean(),
});

export const RegistrationInput = z.object({
  registrationEnabled: z.boolean(),
  emailVerificationRequired: z.boolean(),
  registrationAllowedEmailDomains: z.array(z.string().min(1)).default([]),
  registrationRequiresAdminApproval: z.boolean().default(false),
});

const DEFAULT_BRANDING: BrandingSettings = {
  productName: 'Ferrum Nexus',
  logoUrl: null,
  primaryColor: '#0f172a',
  defaultTheme: 'system',
  supportEmail: null,
  footerNotice: 'Powered by Ferrum Nexus.',
};

const DEFAULT_CAPTCHA: CaptchaSettings = {
  enabled: false,
  provider: null,
  siteKey: null,
};

export interface SettingsService {
  public(): Promise<AppPublicSettings>;
  full(): Promise<{
    branding: BrandingSettings;
    captcha: CaptchaSettings;
    registrationEnabled: boolean;
    emailVerificationRequired: boolean;
    registrationAllowedEmailDomains: string[];
    registrationRequiresAdminApproval: boolean;
    sender: {
      from: string;
      smtpHost: string | null;
      smtpPort: number | null;
      smtpUsername: string | null;
      smtpSecure: boolean;
      smtpPasswordConfigured: boolean;
    };
    captchaSecretConfigured: boolean;
  }>;
  setBranding(input: z.infer<typeof BrandingInput>): Promise<BrandingSettings>;
  setCaptcha(input: z.infer<typeof CaptchaInput>): Promise<CaptchaSettings>;
  setSender(input: z.infer<typeof SenderInput>): Promise<void>;
  setRegistration(input: z.infer<typeof RegistrationInput>): Promise<void>;
  captchaSecret(): Promise<string | null>;
}

export function createSettingsService(
  config: ResolvedConfig,
  store: NexusStore,
): SettingsService {
  const getBranding = async (): Promise<BrandingSettings> =>
    (await store.settings.get<BrandingSettings>(KEYS.branding)) ?? DEFAULT_BRANDING;

  const getCaptcha = async (): Promise<CaptchaSettings> =>
    (await store.settings.get<CaptchaSettings>(KEYS.captcha)) ?? DEFAULT_CAPTCHA;

  const getRegFlags = async () => ({
    registrationEnabled:
      ((await store.settings.get<boolean>(KEYS.registrationEnabled)) ?? true) === true,
    emailVerificationRequired:
      ((await store.settings.get<boolean>(KEYS.emailVerificationRequired)) ?? true) === true,
    registrationAllowedEmailDomains:
      (await store.settings.get<string[]>(KEYS.registrationAllowedEmailDomains)) ?? [],
    registrationRequiresAdminApproval:
      ((await store.settings.get<boolean>(KEYS.registrationRequiresAdminApproval)) ?? false) === true,
  });

  return {
    async public() {
      const branding = await getBranding();
      const captcha = await getCaptcha();
      const flags = await getRegFlags();
      // captcha settings stored under KEYS.captcha never include the secret —
      // it lives encrypted under KEYS.captchaSecretEnc — so there is nothing
      // to strip here. Returning the stored shape directly.
      return { branding, captcha, ...flags };
    },
    async full() {
      const branding = await getBranding();
      const captcha = await getCaptcha();
      const flags = await getRegFlags();
      return {
        branding,
        captcha,
        ...flags,
        sender: {
          from: (await store.settings.get<string>(KEYS.emailFrom)) ?? config.email.from,
          smtpHost: (await store.settings.get<string>(KEYS.smtpHost)) ?? config.email.smtpHost ?? null,
          smtpPort: (await store.settings.get<number>(KEYS.smtpPort)) ?? config.email.smtpPort,
          smtpUsername:
            (await store.settings.get<string>(KEYS.smtpUsername)) ??
            config.email.smtpUsername ??
            null,
          smtpSecure:
            ((await store.settings.get<boolean>(KEYS.smtpSecure)) ?? config.email.smtpSecure) === true,
          smtpPasswordConfigured: !!(await store.settings.get<string>(KEYS.smtpPasswordEnc)),
        },
        captchaSecretConfigured: !!(await store.settings.get<string>(KEYS.captchaSecretEnc)),
      };
    },
    async setBranding(input) {
      const next: BrandingSettings = { ...DEFAULT_BRANDING, ...input };
      await store.settings.set(KEYS.branding, next);
      return next;
    },
    async setCaptcha(input) {
      const next: CaptchaSettings = {
        enabled: input.enabled,
        provider: input.provider,
        siteKey: input.siteKey,
      };
      await store.settings.set(KEYS.captcha, next);
      if (typeof input.secret === 'string' && input.secret.length > 0) {
        await store.settings.set(
          KEYS.captchaSecretEnc,
          encryptSetting(input.secret, config.secretKey),
          true,
        );
      }
      return next;
    },
    async setSender(input) {
      await store.settings.set(KEYS.emailFrom, input.from);
      await store.settings.set(KEYS.smtpHost, input.smtpHost);
      await store.settings.set(KEYS.smtpPort, input.smtpPort);
      await store.settings.set(KEYS.smtpUsername, input.smtpUsername);
      await store.settings.set(KEYS.smtpSecure, input.smtpSecure);
      if (typeof input.smtpPassword === 'string' && input.smtpPassword.length > 0) {
        await store.settings.set(
          KEYS.smtpPasswordEnc,
          encryptSetting(input.smtpPassword, config.secretKey),
          true,
        );
      }
    },
    async setRegistration(input) {
      await store.settings.set(KEYS.registrationEnabled, input.registrationEnabled);
      await store.settings.set(KEYS.emailVerificationRequired, input.emailVerificationRequired);
      await store.settings.set(
        KEYS.registrationAllowedEmailDomains,
        normalizeDomains(input.registrationAllowedEmailDomains),
      );
      await store.settings.set(
        KEYS.registrationRequiresAdminApproval,
        input.registrationRequiresAdminApproval,
      );
    },
    async captchaSecret() {
      const enc = await store.settings.get<string>(KEYS.captchaSecretEnc);
      return enc ? decryptSetting(enc, config.secretKey) : null;
    },
  };
}

function normalizeDomains(domains: string[]): string[] {
  return Array.from(
    new Set(
      domains
        .map((domain) => domain.trim().toLowerCase().replace(/^@/, ''))
        .filter(Boolean),
    ),
  ).sort();
}
