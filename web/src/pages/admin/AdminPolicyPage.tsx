import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { GovernancePolicy, PolicyExceptionRequest, PolicyRule } from '@ferrum-nexus/shared';
import { api } from '../../lib/api.js';

export function AdminPolicyPage() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<'policy' | 'exceptions'>('policy');
  const [rulesJson, setRulesJson] = useState('[]');
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});

  const policy = useQuery({
    queryKey: ['governance-policy'],
    queryFn: async () => api<{ policy: GovernancePolicy }>('/admin/governance/policy'),
  });
  const exceptions = useQuery({
    queryKey: ['governance-exceptions'],
    queryFn: async () =>
      api<{ exceptions: PolicyExceptionRequest[] }>('/admin/governance/exceptions', {
        query: { status: 'pending' },
      }),
  });

  useEffect(() => {
    if (policy.data) setRulesJson(JSON.stringify(policy.data.policy.rules, null, 2));
  }, [policy.data]);

  const savePolicy = useMutation({
    mutationFn: async () =>
      api<{ policy: GovernancePolicy }>('/admin/governance/policy', {
        method: 'PUT',
        json: { rules: JSON.parse(rulesJson) as PolicyRule[] },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['governance-policy'] }),
  });

  const approve = useMutation({
    mutationFn: async (id: string) =>
      api(`/admin/governance/exceptions/${id}/approve`, {
        method: 'POST',
        json: { reviewerNotes: reviewNotes[id] || null },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['governance-exceptions'] });
      void queryClient.invalidateQueries({ queryKey: ['catalog-search-index'] });
    },
  });

  const deny = useMutation({
    mutationFn: async (id: string) =>
      api(`/admin/governance/exceptions/${id}/deny`, {
        method: 'POST',
        json: { reviewerNotes: reviewNotes[id] || null },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['governance-exceptions'] }),
  });

  return (
    <section className="space-y-4">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Governance Policy</h1>
        <div className="flex gap-2">
          <button type="button" className={tab === 'policy' ? 'btn-primary' : 'btn-secondary'} onClick={() => setTab('policy')}>Policy</button>
          <button type="button" className={tab === 'exceptions' ? 'btn-primary' : 'btn-secondary'} onClick={() => setTab('exceptions')}>Exceptions</button>
        </div>
      </header>

      {tab === 'policy' ? (
        <div className="card space-y-3">
          <div className="muted text-sm">
            Version {policy.data?.policy.version ?? 0} · {policy.data?.policy.updatedAt ? new Date(policy.data.policy.updatedAt).toLocaleString() : 'never'}
          </div>
          <textarea className="input min-h-[420px] font-mono" value={rulesJson} onChange={(e) => setRulesJson(e.target.value)} />
          <div className="flex justify-end">
            <button type="button" className="btn-primary" onClick={() => savePolicy.mutate()}>
              Save policy
            </button>
          </div>
          {savePolicy.error ? <p className="text-sm text-red-600">{savePolicy.error instanceof Error ? savePolicy.error.message : 'Failed'}</p> : null}
        </div>
      ) : (
        <div className="space-y-3">
          {exceptions.data?.exceptions.map((exception) => (
            <div key={exception.id} className="card space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h2 className="font-semibold">{exception.id}</h2>
                  <p className="muted text-sm">{exception.violations.length} blocking violation(s)</p>
                </div>
                <span className="tag">{exception.status}</span>
              </div>
              <p className="text-sm">{exception.justification}</p>
              <ul className="space-y-1 text-sm">
                {exception.violations.map((violation) => (
                  <li key={`${exception.id}-${violation.ruleId}`} className="rounded bg-slate-50 p-2 dark:bg-slate-950">
                    <code>{violation.ruleId}</code> · {violation.message} · <code>{violation.pointer}</code>
                  </li>
                ))}
              </ul>
              <textarea
                className="input min-h-[80px]"
                placeholder="Reviewer notes"
                value={reviewNotes[exception.id] ?? ''}
                onChange={(e) => setReviewNotes({ ...reviewNotes, [exception.id]: e.target.value })}
              />
              <div className="flex justify-end gap-2">
                <button type="button" className="btn-secondary" onClick={() => deny.mutate(exception.id)}>Deny</button>
                <button type="button" className="btn-primary" onClick={() => approve.mutate(exception.id)}>Approve</button>
              </div>
            </div>
          ))}
          {exceptions.data?.exceptions.length === 0 ? <p className="muted">No pending exceptions.</p> : null}
        </div>
      )}
    </section>
  );
}

