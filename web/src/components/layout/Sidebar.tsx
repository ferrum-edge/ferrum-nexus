import { Link } from '@tanstack/react-router';
import type { ReactElement, ReactNode, Ref } from 'react';
import { ROLE_LABELS, type Role, type User } from '@ferrum-nexus/shared';
import { cn } from '../../lib/cn';
import { Icon } from '../ui/Icon';
import { NAV_SECTIONS, navItemsForSection } from './nav';

export interface SidebarProps {
  id: string;
  sidebarRef: Ref<HTMLElement>;
  role: Role | null;
  /** Mobile drawer state; the sidebar is always visible from `lg` up. */
  open: boolean;
  isDesktop: boolean;
  onNavigate: () => void;
  portalName: string;
  logoDataUrl: string | null;
  /** Signed-in account, shown in the rail footer. */
  user?: Pick<User, 'display_name' | 'email' | 'role'> | null;
  /** Optional operator footer (a copyright line, legal links). */
  footer?: ReactNode;
}

/** Initials for an avatar tile: first letters of up to two words. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] ?? ''}${parts[parts.length - 1]![0] ?? ''}`.toUpperCase();
}

/** Brand tile: the uploaded logo, or a monogram of the portal name on the accent. */
export function BrandMark({
  logoDataUrl,
  portalName,
  className,
}: {
  logoDataUrl: string | null;
  portalName: string;
  className?: string;
}): ReactElement {
  if (logoDataUrl) {
    return (
      <img
        src={logoDataUrl}
        alt=""
        className={cn('h-8 w-8 shrink-0 rounded-md object-contain', className)}
      />
    );
  }
  return (
    <span
      className={cn(
        'flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-sm font-bold text-accent-fg',
        'bg-[linear-gradient(135deg,var(--accent-hover),var(--accent-active))] shadow-[0_1px_0_rgb(255_255_255/0.2)_inset,0_2px_8px_-2px_var(--accent-glow)]',
        className,
      )}
      aria-hidden="true"
    >
      {portalName.trim().charAt(0).toUpperCase() || 'N'}
    </span>
  );
}

/** Role-filtered primary navigation. */
export function Sidebar({
  id,
  sidebarRef,
  role,
  open,
  isDesktop,
  onNavigate,
  portalName,
  logoDataUrl,
  user,
  footer,
}: SidebarProps): ReactElement {
  return (
    <aside
      id={id}
      ref={sidebarRef}
      tabIndex={-1}
      inert={!isDesktop && !open}
      aria-hidden={!isDesktop && !open ? true : undefined}
      className={cn(
        'fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-fg',
        'transition-transform duration-200 ease-out lg:translate-x-0',
        open ? 'translate-x-0 shadow-pop' : '-translate-x-full',
      )}
      aria-label="Primary"
    >
      <Link
        to="/"
        onClick={onNavigate}
        className="flex h-16 items-center gap-3 border-b border-sidebar-border px-4 transition-colors hover:bg-sidebar-hover"
      >
        <BrandMark logoDataUrl={logoDataUrl} portalName={portalName} />
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold text-sidebar-fg-strong">
            {portalName}
          </span>
          <span className="block truncate text-[0.68rem] tracking-wide text-sidebar-subtle uppercase">
            Developer portal
          </span>
        </span>
      </Link>

      <nav className="flex-1 overflow-y-auto px-3 py-4">
        {NAV_SECTIONS.map((section) => {
          const items = navItemsForSection(role, section.id);
          if (items.length === 0) return null;
          return (
            <div key={section.id} className="mb-6 last:mb-0">
              <p className="px-2.5 pb-2 text-[0.66rem] font-semibold tracking-[0.14em] text-sidebar-subtle uppercase">
                {section.label}
              </p>
              <ul className="flex flex-col gap-0.5">
                {items.map((item) => (
                  <li key={item.to}>
                    <Link
                      to={item.to}
                      activeOptions={{ exact: item.exact ?? false }}
                      onClick={onNavigate}
                      className={cn(
                        'group relative flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium text-sidebar-fg',
                        'transition-colors hover:bg-sidebar-hover hover:text-sidebar-fg-strong',
                        'focus-visible:ring-2 focus-visible:ring-accent-ring focus-visible:outline-none',
                      )}
                      activeProps={{
                        className:
                          'bg-sidebar-active text-sidebar-active-fg hover:bg-sidebar-active hover:text-sidebar-active-fg',
                        'aria-current': 'page',
                      }}
                    >
                      {({ isActive }) => (
                        <>
                          <span
                            aria-hidden="true"
                            className={cn(
                              'absolute top-1/2 -left-3 h-5 w-0.5 -translate-y-1/2 rounded-r-full bg-accent transition-opacity',
                              isActive ? 'opacity-100' : 'opacity-0',
                            )}
                          />
                          <Icon
                            name={item.icon}
                            className={cn(
                              'h-4 w-4 transition-colors',
                              isActive
                                ? 'text-sidebar-active-fg'
                                : 'text-sidebar-subtle group-hover:text-sidebar-fg-strong',
                            )}
                          />
                          {item.label}
                        </>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </nav>

      <div className="border-t border-sidebar-border px-3 py-3">
        {user ? (
          <Link
            to="/profile"
            onClick={onNavigate}
            className="flex items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-sidebar-hover"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent ring-1 ring-accent/20">
              {initials(user.display_name)}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-sidebar-fg-strong">
                {user.display_name}
              </span>
              <span className="block truncate text-xs text-sidebar-subtle">
                {ROLE_LABELS[user.role]}
              </span>
            </span>
          </Link>
        ) : null}
        {footer ? <div className="mt-2 px-2 text-xs text-sidebar-subtle">{footer}</div> : null}
      </div>
    </aside>
  );
}
