import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type {
  ApproveAccessRequestResponse,
  CancelAccessRequestResponse,
  CreateAccessRequestRequest,
  CreateAccessRequestResponse,
  DecideAccessRequestRequest,
  DenyAccessRequestResponse,
  ListAccessRequestsQuery,
  ListAccessRequestsResponse,
} from '@ferrum-nexus/shared';
import { accessRequestsApi } from '../lib/api';
import { queryKeys } from './keys';

/** List access requests (own requests, or an API's inbox for its provider). */
export function useAccessRequests(
  query: ListAccessRequestsQuery = {},
  enabled = true,
): UseQueryResult<ListAccessRequestsResponse> {
  return useQuery({
    queryKey: queryKeys.accessRequests.list(query),
    queryFn: () => accessRequestsApi.list(query),
    enabled,
  });
}

function useInvalidateAccess(): () => void {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.accessRequests.all });
    void queryClient.invalidateQueries({ queryKey: queryKeys.grants.all });
    void queryClient.invalidateQueries({ queryKey: queryKeys.catalog.all });
    void queryClient.invalidateQueries({ queryKey: queryKeys.apis.all });
  };
}

/** Submit an access request with a justification. */
export function useCreateAccessRequest(): UseMutationResult<
  CreateAccessRequestResponse,
  Error,
  CreateAccessRequestRequest
> {
  const invalidate = useInvalidateAccess();
  return useMutation({
    mutationFn: (body: CreateAccessRequestRequest) => accessRequestsApi.create(body),
    onSuccess: invalidate,
  });
}

/** Withdraw one of the caller's own pending requests. */
export function useCancelAccessRequest(): UseMutationResult<
  CancelAccessRequestResponse,
  Error,
  string
> {
  const invalidate = useInvalidateAccess();
  return useMutation({
    mutationFn: (id: string) => accessRequestsApi.cancel(id),
    onSuccess: invalidate,
  });
}

/** Approve a request; the ACL group lands on the requester's consumer. */
export function useApproveAccessRequest(): UseMutationResult<
  ApproveAccessRequestResponse,
  Error,
  { id: string; body?: DecideAccessRequestRequest }
> {
  const invalidate = useInvalidateAccess();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body?: DecideAccessRequestRequest }) =>
      accessRequestsApi.approve(id, body ?? {}),
    onSuccess: invalidate,
  });
}

/** Deny a request with an optional reviewer note. */
export function useDenyAccessRequest(): UseMutationResult<
  DenyAccessRequestResponse,
  Error,
  { id: string; body?: DecideAccessRequestRequest }
> {
  const invalidate = useInvalidateAccess();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body?: DecideAccessRequestRequest }) =>
      accessRequestsApi.deny(id, body ?? {}),
    onSuccess: invalidate,
  });
}
