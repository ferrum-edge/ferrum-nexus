import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminGodPage } from './AdminGodPage';

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
vi.mock('../../stores/toast', () => ({ useToast: () => ({ success: vi.fn() }) }));
vi.mock('../../components/layout/RoleGuard', () => ({
  RoleGuard: ({ children }: { children: ReactNode }) => children,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const oldest = '12345678-1234-4234-8234-123456789abc';

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
    render(<AdminGodPage />);
    const send = [revoke, remove, disable][entry.index]!;
    expect(recent.some((record) => record.id === oldest)).toBe(false);
    fireEvent.change(screen.getByLabelText(entry.label), { target: { value: ` ${oldest} ` } });
    fireEvent.change(screen.getAllByLabelText(/^Reason/)[entry.index]!, {
      target: { value: 'Reviewed emergency request' },
    });
    fireEvent.click(screen.getByRole('button', { name: entry.action }));
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByText(new RegExp(oldest))).toBeInTheDocument();
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

describe('broadcast email campaign identity', () => {
  it('keeps HTTP-compatible retry keys until success and starts a new campaign afterward', () => {
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
    render(<AdminGodPage />);
    const compose = () => {
      fireEvent.change(screen.getByLabelText(/^Subject/), { target: { value: 'Maintenance' } });
      fireEvent.change(screen.getByLabelText(/^Message/), { target: { value: 'Sunday window' } });
      fireEvent.click(screen.getByRole('button', { name: 'Broadcast' }));
      const dialog = within(screen.getByRole('dialog'));
      fireEvent.change(dialog.getByPlaceholderText('BROADCAST'), {
        target: { value: 'BROADCAST' },
      });
      fireEvent.click(dialog.getByRole('button', { name: 'Broadcast' }));
    };
    compose();
    const firstKey = sendBroadcast.mock.calls[0]![0].idempotency_key;
    expect(firstKey).toMatch(/^[0-9a-f]{32}$/);
    // A failed mutation leaves the dialog open and the form intact.
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Broadcast' }));
    expect(sendBroadcast.mock.calls[1]![0].idempotency_key).toBe(firstKey);
    act(() => {
      sendBroadcast.mock.calls[1]![1].onSuccess({ notified: 1 });
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
    render(<AdminGodPage />);
    fireEvent.click(screen.getByLabelText('Filtered'));
    fireEvent.click(screen.getByRole('button', { name: 'All administrative roles' }));
    fireEvent.change(screen.getByLabelText(/^Subject/), { target: { value: 'Rotate now' } });
    fireEvent.change(screen.getByLabelText(/^Message/), { target: { value: 'Within an hour' } });
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
