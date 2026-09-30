import type { ReactElement } from 'react';
import type { UpdateNotificationPreferencesRequest } from '@ferrum-nexus/shared';
import { useNotificationPreferences, useUpdateNotificationPreferences } from '../../hooks/useUsers';
import { useToast } from '../../stores/toast';
import { Card, CardBody, CardHeader } from '../ui/Card';
import { Checkbox } from '../ui/Input';
import { LoadingPanel } from '../ui/Spinner';

/**
 * The optional notices an account chooses: today, the two channels of the
 * spec-change notice (issue #447) — in-app, on by default, and email, off
 * until the account turns it on. Each box saves on its own.
 */
export function NotificationPreferencesCard(): ReactElement {
  const query = useNotificationPreferences();
  const update = useUpdateNotificationPreferences();
  const toast = useToast();
  const preferences = query.data?.preferences;

  const save = (patch: UpdateNotificationPreferencesRequest): void => {
    update.mutate(patch, { onSuccess: () => toast.success('Notification preferences saved') });
  };

  return (
    <Card>
      <CardHeader
        icon="bell"
        title="Notifications"
        description="How you hear that an API you have access to has changed."
      />
      <CardBody>
        {query.isLoading ? (
          <LoadingPanel label="Loading preferences" />
        ) : query.isError || !preferences ? (
          <p className="text-sm text-danger" role="alert">
            Your notification preferences could not be loaded. Try again in a moment.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            <Checkbox
              label="Notify me in the portal when an API I use changes its specification"
              description="One notice with what the latest revision changed, until you read it."
              checked={preferences.api_spec_updated_in_app}
              disabled={update.isPending}
              onChange={(event) => save({ api_spec_updated_in_app: event.target.checked })}
            />
            <Checkbox
              label="Email me when an API I use changes its specification"
              description="Off until you turn it on. At most one per API per clock hour."
              checked={preferences.api_spec_updated_email}
              disabled={update.isPending}
              onChange={(event) => save({ api_spec_updated_email: event.target.checked })}
            />
          </div>
        )}
      </CardBody>
    </Card>
  );
}
