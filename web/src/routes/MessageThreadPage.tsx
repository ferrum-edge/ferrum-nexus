import { Link, useParams } from '@tanstack/react-router';
import { useEffect, useState, type FormEvent, type ReactElement } from 'react';
import type { Message, MessagePage } from '@ferrum-nexus/shared';
import { formatDateTime } from '../lib/format';
import { useOlderMessages, useSendMessage, useThread } from '../hooks/useThreads';
import { useAuth } from '../stores/auth';
import { Button } from '../components/ui/Button';
import { Card, PageHeader } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { Textarea } from '../components/ui/Input';
import { LoadingPanel } from '../components/ui/Spinner';
import { cn } from '../lib/cn';

/**
 * Fold `incoming` into `current`, de-duplicated by id and back in reading order.
 *
 * The page accumulates rather than replaces because the two sources overlap and
 * move: the newest window slides forward every time somebody replies, and the
 * older windows are fetched one cursor at a time. Merging by id keeps a message
 * that has just fallen out of the newest window on screen instead of leaving a
 * hole in the transcript. Equal timestamps tie-break on id, the same total
 * order the server pages by.
 */
export function mergeMessages(current: Message[], incoming: Message[]): Message[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => {
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
    if (a.id === b.id) return 0;
    return a.id < b.id ? -1 : 1;
  });
}

/** Where the next "Load older" request should start. */
export interface ThreadPageCursors {
  /** Cursor from the live newest window; moves forward as replies arrive. */
  headCursor: string | null;
  /** When a refetched newest window skips held messages, walk backwards from here first. */
  headGapCursor: string | null;
  /** Cursor from windows the reader has already paged backwards through. */
  olderCursor: string | null;
}

export function initialThreadPageCursors(): ThreadPageCursors {
  return { headCursor: null, headGapCursor: null, olderCursor: null };
}

/** Pick the cursor the load-older button should use. */
export function loadOlderCursor(cursors: ThreadPageCursors): string | null {
  return cursors.headGapCursor ?? cursors.olderCursor ?? cursors.headCursor;
}

/**
 * Fold a refetched newest window into the cursor state.
 *
 * The live query's `next_before` always describes that window. Adopting it once
 * was wrong: when more than a page of replies lands mid-session the refetched
 * window starts newer than the retained cursor and the messages in between
 * become unreachable. Overlap means the head still connects; a non-overlapping
 * refetch opens a gap that must be closed before tail pagination continues.
 */
export function adoptNewestPageCursors(
  cursors: ThreadPageCursors,
  heldBeforeMerge: Message[],
  page: Pick<MessagePage, 'items' | 'next_before'>,
): ThreadPageCursors {
  const overlaps =
    heldBeforeMerge.length === 0 ||
    page.items.some((message) => heldBeforeMerge.some((held) => held.id === message.id));

  return {
    headCursor: page.next_before,
    headGapCursor:
      !overlaps && heldBeforeMerge.length > 0 && page.items.length > 0 ? page.next_before : null,
    olderCursor: cursors.olderCursor,
  };
}

/** Fold one manually fetched older window into the cursor state. */
export function adoptOlderPageCursors(
  cursors: ThreadPageCursors,
  heldBeforeMerge: Message[],
  page: Pick<MessagePage, 'items' | 'next_before'>,
): ThreadPageCursors {
  if (!cursors.headGapCursor) {
    return { ...cursors, olderCursor: page.next_before };
  }

  const closesGap = page.items.some((message) =>
    heldBeforeMerge.some((held) => held.id === message.id),
  );
  if (closesGap) {
    return {
      headCursor: cursors.headCursor,
      headGapCursor: null,
      olderCursor: page.next_before,
    };
  }

  return { ...cursors, headGapCursor: page.next_before };
}

/** One conversation with its messages and a reply composer. */
export function MessageThreadPage(): ReactElement {
  const params = useParams({ strict: false });
  const threadId = params.threadId ?? '';
  const query = useThread(threadId);
  const send = useSendMessage();
  const loadOlder = useOlderMessages();
  const { user } = useAuth();
  const [body, setBody] = useState('');

  // Everything fetched so far, and where the next older window starts.
  const [messages, setMessages] = useState<Message[]>([]);
  const [cursors, setCursors] = useState<ThreadPageCursors>(initialThreadPageCursors);

  useEffect(() => {
    setMessages([]);
    setCursors(initialThreadPageCursors());
  }, [threadId]);

  useEffect(() => {
    const page = query.data?.messages;
    if (!page) return;
    setMessages((current) => {
      setCursors((previous) => adoptNewestPageCursors(previous, current, page));
      return mergeMessages(current, page.items);
    });
  }, [query.data]);

  if (query.isLoading) return <LoadingPanel label="Loading conversation" />;
  if (query.isError || !query.data) {
    return (
      <Card>
        <EmptyState
          icon="alert"
          title="Conversation not found"
          description="It may have been removed, or you may not be a participant."
          action={
            <Link to="/messages" className="text-sm text-accent hover:underline">
              Back to messages
            </Link>
          }
        />
      </Card>
    );
  }

  const thread = query.data;
  const counterpart = thread.participants?.find((participant) => participant.id !== user?.id);

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const trimmed = body.trim();
    if (!trimmed) return;
    send.mutate({ id: thread.id, body: { body: trimmed } }, { onSuccess: () => setBody('') });
  };

  const nextBefore = loadOlderCursor(cursors);

  const older = (): void => {
    if (!nextBefore) return;
    loadOlder.mutate(
      { id: thread.id, before: nextBefore },
      {
        onSuccess: (page) => {
          setMessages((current) => {
            setCursors((previous) => adoptOlderPageCursors(previous, current, page));
            return mergeMessages(current, page.items);
          });
        },
      },
    );
  };

  return (
    <>
      <PageHeader
        title={thread.subject}
        description={
          <>
            {counterpart ? counterpart.display_name : 'Portal administrators'}
            {thread.api ? ` · ${thread.api.name}` : ''}
          </>
        }
        actions={
          <Link to="/messages" className="text-sm text-accent hover:underline">
            All conversations
          </Link>
        }
      />

      <Card className="flex flex-col overflow-hidden">
        <div className="flex flex-col gap-4 px-5 py-5">
          {nextBefore ? (
            <div className="flex flex-col items-center gap-1">
              <Button type="button" variant="ghost" loading={loadOlder.isPending} onClick={older}>
                Load older messages
              </Button>
              <span className="text-xs text-fg-subtle">
                Showing {messages.length} of {thread.messages.total} messages
              </span>
            </div>
          ) : null}

          {messages.length === 0 ? (
            <p className="text-sm text-fg-muted">No messages in this conversation yet.</p>
          ) : (
            messages.map((message) => {
              const mine = message.sender_user_id === user?.id;
              return (
                <div
                  key={message.id}
                  className={cn('flex flex-col gap-1', mine ? 'items-end' : 'items-start')}
                >
                  <span className="text-xs text-fg-subtle">
                    {mine ? 'You' : (message.sender?.display_name ?? 'Participant')} ·{' '}
                    {formatDateTime(message.created_at)}
                  </span>
                  <p
                    className={cn(
                      'max-w-[42rem] rounded-lg px-3.5 py-2.5 text-sm whitespace-pre-line',
                      mine ? 'bg-accent-soft text-fg' : 'bg-inset text-fg',
                    )}
                  >
                    {message.body}
                  </p>
                </div>
              );
            })
          )}
        </div>

        <form className="flex flex-col gap-2 border-t border-border px-5 py-4" onSubmit={submit}>
          <label htmlFor="reply-body" className="text-sm font-medium text-fg">
            Reply
          </label>
          <Textarea
            id="reply-body"
            rows={4}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder="Write a reply…"
          />
          <div className="flex justify-end">
            <Button
              type="submit"
              variant="primary"
              loading={send.isPending}
              disabled={body.trim().length === 0}
            >
              Send reply
            </Button>
          </div>
        </form>
      </Card>
    </>
  );
}
