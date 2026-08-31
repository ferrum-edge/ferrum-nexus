import { Link, Navigate, useNavigate } from '@tanstack/react-router';
import { useCallback, useState, type FormEvent, type ReactElement } from 'react';
import { ERROR_CODES } from '@ferrum-nexus/shared';
import { AuthShell, FormNotice } from '../components/auth/AuthShell';
import { CaptchaWidget } from '../components/auth/CaptchaWidget';
import { Button } from '../components/ui/Button';
import { LabeledInput } from '../components/ui/Input';
import { useCaptchaConfig } from '../hooks/useBranding';
import { ApiError } from '../lib/api';
import { useAuth } from '../stores/auth';

/** Sign-in form. */
export function LoginPage(): ReactElement {
  const { status, login } = useAuth();
  const navigate = useNavigate();
  const { data: captcha } = useCaptchaConfig();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onToken = useCallback((token: string | null) => setCaptchaToken(token), []);

  if (status === 'authenticated') return <Navigate to="/" replace />;

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login({
        email: email.trim(),
        password,
        ...(captchaToken ? { captcha_token: captchaToken } : {}),
      });
      await navigate({ to: '/' });
    } catch (caught) {
      setError(
        ApiError.is(caught) ? caught : new ApiError(ERROR_CODES.INTERNAL, 'Sign-in failed', 0),
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthShell
      title="Sign in"
      description="Access the developer portal with your Nexus account."
      footer={
        <>
          Need an account?{' '}
          <Link to="/register" className="text-accent hover:underline">
            Register
          </Link>
        </>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
        {error ? (
          <FormNotice tone={error.code === ERROR_CODES.EMAIL_NOT_VERIFIED ? 'warning' : 'danger'}>
            {error.code === ERROR_CODES.EMAIL_NOT_VERIFIED ? (
              <>
                <span className="font-medium">Verify your email address.</span> Open the
                verification link we sent you, then sign in again.
              </>
            ) : (
              error.message
            )}
          </FormNotice>
        ) : null}

        <LabeledInput
          label="Email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <LabeledInput
          label="Password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />

        <CaptchaWidget config={captcha} onToken={onToken} />

        <Button type="submit" variant="primary" size="lg" loading={submitting}>
          Sign in
        </Button>
      </form>
    </AuthShell>
  );
}
