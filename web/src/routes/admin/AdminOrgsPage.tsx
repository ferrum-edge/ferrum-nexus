import { useMemo, useState, type ReactElement } from 'react';
import { DEFAULT_PAGE_SIZE, type Organization } from '@ferrum-nexus/shared';
import { formatDateTime, formatRelative } from '../../lib/format';
import { useCreateOrganization, useOrganizations } from '../../hooks/useUsers';
import { useToast } from '../../stores/toast';
import { RoleGuard } from '../../components/layout/RoleGuard';
import { Button } from '../../components/ui/Button';
import { PageHeader } from '../../components/ui/Card';
import { DataTable, type Columns } from '../../components/ui/DataTable';
import { Dialog } from '../../components/ui/Dialog';
import { EmptyState } from '../../components/ui/EmptyState';
import { Icon } from '../../components/ui/Icon';
import { LabeledInput, LabeledTextarea } from '../../components/ui/Input';

/** The create dialog, mounted only while it is open so its fields start empty. */
function CreateOrgDialog({ onClose }: { onClose: () => void }): ReactElement {
  const create = useCreateOrganization();
  const toast = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="Create organization"
      description="A name to group accounts by. It grants nothing on its own."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={create.isPending}
            disabled={name.trim().length === 0}
            onClick={() =>
              create.mutate(
                { name: name.trim(), description: description.trim() || null },
                {
                  onSuccess: () => {
                    toast.success('Organization created');
                    onClose();
                  },
                },
              )
            }
          >
            Create
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <LabeledInput
          label="Name"
          required
          placeholder="Acme Corp"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <LabeledTextarea
          label="Description"
          rows={3}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          hint="Optional. Shown to administrators in this directory only."
        />
      </div>
    </Dialog>
  );
}

function OrgsTable({ onCreate }: { onCreate: () => void }): ReactElement {
  const [offset, setOffset] = useState(0);
  const limit = DEFAULT_PAGE_SIZE;

  const query = useOrganizations({ limit, offset });

  const columns = useMemo<Columns<Organization>>(
    () => [
      {
        id: 'name',
        header: 'Organization',
        cell: ({ row }) => (
          <div className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent"
            >
              <Icon name="building" className="h-4 w-4" />
            </span>
            <span className="block truncate font-medium text-fg">{row.original.name}</span>
          </div>
        ),
      },
      {
        id: 'description',
        header: 'Description',
        cell: ({ row }) =>
          row.original.description ? (
            <span className="block max-w-lg text-fg-muted">{row.original.description}</span>
          ) : (
            <span className="text-fg-subtle">—</span>
          ),
      },
      {
        id: 'created',
        header: 'Created',
        cell: ({ row }) => (
          <span
            className="whitespace-nowrap text-fg-muted tabular-nums"
            title={formatDateTime(row.original.created_at)}
          >
            {formatRelative(row.original.created_at)}
          </span>
        ),
      },
    ],
    [],
  );

  return (
    <DataTable<Organization>
      columns={columns}
      data={query.data?.items ?? []}
      total={query.data?.total ?? 0}
      offset={offset}
      limit={limit}
      onOffsetChange={setOffset}
      loading={query.isLoading}
      empty={
        <EmptyState
          icon="building"
          title="No organizations yet"
          description="Organizations group providers and their APIs, and give mass email an audience to aim at."
          action={
            <Button variant="primary" onClick={onCreate}>
              <Icon name="plus" />
              New organization
            </Button>
          }
        />
      }
    />
  );
}

/** Admin organization management. */
export function AdminOrgsPage(): ReactElement {
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <RoleGuard minRole="admin">
      <PageHeader
        title="Organizations"
        description="Lightweight grouping for providers and their published APIs."
        actions={
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            <Icon name="plus" />
            New organization
          </Button>
        }
      />
      <OrgsTable onCreate={() => setCreateOpen(true)} />
      {createOpen ? <CreateOrgDialog onClose={() => setCreateOpen(false)} /> : null}
    </RoleGuard>
  );
}
