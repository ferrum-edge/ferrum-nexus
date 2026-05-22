import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import type { ApiAssetWithProvider } from '@ferrum-nexus/shared';
import { ApiKeyFactsPanel, contactText } from './ApiKeyFactsPanel.js';
import { OasViewer } from '../../components/oas-viewer/OasViewer.js';

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
  const contact = contactText(asset);
  const safeContactUrl = normalizeHttpUrl(asset.contactUrl);

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
          <p className="mt-2 max-w-3xl text-sm">
            {asset.description ?? (
              <span className="muted">No description in the OpenAPI document.</span>
            )}
          </p>
          {contact ? (
            <p className="muted mt-2 text-sm">
              Contact: {asset.contactName ? <span>{asset.contactName}</span> : null}
              {asset.contactName && asset.contactEmail ? ' · ' : ''}
              {asset.contactEmail ? (
                <a
                  className="text-brand-700 hover:underline dark:text-brand-300"
                  href={`mailto:${asset.contactEmail}`}
                >
                  {asset.contactEmail}
                </a>
              ) : null}
              {(asset.contactName || asset.contactEmail) && asset.contactUrl ? ' · ' : ''}
              {safeContactUrl ? (
                <a
                  className="text-brand-700 hover:underline dark:text-brand-300"
                  href={safeContactUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {asset.contactUrl}
                </a>
              ) : (
                asset.contactUrl
              )}
            </p>
          ) : null}
        </div>
        {asset.requestable ? (
          <button type="button" className="btn-primary" onClick={() => setShowRequest((v) => !v)}>
            Request access
          </button>
        ) : (
          <span className="tag">Not requestable</span>
        )}
      </header>

      {showRequest ? (
        <div className="card mb-4">
          <label className="label" htmlFor="justification">
            Justification
          </label>
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

      <ApiKeyFactsPanel asset={asset} />

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <div className="card">
            <h2 className="mb-2 font-semibold">Description</h2>
            <p className="text-sm">{asset.description ?? 'No description.'}</p>
            <h3 className="mt-4 font-semibold">Tags</h3>
            <div className="mt-1 flex flex-wrap gap-1">
              {asset.tags.length === 0 ? (
                <span className="muted text-sm">No tags.</span>
              ) : (
                asset.tags.map((t) => (
                  <span key={t} className="tag">
                    {t}
                  </span>
                ))
              )}
            </div>
          </div>
          <OasViewer rawSpec={spec?.rawSpec ?? null} />
        </div>
        <div className="card space-y-2 text-sm">
          <h2 className="font-semibold">Metadata</h2>
          <p>
            <span className="muted">Operations:</span> {asset.operationCount}
          </p>
          <p>
            <span className="muted">Namespace:</span> {asset.namespace}
          </p>
          <p>
            <span className="muted">Proxy:</span> <code>{asset.proxyId}</code>
          </p>
          <p>
            <span className="muted">Spec id:</span> <code>{asset.apiSpecId}</code>
          </p>
          <p>
            <span className="muted">Contact:</span> {contact ?? '—'}
          </p>
          <p>
            <span className="muted">Support:</span> {asset.supportNotes ?? '—'}
          </p>
          {asset.policyExceptionId ? (
            <p>
              <span className="muted">Policy exception:</span>{' '}
              <code>{asset.policyExceptionId}</code>
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function normalizeHttpUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}
