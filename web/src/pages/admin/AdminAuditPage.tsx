import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import type { AuditLogEntry } from '@ferrum-nexus/shared';

export function AdminAuditPage() {
  const [action, setAction] = useState('');
  const list = useQuery({
    queryKey: ['audit', action],
    queryFn: async () =>
      api<{ entries: AuditLogEntry[]; total: number }>('/admin/audit-logs', {
        query: { action: action || undefined, limit: 200 },
      }),
  });

  return (
    <section className="space-y-4">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Audit log</h1>
        <input
          className="input max-w-xs"
          placeholder="Filter by action (e.g. access_request.approve)"
          value={action}
          onChange={(e) => setAction(e.target.value)}
        />
      </header>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase muted">
              <th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {list.data?.entries.map((e) => (
              <tr key={e.id} className="border-t border-slate-100 align-top dark:border-slate-800">
                <td className="py-1">{new Date(e.createdAt).toLocaleString()}</td>
                <td>{e.actorEmail ?? '—'}</td>
                <td><code>{e.action}</code></td>
                <td><code>{e.targetType}:{e.targetId ?? '—'}</code></td>
                <td className="max-w-md whitespace-pre-wrap">{e.reason ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
