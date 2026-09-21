/**
 * `/api/applications` — the caller's application identities (issue #289).
 *
 * An application is a separate gateway identity owned by a portal account,
 * with its own approved APIs and its own credentials. These routes administer
 * the identity itself; acting *as* one is a parameter on the access-request
 * and credential routes, where `ApplicationsService.resolveForActor` is what
 * checks ownership and that the application is active.
 *
 * `session` rather than a role hook: a `client` is exactly who needs
 * applications, and providers and admins get them for the same reason anybody
 * does. Ownership, not role, is what scopes every route here.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import type {
  CreateApplicationResponse,
  DeleteApplicationResponse,
  GetApplicationResponse,
  ListApplicationsResponse,
  UpdateApplicationResponse,
} from '@ferrum-nexus/shared';

import type { ApplicationsService } from '../applications/service.js';
import { clientIp, requireAuth, requireAuthHook } from '../middleware/auth-plugin.js';
import { parseOrThrow } from '../middleware/error-handler.js';
import { idParamSchema, listOptions, listQuerySchema } from './common.js';

/** Services this route plugin needs. */
export interface ApplicationRoutesOptions {
  applications: ApplicationsService;
}

const listApplicationsQuery = listQuerySchema.extend({
  /** Admin-only: somebody else's. A client always sees their own. */
  owner_user_id: z.string().trim().min(1).max(64).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  q: z.string().trim().max(200).optional(),
});

const createBody = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullish(),
});

const updateBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(500).nullish(),
  status: z.enum(['active', 'disabled']).optional(),
});

/** Rate limit shared by the mutating routes here, matching the other writes. */
const MUTATION_RATE_LIMIT = { rateLimit: { max: 30, timeWindow: '1 minute' } } as const;

/** `/api/applications` route plugin. */
export const applicationRoutes: FastifyPluginAsync<ApplicationRoutesOptions> = async (
  app,
  options,
) => {
  const { applications } = options;
  app.addHook('onRequest', requireAuthHook);

  app.get('/', async (request): Promise<ListApplicationsResponse> => {
    const { user } = requireAuth(request);
    const query = parseOrThrow(listApplicationsQuery, request.query);
    return applications.list(
      user,
      {
        ...(query.owner_user_id !== undefined ? { owner_user_id: query.owner_user_id } : {}),
        ...(query.status !== undefined ? { status: query.status } : {}),
        ...(query.q !== undefined ? { q: query.q } : {}),
      },
      listOptions(query),
    );
  });

  app.get('/:id', async (request): Promise<GetApplicationResponse> => {
    const { user } = requireAuth(request);
    const { id } = parseOrThrow(idParamSchema, request.params);
    return { application: await applications.get(user, id) };
  });

  app.post(
    '/',
    { config: MUTATION_RATE_LIMIT },
    async (request, reply): Promise<CreateApplicationResponse> => {
      const { user } = requireAuth(request);
      const input = parseOrThrow(createBody, request.body);
      const application = await applications.create(
        user,
        { name: input.name, description: input.description ?? null },
        clientIp(request),
      );
      reply.status(201);
      return { application };
    },
  );

  app.patch(
    '/:id',
    { config: MUTATION_RATE_LIMIT },
    async (request): Promise<UpdateApplicationResponse> => {
      const { user } = requireAuth(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const patch = parseOrThrow(updateBody, request.body);
      const application = await applications.update(
        user,
        id,
        {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.description !== undefined ? { description: patch.description ?? null } : {}),
          ...(patch.status !== undefined ? { status: patch.status } : {}),
        },
        clientIp(request),
      );
      return { application };
    },
  );

  /**
   * Destructive: the gateway identity goes, and with it every credential that
   * authenticated as it. The reversible option is `PATCH` with
   * `status: 'disabled'`, which refuses new access and new credentials while
   * leaving what exists working.
   */
  app.delete(
    '/:id',
    { config: MUTATION_RATE_LIMIT },
    async (request): Promise<DeleteApplicationResponse> => {
      const { user } = requireAuth(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      return applications.remove(user, id, clientIp(request));
    },
  );
};
