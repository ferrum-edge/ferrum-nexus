import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import type { AccessRequest } from '@ferrum-nexus/shared';

type ReviewState = { id: string; reason: string };

export function ProviderRequestsPage() {
  const queryClient = useQueryClient();
  const [denyState, setDenyState] = useState<ReviewState | null>(null);
  const requests = useQuery({
    queryKey: ['provider-requests-all'],
    queryFn: async () => api<{ requests: AccessRequest[] }>('/provider/access-requests'),
  });

  const approve = useMutation({
    mutationFn: async (id: string) =>
      api(`/provider/access-requests/${id}/approve`, { method: 'POST', json: {} }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['provider-requests-all'] }),
  });

  const deny = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) =>
      api(`/provider/access-requests/${id}/deny`, {
        method: 'POST',
        json: { providerReason: reason },
      }),
    onSuccess: () => {
      setDenyState(null);
      void queryClient.invalidateQueries({ queryKey: ['provider-requests-all'] });
    },
  });

  return (
    <section className="space-y-4">
      <h1 className="text-xl font-semibold">Access requests</h1>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase muted">
              <th>API</th><th>Client</th><th>Justification</th><th>Status</th><th>Submitted</th><th></th>
            </tr>
          </thead>
          <tbody>
            {requests.data?.requests.map((r) => (
              <tr key={r.id} className="border-t border-slate-100 dark:border-slate-800 align-top">
                <td className="py-1"><code>{r.apiAssetId.slice(0, 8)}</code></td>
                <td><code>{r.clientUserId.slice(0, 8)}</code></td>
                <td className="max-w-md whitespace-pre-wrap">{r.justification}</td>
                <td>{r.status}</td>
                <td>{new Date(r.createdAt).toLocaleString()}</td>
                <td>
                  {r.status === 'pending' ? (
                    <div className="flex justify-end gap-2">
                      <button type="button" className="btn-primary" onClick={() => approve.mutate(r.id)}>
                        Approve
                      </button>
                      <button
                        type="button"
                        className="btn-danger"
                        onClick={() => setDenyState({ id: r.id, reason: '' })}
                      >
                        Deny
                      </button>
                    </div>
                  ) : null}
                </td>
              </tr>
            ))}
            {requests.data && requests.data.requests.length === 0 ? (
              <tr><td colSpan={6} className="muted py-2">No requests yet.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {denyState ? (
        <div className="card">
          <h2 className="font-semibold">Deny with reason</h2>
          <textarea
            className="input mt-2"
            value={denyState.reason}
            onChange={(e) => setDenyState({ ...denyState, reason: e.target.value })}
          />
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={() => setDenyState(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-danger"
              disabled={denyState.reason.length === 0 || deny.isPending}
              onClick={() => deny.mutate(denyState)}
            >
              {deny.isPending ? 'Denying…' : 'Deny'}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
