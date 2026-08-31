import { useNavigate } from '@tanstack/react-router';
import { useMemo, useState, type ReactElement } from 'react';
import { AUTH_PLUGIN_LABELS, DEFAULT_PAGE_SIZE, type Api } from '@ferrum-nexus/shared';
import { formatDateTime } from '../../lib/format';
import { useApis } from '../../hooks/useApis';
import { RoleGuard } from '../../components/layout/RoleGuard';
import { Badge } from '../../components/ui/Badge';
import { PageHeader } from '../../components/ui/Card';
import { DataTable, type Columns } from '../../components/ui/DataTable';
import { EmptyState } from '../../components/ui/EmptyState';
import { Icon } from '../../components/ui/Icon';
import { Input } from '../../components/ui/Input';
import { StatusPill } from '../../components/ui/StatusPill';

function AllApisTable(): ReactElement {
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const limit = DEFAULT_PAGE_SIZE;
  const navigate = useNavigate();

  const query = useApis({
    mine: false,
    limit,
    offset,
    ...(search.trim() ? { q: search.trim() } : {}),
  });

  const columns = useMemo<Columns<Api>>(
    () => [
      {
        id: 'name',
        header: 'API',
        cell: ({ row }) => (
          <span>
            <span className="block font-medium text-fg">{row.original.name}</span>
            <span className="block font-mono text-xs text-fg-subtle">/{row.original.slug}</span>
          </span>
        ),
      },
      { id: 'version', header: 'Version', cell: ({ row }) => `v${row.original.version}` },
      {
        id: 'auth',
        header: 'Auth',
        cell: ({ row }) => (
          <Badge tone="info">{AUTH_PLUGIN_LABELS[row.original.auth_plugin]}</Badge>
        ),
      },
      {
        id: 'visibility',
        header: 'Visibility',
        cell: ({ row }) =>
          row.original.visibility === 'internal' ? (
            <Badge tone="warning">Internal</Badge>
          ) : (
            <Badge>Public</Badge>
          ),
      },
      {
        id: 'status',
        header: 'Status',
        cell: ({ row }) => <StatusPill status={row.original.status} />,
      },
      {
        id: 'updated',
        header: 'Updated',
        cell: ({ row }) => (
          <span className="text-fg-muted">{formatDateTime(row.original.updated_at)}</span>
        ),
      },
    ],
    [],
  );

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-sm">
          <Icon
            name="search"
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-fg-subtle"
          />
          <Input
            className="pl-9"
            aria-label="Search APIs"
            placeholder="Search by name or slug"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setOffset(0);
            }}
          />
        </div>
      </div>

      <DataTable<Api>
        columns={columns}
        data={query.data?.items ?? []}
        total={query.data?.total ?? 0}
        offset={offset}
        limit={limit}
        onOffsetChange={setOffset}
        loading={query.isLoading}
        onRowClick={(api) => void navigate({ to: '/catalog/$slug', params: { slug: api.slug } })}
        empty={<EmptyState icon="spec" title="No APIs published yet" />}
      />
    </>
  );
}

/** Portal-wide API inventory. */
export function AdminApisPage(): ReactElement {
  return (
    <RoleGuard minRole="admin">
      <PageHeader
        title="All APIs"
        description="Every API published on this portal, across all providers."
      />
      <AllApisTable />
    </RoleGuard>
  );
}
