import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { api } from '../../lib/api.js';

interface DriftReport {
  namespace: string;
  missingInNexus: { specId: string; title: string; version: string }[];
  drifted: { assetId: string; specId: string; localHash: string | null; remoteHash: string | null }[];
  missingInEdge: { assetId: string; specId: string }[];
}

export function AdminDriftPage() {
  const [namespace, setNamespace] = useState('default');
  const { data, refetch, isFetching } = useQuery({
    queryKey: ['drift', namespace],
    queryFn: async () => api<DriftReport>('/admin/drift', { query: { namespace } }),
  });
  const sync = useMutation({
    mutationFn: async () => api<{ imported: number; updated: number; drift: number }>(
      '/admin/drift/sync',
      { method: 'POST', query: { namespace } },
    ),
    onSuccess: () => refetch(),
  });

  return (
    <section className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Drift sync</h1>
        <div className="flex items-center gap-2">
          <input className="input max-w-xs" placeholder="namespace" value={namespace} onChange={(e) => setNamespace(e.target.value)} />
          <button type="button" className="btn-secondary" disabled={isFetching} onClick={() => refetch()}>
            Refresh
          </button>
          <button type="button" className="btn-primary" disabled={sync.isPending} onClick={() => sync.mutate()}>
            {sync.isPending ? 'Syncing…' : 'Run sync'}
          </button>
        </div>
      </header>
      {sync.data ? (
        <p className="muted text-sm">
          Imported {sync.data.imported}, updated {sync.data.updated}, drift detected on {sync.data.drift}.
        </p>
      ) : null}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <div className="card">
          <h2 className="font-semibold">Missing in Nexus</h2>
          {data?.missingInNexus.length === 0 ? <p className="muted text-sm">All accounted for.</p> : null}
          <ul className="mt-2 space-y-1 text-sm">
            {data?.missingInNexus.map((s) => (
              <li key={s.specId}>
                {s.title} v{s.version} <code className="muted">({s.specId})</code>
              </li>
            ))}
          </ul>
        </div>
        <div className="card">
          <h2 className="font-semibold">Drifted</h2>
          {data?.drifted.length === 0 ? <p className="muted text-sm">No drift.</p> : null}
          <ul className="mt-2 space-y-1 text-sm">
            {data?.drifted.map((s) => (
              <li key={s.assetId}>
                <code>{s.assetId}</code> · local {s.localHash?.slice(0, 8)} ↔ remote {s.remoteHash?.slice(0, 8)}
              </li>
            ))}
          </ul>
        </div>
        <div className="card">
          <h2 className="font-semibold">Missing in Edge</h2>
          {data?.missingInEdge.length === 0 ? <p className="muted text-sm">None.</p> : null}
          <ul className="mt-2 space-y-1 text-sm">
            {data?.missingInEdge.map((s) => (
              <li key={s.assetId}>
                <code>{s.assetId}</code>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
