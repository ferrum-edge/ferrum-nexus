import { useMemo, useState, type ReactElement } from 'react';
import {
  DEFAULT_PAGE_SIZE,
  ROLE_LABELS,
  ROLE_ORDER,
  type Role,
  type User,
} from '@ferrum-nexus/shared';
import { formatDateTime } from '../../lib/format';
import { useRetryGatewayTeardown, useUpdateUser, useUser, useUsers } from '../../hooks/useUsers';
import { useToast } from '../../stores/toast';
import { RoleGuard } from '../../components/layout/RoleGuard';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { PageHeader } from '../../components/ui/Card';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { DataTable, type Columns } from '../../components/ui/DataTable';
import { EmptyState } from '../../components/ui/EmptyState';
import { Icon } from '../../components/ui/Icon';
import { Input } from '../../components/ui/Input';
import { Select } from '../../components/ui/Select';
import { RoleBadge, StatusPill } from '../../components/ui/StatusPill';
import { Tooltip } from '../../components/ui/Tooltip';

/**
 * "The account is off but its gateway credentials are not."
 *
 * A disabled account whose Ferrum consumer could not be stripped keeps a
 * working API key until the teardown worker gets through, so the state is shown
 * rather than left to the audit log — with the last error and a way to re-drive
 * it now that Edge may be back.
 */
function GatewayTeardownBadge({ userId }: { userId: string }): ReactElement | null {
  const detail = useUser(userId);
  const retry = useRetryGatewayTeardown();
  const toast = useToast();
  const teardown = detail.data?.gateway_teardown ?? null;

  if (!teardown || teardown.status === 'done') return null;

  return (
    <span className="mt-1 flex items-center gap-1.5">
      <Tooltip
        label={
          teardown.last_error
            ? `Last attempt failed: ${teardown.last_error}`
            : 'Queued; the gateway teardown worker is retrying.'
        }
      >
        <Badge tone="warning">Gateway revocation pending</Badge>
      </Tooltip>
      <Button
        size="sm"
        variant="ghost"
        loading={retry.isPending}
        onClick={() =>
          retry.mutate(userId, {
            onSuccess: (result) => {
              if (result.gateway_teardown === 'pending') {
                toast.error('The gateway still refused the revocation; it stays queued');
              } else {
                toast.success('Gateway credentials revoked');
              }
            },
          })
        }
      >
        Retry
      </Button>
    </span>
  );
}

function UsersTable(): ReactElement {
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<Role | 'all'>('all');
  const limit = DEFAULT_PAGE_SIZE;

  const query = useUsers({
    limit,
    offset,
    ...(search.trim() ? { q: search.trim() } : {}),
    ...(roleFilter === 'all' ? {} : { role: roleFilter }),
  });

  const update = useUpdateUser();
  const toast = useToast();
  const [statusTarget, setStatusTarget] = useState<User | null>(null);
  // Portal-wide, so a page with no outstanding revocation costs no extra
  // requests at all — the per-row detail is only fetched when this is non-zero.
  const pendingTeardowns = query.data?.pending_gateway_teardowns ?? 0;

  const columns = useMemo<Columns<User>>(
    () => [
      {
        id: 'user',
        header: 'User',
        cell: ({ row }) => (
          <span>
            <span className="block font-medium text-fg">{row.original.display_name}</span>
            <span className="block text-xs text-fg-subtle">{row.original.email}</span>
          </span>
        ),
      },
      {
        id: 'role',
        header: 'Role',
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            <RoleBadge role={row.original.role} />
            <Select<Role>
              aria-label={`Change role for ${row.original.display_name}`}
              className="h-8 w-36"
              value={row.original.role}
              onValueChange={(role) => {
                if (role === row.original.role) return;
                update.mutate(
                  { id: row.original.id, body: { role } },
                  { onSuccess: () => toast.success(`Role updated to ${ROLE_LABELS[role]}`) },
                );
              }}
              options={ROLE_ORDER.map((value) => ({ value, label: ROLE_LABELS[value] }))}
            />
          </div>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        cell: ({ row }) => (
          <span className="block">
            <StatusPill status={row.original.status} />
            {pendingTeardowns > 0 && row.original.status === 'disabled' ? (
              <GatewayTeardownBadge userId={row.original.id} />
            ) : null}
          </span>
        ),
      },
      {
        id: 'verified',
        header: 'Verified',
        cell: ({ row }) =>
          row.original.email_verified ? (
            <Icon name="check" className="text-success" title="Email verified" />
          ) : (
            <span className="text-xs text-fg-subtle">No</span>
          ),
      },
      {
        id: 'last_login',
        header: 'Last sign-in',
        cell: ({ row }) => (
          <span className="text-fg-muted">{formatDateTime(row.original.last_login_at)}</span>
        ),
      },
      {
        id: 'actions',
        header: '',
        cell: ({ row }) => (
          <div className="flex justify-end">
            <Button size="sm" variant="secondary" onClick={() => setStatusTarget(row.original)}>
              {row.original.status === 'active' ? 'Disable' : 'Enable'}
            </Button>
          </div>
        ),
      },
    ],
    [update, toast, pendingTeardowns],
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
            aria-label="Search users"
            placeholder="Search by name or email"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setOffset(0);
            }}
          />
        </div>
        <Select<Role | 'all'>
          aria-label="Filter by role"
          className="w-44"
          value={roleFilter}
          onValueChange={(value) => {
            setRoleFilter(value);
            setOffset(0);
          }}
          options={[
            { value: 'all', label: 'All roles' },
            ...ROLE_ORDER.map((value) => ({
              value: value as Role | 'all',
              label: ROLE_LABELS[value],
            })),
          ]}
        />
      </div>

      <DataTable<User>
        columns={columns}
        data={query.data?.items ?? []}
        total={query.data?.total ?? 0}
        offset={offset}
        limit={limit}
        onOffsetChange={setOffset}
        loading={query.isLoading}
        empty={<EmptyState icon="users" title="No accounts match these filters" />}
      />

      <ConfirmDialog
        open={statusTarget !== null}
        onOpenChange={(open) => {
          if (!open) setStatusTarget(null);
        }}
        title={statusTarget?.status === 'active' ? 'Disable account' : 'Enable account'}
        description={
          statusTarget?.status === 'active'
            ? 'The account can no longer sign in. Existing sessions are terminated by the server.'
            : 'The account regains portal access.'
        }
        confirmLabel={statusTarget?.status === 'active' ? 'Disable' : 'Enable'}
        danger={statusTarget?.status === 'active'}
        loading={update.isPending}
        onConfirm={() => {
          if (!statusTarget) return;
          update.mutate(
            {
              id: statusTarget.id,
              body: { status: statusTarget.status === 'active' ? 'disabled' : 'active' },
            },
            {
              onSuccess: () => {
                toast.success('Account updated');
                setStatusTarget(null);
              },
            },
          );
        }}
      />
    </>
  );
}

/** Admin user directory with role and status management. */
export function AdminUsersPage(): ReactElement {
  return (
    <RoleGuard minRole="admin">
      <PageHeader
        title="Users"
        description="Every portal account. The last active super admin cannot be demoted or disabled."
      />
      <UsersTable />
    </RoleGuard>
  );
}
