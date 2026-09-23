import { useEffect, useMemo, useState, type FormEvent, type ReactElement } from 'react';
import { DEFAULT_PAGE_SIZE, type Application } from '@ferrum-nexus/shared';
import { formatDateTime } from '../lib/format';
import {
  useApplications,
  useCreateApplication,
  useDeleteApplication,
  useUpdateApplication,
} from '../hooks/useApplications';
import { useToast } from '../stores/toast';
import { RoleGuard } from '../components/layout/RoleGuard';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, CardBody, CardHeader, PageHeader } from '../components/ui/Card';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { DataTable, type Columns } from '../components/ui/DataTable';
import { Dialog } from '../components/ui/Dialog';
import { EmptyState } from '../components/ui/EmptyState';
import { Icon } from '../components/ui/Icon';
import { LabeledInput, LabeledTextarea } from '../components/ui/Input';
import { LoadingPanel } from '../components/ui/Spinner';

/**
 * The account's application identities (issue #289).
 *
 * The page has one thing to teach, and it says it in the header rather than in
 * a tooltip: an application is a **permission boundary**, not a label. Two of
 * them approved for different APIs genuinely cannot call each other's, because
 * each is its own gateway identity carrying its own approvals. A credential
 * label is a note to yourself and changes nothing.
 *
 * The disable/delete distinction gets the same treatment. Disabling stops an
 * application acquiring *new* access and new credentials and revokes nothing;
 * deleting takes its gateway identity down and its credentials stop working.
 * Both confirmations say which is which, because "turn this off" is ambiguous
 * and the two outcomes are very different.
 */

function ApplicationsList(): ReactElement {
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Application | null>(null);

  // Paged: an owner's application ceiling can exceed one page (or be
  // unlimited), and every application has to stay reachable here to be
  // disabled or deleted (issue #310).
  const [offset, setOffset] = useState(0);
  const limit = DEFAULT_PAGE_SIZE;
  const query = useApplications({ limit, offset }, true, true);
  const create = useCreateApplication();
  const update = useUpdateApplication();
  const remove = useDeleteApplication();
  const toast = useToast();

  const columns = useMemo<Columns<Application>>(
    () => [
      {
        id: 'name',
        header: 'Application',
        cell: ({ row }) => (
          <span className="flex min-w-0 items-center gap-2.5">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
              <Icon name="stack" className="h-3.5 w-3.5" />
            </span>
            <span className="min-w-0">
              <span className="block font-medium text-fg">{row.original.name}</span>
              {row.original.description ? (
                <span className="block truncate text-xs text-fg-muted">
                  {row.original.description}
                </span>
              ) : null}
            </span>
          </span>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        cell: ({ row }) =>
          row.original.status === 'active' ? (
            <Badge tone="success">Active</Badge>
          ) : (
            <Badge tone="warning">Disabled</Badge>
          ),
      },
      {
        id: 'access',
        header: 'Approved APIs',
        cell: ({ row }) => (
          <span className="tabular-nums text-fg-muted">{row.original.active_grants ?? 0}</span>
        ),
      },
      {
        id: 'credentials',
        header: 'Credentials',
        cell: ({ row }) => (
          <span className="tabular-nums text-fg-muted">{row.original.active_credentials ?? 0}</span>
        ),
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
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              loading={update.isPending}
              onClick={() =>
                update.mutate(
                  {
                    id: row.original.id,
                    body: {
                      status: row.original.status === 'active' ? 'disabled' : 'active',
                    },
                  },
                  {
                    onSuccess: () =>
                      toast.success(
                        row.original.status === 'active'
                          ? 'Application disabled'
                          : 'Application enabled',
                        row.original.status === 'active'
                          ? 'Existing credentials keep working until you delete it or revoke its access.'
                          : undefined,
                      ),
                    onError: (mutationError: Error) =>
                      toast.error('Could not change the application', mutationError.message),
                  },
                )
              }
            >
              {row.original.status === 'active' ? 'Disable' : 'Enable'}
            </Button>
            <Button variant="ghost" onClick={() => setDeleting(row.original)}>
              Delete
            </Button>
          </div>
        ),
      },
    ],
    [toast, update],
  );

  // Deleting the last row of the last page leaves an empty page; step back.
  useEffect(() => {
    if (query.data && query.data.items.length === 0 && offset > 0) {
      setOffset(Math.max(0, offset - limit));
    }
  }, [query.data, offset, limit]);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setError(null);
    if (name.trim() === '') {
      setError('Give the application a name.');
      return;
    }
    create.mutate(
      { name: name.trim(), description: description.trim() || null },
      {
        onSuccess: () => {
          setCreateOpen(false);
          setName('');
          setDescription('');
          toast.success('Application created');
        },
        onError: (mutationError: Error) => setError(mutationError.message),
      },
    );
  };

  return (
    <>
      <PageHeader
        title="Applications"
        description="One identity per integration, each approved for its own APIs."
        actions={
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            <Icon name="plus" />
            New application
          </Button>
        }
      />

      <Card className="mb-6">
        <CardBody className="flex items-start gap-3">
          <span className="mt-0.5 text-fg-muted">
            <Icon name="info" className="h-4 w-4" />
          </span>
          <p className="max-w-3xl text-sm leading-relaxed text-fg-muted">
            An application is a <strong className="font-semibold text-fg">separate identity</strong>
            , not a label. Each one requests access and is approved on its own, and its credentials
            can call only the APIs <em>it</em> has been approved for — so two of your applications
            approved for different APIs cannot reach each other&rsquo;s. Credentials issued to your
            account itself are unchanged and can still call everything your account is approved for.
          </p>
        </CardBody>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader
          icon="stack"
          title="Your applications"
          description="Choose one when requesting access or issuing a credential."
        />
        {query.isLoading ? (
          <LoadingPanel label="Loading applications" />
        ) : query.isError ? (
          <CardBody>
            <p className="text-sm text-danger">Your applications could not be loaded.</p>
          </CardBody>
        ) : (query.data?.total ?? 0) === 0 && offset === 0 ? (
          <EmptyState
            icon="stack"
            title="No applications yet"
            description="Create one per integration — a worker, a mobile app, a partner sandbox — to keep their approved APIs and credentials apart."
            action={
              <Button variant="primary" onClick={() => setCreateOpen(true)}>
                <Icon name="plus" />
                New application
              </Button>
            }
          />
        ) : (
          <DataTable
            columns={columns}
            data={query.data?.items ?? []}
            total={query.data?.total ?? 0}
            offset={offset}
            limit={limit}
            onOffsetChange={setOffset}
          />
        )}
      </Card>

      <Dialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="New application"
        description="It starts with no approved APIs and no credentials. Request access for it from the catalog."
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" loading={create.isPending} onClick={submit}>
              Create
            </Button>
          </>
        }
      >
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <LabeledInput
            label="Name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Billing worker"
            hint="Unique among your applications."
          />
          <LabeledTextarea
            label="Description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="What this integration does."
            rows={3}
          />
          {error ? <p className="text-sm text-danger">{error}</p> : null}
        </form>
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title="Delete this application"
        description={
          deleting
            ? `Its gateway identity is deleted, so its ${deleting.active_credentials ?? 0} credential(s) stop working immediately and its ${deleting.active_grants ?? 0} approved API(s) are given up. This cannot be undone — disable it instead if you only want to stop it acquiring new access.`
            : ''
        }
        confirmLabel="Delete application"
        danger
        confirmPhrase={deleting?.name}
        loading={remove.isPending}
        onConfirm={() => {
          if (!deleting) return;
          remove.mutate(deleting.id, {
            onSuccess: () => {
              toast.success('Application deleted');
              setDeleting(null);
            },
            onError: (mutationError: Error) =>
              toast.error('Could not delete the application', mutationError.message),
          });
        }}
      />
    </>
  );
}

/** The account's application identities. */
export function ApplicationsPage(): ReactElement {
  return (
    <RoleGuard minRole="client">
      <ApplicationsList />
    </RoleGuard>
  );
}
