import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Notification } from '@ferrum-nexus/shared';
import { CREATED_AT } from '../../test/fixtures';
import { clearClients, renderPage } from '../../test/helpers';
import { NotificationsBell } from '../components/layout/NotificationsBell';
import { notificationsApi } from '../lib/api';
import { NotificationsPage } from './NotificationsPage';

const navigate = vi.hoisted(() => vi.fn());

vi.mock('@tanstack/react-router', async () => {
  const { TestLink } = await import('../../test/helpers');
  return { Link: TestLink, useNavigate: () => navigate };
});

let notifications: Notification[];

beforeEach(() => {
  navigate.mockReset();
  notifications = Array.from({ length: 12 }, (_, index) => ({
    id: `notification-${index + 1}`,
    user_id: 'user-1',
    type: 'message_received' as const,
    title: `Notification ${index + 1}`,
    body: `Message ${index + 1}`,
    link: `/messages/thread-${index + 1}`,
    read_at: index >= 10 ? null : CREATED_AT,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
  }));
  vi.spyOn(notificationsApi, 'list').mockImplementation(async (query = {}) => {
    const matching = query.unread
      ? notifications.filter((notification) => notification.read_at === null)
      : notifications;
    return {
      items: matching.slice(query.offset ?? 0, (query.offset ?? 0) + (query.limit ?? 25)),
      total: matching.length,
      unread_count: notifications.filter((notification) => notification.read_at === null).length,
    };
  });
  vi.spyOn(notificationsApi, 'markRead').mockImplementation(async (body) => {
    let updated = 0;
    notifications = notifications.map((notification) => {
      if (notification.read_at === null && (body.all || body.ids?.includes(notification.id))) {
        updated += 1;
        return { ...notification, read_at: CREATED_AT };
      }
      return notification;
    });
    return {
      updated,
      unread_count: notifications.filter((notification) => notification.read_at === null).length,
    };
  });
});

afterEach(() => {
  cleanup();
  clearClients();
  vi.restoreAllMocks();
});

describe('notifications inbox', () => {
  it('paginates past the latest ten and opens an older unread notification', async () => {
    renderPage(<NotificationsPage />);
    await screen.findByRole('button', { name: /Notification 1\b/ });
    expect(screen.queryByRole('button', { name: /Notification 11\b/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    const older = await screen.findByRole('button', { name: /Notification 11\b/ });
    expect(notificationsApi.list).toHaveBeenLastCalledWith({ limit: 10, offset: 10 });
    expect(screen.getByText('11–12')).toBeInTheDocument();
    fireEvent.click(older);
    await waitFor(() =>
      expect(notificationsApi.markRead).toHaveBeenCalledWith({ ids: ['notification-11'] }),
    );
    expect(navigate).toHaveBeenCalledWith({ href: '/messages/thread-11' });
  });

  it('filters to unread notifications and resets to the first page', async () => {
    renderPage(<NotificationsPage />);
    await screen.findByRole('button', { name: /Notification 1\b/ });
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByRole('button', { name: /Notification 11\b/ });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Unread only' }));
    await waitFor(() =>
      expect(notificationsApi.list).toHaveBeenLastCalledWith({
        limit: 10,
        offset: 0,
        unread: true,
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Notification 1\b/ })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /Notification 11\b/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next page' })).not.toBeInTheDocument();
  });

  it('refreshes the unread filter and bell count after reading one item', async () => {
    notifications = notifications.slice(0, 11);
    renderPage(
      <>
        <NotificationsBell />
        <NotificationsPage />
      </>,
    );
    await screen.findByRole('button', { name: 'Notifications, 1 unread' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Unread only' }));
    const unread = await screen.findByRole('button', { name: /Notification 11\b/ });
    fireEvent.click(unread);
    await waitFor(() => expect(screen.getByText('No unread notifications')).toBeInTheDocument());
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Notifications' })).toBeInTheDocument(),
    );
    expect(notificationsApi.markRead).toHaveBeenCalledWith({ ids: ['notification-11'] });
  });

  it('links the bell preview to the full inbox and keeps mark all read', async () => {
    renderPage(<NotificationsBell />);
    const trigger = await screen.findByRole('button', { name: 'Notifications, 2 unread' });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    expect(await screen.findByRole('menuitem', { name: 'View all' })).toHaveAttribute(
      'href',
      '/notifications',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Mark all read' }));
    await waitFor(() => expect(notificationsApi.markRead).toHaveBeenCalledWith({ all: true }));
  });
});
