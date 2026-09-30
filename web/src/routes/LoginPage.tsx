import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useCallback, useEffect, useState, type FormEvent, type ReactElement } from 'react';
import { ERROR_CODES, type SsoErrorReason } from '@ferrum-nexus/shared';
import { AuthShell, FormNotice } from '../components/auth/AuthShell';
import { CaptchaWidget } from '../components/auth/CaptchaWidget';
import { PasswordField } from '../components/auth/PasswordField';
import { ResendVerification } from '../components/auth/ResendVerification';
import { Button, buttonClassName } from '../components/ui/Button';
import { Icon } from '../components/ui/Icon';
import { LabeledInput } from '../components/ui/Input';
import { useCaptchaConfig, useSsoConfig } from '../hooks/useBranding';
import { ApiError, ssoStartUrl } from '../lib/api';
import { useAuth } from '../stores/auth';

/**
 * What to tell the visitor when single sign-on sent them back refused. The
 * server reports a reason from a closed set, never the provider's own text.
 */
export const SSO_ERROR_MESSAGES: Readonly<Record<SsoErrorReason, string>> = {
  sso_disabled: 'Single sign-on is not available for that provider.',
  provider_unavailable:
    'The identity provider could not be reached or is misconfigured. Try again, or contact an administrator.',
  invalid_state:
    'That sign-in attempt expired or did not start in this browser. Please start again.',
  idp_error: 'The identity provider did not complete the sign-in.',
  token_invalid: 'The identity provider’s answer could not be verified. Please try again.',
  email_required: 'The identity provider did not share an email address for your account.',
  email_domain_not_allowed: 'Your email domain is not allowed to sign in to this portal.',
  email_not_verified: 'The identity provider has not verified your email address.',
  account_exists:
    'An account with this email address already exists and could not be linked automatically. Sign in with your password, or ask an administrator.',
  access_denied: 'Your account at the identity provider does not grant access to this portal.',
  account_disabled: 'This account has been disabled.',
  signup_disabled: 'No portal account is linked to this identity, and sign-up through it is off.',
  server_error: 'Single sign-on failed. Please try again.',
};

const BREAK_GLASS_NOTICE =
  'This portal uses single sign-on. Password sign-in is open to super admins only, for recovery.';

const NO_WAY_IN_NOTICE =
  'Password sign-in is disabled and no single sign-on provider is available. Contact an administrator.';

/** Sign-in form, with a button per single sign-on provider. */
export function LoginPage(): ReactElement {
  const { status, login } = useAuth();
  const navigate = useNavigate();
  const { data: captcha } = useCaptchaConfig();
  const { data: sso } = useSsoConfig();
  // Set by the reset page, which cannot show its own confirmation: completing a
  // reset destroys every session, so the visitor is bounced straight here.
  // `sso_error` is set by a refused single sign-on callback.
  const { reset: passwordWasReset, sso_error: ssoError } = useSearch({ from: '/login' });

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [breakGlassOpen, setBreakGlassOpen] = useState(false);

  const onToken = useCallback((token: string | null) => setCaptchaToken(token), []);

  // An already-signed-in visitor who lands here is bounced to the dashboard.
  useEffect(() => {
    if (status === 'authenticated') void navigate({ to: '/', replace: true });
  }, [status, navigate]);

  const providers = sso?.providers ?? [];
  // Until the policy is known the form is offered, as it always was.
  const passwordLogin = sso?.password_login ?? 'enabled';
  const showPasswordForm =
    passwordLogin === 'enabled' || (passwordLogin === 'break_glass' && breakGlassOpen);
  const registrationEnabled = sso?.registration_enabled ?? true;

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
        registrationEnabled ? (
          <>
            Need an account?{' '}
            <Link to="/register" className="text-accent-text hover:underline">
              Register
            </Link>
          </>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-4">
        {ssoError && !error ? (
          <FormNotice tone="danger">{SSO_ERROR_MESSAGES[ssoError]}</FormNotice>
        ) : null}

        {/* Full navigations, not fetches: the server answers with a redirect. */}
        {providers.length > 0 ? (
          <div className="flex flex-col gap-2">
            {providers.map((provider) => (
              <a
                key={provider.id}
                href={ssoStartUrl(provider.id)}
                className={buttonClassName({
                  variant: 'secondary',
                  size: 'lg',
                  className: 'w-full',
                })}
              >
                <Icon name="shield" className="h-4 w-4" />
                <span>Continue with {provider.display_name}</span>
              </a>
            ))}
          </div>
        ) : null}

        {providers.length > 0 && showPasswordForm ? (
          <div className="flex items-center gap-3 text-xs text-fg-subtle" aria-hidden="true">
            <span className="h-px flex-1 bg-border" />
            <span>or</span>
            <span className="h-px flex-1 bg-border" />
          </div>
        ) : null}

        {passwordLogin === 'break_glass' && !breakGlassOpen ? (
          <Button variant="link" className="self-center" onClick={() => setBreakGlassOpen(true)}>
            Administrator sign-in with a password
          </Button>
        ) : null}

        {passwordLogin === 'disabled' && providers.length === 0 ? (
          <FormNotice tone="warning">{NO_WAY_IN_NOTICE}</FormNotice>
        ) : null}

        {showPasswordForm ? (
          <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
            {passwordWasReset && !error ? (
              <FormNotice tone="success">
                Your password has been changed. Sign in with the new one.
              </FormNotice>
            ) : null}

            {passwordLogin === 'break_glass' ? (
              <FormNotice tone="info">{BREAK_GLASS_NOTICE}</FormNotice>
            ) : null}

            {error ? (
              <FormNotice
                tone={error.code === ERROR_CODES.EMAIL_NOT_VERIFIED ? 'warning' : 'danger'}
              >
                {error.code === ERROR_CODES.EMAIL_NOT_VERIFIED ? (
                  <div className="flex flex-col gap-1">
                    <span>
                      <span className="font-medium">Verify your email address.</span> Open the
                      verification link we sent you, then sign in again.
                    </span>
                    <ResendVerification email={email} />
                  </div>
                ) : (
                  error.message
                )}
              </FormNotice>
            ) : null}

            <LabeledInput
              label="Email"
              type="email"
              autoComplete="email"
              placeholder="you@company.com"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <div className="flex flex-col gap-1.5">
              <PasswordField
                label="Password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <Link
                to="/forgot-password"
                className="self-end text-xs text-accent-text hover:underline"
              >
                Forgot password?
              </Link>
            </div>

            <CaptchaWidget config={captcha} onToken={onToken} />

            <Button
              type="submit"
              variant="primary"
              size="lg"
              className="w-full"
              loading={submitting}
            >
              Sign in
              <Icon name="arrow-right" className="h-4 w-4" />
            </Button>
          </form>
        ) : null}
      </div>
    </AuthShell>
  );
}
