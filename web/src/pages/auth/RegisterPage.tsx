import { useState } from 'react';
import { useAuth } from '../../lib/auth.js';
import { navigate } from '../../App.js';

export function RegisterPage() {
  const { register, settings } = useAuth();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [desiredRole, setDesiredRole] = useState<'client' | 'provider'>('client');
  const [captchaToken, setCaptchaToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  if (done) {
    return (
      <div className="flex h-full min-h-screen items-center justify-center px-4">
        <div className="card max-w-md text-center">
          <h2 className="text-lg font-semibold">Check your email</h2>
          <p className="muted mt-2">
            Please confirm your email address to activate your account.
          </p>
          <button type="button" className="btn-secondary mt-4" onClick={() => navigate('/')}>
            Back to sign in
          </button>
        </div>
      </div>
    );
  }

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
              const out = await register({
                email,
                password,
                name: name || undefined,
                desiredRole,
                captchaToken: settings?.captcha.enabled ? captchaToken : undefined,
              });
              if (out.requiresVerification) setDone(true);
              else navigate('/');
            } catch (err) {
              setError(err instanceof Error ? err.message : 'Registration failed');
            } finally {
              setBusy(false);
            }
          }}
        >
          <h2 className="text-lg font-semibold">Create an account</h2>
          <div>
            <label className="label">Name</label>
            <input
              className="input"
              type="text"
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <label className="label">Email</label>
            <input
              className="input"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div>
            <label className="label">Password</label>
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <p className="muted mt-1 text-xs">At least 8 characters.</p>
          </div>
          <div>
            <label className="label">I am a…</label>
            <div className="flex gap-2">
              {(['client', 'provider'] as const).map((role) => (
                <button
                  key={role}
                  type="button"
                  className={
                    desiredRole === role ? 'btn-primary flex-1' : 'btn-secondary flex-1'
                  }
                  onClick={() => setDesiredRole(role)}
                >
                  {role === 'client' ? 'API Client' : 'API Provider'}
                </button>
              ))}
            </div>
          </div>
          {settings?.captcha.enabled ? (
            <div>
              <label className="label">
                CAPTCHA token ({settings.captcha.provider}, site key {settings.captcha.siteKey})
              </label>
              <input
                className="input"
                value={captchaToken}
                onChange={(e) => setCaptchaToken(e.target.value)}
              />
              <p className="muted mt-1 text-xs">
                Embed the CAPTCHA widget here; for this scaffold paste a token to test.
              </p>
            </div>
          ) : null}
          {error ? <p className="text-sm text-red-600">{error}</p> : null}
          <button type="submit" className="btn-primary w-full" disabled={busy}>
            {busy ? 'Creating…' : 'Create account'}
          </button>
          <div className="muted text-sm">
            <button type="button" className="hover:underline" onClick={() => navigate('/')}>
              Back to sign in
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
