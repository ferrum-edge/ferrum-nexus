import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { api } from '../lib/api.js';
import type { NotificationItem } from '@ferrum-nexus/shared';
import { useState } from 'react';

interface NotificationsResponse {
  notifications: NotificationItem[];
  unread: number;
}

export function NotificationBell() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const { data } = useQuery({
    queryKey: ['notifications'],
    queryFn: async () => api<NotificationsResponse>('/notifications'),
    refetchInterval: 30_000,
  });

  const markRead = useMutation({
    mutationFn: async (id: string) =>
      api<void>(`/notifications/${id}/read`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });

  return (
    <div className="relative">
      <button
        type="button"
        className="btn-secondary"
        onClick={() => setOpen((v) => !v)}
        aria-label="Notifications"
      >
        <Bell size={16} />
        {data && data.unread > 0 ? (
          <span className="ml-1 rounded bg-brand-600 px-1 text-xs text-white">{data.unread}</span>
        ) : null}
      </button>
      {open ? (
        <div className="absolute right-0 z-20 mt-2 w-96 rounded border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-900">
          <ul className="max-h-96 divide-y divide-slate-100 overflow-y-auto dark:divide-slate-800">
            {data?.notifications.length === 0 ? (
              <li className="muted p-3 text-sm">No notifications yet.</li>
            ) : null}
            {data?.notifications.map((n) => (
              <li key={n.id} className="p-3 text-sm">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-medium">{n.type.replace(/_/g, ' ')}</div>
                    <div className="muted">
                      {summarize(n.payload)} ·{' '}
                      {new Date(n.createdAt).toLocaleString()}
                    </div>
                  </div>
                  {!n.readAt ? (
                    <button
                      type="button"
                      className="btn-secondary text-xs"
                      onClick={() => markRead.mutate(n.id)}
                    >
                      Mark read
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function summarize(payload: Record<string, unknown>): string {
  if (payload.apiTitle) return String(payload.apiTitle);
  if (payload.subject) return String(payload.subject);
  if (payload.label) return String(payload.label);
  return '';
}
