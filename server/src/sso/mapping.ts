/**
 * What a validated ID token's claims mean for a portal account: which role
 * and organization they map to, whether the address may sign in at all, and
 * what — if anything — has to change on the account.
 *
 * Pure functions over plain data, so every rule here is unit-tested without a
 * server. The one rule that matters most is structural: {@link SsoMappableRole}
 * has no `super_admin`, and {@link planClaimsChange} never touches an account
 * that already is one.
 */

import {
  roleRank,
  type Role,
  type SsoMappableRole,
  type SsoOrgMapping,
  type SsoProviderSettings,
  type SsoRoleMapping,
  type Uuid,
} from '@ferrum-nexus/shared';

/** Claims as the ID token carried them. */
export type Claims = Readonly<Record<string, unknown>>;

/**
 * Every string a claim holds, looked up by `path`.
 *
 * `path` is first tried as one claim name, so namespaced claims such as
 * `https://example.com/groups` work; otherwise it is split on `.` and walked
 * (`realm_access.roles`). A string yields itself, a number or boolean its
 * text, and an array each of those it contains. Anything else yields nothing.
 */
export function claimValues(claims: Claims, path: string): string[] {
  const value = Object.prototype.hasOwnProperty.call(claims, path)
    ? claims[path]
    : walk(claims, path.split('.'));
  const flat = Array.isArray(value) ? value : [value];
  return flat.flatMap((item: unknown) => {
    if (typeof item === 'string') return [item];
    if (typeof item === 'number' || typeof item === 'boolean') return [String(item)];
    return [];
  });
}

function walk(value: unknown, segments: readonly string[]): unknown {
  let current: unknown = value;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined;
    const record = current as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(record, segment)) return undefined;
    current = record[segment];
  }
  return current;
}

function matches(claims: Claims, mapping: { claim: string; value: string }): boolean {
  return claimValues(claims, mapping.claim).includes(mapping.value);
}

/** What one provider's mappings make of one set of claims. */
export interface ClaimMapping {
  /** The role the claims qualify for, or `null` when they grant no access. */
  role: SsoMappableRole | null;
  /** The highest-ranked matching rule, or `null` when the default applied. */
  roleMapping: SsoRoleMapping | null;
  /**
   * The organization the claims map to — `null` for none — or `undefined`
   * when the provider does not manage organizations (no org mappings).
   */
  orgId: Uuid | null | undefined;
  /** The first matching organization rule. */
  orgMapping: SsoOrgMapping | null;
}

/**
 * Map claims through a provider's rules.
 *
 * The role is the highest-ranked role any rule grants, else the provider's
 * default; a `null` default with no match means no access. The organization
 * is the first matching rule's, else none — but only when the provider has
 * organization rules at all.
 */
export function mapClaims(provider: SsoProviderSettings, claims: Claims): ClaimMapping {
  let roleMapping: SsoRoleMapping | null = null;
  for (const mapping of provider.role_mappings) {
    if (!matches(claims, mapping)) continue;
    if (roleMapping === null || roleRank(mapping.role) > roleRank(roleMapping.role)) {
      roleMapping = mapping;
    }
  }
  const role = roleMapping?.role ?? provider.default_role;

  if (provider.org_mappings.length === 0) {
    return { role, roleMapping, orgId: undefined, orgMapping: null };
  }
  const orgMapping = provider.org_mappings.find((mapping) => matches(claims, mapping)) ?? null;
  return { role, roleMapping, orgId: orgMapping?.org_id ?? null, orgMapping };
}

/**
 * The account changes a sign-in's mapping calls for, or `null` for none.
 *
 * - A `super_admin` is never changed: that role is conferred and removed in
 *   the portal only, and demoting one from a claim could strand the portal
 *   without an administrator.
 * - The role follows the mapping only when the provider syncs roles.
 * - The organization follows the mapping only when the provider manages
 *   organizations; `orgExists` says whether the mapped one is still there,
 *   and a deleted organization maps to none.
 */
export function planClaimsChange(
  account: { role: Role; org_id: Uuid | null },
  mapping: ClaimMapping,
  provider: SsoProviderSettings,
  orgExists: boolean,
): { role?: SsoMappableRole; org_id?: Uuid | null } | null {
  if (account.role === 'super_admin') return null;
  const patch: { role?: SsoMappableRole; org_id?: Uuid | null } = {};
  if (provider.sync_roles && mapping.role !== null && mapping.role !== account.role) {
    patch.role = mapping.role;
  }
  if (mapping.orgId !== undefined) {
    const target = mapping.orgId !== null && orgExists ? mapping.orgId : null;
    if (target !== account.org_id) patch.org_id = target;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/** Longest email address accepted, as elsewhere in the portal. */
const MAX_EMAIL_LENGTH = 320;

/**
 * The `email` claim as an address the portal can store — trimmed and
 * lower-cased — or `null` when it is missing or not an address.
 */
export function normalizeEmailClaim(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

/**
 * Whether the provider asserted the address is verified.
 *
 * Only the JSON boolean `true` counts. A string `"true"` or an absent claim
 * is "not verified": account linking is exactly where a lax reading becomes
 * an account takeover.
 */
export function emailVerifiedClaim(value: unknown): boolean {
  return value === true;
}

/** Whether `email` belongs to one of `allowed` (exact domain match); empty allows all. */
export function emailDomainAllowed(email: string, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return true;
  const at = email.lastIndexOf('@');
  if (at === -1) return false;
  return allowed.includes(email.slice(at + 1));
}

/** Longest display name the portal stores. */
const MAX_DISPLAY_NAME_LENGTH = 200;

/** A display name for a new account: `name`, else `preferred_username`, else the mailbox. */
export function displayNameFromClaims(claims: Claims, email: string): string {
  for (const key of ['name', 'preferred_username']) {
    const value = claims[key];
    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim().slice(0, MAX_DISPLAY_NAME_LENGTH);
    }
  }
  const at = email.indexOf('@');
  return (at > 0 ? email.slice(0, at) : email).slice(0, MAX_DISPLAY_NAME_LENGTH);
}
