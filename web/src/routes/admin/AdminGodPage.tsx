import { useState, type ReactElement, type ReactNode } from 'react';
import { MAX_PAGE_SIZE, ROLE_LABELS } from '@ferrum-nexus/shared';
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
import {
  AudienceFields,
  EVERYONE,
  audienceFrom,
  audienceReady,
  describeAudience,
  type AudienceDraft,
} from '../../components/admin/AudienceFields';
import { RoleGuard } from '../../components/layout/RoleGuard';
import { FormNotice } from '../../components/auth/AuthShell';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardBody, PageHeader } from '../../components/ui/Card';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Checkbox, LabeledInput, LabeledTextarea } from '../../components/ui/Input';
import { LabeledSelect } from '../../components/ui/Select';
import { Icon, type IconName } from '../../components/ui/Icon';

const LIST_LIMIT = Math.min(MAX_PAGE_SIZE, 200);

/**
 * The header every emergency panel wears.
 *
 * `CardHeader`'s icon tile is accent-toned, which reads as "a feature"; these
 * four are not features, so the tile is tinted with the danger token instead
 * and the phrase that follows says what the action costs in one line.
 */
function DangerCardHeader({
  icon,
  title,
  description,
}: {
  icon: IconName;
  title: string;
  description: string;
}): ReactElement {
  return (
    <div className="flex items-start gap-3 border-b border-border px-5 py-4">
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-danger-soft text-danger">
        <Icon name={icon} className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-fg">{title}</h2>
        <p className="mt-1 text-sm text-fg-muted">{description}</p>
      </div>
    </div>
  );
}

/** The action row every emergency panel ends with. */
function DangerCardFooter({ hint, children }: { hint: string; children: ReactNode }): ReactElement {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-inset/40 px-5 py-3">
      <p className="text-xs text-fg-subtle">{hint}</p>
      {children}
    </div>
  );
}

const CONFIRMATION_HINT = 'Asks for a typed confirmation phrase.';

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
        <DangerCardHeader
          icon="grant"
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
          <LabeledInput
            label="Grant ID"
            value={grantId}
            onChange={(event) => setGrantId(event.target.value.trim())}
            hint="The picker lists recent records. Paste an exact ID to target a record beyond that page."
          />
          <LabeledTextarea
            label="Reason"
            required
            rows={3}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            hint="Recorded in the audit log."
          />
        </CardBody>
        <DangerCardFooter hint={CONFIRMATION_HINT}>
          <Button
            variant="danger"
            disabled={!grantId || reason.trim().length === 0}
            onClick={() => setOpen(true)}
          >
            Revoke grant
          </Button>
        </DangerCardFooter>
      </Card>

      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Revoke this grant"
        description={`Grant ${grantId} loses gateway access when Edge applies the change.`}
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
        <DangerCardHeader
          icon="trash"
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
          <LabeledInput
            label="API ID"
            value={apiId}
            onChange={(event) => setApiId(event.target.value.trim())}
            hint="The picker lists recent records. Paste an exact ID to target a record beyond that page."
          />
          <LabeledTextarea
            label="Reason"
            required
            rows={3}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            hint="Recorded in the audit log."
          />
          <Checkbox
            label="Also revoke every active grant for this API"
            checked={revokeGrants}
            onChange={(event) => setRevokeGrants(event.target.checked)}
          />
        </CardBody>
        <DangerCardFooter hint={CONFIRMATION_HINT}>
          <Button
            variant="danger"
            disabled={!apiId || reason.trim().length === 0}
            onClick={() => setOpen(true)}
          >
            Delete API
          </Button>
        </DangerCardFooter>
      </Card>

      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Delete ${selected?.name ?? 'this API'}`}
        description={`API ${apiId} will be deleted. Calls will receive gateway 404s.`}
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
        <DangerCardHeader
          icon="user"
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
          <LabeledInput
            label="Account ID"
            value={userId}
            onChange={(event) => setUserId(event.target.value.trim())}
            hint="The picker lists recent records. Paste an exact ID to target a record beyond that page."
          />
          <LabeledTextarea
            label="Reason"
            required
            rows={3}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            hint="Recorded in the audit log."
          />
          <Checkbox
            label="Also revoke every grant held by this account"
            checked={revokeGrants}
            onChange={(event) => setRevokeGrants(event.target.checked)}
          />
        </CardBody>
        <DangerCardFooter hint={CONFIRMATION_HINT}>
          <Button
            variant="danger"
            disabled={!userId || reason.trim().length === 0}
            onClick={() => setOpen(true)}
          >
            Disable account
          </Button>
        </DangerCardFooter>
      </Card>

      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Disable ${selected?.display_name ?? 'this account'}`}
        description={`Account ${userId} will be signed out and blocked from signing in.`}
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

function broadcastEmailBatchId(): string {
  // getRandomValues also supports the portal's plain-HTTP deployments.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function BroadcastPanel(): ReactElement {
  const broadcast = useGodBroadcast();
  const toast = useToast();
  const [audience, setAudience] = useState<AudienceDraft>(EVERYONE);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sendEmail, setSendEmail] = useState(false);
  const [open, setOpen] = useState(false);
  const [emailBatch, setEmailBatch] = useState(broadcastEmailBatchId);

  return (
    <>
      <Card>
        <DangerCardHeader
          icon="megaphone"
          title="Platform broadcast"
          description="Creates an in-app notification (and optionally an email) for every account in the audience."
        />
        <CardBody className="flex flex-col gap-4">
          {/* No "add myself": the server excludes the acting super admin. */}
          <AudienceFields name="broadcast" value={audience} onChange={setAudience} />
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
            description="Queued in the outbox alongside the in-app notification."
            checked={sendEmail}
            onChange={(event) => setSendEmail(event.target.checked)}
          />
        </CardBody>
        <DangerCardFooter hint={`Reaches ${describeAudience(audience)}, except you.`}>
          <Button
            variant="danger"
            disabled={
              subject.trim().length === 0 || body.trim().length === 0 || !audienceReady(audience)
            }
            onClick={() => setOpen(true)}
          >
            Broadcast
          </Button>
        </DangerCardFooter>
      </Card>

      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Send this broadcast?"
        description={`This reaches ${describeAudience(audience)}, except you. It cannot be recalled.`}
        confirmLabel="Broadcast"
        danger
        confirmPhrase="BROADCAST"
        loading={broadcast.isPending}
        onConfirm={() =>
          broadcast.mutate(
            {
              subject: subject.trim(),
              body: body.trim(),
              audience: audienceFrom(audience),
              send_email: sendEmail,
              idempotency_key: emailBatch,
            },
            {
              onSuccess: (response) => {
                setOpen(false);
                setEmailBatch(broadcastEmailBatchId());
                setSubject('');
                setBody('');
                // `delivered` is the audience the message actually reached;
                // per-recipient failures are skipped rather than fatal, so a
                // partial broadcast has to say so instead of reporting the
                // audience size as a success.
                const detail =
                  response.failed > 0
                    ? `${response.delivered} account(s) reached, ${response.failed} failed.`
                    : `${response.delivered} account(s) notified.`;
                if (response.failed > 0) toast.error('Broadcast partly delivered', detail);
                else toast.success('Broadcast sent', detail);
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
        meta={
          <Badge tone="danger" dot>
            Super admin only
          </Badge>
        }
      />
      <div className="mb-6">
        <FormNotice tone="danger">
          These operations take effect on the gateway immediately and cannot be undone from the
          portal. Each one requires you to type a confirmation phrase.
        </FormNotice>
      </div>

      <div className="grid items-start gap-6 xl:grid-cols-2">
        <RevokeGrantPanel />
        <DeleteApiPanel />
        <DisableUserPanel />
        <BroadcastPanel />
      </div>
    </RoleGuard>
  );
}
