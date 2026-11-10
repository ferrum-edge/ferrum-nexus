import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { organizationsApi } from '../../lib/api';
import { AdminGodPage } from './AdminGodPage';

const REASON = /^Reason/;
const SUBJECT = /^Subject/;
const MESSAGE = /^Message/;
const HEX_KEY = /^[0-9a-f]{32}$/;

const { revoke, remove, disable, sendBroadcast, recent } = vi.hoisted(() => ({
  revoke: vi.fn(),
  remove: vi.fn(),
  disable: vi.fn(),
  sendBroadcast: vi.fn(),
  recent: Array.from({ length: 200 }, (_, index) => ({
    id: `recent-${index}`,
    api_id: `api-${index}`,
    user_id: `user-${index}`,
    acl_group: `group-${index}`,
    name: `API ${index}`,
    slug: `api-${index}`,
    version: '1',
    display_name: `User ${index}`,
    email: `user-${index}@example.test`,
    role: 'client',
  })),
}));
const { toastSuccess, toastError } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock('../../hooks/useGrants', () => ({
  useGrants: () => ({ data: { items: recent, total: 201 } }),
}));
vi.mock('../../hooks/useApis', () => ({
  useApis: () => ({ data: { items: recent, total: 201 } }),
}));
vi.mock('../../hooks/useUsers', () => ({
  useUsers: () => ({ data: { items: recent, total: 201 } }),
  // The audience selector offers an organization filter.
  useOrganizations: () => ({ data: { items: [], total: 0 } }),
}));
vi.mock('../../hooks/useGodMode', () => ({
  useGodRevokeGrant: () => ({ mutate: revoke, isPending: false }),
  useGodDeleteApi: () => ({ mutate: remove, isPending: false }),
  useGodDisableUser: () => ({ mutate: disable, isPending: false }),
  useGodBroadcast: () => ({ mutate: sendBroadcast, isPending: false }),
}));
vi.mock('../../stores/toast', () => ({
  useToast: () => ({ success: toastSuccess, error: toastError }),
}));
vi.mock('../../components/layout/RoleGuard', () => ({
  RoleGuard: ({ children }: { children: ReactNode }) => children,
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const oldest = '12345678-1234-4234-8234-123456789abc';
const OLDEST_ID = new RegExp(oldest);

function renderGodPage(): void {
  vi.spyOn(organizationsApi, 'list').mockResolvedValue({ items: [], total: 0 });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AdminGodPage />
    </QueryClientProvider>,
  );
}

describe('emergency targets beyond the first page', () => {
  it.each([
    { label: 'Grant ID', action: 'Revoke grant', phrase: 'REVOKE', field: 'grant_id', index: 0 },
    { label: 'API ID', action: 'Delete API', phrase: 'DELETE', field: 'api_id', index: 1 },
    {
      label: 'Account ID',
      action: 'Disable account',
      phrase: 'DISABLE',
      field: 'user_id',
      index: 2,
    },
  ])('submits the unlisted 201st target through $label after confirmation', (entry) => {
    renderGodPage();
    const send = [revoke, remove, disable][entry.index]!;
    expect(recent.some((record) => record.id === oldest)).toBe(false);
    fireEvent.change(screen.getByLabelText(entry.label), { target: { value: ` ${oldest} ` } });
    fireEvent.change(screen.getAllByLabelText(REASON)[entry.index]!, {
      target: { value: 'Reviewed emergency request' },
    });
    fireEvent.click(screen.getByRole('button', { name: entry.action }));
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByText(OLDEST_ID)).toBeInTheDocument();
    expect(dialog.getByRole('button', { name: entry.action })).toBeDisabled();
    expect(send).not.toHaveBeenCalled();
    fireEvent.change(dialog.getByPlaceholderText(entry.phrase), {
      target: { value: entry.phrase },
    });
    fireEvent.click(dialog.getByRole('button', { name: entry.action }));
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ [entry.field]: oldest, reason: 'Reviewed emergency request' }),
      expect.any(Object),
    );
  });
});

describe('disabling an account', () => {
  /** Disable `oldest` through the confirmation dialog and return the mutation's callbacks. */
  function confirmDisable(): { onSuccess: (response: unknown) => void } {
    renderGodPage();
    fireEvent.change(screen.getByLabelText('Account ID'), { target: { value: oldest } });
    fireEvent.change(screen.getAllByLabelText(REASON)[2]!, {
      target: { value: 'Compromised key' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Disable account' }));
    const dialog = within(screen.getByRole('dialog'));
    fireEvent.change(dialog.getByPlaceholderText('DISABLE'), { target: { value: 'DISABLE' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Disable account' }));
    expect(disable).toHaveBeenCalledTimes(1);
    return disable.mock.calls[0]![1] as { onSuccess: (response: unknown) => void };
  }

  function response(gatewayTeardown: string): unknown {
    return {
      user: { id: oldest },
      revoked_grants: 0,
      terminated_sessions: 2,
      gateway_teardown: gatewayTeardown,
    };
  }

  it('does not report a disable as done while gateway revocation is pending', () => {
    const { onSuccess } = confirmDisable();
    act(() => onSuccess(response('pending')));

    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith(
      'Account disabled; gateway revocation pending',
      expect.stringContaining('gateway credentials keep working'),
    );
  });

  it.each(['ok', 'no_consumer'])('reports a disable with teardown %s as done', (outcome) => {
    const { onSuccess } = confirmDisable();
    act(() => onSuccess(response(outcome)));

    expect(toastError).not.toHaveBeenCalled();
    expect(toastSuccess).toHaveBeenCalledWith('Account disabled', '2 session(s) terminated.');
  });
});

describe('broadcast email campaign identity', () => {
  it('keeps HTTP-compatible retry keys until success and starts a new campaign afterward', () => {
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
    renderGodPage();
    const compose = () => {
      fireEvent.change(screen.getByLabelText(SUBJECT), { target: { value: 'Maintenance' } });
      fireEvent.change(screen.getByLabelText(MESSAGE), { target: { value: 'Sunday window' } });
      fireEvent.click(screen.getByRole('button', { name: 'Broadcast' }));
      const dialog = within(screen.getByRole('dialog'));
      fireEvent.change(dialog.getByPlaceholderText('BROADCAST'), {
        target: { value: 'BROADCAST' },
      });
      fireEvent.click(dialog.getByRole('button', { name: 'Broadcast' }));
    };
    compose();
    const firstKey = sendBroadcast.mock.calls[0]![0].idempotency_key;
    expect(firstKey).toMatch(HEX_KEY);
    // A failed mutation leaves the dialog open and the form intact.
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Broadcast' }));
    expect(sendBroadcast.mock.calls[1]![0].idempotency_key).toBe(firstKey);
    act(() => {
      sendBroadcast.mock.calls[1]![1].onSuccess({
        notified: 1,
        emails_enqueued: 0,
        threads_created: 1,
        delivered: 1,
        failed: 0,
      });
    });
    compose();
    expect(sendBroadcast.mock.calls[2]![0].idempotency_key).not.toBe(firstKey);
  });
});

/**
 * The broadcast audience.
 *
 * `docs/api.md` calls god-mode broadcast the channel for "anything people must
 * not miss", and the guide says its audience works exactly like mass email's.
 * The panel used to send `{ scope: 'filtered', roles: [oneRole] }`, so the one
 * audience an operator reaches for in an incident skipped every super admin.
 */
describe('broadcast audience', () => {
  it('reaches both administrative roles when the shortcut is used', () => {
    renderGodPage();
    fireEvent.click(screen.getByLabelText('Filtered'));
    fireEvent.click(screen.getByRole('button', { name: 'All administrative roles' }));
    fireEvent.change(screen.getByLabelText(SUBJECT), { target: { value: 'Rotate now' } });
    fireEvent.change(screen.getByLabelText(MESSAGE), { target: { value: 'Within an hour' } });
    fireEvent.click(screen.getByRole('button', { name: 'Broadcast' }));
    const dialog = within(screen.getByRole('dialog'));
    fireEvent.change(dialog.getByPlaceholderText('BROADCAST'), { target: { value: 'BROADCAST' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Broadcast' }));

    expect(sendBroadcast.mock.calls[0]![0].audience).toEqual({
      scope: 'filtered',
      status: 'active',
      roles: ['admin', 'super_admin'],
    });
  });
});
