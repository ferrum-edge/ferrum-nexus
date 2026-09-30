/**
 * The stored single sign-on configuration, and the providers in force.
 *
 * | key                      | contents                                           | encrypted |
 * | ------------------------ | -------------------------------------------------- | --------- |
 * | `sso`                    | policy, allowed domains, deprovisioning, providers | no        |
 * | `sso.client_secret.<id>` | one provider's client secret                       | **yes**   |
 *
 * Environment providers (`NEXUS_OIDC_PROVIDERS`) are never stored: they are
 * merged in front of the stored ones on every read, and an id the environment
 * declares cannot be saved as a settings provider.
 *
 * Reads are lenient — a malformed stored provider is dropped rather than
 * failing every sign-in — and writes are strict (`sso/service.ts`).
 */

import {
  DEFAULT_LOGIN_POLICY,
  isLoginPolicy,
  type LoginPolicy,
  type SsoProviderSettings,
  type SsoProviderSource,
} from '@ferrum-nexus/shared';

import type { NexusConfig } from '../config/index.js';
import type { NexusStore } from '../db/store.js';
import type { NexusCrypto } from '../lib/crypto.js';
import { normalizeEmailDomain, ssoProviderSettingsSchema } from './config.js';

/** `app_settings` key of the non-secret single sign-on configuration. */
export const SSO_SETTINGS_KEY = 'sso';

/** `app_settings` key of one settings provider's encrypted client secret. */
export function ssoClientSecretKey(providerId: string): string {
  return `sso.client_secret.${providerId}`;
}

/** The stored `sso` row, with defaults applied. */
export interface StoredSsoSettings {
  policy: LoginPolicy;
  allowed_email_domains: string[];
  deprovision_on_access_loss: boolean;
  /** Settings-sourced providers only. */
  providers: SsoProviderSettings[];
}

/** A provider in force, from either source. */
export interface ResolvedSsoProvider {
  settings: SsoProviderSettings;
  source: SsoProviderSource;
  /** `null` for a public client, or when a stored secret no longer decrypts. */
  clientSecret: string | null;
  /**
   * True when a secret is stored but does not decrypt (`NEXUS_SECRET_KEY` was
   * rotated without `rotate-key`). Sign-in through the provider then fails
   * closed rather than presenting no secret at all.
   */
  secretUnreadable: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/** Read the `sso` row leniently: unknown or malformed parts fall back to defaults. */
export async function readStoredSsoSettings(store: NexusStore): Promise<StoredSsoSettings> {
  const row = await store.settings.get(SSO_SETTINGS_KEY);
  const value = asRecord(row?.value);
  const domains = Array.isArray(value.allowed_email_domains)
    ? value.allowed_email_domains.flatMap((entry: unknown) => {
        const domain = typeof entry === 'string' ? normalizeEmailDomain(entry) : null;
        return domain === null ? [] : [domain];
      })
    : [];
  const providers = Array.isArray(value.providers)
    ? value.providers.flatMap((entry: unknown) => {
        const parsed = ssoProviderSettingsSchema.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
      })
    : [];
  return {
    policy: isLoginPolicy(value.policy) ? value.policy : DEFAULT_LOGIN_POLICY,
    allowed_email_domains: [...new Set(domains)],
    deprovision_on_access_loss: value.deprovision_on_access_loss === true,
    providers,
  };
}

/** The deployment's login policy. Used by the password flows as well as SSO. */
export async function readLoginPolicy(store: NexusStore): Promise<LoginPolicy> {
  return (await readStoredSsoSettings(store)).policy;
}

/**
 * The settings of every provider in force, environment first, in
 * configuration order, without reading any secret. A stored provider whose id
 * the environment also declares is shadowed.
 */
export function providersInForce(
  config: NexusConfig,
  stored: StoredSsoSettings,
): { settings: SsoProviderSettings; source: SsoProviderSource }[] {
  const envIds = new Set(config.sso.providers.map((provider) => provider.settings.id));
  return [
    ...config.sso.providers.map((provider) => ({
      settings: provider.settings,
      source: 'environment' as const,
    })),
    ...stored.providers
      .filter((provider) => !envIds.has(provider.id))
      .map((provider) => ({ settings: provider, source: 'settings' as const })),
  ];
}

/**
 * Stored providers whose id the environment now also declares. The
 * environment one is in force; reported so an administrator can see why a
 * stored provider does nothing, and remove it.
 */
export function shadowedProviderIds(config: NexusConfig, stored: StoredSsoSettings): string[] {
  const envIds = new Set(config.sso.providers.map((provider) => provider.settings.id));
  return stored.providers.filter((provider) => envIds.has(provider.id)).map(({ id }) => id);
}

/**
 * Whether an account may no longer use a password — sign-in or reset.
 *
 * True for an account an identity provider provisioned: it never had a
 * password, and one set later through a reset would let its holder keep
 * access after the provider offboarded them. True as well for an account
 * linked to a provider that sets `disable_local_password_for_linked`. A link
 * removed by an administrator no longer counts.
 */
export async function localPasswordBlocked(
  config: NexusConfig,
  store: NexusStore,
  userId: string,
): Promise<boolean> {
  const identities = await store.userIdentities.listByUser(userId);
  if (identities.length === 0) return false;
  if (identities.some((identity) => identity.provisioned)) return true;
  const strict = new Set(
    providersInForce(config, await readStoredSsoSettings(store))
      .filter(({ settings }) => settings.disable_local_password_for_linked)
      .map(({ settings }) => settings.id),
  );
  return identities.some((identity) => strict.has(identity.provider_id));
}

/** Every provider in force, as {@link providersInForce} orders them, with its secret. */
export async function resolveSsoProviders(
  config: NexusConfig,
  store: NexusStore,
  crypto: NexusCrypto,
  stored: StoredSsoSettings,
): Promise<ResolvedSsoProvider[]> {
  const resolved: ResolvedSsoProvider[] = [];
  for (const { settings, source } of providersInForce(config, stored)) {
    if (source === 'environment') {
      const declared = config.sso.providers.find(
        (provider) => provider.settings.id === settings.id,
      );
      resolved.push({
        settings,
        source,
        clientSecret: declared?.clientSecret ?? null,
        secretUnreadable: false,
      });
      continue;
    }
    const secret = await readClientSecret(store, crypto, settings.id);
    resolved.push({
      settings,
      source,
      clientSecret: secret.state === 'value' ? secret.value : null,
      secretUnreadable: secret.state === 'unreadable',
    });
  }
  return resolved;
}

/** What a stored client secret read found. */
export type ClientSecretRead =
  { state: 'absent' } | { state: 'value'; value: string } | { state: 'unreadable' };

/** A stored client secret, telling "none" apart from "stored but unreadable". */
export async function readClientSecret(
  store: NexusStore,
  crypto: NexusCrypto,
  providerId: string,
): Promise<ClientSecretRead> {
  const row = await store.settings.get(ssoClientSecretKey(providerId));
  if (!row) return { state: 'absent' };
  if (!row.encrypted || typeof row.value !== 'string') return { state: 'unreadable' };
  try {
    const value = crypto.decryptJson<unknown>(row.value);
    return typeof value === 'string' && value !== ''
      ? { state: 'value', value }
      : { state: 'unreadable' };
  } catch {
    return { state: 'unreadable' };
  }
}
