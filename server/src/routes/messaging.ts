/**
 * `/api/threads` — the portal inbox.
 *
 * Every endpoint requires a session; who may read or post in a given thread is
 * decided by the messaging service, which owns the participant/platform rules.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { MAX_PAGE_SIZE } from '@ferrum-nexus/shared';
import type {
  CreateThreadResponse,
  GetThreadResponse,
  ListThreadMessagesResponse,
  ListThreadsResponse,
  SendMessageResponse,
} from '@ferrum-nexus/shared';

import type { MessagePageOptions, MessagingService } from '../messaging/service.js';
import { clientIp, requireAuth, requireAuthHook } from '../middleware/auth-plugin.js';
import { parseOrThrow } from '../middleware/error-handler.js';
import { idParamSchema, listOptions, listQuerySchema } from './common.js';

/** Services this route plugin needs. */
export interface MessagingRoutesOptions {
  messaging: MessagingService;
}

/** Longest single message body accepted, matching the `messages.body` column. */
export const MAX_MESSAGE_LENGTH = 10_000;

/**
 * Per-account burst limits on the two write paths, enforced by the
 * `@fastify/rate-limit` instance the composition root registers on this scope
 * with `global: false` (so the reads stay unthrottled).
 *
 * Opening a conversation is the expensive half — it may seat a brand new thread
 * and, for a platform thread, fan a notification and an email out to every
 * administrator — so it gets the tighter number. Replying inside an existing
 * thread is the ordinary case and gets room for a real back-and-forth.
 *
 * These bound a burst; the rolling daily budget in the messaging service bounds
 * the day. Counters live in one process's memory, so N instances enforce N ×
 * these numbers — the daily budget, which counts durable rows, does not have
 * that problem.
 */
export const THREAD_CREATE_RATE_LIMIT = { max: 10, timeWindow: '1 minute' } as const;

/** Per-account burst limit on `POST /api/threads/:id/messages`. */
export const MESSAGE_SEND_RATE_LIMIT = { max: 30, timeWindow: '1 minute' } as const;

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

/**
 * `?limit=&before=` on the two transcript reads.
 *
 * There is no `offset`: a conversation grows at the end a reader is anchored
 * to, so an offset into it slides under every reply. `before` is the id of a
 * message already in hand, which does not.
 */
const messagePageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
  before: z.string().trim().min(1).max(64).optional(),
});

/** Turn the parsed query into the messaging service's page options. */
function messagePageOptions(query: z.infer<typeof messagePageQuery>): MessagePageOptions {
  return {
    ...(query.limit !== undefined ? { limit: query.limit } : {}),
    ...(query.before !== undefined ? { before: query.before } : {}),
  };
}

/** `/api/threads` route plugin. */
export const messagingRoutes: FastifyPluginAsync<MessagingRoutesOptions> = async (app, options) => {
  const { messaging } = options;
  app.addHook('onRequest', requireAuthHook);

  app.get('/', async (request): Promise<ListThreadsResponse> => {
    const { user } = requireAuth(request);
    const query = parseOrThrow(listThreadsQuery, request.query);
    return messaging.listThreadsFor(user, query, listOptions(query));
  });

  app.post(
    '/',
    { config: { rateLimit: { ...THREAD_CREATE_RATE_LIMIT } } },
    async (request, reply): Promise<CreateThreadResponse> => {
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
    },
  );

  app.get('/:id', async (request): Promise<GetThreadResponse> => {
    const { user } = requireAuth(request);
    const { id } = parseOrThrow(idParamSchema, request.params);
    const query = parseOrThrow(messagePageQuery, request.query);
    return messaging.getThread(user, id, messagePageOptions(query));
  });

  app.get('/:id/messages', async (request): Promise<ListThreadMessagesResponse> => {
    const { user } = requireAuth(request);
    const { id } = parseOrThrow(idParamSchema, request.params);
    const query = parseOrThrow(messagePageQuery, request.query);
    return messaging.listMessages(user, id, messagePageOptions(query));
  });

  app.post(
    '/:id/messages',
    { config: { rateLimit: { ...MESSAGE_SEND_RATE_LIMIT } } },
    async (request, reply): Promise<SendMessageResponse> => {
      const { user } = requireAuth(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(sendMessageBody, request.body);
      const message = await messaging.sendMessage(user, id, input.body, clientIp(request));
      reply.status(201);
      return { message };
    },
  );
};
