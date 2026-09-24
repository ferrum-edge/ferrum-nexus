import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@ferrum-nexus/shared';
import { authApi, usersApi } from '../lib/api';
import { AuthProvider, useAuth } from '../stores/auth';
import { useUpdateUser } from './useUsers';

const clientUser: User = {
  id: 'user-1',
  email: 'admin@example.test',
  display_name: 'Admin',
  role: 'client',
  org_id: null,
  company: null,
  phone: null,
  status: 'active',
  email_verified: true,
  last_login_at: null,
  created_at: '2026-09-08T00:00:00.000Z',
  updated_at: '2026-09-08T00:00:00.000Z',
};
const adminUser: User = { ...clientUser, role: 'admin' };
const capabilities = {
  can_publish_apis: false,
  can_review_access_requests: false,
  can_manage_users: true,
  can_manage_settings: true,
  can_view_audit_log: true,
  can_use_god_mode: false,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useUpdateUser', () => {
  it('refreshes auth state after the current user role changes', async () => {
    vi.spyOn(authApi, 'meSilent')
      .mockResolvedValueOnce({
        user: clientUser,
        capabilities,
        csrf_token: 'csrf',
        expires_at: '2026-09-09T00:00:00.000Z',
      })
      .mockResolvedValueOnce({
        user: adminUser,
        capabilities,
        csrf_token: 'csrf',
        expires_at: '2026-09-09T00:00:00.000Z',
      });
    vi.spyOn(usersApi, 'update').mockResolvedValue({ user: adminUser });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }): ReactElement => (
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => ({ auth: useAuth(), update: useUpdateUser() }), {
      wrapper,
    });

    await waitFor(() => expect(result.current.auth.user?.role).toBe('client'));
    await act(async () => {
      await result.current.update.mutateAsync({ id: clientUser.id, body: { role: 'admin' } });
    });

    await waitFor(() => expect(result.current.auth.user?.role).toBe('admin'));
    expect(authApi.meSilent).toHaveBeenCalledTimes(2);
    queryClient.clear();
  });
});
