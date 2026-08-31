import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type {
  DeleteCredentialResponse,
  IssueCredentialRequest,
  IssueCredentialResponse,
  ListCredentialsQuery,
  ListCredentialsResponse,
  RotateCredentialRequest,
  RotateCredentialResponse,
} from '@ferrum-nexus/shared';
import { credentialsApi } from '../lib/api';
import { queryKeys } from './keys';

/** The caller's gateway credential metadata (never any secret material). */
export function useCredentials(
  query: ListCredentialsQuery = {},
): UseQueryResult<ListCredentialsResponse> {
  return useQuery({
    queryKey: queryKeys.credentials.list(query),
    queryFn: () => credentialsApi.list(query),
  });
}

/** Issue a credential; the plaintext in the response is shown exactly once. */
export function useIssueCredential(): UseMutationResult<
  IssueCredentialResponse,
  Error,
  IssueCredentialRequest
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: IssueCredentialRequest) => credentialsApi.issue(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.credentials.all });
    },
  });
}

/** Rotate a credential; the replacement secret is shown exactly once. */
export function useRotateCredential(): UseMutationResult<
  RotateCredentialResponse,
  Error,
  { id: string; body?: RotateCredentialRequest }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body?: RotateCredentialRequest }) =>
      credentialsApi.rotate(id, body ?? {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.credentials.all });
    },
  });
}

/** Revoke and delete a credential. */
export function useDeleteCredential(): UseMutationResult<DeleteCredentialResponse, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => credentialsApi.remove(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.credentials.all });
    },
  });
}
