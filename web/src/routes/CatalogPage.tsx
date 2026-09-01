import { Link } from '@tanstack/react-router';
import { useState, type ReactElement } from 'react';
import { AUTH_PLUGIN_LABELS, DEFAULT_PAGE_SIZE, type CatalogApi } from '@ferrum-nexus/shared';
import { truncate } from '../lib/format';
import { useCatalog } from '../hooks/useCatalog';
import { Badge } from '../components/ui/Badge';
import { Card, PageHeader } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { Icon } from '../components/ui/Icon';
import { Input } from '../components/ui/Input';
import { PaginationBar } from '../components/ui/DataTable';
import { LoadingPanel } from '../components/ui/Spinner';
import { StatusPill } from '../components/ui/StatusPill';

function CatalogCard({ api }: { api: CatalogApi }): ReactElement {
  return (
    <Link
      to="/catalog/$slug"
      params={{ slug: api.slug }}
      className="fx-card flex flex-col gap-3 p-4 transition-colors hover:border-border-strong hover:bg-inset"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-fg">{api.name}</h2>
          <p className="truncate font-mono text-xs text-fg-subtle">/{api.slug}</p>
        </div>
        <StatusPill status={api.access_state} />
      </div>
      <p className="text-sm text-fg-muted">
        {api.description ? truncate(api.description, 160) : 'No description provided.'}
      </p>
      <div className="mt-auto flex flex-wrap items-center gap-1.5">
        <Badge>v{api.version}</Badge>
        <Badge tone="info">{AUTH_PLUGIN_LABELS[api.auth_plugin]}</Badge>
        {api.requestable ? <Badge tone="accent">Requestable</Badge> : <Badge>Open</Badge>}
        {api.visibility === 'internal' ? <Badge tone="warning">Internal</Badge> : null}
        {api.owner ? (
          <span className="text-xs text-fg-subtle">by {api.owner.display_name}</span>
        ) : null}
      </div>
    </Link>
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

  return (
    <>
      <PageHeader
        title="API catalog"
        description="Every API published on this portal that you are allowed to see."
      />

      <div className="mb-4 flex items-center gap-2">
        <div className="relative w-full max-w-sm">
          <Icon
            name="search"
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-fg-subtle"
          />
          <Input
            className="pl-9"
            placeholder="Search by name, slug or description"
            aria-label="Search the catalog"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setOffset(0);
            }}
          />
        </div>
      </div>

      {query.isLoading ? (
        <Card>
          <LoadingPanel label="Loading catalog" />
        </Card>
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
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {items.map((api) => (
              <CatalogCard key={api.id} api={api} />
            ))}
          </div>
          {(query.data?.total ?? 0) > limit ? (
            <div className="fx-card mt-4">
              <PaginationBar
                offset={offset}
                limit={limit}
                total={query.data?.total ?? 0}
                onOffsetChange={setOffset}
              />
            </div>
          ) : null}
        </>
      )}
    </>
  );
}
