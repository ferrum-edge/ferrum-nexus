import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GatewayTeardownState, User } from '@ferrum-nexus/shared';
import { usersApi } from '../../lib/api';
import { TooltipProvider } from '../../components/ui/Tooltip';
import { AdminUsersPage } from './AdminUsersPage';

vi.mock('../../components/layout/RoleGuard', () => ({
  RoleGuard: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../../stores/toast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));

const user: User = {
  id: 'disabled-user',
  email: 'disabled@example.test',
  display_name: 'Disabled user',
  role: 'client',
  org_id: null,
  company: null,
  phone: null,
  status: 'disabled',
  email_verified: true,
  last_login_at: null,
  created_at: '2026-09-07T12:00:00.000Z',
  updated_at: '2026-09-07T12:00:00.000Z',
};

function job(status: GatewayTeardownState['status']): GatewayTeardownState {
  return {
    status,
    attempts: 12,
    next_attempt_at: status === 'done' ? null : '2026-09-07T12:05:00.000Z',
    last_error: status === 'pending' ? 'Gateway unavailable' : null,
    updated_at: '2026-09-07T12:00:00.000Z',
    completed_at: status === 'done' ? '2026-09-07T12:00:00.000Z' : null,
  };
}

function renderUsers(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <AdminUsersPage />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('gateway revocation visibility', () => {
  it.each(['pending', 'sending'] as const)('shows %s jobs with Retry', async (status) => {
    vi.spyOn(usersApi, 'list').mockResolvedValue({
      items: [user],
      total: 1,
      pending_gateway_teardowns: 1,
    });
    vi.spyOn(usersApi, 'get').mockResolvedValue({ user, gateway_teardown: job(status) });
    const retry = vi.spyOn(usersApi, 'retryGatewayTeardown').mockResolvedValue({
      gateway_teardown: 'pending',
      job: job('pending'),
    });
    renderUsers();
    expect(
      await screen.findByText(
        status === 'sending' ? 'Gateway revocation in progress' : 'Gateway revocation pending',
      ),
    ).toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Retry' });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(retry).toHaveBeenCalledWith(user.id));
  });

  it.each([job('done'), null])('hides a completed or absent per-user job', async (teardown) => {
    // Another account can keep the portal-wide backlog non-zero.
    vi.spyOn(usersApi, 'list').mockResolvedValue({
      items: [user],
      total: 1,
      pending_gateway_teardowns: 1,
    });
    const detail = vi.spyOn(usersApi, 'get').mockResolvedValue({
      user,
      gateway_teardown: teardown,
    });
    renderUsers();
    await screen.findByText(user.email);
    await waitFor(() => expect(detail).toHaveBeenCalledWith(user.id));
    expect(screen.queryByText(/^Gateway revocation/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('clears the badge and Retry control once the backlog completes', async () => {
    const list = vi.spyOn(usersApi, 'list').mockResolvedValue({
      items: [user],
      total: 1,
      pending_gateway_teardowns: 1,
    });
    vi.spyOn(usersApi, 'get').mockResolvedValue({ user, gateway_teardown: job('sending') });
    vi.spyOn(usersApi, 'retryGatewayTeardown').mockImplementation(async () => {
      list.mockResolvedValue({ items: [user], total: 1, pending_gateway_teardowns: 0 });
      return { gateway_teardown: 'ok', job: job('done') };
    });
    renderUsers();
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
      expect(screen.queryByText(/^Gateway revocation/)).not.toBeInTheDocument();
    });
  });
});
