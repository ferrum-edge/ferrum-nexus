import { v4 as uuid } from 'uuid';
import type { NexusStore } from '../db/store.js';
import type { NotificationItem, NotificationType } from '@ferrum-nexus/shared';

export interface NotificationService {
  push(opts: {
    recipientId: string;
    type: NotificationType;
    payload: Record<string, unknown>;
  }): Promise<NotificationItem>;
  list(userId: string, limit?: number): Promise<NotificationItem[]>;
  markRead(id: string): Promise<void>;
  unreadCount(userId: string): Promise<number>;
}

export function createNotificationService(store: NexusStore): NotificationService {
  return {
    async push({ recipientId, type, payload }) {
      const row = await store.notifications.insert({
        id: uuid(),
        recipient_id: recipientId,
        type,
        payload,
        read_at: null,
        created_at: new Date().toISOString(),
      });
      return toItem(row);
    },
    async list(userId, limit = 50) {
      const rows = await store.notifications.listForUser(userId, limit);
      return rows.map(toItem);
    },
    async markRead(id) {
      await store.notifications.markRead(id, new Date().toISOString());
    },
    async unreadCount(userId) {
      return store.notifications.unreadCount(userId);
    },
  };
}

function toItem(row: {
  id: string;
  recipient_id: string;
  type: string;
  payload: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
}): NotificationItem {
  return {
    id: row.id,
    recipientId: row.recipient_id,
    type: row.type as NotificationType,
    payload: row.payload,
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}
