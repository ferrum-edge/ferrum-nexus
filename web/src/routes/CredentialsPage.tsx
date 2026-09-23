import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  DEFAULT_PAGE_SIZE,
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
import { useApplicationsById } from '../hooks/useApplications';
import { useGrants } from '../hooks/useGrants';
import { useToast } from '../stores/toast';
import { ACCOUNT_IDENTITY, IdentityPicker } from '../components/applications/IdentityPicker';
import { ShowOnceSecretDialog } from '../components/credentials/ShowOnceSecretDialog';
import { FormNotice } from '../components/auth/AuthShell';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, CardHeader, PageHeader } from '../components/ui/Card';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { DataTable, PaginationBar, type Columns } from '../components/ui/DataTable';
import { Dialog } from '../components/ui/Dialog';
import { EmptyState } from '../components/ui/EmptyState';
import { Icon, type IconName } from '../components/ui/Icon';
import { LabeledInput } from '../components/ui/Input';
import { LabeledSelect } from '../components/ui/Select';
import { StatusPill } from '../components/ui/StatusPill';

interface ShowOnceState {
  secret: ShowOnceSecret;
  consumerUsername: string;
  title: string;
}

/** Glyph per credential flavour, so a row is recognisable before it is read. */
const CREDENTIAL_TYPE_ICONS: Readonly<Record<CredentialType, IconName>> = {
  keyauth: 'key',
  basicauth: 'lock',
  jwt: 'code',
};

/** One line on the issue form explaining what the chosen type is used for. */
const CREDENTIAL_TYPE_HINTS: Readonly<Record<CredentialType, string>> = {
  keyauth: 'Sent as the X-API-Key header on every request.',
  basicauth: 'The password half of HTTP Basic; the username is your consumer username.',
  jwt: 'A signing secret for the short-lived HS256 tokens you mint yourself.',
};

/** Read-only value with a copy affordance, sized for a list row. */
function CopyableValue({ label, value }: { label: string; value: string }): ReactElement {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // Clipboard access can be denied (insecure context, permissions); the
      // value stays selectable so it can be copied by hand.
      setCopied(false);
    }
  }, [value]);

  return (
    <span className="flex min-w-0 items-center gap-1">
      <code className="min-w-0 truncate rounded-sm bg-inset px-1.5 py-0.5 font-mono text-xs text-fg-muted">
        {value}
      </code>
      <Button
        size="icon-sm"
        variant="ghost"
        onClick={() => void copy()}
        aria-label={copied ? `${label} copied` : `Copy ${label}`}
        title={`Copy ${label}`}
      >
        <Icon
          name={copied ? 'check' : 'copy'}
          className={copied ? 'h-3.5 w-3.5 text-success' : 'h-3.5 w-3.5'}
        />
      </Button>
    </span>
  );
}

/**
 * The APIs this account may call, and where to call them.
 *
 * A credential on its own is unusable without an address, and the address is
 * the gateway's, not this portal's — so the two belong on the same page. When
 * no gateway origin is configured the listen path is shown instead, since that
 * is genuinely all the portal knows.
 *
 * Paged like every other list: one `MAX_PAGE_SIZE` page is not "every grant"
 * once an account holds more than that (issue #310). Each row names the
 * identity holding the grant, because an application's grant reaches only
 * that application's credentials.
 */
function MyAccessCard(): ReactElement {
  const [offset, setOffset] = useState(0);
  const limit = DEFAULT_PAGE_SIZE;
  const grants = useGrants({ mine: true, status: 'active', limit, offset }, true, true);
  const items = grants.data?.items ?? [];
  const total = grants.data?.total ?? 0;

  // A revocation can empty the last page; step back rather than show nothing.
  useEffect(() => {
    if (grants.data && items.length === 0 && offset > 0) {
      setOffset(Math.max(0, offset - limit));
    }
  }, [grants.data, items.length, offset, limit]);

  if (grants.isLoading || total === 0) return <></>;

  return (
    <Card className="mt-6">
      <CardHeader
        title="Your API access"
        icon="grant"
        description="The APIs your account and its applications hold active grants for, with the URL to send requests to."
      />
      <ul aria-busy={grants.isPlaceholderData || undefined}>
        {items.map((grant) => {
          const name = grant.api?.name ?? grant.api_id;
          const address = grant.api ? (grant.api.invoke_url ?? grant.api.listen_path) : null;
          return (
            <li
              key={grant.id}
              className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border px-5 py-3 last:border-b-0"
            >
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="truncate text-sm font-medium text-fg">{name}</span>
                  {grant.application_id ? (
                    <Badge tone="accent">{grant.application?.name ?? 'Application'}</Badge>
                  ) : (
                    <Badge tone="neutral">My account</Badge>
                  )}
                </span>
                {address ? (
                  <CopyableValue label={`${name} address`} value={address} />
                ) : (
                  <code className="block font-mono text-xs text-fg-subtle">—</code>
                )}
              </span>
              {grant.api && grant.api.invoke_url === null ? (
                <span className="text-xs text-fg-subtle">
                  Gateway address not published — ask your administrator.
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
      {total > limit ? (
        <PaginationBar offset={offset} limit={limit} total={total} onOffsetChange={setOffset} />
      ) : null}
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
  // The identity the credential authenticates as. `ACCOUNT_IDENTITY` is the
  // account itself, which is the default and what every credential issued
  // before applications existed uses.
  const [identity, setIdentity] = useState<string>(ACCOUNT_IDENTITY);
  const [identityName, setIdentityName] = useState<string>('My account');
  const [showOnce, setShowOnce] = useState<ShowOnceState | null>(null);
  const [rotating, setRotating] = useState<CredentialMetadata | null>(null);
  const [revoking, setRevoking] = useState<CredentialMetadata | null>(null);

  // The applications this page of credentials authenticates as, fetched by
  // id. Loading one page of applications and looking names up in it left any
  // application past that page an anonymous "Application" (issue #310).
  // Disabled ones are included: a disabled application keeps its
  // credentials, so the table still has to say whose they are.
  const applications = useApplicationsById(
    (query.data?.items ?? [])
      .map((item) => item.application_id)
      .filter((id): id is string => id !== null),
  );

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
          <span className="flex items-center gap-2.5">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
              <Icon
                name={CREDENTIAL_TYPE_ICONS[row.original.credential_type]}
                className="h-3.5 w-3.5"
              />
            </span>
            <span className="font-medium text-fg">
              {row.original.label ?? CREDENTIAL_TYPE_LABELS[row.original.credential_type]}
            </span>
          </span>
        ),
      },
      {
        id: 'identity',
        header: 'Identity',
        // Which identity the material authenticates as, and therefore what it
        // can reach — the thing `Label` cannot tell you.
        cell: ({ row }) =>
          row.original.application_id ? (
            <span className="flex flex-wrap items-center gap-1.5">
              <Badge tone="accent">
                {applications.get(row.original.application_id)?.name ?? 'Application'}
              </Badge>
              {applications.get(row.original.application_id)?.status === 'disabled' ? (
                <Badge tone="warning">Disabled</Badge>
              ) : null}
            </span>
          ) : (
            <span className="text-fg-muted">My account</span>
          ),
      },
      {
        id: 'type',
        header: 'Type',
        cell: ({ row }) => (
          <span className="text-fg-muted">
            {CREDENTIAL_TYPE_LABELS[row.original.credential_type]}
          </span>
        ),
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
          <span className="text-xs whitespace-nowrap text-fg-muted tabular-nums">
            {formatDateTime(row.original.created_at)}
          </span>
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
            <Button
              size="sm"
              variant="ghost"
              className="hover:bg-danger-soft hover:text-danger"
              onClick={() => setRevoking(row.original)}
            >
              Revoke
            </Button>
          </div>
        ),
      },
    ],
    [applications],
  );

  return (
    <>
      <PageHeader
        title="Credentials"
        description="Gateway credentials for your Ferrum consumer. Secrets are shown once and never stored."
        actions={
          <Button variant="primary" onClick={() => setIssueOpen(true)}>
            <Icon name="plus" />
            Issue credential
          </Button>
        }
      />

      <div className="mb-4">
        <FormNotice tone="info">
          Rotation revokes the previous value as part of the same operation. Callers using the old
          secret start receiving 401 as soon as gateway configuration propagates, which can
          interrupt clients until they deploy the new value. To keep both secrets live during a
          cutover, issue a new credential, deploy it, then revoke the old one — that path is
          available when you are below the per-type limit (issuing another credential of the same
          type is refused once you are at the cap). Revoking a credential removes it immediately.
        </FormNotice>
      </div>

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
                  {
                    credential_type: credentialType,
                    label: label.trim() || null,
                    application_id: identity === ACCOUNT_IDENTITY ? null : identity,
                  },
                  {
                    onSuccess: (response) => {
                      setIssueOpen(false);
                      setLabel('');
                      setIdentity(ACCOUNT_IDENTITY);
                      setIdentityName('My account');
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
          {/* The identity comes first because it is the only field here that
              changes what the credential can *reach*. `Label` is a note to
              yourself; this is a permission boundary (issue #289). */}
          <IdentityPicker
            label="Identity"
            value={identity}
            selectedLabel={identityName}
            onValueChange={(value, name) => {
              setIdentity(value);
              setIdentityName(name);
            }}
            hint={
              identity === ACCOUNT_IDENTITY
                ? 'This credential can call every API your account is approved for.'
                : `This credential can call only the APIs ${identityName} is approved for.`
            }
          />
          <LabeledSelect<CredentialType>
            label="Credential type"
            value={credentialType}
            onValueChange={setCredentialType}
            hint={CREDENTIAL_TYPE_HINTS[credentialType]}
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
            hint="Optional, and a note to yourself only — it does not affect what this credential can call."
          />
        </div>
      </Dialog>

      <ConfirmDialog
        open={rotating !== null}
        onOpenChange={(open) => {
          if (!open) setRotating(null);
        }}
        title="Rotate credential"
        description={
          'A replacement is created on the gateway and shown once. The current secret is ' +
          'revoked as part of this operation and will stop working as soon as the gateway ' +
          'applies the change. Deploy the new value before callers retry, or issue a new ' +
          'credential first if you are below the per-type limit.'
        }
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
