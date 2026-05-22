import Fuse from 'fuse.js';

export interface CatalogSearchItem {
  id: string;
  title: string;
  slug: string;
  version: string;
  tags: string[];
  description: string | null;
  providerName: string;
  contactName: string | null;
  contactEmail: string | null;
  contactUrl: string | null;
  operationPaths: string[];
  operationSummaries: string[];
  operationCount: number;
  requestable: boolean;
  lifecycle: string;
  keyFactsSummary: string[];
}

export function searchCatalog(items: CatalogSearchItem[], query: string): CatalogSearchItem[] {
  const trimmed = query.trim();
  if (trimmed.length < 2) return items;
  const fuse = new Fuse(items, {
    threshold: 0.2,
    ignoreLocation: true,
    minMatchCharLength: 2,
    keys: [
      { name: 'title', weight: 5 },
      { name: 'tags', weight: 3 },
      { name: 'description', weight: 2 },
      { name: 'providerName', weight: 2 },
      { name: 'contactName', weight: 1 },
      { name: 'contactEmail', weight: 1 },
      { name: 'contactUrl', weight: 1 },
      { name: 'operationPaths', weight: 2 },
      { name: 'operationSummaries', weight: 1 },
      { name: 'slug', weight: 1 },
      { name: 'keyFactsSummary', weight: 1 },
    ],
  });
  return fuse.search(query).map((result) => result.item);
}
