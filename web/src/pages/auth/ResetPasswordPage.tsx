import { useState } from 'react';
import { api } from '../../lib/api.js';
import { navigate } from '../../App.js';

export function ResetPasswordPage({ token }: { token: string | null }) {
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!token) {
    return (
      <div className="flex h-full min-h-screen items-center justify-center px-4">
        <div className="card max-w-md text-center">
          <p className="muted">Missing or invalid token.</p>
          <button type="button" className="btn-secondary mt-3" onClick={() => navigate('/')}>
            Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-screen items-center justify-center px-4">
      <form
        className="card w-full max-w-md space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          try {
            await api<void>('/auth/reset-password', { method: 'POST', json: { token, password } });
            setDone(true);
          } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to reset password');
          }
        }}
      >
        <h2 className="text-lg font-semibold">Reset password</h2>
        {done ? (
          <>
            <p>Your password has been reset. Sign in to continue.</p>
            <button type="button" className="btn-primary" onClick={() => navigate('/')}>
              Sign in
            </button>
          </>
        ) : (
          <>
            <div>
              <label className="label">New password</label>
              <input
                className="input"
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            {error ? <p className="text-sm text-red-600">{error}</p> : null}
            <button type="submit" className="btn-primary w-full">Set new password</button>
          </>
        )}
      </form>
    </div>
  );
}
