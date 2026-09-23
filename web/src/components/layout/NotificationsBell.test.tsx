import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Notification } from '@ferrum-nexus/shared';
import { CREATED_AT } from '../../../test/fixtures';
import { clearClients, renderPage } from '../../../test/helpers';
import { notificationsApi } from '../../lib/api';
import { NotificationsBell } from './NotificationsBell';

vi.mock('@tanstack/react-router', async () => {
  const { TestLink } = await import('../../../test/helpers');
  return { Link: TestLink, useNavigate: () => vi.fn() };
});

// Radix positions an open menu with layout measurements jsdom cannot answer,
// and opening it there never settles. The bell's own behaviour is what this
// file covers, so the menu primitives render their content in place.
vi.mock('@radix-ui/react-dropdown-menu', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return {
    Root: Pass,
    Trigger: Pass,
    Portal: Pass,
    Content: ({ children }: { children?: ReactNode }) => <div role="menu">{children}</div>,
    Item: Pass,
  };
});

let notifications: Notification[];

beforeEach(() => {
  notifications = Array.from({ length: 2 }, (_, index) => ({
    id: `notification-${index + 1}`,
    user_id: 'user-1',
    type: 'message_received' as const,
    title: `Notification ${index + 1}`,
    body: `Message ${index + 1}`,
    link: null,
    read_at: null,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
  }));
  vi.spyOn(notificationsApi, 'list').mockImplementation(async () => ({
    items: notifications,
    total: notifications.length,
    unread_count: notifications.filter((notification) => notification.read_at === null).length,
  }));
  vi.spyOn(notificationsApi, 'markRead').mockImplementation(async () => {
    notifications = notifications.map((item) => ({ ...item, read_at: CREATED_AT }));
    return { updated: 2, unread_count: 0 };
  });
});

afterEach(() => {
  cleanup();
  clearClients();
  vi.restoreAllMocks();
});

describe('notifications bell', () => {
  it('links the preview to the full inbox and keeps mark all read', async () => {
    renderPage(<NotificationsBell />);
    await screen.findByRole('button', { name: 'Notifications, 2 unread' });
    expect(screen.getByRole('link', { name: 'View all' })).toHaveAttribute(
      'href',
      '/notifications',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Mark all read' }));
    await waitFor(() => expect(notificationsApi.markRead).toHaveBeenCalledWith({ all: true }));
  });
});
