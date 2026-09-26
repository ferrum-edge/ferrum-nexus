import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { GodDisableUserResponse } from '@ferrum-nexus/shared';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API, CREDENTIAL, GRANT, REQUEST } from '../../test/fixtures';
import {
  accessRequestsApi,
  apisApi,
  applicationsApi,
  credentialsApi,
  godApi,
  grantsApi,
} from '../lib/api';
import { queryKeys } from './keys';
import { useDeleteApi } from './useApis';
import { useApproveAccessRequest } from './useAccessRequests';
import { useDeleteApplication } from './useApplications';
import { useDeleteCredential, useIssueCredential, useRotateCredential } from './useCredentials';
import { useGodDisableUser, useGodRevokeGrant } from './useGodMode';
import { useRevokeGrant } from './useGrants';

/** Cached screens a mutation may or may not have to refresh (issue #336). */
const cacheKeys = {
  apis: queryKeys.apis.detail('api-other'),
  catalog: queryKeys.catalog.detail(API.slug),
  applications: queryKeys.applications.list({}),
  credentials: queryKeys.credentials.list({}),
  grants: queryKeys.grants.list({}),
  requests: queryKeys.accessRequests.list({}),
};

let client: QueryClient;

function wrapper({ children }: { children: ReactNode }): ReactElement {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

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
  vi.spyOn(grantsApi, 'revoke').mockResolvedValue({ grant: { ...GRANT, status: 'revoked' } });
  vi.spyOn(credentialsApi, 'issue').mockResolvedValue({
    credential: CREDENTIAL,
    consumer_username: 'nexus-user-user-1',
    secret: { type: 'keyauth', key: 'test-only-issued-key' },
  });
  vi.spyOn(credentialsApi, 'rotate').mockResolvedValue({
    credential: CREDENTIAL,
    previous: { ...CREDENTIAL, status: 'revoked' },
    consumer_username: 'nexus-user-user-1',
    secret: { type: 'keyauth', key: 'test-only-rotated-key' },
  });
  vi.spyOn(credentialsApi, 'remove').mockResolvedValue({ ok: true });
  vi.spyOn(apisApi, 'remove').mockResolvedValue({ ok: true });
  vi.spyOn(applicationsApi, 'remove').mockResolvedValue({
    revoked_grants: 0,
    revoked_credentials: 0,
  });
  vi.spyOn(accessRequestsApi, 'approve').mockResolvedValue({
    access_request: REQUEST,
    grant: GRANT,
  });
  vi.spyOn(godApi, 'revokeGrant').mockResolvedValue({ grant: { ...GRANT, status: 'revoked' } });
  // Only the invalidations are under test, so the response body is a stub.
  vi.spyOn(godApi, 'disableUser').mockResolvedValue({} as GodDisableUserResponse);
});

afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
});

describe('grant and credential mutations', () => {
  it('refreshes application counts after approving a request', async () => {
    const { result } = renderHook(useApproveAccessRequest, { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ id: 'request-1' });
    });
    expectStale('applications', 'requests', 'grants', 'catalog', 'apis');
  });

  it('refreshes the API workspace counts after revoking a grant', async () => {
    const { result } = renderHook(useRevokeGrant, { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ id: GRANT.id });
    });
    expectStale('grants', 'requests', 'catalog', 'apis', 'applications');
  });

  it('refreshes every grant surface after a god-mode revocation', async () => {
    const { result } = renderHook(useGodRevokeGrant, { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ grant_id: GRANT.id, reason: 'incident' });
    });
    expectStale('grants', 'requests', 'catalog', 'apis', 'applications');
  });

  it('refreshes every grant surface after a god-mode disable that revokes grants', async () => {
    const { result } = renderHook(useGodDisableUser, { wrapper });
    await act(async () => {
      await result.current.mutateAsync({
        user_id: GRANT.user_id,
        reason: 'incident',
        revoke_grants: true,
      });
    });
    expectStale('grants', 'requests', 'catalog', 'apis', 'applications');
  });

  it.each([
    [
      'issuing',
      (hooks: CredentialHooks) => hooks.issue.mutateAsync({ credential_type: 'keyauth' }),
    ],
    ['rotating', (hooks: CredentialHooks) => hooks.rotate.mutateAsync({ id: CREDENTIAL.id })],
    ['revoking', (hooks: CredentialHooks) => hooks.remove.mutateAsync(CREDENTIAL.id)],
  ] as const)('refreshes application credential counts after %s', async (_name, run) => {
    const { result } = renderHook(useCredentialHooks, { wrapper });
    await act(async () => {
      await run(result.current);
    });
    expectStale('credentials', 'applications');
  });

  it('drops a show-once secret from the mutation cache as soon as it is reset', async () => {
    const { result } = renderHook(useCredentialHooks, { wrapper });
    await act(async () => {
      await result.current.issue.mutateAsync({ credential_type: 'keyauth' });
      await result.current.rotate.mutateAsync({ id: CREDENTIAL.id });
    });
    expect(client.getMutationCache().getAll()).toHaveLength(2);
    act(() => {
      result.current.issue.reset();
      result.current.rotate.reset();
    });
    await vi.waitFor(() => expect(client.getMutationCache().getAll()).toHaveLength(0));
  });
});

type CredentialHooks = ReturnType<typeof useCredentialHooks>;

function useCredentialHooks() {
  return {
    issue: useIssueCredential(),
    rotate: useRotateCredential(),
    remove: useDeleteCredential(),
  };
}

describe('deleting an API', () => {
  it('refreshes every dependent cache after deleting an API', async () => {
    const { result } = renderHook(useDeleteApi, { wrapper });
    await act(async () => {
      await result.current.mutateAsync(API.id);
    });
    expectStale('apis', 'catalog', 'grants', 'requests', 'applications', 'credentials');

    const fetchGrants = vi.fn(async () => ({ items: [], total: 0 }));
    await expect(
      client.fetchQuery({
        queryKey: cacheKeys.grants,
        queryFn: fetchGrants,
        staleTime: 30_000,
      }),
    ).resolves.toEqual({ items: [], total: 0 });
    expect(fetchGrants).toHaveBeenCalledOnce();
  });

  it('forgets the deleted API without refetching it and refreshes the rest', async () => {
    const detail = vi.fn(async () => ({ id: API.id }));
    client.setQueryData(queryKeys.apis.spec(API.id), { raw_spec: '{}' });
    client.setQueryData(queryKeys.apis.list({}), { items: [] });
    // The page that deletes the API is still mounted when the mutation lands.
    const { result, unmount } = renderHook(
      () => ({
        detail: useQuery({ queryKey: queryKeys.apis.detail(API.id), queryFn: detail }),
        remove: useDeleteApi(),
      }),
      { wrapper },
    );
    await vi.waitFor(() => expect(result.current.detail.isSuccess).toBe(true));
    expect(detail).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.remove.mutateAsync(API.id);
    });

    // The unobserved spec is gone at once; the mounted detail query is neither
    // refetched (it would 404) nor marked stale.
    expect(client.getQueryState(queryKeys.apis.spec(API.id))).toBeUndefined();
    expect(client.getQueryState(queryKeys.apis.detail(API.id))?.isInvalidated).toBe(false);
    expect(detail).toHaveBeenCalledTimes(1);
    // Lists, other APIs and the catalog are refreshed as before.
    expect(client.getQueryState(queryKeys.apis.list({}))?.isInvalidated).toBe(true);
    expectStale('apis', 'catalog');

    // Once the page unmounts, the deleted API leaves the cache entirely.
    unmount();
    expect(client.getQueryState(queryKeys.apis.detail(API.id))).toBeUndefined();
  });
});

describe('deleting an application', () => {
  it('refreshes API counts and the catalog after its grants are removed', async () => {
    const { result } = renderHook(useDeleteApplication, { wrapper });
    await act(async () => {
      await result.current.mutateAsync('application-1');
    });
    expectStale('applications', 'credentials', 'requests', 'grants', 'catalog', 'apis');
  });
});
