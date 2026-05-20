import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/session.js';
import type { MessagingService } from '../messaging/service.js';

export async function registerMessageRoutes(
  app: FastifyInstance,
  opts: { messaging: MessagingService },
): Promise<void> {
  const { messaging } = opts;

  app.get('/api/messages', async (req, reply) => {
    const user = requireAuth(req);
    const conversations = await messaging.listForUser(user.id);
    reply.send({ conversations });
  });

  app.get('/api/messages/:conversationId', async (req, reply) => {
    const user = requireAuth(req);
    const { conversationId } = req.params as { conversationId: string };
    const messages = await messaging.list({ actorId: user.id, conversationId });
    reply.send({ messages });
  });

  app.post('/api/messages/:conversationId', async (req, reply) => {
    const user = requireAuth(req);
    const { conversationId } = req.params as { conversationId: string };
    const { body } = z.object({ body: z.string().min(1).max(5000) }).parse(req.body);
    const message = await messaging.send({ actorId: user.id, conversationId, body });
    reply.status(201).send({ message });
  });

  app.post('/api/messages/:conversationId/read', async (req, reply) => {
    const user = requireAuth(req);
    const { conversationId } = req.params as { conversationId: string };
    await messaging.markRead({ actorId: user.id, conversationId });
    reply.status(204).send();
  });
}
