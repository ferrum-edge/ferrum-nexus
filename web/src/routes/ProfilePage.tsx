import { useState, type FormEvent, type ReactElement } from 'react';
import { MIN_PASSWORD_LENGTH } from '@ferrum-nexus/shared';
import { formatDateTime } from '../lib/format';
import { useUpdateProfile } from '../hooks/useUsers';
import { useAuth } from '../stores/auth';
import { useToast } from '../stores/toast';
import { Button } from '../components/ui/Button';
import { Card, CardBody, CardHeader, DetailRow, PageHeader } from '../components/ui/Card';
import { LabeledInput } from '../components/ui/Input';
import { RoleBadge, StatusPill } from '../components/ui/StatusPill';

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

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Account" />
          <CardBody>
            <dl>
              <DetailRow label="Email">{user.email}</DetailRow>
              <DetailRow label="Role">
                <RoleBadge role={user.role} />
              </DetailRow>
              <DetailRow label="Status">
                <StatusPill status={user.status} />
              </DetailRow>
              <DetailRow label="Email verified">{user.email_verified ? 'Yes' : 'No'}</DetailRow>
              <DetailRow label="Last sign-in">{formatDateTime(user.last_login_at)}</DetailRow>
              <DetailRow label="Member since">{formatDateTime(user.created_at)}</DetailRow>
            </dl>
          </CardBody>
        </Card>

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader title="Contact details" />
            <CardBody>
              <form className="flex flex-col gap-4" onSubmit={saveProfile}>
                <LabeledInput
                  label="Display name"
                  required
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                />
                <LabeledInput
                  label="Company"
                  value={company}
                  onChange={(event) => setCompany(event.target.value)}
                />
                <LabeledInput
                  label="Phone"
                  type="tel"
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
            <CardHeader title="Change password" />
            <CardBody>
              <form className="flex flex-col gap-4" onSubmit={savePassword}>
                <LabeledInput
                  label="Current password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                />
                <LabeledInput
                  label="New password"
                  type="password"
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
      </div>
    </>
  );
}
