/**
 * `/api/threads` — the portal inbox.
 *
 * Every endpoint requires a session; who may read or post in a given thread is
 * decided by the messaging service, which owns the participant/platform rules.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import type {
  CreateThreadResponse,
  GetThreadResponse,
  ListThreadsResponse,
  SendMessageResponse,
} from '@ferrum-nexus/shared';

import type { MessagingService } from '../messaging/service.js';
import { clientIp, requireAuth, requireAuthHook } from '../middleware/auth-plugin.js';
import { parseOrThrow } from '../middleware/error-handler.js';
import { idParamSchema, listOptions, listQuerySchema } from './common.js';

/** Services this route plugin needs. */
export interface MessagingRoutesOptions {
  messaging: MessagingService;
}

/** Longest single message body accepted, matching the `messages.body` column. */
export const MAX_MESSAGE_LENGTH = 10_000;

const listThreadsQuery = listQuerySchema.extend({
  api_id: z.string().trim().min(1).max(64).optional(),
  q: z.string().trim().max(200).optional(),
});

const createThreadBody = z.object({
  subject: z.string().trim().min(1).max(200),
  recipient_user_id: z.string().trim().min(1).max(64).nullish(),
  api_id: z.string().trim().min(1).max(64).nullish(),
  body: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
});

const sendMessageBody = z.object({
  body: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
});

/** `/api/threads` route plugin. */
export const messagingRoutes: FastifyPluginAsync<MessagingRoutesOptions> = async (app, options) => {
  const { messaging } = options;
  app.addHook('onRequest', requireAuthHook);

  app.get('/', async (request): Promise<ListThreadsResponse> => {
    const { user } = requireAuth(request);
    const query = parseOrThrow(listThreadsQuery, request.query);
    return messaging.listThreadsFor(user, query, listOptions(query));
  });

  app.post('/', async (request, reply): Promise<CreateThreadResponse> => {
    const { user } = requireAuth(request);
    const input = parseOrThrow(createThreadBody, request.body);
    const result = await messaging.createThread({
      actor: user,
      subject: input.subject,
      body: input.body,
      recipientUserId: input.recipient_user_id ?? null,
      apiId: input.api_id ?? null,
      ip: clientIp(request),
    });
    reply.status(201);
    return { thread: result.thread, message: result.message };
  });

  app.get('/:id', async (request): Promise<GetThreadResponse> => {
    const { user } = requireAuth(request);
    const { id } = parseOrThrow(idParamSchema, request.params);
    return messaging.getThread(user, id);
  });

  app.post('/:id/messages', async (request, reply): Promise<SendMessageResponse> => {
    const { user } = requireAuth(request);
    const { id } = parseOrThrow(idParamSchema, request.params);
    const input = parseOrThrow(sendMessageBody, request.body);
    const message = await messaging.sendMessage(user, id, input.body, clientIp(request));
    reply.status(201);
    return { message };
  });
};
