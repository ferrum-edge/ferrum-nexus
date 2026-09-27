import { describe, expect, it } from 'vitest';
import { ROLE_ORDER, type Role } from '@ferrum-nexus/shared';
import {
  NAV_ITEMS,
  isNavItemActive,
  locationForPath,
  navItemsForSection,
  requiredRoleForPath,
  visibleNavItems,
  type NavItem,
} from './nav';

function pathsFor(role: Role | null): string[] {
  return visibleNavItems(role).map((item) => item.to);
}

describe('nav config', () => {
  it('shows a signed-out visitor nothing', () => {
    expect(pathsFor(null)).toEqual([]);
  });

  it('gives clients the portal section only', () => {
    const paths = pathsFor('client');
    expect(paths).toEqual([
      '/',
      '/catalog',
      '/applications',
      '/credentials',
      '/messages',
      '/profile',
    ]);
    expect(paths).not.toContain('/apis');
    expect(paths.some((path) => path.startsWith('/admin'))).toBe(false);
  });

  it('adds the publishing section for providers, without admin pages', () => {
    const paths = pathsFor('provider');
    expect(paths).toContain('/apis');
    expect(paths).toContain('/catalog');
    expect(paths.some((path) => path.startsWith('/admin'))).toBe(false);
  });

  it('gives admins every admin page except god mode', () => {
    const paths = pathsFor('admin');
    expect(paths).toContain('/apis');
    expect(paths).toContain('/admin/users');
    expect(paths).toContain('/admin/orgs');
    expect(paths).toContain('/admin/apis');
    expect(paths).toContain('/admin/audit');
    expect(paths).toContain('/admin/settings');
    expect(paths).toContain('/admin/mass-email');
    expect(paths).not.toContain('/admin/god');
  });

  it('gives super admins everything', () => {
    expect(pathsFor('super_admin')).toEqual(NAV_ITEMS.map((item) => item.to));
  });

  it('never shrinks the visible set as the role rank grows', () => {
    let previous: string[] = [];
    for (const role of ROLE_ORDER) {
      const current = pathsFor(role);
      for (const path of previous) expect(current).toContain(path);
      previous = current;
    }
  });

  it('groups items by section', () => {
    expect(navItemsForSection('super_admin', 'provider').map((item) => item.to)).toEqual(['/apis']);
    expect(navItemsForSection('client', 'admin')).toEqual([]);
    expect(navItemsForSection('client', 'main')).toHaveLength(6);
  });

  it('reports the role a nav path requires', () => {
    expect(requiredRoleForPath('/admin/god')).toBe('super_admin');
    expect(requiredRoleForPath('/apis')).toBe('provider');
    expect(requiredRoleForPath('/catalog')).toBe('client');
    expect(requiredRoleForPath('/not-a-nav-path')).toBeNull();
  });

  it('keeps off-sidebar pages out of the sidebar and the route guards', () => {
    expect(pathsFor('super_admin')).not.toContain('/notifications');
    expect(requiredRoleForPath('/notifications')).toBeNull();
  });
});

describe('location bar', () => {
  it.each([
    ['/', 'Portal', 'Dashboard'],
    ['/catalog', 'Portal', 'API catalog'],
    ['/catalog/billing', 'Portal', 'API catalog'],
    ['/applications', 'Portal', 'Applications'],
    ['/credentials', 'Portal', 'Credentials'],
    ['/messages', 'Portal', 'Messages'],
    ['/messages/thread-1', 'Portal', 'Messages'],
    ['/notifications', 'Portal', 'Notifications'],
    ['/profile', 'Portal', 'Profile'],
    ['/apis', 'Publishing', 'My APIs'],
    ['/apis/new', 'Publishing', 'My APIs'],
    ['/apis/api-1', 'Publishing', 'My APIs'],
    ['/admin/users', 'Administration', 'Users'],
    ['/admin/orgs', 'Administration', 'Organizations'],
    ['/admin/apis', 'Administration', 'All APIs'],
    ['/admin/audit', 'Administration', 'Audit log'],
    ['/admin/settings', 'Administration', 'Settings'],
    ['/admin/mass-email', 'Administration', 'Mass email'],
    ['/admin/god', 'Administration', 'God mode'],
  ])('names %s as %s › %s', (path, section, page) => {
    expect(locationForPath(path)).toEqual({ section, page });
  });

  it('names nothing for a path no page owns', () => {
    expect(locationForPath('/nope')).toBeNull();
    // A prefix of a nav path is not that page.
    expect(locationForPath('/catalogue')).toBeNull();
  });
});

describe('isNavItemActive', () => {
  const item = (to: string): NavItem => NAV_ITEMS.find((entry) => entry.to === to)!;

  it('matches the item itself and pages beneath it', () => {
    expect(isNavItemActive(item('/apis'), '/apis')).toBe(true);
    expect(isNavItemActive(item('/apis'), '/apis/new')).toBe(true);
    expect(isNavItemActive(item('/apis'), '/apis/abc')).toBe(true);
  });

  it('does not match a sibling that merely shares a prefix', () => {
    expect(isNavItemActive(item('/apis'), '/admin/apis')).toBe(false);
    expect(isNavItemActive(item('/admin/apis'), '/apis/abc')).toBe(false);
    expect(isNavItemActive(item('/catalog'), '/catalogue')).toBe(false);
  });

  it('matches the dashboard only on its own path', () => {
    expect(isNavItemActive(item('/'), '/')).toBe(true);
    expect(isNavItemActive(item('/'), '/apis')).toBe(false);
  });
});
