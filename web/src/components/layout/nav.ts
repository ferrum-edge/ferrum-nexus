/**
 * The single source of truth for sidebar navigation.
 *
 * Both the sidebar and the route guards read this list, so a section can never
 * be visible to a role that cannot enter it. Visibility is decided purely by
 * the shared role ordering (`client` < `provider` < `admin` < `super_admin`).
 */

import { roleAtLeast, type Role } from '@ferrum-nexus/shared';
import type { IconName } from '../ui/Icon';

/** Every path reachable from the sidebar. */
export type NavPath =
  | '/'
  | '/catalog'
  | '/credentials'
  | '/messages'
  | '/profile'
  | '/apis'
  | '/admin/users'
  | '/admin/orgs'
  | '/admin/apis'
  | '/admin/audit'
  | '/admin/settings'
  | '/admin/mass-email'
  | '/admin/god';

/** Grouping heading a nav item belongs to. */
export type NavSection = 'main' | 'provider' | 'admin';

/** One sidebar entry. */
export interface NavItem {
  to: NavPath;
  label: string;
  icon: IconName;
  /** Minimum role required to see (and enter) this destination. */
  minRole: Role;
  section: NavSection;
  /** Only match this item as active on an exact path match. */
  exact?: boolean;
}

/** Section headings, in display order. */
export const NAV_SECTIONS: ReadonlyArray<{ id: NavSection; label: string }> = [
  { id: 'main', label: 'Portal' },
  { id: 'provider', label: 'Publishing' },
  { id: 'admin', label: 'Administration' },
];

/** Every sidebar destination, in display order. */
export const NAV_ITEMS: readonly NavItem[] = [
  {
    to: '/',
    label: 'Dashboard',
    icon: 'dashboard',
    minRole: 'client',
    section: 'main',
    exact: true,
  },
  { to: '/catalog', label: 'API catalog', icon: 'catalog', minRole: 'client', section: 'main' },
  { to: '/credentials', label: 'Credentials', icon: 'key', minRole: 'client', section: 'main' },
  { to: '/messages', label: 'Messages', icon: 'mail', minRole: 'client', section: 'main' },
  { to: '/profile', label: 'Profile', icon: 'user', minRole: 'client', section: 'main' },

  { to: '/apis', label: 'My APIs', icon: 'stack', minRole: 'provider', section: 'provider' },

  { to: '/admin/users', label: 'Users', icon: 'users', minRole: 'admin', section: 'admin' },
  {
    to: '/admin/orgs',
    label: 'Organizations',
    icon: 'building',
    minRole: 'admin',
    section: 'admin',
  },
  { to: '/admin/apis', label: 'All APIs', icon: 'spec', minRole: 'admin', section: 'admin' },
  { to: '/admin/audit', label: 'Audit log', icon: 'audit', minRole: 'admin', section: 'admin' },
  {
    to: '/admin/settings',
    label: 'Settings',
    icon: 'settings',
    minRole: 'admin',
    section: 'admin',
  },
  {
    to: '/admin/mass-email',
    label: 'Mass email',
    icon: 'megaphone',
    minRole: 'admin',
    section: 'admin',
  },
  { to: '/admin/god', label: 'God mode', icon: 'shield', minRole: 'super_admin', section: 'admin' },
];

/** Nav entries a given role may see; `null` (signed out) sees nothing. */
export function visibleNavItems(role: Role | null): NavItem[] {
  if (role === null) return [];
  return NAV_ITEMS.filter((item) => roleAtLeast(role, item.minRole));
}

/** Nav entries for one section, filtered by role. */
export function navItemsForSection(role: Role | null, section: NavSection): NavItem[] {
  return visibleNavItems(role).filter((item) => item.section === section);
}

/** The minimum role required to enter `path`, or `null` when it is not a nav path. */
export function requiredRoleForPath(path: string): Role | null {
  const match = NAV_ITEMS.find((item) => item.to === path);
  return match ? match.minRole : null;
}
