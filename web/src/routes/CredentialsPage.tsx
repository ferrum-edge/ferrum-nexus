import { useMemo, useState, type ReactElement } from 'react';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  type CredentialMetadata,
  type CredentialType,
  type ShowOnceSecret,
} from '@ferrum-nexus/shared';
import { formatDateTime } from '../lib/format';
import { CREDENTIAL_TYPES, CREDENTIAL_TYPE_LABELS } from '../lib/credential-labels';
import {
  useCredentials,
  useDeleteCredential,
  useIssueCredential,
  useRotateCredential,
} from '../hooks/useCredentials';
import { useGrants } from '../hooks/useGrants';
import { useToast } from '../stores/toast';
import { ShowOnceSecretDialog } from '../components/credentials/ShowOnceSecretDialog';
import { Button } from '../components/ui/Button';
import { Card, CardHeader, PageHeader } from '../components/ui/Card';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { DataTable, type Columns } from '../components/ui/DataTable';
import { Dialog } from '../components/ui/Dialog';
import { EmptyState } from '../components/ui/EmptyState';
import { LabeledInput } from '../components/ui/Input';
import { LabeledSelect } from '../components/ui/Select';
import { StatusPill } from '../components/ui/StatusPill';

interface ShowOnceState {
  secret: ShowOnceSecret;
  consumerUsername: string;
  title: string;
}

/**
 * The APIs this account may call, and where to call them.
 *
 * A credential on its own is unusable without an address, and the address is
 * the gateway's, not this portal's — so the two belong on the same page. When
 * no gateway origin is configured the listen path is shown instead, since that
 * is genuinely all the portal knows.
 */
function MyAccessCard(): ReactElement {
  const grants = useGrants({ mine: true, status: 'active', limit: MAX_PAGE_SIZE });
  const items = grants.data?.items ?? [];

  if (grants.isLoading || items.length === 0) return <></>;

  return (
    <Card className="mt-6">
      <CardHeader
        title="Your API access"
        description="Every API your active grants cover, with the URL to send requests to."
      />
      <ul>
        {items.map((grant) => (
          <li
            key={grant.id}
            className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3 last:border-b-0"
          >
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-fg">
                {grant.api?.name ?? grant.api_id}
              </span>
              <code className="block truncate font-mono text-xs text-fg-subtle">
                {grant.api?.invoke_url ?? grant.api?.listen_path ?? '—'}
              </code>
            </span>
            {grant.api && grant.api.invoke_url === null ? (
              <span className="text-xs text-fg-subtle">
                Gateway address not published — ask your administrator.
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Gateway credential management with show-once issue and rotation. */
export function CredentialsPage(): ReactElement {
  const [offset, setOffset] = useState(0);
  const limit = DEFAULT_PAGE_SIZE;
  const query = useCredentials({ limit, offset });

  const [issueOpen, setIssueOpen] = useState(false);
  const [credentialType, setCredentialType] = useState<CredentialType>('keyauth');
  const [label, setLabel] = useState('');
  const [showOnce, setShowOnce] = useState<ShowOnceState | null>(null);
  const [rotating, setRotating] = useState<CredentialMetadata | null>(null);
  const [revoking, setRevoking] = useState<CredentialMetadata | null>(null);

  const issue = useIssueCredential();
  const rotate = useRotateCredential();
  const remove = useDeleteCredential();
  const toast = useToast();

  const columns = useMemo<Columns<CredentialMetadata>>(
    () => [
      {
        id: 'label',
        header: 'Label',
        cell: ({ row }) => (
          <span className="font-medium text-fg">
            {row.original.label ?? CREDENTIAL_TYPE_LABELS[row.original.credential_type]}
          </span>
        ),
      },
      {
        id: 'type',
        header: 'Type',
        cell: ({ row }) => CREDENTIAL_TYPE_LABELS[row.original.credential_type],
      },
      {
        id: 'last4',
        header: 'Secret',
        cell: ({ row }) => (
          <code className="font-mono text-xs text-fg-muted">••••{row.original.last4}</code>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        cell: ({ row }) => <StatusPill status={row.original.status} />,
      },
      {
        id: 'created',
        header: 'Created',
        cell: ({ row }) => (
          <span className="text-fg-muted">{formatDateTime(row.original.created_at)}</span>
        ),
      },
      {
        id: 'actions',
        header: '',
        cell: ({ row }) => (
          <div className="flex justify-end gap-1.5">
            <Button size="sm" variant="secondary" onClick={() => setRotating(row.original)}>
              Rotate
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setRevoking(row.original)}>
              Revoke
            </Button>
          </div>
        ),
      },
    ],
    [],
  );

  return (
    <>
      <PageHeader
        title="Credentials"
        description="Gateway credentials for your Ferrum consumer. Secrets are shown once at issue and rotation time and are never stored."
        actions={
          <Button variant="primary" onClick={() => setIssueOpen(true)}>
            Issue credential
          </Button>
        }
      />

      <DataTable<CredentialMetadata>
        columns={columns}
        data={query.data?.items ?? []}
        total={query.data?.total ?? 0}
        offset={offset}
        limit={limit}
        onOffsetChange={setOffset}
        loading={query.isLoading}
        empty={
          <EmptyState
            icon="key"
            title="No credentials yet"
            description="Issue a credential to authenticate against the APIs you have access to."
            action={
              <Button variant="primary" onClick={() => setIssueOpen(true)}>
                Issue credential
              </Button>
            }
          />
        }
      />

      <MyAccessCard />

      <Card className="mt-4 p-4 text-sm text-fg-muted">
        Rotation appends a new credential on the gateway before retiring the old one, so callers
        have a window to switch over. Revoking removes the credential immediately.
      </Card>

      <Dialog
        open={issueOpen}
        onOpenChange={setIssueOpen}
        title="Issue a credential"
        description="Choose the credential type expected by the APIs you call."
        footer={
          <>
            <Button variant="ghost" onClick={() => setIssueOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={issue.isPending}
              onClick={() =>
                issue.mutate(
                  { credential_type: credentialType, label: label.trim() || null },
                  {
                    onSuccess: (response) => {
                      setIssueOpen(false);
                      setLabel('');
                      setShowOnce({
                        secret: response.secret,
                        consumerUsername: response.consumer_username,
                        title: 'Save your new credential',
                      });
                    },
                  },
                )
              }
            >
              Issue
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <LabeledSelect<CredentialType>
            label="Credential type"
            value={credentialType}
            onValueChange={setCredentialType}
            options={CREDENTIAL_TYPES.map((value) => ({
              value,
              label: CREDENTIAL_TYPE_LABELS[value],
            }))}
          />
          <LabeledInput
            label="Label"
            placeholder="e.g. production worker"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            hint="Optional, helps you recognise this credential later."
          />
        </div>
      </Dialog>

      <ConfirmDialog
        open={rotating !== null}
        onOpenChange={(open) => {
          if (!open) setRotating(null);
        }}
        title="Rotate credential"
        description="A replacement is created on the gateway and shown once. The current secret keeps working until the rotation is finalized."
        confirmLabel="Rotate"
        loading={rotate.isPending}
        onConfirm={() => {
          if (!rotating) return;
          rotate.mutate(
            { id: rotating.id, body: { label: rotating.label } },
            {
              onSuccess: (response) => {
                setRotating(null);
                setShowOnce({
                  secret: response.secret,
                  consumerUsername: response.consumer_username,
                  title: 'Save your rotated credential',
                });
              },
            },
          );
        }}
      />

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title="Revoke credential"
        description="Any caller still using this secret will start receiving 401 responses immediately."
        confirmLabel="Revoke"
        danger
        loading={remove.isPending}
        onConfirm={() => {
          if (!revoking) return;
          remove.mutate(revoking.id, {
            onSuccess: () => {
              setRevoking(null);
              toast.success('Credential revoked');
            },
          });
        }}
      />

      {showOnce ? (
        <ShowOnceSecretDialog
          open
          secret={showOnce.secret}
          consumerUsername={showOnce.consumerUsername}
          title={showOnce.title}
          onAcknowledge={() => setShowOnce(null)}
        />
      ) : null}
    </>
  );
}
