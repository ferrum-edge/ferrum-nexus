import { Link, Navigate } from '@tanstack/react-router';
import { useCallback, useState, type FormEvent, type ReactElement } from 'react';
import {
  MIN_PASSWORD_LENGTH,
  REGISTRABLE_ROLES,
  ROLE_LABELS,
  type RegistrableRole,
} from '@ferrum-nexus/shared';
import { AuthShell, FormNotice } from '../components/auth/AuthShell';
import { CaptchaWidget } from '../components/auth/CaptchaWidget';
import { Button } from '../components/ui/Button';
import { LabeledInput } from '../components/ui/Input';
import { LabeledSelect } from '../components/ui/Select';
import { useCaptchaConfig } from '../hooks/useBranding';
import { ApiError } from '../lib/api';
import { useAuth } from '../stores/auth';

const ROLE_DESCRIPTIONS: Readonly<Record<RegistrableRole, string>> = {
  client: 'Consume APIs: browse the catalog, request access, manage credentials.',
  provider: 'Publish APIs: upload specs, review access requests, manage runtime settings.',
};

/** Self-service registration. */
export function RegisterPage(): ReactElement {
  const { status, register } = useAuth();
  const { data: captcha } = useCaptchaConfig();

  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [company, setCompany] = useState('');
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState<RegistrableRole>('client');
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<{ verificationRequired: boolean } | null>(null);

  const onToken = useCallback((token: string | null) => setCaptchaToken(token), []);

  if (status === 'authenticated') return <Navigate to="/" replace />;

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setError(null);
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Passwords must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    setSubmitting(true);
    try {
      const response = await register({
        email: email.trim(),
        password,
        display_name: displayName.trim(),
        role,
        company: company.trim() || null,
        phone: phone.trim() || null,
        ...(captchaToken ? { captcha_token: captchaToken } : {}),
      });
      setDone({ verificationRequired: response.email_verification_required });
    } catch (caught) {
      setError(ApiError.is(caught) ? caught.message : 'Registration failed.');
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <AuthShell title="Account created">
        <div className="flex flex-col gap-4">
          <FormNotice tone="success">
            {done.verificationRequired
              ? 'Check your inbox for a verification link, then sign in.'
              : 'Your account is ready. You can sign in now.'}
          </FormNotice>
          <Link
            to="/login"
            className="inline-flex h-11 items-center justify-center rounded-md bg-accent px-4 text-sm font-medium text-accent-fg hover:bg-accent-hover"
          >
            Go to sign in
          </Link>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Create an account"
      description="Register for portal access to browse and consume published APIs."
      footer={
        <>
          Already registered?{' '}
          <Link to="/login" className="text-accent hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
        {error ? <FormNotice>{error}</FormNotice> : null}

        <LabeledInput
          label="Display name"
          autoComplete="name"
          required
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
        />
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
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <LabeledSelect<RegistrableRole>
          label="Account type"
          value={role}
          onValueChange={setRole}
          options={REGISTRABLE_ROLES.map((value) => ({
            value,
            label: ROLE_LABELS[value],
            description: ROLE_DESCRIPTIONS[value],
          }))}
          hint="Administrator roles are granted by an existing admin."
        />
        <LabeledInput
          label="Company"
          autoComplete="organization"
          value={company}
          onChange={(event) => setCompany(event.target.value)}
        />
        <LabeledInput
          label="Phone"
          type="tel"
          autoComplete="tel"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
        />

        <CaptchaWidget config={captcha} onToken={onToken} />

        <Button type="submit" variant="primary" size="lg" loading={submitting}>
          Create account
        </Button>
      </form>
    </AuthShell>
  );
}
