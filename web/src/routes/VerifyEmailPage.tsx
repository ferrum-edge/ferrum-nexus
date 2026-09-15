import { Link, useSearch } from '@tanstack/react-router';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { AuthShell, FormNotice } from '../components/auth/AuthShell';
import { buttonClassName } from '../components/ui/Button';
import { Icon } from '../components/ui/Icon';
import { Spinner } from '../components/ui/Spinner';
import { ApiError, authApi } from '../lib/api';

type VerifyState =
  | { kind: 'idle' }
  | { kind: 'verifying' }
  | { kind: 'verified'; email: string }
  | { kind: 'failed'; message: string };

/** Consumes the `?token=` link from the verification email. */
export function VerifyEmailPage(): ReactElement {
  const { token } = useSearch({ from: '/verify-email' });
  const [state, setState] = useState<VerifyState>({ kind: 'idle' });
  const attempted = useRef(false);

  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;
    if (!token) {
      setState({ kind: 'failed', message: 'This link is missing its verification token.' });
      return;
    }
    setState({ kind: 'verifying' });
    authApi
      .verifyEmail({ token })
      .then((response) => {
        setState(
          response.verified
            ? { kind: 'verified', email: response.user.email }
            : { kind: 'failed', message: 'This verification link is no longer valid.' },
        );
      })
      .catch((error: unknown) => {
        setState({
          kind: 'failed',
          message: ApiError.is(error) ? error.message : 'Verification failed.',
        });
      });
  }, [token]);

  return (
    <AuthShell title="Email verification">
      <div className="flex flex-col gap-4">
        {state.kind === 'verifying' || state.kind === 'idle' ? (
          <div className="flex justify-center rounded-md border border-border bg-inset py-6">
            <Spinner label="Verifying your email address" />
          </div>
        ) : null}
        {state.kind === 'verified' ? (
          <FormNotice tone="success">
            <span className="font-medium">{state.email}</span> is verified. You can sign in now.
          </FormNotice>
        ) : null}
        {state.kind === 'failed' ? <FormNotice>{state.message}</FormNotice> : null}
        <Link
          to="/login"
          className={buttonClassName({
            variant: state.kind === 'verified' ? 'primary' : 'secondary',
            size: 'lg',
            className: 'w-full',
          })}
        >
          Go to sign in
          <Icon name="arrow-right" className="h-4 w-4" />
        </Link>
      </div>
    </AuthShell>
  );
}
