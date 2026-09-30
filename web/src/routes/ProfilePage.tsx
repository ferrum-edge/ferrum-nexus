import { useSearch } from '@tanstack/react-router';
import { useState, type FormEvent, type ReactElement } from 'react';
import { isSsoErrorReason, MIN_PASSWORD_LENGTH } from '@ferrum-nexus/shared';
import { formatDateTime } from '../lib/format';
import { SSO_ERROR_MESSAGES } from '../lib/sso-errors';
import { useSsoConfig } from '../hooks/useBranding';
import { useMyIdentities, useStartSsoLink, useUpdateProfile } from '../hooks/useUsers';
import { useAuth } from '../stores/auth';
import { useToast } from '../stores/toast';
import { Button } from '../components/ui/Button';
import { Card, CardBody, CardHeader, PageHeader } from '../components/ui/Card';
import { Icon } from '../components/ui/Icon';
import { LabeledInput } from '../components/ui/Input';
import { RoleBadge, StatusPill } from '../components/ui/StatusPill';
import { FormNotice } from '../components/auth/AuthShell';
import { PasswordField } from '../components/auth/PasswordField';

/** Initials for the identity tile: first letters of up to two words. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] ?? ''}${parts[parts.length - 1]![0] ?? ''}`.toUpperCase();
}

/**
 * The account's single sign-on links, and a button per provider it is not
 * linked at yet. Linking here is the only way an administrator's account is
 * ever linked: sign-in never links one automatically.
 */
function LinkedSignIn(): ReactElement | null {
  const { data: sso } = useSsoConfig();
  const { data: identities } = useMyIdentities();
  const startLink = useStartSsoLink();
  // `?sso_error=` is how a refused link comes back to this page.
  const search: { sso_error?: unknown } = useSearch({ strict: false });
  const refusal = isSsoErrorReason(search.sso_error) ? SSO_ERROR_MESSAGES[search.sso_error] : null;

  const providers = sso?.providers ?? [];
  const links = identities?.items ?? [];
  if (providers.length === 0 && links.length === 0 && refusal === null) return null;
  const names = new Map(providers.map((provider) => [provider.id, provider.display_name]));
  const linked = new Set(links.map((identity) => identity.provider_id));
  const unlinked = providers.filter((provider) => !linked.has(provider.id));

  return (
    <Card className="mt-6">
      <CardHeader
        icon="link"
        title="Linked sign-in"
        description="Identity providers you can use to sign in to this account."
      />
      <CardBody>
        <div className="flex flex-col gap-4">
          {refusal ? <FormNotice>{refusal}</FormNotice> : null}
          {links.length === 0 ? (
            <p className="text-sm text-fg-muted">No identity provider is linked yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {links.map((identity) => (
                <li
                  key={identity.id}
                  className="flex flex-wrap items-center justify-between gap-2 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-fg">
                      {names.get(identity.provider_id) ?? identity.provider_id}
                    </p>
                    <p className="truncate text-xs text-fg-muted">
                      {identity.email ?? identity.subject}
                    </p>
                  </div>
                  <span className="text-xs text-fg-subtle tabular-nums">
                    Last used {formatDateTime(identity.last_login_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {unlinked.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {unlinked.map((provider) => (
                <Button
                  key={provider.id}
                  type="button"
                  loading={startLink.isPending && startLink.variables === provider.id}
                  onClick={() => startLink.mutate(provider.id)}
                >
                  Link {provider.display_name}
                </Button>
              ))}
            </div>
          ) : null}
        </div>
      </CardBody>
    </Card>
  );
}

/** Self-service profile and password management. */
export function ProfilePage(): ReactElement {
  const { user, refresh } = useAuth();
  const updateProfile = useUpdateProfile();
  const toast = useToast();

  const [displayName, setDisplayName] = useState(user?.display_name ?? '');
  const [company, setCompany] = useState(user?.company ?? '');
  const [phone, setPhone] = useState(user?.phone ?? '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);

  if (!user) return <PageHeader title="Profile" />;

  const saveProfile = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    updateProfile.mutate(
      {
        display_name: displayName.trim(),
        company: company.trim() || null,
        phone: phone.trim() || null,
      },
      {
        onSuccess: () => {
          toast.success('Profile updated');
          void refresh();
        },
      },
    );
  };

  const savePassword = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setPasswordError(null);
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setPasswordError(`Passwords must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    updateProfile.mutate(
      { current_password: currentPassword, new_password: newPassword },
      {
        onSuccess: () => {
          setCurrentPassword('');
          setNewPassword('');
          toast.success('Password changed');
        },
      },
    );
  };

  return (
    <>
      <PageHeader title="Profile" description="Your account details and contact information." />

      <Card className="mb-6 overflow-hidden">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-4 px-5 py-5">
          <span
            aria-hidden="true"
            className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-accent-soft text-lg font-semibold text-accent-text ring-1 ring-accent/20"
          >
            {initials(user.display_name)}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-lg font-semibold tracking-tight text-fg">
              {user.display_name}
            </p>
            <p className="truncate text-sm text-fg-muted">{user.email}</p>
          </div>
          <div className="flex w-full shrink-0 flex-wrap items-center gap-1.5 sm:w-auto">
            <RoleBadge role={user.role} />
            <StatusPill status={user.status} />
          </div>
        </div>
        {/* Hairline-separated facts: one `bg-border` gap between surface cells. */}
        <dl className="grid gap-px border-t border-border bg-border sm:grid-cols-3">
          <div className="bg-surface px-5 py-3">
            <dt className="text-[0.7rem] font-semibold tracking-[0.08em] text-fg-subtle uppercase">
              Member since
            </dt>
            <dd className="mt-0.5 text-sm text-fg tabular-nums">
              {formatDateTime(user.created_at)}
            </dd>
          </div>
          <div className="bg-surface px-5 py-3">
            <dt className="text-[0.7rem] font-semibold tracking-[0.08em] text-fg-subtle uppercase">
              Last sign-in
            </dt>
            <dd className="mt-0.5 text-sm text-fg tabular-nums">
              {formatDateTime(user.last_login_at)}
            </dd>
          </div>
          <div className="bg-surface px-5 py-3">
            <dt className="text-[0.7rem] font-semibold tracking-[0.08em] text-fg-subtle uppercase">
              Email address
            </dt>
            <dd className="mt-0.5 text-sm">
              {user.email_verified ? (
                <span className="inline-flex items-center gap-1.5 text-success">
                  <Icon name="check" className="h-4 w-4" />
                  Verified
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-warning">
                  <Icon name="alert" className="h-4 w-4" />
                  Not verified
                </span>
              )}
            </dd>
          </div>
        </dl>
      </Card>

      <div className="grid items-start gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader
            icon="user"
            title="Contact details"
            description="How providers and administrators reach you."
          />
          <CardBody>
            <form className="flex flex-col gap-4" onSubmit={saveProfile}>
              {updateProfile.error && updateProfile.variables?.display_name !== undefined ? (
                <FormNotice>{updateProfile.error.message}</FormNotice>
              ) : null}
              <LabeledInput
                label="Display name"
                required
                hint="Shown on your access requests and in conversations."
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
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
              <div>
                <Button type="submit" variant="primary" loading={updateProfile.isPending}>
                  Save changes
                </Button>
              </div>
            </form>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            icon="lock"
            title="Change password"
            description="Choose a new password for this account."
          />
          <CardBody>
            <form className="flex flex-col gap-4" onSubmit={savePassword}>
              {updateProfile.error && updateProfile.variables?.new_password !== undefined ? (
                <FormNotice>{updateProfile.error.message}</FormNotice>
              ) : null}
              <PasswordField
                label="Current password"
                autoComplete="current-password"
                required
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
              />
              <PasswordField
                label="New password"
                autoComplete="new-password"
                required
                minLength={MIN_PASSWORD_LENGTH}
                error={passwordError}
                hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
              />
              <div>
                <Button type="submit" variant="primary" loading={updateProfile.isPending}>
                  Change password
                </Button>
              </div>
            </form>
          </CardBody>
        </Card>
      </div>

      <LinkedSignIn />
    </>
  );
}
