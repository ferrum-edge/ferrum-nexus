import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useMemo, useState, type ReactElement } from 'react';
import {
  DEFAULT_PAGE_SIZE,
  ROLE_LABELS,
  ROLE_ORDER,
  roleAtLeast,
  type GetOrganizationResponse,
  type Organization,
  type Role,
  type User,
  type UserStatus,
} from '@ferrum-nexus/shared';
import { formatDateTime, formatRelative } from '../../lib/format';
import { useRetryGatewayTeardown, useUpdateUser, useUser, useUsers } from '../../hooks/useUsers';
import { useAuth } from '../../stores/auth';
import { useToast } from '../../stores/toast';
import { RoleGuard } from '../../components/layout/RoleGuard';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { PageHeader } from '../../components/ui/Card';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { DataTable, type Columns } from '../../components/ui/DataTable';
import { Dialog } from '../../components/ui/Dialog';
import { EmptyState } from '../../components/ui/EmptyState';
import { Icon } from '../../components/ui/Icon';
import { LabeledInput, SearchInput } from '../../components/ui/Input';
import { RoleBadge, StatusPill } from '../../components/ui/StatusPill';
import { Tooltip } from '../../components/ui/Tooltip';
import { AsyncSelect } from '../../components/ui/AsyncSelect';
import { Select } from '../../components/ui/Select';
import { queryKeys } from '../../hooks/keys';
import { organizationsApi } from '../../lib/api';

/**
 * Sentinel for "no organization". A select item's value may not be the empty
 * string, so the absence of an organization needs a value of its own.
 */
const NO_ORG = '__none__';

/** One or two letters standing in for an account, used by the directory rows. */
function initials(displayName: string): string {
  const words = displayName.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = words[0]?.[0] ?? '';
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : '';
  return `${first}${last}`.toUpperCase();
}

/**
 * Why `actor` cannot change `target`'s role from its row, or `null` when they
 * can.
 *
 * Mirrors the server's rules (`server/src/users/service.ts`) so a row offers a
 * select only where a change can succeed, and a plain role badge — with the
 * reason — where it cannot. The server still decides.
 */
function roleLockReason(actor: User | null, target: User, lastSuperAdmin: boolean): string | null {
  if (actor === null) return null;
  if (!roleAtLeast(actor.role, 'super_admin') && roleAtLeast(target.role, 'admin')) {
    return 'Only a super admin can change an administrator’s role.';
  }
  if (lastSuperAdmin && target.role === 'super_admin' && target.status === 'active') {
    return 'The last active super admin cannot be demoted.';
  }
  return null;
}

/** Why `actor` cannot disable (or re-enable) `target`, or `null` when they can. */
function statusLockReason(
  actor: User | null,
  target: User,
  lastSuperAdmin: boolean,
): string | null {
  if (actor === null) return null;
  if (!roleAtLeast(actor.role, 'super_admin') && roleAtLeast(target.role, 'admin')) {
    return 'Only a super admin can disable or re-enable an administrator.';
  }
  if (target.status !== 'active') return null;
  if (lastSuperAdmin && target.role === 'super_admin') {
    return 'The last active super admin cannot be disabled.';
  }
  if (target.id === actor.id) return 'You cannot disable your own account.';
  return null;
}

/**
 * A badge a tooltip explains. The tooltip needs a DOM element to attach to —
 * `Badge` renders none of the trigger's props — and a keyboard user needs to
 * reach it, so the badge sits in a focusable span.
 */
function ExplainedBadge({
  label,
  children,
}: {
  label: string;
  children: ReactElement;
}): ReactElement {
  return (
    <Tooltip label={label}>
      <span
        tabIndex={0}
        className="inline-flex rounded-full focus-visible:ring-2 focus-visible:ring-accent-ring focus-visible:outline-none"
      >
        {children}
      </span>
    </Tooltip>
  );
}

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
    <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
      <ExplainedBadge
        label={
          teardown.status === 'sending'
            ? 'Revocation is in progress. Interrupted attempts are recovered automatically; Retry re-drives it now.'
            : teardown.last_error
              ? `Last attempt failed: ${teardown.last_error}`
              : 'Queued; the gateway teardown worker is retrying.'
        }
      >
        <Badge tone="warning" dot>
          {teardown.status === 'sending'
            ? 'Gateway revocation in progress'
            : 'Gateway revocation pending'}
        </Badge>
      </ExplainedBadge>
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

/**
 * One organization by id, cached per id. Rows and the editor resolve names this
 * way so an organization beyond any loaded list page still shows its name, and
 * so the table's column definitions never depend on lookups that settle later
 * (a changed cell renderer remounts every row's cells).
 */
function useOrganizationDetail(id: string | null): UseQueryResult<GetOrganizationResponse> {
  return useQuery({
    queryKey: queryKeys.organizations.detail(id ?? ''),
    queryFn: () => organizationsApi.get(id ?? ''),
    enabled: id !== null,
    staleTime: 60_000,
  });
}

function OrganizationName({ id }: { id: string }): ReactElement {
  const detail = useOrganizationDetail(id);
  return <>{detail.data?.organization.name ?? id}</>;
}

/**
 * The account editor the admin guide's organization procedure needs.
 *
 * `PATCH /api/users/:id` has always accepted `org_id` and `display_name`; the
 * directory had no control for either, so "create an organization, then assign
 * accounts by editing the user's org_id" had no second step in the browser.
 * Mounted per target so its fields start from that account every time.
 */
function EditUserDialog({ user, onClose }: { user: User; onClose: () => void }): ReactElement {
  const selectedOrganization = useOrganizationDetail(user.org_id);
  const update = useUpdateUser();
  const toast = useToast();
  const [displayName, setDisplayName] = useState(user.display_name);
  const [orgId, setOrgId] = useState(user.org_id ?? NO_ORG);

  const save = (): void => {
    update.mutate(
      {
        id: user.id,
        body: {
          display_name: displayName.trim(),
          org_id: orgId === NO_ORG ? null : orgId,
        },
      },
      {
        onSuccess: () => {
          toast.success('Account updated');
          onClose();
        },
      },
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={`Edit ${user.display_name}`}
      description={user.email}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={update.isPending}
            disabled={displayName.trim().length === 0}
            onClick={save}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <LabeledInput
          label="Display name"
          required
          maxLength={200}
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
        />
        <AsyncSelect<Organization>
          label="Organization"
          value={orgId === NO_ORG ? '' : orgId}
          onValueChange={(value) => setOrgId(value || NO_ORG)}
          queryKey={queryKeys.organizations.picker}
          fetchPage={({ q, limit, offset }) => organizationsApi.list({ q, limit, offset })}
          toOption={(org) => ({ value: org.id, label: org.name })}
          fixedOptions={[{ value: '', label: 'No organization' }]}
          selectedLabel={selectedOrganization.data?.organization.name}
          searchPlaceholder="Search organizations"
          emptyLabel="No organizations found."
          hint="Groups accounts for filtering and for mass email; it grants nothing on its own."
        />
      </div>
    </Dialog>
  );
}

function UsersTable(): ReactElement {
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<Role | 'all'>('all');
  const [statusFilter, setStatusFilter] = useState<UserStatus | 'all'>('all');
  const [orgFilter, setOrgFilter] = useState<string>('all');
  const limit = DEFAULT_PAGE_SIZE;

  const query = useUsers({
    limit,
    offset,
    ...(search.trim() ? { q: search.trim() } : {}),
    ...(roleFilter === 'all' ? {} : { role: roleFilter }),
    ...(statusFilter === 'all' ? {} : { status: statusFilter }),
    ...(orgFilter === 'all' ? {} : { org_id: orgFilter }),
  });

  const { user: actor } = useAuth();
  // Only asked when a super admin is on screen: whether they are the last
  // active one, whose role and status the server refuses to change.
  const superAdminOnPage = (query.data?.items ?? []).some(
    (row) => row.role === 'super_admin' && row.status === 'active',
  );
  const activeSuperAdmins = useUsers(
    { role: 'super_admin', status: 'active', limit: 1 },
    superAdminOnPage,
  );
  const lastSuperAdmin = activeSuperAdmins.data?.total === 1;
  // A plain admin may move accounts between client and provider only.
  const actorRole = actor?.role ?? null;
  const assignableRoles = useMemo(
    () =>
      ROLE_ORDER.filter(
        (role) =>
          actorRole === null ||
          roleAtLeast(actorRole, 'super_admin') ||
          !roleAtLeast(role, 'admin'),
      ),
    [actorRole],
  );

  const update = useUpdateUser();
  const toast = useToast();
  const [statusTarget, setStatusTarget] = useState<User | null>(null);
  const [editTarget, setEditTarget] = useState<User | null>(null);
  // Portal-wide, so a page with no outstanding revocation costs no extra
  // requests at all — the per-row detail is only fetched when this is non-zero.
  const pendingTeardowns = query.data?.pending_gateway_teardowns ?? 0;

  const columns = useMemo<Columns<User>>(
    () => [
      {
        id: 'user',
        header: 'User',
        cell: ({ row }) => (
          <div className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent"
            >
              {initials(row.original.display_name)}
            </span>
            <span className="min-w-0">
              <span className="block truncate font-medium text-fg">
                {row.original.display_name}
              </span>
              <span className="block truncate text-xs text-fg-subtle">{row.original.email}</span>
            </span>
          </div>
        ),
      },
      {
        id: 'role',
        header: 'Role',
        // One control per row: the select where the role can be changed, and
        // the badge alone — with the reason — where it cannot.
        cell: ({ row }) => {
          const locked = roleLockReason(actor, row.original, lastSuperAdmin);
          if (locked) {
            return (
              <ExplainedBadge label={locked}>
                <RoleBadge role={row.original.role} />
              </ExplainedBadge>
            );
          }
          return (
            <Select<Role>
              aria-label={`Change role for ${row.original.display_name}`}
              className="h-8 w-36 text-xs"
              value={row.original.role}
              onValueChange={(role) => {
                if (role === row.original.role) return;
                update.mutate(
                  { id: row.original.id, body: { role } },
                  { onSuccess: () => toast.success(`Role updated to ${ROLE_LABELS[role]}`) },
                );
              }}
              options={assignableRoles.map((value) => ({ value, label: ROLE_LABELS[value] }))}
            />
          );
        },
      },
      {
        id: 'organization',
        header: 'Organization',
        cell: ({ row }) => {
          const orgId = row.original.org_id;
          if (orgId === null) return <span className="text-fg-subtle">—</span>;
          return (
            <span className="text-fg-muted">
              <OrganizationName id={orgId} />
            </span>
          );
        },
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
          <span
            className="whitespace-nowrap text-fg-muted tabular-nums"
            title={formatDateTime(row.original.last_login_at)}
          >
            {formatRelative(row.original.last_login_at)}
          </span>
        ),
      },
      {
        id: 'actions',
        header: '',
        cell: ({ row }) => {
          const active = row.original.status === 'active';
          const statusLocked = statusLockReason(actor, row.original, lastSuperAdmin);
          return (
            <div className="flex justify-end gap-1.5">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setEditTarget(row.original)}
                aria-label={`Edit ${row.original.display_name}`}
              >
                Edit
              </Button>
              <Button
                size="sm"
                variant={active ? 'ghost-danger' : 'ghost'}
                disabled={statusLocked !== null}
                title={statusLocked ?? undefined}
                onClick={() => setStatusTarget(row.original)}
              >
                {active ? 'Disable' : 'Enable'}
              </Button>
            </div>
          );
        },
      },
    ],
    [update, toast, pendingTeardowns, actor, lastSuperAdmin, assignableRoles],
  );

  return (
    <>
      <DataTable<User>
        columns={columns}
        data={query.data?.items ?? []}
        total={query.data?.total ?? 0}
        offset={offset}
        limit={limit}
        onOffsetChange={setOffset}
        loading={query.isLoading}
        toolbar={
          // Its own wrapping row, top-aligned, so opening the organization
          // picker (which unfolds in place) grows the bar downwards instead of
          // re-centring the controls beside it. On a phone: search, then role
          // and status side by side, then organization.
          <div className="flex w-full flex-wrap items-start gap-2">
            <SearchInput
              wrapperClassName="w-full sm:w-64"
              aria-label="Search users"
              placeholder="Search by name or email"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setOffset(0);
              }}
            />
            <Select<Role | 'all'>
              aria-label="Filter by role"
              className="w-[calc(50%-0.25rem)] sm:w-40"
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
            <Select<UserStatus | 'all'>
              aria-label="Filter by status"
              className="w-[calc(50%-0.25rem)] sm:w-40"
              value={statusFilter}
              onValueChange={(value) => {
                setStatusFilter(value);
                setOffset(0);
              }}
              options={[
                { value: 'all', label: 'All statuses' },
                { value: 'active', label: 'Active' },
                { value: 'disabled', label: 'Disabled' },
              ]}
            />
            <AsyncSelect<Organization>
              label="Filter by organization"
              hideLabel
              className="w-full sm:w-56"
              value={orgFilter === 'all' ? '' : orgFilter}
              onValueChange={(value) => {
                setOrgFilter(value || 'all');
                setOffset(0);
              }}
              queryKey={queryKeys.organizations.picker}
              fetchPage={({ q, limit, offset }) => organizationsApi.list({ q, limit, offset })}
              toOption={(org) => ({ value: org.id, label: org.name })}
              fixedOptions={[{ value: '', label: 'All organizations' }]}
              searchPlaceholder="Search organizations"
              emptyLabel="No organizations found."
            />
          </div>
        }
        empty={
          <EmptyState
            icon="users"
            title="No accounts match these filters"
            description="Widen the search or clear a filter to see more of the directory."
          />
        }
      />

      {editTarget ? (
        <EditUserDialog key={editTarget.id} user={editTarget} onClose={() => setEditTarget(null)} />
      ) : null}

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
