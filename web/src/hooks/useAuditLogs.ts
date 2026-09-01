import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { ListAuditLogsQuery, ListAuditLogsResponse } from '@ferrum-nexus/shared';
import { adminApi } from '../lib/api';
import { queryKeys } from './keys';

/** Filterable append-only audit trail (admin only). */
export function useAuditLogs(
  query: ListAuditLogsQuery = {},
  enabled = true,
): UseQueryResult<ListAuditLogsResponse> {
  return useQuery({
    queryKey: queryKeys.auditLogs.list(query),
    queryFn: () => adminApi.auditLogs(query),
    enabled,
  });
}
