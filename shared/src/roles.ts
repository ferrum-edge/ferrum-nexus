/**
 * Role model shared by the Nexus server and web SPA.
 *
 * Roles are strictly ordered — a higher role inherits every capability of the
 * roles beneath it: `client` < `provider` < `admin` < `super_admin`.
 */

import type { Capabilities } from './api-contract.js';

/** Every role a Nexus account can hold. */
export type Role = 'client' | 'provider' | 'admin' | 'super_admin';

/**
 * Roles in ascending order of privilege. Index in this array is the
 * privilege rank used by {@link roleAtLeast}.
 */
export const ROLE_ORDER = [
  'client',
  'provider',
  'admin',
  'super_admin',
] as const satisfies readonly Role[];

/** Roles a visitor may self-select at registration time. */
export const REGISTRABLE_ROLES = ['client', 'provider'] as const satisfies readonly Role[];

/** A role that can be chosen during self-service registration. */
export type RegistrableRole = (typeof REGISTRABLE_ROLES)[number];

/** Roles that can only be conferred by an existing admin/super_admin. */
export const ELEVATED_ROLES = ['admin', 'super_admin'] as const satisfies readonly Role[];

/** Human-readable labels for each role, for UI rendering. */
export const ROLE_LABELS: Readonly<Record<Role, string>> = {
  client: 'Client',
  provider: 'Provider',
  admin: 'Admin',
  super_admin: 'Super Admin',
};

/** Runtime type guard: is `value` a role a visitor may register with? */
export function isRegistrableRole(value: unknown): value is RegistrableRole {
  return typeof value === 'string' && (REGISTRABLE_ROLES as readonly string[]).includes(value);
}

/**
 * Privilege rank of a role (0 = `client` … 3 = `super_admin`).
 * Unknown values rank `-1` so they never satisfy a comparison.
 */
export function roleRank(role: Role): number {
  return (ROLE_ORDER as readonly string[]).indexOf(role);
}

/**
 * Does role `a` meet or exceed the privilege of role `b`?
 *
 * @example roleAtLeast('admin', 'provider') // true
 * @example roleAtLeast('client', 'provider') // false
 */
export function roleAtLeast(a: Role, b: Role): boolean {
  return roleRank(a) >= roleRank(b);
}

/**
 * The role-derived permission flags `/api/auth/me` and sign-in return, and the
 * SPA's fallback until a response carries them. One derivation, so the flags
 * the server sends and the ones the SPA assumes cannot disagree.
 */
export function capabilitiesFor(role: Role): Capabilities {
  return {
    can_publish_apis: roleAtLeast(role, 'provider'),
    can_review_access_requests: roleAtLeast(role, 'provider'),
    can_manage_users: roleAtLeast(role, 'admin'),
    can_manage_settings: roleAtLeast(role, 'admin'),
    can_view_audit_log: roleAtLeast(role, 'admin'),
    can_use_god_mode: roleAtLeast(role, 'super_admin'),
  };
}
