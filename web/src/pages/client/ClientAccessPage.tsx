import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import type { AccessGrant, AccessRequest } from '@ferrum-nexus/shared';

export function ClientAccessPage() {
  const requests = useQuery({
    queryKey: ['my-requests'],
    queryFn: async () => api<{ requests: AccessRequest[] }>('/client/requests'),
  });
  const grants = useQuery({
    queryKey: ['my-grants'],
    queryFn: async () => api<{ grants: AccessGrant[] }>('/client/access'),
  });

  return (
    <section className="space-y-4">
      <h1 className="text-xl font-semibold">My access</h1>
      <div className="card">
        <h2 className="font-semibold">Active grants</h2>
        <table className="mt-2 w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase muted">
              <th>API</th><th>Granted</th><th>Status</th><th>Revoked reason</th>
            </tr>
          </thead>
          <tbody>
            {grants.data?.grants.map((g) => (
              <tr key={g.id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="py-1"><code>{g.apiAssetId.slice(0, 8)}</code></td>
                <td>{new Date(g.approvedAt).toLocaleString()}</td>
                <td>{g.status}</td>
                <td>{g.revokedReason ?? '—'}</td>
              </tr>
            ))}
            {grants.data && grants.data.grants.length === 0 ? (
              <tr><td colSpan={4} className="muted py-2">No grants yet.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <div className="card">
        <h2 className="font-semibold">Requests</h2>
        <table className="mt-2 w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase muted">
              <th>API</th><th>Justification</th><th>Status</th><th>Submitted</th><th>Note</th>
            </tr>
          </thead>
          <tbody>
            {requests.data?.requests.map((r) => (
              <tr key={r.id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="py-1"><code>{r.apiAssetId.slice(0, 8)}</code></td>
                <td className="max-w-md truncate">{r.justification}</td>
                <td>{r.status}</td>
                <td>{new Date(r.createdAt).toLocaleString()}</td>
                <td>{r.providerReason ?? '—'}</td>
              </tr>
            ))}
            {requests.data && requests.data.requests.length === 0 ? (
              <tr><td colSpan={5} className="muted py-2">No requests yet.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
