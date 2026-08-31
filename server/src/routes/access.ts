/**
 * `/api/access-requests` and `/api/grants` — the approval workflow's HTTP face.
 *
 * Both plugins only require a session: a client raises and cancels requests, a
 * provider decides the ones on their own APIs, and an admin may act on any of
 * them. That "who may act on this row" question is answered by the access
 * service, not by a route-level role hook, because it depends on who owns the
 * API the request points at.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import {
  MAX_JUSTIFICATION_LENGTH,
  type ApproveAccessRequestResponse,
  type CancelAccessRequestResponse,
  type CreateAccessRequestResponse,
  type DenyAccessRequestResponse,
  type ListAccessRequestsResponse,
  type ListGrantsResponse,
  type RevokeGrantResponse,
} from '@ferrum-nexus/shared';

import type { AccessService } from '../access/service.js';
import { clientIp, requireAuth, requireAuthHook } from '../middleware/auth-plugin.js';
import { parseOrThrow } from '../middleware/error-handler.js';
import {
  booleanQuerySchema,
  idParamSchema,
  listOptions,
  listQuerySchema,
  toBoolean,
} from './common.js';

/** Services these route plugins need. */
export interface AccessRoutesOptions {
  access: AccessService;
}

const createBody = z.object({
  api_id: z.string().trim().min(1).max(64),
  justification: z.string().trim().min(1).max(MAX_JUSTIFICATION_LENGTH),
});

const decideBody = z.object({ decision_note: z.string().trim().max(2_000).nullish() });

const listRequestsQuery = listQuerySchema.extend({
  mine: booleanQuerySchema,
  api_id: z.string().trim().min(1).max(64).optional(),
  status: z.enum(['pending', 'approved', 'denied', 'revoked', 'cancelled']).optional(),
});

const listGrantsQuery = listQuerySchema.extend({
  mine: booleanQuerySchema,
  api_id: z.string().trim().min(1).max(64).optional(),
  user_id: z.string().trim().min(1).max(64).optional(),
  status: z.enum(['active', 'revoked']).optional(),
});

const revokeBody = z.object({ reason: z.string().trim().max(2_000).nullish() });

/** `/api/access-requests` route plugin. */
export const accessRequestRoutes: FastifyPluginAsync<AccessRoutesOptions> = async (
  app,
  options,
) => {
  const { access } = options;
  app.addHook('onRequest', requireAuthHook);

  app.get('/', async (request): Promise<ListAccessRequestsResponse> => {
    const { user } = requireAuth(request);
    const query = parseOrThrow(listRequestsQuery, request.query);
    const mine = toBoolean(query.mine);
    return access.listRequests(
      user,
      {
        ...(mine !== undefined ? { mine } : {}),
        ...(query.api_id !== undefined ? { api_id: query.api_id } : {}),
        ...(query.status !== undefined ? { status: query.status } : {}),
      },
      listOptions(query),
    );
  });

  app.post('/', async (request, reply): Promise<CreateAccessRequestResponse> => {
    const { user } = requireAuth(request);
    const input = parseOrThrow(createBody, request.body);
    const created = await access.request(
      user,
      input.api_id,
      input.justification,
      clientIp(request),
    );
    reply.status(201);
    return { access_request: created };
  });

  app.post('/:id/cancel', async (request): Promise<CancelAccessRequestResponse> => {
    const { user } = requireAuth(request);
    const { id } = parseOrThrow(idParamSchema, request.params);
    return { access_request: await access.cancel(user, id, clientIp(request)) };
  });

  app.post('/:id/approve', async (request): Promise<ApproveAccessRequestResponse> => {
    const { user } = requireAuth(request);
    const { id } = parseOrThrow(idParamSchema, request.params);
    const body = parseOrThrow(decideBody, request.body ?? {});
    return access.approve(user, id, body.decision_note ?? null, clientIp(request));
  });

  app.post('/:id/deny', async (request): Promise<DenyAccessRequestResponse> => {
    const { user } = requireAuth(request);
    const { id } = parseOrThrow(idParamSchema, request.params);
    const body = parseOrThrow(decideBody, request.body ?? {});
    return {
      access_request: await access.deny(user, id, body.decision_note ?? null, clientIp(request)),
    };
  });
};

/** `/api/grants` route plugin. */
export const grantRoutes: FastifyPluginAsync<AccessRoutesOptions> = async (app, options) => {
  const { access } = options;
  app.addHook('onRequest', requireAuthHook);

  app.get('/', async (request): Promise<ListGrantsResponse> => {
    const { user } = requireAuth(request);
    const query = parseOrThrow(listGrantsQuery, request.query);
    const mine = toBoolean(query.mine);
    return access.listGrants(
      user,
      {
        ...(mine !== undefined ? { mine } : {}),
        ...(query.api_id !== undefined ? { api_id: query.api_id } : {}),
        ...(query.user_id !== undefined ? { user_id: query.user_id } : {}),
        ...(query.status !== undefined ? { status: query.status } : {}),
      },
      listOptions(query),
    );
  });

  app.post('/:id/revoke', async (request): Promise<RevokeGrantResponse> => {
    const { user } = requireAuth(request);
    const { id } = parseOrThrow(idParamSchema, request.params);
    const body = parseOrThrow(revokeBody, request.body ?? {});
    return { grant: await access.revoke(user, id, body.reason ?? null, clientIp(request)) };
  });
};
