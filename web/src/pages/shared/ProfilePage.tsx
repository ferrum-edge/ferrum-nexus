import { useState } from 'react';
import { useAuth } from '../../lib/auth.js';
import { api } from '../../lib/api.js';
import type { PortalUser } from '@ferrum-nexus/shared';

export function ProfilePage() {
  const { user, refresh } = useAuth();
  const [name, setName] = useState(user?.name ?? '');
  const [phone, setPhone] = useState(user?.phone ?? '');
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNew] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  if (!user) return null;

  return (
    <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <div className="card">
        <h2 className="font-semibold">Contact information</h2>
        <form
          className="mt-2 space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            await api<{ user: PortalUser }>('/me/contact', {
              method: 'PUT',
              json: { name, phone },
            });
            await refresh();
            setMessage('Contact info updated.');
          }}
        >
          <div>
            <label className="label">Name</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label className="label">Phone</label>
            <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>
          <button type="submit" className="btn-primary">Save</button>
        </form>
      </div>
      <div className="card">
        <h2 className="font-semibold">Change password</h2>
        <form
          className="mt-2 space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setMessage(null);
            try {
              await api<void>('/auth/change-password', {
                method: 'POST',
                json: { currentPassword, newPassword },
              });
              setMessage('Password changed; please sign in again.');
              window.location.href = '/';
            } catch (err) {
              setMessage(err instanceof Error ? err.message : 'Failed');
            }
          }}
        >
          <div>
            <label className="label">Current password</label>
            <input
              type="password"
              className="input"
              required
              value={currentPassword}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </div>
          <div>
            <label className="label">New password</label>
            <input
              type="password"
              className="input"
              required
              minLength={8}
              value={newPassword}
              onChange={(e) => setNew(e.target.value)}
            />
          </div>
          <button type="submit" className="btn-primary">Change password</button>
        </form>
      </div>
      {message ? <p className="muted col-span-full text-sm">{message}</p> : null}
      <div className="card md:col-span-2 text-sm">
        <h2 className="font-semibold">Account details</h2>
        <p className="muted mt-1">User id: <code>{user.id}</code></p>
        <p className="muted">Email: {user.email}</p>
        <p className="muted">Status: {user.status}</p>
        <p className="muted">Roles: {user.roles.join(', ')}</p>
        <p className="muted">Last login: {user.lastLoginAt ?? '—'}</p>
      </div>
    </section>
  );
}
