import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type {
  ApiUsageResponse,
  CreateTestConsumerRequest,
  CreateTestConsumerResponse,
  DeleteApiResponse,
  GetApiResponse,
  ListApisQuery,
  ListApisResponse,
  PublishApiRequest,
  PublishApiResponse,
  UpdateApiRequest,
  UpdateApiResponse,
  UpdateApiSpecRequest,
  UpdateApiSpecResponse,
} from '@ferrum-nexus/shared';
import { apisApi } from '../lib/api';
import { queryKeys } from './keys';

/** List APIs; providers default to `mine`, admins pass `mine: false`. */
export function useApis(
  query: ListApisQuery = {},
  enabled = true,
): UseQueryResult<ListApisResponse> {
  return useQuery({
    queryKey: queryKeys.apis.list(query),
    queryFn: () => apisApi.list(query),
    enabled,
  });
}

/** The caller's own published APIs. */
export function useMyApis(
  query: Omit<ListApisQuery, 'mine'> = {},
  enabled = true,
): UseQueryResult<ListApisResponse> {
  return useApis({ ...query, mine: true }, enabled);
}

/** A single API with its current spec metadata and counters. */
export function useApi(id: string): UseQueryResult<GetApiResponse> {
  return useQuery({
    queryKey: queryKeys.apis.detail(id),
    queryFn: () => apisApi.get(id),
    enabled: id.length > 0,
  });
}

/**
 * Gateway counters and backend state for one API.
 *
 * Polled every 30s while the page is open. The route answers `200` with
 * `available: false` when the gateway cannot be read, so a down gateway shows
 * as a message on the card rather than as a query error; `retry: false` keeps a
 * genuine failure (a 403, say) from being retried behind the user's back.
 */
export function useApiUsage(id: string, enabled = true): UseQueryResult<ApiUsageResponse> {
  return useQuery({
    queryKey: queryKeys.apis.usage(id),
    queryFn: () => apisApi.usage(id),
    enabled: enabled && id.length > 0,
    refetchInterval: 30_000,
    retry: false,
  });
}

/** Publish a new API (creates the Edge proxy and its plugins). */
export function usePublishApi(): UseMutationResult<PublishApiResponse, Error, PublishApiRequest> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: PublishApiRequest) => apisApi.publish(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.apis.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.catalog.all });
    },
  });
}

/** Patch an API's safe runtime settings. */
export function useUpdateApi(): UseMutationResult<
  UpdateApiResponse,
  Error,
  { id: string; body: UpdateApiRequest }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateApiRequest }) => apisApi.update(id, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.apis.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.catalog.all });
    },
  });
}

/** Publish a new spec revision for an API. */
export function useUpdateApiSpec(): UseMutationResult<
  UpdateApiSpecResponse,
  Error,
  { id: string; body: UpdateApiSpecRequest }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateApiSpecRequest }) =>
      apisApi.updateSpec(id, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.apis.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.catalog.all });
    },
  });
}

/** Delete an API and its Edge proxy. */
export function useDeleteApi(): UseMutationResult<DeleteApiResponse, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apisApi.remove(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.apis.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.catalog.all });
    },
  });
}

/** Create the provider's sandbox consumer; returns show-once credentials. */
export function useCreateTestConsumer(): UseMutationResult<
  CreateTestConsumerResponse,
  Error,
  { id: string; body?: CreateTestConsumerRequest }
> {
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body?: CreateTestConsumerRequest }) =>
      apisApi.createTestConsumer(id, body ?? {}),
  });
}
