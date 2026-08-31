import { useState, type ReactElement } from 'react';
import {
  MAX_PAGE_SIZE,
  ROLE_LABELS,
  type MassEmailAudience,
  type Role,
} from '@ferrum-nexus/shared';
import { useApis } from '../../hooks/useApis';
import { useGrants } from '../../hooks/useGrants';
import { useUsers } from '../../hooks/useUsers';
import {
  useGodBroadcast,
  useGodDeleteApi,
  useGodDisableUser,
  useGodRevokeGrant,
} from '../../hooks/useGodMode';
import { useToast } from '../../stores/toast';
import { RoleGuard } from '../../components/layout/RoleGuard';
import { Button } from '../../components/ui/Button';
import { Card, CardBody, CardHeader, PageHeader } from '../../components/ui/Card';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Checkbox, LabeledInput, LabeledTextarea } from '../../components/ui/Input';
import { LabeledSelect } from '../../components/ui/Select';
import { Icon } from '../../components/ui/Icon';

const LIST_LIMIT = Math.min(MAX_PAGE_SIZE, 200);

function RevokeGrantPanel(): ReactElement {
  const grants = useGrants({ status: 'active', limit: LIST_LIMIT });
  const revoke = useGodRevokeGrant();
  const toast = useToast();
  const [grantId, setGrantId] = useState('');
  const [reason, setReason] = useState('');
  const [open, setOpen] = useState(false);

  const options = (grants.data?.items ?? []).map((grant) => ({
    value: grant.id,
    label: `${grant.api?.name ?? grant.api_id} → ${grant.user?.display_name ?? grant.user_id}`,
    description: grant.acl_group,
  }));

  return (
    <>
      <Card>
        <CardHeader
          title="Emergency grant revocation"
          description="Removes the ACL group from the consumer immediately, bypassing API ownership."
        />
        <CardBody className="flex flex-col gap-4">
          <LabeledSelect
            label="Grant"
            value={grantId}
            onValueChange={setGrantId}
            options={options}
            placeholder={options.length === 0 ? 'No active grants' : 'Select a grant…'}
          />
          <LabeledTextarea
            label="Reason"
            required
            rows={3}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            hint="Recorded in the audit log."
          />
          <div>
            <Button
              variant="danger"
              disabled={!grantId || reason.trim().length === 0}
              onClick={() => setOpen(true)}
            >
              Revoke grant
            </Button>
          </div>
        </CardBody>
      </Card>

      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Revoke this grant"
        description="The consumer loses gateway access to the API as soon as Edge applies the change."
        confirmLabel="Revoke grant"
        danger
        confirmPhrase="REVOKE"
        loading={revoke.isPending}
        onConfirm={() =>
          revoke.mutate(
            { grant_id: grantId, reason: reason.trim() },
            {
              onSuccess: () => {
                setOpen(false);
                setGrantId('');
                setReason('');
                toast.success('Grant revoked');
              },
            },
          )
        }
      />
    </>
  );
}

function DeleteApiPanel(): ReactElement {
  const apis = useApis({ mine: false, limit: LIST_LIMIT });
  const remove = useGodDeleteApi();
  const toast = useToast();
  const [apiId, setApiId] = useState('');
  const [reason, setReason] = useState('');
  const [revokeGrants, setRevokeGrants] = useState(true);
  const [open, setOpen] = useState(false);

  const selected = (apis.data?.items ?? []).find((api) => api.id === apiId);

  return (
    <>
      <Card>
        <CardHeader
          title="Delete an API"
          description="Removes the catalog entry, its Edge proxy and every plugin attached to it."
        />
        <CardBody className="flex flex-col gap-4">
          <LabeledSelect
            label="API"
            value={apiId}
            onValueChange={setApiId}
            options={(apis.data?.items ?? []).map((api) => ({
              value: api.id,
              label: api.name,
              description: `/${api.slug} · v${api.version}`,
            }))}
            placeholder="Select an API…"
          />
          <LabeledTextarea
            label="Reason"
            required
            rows={3}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <Checkbox
            label="Also revoke every active grant for this API"
            checked={revokeGrants}
            onChange={(event) => setRevokeGrants(event.target.checked)}
          />
          <div>
            <Button
              variant="danger"
              disabled={!apiId || reason.trim().length === 0}
              onClick={() => setOpen(true)}
            >
              Delete API
            </Button>
          </div>
        </CardBody>
      </Card>

      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Delete ${selected?.name ?? 'this API'}`}
        description="This cannot be undone. Every consumer calling it starts receiving 404s from the gateway."
        confirmLabel="Delete API"
        danger
        confirmPhrase={selected?.slug ?? 'DELETE'}
        loading={remove.isPending}
        onConfirm={() =>
          remove.mutate(
            { api_id: apiId, reason: reason.trim(), revoke_grants: revokeGrants },
            {
              onSuccess: (response) => {
                setOpen(false);
                setApiId('');
                setReason('');
                toast.success(
                  'API deleted',
                  `${response.revoked_grants} grant(s) revoked alongside it.`,
                );
              },
            },
          )
        }
      />
    </>
  );
}

function DisableUserPanel(): ReactElement {
  const users = useUsers({ status: 'active', limit: LIST_LIMIT });
  const disable = useGodDisableUser();
  const toast = useToast();
  const [userId, setUserId] = useState('');
  const [reason, setReason] = useState('');
  const [revokeGrants, setRevokeGrants] = useState(false);
  const [open, setOpen] = useState(false);

  const selected = (users.data?.items ?? []).find((user) => user.id === userId);

  return (
    <>
      <Card>
        <CardHeader
          title="Disable an account"
          description="Terminates every session for the account. Refused for the last active super admin."
        />
        <CardBody className="flex flex-col gap-4">
          <LabeledSelect
            label="Account"
            value={userId}
            onValueChange={setUserId}
            options={(users.data?.items ?? []).map((user) => ({
              value: user.id,
              label: user.display_name,
              description: `${user.email} · ${ROLE_LABELS[user.role]}`,
            }))}
            placeholder="Select an account…"
          />
          <LabeledTextarea
            label="Reason"
            required
            rows={3}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <Checkbox
            label="Also revoke every grant held by this account"
            checked={revokeGrants}
            onChange={(event) => setRevokeGrants(event.target.checked)}
          />
          <div>
            <Button
              variant="danger"
              disabled={!userId || reason.trim().length === 0}
              onClick={() => setOpen(true)}
            >
              Disable account
            </Button>
          </div>
        </CardBody>
      </Card>

      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Disable ${selected?.display_name ?? 'this account'}`}
        description="The user is signed out everywhere and can no longer sign in."
        confirmLabel="Disable account"
        danger
        confirmPhrase={selected?.email ?? 'DISABLE'}
        loading={disable.isPending}
        onConfirm={() =>
          disable.mutate(
            { user_id: userId, reason: reason.trim(), revoke_grants: revokeGrants },
            {
              onSuccess: (response) => {
                setOpen(false);
                setUserId('');
                setReason('');
                toast.success(
                  'Account disabled',
                  `${response.terminated_sessions} session(s) terminated.`,
                );
              },
            },
          )
        }
      />
    </>
  );
}

type BroadcastChoice = 'all' | 'client' | 'provider' | 'admin';

function audienceFor(choice: BroadcastChoice): MassEmailAudience {
  if (choice === 'all') return { scope: 'all' };
  return { scope: 'filtered', roles: [choice as Role], status: 'active' };
}

function BroadcastPanel(): ReactElement {
  const broadcast = useGodBroadcast();
  const toast = useToast();
  const [choice, setChoice] = useState<BroadcastChoice>('all');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sendEmail, setSendEmail] = useState(false);
  const [open, setOpen] = useState(false);

  return (
    <>
      <Card>
        <CardHeader
          title="Platform broadcast"
          description="Creates an in-app notification (and optionally an email) for every account in the audience."
        />
        <CardBody className="flex flex-col gap-4">
          <LabeledSelect<BroadcastChoice>
            label="Audience"
            value={choice}
            onValueChange={setChoice}
            options={[
              { value: 'all', label: 'Everyone' },
              { value: 'client', label: ROLE_LABELS.client },
              { value: 'provider', label: ROLE_LABELS.provider },
              { value: 'admin', label: ROLE_LABELS.admin },
            ]}
          />
          <LabeledInput
            label="Subject"
            required
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
          />
          <LabeledTextarea
            label="Message"
            required
            rows={6}
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
          <Checkbox
            label="Also send this as an email"
            checked={sendEmail}
            onChange={(event) => setSendEmail(event.target.checked)}
          />
          <div>
            <Button
              variant="danger"
              disabled={subject.trim().length === 0 || body.trim().length === 0}
              onClick={() => setOpen(true)}
            >
              Broadcast
            </Button>
          </div>
        </CardBody>
      </Card>

      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Send this broadcast?"
        description="Every account in the audience receives it. It cannot be recalled."
        confirmLabel="Broadcast"
        danger
        confirmPhrase="BROADCAST"
        loading={broadcast.isPending}
        onConfirm={() =>
          broadcast.mutate(
            {
              subject: subject.trim(),
              body: body.trim(),
              audience: audienceFor(choice),
              send_email: sendEmail,
            },
            {
              onSuccess: (response) => {
                setOpen(false);
                setSubject('');
                setBody('');
                toast.success('Broadcast sent', `${response.notified} account(s) notified.`);
              },
            },
          )
        }
      />
    </>
  );
}

/** Super-admin emergency controls; every action needs a typed confirmation. */
export function AdminGodPage(): ReactElement {
  return (
    <RoleGuard minRole="super_admin">
      <PageHeader
        title="God mode"
        description="Emergency controls that bypass ownership checks. Every action is audited with the reason you supply."
      />
      <div className="mb-6 flex items-start gap-2.5 rounded-lg border border-danger/40 bg-danger-soft p-4">
        <Icon name="shield" className="mt-0.5 h-4 w-4 text-danger" />
        <p className="text-sm text-fg">
          These operations take effect on the gateway immediately and cannot be undone from the
          portal. Each one requires you to type a confirmation phrase.
        </p>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <RevokeGrantPanel />
        <DeleteApiPanel />
        <DisableUserPanel />
        <BroadcastPanel />
      </div>
    </RoleGuard>
  );
}
