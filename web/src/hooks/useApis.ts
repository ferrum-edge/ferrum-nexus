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
  DeleteApiPluginResponse,
  DeleteApiResponse,
  GetApiResponse,
  GetApiSpecResponse,
  ListApiPluginsResponse,
  ListApisQuery,
  ListApisResponse,
  PublishApiRequest,
  PublishApiResponse,
  AuthorizeApiViewerRequest,
  AuthorizeApiViewerResponse,
  DiffApiSpecRequest,
  DiffApiSpecResponse,
  GetApiRevisionDiffResponse,
  GetApiRevisionResponse,
  ListApiRevisionsResponse,
  ListApiViewersResponse,
  ListQuery,
  RestoreApiGatewayResponse,
  RevokeApiViewerResponse,
  RollbackApiSpecResponse,
  SetApiPluginRequest,
  SetApiPluginResponse,
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

/** The stored original for the provider's spec editor. */
export function useApiSpec(id: string): UseQueryResult<GetApiSpecResponse> {
  return useQuery({
    queryKey: queryKeys.apis.spec(id),
    queryFn: () => apisApi.spec(id),
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

/* ── Private documentation access ───────────────────────────────────────── */

/** Who may read this API's documentation. Not its grants — see `useGrants`. */
export function useApiViewers(
  id: string,
  query: ListQuery = {},
): UseQueryResult<ListApiViewersResponse> {
  return useQuery({
    queryKey: queryKeys.apis.viewers(id, query),
    queryFn: () => apisApi.viewers(id, query),
    enabled: id.length > 0,
  });
}

/** Authorize one account to read this API's documentation. */
export function useAuthorizeApiViewer(): UseMutationResult<
  AuthorizeApiViewerResponse,
  Error,
  { id: string; body: AuthorizeApiViewerRequest }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: AuthorizeApiViewerRequest }) =>
      apisApi.authorizeViewer(id, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.apis.all });
    },
  });
}

/** Withdraw a read authorization. Leaves any grant the account holds alone. */
export function useRevokeApiViewer(): UseMutationResult<
  RevokeApiViewerResponse,
  Error,
  { id: string; userId: string }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, userId }: { id: string; userId: string }) =>
      apisApi.revokeViewer(id, userId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.apis.all });
    },
  });
}

/* ── Specification history, change review and rollback ──────────────────── */

/** One page of retained revisions: the current one first, then newest-first. */
export function useApiRevisions(
  id: string,
  query: ListQuery = {},
): UseQueryResult<ListApiRevisionsResponse> {
  return useQuery({
    queryKey: queryKeys.apis.revisions(id, query),
    queryFn: () => apisApi.revisions(id, query),
    enabled: id.length > 0,
  });
}

/** One retained revision's document. */
export function useApiRevision(
  id: string,
  revisionId: string | null,
): UseQueryResult<GetApiRevisionResponse> {
  return useQuery({
    queryKey: queryKeys.apis.revision(id, revisionId ?? ''),
    queryFn: () => apisApi.revision(id, revisionId ?? ''),
    enabled: id.length > 0 && revisionId !== null,
  });
}

/** What rolling back to a revision would change, against the current one. */
export function useApiRevisionDiff(
  id: string,
  revisionId: string | null,
): UseQueryResult<GetApiRevisionDiffResponse> {
  return useQuery({
    queryKey: queryKeys.apis.revisionDiff(id, revisionId ?? ''),
    queryFn: () => apisApi.revisionDiff(id, revisionId ?? ''),
    enabled: id.length > 0 && revisionId !== null,
  });
}

/**
 * Review an upload before publishing it.
 *
 * A mutation rather than a query because the document is the input and the
 * provider asks for the comparison explicitly; nothing is stored, so there is
 * nothing to invalidate.
 */
export function useDiffApiSpec(): UseMutationResult<
  DiffApiSpecResponse,
  Error,
  { id: string; body: DiffApiSpecRequest }
> {
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: DiffApiSpecRequest }) =>
      apisApi.diffSpec(id, body),
  });
}

/** Redeploy a retained revision as a new revision of the same API. */
export function useRollbackApiSpec(): UseMutationResult<
  RollbackApiSpecResponse,
  Error,
  { id: string; revisionId: string }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, revisionId }: { id: string; revisionId: string }) =>
      apisApi.rollbackSpec(id, revisionId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.apis.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.catalog.all });
    },
  });
}

/**
 * Rebuild the gateway deployment of an API the gateway no longer serves.
 *
 * Invalidates the catalog too: until the restore lands, the API's public path
 * answers nothing, so a catalog entry showing it as reachable was wrong.
 */
export function useRestoreApiGateway(): UseMutationResult<
  RestoreApiGatewayResponse,
  Error,
  string
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apisApi.restoreGateway(id),
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

/* ── Plugin palette ───────────────────────────────────────────────────────
 *
 * Only the state is fetched: which palette plugins this API has switched on.
 * The palette itself is the static `PROVIDER_PLUGINS` catalog imported from
 * `@ferrum-nexus/shared`, so there is no schema query.
 */

/** Palette plugins currently configured on one API. */
export function useApiPlugins(id: string, enabled = true): UseQueryResult<ListApiPluginsResponse> {
  return useQuery({
    queryKey: queryKeys.apis.plugins(id),
    queryFn: () => apisApi.listPlugins(id),
    enabled: enabled && id.length > 0,
  });
}

/** Create or replace one palette plugin on the gateway. */
export function useSetApiPlugin(): UseMutationResult<
  SetApiPluginResponse,
  Error,
  { id: string; name: string; body: SetApiPluginRequest }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name, body }: { id: string; name: string; body: SetApiPluginRequest }) =>
      apisApi.setPlugin(id, name, body),
    onSuccess: (_result, variables) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.apis.plugins(variables.id) });
    },
  });
}

/** Detach and delete one palette plugin. */
export function useRemoveApiPlugin(): UseMutationResult<
  DeleteApiPluginResponse,
  Error,
  { id: string; name: string }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => apisApi.removePlugin(id, name),
    onSuccess: (_result, variables) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.apis.plugins(variables.id) });
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
