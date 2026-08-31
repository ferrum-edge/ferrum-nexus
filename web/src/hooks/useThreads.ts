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

/** One conversation with its full message list. */
export function useThread(id: string): UseQueryResult<GetThreadResponse> {
  return useQuery({
    queryKey: queryKeys.threads.detail(id),
    queryFn: () => threadsApi.get(id),
    enabled: id.length > 0,
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
