import { Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import type { Role } from '@ferrum-nexus/shared';
import { cn } from '../../lib/cn';
import { Icon } from '../ui/Icon';
import { NAV_SECTIONS, navItemsForSection } from './nav';

export interface SidebarProps {
  role: Role | null;
  /** Mobile drawer state; the sidebar is always visible from `lg` up. */
  open: boolean;
  onNavigate: () => void;
  portalName: string;
  logoDataUrl: string | null;
}

/** Role-filtered primary navigation. */
export function Sidebar({
  role,
  open,
  onNavigate,
  portalName,
  logoDataUrl,
}: SidebarProps): ReactElement {
  return (
    <aside
      className={cn(
        'fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-border bg-surface',
        'transition-transform lg:translate-x-0',
        open ? 'translate-x-0' : '-translate-x-full',
      )}
      aria-label="Primary"
    >
      <div className="flex h-14 items-center gap-2.5 border-b border-border px-4">
        {logoDataUrl ? (
          <img src={logoDataUrl} alt="" className="h-7 w-7 rounded-md object-contain" />
        ) : (
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-accent text-sm font-bold text-accent-fg">
            N
          </span>
        )}
        <span className="truncate text-sm font-semibold text-fg">{portalName}</span>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4">
        {NAV_SECTIONS.map((section) => {
          const items = navItemsForSection(role, section.id);
          if (items.length === 0) return null;
          return (
            <div key={section.id} className="mb-5 last:mb-0">
              <p className="px-2 pb-1.5 text-[0.68rem] font-semibold tracking-wider text-fg-subtle uppercase">
                {section.label}
              </p>
              <ul className="flex flex-col gap-0.5">
                {items.map((item) => (
                  <li key={item.to}>
                    <Link
                      to={item.to}
                      activeOptions={{ exact: item.exact ?? false }}
                      onClick={onNavigate}
                      className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-fg-muted transition-colors hover:bg-neutral-soft hover:text-fg"
                      activeProps={{
                        className:
                          'bg-accent-soft text-accent hover:bg-accent-soft hover:text-accent',
                        'aria-current': 'page',
                      }}
                    >
                      <Icon name={item.icon} />
                      {item.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </nav>

      <p className="border-t border-border px-4 py-3 text-xs text-fg-subtle">Ferrum Nexus</p>
    </aside>
  );
}
