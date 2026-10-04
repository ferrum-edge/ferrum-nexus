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
  GetNotificationPreferencesResponse,
  GetUserResponse,
  ListOrganizationsQuery,
  ListOrganizationsResponse,
  ListUsersQuery,
  ListUserIdentitiesResponse,
  ListUsersResponse,
  ReleaseUserAddressResponse,
  RetryGatewayTeardownResponse,
  UnlinkUserIdentityResponse,
  StartSsoLinkResponse,
  UpdateMeRequest,
  UpdateMeResponse,
  UpdateNotificationPreferencesRequest,
  UpdateNotificationPreferencesResponse,
  UpdateUserRequest,
  UpdateUserResponse,
} from '@ferrum-nexus/shared';
import { authApi, organizationsApi, usersApi } from '../lib/api';
import { useOptionalAuth } from '../stores/auth';
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

/** Super admin: free a disabled account's address while retaining its history. */
export function useReleaseUserAddress(): UseMutationResult<
  ReleaseUserAddressResponse,
  Error,
  { id: string; email: string }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, email }: { id: string; email: string }) =>
      usersApi.releaseAddress(id, { email }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.users.all });
    },
  });
}

/** Admin: inspect and remove identities from the recovery dialog. */
export function useUserIdentities(id: string): UseQueryResult<ListUserIdentitiesResponse> {
  return useQuery({
    queryKey: queryKeys.users.identities(id),
    queryFn: () => usersApi.identities(id),
  });
}

export function useUnlinkUserIdentity(): UseMutationResult<
  UnlinkUserIdentityResponse,
  Error,
  { id: string; identityId: string }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, identityId }: { id: string; identityId: string }) =>
      usersApi.unlinkIdentity(id, identityId),
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
  const auth = useOptionalAuth();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateUserRequest }) =>
      usersApi.update(id, body),
    onSuccess: (_response, variables) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.users.all });
      // Editing one's own account changes role/nav; pull the new principal.
      if (auth && variables.id === auth.user?.id) void auth.refresh();
    },
  });
}

/** Self-service profile update (also handles password change). */
export function useUpdateProfile(): UseMutationResult<UpdateMeResponse, Error, UpdateMeRequest> {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: (body: UpdateMeRequest) => usersApi.updateMe(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.users.all });
    },
  });
}

/** The caller's own notification preferences. */
export function useNotificationPreferences(): UseQueryResult<GetNotificationPreferencesResponse> {
  return useQuery({
    queryKey: queryKeys.users.notificationPreferences,
    queryFn: () => usersApi.notificationPreferences(),
  });
}

/** Change some of the caller's notification preferences. */
export function useUpdateNotificationPreferences(): UseMutationResult<
  UpdateNotificationPreferencesResponse,
  Error,
  UpdateNotificationPreferencesRequest
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateNotificationPreferencesRequest) =>
      usersApi.updateNotificationPreferences(body),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.users.notificationPreferences, data);
    },
  });
}

/** The signed-in account's own single sign-on links. */
export function useMyIdentities(): UseQueryResult<ListUserIdentitiesResponse> {
  return useQuery({
    queryKey: queryKeys.users.myIdentities,
    queryFn: () => usersApi.myIdentities(),
  });
}

/**
 * Link the signed-in account to a provider: start the attempt, then leave for
 * the provider with a full navigation. The callback brings the browser back to
 * the profile page.
 */
export function useStartSsoLink(): UseMutationResult<StartSsoLinkResponse, Error, string> {
  return useMutation({
    mutationFn: (providerId: string) => authApi.startSsoLink(providerId),
    onSuccess: ({ location }) => {
      window.location.assign(location);
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
