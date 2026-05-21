import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api.js';

export function AdminMassEmailPage() {
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [audience, setAudience] = useState<'all_users' | 'clients' | 'providers' | 'pending_clients' | 'api_clients'>('all_users');
  const [apiAssetId, setApiAssetId] = useState('');
  const [result, setResult] = useState<{ queued: number } | null>(null);
  const list = useQuery({
    queryKey: ['mass-email-history'],
    queryFn: async () =>
      api<{ campaigns: Array<{ id: string; subject: string; sent_count: number; status: string; created_at: string }> }>(
        '/admin/mass-email',
      ),
  });
  const send = useMutation({
    mutationFn: async () =>
      api<{ queued: number; campaignId: string }>('/admin/mass-email', {
        method: 'POST',
        json: { subject, body, filter: { audience, apiAssetId: audience === 'api_clients' ? apiAssetId : undefined } },
      }),
    onSuccess: (data) => {
      setResult({ queued: data.queued });
      void list.refetch();
    },
  });
  return (
    <section className="space-y-4">
      <h1 className="text-xl font-semibold">Mass email</h1>
      <div className="card space-y-3">
        <div>
          <label className="label">Audience</label>
          <select
            className="input"
            value={audience}
            onChange={(e) =>
              setAudience(e.target.value as 'all_users' | 'clients' | 'providers' | 'pending_clients' | 'api_clients')
            }
          >
            <option value="all_users">All users</option>
            <option value="clients">All clients</option>
            <option value="providers">All providers</option>
            <option value="pending_clients">Pending clients</option>
            <option value="api_clients">Clients with access to API</option>
          </select>
        </div>
        {audience === 'api_clients' ? (
          <div>
            <label className="label">API asset id</label>
            <input className="input" value={apiAssetId} onChange={(e) => setApiAssetId(e.target.value)} />
          </div>
        ) : null}
        <div>
          <label className="label">Subject</label>
          <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} />
        </div>
        <div>
          <label className="label">Body</label>
          <textarea className="input min-h-[200px]" value={body} onChange={(e) => setBody(e.target.value)} />
        </div>
        <button
          type="button"
          className="btn-primary"
          disabled={!subject || !body || send.isPending}
          onClick={() => {
            if (confirm('Send this mass email?')) send.mutate();
          }}
        >
          {send.isPending ? 'Queueing…' : 'Send'}
        </button>
        {result ? <p className="muted text-sm">Queued {result.queued} recipients.</p> : null}
      </div>

      <div className="card">
        <h2 className="font-semibold">Recent campaigns</h2>
        <table className="mt-2 w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase muted">
              <th>Subject</th><th>Status</th><th>Sent</th><th>Created</th>
            </tr>
          </thead>
          <tbody>
            {list.data?.campaigns.map((c) => (
              <tr key={c.id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="py-1">{c.subject}</td>
                <td>{c.status}</td>
                <td>{c.sent_count}</td>
                <td>{new Date(c.created_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
