import { describe, expect, it } from 'vitest';
import { ROLE_ORDER, type Role } from '@ferrum-nexus/shared';
import { NAV_ITEMS, navItemsForSection, requiredRoleForPath, visibleNavItems } from './nav';

function pathsFor(role: Role | null): string[] {
  return visibleNavItems(role).map((item) => item.to);
}

describe('nav config', () => {
  it('shows a signed-out visitor nothing', () => {
    expect(pathsFor(null)).toEqual([]);
  });

  it('gives clients the portal section only', () => {
    const paths = pathsFor('client');
    expect(paths).toEqual(['/', '/catalog', '/credentials', '/messages', '/profile']);
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
    expect(navItemsForSection('client', 'main')).toHaveLength(5);
  });

  it('reports the role a nav path requires', () => {
    expect(requiredRoleForPath('/admin/god')).toBe('super_admin');
    expect(requiredRoleForPath('/apis')).toBe('provider');
    expect(requiredRoleForPath('/catalog')).toBe('client');
    expect(requiredRoleForPath('/not-a-nav-path')).toBeNull();
  });
});
