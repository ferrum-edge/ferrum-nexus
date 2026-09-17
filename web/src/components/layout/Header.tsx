import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Link, useLocation, useNavigate } from '@tanstack/react-router';
import type { ReactElement, Ref } from 'react';
import { ROLE_LABELS, type User } from '@ferrum-nexus/shared';
import { useAuth } from '../../stores/auth';
import { useTheme } from '../../stores/theme';
import { Icon } from '../ui/Icon';
import { Tooltip } from '../ui/Tooltip';
import { NAV_ITEMS, NAV_SECTIONS } from './nav';
import { NotificationsBell } from './NotificationsBell';
import { initials } from './Sidebar';

const ICON_BUTTON =
  'inline-flex h-9 w-9 items-center justify-center rounded-md text-fg-muted transition-colors ' +
  'hover:bg-neutral-soft hover:text-fg focus-visible:ring-2 focus-visible:ring-accent-ring focus-visible:outline-none';

/** Dark/light switch; `system` collapses into whichever is currently applied. */
export function ThemeToggle(): ReactElement {
  const { resolved, toggle } = useTheme();
  const label = resolved === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  return (
    <Tooltip label={label}>
      <button type="button" onClick={toggle} aria-label={label} className={ICON_BUTTON}>
        <Icon name={resolved === 'dark' ? 'sun' : 'moon'} className="h-[18px] w-[18px]" />
      </button>
    </Tooltip>
  );
}

function UserMenu({ user }: { user: User }): ReactElement {
  const { logout } = useAuth();
  const navigate = useNavigate();

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="flex items-center gap-2 rounded-md py-1 pr-1.5 pl-1 text-sm text-fg transition-colors hover:bg-neutral-soft focus-visible:ring-2 focus-visible:ring-accent-ring focus-visible:outline-none"
          aria-label="Account menu"
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent ring-1 ring-accent/20">
            {initials(user.display_name)}
          </span>
          <span className="hidden max-w-40 truncate font-medium sm:block">{user.display_name}</span>
          <Icon name="chevron-down" className="hidden h-3.5 w-3.5 text-fg-subtle sm:block" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={8}
          className="fx-pop animate-pop-in z-50 w-64 p-1"
        >
          <div className="flex items-center gap-3 border-b border-border px-2.5 py-2.5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-sm font-semibold text-accent ring-1 ring-accent/20">
              {initials(user.display_name)}
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-fg">{user.display_name}</p>
              <p className="truncate text-xs text-fg-muted">{user.email}</p>
              <p className="mt-0.5 text-[0.7rem] font-medium tracking-wide text-accent uppercase">
                {ROLE_LABELS[user.role]}
              </p>
            </div>
          </div>
          <div className="py-1">
            <DropdownMenu.Item asChild>
              <Link
                to="/profile"
                className="flex cursor-pointer items-center gap-2.5 rounded-sm px-2.5 py-2 text-sm text-fg outline-none data-[highlighted]:bg-neutral-soft"
              >
                <Icon name="user" className="text-fg-subtle" />
                Profile
              </Link>
            </DropdownMenu.Item>
            <DropdownMenu.Item
              onSelect={() => {
                void logout().then(() => navigate({ to: '/login' }));
              }}
              className="flex cursor-pointer items-center gap-2.5 rounded-sm px-2.5 py-2 text-sm text-fg outline-none data-[highlighted]:bg-neutral-soft"
            >
              <Icon name="logout" className="text-fg-subtle" />
              Sign out
            </DropdownMenu.Item>
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** "Section › Page" for the current route, from the nav catalog. */
function useLocationCrumbs(): { section: string; page: string } | null {
  const { pathname } = useLocation();
  const item =
    NAV_ITEMS.find((entry) => entry.to === pathname) ??
    [...NAV_ITEMS]
      .filter((entry) => entry.to !== '/' && pathname.startsWith(`${entry.to}/`))
      .sort((a, b) => b.to.length - a.to.length)[0];
  if (!item) return null;
  const section = NAV_SECTIONS.find((entry) => entry.id === item.section);
  return { section: section?.label ?? '', page: item.label };
}

export interface HeaderProps {
  portalName: string;
  sidebarId: string;
  sidebarOpen: boolean;
  sidebarToggleRef: Ref<HTMLButtonElement>;
  onToggleSidebar: () => void;
  user: User;
}

/** Top bar: current location, notifications, theme toggle and the account menu. */
export function Header({
  portalName,
  sidebarId,
  sidebarOpen,
  sidebarToggleRef,
  onToggleSidebar,
  user,
}: HeaderProps): ReactElement {
  const crumbs = useLocationCrumbs();
  return (
    <header className="fx-glass sticky top-0 z-30 flex h-16 items-center justify-between gap-3 border-b border-border px-4 sm:px-6">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          ref={sidebarToggleRef}
          onClick={onToggleSidebar}
          aria-label="Toggle navigation"
          aria-expanded={sidebarOpen}
          aria-controls={sidebarId}
          className={`${ICON_BUTTON} -ml-2 lg:hidden`}
        >
          <Icon name="menu" className="h-5 w-5" />
        </button>
        <span className="truncate text-sm font-semibold text-fg lg:hidden">{portalName}</span>
        {crumbs ? (
          <p className="hidden min-w-0 items-center gap-1.5 text-sm lg:flex">
            <span className="text-fg-subtle">{crumbs.section}</span>
            <Icon name="chevron-right" className="h-3.5 w-3.5 text-fg-subtle" />
            <span className="truncate font-medium text-fg">{crumbs.page}</span>
          </p>
        ) : null}
      </div>
      <div className="flex items-center gap-1">
        <NotificationsBell />
        <ThemeToggle />
        <span className="mx-1.5 hidden h-5 w-px bg-border sm:block" aria-hidden="true" />
        <UserMenu user={user} />
      </div>
    </header>
  );
}
