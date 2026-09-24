/**
 * Typed reader/writer for the `app_settings` groups an admin can edit.
 *
 * Each group lives under its own key so a partial update never rewrites an
 * unrelated section:
 *
 * | key               | contents                                   | encrypted |
 * | ----------------- | ------------------------------------------ | --------- |
 * | `branding`        | portal name, logo data URL, colours, theme | no        |
 * | `gateway`         | public origin of the proxy listener        | no        |
 * | `captcha`         | enabled/provider/site key                  | no        |
 * | `captcha.secret_key` | vendor secret                           | **yes**   |
 * | `smtp`            | host/port/secure/username/from             | no        |
 * | `smtp.password`   | SMTP password                              | **yes**   |
 * | `registration`    | open registration / verification policy    | no        |
 *
 * Four invariants the rest of the server relies on:
 *
 * 1. **Secrets are write-only.** `password`/`secret_key` are never returned;
 *    the DTOs expose `password_set`/`secret_set` booleans instead.
 * 2. **Audit rows record changed keys, never values.** A settings update writes
 *    `admin.settings_update` with touched keys and password-source transitions, so
 *    the audit log can be read by anyone allowed to read audit logs.
 * 3. **`smtp`, `captcha`, and `gateway` are `super_admin`-only** (see
 *    {@link PRIVILEGED_SETTINGS_SECTIONS}); `branding` and `registration` are
 *    editable by any `admin`.
 * 4. **A CAPTCHA activation proves itself before it is stored.** Turning
 *    CAPTCHA on — or moving its provider, site key or secret while it is on —
 *    makes register *and login* demand a token from every account, the
 *    enabling super admin included, so the patch has to carry a
 *    `captcha_token` the new configuration accepts or nothing is written
 *    (ferrum-nexus#252). The vendor call happens **before** the transaction
 *    opens, because a transaction body here must be re-runnable; the write is
 *    therefore a compare-and-swap against the rows that proof was made on, and
 *    a concurrent CAPTCHA edit gets `409 CONFLICT` rather than a lost update.
 */

import { createHash } from 'node:crypto';

import {
  BRANDING_FONT_PRESETS,
  BRANDING_LOGIN_LAYOUTS,
  BRANDING_RADII,
  BRANDING_SIDEBAR_STYLES,
  EMAIL_TEMPLATE_KEYS,
  MAX_BRANDING_FOOTER_LINKS,
  roleAtLeast,
  type AdminSettingsResponse,
  type BrandingLink,
  type BrandingSettings,
  type CaptchaAdminSettings,
  type CaptchaProvider,
  type EmailTemplate,
  type EmailTemplateKey,
  type GatewaySettings,
  type RegistrationSettings,
  type Role,
  type SmtpSettings,
  type ThemePreference,
  type UpdateSettingsRequest,
} from '@ferrum-nexus/shared';

import { AuditAction, type AuditActor, type AuditService } from '../audit/service.js';
import {
  CAPTCHA_SECRET_SETTINGS_KEY,
  CAPTCHA_SETTINGS_KEY,
  type CaptchaService,
  type StoredCaptchaSettings,
} from '../auth/captcha.js';
import {
  REGISTRATION_SETTINGS_KEY,
  readRegistrationPolicy,
  type AuthService,
} from '../auth/service.js';
import type { NexusConfig } from '../config/index.js';
import type { NexusStore } from '../db/store.js';
import { validateTemplateLinks } from '../email/template-links.js';
import {
  DEFAULT_EMAIL_TEMPLATES,
  removedTemplateVariable,
  TEMPLATE_VARIABLES,
} from '../email/templates.js';
import type { NexusCrypto } from '../lib/crypto.js';
import { conflict, forbidden, validationFailed } from '../lib/errors.js';
import { GATEWAY_PUBLIC_URL_RULE, normalizeGatewayPublicUrl } from '../lib/gateway-url.js';
import { newId, nowIso } from '../lib/ids.js';

/**
 * Sections of {@link UpdateSettingsRequest} that only a `super_admin` may touch.
 *
 * These are escalation paths rather than presentation: whoever owns `smtp` owns
 * every verification and password-reset link the portal sends, and whoever owns
 * `captcha` owns the registration brake. Whoever controls `gateway` can direct
 * clients to send their gateway credentials to another origin. `branding` and
 * `registration` stay at `admin`.
 */
export const PRIVILEGED_SETTINGS_SECTIONS = ['smtp', 'captcha', 'gateway'] as const;

/** `app_settings` key holding the public branding block. */
export const BRANDING_SETTINGS_KEY = 'branding';

/** `app_settings` key holding the gateway's public proxy-listener origin. */
export const GATEWAY_SETTINGS_KEY = 'gateway';

/**
 * How long {@link SettingsService.getGatewayPublicUrl} may serve a cached
 * answer.
 *
 * Every catalog row needs the origin, so an uncached read would be one store
 * round-trip per API on every list. The window is short, and a write through
 * this service drops the entry immediately, so the only staleness possible is
 * from another process editing the row.
 */
const GATEWAY_URL_CACHE_MS = 5_000;

/** `app_settings` key holding the non-secret SMTP configuration. */
export const SMTP_SETTINGS_KEY = 'smtp';

/** `app_settings` key holding the AES-256-GCM encrypted SMTP password. */
export const SMTP_PASSWORD_SETTINGS_KEY = 'smtp.password';

/** Branding used until an admin saves something else. */
export const DEFAULT_BRANDING: BrandingSettings = {
  portal_name: 'Ferrum Nexus',
  logo_data_url: null,
  // Ferrum = iron: the ember accent the SPA's stylesheet is designed around.
  primary_color: '#f97316',
  accent_color: '#38bdf8',
  default_theme: 'dark',
  tagline: null,
  support_email: null,
  radius: 'md',
  font_preset: 'system',
  sidebar_style: 'surface',
  login_layout: 'split',
  footer_text: null,
  footer_links: [],
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

/**
 * A `captcha` section resolved against what is stored, decided before the
 * transaction opens.
 *
 * Everything slow or refusable lives here — the completeness rule and the
 * vendor round-trip of the activation self-test — so the transaction body is
 * pure writes and can be re-run by a pooled adapter without repeating either.
 */
interface CaptchaUpdatePlan {
  /** The `captcha` row exactly as it will be written. */
  next: StoredCaptchaSettings;
  /**
   * {@link captchaFingerprint} of the rows `next` was merged over.
   *
   * Re-checked under the transaction: the merge and the self-test both used a
   * snapshot taken before the body opened, so the write is a compare-and-swap
   * against it rather than a blind overwrite.
   */
  fingerprint: string;
  /** True when a self-test actually ran, for the audit row. */
  selfTested: boolean;
}

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
    radius: oneOf(value.radius, BRANDING_RADII, DEFAULT_BRANDING.radius),
    font_preset: oneOf(value.font_preset, BRANDING_FONT_PRESETS, DEFAULT_BRANDING.font_preset),
    sidebar_style: oneOf(
      value.sidebar_style,
      BRANDING_SIDEBAR_STYLES,
      DEFAULT_BRANDING.sidebar_style,
    ),
    login_layout: oneOf(value.login_layout, BRANDING_LOGIN_LAYOUTS, DEFAULT_BRANDING.login_layout),
    footer_text: str(value.footer_text),
    footer_links: readFooterLinks(value.footer_links),
  };
}

/** `value` when it is one of `allowed`, else `fallback`. */
function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/**
 * Footer links as stored, re-validated on the way out: only well-formed
 * `{ label, url }` pairs with an `http(s)` URL survive, capped at the same
 * count the route accepts, so a hand-edited row can never put a `javascript:`
 * link on the sign-in page.
 */
function readFooterLinks(value: unknown): BrandingLink[] {
  if (!Array.isArray(value)) return [];
  const links: BrandingLink[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    const label = str(record.label);
    const url = str(record.url);
    if (label === null || url === null || !/^https?:\/\//i.test(url)) continue;
    links.push({ label, url });
    if (links.length >= MAX_BRANDING_FOOTER_LINKS) break;
  }
  return links;
}

/**
 * The stored gateway origin, or `null` when an admin has never set one.
 *
 * Already-normalised on the way in, but re-normalised here so a value written
 * by an older build (or by hand) cannot produce a malformed `invoke_url`.
 */
export async function readStoredGatewayPublicUrl(store: NexusStore): Promise<string | null> {
  const row = await store.settings.get(GATEWAY_SETTINGS_KEY);
  const stored = str(asRecord(row?.value).public_url);
  return stored === null ? null : normalizeGatewayPublicUrl(stored);
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

/**
 * Fingerprint of the two rows a {@link CaptchaUpdatePlan} is resolved against.
 *
 * The plan merges the patch over a snapshot read — and proven with the vendor —
 * before the transaction opens, so the write has to establish that the snapshot
 * is still current. Both rows count: the self-test blessed one
 * `{provider, site_key, secret}` triple, and either half moving underneath
 * would store a combination nothing has ever proven.
 *
 * `updated_at` alone would be too coarse (two writes can land in the same
 * millisecond), so the stored value goes in as well — the secret only ever as
 * the opaque ciphertext the store holds, never decrypted, and only ever as a
 * SHA-256 digest of it.
 */
async function captchaFingerprint(reader: NexusStore): Promise<string> {
  const hash = createHash('sha256');
  // Sequentially, not `Promise.all`: a transaction-scoped store is one
  // connection, and the pooled adapters expect one statement at a time on it.
  for (const key of [CAPTCHA_SETTINGS_KEY, CAPTCHA_SECRET_SETTINGS_KEY]) {
    const row = await reader.settings.get(key);
    // The separators keep the fields and the rows apart, so no pair of stored
    // values can collide with a different pair by running together.
    const part =
      row === null ? 'absent' : `${row.updated_at}\u0000${JSON.stringify(row.value ?? null)}`;
    hash.update(`${part}\u0001`);
  }
  return hash.digest('hex');
}

/* ── Service ────────────────────────────────────────────────────────────── */

/** Admin settings and email templates. */
export interface SettingsService {
  /** Revision of committed in-process writes affecting public branding. */
  getBrandingRevision(): number;
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
  /**
   * Public origin of the gateway's proxy listener: the stored
   * `gateway.public_url` when set, else `FERRUM_GATEWAY_PUBLIC_URL`, else
   * `null`. Cached for a few seconds — a catalog page asks once per row.
   */
  getGatewayPublicUrl(): Promise<string | null>;
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
  /**
   * Runs the activation self-test, and reports whether enforcement is on.
   *
   * The same service the login path uses, so "the configuration this patch
   * describes works" is decided by exactly the code that will demand a token
   * from every visitor a moment later.
   */
  captcha: CaptchaService;
}

/** Build the settings service. */
export function createSettingsService(deps: SettingsServiceDeps): SettingsService {
  const { config, store, crypto, audit, auth, captcha } = deps;
  let brandingRevision = 0;

  /** Memoised gateway origin; dropped the moment a write changes it. */
  let gatewayUrlCache: { value: string | null; expires: number } | null = null;

  async function resolveGatewayPublicUrl(): Promise<string | null> {
    return (await readStoredGatewayPublicUrl(store)) ?? config.edge.gatewayPublicUrl ?? null;
  }

  async function getGatewayPublicUrl(): Promise<string | null> {
    const now = Date.now();
    if (gatewayUrlCache !== null && gatewayUrlCache.expires > now) return gatewayUrlCache.value;
    const value = await resolveGatewayPublicUrl();
    gatewayUrlCache = { value, expires: now + GATEWAY_URL_CACHE_MS };
    return value;
  }

  async function readGateway(): Promise<GatewaySettings> {
    return { public_url: await getGatewayPublicUrl() };
  }

  async function readCaptcha(): Promise<CaptchaAdminSettings> {
    const row = await store.settings.get(CAPTCHA_SETTINGS_KEY);
    const value = asRecord(row?.value);
    const secret = await store.settings.get(CAPTCHA_SECRET_SETTINGS_KEY);
    return {
      enabled: value.enabled === true,
      provider: (str(value.provider) ?? 'none') as CaptchaProvider,
      site_key: str(value.site_key),
      secret_set: secret !== null,
      // Environment, not storage: an administrator reading a block that says
      // `enabled: true` has to be able to see that the server is not acting on
      // it, rather than concluding the portal ignores its own settings.
      enforcement: captcha.getEnforcement(),
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

  /**
   * Resolve a `captcha` patch against what is stored, and make it prove itself.
   *
   * Two refusals live here, both before a single row is written:
   *
   * 1. **Completeness** — an enabled configuration needs a real provider, a
   *    site key and a usable secret (`400 VALIDATION_FAILED`). Moving
   *    `provider` while CAPTCHA is (or becomes) on additionally requires a
   *    `secret_key` in the same patch: a stored secret belongs to the vendor
   *    that issued it, and replaying it against another vendor's `siteverify`
   *    would disclose a write-only credential to a third party the operator
   *    never chose. `smtp` applies the same rule to a connection change.
   * 2. **The activation self-test** — turning CAPTCHA on, or moving its
   *    provider, site key or secret while it is on, makes every password login
   *    demand a token, so the patch has to carry one the *new* configuration
   *    accepts (`400 CAPTCHA_SELF_TEST_FAILED`). Enforcement being disabled
   *    does not waive it: the admin page renders the widget from the pending
   *    configuration, so a token can be minted even while the break-glass
   *    switch is holding the portal open, and an operator recovering from a
   *    bad configuration is precisely who must not store another one.
   *
   * A patch that only turns CAPTCHA **off** — or that leaves an already-proven
   * configuration alone — needs no token, so a lockout is always one
   * `{"captcha":{"enabled":false}}` away for whoever can still authenticate.
   *
   * Read outside the transaction, against `store`: the vendor call cannot sit
   * in a body a pooled adapter may re-run. What that would otherwise leave open
   * — a second super admin editing CAPTCHA between this snapshot and the commit
   * — is closed by {@link CaptchaUpdatePlan.fingerprint}, which the transaction
   * body re-checks before it writes.
   */
  async function planCaptchaUpdate(
    patch: NonNullable<UpdateSettingsRequest['captcha']>,
    ip: string | null,
  ): Promise<CaptchaUpdatePlan> {
    // Fingerprinted *before* the rows are read for the merge, never after: a
    // write landing between the two then makes the fingerprint stale and the
    // patch fails closed with `CONFLICT`. The other order would let a merge
    // built on rows newer than the fingerprint commit as if it were current.
    const fingerprint = await captchaFingerprint(store);
    const current = await readCaptcha();
    const next: StoredCaptchaSettings = {
      enabled: patch.enabled ?? current.enabled,
      provider: patch.provider ?? current.provider,
      site_key: patch.site_key === undefined ? current.site_key : patch.site_key,
    };
    if (!next.enabled) return { next, fingerprint, selfTested: false };

    const provider = next.provider;
    const siteKey = next.site_key?.trim() ?? '';
    const storedSecret =
      patch.secret_key === undefined
        ? await readEncryptedSetting(store, crypto, CAPTCHA_SECRET_SETTINGS_KEY)
        : patch.secret_key;
    // An unreadable encrypted row and a cleared one both read as absent here,
    // which is the same "unusable" the `verify` path fails closed on.
    const secret = storedSecret ?? '';
    if (provider === 'none' || siteKey === '' || secret.trim() === '') {
      throw validationFailed(
        'Enabling CAPTCHA requires a provider, a site key, and a usable secret key',
      );
    }

    // Refused before the self-test, which is the call that would have posted
    // the stored secret to the new vendor's `siteverify`. A secret is issued by
    // one vendor and is useless — and disclosed — at another.
    if (provider !== current.provider && patch.secret_key === undefined) {
      throw validationFailed(
        'Changing the CAPTCHA provider requires sending captcha.secret_key in the same request, ' +
          'because the stored secret belongs to the previous provider',
      );
    }

    // Any of these makes the challenge visitors are about to face a different
    // one from the challenge that was last proven to work.
    const selfTestRequired =
      !current.enabled ||
      provider !== current.provider ||
      siteKey !== (current.site_key?.trim() ?? '') ||
      patch.secret_key !== undefined;
    if (!selfTestRequired) return { next, fingerprint, selfTested: false };

    await captcha.selfTest({
      provider,
      siteKey,
      secret,
      token: patch.captcha_token,
      remoteIp: ip,
    });
    return { next, fingerprint, selfTested: true };
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
      gateway: await readGateway(),
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
    getBrandingRevision: () => brandingRevision + auth.getBrandingRevision(),

    getBranding: async () => readBranding(store),

    getGatewayPublicUrl,

    getAdminSettings: snapshot,

    async updateSettings(actor, patch, ip = null): Promise<AdminSettingsResponse> {
      // Mail, CAPTCHA, and the client-facing gateway origin are
      // privilege-escalation surfaces, not preferences:
      // repointing SMTP hands the operator every verification and
      // password-reset message, and turning CAPTCHA off (or swapping its
      // secret) removes the registration brake. `/api/admin` only requires
      // `admin`, so the extra step is enforced here.
      for (const section of PRIVILEGED_SETTINGS_SECTIONS) {
        if (patch[section] !== undefined && !roleAtLeast(actor.role ?? 'client', 'super_admin')) {
          throw forbidden(`Only a super admin can change the ${section} settings`);
        }
      }

      // Validated before the first write, like the privilege check above, so a
      // malformed gateway URL does not leave a half-applied patch behind.
      // `undefined` means "not in this patch"; `null` means "clear it".
      let nextGatewayUrl: string | null | undefined;
      if (patch.gateway && patch.gateway.public_url !== undefined) {
        const raw = patch.gateway.public_url;
        if (raw === null || raw.trim() === '') {
          nextGatewayUrl = null;
        } else {
          nextGatewayUrl = normalizeGatewayPublicUrl(raw);
          if (nextGatewayUrl === null) {
            throw validationFailed(`gateway.public_url ${GATEWAY_PUBLIC_URL_RULE}`);
          }
        }
      }

      // Resolved, validated and — when the change would move the challenge —
      // proven against the vendor here, for the same reason the gateway URL is:
      // a refusal must not leave a half-applied patch behind, and a transaction
      // body that a pooled adapter may re-run must never make a network call.
      const captchaPlan =
        patch.captcha === undefined ? undefined : await planCaptchaUpdate(patch.captcha, ip);

      // Every settings row and its audit record share one transaction-scoped
      // store. In particular, secret writes cannot split from their config.
      await store.transaction(async (tx) => {
        const changed: string[] = [];
        let smtpPasswordSourceChange:
          { from: 'override' | 'environment'; to: 'override' | 'environment' } | undefined;

        if (patch.branding) {
          const current = await readBranding(tx);
          const next: BrandingSettings = { ...current };
          for (const [field, value] of Object.entries(patch.branding)) {
            if (value === undefined) continue;
            // The route rejects unknown keys; internal callers use the shared DTO.
            (next as unknown as Record<string, unknown>)[field] = value;
            changed.push(`branding.${field}`);
          }
          await tx.settings.set(BRANDING_SETTINGS_KEY, next, false);
        }

        // Normalised above rather than only in the route schema, so the stored
        // value is an origin no matter who calls the service.
        if (nextGatewayUrl !== undefined) {
          await tx.settings.set(GATEWAY_SETTINGS_KEY, { public_url: nextGatewayUrl }, false);
          changed.push('gateway.public_url');
        }

        if (patch.captcha && captchaPlan) {
          // Compare-and-swap. `captchaPlan.next` is a merge over rows read
          // before the vendor round-trip, so writing it blind would silently
          // revert a concurrent CAPTCHA edit — and could store a
          // `{site_key, secret}` pair neither save ever proved, which is
          // exactly the lockout this section exists to prevent. Re-checking
          // here also means a body a pooled adapter re-runs after a rollback
          // re-fails instead of re-applying a merge that has gone stale.
          if ((await captchaFingerprint(tx)) !== captchaPlan.fingerprint) {
            throw conflict(
              'The CAPTCHA settings changed while this patch was being verified with the ' +
                'provider; reload the settings and try again',
            );
          }
          for (const field of ['enabled', 'provider', 'site_key'] as const) {
            if (patch.captcha[field] !== undefined) changed.push(`captcha.${field}`);
          }
          await tx.settings.set(CAPTCHA_SETTINGS_KEY, captchaPlan.next, false);

          if (patch.captcha.secret_key !== undefined) {
            changed.push('captcha.secret_key');
            if (patch.captcha.secret_key === null || patch.captcha.secret_key === '') {
              await tx.settings.delete(CAPTCHA_SECRET_SETTINGS_KEY);
            } else {
              await tx.settings.set(
                CAPTCHA_SECRET_SETTINGS_KEY,
                crypto.encryptJson(patch.captcha.secret_key),
                true,
              );
            }
          }
        }

        if (patch.smtp) {
          const current = await readStoredSmtp(tx);
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
            (str(next.host) ?? config.smtp.host ?? null) !==
              (current.host ?? config.smtp.host ?? null) ||
            (next.port ?? config.smtp.port) !== (current.port ?? config.smtp.port) ||
            (next.secure ?? config.smtp.secure) !== (current.secure ?? config.smtp.secure) ||
            (str(next.username) ?? config.smtp.user ?? null) !==
              (current.username ?? config.smtp.user ?? null);
          const storedPassword = await tx.settings.get(SMTP_PASSWORD_SETTINGS_KEY);
          const passwordSet = storedPassword !== null || config.smtp.password !== undefined;
          const clearingPassword = patch.smtp.password === null || patch.smtp.password === '';
          const connectionMatchesEnvironment =
            (str(next.host) ?? config.smtp.host ?? null) === (config.smtp.host ?? null) &&
            (next.port ?? config.smtp.port) === config.smtp.port &&
            (next.secure ?? config.smtp.secure) === config.smtp.secure &&
            (str(next.username) ?? config.smtp.user ?? null) === (config.smtp.user ?? null);
          // Clearing an override restores the environment credential. Its connection
          // must also belong to the environment, even when this patch did not move it.
          if (clearingPassword && !connectionMatchesEnvironment) {
            throw validationFailed(
              'SMTP password can only be cleared when the connection matches the environment',
            );
          }
          if (connectionChanged && passwordSet && !patch.smtp.password) {
            throw validationFailed(
              'SMTP password is required when changing the SMTP connection settings',
            );
          }
          for (const field of ['host', 'port', 'secure', 'username', 'from_address'] as const) {
            if (patch.smtp[field] !== undefined) changed.push(`smtp.${field}`);
          }
          await tx.settings.set(SMTP_SETTINGS_KEY, next, false);

          if (patch.smtp.password !== undefined) {
            changed.push('smtp.password');
            const from = storedPassword === null ? 'environment' : 'override';
            const to = clearingPassword ? 'environment' : 'override';
            if (from !== to) smtpPasswordSourceChange = { from, to };
            if (clearingPassword) {
              await tx.settings.delete(SMTP_PASSWORD_SETTINGS_KEY);
            } else {
              await tx.settings.set(
                SMTP_PASSWORD_SETTINGS_KEY,
                crypto.encryptJson(patch.smtp.password),
                true,
              );
            }
          }
        }

        if (patch.registration) {
          const current = await readRegistrationPolicy(tx);
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
          await tx.settings.set(REGISTRATION_SETTINGS_KEY, next, false);
        }

        // Record key names and credential provenance, never setting values,
        // which would put the SMTP password and CAPTCHA secret in the audit log.
        await audit.forStore(tx).record(
          actor,
          AuditAction.ADMIN_SETTINGS_UPDATE,
          { type: 'settings', id: null },
          {
            changed_keys: changed,
            ...(smtpPasswordSourceChange
              ? { smtp_password_source_change: smtpPasswordSourceChange }
              : {}),
            // Recorded because it is the evidence that this activation was
            // provably usable at the moment it was stored, and because its
            // absence on a `captcha.enabled` change would be an anomaly.
            ...(captchaPlan?.selfTested ? { captcha_self_test: 'passed' } : {}),
          },
          ip,
        );
      });
      brandingRevision += 1;
      // Only committed updates invalidate the cached public origin.
      if (nextGatewayUrl !== undefined) gatewayUrlCache = null;

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
      for (const field of ['subject', 'body_html', 'body_text'] as const) {
        const variable = removedTemplateVariable(value[field]);
        if (variable) {
          throw validationFailed(`Template placeholder '${variable}' is no longer supported`, {
            field,
            variable,
          });
        }
      }
      validateTemplateLinks(value, config);
      // The template and its audit record commit together, like every other
      // settings write: a failed audit insert must not leave an unaudited
      // template in force (#334). The body only writes through `tx`, so a
      // pooled adapter may safely re-run it.
      return store.transaction(async (tx) => {
        const template = await tx.emailTemplates.upsert(key, value);
        await audit.forStore(tx).record(
          actor,
          AuditAction.ADMIN_TEMPLATE_UPDATE,
          { type: 'email_template', id: key },
          {
            key,
            body_html_sha256: createHash('sha256').update(template.body_html, 'utf8').digest('hex'),
            body_text_sha256: createHash('sha256').update(template.body_text, 'utf8').digest('hex'),
          },
          ip,
        );
        return template;
      });
    },
  };
}
