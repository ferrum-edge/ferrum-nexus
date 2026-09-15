import { auditActorLabel } from '../../lib/audit';
import { useMemo, useState, type ReactElement } from 'react';
import { DEFAULT_PAGE_SIZE, type AuditLog } from '@ferrum-nexus/shared';
import { formatDateTime, formatRelative, humanize } from '../../lib/format';
import { useAuditLogs } from '../../hooks/useAuditLogs';
import { RoleGuard } from '../../components/layout/RoleGuard';
import { Badge, type BadgeTone } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { PageHeader } from '../../components/ui/Card';
import { DataTable, type Columns } from '../../components/ui/DataTable';
import { EmptyState } from '../../components/ui/EmptyState';
import { Input, SearchInput } from '../../components/ui/Input';

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

/**
 * Colour an action by what it does, read off its own name.
 *
 * The catalog lives on the server and grows with every feature, so the tone is
 * derived from the verb rather than from a table the browser would have to be
 * taught about — an unrecognised action lands on the neutral tone instead of
 * being mis-coloured.
 */
function actionTone(action: string): BadgeTone {
  if (/deny|denied|revoke|delete|disable|fail|remove|purge/.test(action)) return 'danger';
  if (/approve|create|publish|enable|grant|issue|repair/.test(action)) return 'success';
  if (/login|logout|session|settings|update|register/.test(action)) return 'neutral';
  return 'info';
}

/**
 * A filter label small enough to sit in the table's toolbar.
 *
 * The control is wrapped rather than given a width class: `Input` hard-codes
 * `w-full`, and `cn` only joins class lists, so a competing width utility would
 * be decided by stylesheet order rather than by this call.
 */
function ToolbarField({
  label,
  htmlFor,
  width,
  children,
}: {
  label: string;
  htmlFor: string;
  width: string;
  children: ReactElement;
}): ReactElement {
  return (
    <span className="flex items-center gap-1.5">
      <label htmlFor={htmlFor} className="text-xs whitespace-nowrap text-fg-subtle">
        {label}
      </label>
      <span className={width}>{children}</span>
    </span>
  );
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
          <span
            className="block whitespace-nowrap text-fg-muted tabular-nums"
            title={formatDateTime(row.original.created_at)}
          >
            {formatRelative(row.original.created_at)}
          </span>
        ),
      },
      {
        id: 'action',
        header: 'Action',
        cell: ({ row }) => (
          <span className="block">
            <Badge tone={actionTone(row.original.action)}>{humanize(row.original.action)}</Badge>
            <code className="mt-1 block font-mono text-xs text-fg-subtle">
              {row.original.action}
            </code>
          </span>
        ),
      },
      {
        id: 'actor',
        header: 'Actor',
        cell: ({ row }) => (
          <span className="block">
            <span className="block text-fg">{auditActorLabel(row.original)}</span>
            {row.original.actor_role ? (
              <code className="mt-0.5 block font-mono text-xs text-fg-subtle">
                {row.original.actor_role}
              </code>
            ) : null}
          </span>
        ),
      },
      {
        id: 'target',
        header: 'Target',
        cell: ({ row }) => (
          <span className="block">
            <span className="block text-fg">{humanize(row.original.target_type)}</span>
            <code className="mt-0.5 block font-mono text-xs text-fg-subtle">
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
      {
        id: 'details',
        header: 'Details',
        cell: ({ row }) => {
          const details = row.original.details;
          if (!details || Object.keys(details).length === 0) {
            return <span className="text-xs text-fg-subtle">—</span>;
          }
          return (
            <details className="max-w-xs">
              <summary className="cursor-pointer text-xs font-medium text-accent hover:underline">
                JSON
              </summary>
              <pre className="mt-2 overflow-x-auto rounded-md border border-border bg-inset p-3 font-mono text-xs text-fg-muted">
                {JSON.stringify(details, null, 2)}
              </pre>
            </details>
          );
        },
      },
    ],
    [],
  );

  return (
    <DataTable<AuditLog>
      columns={columns}
      data={query.data?.items ?? []}
      total={query.data?.total ?? 0}
      offset={offset}
      limit={limit}
      onOffsetChange={setOffset}
      loading={query.isLoading}
      toolbar={
        <form
          className="flex w-full flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setOffset(0);
            setApplied(filters);
          }}
        >
          <SearchInput
            wrapperClassName="w-full sm:w-60"
            id="filter-action"
            aria-label="Filter by action"
            placeholder="Action, e.g. access_request.approve"
            value={filters.action}
            onChange={(event) => setFilters({ ...filters, action: event.target.value })}
          />
          <span className="w-full sm:w-40">
            <Input
              id="filter-actor"
              aria-label="Filter by actor user ID"
              placeholder="Actor user ID"
              value={filters.actor}
              onChange={(event) => setFilters({ ...filters, actor: event.target.value })}
            />
          </span>
          <span className="w-full sm:w-40">
            <Input
              id="filter-target"
              aria-label="Filter by target ID"
              placeholder="Target ID"
              value={filters.target}
              onChange={(event) => setFilters({ ...filters, target: event.target.value })}
            />
          </span>
          <ToolbarField label="From" htmlFor="filter-from" width="w-52">
            <Input
              id="filter-from"
              type="datetime-local"
              value={filters.from}
              onChange={(event) => setFilters({ ...filters, from: event.target.value })}
            />
          </ToolbarField>
          <ToolbarField label="To" htmlFor="filter-to" width="w-52">
            <Input
              id="filter-to"
              type="datetime-local"
              value={filters.to}
              onChange={(event) => setFilters({ ...filters, to: event.target.value })}
            />
          </ToolbarField>
          <div className="flex items-center gap-2 sm:ml-auto">
            <Button type="submit" variant="primary" size="sm">
              Apply filters
            </Button>
            <Button
              variant="ghost"
              size="sm"
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
      }
      empty={
        <EmptyState
          icon="audit"
          title="No audit entries match these filters"
          description="Every state-changing request lands here; widen the window or clear a filter."
        />
      }
    />
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
