import { useNavigate } from '@tanstack/react-router';
import { useMemo, useState, type ReactElement } from 'react';
import {
  AUTH_PLUGIN_LABELS,
  DEFAULT_PAGE_SIZE,
  type Api,
  type ApiStatus,
} from '@ferrum-nexus/shared';
import { formatDateTime, formatRelative } from '../../lib/format';
import { useApis } from '../../hooks/useApis';
import { RoleGuard } from '../../components/layout/RoleGuard';
import { Badge } from '../../components/ui/Badge';
import { PageHeader } from '../../components/ui/Card';
import { DataTable, type Columns } from '../../components/ui/DataTable';
import { EmptyState } from '../../components/ui/EmptyState';
import { SearchInput } from '../../components/ui/Input';
import { Select } from '../../components/ui/Select';
import { StatusPill } from '../../components/ui/StatusPill';

function AllApisTable(): ReactElement {
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<ApiStatus | 'all'>('all');
  const limit = DEFAULT_PAGE_SIZE;
  const navigate = useNavigate();

  const query = useApis({
    mine: false,
    limit,
    offset,
    ...(search.trim() ? { q: search.trim() } : {}),
    ...(statusFilter === 'all' ? {} : { status: statusFilter }),
  });

  const columns = useMemo<Columns<Api>>(
    () => [
      {
        id: 'name',
        header: 'API',
        cell: ({ row }) => (
          <span className="block min-w-0">
            <span className="block truncate font-medium text-fg">{row.original.name}</span>
            <span className="block truncate font-mono text-xs text-fg-subtle">
              {row.original.listen_path}
            </span>
          </span>
        ),
      },
      {
        id: 'version',
        header: 'Version',
        cell: ({ row }) => <Badge mono>{`v${row.original.version}`}</Badge>,
      },
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
        id: 'access',
        header: 'Access',
        cell: ({ row }) =>
          row.original.requestable ? (
            <Badge tone="accent">Requestable</Badge>
          ) : (
            <span className="text-xs text-fg-subtle">Open</span>
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
          <span
            className="whitespace-nowrap text-fg-muted tabular-nums"
            title={formatDateTime(row.original.updated_at)}
          >
            {formatRelative(row.original.updated_at)}
          </span>
        ),
      },
    ],
    [],
  );

  return (
    <DataTable<Api>
      columns={columns}
      data={query.data?.items ?? []}
      total={query.data?.total ?? 0}
      offset={offset}
      limit={limit}
      onOffsetChange={setOffset}
      loading={query.isLoading}
      onRowClick={(api) => void navigate({ to: '/apis/$apiId', params: { apiId: api.id } })}
      toolbar={
        <>
          <SearchInput
            wrapperClassName="w-full sm:w-72"
            aria-label="Search APIs"
            placeholder="Search by name or slug"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setOffset(0);
            }}
          />
          <Select<ApiStatus | 'all'>
            aria-label="Filter by status"
            className="w-40"
            value={statusFilter}
            onValueChange={(value) => {
              setStatusFilter(value);
              setOffset(0);
            }}
            options={[
              { value: 'all', label: 'All statuses' },
              { value: 'published', label: 'Published' },
              { value: 'retired', label: 'Retired' },
            ]}
          />
        </>
      }
      empty={
        <EmptyState
          icon="spec"
          title="No APIs match these filters"
          description="Providers publish from their own workspace; published APIs appear here for every administrator."
        />
      }
    />
  );
}

/** Portal-wide API inventory. */
export function AdminApisPage(): ReactElement {
  return (
    <RoleGuard minRole="admin">
      <PageHeader
        title="All APIs"
        description="Every API published on this portal, across all providers. Opening one takes you to its management workspace, where an admin can approve, deny and revoke without god mode."
      />
      <AllApisTable />
    </RoleGuard>
  );
}
