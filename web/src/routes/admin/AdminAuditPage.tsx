import { useMemo, useState, type ReactElement } from 'react';
import { DEFAULT_PAGE_SIZE, type AuditLog } from '@ferrum-nexus/shared';
import { formatDateTime, humanize } from '../../lib/format';
import { useAuditLogs } from '../../hooks/useAuditLogs';
import { RoleGuard } from '../../components/layout/RoleGuard';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, PageHeader } from '../../components/ui/Card';
import { DataTable, type Columns } from '../../components/ui/DataTable';
import { EmptyState } from '../../components/ui/EmptyState';
import { Field, Input } from '../../components/ui/Input';

interface Filters {
  action: string;
  actor: string;
  target: string;
  from: string;
  to: string;
}

const EMPTY_FILTERS: Filters = { action: '', actor: '', target: '', from: '', to: '' };

/** Convert a `datetime-local` value into an ISO-8601 instant. */
function toIso(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function AuditTable(): ReactElement {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS);
  const [offset, setOffset] = useState(0);
  const limit = DEFAULT_PAGE_SIZE;

  const query = useAuditLogs({
    limit,
    offset,
    ...(applied.action.trim() ? { action: applied.action.trim() } : {}),
    ...(applied.actor.trim() ? { actor_user_id: applied.actor.trim() } : {}),
    ...(applied.target.trim() ? { target_id: applied.target.trim() } : {}),
    ...(toIso(applied.from) ? { from: toIso(applied.from) } : {}),
    ...(toIso(applied.to) ? { to: toIso(applied.to) } : {}),
  });

  const columns = useMemo<Columns<AuditLog>>(
    () => [
      {
        id: 'time',
        header: 'When',
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-fg-muted">
            {formatDateTime(row.original.created_at)}
          </span>
        ),
      },
      {
        id: 'action',
        header: 'Action',
        cell: ({ row }) => (
          <span>
            <span className="block font-medium text-fg">{humanize(row.original.action)}</span>
            <code className="block font-mono text-xs text-fg-subtle">{row.original.action}</code>
          </span>
        ),
      },
      {
        id: 'actor',
        header: 'Actor',
        cell: ({ row }) => (
          <span>
            <span className="block text-fg">
              {row.original.actor?.display_name ?? row.original.actor_user_id ?? 'system'}
            </span>
            {row.original.actor_role ? (
              <Badge className="mt-0.5">{row.original.actor_role}</Badge>
            ) : null}
          </span>
        ),
      },
      {
        id: 'target',
        header: 'Target',
        cell: ({ row }) => (
          <span>
            <span className="block text-fg">{row.original.target_type}</span>
            <code className="block font-mono text-xs text-fg-subtle">
              {row.original.target_id ?? '—'}
            </code>
          </span>
        ),
      },
      {
        id: 'ip',
        header: 'IP',
        cell: ({ row }) => (
          <code className="font-mono text-xs text-fg-subtle">{row.original.ip ?? '—'}</code>
        ),
      },
    ],
    [],
  );

  return (
    <>
      <Card className="mb-4 p-4">
        <form
          className="grid gap-3 md:grid-cols-5"
          onSubmit={(event) => {
            event.preventDefault();
            setOffset(0);
            setApplied(filters);
          }}
        >
          <Field label="Action" htmlFor="filter-action">
            <Input
              id="filter-action"
              placeholder="access_request.approve"
              value={filters.action}
              onChange={(event) => setFilters({ ...filters, action: event.target.value })}
            />
          </Field>
          <Field label="Actor user id" htmlFor="filter-actor">
            <Input
              id="filter-actor"
              value={filters.actor}
              onChange={(event) => setFilters({ ...filters, actor: event.target.value })}
            />
          </Field>
          <Field label="Target id" htmlFor="filter-target">
            <Input
              id="filter-target"
              value={filters.target}
              onChange={(event) => setFilters({ ...filters, target: event.target.value })}
            />
          </Field>
          <Field label="From" htmlFor="filter-from">
            <Input
              id="filter-from"
              type="datetime-local"
              value={filters.from}
              onChange={(event) => setFilters({ ...filters, from: event.target.value })}
            />
          </Field>
          <Field label="To" htmlFor="filter-to">
            <Input
              id="filter-to"
              type="datetime-local"
              value={filters.to}
              onChange={(event) => setFilters({ ...filters, to: event.target.value })}
            />
          </Field>
          <div className="flex items-end gap-2 md:col-span-5">
            <Button type="submit" variant="primary">
              Apply filters
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setFilters(EMPTY_FILTERS);
                setApplied(EMPTY_FILTERS);
                setOffset(0);
              }}
            >
              Reset
            </Button>
          </div>
        </form>
      </Card>

      <DataTable<AuditLog>
        columns={columns}
        data={query.data?.items ?? []}
        total={query.data?.total ?? 0}
        offset={offset}
        limit={limit}
        onOffsetChange={setOffset}
        loading={query.isLoading}
        empty={<EmptyState icon="audit" title="No audit entries match these filters" />}
      />
    </>
  );
}

/** Filterable audit trail. */
export function AdminAuditPage(): ReactElement {
  return (
    <RoleGuard minRole="admin">
      <PageHeader
        title="Audit log"
        description="Append-only record of every state-changing request handled by this portal."
      />
      <AuditTable />
    </RoleGuard>
  );
}
