import { useMemo, useState, type ReactElement } from 'react';
import { DEFAULT_PAGE_SIZE, type Organization } from '@ferrum-nexus/shared';
import { formatDateTime } from '../../lib/format';
import { useCreateOrganization, useOrganizations } from '../../hooks/useUsers';
import { useToast } from '../../stores/toast';
import { RoleGuard } from '../../components/layout/RoleGuard';
import { Button } from '../../components/ui/Button';
import { PageHeader } from '../../components/ui/Card';
import { DataTable, type Columns } from '../../components/ui/DataTable';
import { Dialog } from '../../components/ui/Dialog';
import { EmptyState } from '../../components/ui/EmptyState';
import { LabeledInput, LabeledTextarea } from '../../components/ui/Input';

function OrgsTable(): ReactElement {
  const [offset, setOffset] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const limit = DEFAULT_PAGE_SIZE;

  const query = useOrganizations({ limit, offset });
  const create = useCreateOrganization();
  const toast = useToast();

  const columns = useMemo<Columns<Organization>>(
    () => [
      {
        id: 'name',
        header: 'Organization',
        cell: ({ row }) => <span className="font-medium text-fg">{row.original.name}</span>,
      },
      {
        id: 'description',
        header: 'Description',
        cell: ({ row }) => <span className="text-fg-muted">{row.original.description ?? '—'}</span>,
      },
      {
        id: 'created',
        header: 'Created',
        cell: ({ row }) => (
          <span className="text-fg-muted">{formatDateTime(row.original.created_at)}</span>
        ),
      },
    ],
    [],
  );

  return (
    <>
      <div className="mb-4 flex justify-end">
        <Button variant="primary" onClick={() => setCreateOpen(true)}>
          New organization
        </Button>
      </div>

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
            description="Organizations group providers and their APIs."
          />
        }
      />

      <Dialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="Create organization"
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
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
                      setName('');
                      setDescription('');
                      setCreateOpen(false);
                      toast.success('Organization created');
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
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <LabeledTextarea
            label="Description"
            rows={3}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>
      </Dialog>
    </>
  );
}

/** Admin organization management. */
export function AdminOrgsPage(): ReactElement {
  return (
    <RoleGuard minRole="admin">
      <PageHeader
        title="Organizations"
        description="Lightweight grouping for providers and their published APIs."
      />
      <OrgsTable />
    </RoleGuard>
  );
}
