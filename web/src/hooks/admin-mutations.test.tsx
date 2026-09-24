import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GatewayReconciliationReport, User } from '@ferrum-nexus/shared';
import { API, CREATED_AT, GRANT } from '../../test/fixtures';
import { adminApi, godApi } from '../lib/api';
import { queryKeys } from './keys';
import { useReconcileGateway, useRepairGatewayReferences } from './useGatewayReconciliation';
import {
  useGodBroadcast,
  useGodDeleteApi,
  useGodDisableUser,
  useGodRevokeGrant,
} from './useGodMode';

const report: GatewayReconciliationReport = {
  status: 'ok',
  checked_at: CREATED_AT,
  namespace: 'nexus',
  consumers: { checked: 1, orphaned: 0, complete: true },
  proxies: { checked: 1, orphaned: 0, complete: true },
  orphaned_consumers: [],
  orphaned_proxies: [],
  awaiting_restore: 0,
  error: null,
};

const user: User = {
  id: 'user-1',
  email: 'client@example.test',
  display_name: 'Client',
  role: 'client',
  org_id: null,
  company: null,
  phone: null,
  status: 'disabled',
  email_verified: true,
  last_login_at: null,
  created_at: CREATED_AT,
  updated_at: CREATED_AT,
};

const cacheKeys = {
  health: queryKeys.health,
  edge: queryKeys.edgeHealth,
  apis: queryKeys.apis.detail(API.id),
  catalog: queryKeys.catalog.detail(API.slug),
  credentials: queryKeys.credentials.list({}),
  grants: queryKeys.grants.list({}),
  requests: queryKeys.accessRequests.list({}),
  users: queryKeys.users.detail(user.id),
  notifications: queryKeys.notifications.list({}),
  threads: queryKeys.threads.list({}),
  branding: queryKeys.branding,
};

let client: QueryClient;

function wrapper({ children }: { children: ReactNode }): ReactElement {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function useActions() {
  return {
    reconcile: useReconcileGateway(),
    repair: useRepairGatewayReferences(),
    revoke: useGodRevokeGrant(),
    remove: useGodDeleteApi(),
    disable: useGodDisableUser(),
    broadcast: useGodBroadcast(),
  };
}

// Mutations must make cached screens stale, including inactive screens that
// will be revisited later, without unnecessarily invalidating unrelated data.
function expectStale(...names: Array<keyof typeof cacheKeys>): void {
  for (const [name, key] of Object.entries(cacheKeys)) {
    expect(client.getQueryState(key)?.isInvalidated, name).toBe(
      names.includes(name as keyof typeof cacheKeys),
    );
  }
}

beforeEach(() => {
  client = new QueryClient();
  for (const key of Object.values(cacheKeys)) client.setQueryData(key, { cached: true });
  vi.spyOn(adminApi, 'reconcileGateway').mockResolvedValue(report);
  vi.spyOn(adminApi, 'repairGatewayReferences').mockResolvedValue({
    report,
    consumers: [],
    apis: [],
  });
  vi.spyOn(godApi, 'revokeGrant').mockResolvedValue({ grant: { ...GRANT, status: 'revoked' } });
  vi.spyOn(godApi, 'deleteApi').mockResolvedValue({ deleted_api_id: API.id, revoked_grants: 1 });
  vi.spyOn(godApi, 'disableUser').mockResolvedValue({
    user,
    revoked_grants: 1,
    terminated_sessions: 2,
    gateway_teardown: 'pending',
  });
  vi.spyOn(godApi, 'broadcast').mockResolvedValue({
    notified: 2,
    emails_enqueued: 0,
    threads_created: 2,
    delivered: 2,
    failed: 0,
  });
});

afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
});

describe('administrative mutations', () => {
  it('runs reconciliation only on demand and refreshes health without repairing', async () => {
    const { result } = renderHook(useActions, { wrapper });
    expect(adminApi.reconcileGateway).not.toHaveBeenCalled();
    expect(adminApi.repairGatewayReferences).not.toHaveBeenCalled();
    await act(async () => {
      expect(await result.current.reconcile.mutateAsync()).toEqual(report);
    });
    expect(adminApi.reconcileGateway).toHaveBeenCalledTimes(1);
    expect(adminApi.repairGatewayReferences).not.toHaveBeenCalled();
    expectStale('health', 'edge');
  });

  it('forwards selected repair targets and refreshes APIs, credentials, and health', async () => {
    const { result } = renderHook(useActions, { wrapper });
    const body = { user_ids: [user.id], api_ids: [API.id], reason: 'Gateway rebuilt' };
    await act(async () => {
      await result.current.repair.mutateAsync(body);
    });
    expect(adminApi.repairGatewayReferences).toHaveBeenCalledWith(body);
    expectStale('health', 'edge', 'apis', 'credentials');
  });

  it('preserves cached state and exposes a failed repair for retry', async () => {
    vi.mocked(adminApi.repairGatewayReferences).mockRejectedValue(new Error('Gateway unreachable'));
    const { result } = renderHook(useActions, { wrapper });
    await act(async () => {
      await expect(result.current.repair.mutateAsync({ all: true })).rejects.toThrow(
        'Gateway unreachable',
      );
    });
    expectStale();
    expect(client.getQueryData(queryKeys.apis.detail(API.id))).toEqual({ cached: true });
  });

  it('refreshes requests, grants, API counts and the catalog after emergency revocation', async () => {
    const { result } = renderHook(useActions, { wrapper });
    const body = { grant_id: GRANT.id, reason: 'Access no longer authorized' };
    await act(async () => {
      const response = await result.current.revoke.mutateAsync(body);
      expect(response.grant.status).toBe('revoked');
    });
    expect(godApi.revokeGrant).toHaveBeenCalledWith(body);
    // The API workspace's grant counts and the catalog's access state change
    // with it, exactly as for an ordinary revocation (issue #336).
    expectStale('requests', 'grants', 'apis', 'catalog');
  });

  it('refreshes the catalog, API workspace, and grants after emergency deletion', async () => {
    const { result } = renderHook(useActions, { wrapper });
    const body = { api_id: API.id, reason: 'Retire compromised API', revoke_grants: true };
    await act(async () => {
      await result.current.remove.mutateAsync(body);
    });
    expect(godApi.deleteApi).toHaveBeenCalledWith(body);
    expectStale('apis', 'catalog', 'grants');
  });

  it('preserves pending gateway teardown information when disabling an account', async () => {
    const { result } = renderHook(useActions, { wrapper });
    const body = { user_id: user.id, reason: 'Account compromised', revoke_grants: true };
    await act(async () => {
      const response = await result.current.disable.mutateAsync(body);
      expect(response.gateway_teardown).toBe('pending');
      expect(response.terminated_sessions).toBe(2);
    });
    expect(godApi.disableUser).toHaveBeenCalledWith(body);
    expectStale('users', 'grants');
  });

  it('forwards the broadcast audience and retry key and refreshes message surfaces', async () => {
    const { result } = renderHook(useActions, { wrapper });
    const body = {
      subject: 'Maintenance',
      body: 'The gateway is being upgraded',
      audience: { scope: 'explicit' as const, user_ids: [user.id] },
      send_email: false,
      idempotency_key: 'test-broadcast-1',
    };
    await act(async () => {
      await result.current.broadcast.mutateAsync(body);
    });
    expect(godApi.broadcast).toHaveBeenCalledWith(body);
    expectStale('notifications', 'threads');
  });
});
