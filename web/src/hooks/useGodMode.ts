import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import type {
  GodBroadcastRequest,
  GodBroadcastResponse,
  GodDeleteApiRequest,
  GodDeleteApiResponse,
  GodDisableUserRequest,
  GodDisableUserResponse,
  GodRevokeGrantRequest,
  GodRevokeGrantResponse,
} from '@ferrum-nexus/shared';
import { godApi } from '../lib/api';
import { queryKeys } from './keys';

/** Emergency grant revocation, bypassing API ownership. */
export function useGodRevokeGrant(): UseMutationResult<
  GodRevokeGrantResponse,
  Error,
  GodRevokeGrantRequest
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: GodRevokeGrantRequest) => godApi.revokeGrant(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.grants.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.accessRequests.all });
      // Same surfaces as an ordinary revocation: the API workspace's grant
      // counts and the catalog's per-identity access state (issue #336).
      void queryClient.invalidateQueries({ queryKey: queryKeys.apis.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.catalog.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.applications.all });
    },
  });
}

/** Delete an API and its Edge proxy, optionally revoking every grant. */
export function useGodDeleteApi(): UseMutationResult<
  GodDeleteApiResponse,
  Error,
  GodDeleteApiRequest
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: GodDeleteApiRequest) => godApi.deleteApi(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.apis.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.catalog.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.grants.all });
    },
  });
}

/** Disable an account, terminate its sessions, optionally revoke its grants. */
export function useGodDisableUser(): UseMutationResult<
  GodDisableUserResponse,
  Error,
  GodDisableUserRequest
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: GodDisableUserRequest) => godApi.disableUser(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.users.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.grants.all });
      // `revoke_grants` revokes every grant of the account, so everything an
      // ordinary revocation refreshes goes stale too (issue #336).
      void queryClient.invalidateQueries({ queryKey: queryKeys.accessRequests.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.apis.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.catalog.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.applications.all });
    },
  });
}

/** Platform-wide announcement (in-app notification, optionally emailed). */
export function useGodBroadcast(): UseMutationResult<
  GodBroadcastResponse,
  Error,
  GodBroadcastRequest
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: GodBroadcastRequest) => godApi.broadcast(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.threads.all });
    },
  });
}
