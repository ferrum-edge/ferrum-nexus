import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import type { AccessRequest, ApiAssetWithProvider } from '@ferrum-nexus/shared';
import { navigate } from '../../App.js';

export function ProviderDashboard() {
  const apis = useQuery({
    queryKey: ['provider-apis'],
    queryFn: async () => api<{ items: ApiAssetWithProvider[]; total: number }>('/provider/apis'),
  });
  const requests = useQuery({
    queryKey: ['provider-requests'],
    queryFn: async () =>
      api<{ requests: AccessRequest[] }>('/provider/access-requests', {
        query: { status: 'pending' },
      }),
  });

  return (
    <section className="space-y-4">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Provider dashboard</h1>
        <button type="button" className="btn-primary" onClick={() => navigate('/provider/publish')}>
          Publish API
        </button>
      </header>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <button type="button" className="card text-left hover:shadow-md" onClick={() => navigate('/provider/apis')}>
          <p className="muted text-xs uppercase">My APIs</p>
          <p className="text-3xl font-semibold">{apis.data?.total ?? 0}</p>
        </button>
        <button type="button" className="card text-left hover:shadow-md" onClick={() => navigate('/provider/requests')}>
          <p className="muted text-xs uppercase">Pending requests</p>
          <p className="text-3xl font-semibold">{requests.data?.requests.length ?? 0}</p>
        </button>
        <button type="button" className="card text-left hover:shadow-md" onClick={() => navigate('/messages')}>
          <p className="muted text-xs uppercase">Messages</p>
          <p className="text-3xl font-semibold">→</p>
        </button>
      </div>
    </section>
  );
}
