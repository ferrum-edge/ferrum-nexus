import {
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

/** List grants (own grants for clients, an API's grants for its provider). */
export function useGrants(
  query: ListGrantsQuery = {},
  enabled = true,
): UseQueryResult<ListGrantsResponse> {
  return useQuery({
    queryKey: queryKeys.grants.list(query),
    queryFn: () => grantsApi.list(query),
    enabled,
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
