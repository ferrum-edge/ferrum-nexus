import { Link } from '@tanstack/react-router';
import { useState, type FormEvent, type ReactElement } from 'react';
import { AuthShell, FormNotice } from '../components/auth/AuthShell';
import { Button } from '../components/ui/Button';
import { LabeledInput } from '../components/ui/Input';
import { ApiError, authApi } from '../lib/api';

/**
 * Request a password-reset link.
 *
 * The server answers `ok` to every address, so this page must too: the
 * confirmation below is deliberately worded as a conditional and is shown for
 * an unknown address exactly as it is for a real one. Saying "we sent you an
 * email" instead would hand a visitor the account-existence answer the API
 * spent a scrypt hash refusing to give.
 */
export function ForgotPasswordPage(): ReactElement {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await authApi.forgotPassword({ email: email.trim() });
      setSent(true);
    } catch (caught) {
      // Only transport-level failures land here — a rate limit, or the portal
      // being down. "No such account" is not an error the API reports.
      setError(ApiError.is(caught) ? caught.message : 'Could not send the reset link.');
    } finally {
      setSubmitting(false);
    }
  };

  if (sent) {
    return (
      <AuthShell title="Check your email">
        <div className="flex flex-col gap-4">
          <FormNotice tone="success">
            If an account exists for that address, a reset link has been sent. The link expires in
            one hour.
          </FormNotice>
          <Link
            to="/login"
            className="inline-flex h-11 items-center justify-center rounded-md bg-accent px-4 text-sm font-medium text-accent-fg hover:bg-accent-hover"
          >
            Back to sign in
          </Link>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Reset your password"
      description="Enter the address you registered with and we will email you a link to choose a new password."
      footer={
        <>
          Remembered it?{' '}
          <Link to="/login" className="text-accent hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
        {error ? <FormNotice>{error}</FormNotice> : null}

        <LabeledInput
          label="Email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />

        <Button type="submit" variant="primary" size="lg" loading={submitting}>
          Email me a reset link
        </Button>
      </form>
    </AuthShell>
  );
}
