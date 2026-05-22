import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ApiError, api } from '../../lib/api.js';
import type { ApiAsset, Violation } from '@ferrum-nexus/shared';
import { navigate } from '../../App.js';

export function ProviderPublishPage() {
  const [rawSpec, setRawSpec] = useState('');
  const [visibility, setVisibility] = useState<'private' | 'internal' | 'public'>('private');
  const [requestable, setRequestable] = useState(false);
  const [lifecycle, setLifecycle] = useState<'draft' | 'published' | 'deprecated' | 'retired'>('draft');
  const [contactEmail, setContactEmail] = useState('');
  const [supportNotes, setSupportNotes] = useState('');
  const [namespace, setNamespace] = useState('');
  const [policyViolation, setPolicyViolation] = useState<{
    pendingPublishId: string;
    violations: Violation[];
  } | null>(null);
  const [justification, setJustification] = useState('');

  const publish = useMutation({
    mutationFn: async () =>
      api<{ asset: ApiAsset }>('/provider/apis', {
        method: 'POST',
        json: {
          rawSpec,
          visibility,
          requestable,
          lifecycle,
          contactEmail: contactEmail || null,
          supportNotes: supportNotes || null,
          namespace: namespace || undefined,
        },
      }),
    onSuccess: (data) => {
      navigate(`/apis/${data.asset.id}`);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'POLICY_VIOLATION') {
        const details = err.details as { pendingPublishId?: string; violations?: Violation[] } | undefined;
        if (details?.pendingPublishId && details.violations) {
          setPolicyViolation({
            pendingPublishId: details.pendingPublishId,
            violations: details.violations,
          });
        }
      }
    },
  });

  const requestException = useMutation({
    mutationFn: async () =>
      policyViolation
        ? api('/provider/governance/exceptions', {
            method: 'POST',
            json: {
              pendingPublishId: policyViolation.pendingPublishId,
              justification,
            },
          })
        : Promise.resolve(),
    onSuccess: () => {
      setJustification('');
    },
  });

  return (
    <section className="space-y-4">
      <h1 className="text-xl font-semibold">Publish an API</h1>
      <div className="card space-y-3">
        <div>
          <label className="label">OpenAPI document (JSON or YAML)</label>
          <textarea
            className="input font-mono min-h-[260px]"
            placeholder="paste your OpenAPI document here…"
            value={rawSpec}
            onChange={(e) => setRawSpec(e.target.value)}
          />
          <p className="muted text-xs">Must include the <code>x-ferrum-proxy</code> extension.</p>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <div>
            <label className="label">Visibility</label>
            <select className="input" value={visibility} onChange={(e) => setVisibility(e.target.value as typeof visibility)}>
              <option value="private">Private</option>
              <option value="internal">Internal</option>
              <option value="public">Public</option>
            </select>
          </div>
          <div>
            <label className="label">Lifecycle</label>
            <select className="input" value={lifecycle} onChange={(e) => setLifecycle(e.target.value as typeof lifecycle)}>
              <option value="draft">Draft</option>
              <option value="published">Published</option>
              <option value="deprecated">Deprecated</option>
              <option value="retired">Retired</option>
            </select>
          </div>
          <div>
            <label className="label">Namespace (optional)</label>
            <input className="input" value={namespace} onChange={(e) => setNamespace(e.target.value)} />
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div>
            <label className="label">Contact email</label>
            <input className="input" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} />
          </div>
          <div className="flex items-end">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={requestable} onChange={(e) => setRequestable(e.target.checked)} />
              <span className="text-sm">Accept access requests</span>
            </label>
          </div>
        </div>
        <div>
          <label className="label">Support notes</label>
          <textarea className="input" value={supportNotes} onChange={(e) => setSupportNotes(e.target.value)} />
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={() => navigate('/provider/apis')}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={publish.isPending || rawSpec.length === 0}
            onClick={() => publish.mutate()}
          >
            {publish.isPending ? 'Publishing…' : 'Publish'}
          </button>
        </div>
        {publish.error ? (
          <p className="text-sm text-red-600">
            {publish.error instanceof Error ? publish.error.message : 'Failed'}
          </p>
        ) : null}
      </div>
      {policyViolation ? (
        <div className="card space-y-3">
          <h2 className="font-semibold">Policy violations</h2>
          <ul className="space-y-2 text-sm">
            {policyViolation.violations.map((violation) => (
              <li key={violation.ruleId} className="rounded bg-slate-50 p-2 dark:bg-slate-950">
                <div><code>{violation.ruleId}</code> · {violation.severity}</div>
                <div>{violation.message}</div>
                <code className="muted">{violation.pointer}</code>
              </li>
            ))}
          </ul>
          <textarea
            className="input min-h-[120px]"
            value={justification}
            onChange={(e) => setJustification(e.target.value)}
            placeholder="Explain why this API needs an exception."
          />
          <div className="flex justify-end">
            <button
              type="button"
              className="btn-primary"
              disabled={justification.length < 10 || requestException.isPending}
              onClick={() => requestException.mutate()}
            >
              {requestException.isPending ? 'Requesting…' : 'Request exception'}
            </button>
          </div>
          {requestException.isSuccess ? <p className="text-sm text-green-700">Exception request submitted.</p> : null}
        </div>
      ) : null}
    </section>
  );
}
