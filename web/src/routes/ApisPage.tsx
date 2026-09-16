import { Link, useNavigate } from '@tanstack/react-router';
import { useMemo, useState, type ReactElement } from 'react';
import { AUTH_PLUGIN_LABELS, DEFAULT_PAGE_SIZE, type Api } from '@ferrum-nexus/shared';
import { formatDateTime } from '../lib/format';
import { useMyApis } from '../hooks/useApis';
import { RoleGuard } from '../components/layout/RoleGuard';
import { Badge } from '../components/ui/Badge';
import { buttonClassName } from '../components/ui/Button';
import { PageHeader } from '../components/ui/Card';
import { DataTable, type Columns } from '../components/ui/DataTable';
import { EmptyState } from '../components/ui/EmptyState';
import { Icon } from '../components/ui/Icon';
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
          <span className="block min-w-0">
            <span className="block truncate text-sm font-medium text-fg">{row.original.name}</span>
            <span className="block truncate font-mono text-xs text-fg-subtle">
              /{row.original.slug}
            </span>
          </span>
        ),
      },
      {
        id: 'version',
        header: 'Version',
        cell: ({ row }) => <Badge mono>v{row.original.version}</Badge>,
      },
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
          <span className="text-xs whitespace-nowrap text-fg-muted tabular-nums">
            {formatDateTime(row.original.updated_at)}
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
      empty={
        <EmptyState
          icon="stack"
          title="You have not published an API yet"
          description="Publishing creates a gateway proxy from your OpenAPI document and attaches the auth and access-control plugins."
          action={
            <Link to="/apis/new" className={buttonClassName({ variant: 'primary' })}>
              <Icon name="plus" />
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
          <Link to="/apis/new" className={buttonClassName({ variant: 'primary' })}>
            <Icon name="plus" />
            Publish API
          </Link>
        }
      />
      <MyApisTable />
    </RoleGuard>
  );
}
