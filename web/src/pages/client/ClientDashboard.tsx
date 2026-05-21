import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import type { AccessGrant, AccessRequest, CredentialMetadata } from '@ferrum-nexus/shared';
import { navigate } from '../../App.js';

export function ClientDashboard() {
  const requests = useQuery({
    queryKey: ['my-requests'],
    queryFn: async () => api<{ requests: AccessRequest[] }>('/client/requests'),
  });
  const grants = useQuery({
    queryKey: ['my-grants'],
    queryFn: async () => api<{ grants: AccessGrant[] }>('/client/access'),
  });
  const credentials = useQuery({
    queryKey: ['my-credentials'],
    queryFn: async () => api<{ credentials: CredentialMetadata[] }>('/client/credentials'),
  });

  const pending = requests.data?.requests.filter((r) => r.status === 'pending').length ?? 0;
  const active = grants.data?.grants.filter((g) => g.status === 'active').length ?? 0;
  const credentialCount = credentials.data?.credentials.length ?? 0;

  return (
    <section className="space-y-4">
      <h1 className="text-xl font-semibold">Dashboard</h1>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <button type="button" className="card text-left hover:shadow-md" onClick={() => navigate('/client/access')}>
          <p className="muted text-xs uppercase">Active access</p>
          <p className="text-3xl font-semibold">{active}</p>
        </button>
        <button type="button" className="card text-left hover:shadow-md" onClick={() => navigate('/client/access')}>
          <p className="muted text-xs uppercase">Pending requests</p>
          <p className="text-3xl font-semibold">{pending}</p>
        </button>
        <button type="button" className="card text-left hover:shadow-md" onClick={() => navigate('/client/credentials')}>
          <p className="muted text-xs uppercase">Credentials</p>
          <p className="text-3xl font-semibold">{credentialCount}</p>
        </button>
      </div>
      <div className="card">
        <h2 className="font-semibold">Recent requests</h2>
        <table className="mt-2 w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase muted">
              <th className="py-1">API</th>
              <th>Status</th>
              <th>Submitted</th>
              <th>Provider note</th>
            </tr>
          </thead>
          <tbody>
            {requests.data?.requests.slice(0, 10).map((r) => (
              <tr key={r.id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="py-1"><code>{r.apiAssetId.slice(0, 8)}</code></td>
                <td>{r.status}</td>
                <td>{new Date(r.createdAt).toLocaleString()}</td>
                <td>{r.providerReason ?? '—'}</td>
              </tr>
            ))}
            {requests.data && requests.data.requests.length === 0 ? (
              <tr><td colSpan={4} className="muted py-2">No requests yet.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
