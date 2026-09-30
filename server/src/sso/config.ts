/**
 * The shape of an OpenID Connect provider's configuration, and the rules it
 * is held to wherever it comes from — `NEXUS_OIDC_PROVIDERS` at startup or
 * `PUT /api/admin/sso` at runtime.
 *
 * Pure: no store, no network. `config/index.ts` uses it to validate the
 * environment and `sso/settings.ts` to validate what an administrator saves,
 * so the two sources can never accept different things.
 */

import { z } from 'zod';

import {
  SSO_MAPPABLE_ROLES,
  SSO_PROVIDER_ID_PATTERN,
  type SsoProviderSettings,
} from '@ferrum-nexus/shared';

/** Most providers one deployment may configure, across both sources. */
export const MAX_SSO_PROVIDERS = 10;

/** Most role or organization mappings one provider may carry, per kind. */
export const MAX_SSO_MAPPINGS = 100;

/** Most entries in the allowed-email-domain list. */
export const MAX_ALLOWED_EMAIL_DOMAINS = 100;

/** Longest client secret accepted. */
export const MAX_CLIENT_SECRET_LENGTH = 2048;

/** Scopes requested when a provider does not say. */
export const DEFAULT_SSO_SCOPES: readonly string[] = ['openid', 'email', 'profile'];

const PROVIDER_ID = new RegExp(SSO_PROVIDER_ID_PATTERN);

/** RFC 6749 `scope-token`: printable ASCII except space, `"` and `\`. */
const SCOPE_TOKEN = /^[\x21\x23-\x5b\x5d-\x7e]+$/;

/** A lower-case DNS name with at least two labels. */
const EMAIL_DOMAIN =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Hosts an `http://` issuer may name under `NEXUS_OIDC_ALLOW_HTTP_LOOPBACK=true`. */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * Why `value` may not be used as an issuer or an endpoint the portal calls,
 * or `null` when it may.
 *
 * HTTPS only. A plaintext `http://` URL is accepted for a loopback host, and
 * only when the operator explicitly allowed it — a development identity
 * provider on the same machine. Every URL a discovery document names is held
 * to the same rule, so an HTTPS issuer cannot point the portal at a plaintext
 * token endpoint.
 */
export function oidcUrlProblem(value: string, allowHttpLoopback: boolean): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'must be an absolute URL';
  }
  if (url.username !== '' || url.password !== '') return 'must not contain credentials';
  if (url.hash !== '' || value.includes('#')) return 'must not contain a fragment';
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:') {
    if (allowHttpLoopback && isLoopbackHostname(url.hostname)) return null;
    return (
      'must use https:// (plain http:// is accepted only for a loopback host, and only with ' +
      'NEXUS_OIDC_ALLOW_HTTP_LOOPBACK=true)'
    );
  }
  return 'must use https://';
}

/**
 * Why `issuer` may not be configured, or `null`. An issuer is an endpoint
 * that additionally carries no query string, as OpenID Connect Discovery
 * requires.
 */
export function issuerProblem(issuer: string, allowHttpLoopback: boolean): string | null {
  const problem = oidcUrlProblem(issuer, allowHttpLoopback);
  if (problem !== null) return problem;
  if (issuer.includes('?')) return 'must not contain a query string';
  return null;
}

/**
 * Normalise one allowed email domain (`@Example.COM` → `example.com`), or
 * `null` when it is not a domain.
 */
export function normalizeEmailDomain(value: string): string | null {
  const domain = value.trim().toLowerCase().replace(/^@/, '');
  return EMAIL_DOMAIN.test(domain) ? domain : null;
}

const claimPath = z.string().trim().min(1).max(256);
const claimValue = z.string().min(1).max(512);

/** One claim-to-role rule. */
export const ssoRoleMappingSchema = z
  .object({ claim: claimPath, value: claimValue, role: z.enum(SSO_MAPPABLE_ROLES) })
  .strict();

/** One claim-to-organization rule. */
export const ssoOrgMappingSchema = z
  .object({ claim: claimPath, value: claimValue, org_id: z.string().trim().min(1).max(64) })
  .strict();

const scopesSchema = z
  .array(z.string().regex(SCOPE_TOKEN, 'must be a single OAuth scope token'))
  .min(1)
  .max(20)
  .refine((scopes) => scopes.includes('openid'), { message: 'must include openid' });

/** Every field of {@link SsoProviderSettings}, all required. */
export const ssoProviderSettingsShape = {
  id: z.string().regex(PROVIDER_ID, 'must be 1-32 lower-case letters, digits or hyphens'),
  display_name: z.string().trim().min(1).max(100),
  issuer: z.string().trim().min(1).max(2048),
  client_id: z.string().trim().min(1).max(512),
  scopes: scopesSchema,
  enabled: z.boolean(),
  jit_provisioning: z.boolean(),
  link_existing_accounts: z.boolean(),
  require_verified_email: z.boolean(),
  sync_roles: z.boolean(),
  default_role: z.enum(SSO_MAPPABLE_ROLES).nullable(),
  role_mappings: z.array(ssoRoleMappingSchema).max(MAX_SSO_MAPPINGS),
  org_mappings: z.array(ssoOrgMappingSchema).max(MAX_SSO_MAPPINGS),
};

/** A provider as `PUT /api/admin/sso` or a stored `sso` row carries it. */
export const ssoProviderSettingsSchema = z.object(ssoProviderSettingsShape).strict();

/**
 * A provider as `NEXUS_OIDC_PROVIDERS` declares it: only `id`, `issuer` and
 * `client_id` are required, everything else has the documented default, and
 * the secret may ride along.
 */
const envProviderSchema = z
  .object({
    id: ssoProviderSettingsShape.id,
    display_name: ssoProviderSettingsShape.display_name.optional(),
    issuer: ssoProviderSettingsShape.issuer,
    client_id: ssoProviderSettingsShape.client_id,
    client_secret: z.string().min(1).max(MAX_CLIENT_SECRET_LENGTH).optional(),
    scopes: scopesSchema.optional(),
    enabled: z.boolean().optional(),
    jit_provisioning: z.boolean().optional(),
    link_existing_accounts: z.boolean().optional(),
    require_verified_email: z.boolean().optional(),
    sync_roles: z.boolean().optional(),
    default_role: z.enum(SSO_MAPPABLE_ROLES).nullable().optional(),
    role_mappings: z.array(ssoRoleMappingSchema).max(MAX_SSO_MAPPINGS).optional(),
    org_mappings: z.array(ssoOrgMappingSchema).max(MAX_SSO_MAPPINGS).optional(),
  })
  .strict();

/** A provider declared in the environment, with its secret if it has one. */
export interface EnvSsoProvider {
  settings: SsoProviderSettings;
  /** Never logged, never returned; `undefined` for a public client. */
  clientSecret: string | undefined;
}

/** Single sign-on configuration read from the environment. */
export interface SsoEnvConfig {
  /** `NEXUS_OIDC_PROVIDERS`, validated. Read-only in the admin UI. */
  providers: EnvSsoProvider[];
  /** `NEXUS_OIDC_ALLOW_HTTP_LOOPBACK`: accept `http://` issuers on a loopback host. */
  allowHttpLoopback: boolean;
  /**
   * `NEXUS_SSO_BREAK_GLASS_LOCAL_LOGIN`: under the `sso_only` policy, still
   * accept password sign-in for `super_admin` accounts. Environment-only, like
   * `NEXUS_CAPTCHA_ENFORCEMENT`: an API-settable bypass would be an escalation
   * path out of the policy it relaxes.
   */
  breakGlassLocalLogin: boolean;
}

/**
 * Name of the variable that may carry `providerId`'s client secret instead of
 * the JSON: `corp-idp` → `NEXUS_OIDC_CLIENT_SECRET_CORP_IDP`.
 */
export function envClientSecretVariable(providerId: string): string {
  return `NEXUS_OIDC_CLIENT_SECRET_${providerId.toUpperCase().replace(/-/g, '_')}`;
}

/**
 * Parse `NEXUS_OIDC_PROVIDERS` (a JSON array) into providers, pushing every
 * problem onto `problems` rather than throwing, like the rest of
 * `loadConfig`. Problems name the provider and field, never a secret.
 */
export function parseEnvSsoProviders(
  raw: string | undefined,
  secretFor: (variable: string) => string | undefined,
  allowHttpLoopback: boolean,
  problems: string[],
): EnvSsoProvider[] {
  if (raw === undefined || raw.trim() === '') return [];
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    problems.push('NEXUS_OIDC_PROVIDERS must be a JSON array of provider objects');
    return [];
  }
  if (!Array.isArray(decoded)) {
    problems.push('NEXUS_OIDC_PROVIDERS must be a JSON array of provider objects');
    return [];
  }
  if (decoded.length > MAX_SSO_PROVIDERS) {
    problems.push(`NEXUS_OIDC_PROVIDERS may declare at most ${MAX_SSO_PROVIDERS} providers`);
    return [];
  }

  const providers: EnvSsoProvider[] = [];
  const seen = new Set<string>();
  decoded.forEach((entry: unknown, index: number) => {
    const parsed = envProviderSchema.safeParse(entry);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const path = issue.path.length > 0 ? `.${issue.path.join('.')}` : '';
        problems.push(`NEXUS_OIDC_PROVIDERS[${index}]${path} ${issue.message}`);
      }
      return;
    }
    const value = parsed.data;
    if (seen.has(value.id)) {
      problems.push(`NEXUS_OIDC_PROVIDERS declares provider '${value.id}' more than once`);
      return;
    }
    seen.add(value.id);
    const issuer = issuerProblem(value.issuer, allowHttpLoopback);
    if (issuer !== null) {
      problems.push(`NEXUS_OIDC_PROVIDERS['${value.id}'].issuer ${issuer}`);
      return;
    }
    const variable = envClientSecretVariable(value.id);
    const fromVariable = secretFor(variable);
    const clientSecret =
      fromVariable !== undefined && fromVariable.trim() !== '' ? fromVariable : value.client_secret;
    if (clientSecret !== undefined && clientSecret.length > MAX_CLIENT_SECRET_LENGTH) {
      problems.push(`${variable} must be at most ${MAX_CLIENT_SECRET_LENGTH} characters`);
      return;
    }
    providers.push({
      settings: {
        id: value.id,
        display_name: value.display_name ?? value.id,
        issuer: value.issuer,
        client_id: value.client_id,
        scopes: value.scopes ?? [...DEFAULT_SSO_SCOPES],
        enabled: value.enabled ?? true,
        jit_provisioning: value.jit_provisioning ?? true,
        link_existing_accounts: value.link_existing_accounts ?? true,
        require_verified_email: value.require_verified_email ?? true,
        sync_roles: value.sync_roles ?? true,
        default_role: value.default_role === undefined ? 'client' : value.default_role,
        role_mappings: value.role_mappings ?? [],
        org_mappings: value.org_mappings ?? [],
      },
      clientSecret,
    });
  });
  return providers;
}
