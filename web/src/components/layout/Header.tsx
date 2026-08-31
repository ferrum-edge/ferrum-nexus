import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Link, useNavigate } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { ROLE_LABELS, type User } from '@ferrum-nexus/shared';
import { useAuth } from '../../stores/auth';
import { useTheme } from '../../stores/theme';
import { Icon } from '../ui/Icon';
import { NotificationsBell } from './NotificationsBell';

/** Dark/light switch; `system` collapses into whichever is currently applied. */
export function ThemeToggle(): ReactElement {
  const { resolved, toggle } = useTheme();
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={resolved === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      className="inline-flex h-9 w-9 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-neutral-soft hover:text-fg"
    >
      <Icon name={resolved === 'dark' ? 'sun' : 'moon'} className="h-5 w-5" />
    </button>
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
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-fg transition-colors hover:bg-neutral-soft"
          aria-label="Account menu"
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent">
            {user.display_name.slice(0, 2).toUpperCase()}
          </span>
          <span className="hidden max-w-40 truncate sm:block">{user.display_name}</span>
          <Icon name="chevron-down" className="hidden h-3.5 w-3.5 text-fg-subtle sm:block" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={8} className="fx-pop z-50 w-60 p-1">
          <div className="border-b border-border px-2.5 py-2">
            <p className="truncate text-sm font-medium text-fg">{user.display_name}</p>
            <p className="truncate text-xs text-fg-muted">{user.email}</p>
            <p className="mt-1 text-xs text-fg-subtle">{ROLE_LABELS[user.role]}</p>
          </div>
          <DropdownMenu.Item asChild>
            <Link
              to="/profile"
              className="flex cursor-pointer items-center gap-2 rounded-sm px-2.5 py-2 text-sm text-fg outline-none data-[highlighted]:bg-inset"
            >
              <Icon name="user" />
              Profile
            </Link>
          </DropdownMenu.Item>
          <DropdownMenu.Item
            onSelect={() => {
              void logout().then(() => navigate({ to: '/login' }));
            }}
            className="flex cursor-pointer items-center gap-2 rounded-sm px-2.5 py-2 text-sm text-fg outline-none data-[highlighted]:bg-inset"
          >
            <Icon name="logout" />
            Sign out
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export interface HeaderProps {
  portalName: string;
  onToggleSidebar: () => void;
  user: User;
}

/** Top bar: branding, notifications, theme toggle and the account menu. */
export function Header({ portalName, onToggleSidebar, user }: HeaderProps): ReactElement {
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b border-border bg-surface/95 px-4 backdrop-blur">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={onToggleSidebar}
          aria-label="Toggle navigation"
          className="inline-flex h-9 w-9 items-center justify-center rounded-md text-fg-muted hover:bg-neutral-soft hover:text-fg lg:hidden"
        >
          <Icon name="menu" className="h-5 w-5" />
        </button>
        <span className="truncate text-sm font-medium text-fg-muted">{portalName}</span>
      </div>
      <div className="flex items-center gap-1">
        <NotificationsBell />
        <ThemeToggle />
        <UserMenu user={user} />
      </div>
    </header>
  );
}
