/**
 * Single sign-on (OpenID Connect) constants and shapes shared by the server
 * and the SPA.
 *
 * The request and response DTOs of the SSO endpoints live in
 * `api-contract.ts` with every other route; this module holds the vocabulary
 * they are written in.
 */

import type { Role } from './roles.js';

/**
 * Which sign-in methods a deployment accepts.
 *
 * - `local_only` — email and password only; the SSO endpoints refuse.
 * - `sso_only` — identity-provider sign-in only. Password sign-in and
 *   self-service registration are refused, except the founding registration
 *   that presents the bootstrap token, and (when the operator sets
 *   `NEXUS_SSO_BREAK_GLASS_LOCAL_LOGIN=true`) password sign-in for a
 *   `super_admin`.
 * - `local_and_sso` — both.
 */
export const LOGIN_POLICIES = ['local_only', 'sso_only', 'local_and_sso'] as const;

/** One of {@link LOGIN_POLICIES}. */
export type LoginPolicy = (typeof LOGIN_POLICIES)[number];

/**
 * The policy of a portal nobody has configured. With no provider configured
 * it behaves exactly like `local_only`; declaring a provider is what turns
 * single sign-on on.
 */
export const DEFAULT_LOGIN_POLICY: LoginPolicy = 'local_and_sso';

/** Runtime type guard for {@link LoginPolicy}. */
export function isLoginPolicy(value: unknown): value is LoginPolicy {
  return typeof value === 'string' && (LOGIN_POLICIES as readonly string[]).includes(value);
}

/**
 * Roles an identity provider's claims may confer.
 *
 * `super_admin` is deliberately absent, and the server never grants, removes
 * or otherwise changes a `super_admin` from claims.
 */
export const SSO_MAPPABLE_ROLES = [
  'client',
  'provider',
  'admin',
] as const satisfies readonly Role[];

/** One of {@link SSO_MAPPABLE_ROLES}. */
export type SsoMappableRole = (typeof SSO_MAPPABLE_ROLES)[number];

/** Runtime type guard for {@link SsoMappableRole}. */
export function isSsoMappableRole(value: unknown): value is SsoMappableRole {
  return typeof value === 'string' && (SSO_MAPPABLE_ROLES as readonly string[]).includes(value);
}

/**
 * HttpOnly cookie carrying one sealed sign-in attempt — its `state`, `nonce`
 * and PKCE verifier — from `/api/auth/sso/:provider/start` to the callback.
 */
export const SSO_TRANSACTION_COOKIE = 'nexus_sso';

/** Path the {@link SSO_TRANSACTION_COOKIE} is scoped to. */
export const SSO_TRANSACTION_COOKIE_PATH = '/api/auth/sso';

/** How long one sign-in attempt may take between start and callback, in seconds. */
export const SSO_TRANSACTION_TTL_SECONDS = 600;

/** Pattern every provider id matches; it appears in the callback URL. */
export const SSO_PROVIDER_ID_PATTERN = '^[a-z0-9][a-z0-9-]{0,31}$';

/**
 * Why an SSO sign-in was refused, as the callback reports it to the SPA in
 * `/login?sso_error=<reason>`.
 *
 * A closed set on purpose: the callback never echoes identity-provider error
 * text, token contents or claim values into a URL.
 */
export const SSO_ERROR_REASONS = [
  /** The login policy is `local_only`, or the provider is unknown or disabled. */
  'sso_disabled',
  /** Discovery, the key set or the token endpoint could not be used. */
  'provider_unavailable',
  /** The attempt's cookie was missing, expired, or did not match `state`. */
  'invalid_state',
  /** The identity provider answered the authorization request with an error. */
  'idp_error',
  /** The ID token failed validation. */
  'token_invalid',
  /** The ID token carried no usable email address. */
  'email_required',
  /** The email address's domain is not in the allowed list. */
  'email_domain_not_allowed',
  /** The identity provider did not assert that the address is verified. */
  'email_not_verified',
  /** A local account holds the address and could not be linked safely. */
  'account_exists',
  /** The claims map to no role, so the account has no access. */
  'access_denied',
  /** The linked account is disabled. */
  'account_disabled',
  /** No account is linked and just-in-time provisioning is off. */
  'signup_disabled',
  /** Anything else; the server log has the detail. */
  'server_error',
] as const;

/** One of {@link SSO_ERROR_REASONS}. */
export type SsoErrorReason = (typeof SSO_ERROR_REASONS)[number];

/** Runtime type guard for {@link SsoErrorReason}. */
export function isSsoErrorReason(value: unknown): value is SsoErrorReason {
  return typeof value === 'string' && (SSO_ERROR_REASONS as readonly string[]).includes(value);
}

/**
 * One claim-to-role rule: when the ID token's `claim` (a dot-separated path,
 * e.g. `groups` or `realm_access.roles`) equals `value` or is an array
 * containing it, the account qualifies for `role`. The highest qualifying role
 * wins.
 */
export interface SsoRoleMapping {
  claim: string;
  value: string;
  role: SsoMappableRole;
}

/** One claim-to-organization rule; the first matching rule wins. */
export interface SsoOrgMapping {
  claim: string;
  value: string;
  org_id: string;
}

/** Everything configurable about one OIDC provider except its client secret. */
export interface SsoProviderSettings {
  /** Stable id; appears in the callback URL. Matches {@link SSO_PROVIDER_ID_PATTERN}. */
  id: string;
  /** Label on the sign-in button. */
  display_name: string;
  /** Issuer identifier; discovery is `<issuer>/.well-known/openid-configuration`. */
  issuer: string;
  client_id: string;
  /** Requested scopes; always includes `openid`. */
  scopes: string[];
  /** A disabled provider is hidden from the sign-in page and refuses callbacks. */
  enabled: boolean;
  /** Create an account on first sign-in when no account is linked or matched. */
  jit_provisioning: boolean;
  /**
   * Link the identity to an existing local account with the same email
   * address — only when the provider asserts `email_verified: true` **and** the
   * local account is verified too.
   */
  link_existing_accounts: boolean;
  /** Refuse just-in-time provisioning unless the provider asserts `email_verified: true`. */
  require_verified_email: boolean;
  /** Re-apply the mapped role on every sign-in. */
  sync_roles: boolean;
  /** Role when no {@link SsoRoleMapping} matches; `null` denies access instead. */
  default_role: SsoMappableRole | null;
  role_mappings: SsoRoleMapping[];
  /** Empty: organizations are not managed from claims. */
  org_mappings: SsoOrgMapping[];
}

/** A provider as the sign-in page sees it. */
export interface SsoProviderSummary {
  id: string;
  display_name: string;
}

/** Where a provider's configuration comes from. */
export type SsoProviderSource = 'environment' | 'settings';

/** A provider as an administrator sees it — the client secret is write-only. */
export interface SsoProviderAdminView extends SsoProviderSettings {
  /** `environment` providers come from `NEXUS_OIDC_PROVIDERS` and cannot be edited here. */
  source: SsoProviderSource;
  /** True when a client secret is configured; the value itself is never returned. */
  client_secret_set: boolean;
  /** The redirect URI to register with the identity provider. */
  redirect_uri: string;
}

/** A link between a portal account and one identity-provider subject. */
export interface UserIdentity {
  id: string;
  user_id: string;
  provider_id: string;
  /** The provider's `sub` claim. */
  subject: string;
  /** The email address the provider last asserted. */
  email: string | null;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}
