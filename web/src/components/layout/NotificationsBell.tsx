import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useNavigate } from '@tanstack/react-router';
import { useState, type ReactElement } from 'react';
import type { Notification } from '@ferrum-nexus/shared';
import { formatRelative } from '../../lib/format';
import { useMarkNotificationsRead, useNotifications } from '../../hooks/useNotifications';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';

/** Header bell: unread badge plus a dropdown of the latest notifications. */
export function NotificationsBell(): ReactElement {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { data } = useNotifications({ limit: 10 });
  const markRead = useMarkNotificationsRead();

  const unread = data?.unread_count ?? 0;
  const items: Notification[] = data?.items ?? [];

  const openNotification = (notification: Notification): void => {
    markRead.mutate({ ids: [notification.id] });
    setOpen(false);
    if (notification.link) {
      // The link is a runtime string from the server, so it goes through
      // `href` rather than the statically typed `to`.
      void navigate({ href: notification.link });
    }
  };

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="relative inline-flex h-9 w-9 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-neutral-soft hover:text-fg"
          aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        >
          <Icon name="bell" className="h-5 w-5" />
          {unread > 0 ? (
            <span className="absolute top-1 right-1 min-w-4 rounded-full bg-accent px-1 text-[0.6rem] leading-4 font-semibold text-accent-fg">
              {unread > 99 ? '99+' : unread}
            </span>
          ) : null}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={8}
          className="fx-pop z-50 w-[min(22rem,calc(100vw-2rem))] overflow-hidden"
        >
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
            <p className="text-sm font-semibold text-fg">Notifications</p>
            <Button
              size="sm"
              variant="link"
              disabled={unread === 0 || markRead.isPending}
              onClick={() => markRead.mutate({ all: true })}
            >
              Mark all read
            </Button>
          </div>
          <div className="max-h-96 overflow-y-auto">
            {items.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-fg-muted">Nothing here yet.</p>
            ) : (
              items.map((notification) => (
                <DropdownMenu.Item
                  key={notification.id}
                  onSelect={() => openNotification(notification)}
                  className="flex cursor-pointer flex-col gap-0.5 border-b border-border px-3 py-2.5 outline-none last:border-b-0 data-[highlighted]:bg-inset"
                >
                  <span className="flex items-center gap-2 text-sm font-medium text-fg">
                    {notification.read_at === null ? (
                      <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />
                    ) : null}
                    {notification.title}
                  </span>
                  <span className="text-xs text-fg-muted">{notification.body}</span>
                  <span className="text-xs text-fg-subtle">
                    {formatRelative(notification.created_at)}
                  </span>
                </DropdownMenu.Item>
              ))
            )}
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
