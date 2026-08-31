import { Link, useNavigate } from '@tanstack/react-router';
import { useMemo, useState, type ReactElement } from 'react';
import { AUTH_PLUGIN_LABELS, DEFAULT_PAGE_SIZE, type Api } from '@ferrum-nexus/shared';
import { formatDateTime } from '../lib/format';
import { useMyApis } from '../hooks/useApis';
import { RoleGuard } from '../components/layout/RoleGuard';
import { Badge } from '../components/ui/Badge';
import { PageHeader } from '../components/ui/Card';
import { DataTable, type Columns } from '../components/ui/DataTable';
import { EmptyState } from '../components/ui/EmptyState';
import { StatusPill } from '../components/ui/StatusPill';

function MyApisTable(): ReactElement {
  const [offset, setOffset] = useState(0);
  const limit = DEFAULT_PAGE_SIZE;
  const query = useMyApis({ limit, offset });
  const navigate = useNavigate();

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
        id: 'access',
        header: 'Access',
        cell: ({ row }) =>
          row.original.requestable ? <Badge tone="accent">Requestable</Badge> : <Badge>Open</Badge>,
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
    <DataTable<Api>
      columns={columns}
      data={query.data?.items ?? []}
      total={query.data?.total ?? 0}
      offset={offset}
      limit={limit}
      onOffsetChange={setOffset}
      loading={query.isLoading}
      onRowClick={(api) => void navigate({ to: '/apis/$apiId', params: { apiId: api.id } })}
      empty={
        <EmptyState
          icon="stack"
          title="You have not published an API yet"
          description="Publishing creates a gateway proxy from your OpenAPI document and attaches the auth and access-control plugins."
          action={
            <Link
              to="/apis/new"
              className="inline-flex h-9 items-center rounded-md bg-accent px-3.5 text-sm font-medium text-accent-fg hover:bg-accent-hover"
            >
              Publish an API
            </Link>
          }
        />
      }
    />
  );
}

/** Provider view of the APIs they own. */
export function ApisPage(): ReactElement {
  return (
    <RoleGuard minRole="provider">
      <PageHeader
        title="My APIs"
        description="APIs you publish on this portal, and the gateway proxies behind them."
        actions={
          <Link
            to="/apis/new"
            className="inline-flex h-9 items-center rounded-md bg-accent px-3.5 text-sm font-medium text-accent-fg hover:bg-accent-hover"
          >
            Publish API
          </Link>
        }
      />
      <MyApisTable />
    </RoleGuard>
  );
}
