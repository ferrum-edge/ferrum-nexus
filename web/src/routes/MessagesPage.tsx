import { Link } from '@tanstack/react-router';
import { useState, type ReactElement } from 'react';
import { DEFAULT_PAGE_SIZE } from '@ferrum-nexus/shared';
import { formatRelative, truncate } from '../lib/format';
import { useThreads } from '../hooks/useThreads';
import { useAuth } from '../stores/auth';
import { StartThreadDialog } from '../components/messaging/StartThreadDialog';
import { Button } from '../components/ui/Button';
import { Card, PageHeader } from '../components/ui/Card';
import { PaginationBar } from '../components/ui/DataTable';
import { EmptyState } from '../components/ui/EmptyState';
import { Icon } from '../components/ui/Icon';
import { LoadingPanel } from '../components/ui/Spinner';

/** Initials for a counterpart tile: first letters of up to two words. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] ?? ''}${parts[parts.length - 1]![0] ?? ''}`.toUpperCase();
}

/** Conversation list. */
export function MessagesPage(): ReactElement {
  const [offset, setOffset] = useState(0);
  const [composeOpen, setComposeOpen] = useState(false);
  const limit = DEFAULT_PAGE_SIZE;
  const query = useThreads({ limit, offset });
  const { user } = useAuth();

  const threads = query.data?.items ?? [];

  const compose = (
    <Button variant="primary" onClick={() => setComposeOpen(true)}>
      <Icon name="plus" className="h-4 w-4" />
      New message
    </Button>
  );

  return (
    <>
      <PageHeader
        title="Messages"
        description="Conversations with API providers and the portal administrators."
        actions={compose}
      />

      <Card className="overflow-hidden">
        {query.isLoading ? (
          <LoadingPanel label="Loading conversations" />
        ) : threads.length === 0 ? (
          <EmptyState
            icon="mail"
            title="No conversations yet"
            description="Message a provider from an API's catalog page, or contact the portal administrators."
            action={compose}
          />
        ) : (
          <ul>
            {threads.map((thread) => {
              const counterpart = thread.participants?.find(
                (participant) => participant.id !== user?.id,
              );
              return (
                <li key={thread.id} className="border-b border-border last:border-b-0">
                  <Link
                    to="/messages/$threadId"
                    params={{ threadId: thread.id }}
                    className="group flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-surface-hover sm:gap-3.5 sm:px-5"
                  >
                    {counterpart ? (
                      <span
                        aria-hidden="true"
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent ring-1 ring-accent/20"
                      >
                        {initials(counterpart.display_name)}
                      </span>
                    ) : (
                      <span
                        aria-hidden="true"
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-info-soft text-info ring-1 ring-info/20"
                      >
                        <Icon name="building" className="h-4 w-4" />
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-fg">
                        {thread.subject}
                      </span>
                      <span className="block truncate text-xs text-fg-muted">
                        {counterpart?.display_name ?? 'Portal administrators'}
                        {thread.api ? ` · ${thread.api.name}` : ''}
                      </span>
                      {thread.last_message_preview ? (
                        <span className="mt-0.5 block truncate text-xs text-fg-subtle">
                          {truncate(thread.last_message_preview, 120)}
                        </span>
                      ) : null}
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <span className="text-xs text-fg-subtle tabular-nums">
                        {formatRelative(thread.last_message_at ?? thread.created_at)}
                      </span>
                      <Icon
                        name="chevron-right"
                        className="hidden h-4 w-4 text-fg-subtle opacity-0 transition-opacity group-hover:opacity-100 sm:block"
                      />
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
        {(query.data?.total ?? 0) > limit ? (
          <PaginationBar
            offset={offset}
            limit={limit}
            total={query.data?.total ?? 0}
            onOffsetChange={setOffset}
          />
        ) : null}
      </Card>

      <StartThreadDialog
        open={composeOpen}
        onOpenChange={setComposeOpen}
        recipientLabel="the portal administrators"
      />
    </>
  );
}
