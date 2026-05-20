import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { navigate } from '../../App.js';
import { useAuth } from '../../lib/auth.js';

export function VerifyEmailPage({ token }: { token: string | null }) {
  const { refresh } = useAuth();
  const [state, setState] = useState<'verifying' | 'ok' | 'error'>(token ? 'verifying' : 'error');
  const [message, setMessage] = useState<string | null>(token ? null : 'Missing token');

  useEffect(() => {
    if (!token) return;
    api<{ user: unknown }>('/auth/verify-email', { method: 'POST', json: { token } })
      .then(() => {
        setState('ok');
        return refresh();
      })
      .catch((err) => {
        setState('error');
        setMessage(err instanceof Error ? err.message : 'Verification failed');
      });
  }, [token, refresh]);

  return (
    <div className="flex h-full min-h-screen items-center justify-center px-4">
      <div className="card max-w-md text-center">
        {state === 'verifying' ? (
          <p>Verifying…</p>
        ) : state === 'ok' ? (
          <>
            <h2 className="text-lg font-semibold">Email verified</h2>
            <p className="muted mt-1">You can now sign in.</p>
            <button type="button" className="btn-primary mt-4" onClick={() => navigate('/')}>
              Continue
            </button>
          </>
        ) : (
          <>
            <h2 className="text-lg font-semibold">Verification failed</h2>
            <p className="muted mt-1">{message ?? 'Unknown error'}</p>
            <button type="button" className="btn-secondary mt-4" onClick={() => navigate('/')}>
              Back to sign in
            </button>
          </>
        )}
      </div>
    </div>
  );
}
