import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type {
  CreateOrganizationRequest,
  CreateOrganizationResponse,
  GetUserResponse,
  ListOrganizationsQuery,
  ListOrganizationsResponse,
  ListUsersQuery,
  ListUsersResponse,
  RetryGatewayTeardownResponse,
  UpdateMeRequest,
  UpdateMeResponse,
  UpdateUserRequest,
  UpdateUserResponse,
} from '@ferrum-nexus/shared';
import { organizationsApi, usersApi } from '../lib/api';
import { queryKeys } from './keys';

/** Admin user directory. */
export function useUsers(
  query: ListUsersQuery = {},
  enabled = true,
): UseQueryResult<ListUsersResponse> {
  return useQuery({
    queryKey: queryKeys.users.list(query),
    queryFn: () => usersApi.list(query),
    enabled,
  });
}

/**
 * Admin account detail, which carries any outstanding gateway revocation.
 *
 * Fetched lazily — the users table only asks for it when the portal-wide
 * pending count says there is something to show.
 */
export function useUser(id: string, enabled = true): UseQueryResult<GetUserResponse> {
  return useQuery({
    queryKey: queryKeys.users.detail(id),
    queryFn: () => usersApi.get(id),
    enabled,
  });
}

/** Admin: re-run a disabled account's gateway revocation now. */
export function useRetryGatewayTeardown(): UseMutationResult<
  RetryGatewayTeardownResponse,
  Error,
  string
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => usersApi.retryGatewayTeardown(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.users.all });
    },
  });
}

/** Admin: change a user's role, status, org or display name. */
export function useUpdateUser(): UseMutationResult<
  UpdateUserResponse,
  Error,
  { id: string; body: UpdateUserRequest }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateUserRequest }) =>
      usersApi.update(id, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.users.all });
    },
  });
}

/** Self-service profile update (also handles password change). */
export function useUpdateProfile(): UseMutationResult<UpdateMeResponse, Error, UpdateMeRequest> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateMeRequest) => usersApi.updateMe(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.users.all });
    },
  });
}

/** Admin organization list. */
export function useOrganizations(
  query: ListOrganizationsQuery = {},
  enabled = true,
): UseQueryResult<ListOrganizationsResponse> {
  return useQuery({
    queryKey: queryKeys.organizations.list(query),
    queryFn: () => organizationsApi.list(query),
    enabled,
  });
}

/** Admin: create an organization. */
export function useCreateOrganization(): UseMutationResult<
  CreateOrganizationResponse,
  Error,
  CreateOrganizationRequest
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateOrganizationRequest) => organizationsApi.create(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.organizations.all });
    },
  });
}
