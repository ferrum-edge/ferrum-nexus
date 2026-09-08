import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GatewayTeardownState, Organization, User } from '@ferrum-nexus/shared';
import { organizationsApi, usersApi } from '../../lib/api';
import { TooltipProvider } from '../../components/ui/Tooltip';
import { AdminUsersPage } from './AdminUsersPage';

vi.mock('../../components/layout/RoleGuard', () => ({
  RoleGuard: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../../stores/toast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));
// Radix Select cannot be driven under jsdom (no layout, no pointer capture).
// Both pickers here are plain value pickers, so stand in native <select>s that
// keep the same props contract and accessible names.
vi.mock('../../components/ui/Select', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../components/ui/Select')>();
  function NativeSelect({
    label,
    value,
    onValueChange,
    options,
    'aria-label': ariaLabel,
  }: {
    label?: string;
    value: string;
    onValueChange: (value: never) => void;
    options: ReadonlyArray<{ value: string; label: string }>;
    'aria-label'?: string;
  }): ReactElement {
    return (
      <select
        aria-label={ariaLabel ?? label}
        value={value}
        onChange={(event) => onValueChange(event.target.value as never)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }
  return { ...actual, Select: NativeSelect, LabeledSelect: NativeSelect };
});

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

function renderUsers(organizations: Organization[] = []): void {
  vi.spyOn(organizationsApi, 'list').mockResolvedValue({
    items: organizations,
    total: organizations.length,
  });
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

const ACME: Organization = {
  id: 'org-1',
  name: 'Acme',
  description: null,
  created_at: '2026-09-07T12:00:00.000Z',
  updated_at: '2026-09-07T12:00:00.000Z',
};

const GLOBEX: Organization = { ...ACME, id: 'org-2', name: 'Globex' };

const member: User = {
  ...user,
  id: 'member-1',
  email: 'member@example.test',
  display_name: 'Ada Member',
  status: 'active',
  org_id: ACME.id,
};

/**
 * The admin guide's organization procedure is "create an organization, then
 * assign accounts by editing the user's org_id", and its account section
 * promises filters by status and organization. Neither had a control:
 * `org_id` appeared nowhere in this page.
 */
describe('organization and status management', () => {
  const page = { items: [member], total: 1, pending_gateway_teardowns: 0 };

  it('shows the organization each account belongs to', async () => {
    vi.spyOn(usersApi, 'list').mockResolvedValue(page);
    renderUsers([ACME, GLOBEX]);
    expect(await screen.findByText('Acme')).toBeInTheDocument();
  });

  it('filters the directory by organization and by status', async () => {
    const list = vi.spyOn(usersApi, 'list').mockResolvedValue(page);
    renderUsers([ACME, GLOBEX]);
    await screen.findByText(member.email);

    fireEvent.change(screen.getByLabelText('Filter by status'), {
      target: { value: 'disabled' },
    });
    await waitFor(() =>
      expect(list).toHaveBeenCalledWith(expect.objectContaining({ status: 'disabled' })),
    );

    fireEvent.change(screen.getByLabelText('Filter by organization'), {
      target: { value: GLOBEX.id },
    });
    await waitFor(() =>
      expect(list).toHaveBeenCalledWith(expect.objectContaining({ org_id: GLOBEX.id })),
    );
  });

  it('assigns an account to another organization and renames it', async () => {
    vi.spyOn(usersApi, 'list').mockResolvedValue(page);
    const update = vi.spyOn(usersApi, 'update').mockResolvedValue({ user: member });
    renderUsers([ACME, GLOBEX]);

    fireEvent.click(await screen.findByRole('button', { name: 'Edit Ada Member' }));
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.change(dialog.getByLabelText(/^Display name/), { target: { value: 'Ada Lovelace' } });
    fireEvent.change(dialog.getByLabelText('Organization'), { target: { value: GLOBEX.id } });
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(member.id, {
        display_name: 'Ada Lovelace',
        org_id: GLOBEX.id,
      }),
    );
  });

  it('clears an organization from an account', async () => {
    vi.spyOn(usersApi, 'list').mockResolvedValue(page);
    const update = vi.spyOn(usersApi, 'update').mockResolvedValue({ user: member });
    renderUsers([ACME, GLOBEX]);

    fireEvent.click(await screen.findByRole('button', { name: 'Edit Ada Member' }));
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.change(dialog.getByLabelText('Organization'), { target: { value: '__none__' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(member.id, {
        display_name: member.display_name,
        org_id: null,
      }),
    );
  });
});
