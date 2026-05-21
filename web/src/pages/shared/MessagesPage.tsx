import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import type { Conversation, Message } from '@ferrum-nexus/shared';
import { navigate } from '../../App.js';

export function MessagesPage({ conversationId }: { conversationId?: string }) {
  const queryClient = useQueryClient();
  const [body, setBody] = useState('');
  const conv = useQuery({
    queryKey: ['conversations'],
    queryFn: async () => api<{ conversations: Conversation[] }>('/messages'),
  });
  const messages = useQuery({
    queryKey: ['messages', conversationId],
    enabled: !!conversationId,
    queryFn: async () =>
      api<{ messages: Message[] }>(`/messages/${conversationId}`),
  });
  const send = useMutation({
    mutationFn: async () =>
      api<{ message: Message }>(`/messages/${conversationId}`, { method: 'POST', json: { body } }),
    onSuccess: () => {
      setBody('');
      void queryClient.invalidateQueries({ queryKey: ['messages', conversationId] });
    },
  });

  return (
    <section className="grid grid-cols-1 gap-4 md:grid-cols-[260px_1fr]">
      <aside className="card overflow-hidden">
        <h2 className="mb-2 font-semibold">Conversations</h2>
        {conv.data?.conversations.length === 0 ? (
          <p className="muted text-sm">No conversations yet.</p>
        ) : null}
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {conv.data?.conversations.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className={
                  'w-full px-2 py-2 text-left text-sm ' +
                  (c.id === conversationId
                    ? 'bg-slate-100 dark:bg-slate-800'
                    : 'hover:bg-slate-50 dark:hover:bg-slate-800/60')
                }
                onClick={() => navigate(`/messages/${c.id}`)}
              >
                <div className="font-medium">{c.subject}</div>
                <div className="muted text-xs">{c.type}</div>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <div className="card flex min-h-[400px] flex-col">
        {!conversationId ? (
          <p className="muted">Select a conversation from the list.</p>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto">
              {messages.data?.messages.map((m) => (
                <div key={m.id} className="mb-3">
                  <div className="text-xs text-slate-500">
                    {new Date(m.createdAt).toLocaleString()} · {m.senderId.slice(0, 8)}
                  </div>
                  <div className="whitespace-pre-wrap text-sm">{m.body}</div>
                </div>
              ))}
            </div>
            <form
              className="mt-3 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (body.trim().length > 0) send.mutate();
              }}
            >
              <input
                className="input flex-1"
                placeholder="Type a message…"
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
              <button type="submit" className="btn-primary" disabled={send.isPending}>
                Send
              </button>
            </form>
          </>
        )}
      </div>
    </section>
  );
}
