import { useState, type ReactElement } from 'react';
import { ApiError, authApi } from '../../lib/api';
import { Button } from '../ui/Button';

export interface ResendVerificationProps {
  /** Address to re-send to. Blank disables the control. */
  email: string;
}

/**
 * "Send it again" for a verification link the visitor never received.
 *
 * The API answers `ok` for an unknown address, a disabled account and one that
 * is already verified, so the acknowledgement here is worded as a conditional —
 * dropping into this control from a login form would otherwise make it a
 * convenient account-existence probe.
 */
export function ResendVerification({ email }: ResendVerificationProps): ReactElement {
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);

  const send = async (): Promise<void> => {
    setError(null);
    setState('sending');
    try {
      await authApi.resendVerification({ email: email.trim() });
      setState('sent');
    } catch (caught) {
      setState('idle');
      setError(ApiError.is(caught) ? caught.message : 'Could not send the link.');
    }
  };

  if (state === 'sent') {
    return (
      <p className="text-sm text-fg-muted">
        If that address needs verifying, a new link is on its way. It expires in 24 hours.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Button
        variant="link"
        size="sm"
        className="self-start"
        loading={state === 'sending'}
        disabled={email.trim().length === 0}
        onClick={() => void send()}
      >
        Resend the verification email
      </Button>
      {error ? <p className="text-xs text-danger">{error}</p> : null}
    </div>
  );
}
