import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import {
  ERROR_CODES,
  type DeleteCredentialResponse,
  type IssueCredentialRequest,
  type IssueCredentialResponse,
  type ListCredentialsQuery,
  type ListCredentialsResponse,
  type RotateCredentialRequest,
  type RotateCredentialResponse,
} from '@ferrum-nexus/shared';
import { credentialsApi } from '../lib/api';
import { queryKeys } from './keys';

/**
 * Refresh everything that shows credential state. The Applications page counts
 * each application's active credentials, so it goes stale with the list
 * (issue #336).
 */
function invalidateCredentialViews(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.credentials.all });
  void queryClient.invalidateQueries({ queryKey: queryKeys.applications.all });
}

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
    // The response carries the plaintext secret. Once the page resets the
    // mutation on acknowledgement, drop it from the mutation cache at once
    // rather than keeping it for the default five minutes (issue #336).
    gcTime: 0,
    onSuccess: () => invalidateCredentialViews(queryClient),
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
    // Show-once secret in the response; see `useIssueCredential`.
    gcTime: 0,
    onSuccess: () => invalidateCredentialViews(queryClient),
  });
}

/**
 * Revoke and delete a credential. `clearType` asks for every HTTP Basic
 * credential of the identity to go with it.
 *
 * A `CONFLICT` is left to the caller rather than toasted: one of them is the
 * refusal that asks the owner to confirm clearing the whole HTTP Basic type,
 * which the credentials page turns into a second confirmation.
 */
export function useDeleteCredential(): UseMutationResult<
  DeleteCredentialResponse,
  Error,
  { id: string; clearType?: boolean }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, clearType }: { id: string; clearType?: boolean }) =>
      clearType ? credentialsApi.remove(id, true) : credentialsApi.remove(id),
    meta: { handledCodes: [ERROR_CODES.CONFLICT] },
    onSuccess: () => invalidateCredentialViews(queryClient),
  });
}
