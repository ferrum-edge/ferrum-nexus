import { Link } from '@tanstack/react-router';
import { useState, type ReactElement } from 'react';
import { AUTH_PLUGIN_LABELS, DEFAULT_PAGE_SIZE, type CatalogApi } from '@ferrum-nexus/shared';
import { useCatalog } from '../hooks/useCatalog';
import { Badge } from '../components/ui/Badge';
import { Card, PageHeader } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { SearchInput } from '../components/ui/Input';
import { PaginationBar } from '../components/ui/DataTable';
import { StatusPill } from '../components/ui/StatusPill';

const GRID = 'grid gap-4 md:grid-cols-2 xl:grid-cols-3';

/** Initials for an owner's avatar tile: first letters of up to two words. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] ?? ''}${parts[parts.length - 1]![0] ?? ''}`.toUpperCase();
}

function CatalogCard({ api }: { api: CatalogApi }): ReactElement {
  return (
    <Link
      to="/catalog/$slug"
      params={{ slug: api.slug }}
      className="fx-card fx-card-interactive flex flex-col gap-3 p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-fg">{api.name}</h2>
          <p className="truncate font-mono text-xs text-fg-subtle">/{api.slug}</p>
        </div>
        <StatusPill status={api.access_state} />
      </div>

      <p className="line-clamp-3 text-sm leading-relaxed text-fg-muted">
        {api.description ?? 'No description provided.'}
      </p>

      <div className="mt-auto flex flex-col gap-2.5 border-t border-border pt-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge mono>v{api.version}</Badge>
          <Badge tone="info">{AUTH_PLUGIN_LABELS[api.auth_plugin]}</Badge>
          {api.requestable ? <Badge tone="accent">Requestable</Badge> : <Badge>Open</Badge>}
          {api.visibility === 'internal' ? <Badge tone="warning">Internal</Badge> : null}
        </div>
        {api.owner ? (
          <div className="flex min-w-0 items-center gap-1.5">
            <span
              aria-hidden="true"
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-neutral-soft text-[0.6rem] font-semibold text-fg-muted ring-1 ring-border ring-inset"
            >
              {initials(api.owner.display_name)}
            </span>
            <span className="truncate text-xs text-fg-subtle">by {api.owner.display_name}</span>
          </div>
        ) : null}
      </div>
    </Link>
  );
}

/** Placeholder card shaped like a catalog entry, shown while the list loads. */
function CatalogCardSkeleton(): ReactElement {
  return (
    <div className="fx-card flex flex-col gap-3 p-4">
      <span className="fx-skeleton block h-4 w-2/5" />
      <span className="fx-skeleton block h-3 w-1/4" />
      <span className="fx-skeleton block h-3 w-full" />
      <span className="fx-skeleton block h-3 w-4/5" />
      <div className="mt-2 flex gap-1.5 border-t border-border pt-3">
        <span className="fx-skeleton block h-5 w-14 rounded-full" />
        <span className="fx-skeleton block h-5 w-20 rounded-full" />
      </div>
    </div>
  );
}

/** Browsable list of published APIs. */
export function CatalogPage(): ReactElement {
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const limit = DEFAULT_PAGE_SIZE;

  const query = useCatalog({
    limit,
    offset,
    ...(search.trim() ? { q: search.trim() } : {}),
  });

  const items = query.data?.items ?? [];
  const total = query.data?.total ?? 0;

  return (
    <>
      <PageHeader
        title="API catalog"
        description="Every API published on this portal that you are allowed to see."
      />

      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        <SearchInput
          placeholder="Search by name, slug or description"
          aria-label="Search the catalog"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setOffset(0);
          }}
        />
        {query.isLoading ? null : (
          <p className="text-xs text-fg-subtle tabular-nums">
            {total} {total === 1 ? 'API' : 'APIs'}
            {search.trim() ? ' matching' : null}
          </p>
        )}
      </div>

      {query.isLoading ? (
        <>
          <span role="status" className="sr-only">
            Loading catalog
          </span>
          <div className={GRID} aria-hidden="true">
            {Array.from({ length: 6 }, (_, index) => (
              <CatalogCardSkeleton key={index} />
            ))}
          </div>
        </>
      ) : items.length === 0 ? (
        <Card>
          <EmptyState
            icon="catalog"
            title="No APIs found"
            description={
              search
                ? 'No catalog entry matches your search.'
                : 'Nothing has been published to this portal yet.'
            }
          />
        </Card>
      ) : (
        <>
          <div className={GRID}>
            {items.map((api) => (
              <CatalogCard key={api.id} api={api} />
            ))}
          </div>
          {total > limit ? (
            <div className="fx-card mt-4">
              <PaginationBar
                offset={offset}
                limit={limit}
                total={total}
                onOffsetChange={setOffset}
              />
            </div>
          ) : null}
        </>
      )}
    </>
  );
}
