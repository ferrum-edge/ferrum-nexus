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
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type {
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

/** The caller's applications; an admin may pass `owner_user_id`. */
export function useApplications(
  query: ListApplicationsQuery = {},
  enabled = true,
): UseQueryResult<ListApplicationsResponse> {
  return useQuery({
    queryKey: queryKeys.applications.list(query),
    queryFn: () => applicationsApi.list(query),
    enabled,
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

/** Everything an application mutation has to clear. */
function useApplicationInvalidation(): () => void {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.applications.all });
    void queryClient.invalidateQueries({ queryKey: queryKeys.credentials.all });
    void queryClient.invalidateQueries({ queryKey: queryKeys.accessRequests.all });
    void queryClient.invalidateQueries({ queryKey: queryKeys.grants.all });
  };
}

export function useCreateApplication(): UseMutationResult<
  CreateApplicationResponse,
  Error,
  CreateApplicationRequest
> {
  const invalidate = useApplicationInvalidation();
  return useMutation({
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
  const invalidate = useApplicationInvalidation();
  return useMutation({
    mutationFn: (id: string) => applicationsApi.remove(id),
    onSuccess: invalidate,
  });
}
