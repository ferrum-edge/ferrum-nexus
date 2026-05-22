import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PortalUser } from '@ferrum-nexus/shared';
import { api } from '../../lib/api.js';

export function AdminPendingRegistrationsPage() {
  const queryClient = useQueryClient();
  const [denyUser, setDenyUser] = useState<PortalUser | null>(null);
  const [reason, setReason] = useState('');
  const list = useQuery({
    queryKey: ['pending-registrations'],
    queryFn: async () => api<{ users: PortalUser[]; total: number }>('/admin/users/pending'),
  });

  const approve = useMutation({
    mutationFn: async (id: string) => api(`/admin/users/${id}/approve`, { method: 'POST' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['pending-registrations'] });
      void queryClient.invalidateQueries({ queryKey: ['admin-users'] });
    },
  });
  const deny = useMutation({
    mutationFn: async () =>
      denyUser
        ? api(`/admin/users/${denyUser.id}/deny`, { method: 'POST', json: { reason } })
        : Promise.resolve(),
    onSuccess: () => {
      setDenyUser(null);
      setReason('');
      void queryClient.invalidateQueries({ queryKey: ['pending-registrations'] });
      void queryClient.invalidateQueries({ queryKey: ['admin-users'] });
    },
  });

  return (
    <section className="space-y-4">
      <h1 className="text-xl font-semibold">Pending Registrations</h1>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase muted">
              <th>Email</th><th>Name</th><th>Role</th><th>Created</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {list.data?.users.map((user) => (
              <tr key={user.id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="py-2">{user.email}</td>
                <td>{user.name ?? '—'}</td>
                <td>{user.roles.join(', ')}</td>
                <td>{new Date(user.createdAt).toLocaleString()}</td>
                <td className="space-x-2">
                  <button type="button" className="btn-primary" onClick={() => approve.mutate(user.id)}>
                    Approve
                  </button>
                  <button type="button" className="btn-danger" onClick={() => setDenyUser(user)}>
                    Deny
                  </button>
                </td>
              </tr>
            ))}
            {list.data?.users.length === 0 ? (
              <tr><td colSpan={5} className="muted py-3">No pending registrations.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {denyUser ? (
        <div className="card space-y-3">
          <h2 className="font-semibold">Deny {denyUser.email}</h2>
          <textarea className="input min-h-[100px]" value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={() => setDenyUser(null)}>Cancel</button>
            <button type="button" className="btn-danger" disabled={reason.length === 0} onClick={() => deny.mutate()}>
              Deny registration
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

