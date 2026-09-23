import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type {
  ListGrantsQuery,
  ListGrantsResponse,
  RevokeGrantRequest,
  RevokeGrantResponse,
} from '@ferrum-nexus/shared';
import { grantsApi } from '../lib/api';
import { queryKeys } from './keys';

/**
 * List grants (own grants for clients, an API's grants for its provider).
 *
 * `keepPrevious` holds the current page on screen while the next one loads,
 * for a paged list that should not collapse between pages.
 */
export function useGrants(
  query: ListGrantsQuery = {},
  enabled = true,
  keepPrevious = false,
): UseQueryResult<ListGrantsResponse> {
  return useQuery({
    queryKey: queryKeys.grants.list(query),
    queryFn: () => grantsApi.list(query),
    enabled,
    ...(keepPrevious ? { placeholderData: keepPreviousData } : {}),
  });
}

/** Revoke a grant; the ACL group is removed from the consumer on Edge. */
export function useRevokeGrant(): UseMutationResult<
  RevokeGrantResponse,
  Error,
  { id: string; body?: RevokeGrantRequest }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body?: RevokeGrantRequest }) =>
      grantsApi.revoke(id, body ?? {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.grants.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.accessRequests.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.catalog.all });
    },
  });
}
