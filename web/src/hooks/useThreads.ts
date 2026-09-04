import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type {
  CreateThreadRequest,
  CreateThreadResponse,
  GetThreadResponse,
  ListThreadMessagesResponse,
  ListThreadsQuery,
  ListThreadsResponse,
  SendMessageRequest,
  SendMessageResponse,
} from '@ferrum-nexus/shared';
import { threadsApi } from '../lib/api';
import { queryKeys } from './keys';

/** Conversations the caller participates in. */
export function useThreads(query: ListThreadsQuery = {}): UseQueryResult<ListThreadsResponse> {
  return useQuery({
    queryKey: queryKeys.threads.list(query),
    queryFn: () => threadsApi.list(query),
  });
}

/** One conversation with its most recent window of messages. */
export function useThread(id: string): UseQueryResult<GetThreadResponse> {
  return useQuery({
    queryKey: queryKeys.threads.detail(id),
    queryFn: () => threadsApi.get(id),
    enabled: id.length > 0,
  });
}

/**
 * Fetch the window of messages older than `before`.
 *
 * A mutation rather than a query because it is driven by a button and its
 * result is merged into what the page already holds — caching one window per
 * cursor would only make the merge harder to reason about.
 */
export function useOlderMessages(): UseMutationResult<
  ListThreadMessagesResponse,
  Error,
  { id: string; before: string }
> {
  return useMutation({
    mutationFn: ({ id, before }: { id: string; before: string }) =>
      threadsApi.messages(id, { before }),
  });
}

/** Open a conversation and post its first message. */
export function useCreateThread(): UseMutationResult<
  CreateThreadResponse,
  Error,
  CreateThreadRequest
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateThreadRequest) => threadsApi.create(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.threads.all });
    },
  });
}

/** Post a reply into an existing conversation. */
export function useSendMessage(): UseMutationResult<
  SendMessageResponse,
  Error,
  { id: string; body: SendMessageRequest }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: SendMessageRequest }) =>
      threadsApi.sendMessage(id, body),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.threads.detail(variables.id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.threads.all });
    },
  });
}
