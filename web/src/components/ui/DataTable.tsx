import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import type { ReactElement, ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Button } from './Button';
import { Icon } from './Icon';

/**
 * Column list type used by every page, so table columns are declared with the
 * exact generic arguments {@link DataTable} expects.
 */
export type Columns<TData> = Array<ColumnDef<TData, unknown>>;

export interface DataTableProps<TData> {
  columns: Columns<TData>;
  data: TData[];
  /** Total row count from the server envelope, for the pagination footer. */
  total?: number;
  offset?: number;
  limit?: number;
  onOffsetChange?: (offset: number) => void;
  loading?: boolean;
  empty?: ReactNode;
  /** Row click handler; makes rows keyboard-activatable when provided. */
  onRowClick?: (row: TData) => void;
  className?: string;
  /** Optional toolbar rendered above the header row (filters, counts). */
  toolbar?: ReactNode;
}

/** Placeholder rows shown while the first page is loading. */
function SkeletonRows({ columns, rows = 5 }: { columns: number; rows?: number }): ReactElement {
  return (
    <>
      {Array.from({ length: rows }, (_, rowIndex) => (
        <tr key={rowIndex} className="border-b border-border last:border-b-0">
          {Array.from({ length: columns }, (_, colIndex) => (
            <td key={colIndex} className="px-4 py-3">
              <span
                className="fx-skeleton block h-3.5"
                style={{
                  width: `${colIndex === 0 ? 60 : 35 + ((rowIndex * 7 + colIndex * 13) % 40)}%`,
                }}
              />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

/**
 * Server-paginated table. Pagination is `manual` — the parent owns
 * `offset`/`limit` and refetches; the table only renders the current page.
 */
export function DataTable<TData>({
  columns,
  data,
  total,
  offset = 0,
  limit = 25,
  onOffsetChange,
  loading = false,
  empty,
  onRowClick,
  className,
  toolbar,
}: DataTableProps<TData>): ReactElement {
  const table = useReactTable<TData>({
    data,
    columns,
    manualPagination: true,
    getCoreRowModel: getCoreRowModel(),
  });

  const rows = table.getRowModel().rows;
  const rowCount = total ?? data.length;
  const showPagination = onOffsetChange !== undefined && rowCount > limit;

  return (
    <div className={cn('fx-card overflow-hidden', className)}>
      {toolbar ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
          {toolbar}
        </div>
      ) : null}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm" aria-busy={loading || undefined}>
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id} className="border-b border-border bg-inset/70">
                {headerGroup.headers.map((header) => (
                  <th
                    key={header.id}
                    scope="col"
                    className="px-4 py-2.5 text-left text-[0.7rem] font-semibold tracking-[0.08em] whitespace-nowrap text-fg-subtle uppercase"
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {loading ? (
              <SkeletonRows columns={columns.length} />
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length}>{empty}</td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr
                  key={row.id}
                  onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                  onKeyDown={
                    onRowClick
                      ? (event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            onRowClick(row.original);
                          }
                        }
                      : undefined
                  }
                  className={cn(
                    'border-b border-border transition-colors last:border-b-0 hover:bg-surface-hover',
                    onRowClick &&
                      'cursor-pointer focus-visible:bg-accent-soft/40 focus-visible:outline-none',
                  )}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="px-4 py-3 align-middle text-fg">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {showPagination ? (
        <PaginationBar
          offset={offset}
          limit={limit}
          total={rowCount}
          onOffsetChange={onOffsetChange}
        />
      ) : null}
    </div>
  );
}

export interface PaginationBarProps {
  offset: number;
  limit: number;
  total: number;
  onOffsetChange: (offset: number) => void;
}

/** Prev/next pagination footer driven by the server's `total`. */
export function PaginationBar({
  offset,
  limit,
  total,
  onOffsetChange,
}: PaginationBarProps): ReactElement {
  const first = total === 0 ? 0 : offset + 1;
  const last = Math.min(offset + limit, total);
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.max(1, Math.ceil(total / limit));
  return (
    <div className="flex items-center justify-between gap-3 border-t border-border bg-inset/40 px-4 py-2.5">
      <p className="text-xs text-fg-muted tabular-nums">
        <span className="text-fg">
          {first}–{last}
        </span>{' '}
        of {total}
        <span className="text-fg-subtle">
          {' '}
          · page {page} of {pages}
        </span>
      </p>
      <div className="flex items-center gap-1.5">
        <Button
          size="sm"
          variant="ghost"
          disabled={offset <= 0}
          onClick={() => onOffsetChange(Math.max(0, offset - limit))}
          aria-label="Previous page"
        >
          <Icon name="chevron-left" />
          Prev
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={offset + limit >= total}
          onClick={() => onOffsetChange(offset + limit)}
          aria-label="Next page"
        >
          Next
          <Icon name="chevron-right" />
        </Button>
      </div>
    </div>
  );
}
