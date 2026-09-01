import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type {
  ListNotificationsQuery,
  ListNotificationsResponse,
  MarkNotificationsReadRequest,
  MarkNotificationsReadResponse,
} from '@ferrum-nexus/shared';
import { notificationsApi } from '../lib/api';
import { queryKeys } from './keys';

/** Poll interval for the header bell. */
export const NOTIFICATION_POLL_MS = 20_000;

/** In-app notifications; polled so the bell badge stays roughly live. */
export function useNotifications(
  query: ListNotificationsQuery = {},
  enabled = true,
): UseQueryResult<ListNotificationsResponse> {
  return useQuery({
    queryKey: queryKeys.notifications.list(query),
    queryFn: () => notificationsApi.list(query),
    enabled,
    refetchInterval: NOTIFICATION_POLL_MS,
    staleTime: NOTIFICATION_POLL_MS / 2,
  });
}

/** Mark specific notifications (or all of them) as read. */
export function useMarkNotificationsRead(): UseMutationResult<
  MarkNotificationsReadResponse,
  Error,
  MarkNotificationsReadRequest
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: MarkNotificationsReadRequest) => notificationsApi.markRead(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all });
    },
  });
}
