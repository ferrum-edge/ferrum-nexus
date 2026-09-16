import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useState, type FormEvent, type ReactElement } from 'react';
import { MIN_PASSWORD_LENGTH } from '@ferrum-nexus/shared';
import { AuthShell, FormNotice } from '../components/auth/AuthShell';
import { PasswordField } from '../components/auth/PasswordField';
import { Button, buttonClassName } from '../components/ui/Button';
import { Icon } from '../components/ui/Icon';
import { ApiError, authApi } from '../lib/api';

/**
 * Consumes the `?token=` link from the reset email.
 *
 * A successful reset destroys every session of the account, including any this
 * browser held, so there is nothing to land the visitor in — they are sent to
 * `/login?reset` and the confirmation is shown there.
 */
export function ResetPasswordPage(): ReactElement {
  const { token } = useSearch({ from: '/reset-password' });
  const navigate = useNavigate();

  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setError(null);
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Passwords must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirmation) {
      setError('The two passwords do not match.');
      return;
    }
    setSubmitting(true);
    try {
      await authApi.resetPassword({ token, new_password: password });
      await navigate({ to: '/login', search: { reset: true }, replace: true });
    } catch (caught) {
      setError(ApiError.is(caught) ? caught.message : 'Could not reset your password.');
    } finally {
      setSubmitting(false);
    }
  };

  if (!token) {
    return (
      <AuthShell title="Reset your password">
        <div className="flex flex-col gap-4">
          <FormNotice>This link is missing its reset token.</FormNotice>
          <Link
            to="/forgot-password"
            className={buttonClassName({ variant: 'primary', size: 'lg', className: 'w-full' })}
          >
            Request a new link
            <Icon name="arrow-right" className="h-4 w-4" />
          </Link>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Choose a new password"
      description="Setting a new password signs you out everywhere else."
      footer={
        <>
          Link expired?{' '}
          <Link to="/forgot-password" className="text-accent hover:underline">
            Request a new one
          </Link>
        </>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
        {error ? <FormNotice>{error}</FormNotice> : null}

        <PasswordField
          label="New password"
          autoComplete="new-password"
          required
          hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <PasswordField
          label="Confirm new password"
          autoComplete="new-password"
          required
          hint="Both entries have to match."
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
        />

        <Button type="submit" variant="primary" size="lg" className="w-full" loading={submitting}>
          Set new password
          <Icon name="arrow-right" className="h-4 w-4" />
        </Button>
      </form>
    </AuthShell>
  );
}
