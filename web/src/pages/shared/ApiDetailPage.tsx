import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import type { ApiAssetWithProvider } from '@ferrum-nexus/shared';

interface AssetResp {
  asset: ApiAssetWithProvider;
}
interface SpecResp {
  assetId: string;
  version?: string;
  rawSpec: string | null;
}

export function ApiDetailPage({ id }: { id: string }) {
  const queryClient = useQueryClient();
  const [justification, setJustification] = useState('');
  const [showRequest, setShowRequest] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['api', id],
    queryFn: async () => api<AssetResp>(`/catalog/apis/${id}`),
  });
  const { data: spec } = useQuery({
    queryKey: ['api-spec', id],
    queryFn: async () => api<SpecResp>(`/catalog/apis/${id}/spec`),
  });

  const requestAccess = useMutation({
    mutationFn: async () =>
      api<{ request: unknown }>(`/catalog/apis/${id}/access-requests`, {
        method: 'POST',
        json: { justification },
      }),
    onSuccess: () => {
      setShowRequest(false);
      setJustification('');
      void queryClient.invalidateQueries({ queryKey: ['my-requests'] });
    },
  });

  if (isLoading) return <p className="muted">Loading…</p>;
  if (!data) return null;

  const asset = data.asset;

  return (
    <section>
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{asset.title}</h1>
          <p className="muted text-sm">
            v{asset.version} · {asset.providerName} ({asset.providerEmail}) ·{' '}
            <span className="tag">{asset.lifecycle}</span>{' '}
            <span className="tag">{asset.visibility}</span>
          </p>
        </div>
        {asset.requestable ? (
          <button
            type="button"
            className="btn-primary"
            onClick={() => setShowRequest((v) => !v)}
          >
            Request access
          </button>
        ) : (
          <span className="tag">Not requestable</span>
        )}
      </header>

      {showRequest ? (
        <div className="card mb-4">
          <label className="label" htmlFor="justification">Justification</label>
          <textarea
            id="justification"
            className="input min-h-[100px]"
            value={justification}
            onChange={(e) => setJustification(e.target.value)}
            placeholder="Explain how you intend to use this API. (Min 10 characters.)"
          />
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={() => setShowRequest(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={justification.length < 10 || requestAccess.isPending}
              onClick={() => requestAccess.mutate()}
            >
              {requestAccess.isPending ? 'Submitting…' : 'Submit request'}
            </button>
          </div>
          {requestAccess.error ? (
            <p className="mt-2 text-sm text-red-600">
              {requestAccess.error instanceof Error ? requestAccess.error.message : 'Failed'}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="card lg:col-span-2">
          <h2 className="mb-2 font-semibold">Description</h2>
          <p className="text-sm">{asset.description ?? 'No description.'}</p>
          <h3 className="mt-4 font-semibold">Tags</h3>
          <div className="mt-1 flex flex-wrap gap-1">
            {asset.tags.length === 0 ? (
              <span className="muted text-sm">No tags.</span>
            ) : (
              asset.tags.map((t) => <span key={t} className="tag">{t}</span>)
            )}
          </div>
          <h3 className="mt-4 font-semibold">OpenAPI document</h3>
          <pre className="mt-1 max-h-96 overflow-auto rounded bg-slate-50 p-3 text-xs dark:bg-slate-800">
            {spec?.rawSpec ?? '— no spec on file —'}
          </pre>
        </div>
        <div className="card space-y-2 text-sm">
          <h2 className="font-semibold">Metadata</h2>
          <p><span className="muted">Operations:</span> {asset.operationCount}</p>
          <p><span className="muted">Namespace:</span> {asset.namespace}</p>
          <p><span className="muted">Proxy:</span> <code>{asset.proxyId}</code></p>
          <p><span className="muted">Spec id:</span> <code>{asset.apiSpecId}</code></p>
          <p><span className="muted">Contact:</span> {asset.contactEmail ?? '—'}</p>
          <p><span className="muted">Support:</span> {asset.supportNotes ?? '—'}</p>
        </div>
      </div>
    </section>
  );
}
