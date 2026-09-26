/**
 * Application identities — an account's integrations, each with its own
 * approved APIs and its own credentials.
 *
 * Invalidation reaches further than this resource: creating or deleting an
 * application changes which identities the credential and access-request forms
 * can offer, and deleting one revokes its grants and credentials outright. So
 * a mutation here clears the credential and access caches too, rather than
 * leaving a page showing an identity that no longer exists.
 */

import {
  keepPreviousData,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type {
  Application,
  CreateApplicationRequest,
  CreateApplicationResponse,
  DeleteApplicationResponse,
  GetApplicationResponse,
  ListApplicationsQuery,
  ListApplicationsResponse,
  UpdateApplicationRequest,
  UpdateApplicationResponse,
} from '@ferrum-nexus/shared';
import { applicationsApi } from '../lib/api';
import { queryKeys } from './keys';

/**
 * The caller's applications; an admin may pass `owner_user_id`.
 *
 * `keepPrevious` holds the current page on screen while the next one loads.
 */
export function useApplications(
  query: ListApplicationsQuery = {},
  enabled = true,
  keepPrevious = false,
): UseQueryResult<ListApplicationsResponse> {
  return useQuery({
    queryKey: queryKeys.applications.list(query),
    queryFn: () => applicationsApi.list(query),
    enabled,
    ...(keepPrevious ? { placeholderData: keepPreviousData } : {}),
  });
}

/** One application, with its live grant and credential counts. */
export function useApplication(id: string): UseQueryResult<GetApplicationResponse> {
  return useQuery({
    queryKey: queryKeys.applications.detail(id),
    queryFn: () => applicationsApi.get(id),
    enabled: id.length > 0,
  });
}

/**
 * The applications with these ids, keyed by id, fetched one by one.
 *
 * For naming the identity of rows that reference an application — a page of
 * credentials — without loading every application the account owns and hoping
 * the referenced ones are on the first page. Each read shares the detail
 * cache, and an id that is still loading (or failed) is simply absent.
 */
export function useApplicationsById(ids: readonly string[]): ReadonlyMap<string, Application> {
  const unique = [...new Set(ids)];
  return useQueries({
    queries: unique.map((id) => ({
      queryKey: queryKeys.applications.detail(id),
      queryFn: () => applicationsApi.get(id),
      staleTime: 30_000,
    })),
    combine: byId,
  });
}

/**
 * Module-level so `useQueries` sees a stable `combine` and memoizes its result
 * instead of building a new map on every render.
 */
function byId(
  results: ReadonlyArray<{ data?: GetApplicationResponse }>,
): ReadonlyMap<string, Application> {
  return new Map(
    results
      .map((result) => result.data?.application)
      .filter((application): application is Application => application !== undefined)
      .map((application) => [application.id, application]),
  );
}

/** Everything an application mutation has to clear. */
function useApplicationInvalidation(includeGrantDependents = false): () => void {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.applications.all });
    void queryClient.invalidateQueries({ queryKey: queryKeys.credentials.all });
    void queryClient.invalidateQueries({ queryKey: queryKeys.accessRequests.all });
    void queryClient.invalidateQueries({ queryKey: queryKeys.grants.all });
    if (includeGrantDependents) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.catalog.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.apis.all });
    }
  };
}

export function useCreateApplication(): UseMutationResult<
  CreateApplicationResponse,
  Error,
  CreateApplicationRequest
> {
  const invalidate = useApplicationInvalidation();
  return useMutation({
    meta: { silent: true },
    mutationFn: (body: CreateApplicationRequest) => applicationsApi.create(body),
    onSuccess: invalidate,
  });
}

export function useUpdateApplication(): UseMutationResult<
  UpdateApplicationResponse,
  Error,
  { id: string; body: UpdateApplicationRequest }
> {
  const invalidate = useApplicationInvalidation();
  return useMutation({
    meta: { silent: true },
    mutationFn: ({ id, body }: { id: string; body: UpdateApplicationRequest }) =>
      applicationsApi.update(id, body),
    onSuccess: invalidate,
  });
}

/** Destructive: the gateway identity goes, and its credentials stop working. */
export function useDeleteApplication(): UseMutationResult<
  DeleteApplicationResponse,
  Error,
  string
> {
  const invalidate = useApplicationInvalidation(true);
  return useMutation({
    meta: { silent: true },
    mutationFn: (id: string) => applicationsApi.remove(id),
    onSuccess: invalidate,
  });
}
