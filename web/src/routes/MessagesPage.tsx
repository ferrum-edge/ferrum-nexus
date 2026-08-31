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
import { LoadingPanel } from '../components/ui/Spinner';

/** Conversation list. */
export function MessagesPage(): ReactElement {
  const [offset, setOffset] = useState(0);
  const [composeOpen, setComposeOpen] = useState(false);
  const limit = DEFAULT_PAGE_SIZE;
  const query = useThreads({ limit, offset });
  const { user } = useAuth();

  const threads = query.data?.items ?? [];

  return (
    <>
      <PageHeader
        title="Messages"
        description="Conversations with API providers and the portal administrators."
        actions={
          <Button variant="primary" onClick={() => setComposeOpen(true)}>
            New message
          </Button>
        }
      />

      <Card className="overflow-hidden">
        {query.isLoading ? (
          <LoadingPanel label="Loading conversations" />
        ) : threads.length === 0 ? (
          <EmptyState
            icon="mail"
            title="No conversations yet"
            description="Message a provider from an API's catalog page, or contact the portal administrators."
            action={
              <Button variant="primary" onClick={() => setComposeOpen(true)}>
                New message
              </Button>
            }
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
                    className="flex items-center justify-between gap-4 px-5 py-3.5 transition-colors hover:bg-inset"
                  >
                    <span className="min-w-0">
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
                    <span className="shrink-0 text-xs text-fg-subtle">
                      {formatRelative(thread.last_message_at ?? thread.created_at)}
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
