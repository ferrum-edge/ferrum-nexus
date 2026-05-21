import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import type { CredentialMetadata, CredentialType } from '@ferrum-nexus/shared';

interface ListResp {
  credentials: CredentialMetadata[];
}

interface IssueResp {
  credential: CredentialMetadata;
  secret?: {
    type: CredentialType;
    field: string;
    value: string;
    fields?: Array<{ field: string; value: string }>;
  };
}

export function ClientCredentialsPage() {
  const queryClient = useQueryClient();
  const credentials = useQuery({
    queryKey: ['my-credentials'],
    queryFn: async () => api<ListResp>('/client/credentials'),
  });
  const [showSecret, setShowSecret] = useState<IssueResp['secret'] | null>(null);

  const issue = useMutation({
    mutationFn: async (input: { type: CredentialType; label: string }) =>
      api<IssueResp>('/client/credentials', {
        method: 'POST',
        json: { ...input },
      }),
    onSuccess: (data) => {
      if (data.secret) setShowSecret(data.secret);
      void queryClient.invalidateQueries({ queryKey: ['my-credentials'] });
    },
  });

  const rotate = useMutation({
    mutationFn: async (id: string) =>
      api<IssueResp>(`/client/credentials/${id}/rotate`, { method: 'POST' }),
    onSuccess: (data) => {
      if (data.secret) setShowSecret(data.secret);
      void queryClient.invalidateQueries({ queryKey: ['my-credentials'] });
    },
  });

  const finalize = useMutation({
    mutationFn: async (id: string) =>
      api<void>(`/client/credentials/${id}/finalize`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['my-credentials'] }),
  });

  const [label, setLabel] = useState('Default');
  const [type, setType] = useState<CredentialType>('keyauth');

  return (
    <section className="space-y-4">
      <h1 className="text-xl font-semibold">Credentials</h1>
      {showSecret ? (
        <div className="card border-amber-500/30 bg-amber-50/40 dark:bg-amber-900/10">
          <h2 className="font-semibold">New {showSecret.type} credential</h2>
          <p className="muted mt-1 text-sm">
            This is the only time we'll show you this value. Copy it now.
          </p>
          <pre className="mt-2 overflow-x-auto rounded bg-slate-900 p-2 text-xs text-white">
            {(showSecret.fields ?? [{ field: showSecret.field, value: showSecret.value }])
              .map((item) => `${item.field}=${item.value}`)
              .join('\n')}
          </pre>
          <button type="button" className="btn-secondary mt-2" onClick={() => setShowSecret(null)}>
            I've copied it
          </button>
        </div>
      ) : null}
      <div className="card">
        <h2 className="font-semibold">Create credential</h2>
        <div className="mt-2 flex flex-wrap gap-2">
          <select
            className="input max-w-xs"
            value={type}
            onChange={(e) => setType(e.target.value as CredentialType)}
          >
            <option value="keyauth">API Key</option>
            <option value="basicauth">Basic Auth</option>
            <option value="hmac_auth">HMAC</option>
          </select>
          <input
            className="input max-w-xs"
            placeholder="Label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <button
            type="button"
            className="btn-primary"
            disabled={issue.isPending}
            onClick={() => issue.mutate({ type, label })}
          >
            {issue.isPending ? 'Creating…' : 'Create'}
          </button>
        </div>
        <p className="muted mt-2 text-xs">
          JWT and mTLS credentials require additional input — use a provider's API or admin tools.
        </p>
      </div>
      <div className="card">
        <h2 className="font-semibold">My credentials</h2>
        <table className="mt-2 w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase muted">
              <th>Type</th><th>Label</th><th>Last 4</th><th>Status</th><th>Created</th><th></th>
            </tr>
          </thead>
          <tbody>
            {credentials.data?.credentials.map((c) => (
              <tr key={c.id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="py-1">{c.type}</td>
                <td>{c.label}</td>
                <td>{c.last4 ?? '—'}</td>
                <td>{c.status}</td>
                <td>{new Date(c.createdAt).toLocaleString()}</td>
                <td className="space-x-2 text-right">
                  {c.status === 'active' && (c.type === 'keyauth' || c.type === 'basicauth' || c.type === 'hmac_auth') ? (
                    <button type="button" className="btn-secondary" onClick={() => rotate.mutate(c.id)}>
                      Rotate
                    </button>
                  ) : null}
                  {c.status === 'pending_removal' ? (
                    <button type="button" className="btn-danger" onClick={() => finalize.mutate(c.id)}>
                      Remove old
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
            {credentials.data && credentials.data.credentials.length === 0 ? (
              <tr><td colSpan={6} className="muted py-2">No credentials yet.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
