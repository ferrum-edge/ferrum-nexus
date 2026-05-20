import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import type { ApiAssetWithProvider } from '@ferrum-nexus/shared';
import { navigate } from '../../App.js';

export function ProviderApisPage() {
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: ['provider-apis'],
    queryFn: async () => api<{ items: ApiAssetWithProvider[]; total: number }>('/provider/apis'),
  });
  const remove = useMutation({
    mutationFn: async (id: string) => api<void>(`/provider/apis/${id}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['provider-apis'] }),
  });
  const toggleRequestable = useMutation({
    mutationFn: async (asset: ApiAssetWithProvider) =>
      api<{ asset: ApiAssetWithProvider }>(`/provider/apis/${asset.id}/settings`, {
        method: 'PUT',
        json: { requestable: !asset.requestable },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['provider-apis'] }),
  });

  return (
    <section className="space-y-4">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">My APIs</h1>
        <button type="button" className="btn-primary" onClick={() => navigate('/provider/publish')}>
          Publish API
        </button>
      </header>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase muted">
              <th>Title</th><th>Version</th><th>Lifecycle</th><th>Visibility</th><th>Requestable</th><th>Operations</th><th></th>
            </tr>
          </thead>
          <tbody>
            {list.data?.items.map((a) => (
              <tr key={a.id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="py-1">
                  <button type="button" className="hover:underline" onClick={() => navigate(`/apis/${a.id}`)}>
                    {a.title}
                  </button>
                </td>
                <td>{a.version}</td>
                <td>{a.lifecycle}</td>
                <td>{a.visibility}</td>
                <td>
                  <button
                    type="button"
                    className={a.requestable ? 'tag bg-emerald-100 dark:bg-emerald-900/40' : 'tag'}
                    onClick={() => toggleRequestable.mutate(a)}
                  >
                    {a.requestable ? 'Yes' : 'No'}
                  </button>
                </td>
                <td>{a.operationCount}</td>
                <td className="text-right">
                  <button
                    type="button"
                    className="btn-danger"
                    onClick={() => {
                      if (confirm(`Delete "${a.title}"? This removes the proxy from Ferrum Edge.`)) {
                        remove.mutate(a.id);
                      }
                    }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {list.data && list.data.items.length === 0 ? (
              <tr><td colSpan={7} className="muted py-2">You haven't published any APIs yet.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
