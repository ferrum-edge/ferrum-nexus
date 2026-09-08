import { Link, useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useState, type FormEvent, type ReactElement } from 'react';
import {
  MIN_PASSWORD_LENGTH,
  REGISTRABLE_ROLES,
  ROLE_LABELS,
  type RegistrableRole,
} from '@ferrum-nexus/shared';
import { AuthShell, FormNotice } from '../components/auth/AuthShell';
import { CaptchaWidget } from '../components/auth/CaptchaWidget';
import { ResendVerification } from '../components/auth/ResendVerification';
import { Button } from '../components/ui/Button';
import { LabeledInput } from '../components/ui/Input';
import { LabeledSelect } from '../components/ui/Select';
import { useBranding, useCaptchaConfig } from '../hooks/useBranding';
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
  const branding = useBranding().data;
  // True only while the portal has no active super_admin: this registration
  // seats one, so it has to carry the operator's bootstrap token.
  const bootstrapRequired = branding?.bootstrap_required === true;
  // The administrator can narrow which roles a visitor may self-select, and
  // `POST /api/auth/register` answers 403 for one that is not on the list — so
  // the form offers exactly what the policy allows rather than a constant. The
  // founding registration bypasses the policy, and a server that predates the
  // field leaves it undefined, so both fall back to the full set.
  const policyRoles = branding?.registration?.allowed_roles;
  const allowedRoles: ReadonlyArray<RegistrableRole> =
    bootstrapRequired || policyRoles === undefined ? REGISTRABLE_ROLES : policyRoles;
  // A policy that allows exactly one role has nothing to choose between, so the
  // form states the outcome instead of offering a select with a single option.
  const soleRole = allowedRoles.length === 1 ? allowedRoles[0] : undefined;
  const navigate = useNavigate();

  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [company, setCompany] = useState('');
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState<RegistrableRole>('client');
  const [bootstrapToken, setBootstrapToken] = useState('');
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<{ verificationRequired: boolean } | null>(null);

  const onToken = useCallback((token: string | null) => setCaptchaToken(token), []);

  // An already-signed-in visitor who lands here is bounced to the dashboard.
  useEffect(() => {
    if (status === 'authenticated') void navigate({ to: '/', replace: true });
  }, [status, navigate]);

  // The policy can arrive after the first render, and can exclude the default.
  useEffect(() => {
    const fallback = allowedRoles[0];
    if (fallback !== undefined && !allowedRoles.includes(role)) setRole(fallback);
  }, [allowedRoles, role]);

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
        ...(bootstrapRequired ? { bootstrap_token: bootstrapToken.trim() } : {}),
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
          {done.verificationRequired ? <ResendVerification email={email} /> : null}
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

        {bootstrapRequired ? (
          <>
            <FormNotice tone="warning">
              This portal has no super-admin yet, so this registration becomes its super-admin.
            </FormNotice>
            <LabeledInput
              label="Bootstrap token"
              type="password"
              autoComplete="off"
              required
              hint="Printed in the server log at startup, or the value of NEXUS_BOOTSTRAP_TOKEN."
              value={bootstrapToken}
              onChange={(event) => setBootstrapToken(event.target.value)}
            />
          </>
        ) : null}

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
        {allowedRoles.length === 0 ? (
          <FormNotice tone="warning">
            This portal is not accepting self-service accounts of any type at the moment. Ask an
            administrator to create one for you.
          </FormNotice>
        ) : soleRole ? (
          <p className="rounded-md border border-border bg-inset p-3 text-sm text-fg-muted">
            New accounts on this portal are created as{' '}
            <strong className="font-medium text-fg">{ROLE_LABELS[soleRole]}</strong>.{' '}
            {ROLE_DESCRIPTIONS[soleRole]}
          </p>
        ) : (
          <LabeledSelect<RegistrableRole>
            label="Account type"
            value={role}
            onValueChange={setRole}
            options={allowedRoles.map((value) => ({
              value,
              label: ROLE_LABELS[value],
              description: ROLE_DESCRIPTIONS[value],
            }))}
            hint="Administrator roles are granted by an existing admin."
          />
        )}
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

        <Button
          type="submit"
          variant="primary"
          size="lg"
          loading={submitting}
          disabled={allowedRoles.length === 0}
        >
          Create account
        </Button>
      </form>
    </AuthShell>
  );
}
