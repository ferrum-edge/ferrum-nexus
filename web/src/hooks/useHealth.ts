import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { EdgeHealthResponse, HealthResponse } from '@ferrum-nexus/shared';
import { healthApi } from '../lib/api';
import { queryKeys } from './keys';

/** Aggregate app health, polled while the page is open. */
export function useHealth(enabled = true): UseQueryResult<HealthResponse> {
  return useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    enabled,
    refetchInterval: 30_000,
    retry: false,
  });
}

/** Ferrum Edge Admin API reachability. */
export function useEdgeHealth(enabled = true): UseQueryResult<EdgeHealthResponse> {
  return useQuery({
    queryKey: queryKeys.edgeHealth,
    queryFn: () => healthApi.edge(),
    enabled,
    refetchInterval: 60_000,
    retry: false,
  });
}
