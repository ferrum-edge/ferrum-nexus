/**
 * `/api/users` and `/api/organizations`.
 *
 * `/me` is available to any signed-in account; everything else requires
 * `admin`. The role and last-super-admin guards live in the users service, so
 * these handlers only validate shapes and pass the caller through.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import {
  MIN_PASSWORD_LENGTH,
  ROLE_ORDER,
  type CreateOrganizationResponse,
  type GetMeUserResponse,
  type ListOrganizationsResponse,
  type ListUsersResponse,
  type UpdateMeResponse,
  type UpdateUserResponse,
} from '@ferrum-nexus/shared';

import type { NexusConfig } from '../config/index.js';
import { clientIp, requestContext, requireAuth, requireRole } from '../middleware/auth-plugin.js';
import { parseOrThrow } from '../middleware/error-handler.js';
import { setSessionCookies } from '../middleware/session-cookies.js';
import type { UsersService } from '../users/service.js';
import { idParamSchema, listOptions, listQuerySchema } from './common.js';

/** Services this route plugin needs. */
export interface UsersRoutesOptions {
  users: UsersService;
  /** Cookie policy for the session a password change re-issues. */
  config: NexusConfig;
}

const updateMeBody = z.object({
  display_name: z.string().trim().min(1).max(200).optional(),
  company: z.string().trim().max(200).nullish(),
  phone: z.string().trim().max(64).nullish(),
  current_password: z.string().min(1).max(1024).optional(),
  new_password: z.string().min(MIN_PASSWORD_LENGTH).max(1024).optional(),
});

const listUsersQuery = listQuerySchema.extend({
  role: z.enum(ROLE_ORDER).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  org_id: z.string().trim().min(1).max(64).optional(),
  q: z.string().trim().max(200).optional(),
});

const updateUserBody = z.object({
  role: z.enum(ROLE_ORDER).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  org_id: z.string().trim().min(1).max(64).nullish(),
  display_name: z.string().trim().min(1).max(200).optional(),
});

const createOrganizationBody = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullish(),
});

const updateOrganizationBody = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).nullish(),
});

/** `/api/users` route plugin. */
export const usersRoutes: FastifyPluginAsync<UsersRoutesOptions> = async (app, options) => {
  const { users, config } = options;

  app.get('/me', async (request): Promise<GetMeUserResponse> => {
    const { user } = requireAuth(request);
    return { user: users.getMe(user) };
  });

  app.patch('/me', async (request, reply): Promise<UpdateMeResponse> => {
    const { user } = requireAuth(request);
    const input = parseOrThrow(updateMeBody, request.body);
    const result = await users.updateMe(user, input, requestContext(request));
    // A password change killed every session, including this request's own;
    // the replacement has to reach the browser or the caller is signed out.
    if (result.reissued) setSessionCookies(reply, config, result.reissued);
    return { user: result.user };
  });

  app.get('/', { onRequest: requireRole('admin') }, async (request): Promise<ListUsersResponse> => {
    const query = parseOrThrow(listUsersQuery, request.query);
    return users.listUsers(query, listOptions(query));
  });

  app.patch(
    '/:id',
    { onRequest: requireRole('admin') },
    async (request): Promise<UpdateUserResponse> => {
      const { user } = requireAuth(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const patch = parseOrThrow(updateUserBody, request.body);
      return { user: await users.updateUser(user, id, patch, clientIp(request)) };
    },
  );
};

/** `/api/organizations` route plugin — admin only, all of it. */
export const organizationRoutes: FastifyPluginAsync<UsersRoutesOptions> = async (app, options) => {
  const { users } = options;
  app.addHook('onRequest', requireRole('admin'));

  app.get('/', async (request): Promise<ListOrganizationsResponse> => {
    const query = parseOrThrow(listQuerySchema, request.query);
    return users.listOrganizations(listOptions(query));
  });

  app.post('/', async (request, reply): Promise<CreateOrganizationResponse> => {
    const { user } = requireAuth(request);
    const input = parseOrThrow(createOrganizationBody, request.body);
    const organization = await users.createOrganization(user, input, clientIp(request));
    reply.status(201);
    return { organization };
  });

  // No shared DTO exists for the update body; the response mirrors the create
  // shape so the SPA can reuse one parser.
  app.patch('/:id', async (request): Promise<CreateOrganizationResponse> => {
    const { user } = requireAuth(request);
    const { id } = parseOrThrow(idParamSchema, request.params);
    const patch = parseOrThrow(updateOrganizationBody, request.body);
    return { organization: await users.updateOrganization(user, id, patch, clientIp(request)) };
  });
};
