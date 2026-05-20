import { useState } from 'react';
import { api } from '../../lib/api.js';
import { navigate } from '../../App.js';

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [done, setDone] = useState(false);

  return (
    <div className="flex h-full min-h-screen items-center justify-center px-4">
      <form
        className="card w-full max-w-md space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          await api<void>('/auth/forgot-password', { method: 'POST', json: { email } });
          setDone(true);
        }}
      >
        <h2 className="text-lg font-semibold">Forgot password</h2>
        {done ? (
          <p className="muted">
            If an account exists for that email, a reset link has been sent.
          </p>
        ) : (
          <>
            <div>
              <label className="label">Email</label>
              <input
                className="input"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <button type="submit" className="btn-primary w-full">
              Send reset link
            </button>
          </>
        )}
        <button
          type="button"
          className="muted text-sm hover:underline"
          onClick={() => navigate('/')}
        >
          Back to sign in
        </button>
      </form>
    </div>
  );
}
