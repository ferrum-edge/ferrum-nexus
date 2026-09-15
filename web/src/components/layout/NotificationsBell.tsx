import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useNavigate } from '@tanstack/react-router';
import { useState, type ReactElement } from 'react';
import type { Notification } from '@ferrum-nexus/shared';
import { formatRelative } from '../../lib/format';
import { cn } from '../../lib/cn';
import { useMarkNotificationsRead, useNotifications } from '../../hooks/useNotifications';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
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
            <span className="absolute top-1 right-1 min-w-4 rounded-full bg-accent px-1 text-[0.6rem] leading-4 font-semibold text-accent-fg tabular-nums">
              {unread > 99 ? '99+' : unread}
            </span>
          ) : null}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={8}
          className="fx-pop animate-pop-in z-50 w-[min(22rem,calc(100vw-2rem))] overflow-hidden"
        >
          <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
            <p className="text-sm font-semibold text-fg">Notifications</p>
            {unread > 0 ? (
              <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[0.7rem] font-medium text-accent tabular-nums">
                {unread} unread
              </span>
            ) : (
              <span className="text-xs text-fg-subtle">All caught up</span>
            )}
          </div>

          <div className="max-h-96 overflow-y-auto">
            {items.length === 0 ? (
              <EmptyState
                compact
                icon="bell"
                title="Nothing here yet"
                description="Access decisions, credential changes and new messages land here."
              />
            ) : (
              items.map((notification) => {
                const isUnread = notification.read_at === null;
                return (
                  <DropdownMenu.Item
                    key={notification.id}
                    onSelect={() => openNotification(notification)}
                    className={cn(
                      'flex cursor-pointer gap-2.5 border-b border-border px-4 py-3 outline-none last:border-b-0',
                      'transition-colors data-[highlighted]:bg-surface-hover',
                      isUnread ? 'bg-accent-soft/25' : null,
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full',
                        isUnread ? 'bg-accent' : 'bg-transparent',
                      )}
                    />
                    <span className="min-w-0 flex-1">
                      <span
                        className={cn(
                          'block text-sm',
                          isUnread ? 'font-semibold text-fg' : 'font-medium text-fg-muted',
                        )}
                      >
                        {notification.title}
                      </span>
                      <span
                        className={cn(
                          'mt-0.5 block text-xs leading-relaxed',
                          isUnread ? 'text-fg-muted' : 'text-fg-subtle',
                        )}
                      >
                        {notification.body}
                      </span>
                      <span className="mt-1 block text-[0.7rem] text-fg-subtle">
                        {formatRelative(notification.created_at)}
                      </span>
                    </span>
                  </DropdownMenu.Item>
                );
              })
            )}
          </div>

          <div className="flex items-center justify-end border-t border-border bg-inset/40 px-3 py-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={unread === 0 || markRead.isPending}
              onClick={() => markRead.mutate({ all: true })}
            >
              <Icon name="check" className="h-3.5 w-3.5" />
              Mark all read
            </Button>
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
