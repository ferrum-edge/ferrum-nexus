import { useState } from 'react';
import { useAuth } from '../../lib/auth.js';
import { navigate } from '../../App.js';

export function LoginPage() {
  const { login, settings } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <div className="flex h-full min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-md">
        <h1 className="mb-6 text-center text-2xl font-semibold">
          {settings?.branding.productName ?? 'Ferrum Nexus'}
        </h1>
        <form
          className="card space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              await login({ email, password });
            } catch (err) {
              setError(err instanceof Error ? err.message : 'Login failed');
            } finally {
              setBusy(false);
            }
          }}
        >
          <h2 className="text-lg font-semibold">Sign in</h2>
          <div>
            <label className="label" htmlFor="email">Email</label>
            <input
              id="email"
              className="input"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="password">Password</label>
            <input
              id="password"
              className="input"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {error ? <p className="text-sm text-red-600">{error}</p> : null}
          <button type="submit" className="btn-primary w-full" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          <div className="muted text-sm">
            <button
              type="button"
              className="hover:underline"
              onClick={() => navigate('/forgot-password')}
            >
              Forgot password?
            </button>
            {settings?.registrationEnabled !== false ? (
              <>
                {' · '}
                <button
                  type="button"
                  className="hover:underline"
                  onClick={() => navigate('/register')}
                >
                  Create an account
                </button>
              </>
            ) : null}
          </div>
        </form>
      </div>
    </div>
  );
}
