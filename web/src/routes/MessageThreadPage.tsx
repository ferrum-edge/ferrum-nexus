import { Link, useParams } from '@tanstack/react-router';
import { useState, type FormEvent, type ReactElement } from 'react';
import { formatDateTime } from '../lib/format';
import { useSendMessage, useThread } from '../hooks/useThreads';
import { useAuth } from '../stores/auth';
import { Button } from '../components/ui/Button';
import { Card, PageHeader } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { Textarea } from '../components/ui/Input';
import { LoadingPanel } from '../components/ui/Spinner';
import { cn } from '../lib/cn';

/** One conversation with its messages and a reply composer. */
export function MessageThreadPage(): ReactElement {
  const params = useParams({ strict: false });
  const threadId = params.threadId ?? '';
  const query = useThread(threadId);
  const send = useSendMessage();
  const { user } = useAuth();
  const [body, setBody] = useState('');

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
          {thread.messages.length === 0 ? (
            <p className="text-sm text-fg-muted">No messages in this conversation yet.</p>
          ) : (
            thread.messages.map((message) => {
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
