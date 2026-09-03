/**
 * Typed reader/writer for the `app_settings` groups an admin can edit.
 *
 * Four groups live here, each under its own key so a partial update never
 * rewrites an unrelated section:
 *
 * | key               | contents                                   | encrypted |
 * | ----------------- | ------------------------------------------ | --------- |
 * | `branding`        | portal name, logo data URL, colours, theme | no        |
 * | `captcha`         | enabled/provider/site key                  | no        |
 * | `captcha.secret_key` | vendor secret                           | **yes**   |
 * | `smtp`            | host/port/secure/username/from             | no        |
 * | `smtp.password`   | SMTP password                              | **yes**   |
 * | `registration`    | open registration / verification policy    | no        |
 *
 * Two invariants the rest of the server relies on:
 *
 * 1. **Secrets are write-only.** `password`/`secret_key` are never returned;
 *    the DTOs expose `password_set`/`secret_set` booleans instead.
 * 2. **Audit rows record changed keys, never values.** A settings update writes
 *    `admin.settings_update` with the list of touched keys and nothing else, so
 *    the audit log can be read by anyone allowed to read audit logs.
 */

import {
  EMAIL_TEMPLATE_KEYS,
  type AdminSettingsResponse,
  type BrandingSettings,
  type CaptchaAdminSettings,
  type CaptchaProvider,
  type EmailTemplate,
  type EmailTemplateKey,
  type RegistrationSettings,
  type Role,
  type SmtpSettings,
  type ThemePreference,
  type UpdateSettingsRequest,
} from '@ferrum-nexus/shared';

import { AuditAction, type AuditActor, type AuditService } from '../audit/service.js';
import { CAPTCHA_SECRET_SETTINGS_KEY, CAPTCHA_SETTINGS_KEY } from '../auth/captcha.js';
import { REGISTRATION_SETTINGS_KEY, type AuthService } from '../auth/service.js';
import type { NexusConfig } from '../config/index.js';
import type { NexusStore } from '../db/store.js';
import { DEFAULT_EMAIL_TEMPLATES, TEMPLATE_VARIABLES } from '../email/templates.js';
import type { NexusCrypto } from '../lib/crypto.js';
import { validationFailed } from '../lib/errors.js';
import { newId, nowIso } from '../lib/ids.js';

/** `app_settings` key holding the public branding block. */
export const BRANDING_SETTINGS_KEY = 'branding';

/** `app_settings` key holding the non-secret SMTP configuration. */
export const SMTP_SETTINGS_KEY = 'smtp';

/** `app_settings` key holding the AES-256-GCM encrypted SMTP password. */
export const SMTP_PASSWORD_SETTINGS_KEY = 'smtp.password';

/** Branding used until an admin saves something else. */
export const DEFAULT_BRANDING: BrandingSettings = {
  portal_name: 'Ferrum Nexus',
  logo_data_url: null,
  primary_color: '#4f46e5',
  accent_color: '#22d3ee',
  default_theme: 'dark',
  tagline: null,
  support_email: null,
};

/** Shape of the stored `smtp` setting; `null` means "fall back to the env config". */
export interface StoredSmtpSettings {
  host: string | null;
  port: number | null;
  secure: boolean | null;
  username: string | null;
  from_address: string | null;
}

const EMPTY_SMTP: StoredSmtpSettings = {
  host: null,
  port: null,
  secure: null,
  username: null,
  from_address: null,
};

const THEMES: readonly ThemePreference[] = ['dark', 'light', 'system'];

/* ── Raw readers (usable without constructing the service) ──────────────── */

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** Current branding with defaults applied. Safe to expose unauthenticated. */
export async function readBranding(store: NexusStore): Promise<BrandingSettings> {
  const row = await store.settings.get(BRANDING_SETTINGS_KEY);
  const value = asRecord(row?.value);
  const theme = value.default_theme;
  return {
    portal_name: str(value.portal_name) ?? DEFAULT_BRANDING.portal_name,
    logo_data_url: str(value.logo_data_url),
    primary_color: str(value.primary_color) ?? DEFAULT_BRANDING.primary_color,
    accent_color: str(value.accent_color) ?? DEFAULT_BRANDING.accent_color,
    default_theme: THEMES.includes(theme as ThemePreference)
      ? (theme as ThemePreference)
      : DEFAULT_BRANDING.default_theme,
    tagline: str(value.tagline),
    support_email: str(value.support_email),
  };
}

/** The stored SMTP overrides; every field is `null` when unset. */
export async function readStoredSmtp(store: NexusStore): Promise<StoredSmtpSettings> {
  const row = await store.settings.get(SMTP_SETTINGS_KEY);
  const value = asRecord(row?.value);
  return {
    host: str(value.host),
    port: typeof value.port === 'number' && Number.isFinite(value.port) ? value.port : null,
    secure: typeof value.secure === 'boolean' ? value.secure : null,
    username: str(value.username),
    from_address: str(value.from_address),
  };
}

/**
 * Decrypt an encrypted `app_settings` value, or `null` when absent or
 * undecryptable (which happens after `NEXUS_SECRET_KEY` is rotated).
 */
export async function readEncryptedSetting(
  store: NexusStore,
  crypto: NexusCrypto,
  key: string,
): Promise<string | null> {
  const row = await store.settings.get(key);
  if (!row) return null;
  if (!row.encrypted) return typeof row.value === 'string' ? row.value : null;
  try {
    const decrypted = crypto.decryptJson<unknown>(String(row.value));
    return typeof decrypted === 'string' && decrypted !== '' ? decrypted : null;
  } catch {
    return null;
  }
}

/* ── Service ────────────────────────────────────────────────────────────── */

/** Admin settings and email templates. */
export interface SettingsService {
  /** Everything an admin sees on the settings page (no secrets). */
  getAdminSettings(): Promise<AdminSettingsResponse>;
  /** Apply a partial update; omitted sections are left untouched. */
  updateSettings(
    actor: AuditActor,
    patch: UpdateSettingsRequest,
    ip?: string | null,
  ): Promise<AdminSettingsResponse>;
  /** Public branding block, with defaults applied. */
  getBranding(): Promise<BrandingSettings>;
  /** The stored template for a key, or the built-in default. */
  getEmailTemplate(key: EmailTemplateKey): Promise<{
    template: EmailTemplate;
    available_variables: string[];
  }>;
  /** Every template an admin has overridden, plus the full key list. */
  listEmailTemplates(): Promise<{ templates: EmailTemplate[]; keys: EmailTemplateKey[] }>;
  /** Replace the template for a key. */
  upsertEmailTemplate(
    actor: AuditActor,
    key: EmailTemplateKey,
    value: { subject: string; body_html: string; body_text: string },
    ip?: string | null,
  ): Promise<EmailTemplate>;
}

/** Dependencies of {@link createSettingsService}. */
export interface SettingsServiceDeps {
  config: NexusConfig;
  store: NexusStore;
  crypto: NexusCrypto;
  audit: AuditService;
  /** Source of truth for the registration policy defaults. */
  auth: AuthService;
}

/** Build the settings service. */
export function createSettingsService(deps: SettingsServiceDeps): SettingsService {
  const { config, store, crypto, audit, auth } = deps;

  async function readCaptcha(): Promise<CaptchaAdminSettings> {
    const row = await store.settings.get(CAPTCHA_SETTINGS_KEY);
    const value = asRecord(row?.value);
    const secret = await store.settings.get(CAPTCHA_SECRET_SETTINGS_KEY);
    return {
      enabled: value.enabled === true,
      provider: (str(value.provider) ?? 'none') as CaptchaProvider,
      site_key: str(value.site_key),
      secret_set: secret !== null,
    };
  }

  async function readSmtp(): Promise<SmtpSettings> {
    const stored = await readStoredSmtp(store);
    const password = await store.settings.get(SMTP_PASSWORD_SETTINGS_KEY);
    return {
      host: stored.host ?? config.smtp.host ?? null,
      port: stored.port ?? config.smtp.port,
      secure: stored.secure ?? config.smtp.secure,
      username: stored.username ?? config.smtp.user ?? null,
      password_set: password !== null || config.smtp.password !== undefined,
      from_address: stored.from_address ?? config.smtp.from,
    };
  }

  async function snapshot(): Promise<AdminSettingsResponse> {
    const policy = await auth.getRegistrationPolicy();
    const registration: RegistrationSettings = {
      open_registration: policy.open_registration,
      require_email_verification: policy.require_email_verification,
      allowed_roles: policy.allowed_roles,
    };
    return {
      branding: await readBranding(store),
      captcha: await readCaptcha(),
      smtp: await readSmtp(),
      registration,
    };
  }

  /** Materialise a template row for a key that has no admin override. */
  function defaultTemplateRow(key: EmailTemplateKey): EmailTemplate {
    const at = nowIso();
    const content = DEFAULT_EMAIL_TEMPLATES[key];
    return {
      // A synthetic id: the row does not exist until an admin saves it.
      id: newId(),
      key,
      subject: content.subject,
      body_html: content.body_html,
      body_text: content.body_text,
      created_at: at,
      updated_at: at,
    };
  }

  return {
    getBranding: async () => readBranding(store),

    getAdminSettings: snapshot,

    async updateSettings(actor, patch, ip = null): Promise<AdminSettingsResponse> {
      const changed: string[] = [];

      if (patch.branding) {
        const current = await readBranding(store);
        const next: BrandingSettings = { ...current };
        for (const [field, value] of Object.entries(patch.branding)) {
          if (value === undefined) continue;
          // Narrow through the known keys; unknown fields are dropped by zod.
          (next as unknown as Record<string, unknown>)[field] = value;
          changed.push(`branding.${field}`);
        }
        await store.settings.set(BRANDING_SETTINGS_KEY, next, false);
      }

      if (patch.captcha) {
        const current = await readCaptcha();
        const next = {
          enabled: patch.captcha.enabled ?? current.enabled,
          provider: patch.captcha.provider ?? current.provider,
          site_key:
            patch.captcha.site_key === undefined ? current.site_key : patch.captcha.site_key,
        };
        for (const field of ['enabled', 'provider', 'site_key'] as const) {
          if (patch.captcha[field] !== undefined) changed.push(`captcha.${field}`);
        }
        await store.settings.set(CAPTCHA_SETTINGS_KEY, next, false);

        if (patch.captcha.secret_key !== undefined) {
          changed.push('captcha.secret_key');
          if (patch.captcha.secret_key === null || patch.captcha.secret_key === '') {
            await store.settings.delete(CAPTCHA_SECRET_SETTINGS_KEY);
          } else {
            await store.settings.set(
              CAPTCHA_SECRET_SETTINGS_KEY,
              crypto.encryptJson(patch.captcha.secret_key),
              true,
            );
          }
        }
      }

      if (patch.smtp) {
        const current = await readStoredSmtp(store);
        const next: StoredSmtpSettings = {
          ...EMPTY_SMTP,
          ...current,
          ...(patch.smtp.host !== undefined ? { host: patch.smtp.host } : {}),
          ...(patch.smtp.port !== undefined ? { port: patch.smtp.port } : {}),
          ...(patch.smtp.secure !== undefined ? { secure: patch.smtp.secure } : {}),
          ...(patch.smtp.username !== undefined ? { username: patch.smtp.username } : {}),
          ...(patch.smtp.from_address !== undefined
            ? { from_address: patch.smtp.from_address }
            : {}),
        };
        const connectionChanged =
          (next.host ?? config.smtp.host ?? null) !== (current.host ?? config.smtp.host ?? null) ||
          (next.port ?? config.smtp.port) !== (current.port ?? config.smtp.port) ||
          (next.secure ?? config.smtp.secure) !== (current.secure ?? config.smtp.secure) ||
          (next.username ?? config.smtp.user ?? null) !==
            (current.username ?? config.smtp.user ?? null);
        const passwordSet =
          (await store.settings.get(SMTP_PASSWORD_SETTINGS_KEY)) !== null ||
          config.smtp.password !== undefined;
        if (connectionChanged && passwordSet && !patch.smtp.password) {
          throw validationFailed(
            'SMTP password is required when changing the SMTP connection settings',
          );
        }
        for (const field of ['host', 'port', 'secure', 'username', 'from_address'] as const) {
          if (patch.smtp[field] !== undefined) changed.push(`smtp.${field}`);
        }
        await store.settings.set(SMTP_SETTINGS_KEY, next, false);

        if (patch.smtp.password !== undefined) {
          changed.push('smtp.password');
          if (patch.smtp.password === null || patch.smtp.password === '') {
            await store.settings.delete(SMTP_PASSWORD_SETTINGS_KEY);
          } else {
            await store.settings.set(
              SMTP_PASSWORD_SETTINGS_KEY,
              crypto.encryptJson(patch.smtp.password),
              true,
            );
          }
        }
      }

      if (patch.registration) {
        const current = await auth.getRegistrationPolicy();
        const next = {
          open_registration: patch.registration.open_registration ?? current.open_registration,
          require_email_verification:
            patch.registration.require_email_verification ?? current.require_email_verification,
          allowed_roles: (patch.registration.allowed_roles ?? current.allowed_roles) as Role[],
        };
        for (const field of [
          'open_registration',
          'require_email_verification',
          'allowed_roles',
        ] as const) {
          if (patch.registration[field] !== undefined) changed.push(`registration.${field}`);
        }
        await store.settings.set(REGISTRATION_SETTINGS_KEY, next, false);
      }

      // Only the *names* of the changed keys are recorded — never the values,
      // which would put the SMTP password and CAPTCHA secret in the audit log.
      await audit.record(
        actor,
        AuditAction.ADMIN_SETTINGS_UPDATE,
        { type: 'settings', id: null },
        { changed_keys: changed },
        ip,
      );

      return snapshot();
    },

    async getEmailTemplate(key) {
      const stored = await store.emailTemplates.get(key);
      return {
        template: stored ?? defaultTemplateRow(key),
        available_variables: [...TEMPLATE_VARIABLES[key]],
      };
    },

    async listEmailTemplates() {
      return { templates: await store.emailTemplates.list(), keys: [...EMAIL_TEMPLATE_KEYS] };
    },

    async upsertEmailTemplate(actor, key, value, ip = null): Promise<EmailTemplate> {
      const template = await store.emailTemplates.upsert(key, value);
      await audit.record(
        actor,
        AuditAction.ADMIN_TEMPLATE_UPDATE,
        { type: 'email_template', id: key },
        { key },
        ip,
      );
      return template;
    },
  };
}
