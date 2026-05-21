import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { navigate } from '../../App.js';

export function AdminDashboard() {
  const users = useQuery({
    queryKey: ['admin-users-count'],
    queryFn: async () => api<{ total: number }>('/admin/users', { query: { limit: 1 } }),
  });
  const apis = useQuery({
    queryKey: ['admin-apis-count'],
    queryFn: async () => api<{ total: number }>('/admin/apis', { query: { limit: 1 } }),
  });

  return (
    <section className="space-y-4">
      <h1 className="text-xl font-semibold">Admin</h1>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <button type="button" className="card text-left hover:shadow-md" onClick={() => navigate('/admin/users')}>
          <p className="muted text-xs uppercase">Users</p>
          <p className="text-3xl font-semibold">{users.data?.total ?? '…'}</p>
        </button>
        <button type="button" className="card text-left hover:shadow-md" onClick={() => navigate('/catalog')}>
          <p className="muted text-xs uppercase">APIs</p>
          <p className="text-3xl font-semibold">{apis.data?.total ?? '…'}</p>
        </button>
        <button type="button" className="card text-left hover:shadow-md" onClick={() => navigate('/admin/audit')}>
          <p className="muted text-xs uppercase">Audit log</p>
          <p className="text-3xl font-semibold">→</p>
        </button>
        <button type="button" className="card text-left hover:shadow-md" onClick={() => navigate('/admin/settings')}>
          <p className="muted text-xs uppercase">Settings</p>
          <p className="text-3xl font-semibold">⚙</p>
        </button>
      </div>
      <div className="card">
        <h2 className="font-semibold">Admin actions</h2>
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" className="btn-secondary" onClick={() => navigate('/admin/mass-email')}>
            Mass email
          </button>
          <button type="button" className="btn-secondary" onClick={() => navigate('/admin/drift')}>
            Drift sync
          </button>
          <button type="button" className="btn-secondary" onClick={() => navigate('/admin/audit')}>
            Audit log
          </button>
          <button type="button" className="btn-secondary" onClick={() => navigate('/admin/settings')}>
            Settings & branding
          </button>
        </div>
      </div>
    </section>
  );
}
