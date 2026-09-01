/**
 * In-app notifications — the bell menu in the header.
 *
 * The surface is deliberately generic (`notify(userId, type, title, body,
 * link?)`) because every workflow service emits through it: messaging today,
 * access decisions, credential rotation and god-mode broadcasts as they land.
 * Notifications are a *courtesy* channel: they are never the record of what
 * happened — that is the audit log — so nothing here writes an audit row and
 * a failure to notify must never fail the operation that triggered it.
 */

import type {
  ListNotificationsResponse,
  Notification,
  NotificationType,
  Uuid,
} from '@ferrum-nexus/shared';

import type { ListOptions, NexusStore, NotificationFilter } from '../db/store.js';
import { nowIso } from '../lib/ids.js';

/** Filters accepted by {@link NotificationsService.list}. */
export interface NotificationListFilter {
  unread?: boolean;
  type?: NotificationType;
}

/** In-app notification operations. */
export interface NotificationsService {
  /** Create one notification. */
  notify(
    userId: Uuid,
    type: NotificationType,
    title: string,
    body: string,
    link?: string | null,
  ): Promise<Notification>;
  /** Create the same notification for many users in one insert batch. */
  notifyMany(
    userIds: readonly Uuid[],
    type: NotificationType,
    title: string,
    body: string,
    link?: string | null,
  ): Promise<Notification[]>;
  /** Newest-first page for one user, with the unread badge count attached. */
  list(
    userId: Uuid,
    filter?: NotificationListFilter,
    options?: ListOptions,
  ): Promise<ListNotificationsResponse>;
  countUnread(userId: Uuid): Promise<number>;
  /** Mark specific notifications read. Ids belonging to another user are ignored. */
  markRead(userId: Uuid, ids: readonly Uuid[]): Promise<number>;
  markAllRead(userId: Uuid): Promise<number>;
}

/** Dependencies of {@link createNotificationsService}. */
export interface NotificationsServiceDeps {
  store: NexusStore;
}

/** Build the notifications service. */
export function createNotificationsService(deps: NotificationsServiceDeps): NotificationsService {
  const { store } = deps;

  return {
    async notify(userId, type, title, body, link = null): Promise<Notification> {
      return store.notifications.create({ user_id: userId, type, title, body, link });
    },

    async notifyMany(userIds, type, title, body, link = null): Promise<Notification[]> {
      if (userIds.length === 0) return [];
      return store.notifications.createMany(
        userIds.map((userId) => ({ user_id: userId, type, title, body, link })),
      );
    },

    async list(userId, filter = {}, options): Promise<ListNotificationsResponse> {
      const storeFilter: NotificationFilter = {
        user_id: userId,
        ...(filter.unread !== undefined ? { unread: filter.unread } : {}),
        ...(filter.type !== undefined ? { type: filter.type } : {}),
      };
      const page = await store.notifications.list(storeFilter, options);
      return {
        items: page.items,
        total: page.total,
        unread_count: await store.notifications.countUnread(userId),
      };
    },

    countUnread: async (userId) => store.notifications.countUnread(userId),

    async markRead(userId, ids): Promise<number> {
      if (ids.length === 0) return 0;
      return store.notifications.markRead(userId, [...ids], nowIso());
    },

    markAllRead: async (userId) => store.notifications.markAllRead(userId, nowIso()),
  };
}
