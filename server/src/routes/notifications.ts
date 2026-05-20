import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/session.js';
import type { NotificationService } from '../notifications/service.js';

export async function registerNotificationRoutes(
  app: FastifyInstance,
  opts: { notifications: NotificationService },
): Promise<void> {
  const { notifications } = opts;

  app.get('/api/notifications', async (req, reply) => {
    const user = requireAuth(req);
    const items = await notifications.list(user.id, 100);
    const unread = await notifications.unreadCount(user.id);
    reply.send({ notifications: items, unread });
  });

  app.post('/api/notifications/:id/read', async (req, reply) => {
    requireAuth(req);
    const { id } = req.params as { id: string };
    await notifications.markRead(id);
    reply.status(204).send();
  });
}
