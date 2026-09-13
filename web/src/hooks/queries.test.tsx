import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmailTemplate, ListNotificationsResponse } from '@ferrum-nexus/shared';
import { CREATED_AT } from '../../test/fixtures';
import { adminApi, catalogApi, healthApi, notificationsApi, threadsApi } from '../lib/api';
import { queryKeys } from './keys';
import { useEmailTemplate, useEmailTemplates, useUpdateEmailTemplate } from './useAdminSettings';
import { useCatalogApi, useCatalogSpec } from './useCatalog';
import { useEdgeHealth, useHealth } from './useHealth';
import {
  NOTIFICATION_POLL_MS,
  useMarkNotificationsRead,
  useNotifications,
} from './useNotifications';
import { useThread } from './useThreads';

let client: QueryClient;

function wrapper({ children }: { children: ReactNode }): ReactElement {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  cleanup();
  client.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const notification: ListNotificationsResponse['items'][number] = {
  id: 'notification-1',
  user_id: 'user-1',
  type: 'message_received',
  title: 'New reply',
  body: 'The provider replied',
  link: '/messages/thread-1',
  read_at: null,
  created_at: CREATED_AT,
  updated_at: CREATED_AT,
};

describe('notification queries', () => {
  it('refreshes unread results after marking a notification read', async () => {
    let unread = true;
    vi.spyOn(notificationsApi, 'list').mockImplementation(async () => ({
      items: unread ? [notification] : [],
      total: unread ? 1 : 0,
      unread_count: unread ? 1 : 0,
    }));
    vi.spyOn(notificationsApi, 'markRead').mockImplementation(async () => {
      unread = false;
      return { updated: 1, unread_count: 0 };
    });
    const { result } = renderHook(
      () => ({ query: useNotifications({ unread: true }), mark: useMarkNotificationsRead() }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.query.data?.unread_count).toBe(1));
    await act(async () => {
      await result.current.mark.mutateAsync({ ids: [notification.id] });
    });
    await waitFor(() => expect(result.current.query.data?.unread_count).toBe(0));
    expect(result.current.query.data?.items).toEqual([]);
    expect(notificationsApi.markRead).toHaveBeenCalledWith({ ids: [notification.id] });
    expect(notificationsApi.list).toHaveBeenLastCalledWith({ unread: true });
  });

  it('does not discard unread notifications when marking them read fails', async () => {
    vi.spyOn(notificationsApi, 'list').mockResolvedValue({
      items: [notification],
      total: 1,
      unread_count: 1,
    });
    vi.spyOn(notificationsApi, 'markRead').mockRejectedValue(new Error('Service unavailable'));
    const { result } = renderHook(
      () => ({ query: useNotifications(), mark: useMarkNotificationsRead() }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    await act(async () => {
      await expect(result.current.mark.mutateAsync({ all: true })).rejects.toThrow(
        'Service unavailable',
      );
    });
    expect(result.current.query.data?.unread_count).toBe(1);
    expect(notificationsApi.list).toHaveBeenCalledTimes(1);
  });

  it('polls while enabled and stops after disabling or unmounting', async () => {
    vi.useFakeTimers();
    vi.spyOn(notificationsApi, 'list').mockResolvedValue({ items: [], total: 0, unread_count: 0 });
    const { rerender, unmount } = renderHook(({ enabled }) => useNotifications({}, enabled), {
      wrapper,
      initialProps: { enabled: false },
    });
    await act(async () => vi.advanceTimersByTimeAsync(NOTIFICATION_POLL_MS));
    expect(notificationsApi.list).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(notificationsApi.list).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(NOTIFICATION_POLL_MS));
    expect(notificationsApi.list).toHaveBeenCalledTimes(2);
    rerender({ enabled: false });
    await act(async () => vi.advanceTimersByTimeAsync(NOTIFICATION_POLL_MS * 2));
    expect(notificationsApi.list).toHaveBeenCalledTimes(2);
    unmount();
    await act(async () => vi.advanceTimersByTimeAsync(NOTIFICATION_POLL_MS * 2));
    expect(notificationsApi.list).toHaveBeenCalledTimes(2);
  });
});

describe('query enablement and errors', () => {
  it('does not request catalog entries or conversations without route identifiers', () => {
    vi.spyOn(catalogApi, 'detail').mockRejectedValue(new Error('Unexpected catalog request'));
    vi.spyOn(catalogApi, 'spec').mockRejectedValue(new Error('Unexpected spec request'));
    vi.spyOn(threadsApi, 'get').mockRejectedValue(new Error('Unexpected thread request'));
    renderHook(() => [useCatalogApi(''), useCatalogSpec(''), useThread('')], { wrapper });
    expect(catalogApi.detail).not.toHaveBeenCalled();
    expect(catalogApi.spec).not.toHaveBeenCalled();
    expect(threadsApi.get).not.toHaveBeenCalled();
  });

  it('enables health queries on demand and reports failures without retrying', async () => {
    vi.spyOn(healthApi, 'get').mockRejectedValue(new Error('Portal health unavailable'));
    vi.spyOn(healthApi, 'edge').mockRejectedValue(new Error('Gateway health unavailable'));
    const { result, rerender } = renderHook(
      ({ enabled }) => ({ health: useHealth(enabled), edge: useEdgeHealth(enabled) }),
      { wrapper, initialProps: { enabled: false } },
    );
    expect(healthApi.get).not.toHaveBeenCalled();
    expect(healthApi.edge).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await waitFor(() => {
      expect(result.current.health.isError).toBe(true);
      expect(result.current.edge.isError).toBe(true);
    });
    expect(result.current.health.error?.message).toBe('Portal health unavailable');
    expect(result.current.edge.error?.message).toBe('Gateway health unavailable');
    expect(healthApi.get).toHaveBeenCalledTimes(1);
    expect(healthApi.edge).toHaveBeenCalledTimes(1);
  });
});

describe('email template cache', () => {
  it('loads templates lazily and refreshes both the editor and list after saving', async () => {
    let template: EmailTemplate = {
      id: 'template-1',
      key: 'message_received',
      subject: 'New message',
      body_html: '<p>You have a message</p>',
      body_text: 'You have a message',
      created_at: CREATED_AT,
      updated_at: CREATED_AT,
    };
    vi.spyOn(adminApi, 'listEmailTemplates').mockImplementation(async () => ({
      templates: [template],
      keys: ['message_received'],
    }));
    vi.spyOn(adminApi, 'getEmailTemplate').mockImplementation(async () => ({
      template,
      available_variables: ['portal_name'],
    }));
    vi.spyOn(adminApi, 'updateEmailTemplate').mockImplementation(async (_key, body) => {
      template = { ...template, ...body };
      return { template };
    });
    client.setQueryData(queryKeys.credentials.list({}), { items: [], total: 0 });
    const { result, rerender } = renderHook(
      ({ enabled }) => ({
        list: useEmailTemplates(enabled),
        detail: useEmailTemplate('message_received', enabled),
        update: useUpdateEmailTemplate(),
      }),
      { wrapper, initialProps: { enabled: false } },
    );
    expect(adminApi.listEmailTemplates).not.toHaveBeenCalled();
    expect(adminApi.getEmailTemplate).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.detail.data?.template.subject).toBe('New message'));
    const body = { subject: 'A new reply', body_html: '<p>Reply</p>', body_text: 'Reply' };
    await act(async () => {
      await result.current.update.mutateAsync({ key: 'message_received', body });
    });
    await waitFor(() => {
      expect(result.current.detail.data?.template.subject).toBe('A new reply');
      expect(result.current.list.data?.templates[0]?.subject).toBe('A new reply');
    });
    expect(adminApi.updateEmailTemplate).toHaveBeenCalledWith('message_received', body);
    expect(client.getQueryState(queryKeys.credentials.list({}))?.isInvalidated).toBe(false);
  });
});
