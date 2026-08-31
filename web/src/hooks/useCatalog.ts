import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type {
  CatalogDetailResponse,
  CatalogListQuery,
  CatalogListResponse,
  CatalogSpecResponse,
} from '@ferrum-nexus/shared';
import { catalogApi } from '../lib/api';
import { queryKeys } from './keys';

/** Browse the published API catalog. */
export function useCatalog(query: CatalogListQuery = {}): UseQueryResult<CatalogListResponse> {
  return useQuery({
    queryKey: queryKeys.catalog.list(query),
    queryFn: () => catalogApi.list(query),
  });
}

/** A single catalog entry plus the caller's request/grant state. */
export function useCatalogApi(slug: string): UseQueryResult<CatalogDetailResponse> {
  return useQuery({
    queryKey: queryKeys.catalog.detail(slug),
    queryFn: () => catalogApi.detail(slug),
    enabled: slug.length > 0,
  });
}

/** The raw OpenAPI document for a catalog entry, fetched only when rendered. */
export function useCatalogSpec(slug: string, enabled = true): UseQueryResult<CatalogSpecResponse> {
  return useQuery({
    queryKey: queryKeys.catalog.spec(slug),
    queryFn: () => catalogApi.spec(slug),
    enabled: enabled && slug.length > 0,
    staleTime: 60_000,
  });
}
