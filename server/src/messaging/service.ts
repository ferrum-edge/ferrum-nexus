import { v4 as uuid } from 'uuid';
import { z } from 'zod';
import type { NexusStore } from '../db/store.js';
import type { Conversation, Message } from '@ferrum-nexus/shared';
import { forbidden, notFound, badRequest } from '../lib/errors.js';
import type { NotificationService } from '../notifications/service.js';
import type { EmailService } from '../email/service.js';

export const SendMessageInput = z.object({
  body: z.string().min(1).max(5000),
});

export interface MessagingService {
  listForUser(userId: string): Promise<Conversation[]>;
  open(opts: {
    actorId: string;
    apiAssetId: string;
    type: 'access_request' | 'api_support' | 'admin_direct';
    otherParticipantIds: string[];
    subject?: string;
  }): Promise<Conversation>;
  send(opts: {
    actorId: string;
    conversationId: string;
    body: string;
  }): Promise<Message>;
  list(opts: { actorId: string; conversationId: string }): Promise<Message[]>;
  markRead(opts: { actorId: string; conversationId: string }): Promise<void>;
  broadcast(opts: {
    actorId: string;
    apiAssetId: string;
    subject: string;
    body: string;
  }): Promise<{ conversationId: string; recipients: string[] }>;
}

export function createMessagingService(
  store: NexusStore,
  notifications: NotificationService,
  email: EmailService,
): MessagingService {
  const conversationToApi = (row: {
    id: string;
    api_asset_id: string | null;
    request_id: string | null;
    grant_id: string | null;
    type: 'access_request' | 'api_support' | 'admin_direct' | 'announcement';
    subject: string;
    participants: string[];
    created_at: string;
  }): Conversation => ({
    id: row.id,
    apiAssetId: row.api_asset_id,
    requestId: row.request_id,
    grantId: row.grant_id,
    type: row.type,
    subject: row.subject,
    createdAt: row.created_at,
    participantIds: row.participants,
  });

  const messageToApi = (row: {
    id: string;
    conversation_id: string;
    sender_id: string;
    body: string;
    created_at: string;
    read_by: string[];
  }): Message => ({
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    body: row.body,
    createdAt: row.created_at,
    readBy: row.read_by,
  });

  const ensureParticipant = async (
    actorId: string,
    conversationId: string,
  ): Promise<{ participants: string[]; asset_id: string | null }> => {
    const conv = await store.conversations.findById(conversationId);
    if (!conv) throw notFound('Conversation not found');
    if (!conv.participants.includes(actorId)) throw forbidden('Not a participant');
    return { participants: conv.participants, asset_id: conv.api_asset_id };
  };

  const open: MessagingService['open'] = async ({
    actorId,
    apiAssetId,
    type,
    otherParticipantIds,
    subject,
  }) => {
    const asset = await store.apiAssets.findById(apiAssetId);
    if (!asset) throw notFound('API asset not found');
    const participants = Array.from(new Set([actorId, ...otherParticipantIds]));
    const row = await store.conversations.insert({
      id: uuid(),
      api_asset_id: apiAssetId,
      request_id: null,
      grant_id: null,
      type,
      subject: subject ?? `Conversation: ${asset.title}`,
      participants,
      created_at: new Date().toISOString(),
    });
    return conversationToApi(row);
  };

  const send: MessagingService['send'] = async ({ actorId, conversationId, body }) => {
    const { participants } = await ensureParticipant(actorId, conversationId);
    const message = await store.messages.insert({
      id: uuid(),
      conversation_id: conversationId,
      sender_id: actorId,
      body,
      created_at: new Date().toISOString(),
      read_by: [actorId],
    });
    const sender = await store.users.findById(actorId);
    for (const pid of participants) {
      if (pid === actorId) continue;
      await notifications.push({
        recipientId: pid,
        type: 'message_received',
        payload: { conversationId, senderName: sender?.name ?? sender?.email },
      });
      const recipient = await store.users.findById(pid);
      if (recipient) {
        await email.enqueue({
          to: recipient.email,
          templateKey: 'message_received',
          vars: {
            senderName: sender?.name ?? sender?.email ?? 'Someone',
            subject: 'Ferrum Nexus message',
            preview: body.slice(0, 200),
          },
        });
      }
    }
    return messageToApi(message);
  };

  const list: MessagingService['list'] = async ({ actorId, conversationId }) => {
    await ensureParticipant(actorId, conversationId);
    const rows = await store.messages.listForConversation(conversationId);
    return rows.map(messageToApi);
  };

  const markRead: MessagingService['markRead'] = async ({ actorId, conversationId }) => {
    await ensureParticipant(actorId, conversationId);
    await store.messages.markRead(conversationId, actorId, new Date().toISOString());
  };

  const broadcast: MessagingService['broadcast'] = async ({
    actorId,
    apiAssetId,
    subject,
    body,
  }) => {
    const asset = await store.apiAssets.findById(apiAssetId);
    if (!asset) throw notFound('API asset not found');
    if (asset.provider_id !== actorId) throw forbidden('Not the API owner');
    const grants = await store.grants.listForAsset(apiAssetId);
    const recipients = Array.from(
      new Set(grants.filter((g) => g.status === 'active').map((g) => g.client_user_id)),
    );
    if (recipients.length === 0) {
      throw badRequest('no_recipients', 'No active grants to broadcast to');
    }
    const conv = await store.conversations.insert({
      id: uuid(),
      api_asset_id: apiAssetId,
      request_id: null,
      grant_id: null,
      type: 'announcement',
      subject,
      participants: [actorId, ...recipients],
      created_at: new Date().toISOString(),
    });
    await send({ actorId, conversationId: conv.id, body });
    return { conversationId: conv.id, recipients };
  };

  return {
    listForUser: async (userId) =>
      (await store.conversations.listForUser(userId)).map(conversationToApi),
    open,
    send,
    list,
    markRead,
    broadcast,
  };
}
