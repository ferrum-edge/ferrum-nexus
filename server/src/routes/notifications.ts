/**
 * `/api/notifications` — the header bell.
 *
 * A user only ever sees their own notifications: the caller's id comes from the
 * session, never from the request, so there is no id to tamper with. Marking
 * read is a state change and therefore audited like any other.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import type {
  ListNotificationsResponse,
  MarkNotificationsReadResponse,
  NotificationType,
} from '@ferrum-nexus/shared';

import { AuditAction, type AuditService } from '../audit/service.js';
import { clientIp, requireAuth, requireAuthHook } from '../middleware/auth-plugin.js';
import { parseOrThrow } from '../middleware/error-handler.js';
import type { NotificationsService } from '../notifications/service.js';
import { booleanQuerySchema, listOptions, listQuerySchema, toBoolean } from './common.js';

/** Services this route plugin needs. */
export interface NotificationsRoutesOptions {
  notifications: NotificationsService;
  audit: AuditService;
}

const NOTIFICATION_TYPES = [
  'access_request_created',
  'access_request_approved',
  'access_request_denied',
  'access_revoked',
  'message_received',
  'credential_rotated',
  'api_published',
  'system',
] as const satisfies readonly NotificationType[];

const listNotificationsQuery = listQuerySchema.extend({
  unread: booleanQuerySchema,
  type: z.enum(NOTIFICATION_TYPES).optional(),
});

const markReadBody = z
  .object({
    ids: z.array(z.string().trim().min(1).max(64)).max(500).optional(),
    all: z.boolean().optional(),
  })
  .refine((value) => value.all === true || (value.ids?.length ?? 0) > 0, {
    message: 'Provide notification ids or all: true',
  });

/** `/api/notifications` route plugin. */
export const notificationsRoutes: FastifyPluginAsync<NotificationsRoutesOptions> = async (
  app,
  options,
) => {
  const { notifications, audit } = options;
  app.addHook('onRequest', requireAuthHook);

  app.get('/', async (request): Promise<ListNotificationsResponse> => {
    const { user } = requireAuth(request);
    const query = parseOrThrow(listNotificationsQuery, request.query);
    const unread = toBoolean(query.unread);
    return notifications.list(
      user.id,
      {
        ...(unread !== undefined ? { unread } : {}),
        ...(query.type !== undefined ? { type: query.type } : {}),
      },
      listOptions(query),
    );
  });

  app.post('/read', async (request): Promise<MarkNotificationsReadResponse> => {
    const { user } = requireAuth(request);
    const input = parseOrThrow(markReadBody, request.body);
    const updated =
      input.all === true
        ? await notifications.markAllRead(user.id)
        : await notifications.markRead(user.id, input.ids ?? []);

    await audit.record(
      { id: user.id, role: user.role },
      AuditAction.NOTIFICATION_READ,
      { type: 'notification', id: null },
      { updated, all: input.all === true },
      clientIp(request),
    );

    return { updated, unread_count: await notifications.countUnread(user.id) };
  });
};
