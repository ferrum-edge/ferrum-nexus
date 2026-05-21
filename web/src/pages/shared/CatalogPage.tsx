import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import type { ApiAssetWithProvider } from '@ferrum-nexus/shared';
import { navigate } from '../../App.js';

interface CatalogResp {
  items: ApiAssetWithProvider[];
  total: number;
}

export function CatalogPage() {
  const [search, setSearch] = useState('');
  const { data, isLoading } = useQuery({
    queryKey: ['catalog', search],
    queryFn: async () =>
      api<CatalogResp>('/catalog/apis', { query: { search: search || undefined, limit: 100 } }),
  });

  return (
    <section>
      <header className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">API Catalog</h1>
        <input
          className="input max-w-xs"
          placeholder="Search APIs"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </header>
      {isLoading ? (
        <p className="muted">Loading…</p>
      ) : data?.items.length === 0 ? (
        <p className="muted">No APIs available yet.</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {data?.items.map((item) => (
            <button
              key={item.id}
              type="button"
              className="card text-left hover:shadow-md"
              onClick={() => navigate(`/apis/${item.id}`)}
            >
              <div className="flex items-start justify-between">
                <div>
                  <h2 className="font-semibold">{item.title}</h2>
                  <p className="muted text-xs">v{item.version} · {item.providerName}</p>
                </div>
                <span className="tag">{item.lifecycle}</span>
              </div>
              <p className="muted mt-2 line-clamp-3 text-sm">{item.description ?? 'No description.'}</p>
              <div className="mt-2 flex flex-wrap gap-1">
                {item.tags.slice(0, 5).map((t) => (
                  <span key={t} className="tag">{t}</span>
                ))}
              </div>
              <div className="muted mt-2 text-xs">
                {item.requestable ? 'Accepting access requests' : 'Restricted'} · {item.operationCount} operations
              </div>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
