import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState, type ReactElement } from 'react';
import type { Notification } from '@ferrum-nexus/shared';
import { useMarkNotificationsRead, useNotifications } from '../hooks/useNotifications';
import { cn } from '../lib/cn';
import { formatRelative } from '../lib/format';
import { Button } from '../components/ui/Button';
import { Card, PageHeader } from '../components/ui/Card';
import { PaginationBar } from '../components/ui/DataTable';
import { EmptyState } from '../components/ui/EmptyState';
import { Icon } from '../components/ui/Icon';
import { Checkbox } from '../components/ui/Input';
import { LoadingPanel } from '../components/ui/Spinner';

const PAGE_SIZE = 10;

/** All notifications for the signed-in user, including items older than the bell's preview. */
export function NotificationsPage(): ReactElement {
  const [offset, setOffset] = useState(0);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const navigate = useNavigate();
  const query = useNotifications({
    limit: PAGE_SIZE,
    offset,
    ...(unreadOnly ? { unread: true } : {}),
  });
  const markRead = useMarkNotificationsRead();
  const items = query.data?.items ?? [];
  const total = query.data?.total ?? 0;
  const unreadCount = query.data?.unread_count ?? 0;

  // Reading the last item on an unread page can shrink the result below its offset.
  useEffect(() => {
    if (query.data && offset > 0 && offset >= total) {
      setOffset(Math.max(0, Math.ceil(total / PAGE_SIZE) - 1) * PAGE_SIZE);
    }
  }, [offset, query.data, total]);

  const openNotification = (notification: Notification): void => {
    markRead.mutate({ ids: [notification.id] });
    if (notification.link) {
      // Notification links come from the server and are runtime routes.
      void navigate({ href: notification.link });
    }
  };

  return (
    <>
      <PageHeader
        title="Notifications"
        description="Browse your updates and open the ones that need your attention."
        actions={
          <Button
            size="sm"
            variant="secondary"
            disabled={unreadCount === 0 || markRead.isPending}
            onClick={() => markRead.mutate({ all: true })}
          >
            <Icon name="check" className="h-3.5 w-3.5" />
            Mark all read
          </Button>
        }
      />
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
          <Checkbox
            label="Unread only"
            checked={unreadOnly}
            onChange={(event) => {
              setUnreadOnly(event.target.checked);
              setOffset(0);
            }}
          />
          <span className="text-xs text-fg-muted tabular-nums">{unreadCount} unread</span>
        </div>
        {query.isLoading ? (
          <LoadingPanel label="Loading notifications" />
        ) : items.length === 0 ? (
          <EmptyState
            icon="bell"
            title={unreadOnly ? 'No unread notifications' : 'Nothing here yet'}
            description={
              unreadOnly
                ? 'You are all caught up.'
                : 'Access decisions, credential changes and new messages land here.'
            }
          />
        ) : (
          <ul>
            {items.map((notification) => {
              const isUnread = notification.read_at === null;
              return (
                <li key={notification.id} className="border-b border-border last:border-b-0">
                  <button
                    type="button"
                    disabled={markRead.isPending}
                    onClick={() => openNotification(notification)}
                    className={cn(
                      'flex w-full items-start gap-3 px-4 py-4 text-left transition-colors sm:px-5',
                      'hover:bg-surface-hover focus-visible:bg-accent-soft/40 focus-visible:outline-none',
                      isUnread ? 'bg-accent-soft/25' : null,
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        'mt-1.5 h-2 w-2 shrink-0 rounded-full',
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
                      <span className="mt-1 block text-sm leading-relaxed text-fg-muted">
                        {notification.body}
                      </span>
                      <span className="mt-2 block text-xs text-fg-subtle">
                        {formatRelative(notification.created_at)}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs font-medium text-accent">
                      {notification.link ? 'Open' : isUnread ? 'Mark read' : 'Read'}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {total > PAGE_SIZE ? (
          <PaginationBar
            offset={offset}
            limit={PAGE_SIZE}
            total={total}
            onOffsetChange={setOffset}
          />
        ) : null}
      </Card>
    </>
  );
}
