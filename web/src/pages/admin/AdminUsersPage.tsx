import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import type { PortalUser, UserRole, UserStatus } from '@ferrum-nexus/shared';

const ROLES: UserRole[] = ['client', 'provider', 'admin', 'super_admin'];

export function AdminUsersPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const list = useQuery({
    queryKey: ['admin-users', search],
    queryFn: async () =>
      api<{ users: PortalUser[]; total: number }>('/admin/users', {
        query: { search: search || undefined, limit: 100 },
      }),
  });

  const setStatus = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: UserStatus }) =>
      api<void>(`/admin/users/${id}/status`, { method: 'PUT', json: { status } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-users'] }),
  });

  const setRoles = useMutation({
    mutationFn: async ({ id, roles }: { id: string; roles: UserRole[] }) =>
      api<void>(`/admin/users/${id}/roles`, { method: 'PUT', json: { roles } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-users'] }),
  });

  return (
    <section className="space-y-4">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Users</h1>
        <input
          className="input max-w-xs"
          placeholder="Search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </header>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase muted">
              <th>Email</th><th>Name</th><th>Status</th><th>Roles</th><th>Last login</th>
            </tr>
          </thead>
          <tbody>
            {list.data?.users.map((u) => (
              <tr key={u.id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="py-1">{u.email}</td>
                <td>{u.name ?? '—'}</td>
                <td>
                  <select
                    className="input max-w-[140px]"
                    value={u.status}
                    onChange={(e) => setStatus.mutate({ id: u.id, status: e.target.value as UserStatus })}
                  >
                    <option value="pending">pending</option>
                    <option value="pending_admin_approval">pending_admin_approval</option>
                    <option value="active">active</option>
                    <option value="disabled">disabled</option>
                  </select>
                </td>
                <td>
                  <div className="flex flex-wrap gap-2">
                    {ROLES.map((role) => {
                      const enabled = u.roles.includes(role);
                      return (
                        <button
                          key={role}
                          type="button"
                          className={enabled ? 'tag bg-brand-100 dark:bg-brand-900/40' : 'tag opacity-50'}
                          onClick={() => {
                            const next = enabled
                              ? u.roles.filter((r) => r !== role)
                              : [...u.roles, role];
                            setRoles.mutate({ id: u.id, roles: next });
                          }}
                        >
                          {role}
                        </button>
                      );
                    })}
                  </div>
                </td>
                <td>{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : '—'}</td>
              </tr>
            ))}
            {list.data && list.data.users.length === 0 ? (
              <tr><td colSpan={5} className="muted py-2">No users found.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
