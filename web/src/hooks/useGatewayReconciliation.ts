import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import type {
  ReconcileGatewayResponse,
  RepairGatewayReferencesRequest,
  RepairGatewayReferencesResponse,
} from '@ferrum-nexus/shared';
import { adminApi } from '../lib/api';
import { queryKeys } from './keys';

/**
 * Re-check whether the gateway still holds the consumer and proxy ids the
 * portal stored (super admin only).
 *
 * A mutation rather than a query on purpose: the pass costs one Admin API read
 * per stored reference, so it runs when somebody asks for it, never on render.
 * The cached verdict a page shows comes from `useEdgeHealth`.
 */
export function useReconcileGateway(): UseMutationResult<ReconcileGatewayResponse, Error, void> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => adminApi.reconcileGateway(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.edgeHealth });
      void queryClient.invalidateQueries({ queryKey: queryKeys.health });
    },
  });
}

/** Recreate the missing gateway consumers and clear the dead proxy ids. */
export function useRepairGatewayReferences(): UseMutationResult<
  RepairGatewayReferencesResponse,
  Error,
  RepairGatewayReferencesRequest
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: RepairGatewayReferencesRequest) => adminApi.repairGatewayReferences(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.edgeHealth });
      void queryClient.invalidateQueries({ queryKey: queryKeys.health });
      void queryClient.invalidateQueries({ queryKey: queryKeys.apis.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.credentials.all });
    },
  });
}
