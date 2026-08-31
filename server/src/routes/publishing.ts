/**
 * `/api/apis` — the provider's own view of what they publish.
 *
 * The whole plugin requires at least `provider`; ownership is checked one level
 * down, in the publishing service, because "owner **or** admin" is a rule about
 * a specific row rather than about the route.
 *
 * Spec uploads arrive as a JSON string field rather than a multipart file: the
 * SPA reads the file client-side and the documents are small, so a single JSON
 * body keeps the CSRF story and the error shape identical to every other route.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import {
  AUTH_PLUGIN_TYPES,
  MAX_SPEC_BYTES,
  type CreateTestConsumerResponse,
  type DeleteApiResponse,
  type GetApiResponse,
  type ListApisResponse,
  type PublishApiResponse,
  type UpdateApiResponse,
  type UpdateApiSpecResponse,
} from '@ferrum-nexus/shared';

import { clientIp, requireAuth, requireRole } from '../middleware/auth-plugin.js';
import { parseOrThrow } from '../middleware/error-handler.js';
import type { PublishingService } from '../publishing/service.js';
import {
  booleanQuerySchema,
  idParamSchema,
  listOptions,
  listQuerySchema,
  toBoolean,
} from './common.js';

/** Services this route plugin needs. */
export interface PublishingRoutesOptions {
  publishing: PublishingService;
}

/** Character ceiling on an uploaded document; the byte check lives in `oas.ts`. */
const specField = z.string().min(1).max(MAX_SPEC_BYTES);

const rateLimitSchema = z
  .object({
    limit: z.number().int().min(1).max(10_000_000),
    window_seconds: z.number().int().min(1).max(86_400),
  })
  .nullable();

const listApisQuery = listQuerySchema.extend({
  mine: booleanQuerySchema,
  owner_user_id: z.string().trim().min(1).max(64).optional(),
  status: z.enum(['published', 'retired']).optional(),
  q: z.string().trim().max(200).optional(),
});

const publishBody = z.object({
  name: z.string().trim().min(1).max(200),
  slug: z.string().trim().max(60).optional(),
  description: z.string().trim().max(4_000).nullish(),
  version: z.string().trim().max(60).optional(),
  // Optional here even though the shared DTO marks it required: a document with
  // an absolute `servers[0].url` already names its upstream, and demanding the
  // provider retype it is friction with no safety benefit.
  upstream_url: z.string().trim().max(2_000).optional(),
  spec: specField,
  auth_plugin: z.enum(AUTH_PLUGIN_TYPES),
  requestable: z.boolean(),
  visibility: z.enum(['public', 'internal']),
  rate_limit: rateLimitSchema.optional(),
});

const updateBody = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(4_000).nullish(),
  version: z.string().trim().max(60).optional(),
  upstream_url: z.string().trim().max(2_000).optional(),
  auth_plugin: z.enum(AUTH_PLUGIN_TYPES).optional(),
  requestable: z.boolean().optional(),
  visibility: z.enum(['public', 'internal']).optional(),
  rate_limit: rateLimitSchema.optional(),
  status: z.enum(['published', 'retired']).optional(),
});

const specBody = z.object({
  spec: specField,
  version: z.string().trim().max(60).optional(),
});

const testConsumerBody = z.object({ label: z.string().trim().max(120).nullish() });

/** `/api/apis` route plugin. */
export const publishingRoutes: FastifyPluginAsync<PublishingRoutesOptions> = async (
  app,
  options,
) => {
  const { publishing } = options;
  app.addHook('onRequest', requireRole('provider'));

  app.get('/', async (request): Promise<ListApisResponse> => {
    const { user } = requireAuth(request);
    const query = parseOrThrow(listApisQuery, request.query);
    const mine = toBoolean(query.mine);
    return publishing.list(
      user,
      {
        ...(mine !== undefined ? { mine } : {}),
        ...(query.owner_user_id !== undefined ? { owner_user_id: query.owner_user_id } : {}),
        ...(query.status !== undefined ? { status: query.status } : {}),
        ...(query.q !== undefined ? { q: query.q } : {}),
      },
      listOptions(query),
    );
  });

  app.post('/', async (request, reply): Promise<PublishApiResponse> => {
    const { user } = requireAuth(request);
    const input = parseOrThrow(publishBody, request.body);
    const result = await publishing.publish(
      user,
      {
        ...input,
        slug: input.slug ?? '',
        version: input.version ?? '',
        upstream_url: input.upstream_url ?? '',
        description: input.description ?? null,
        rate_limit: input.rate_limit ?? null,
      },
      clientIp(request),
    );
    reply.status(201);
    return result;
  });

  app.get('/:id', async (request): Promise<GetApiResponse> => {
    const { user } = requireAuth(request);
    const { id } = parseOrThrow(idParamSchema, request.params);
    return publishing.get(user, id);
  });

  app.patch('/:id', async (request): Promise<UpdateApiResponse> => {
    const { user } = requireAuth(request);
    const { id } = parseOrThrow(idParamSchema, request.params);
    const patch = parseOrThrow(updateBody, request.body);
    return { api: await publishing.update(user, id, patch, clientIp(request)) };
  });

  app.delete('/:id', async (request): Promise<DeleteApiResponse> => {
    const { user } = requireAuth(request);
    const { id } = parseOrThrow(idParamSchema, request.params);
    await publishing.remove(user, id, clientIp(request));
    return { ok: true };
  });

  app.put('/:id/spec', async (request): Promise<UpdateApiSpecResponse> => {
    const { user } = requireAuth(request);
    const { id } = parseOrThrow(idParamSchema, request.params);
    const body = parseOrThrow(specBody, request.body);
    return publishing.updateSpec(user, id, body.spec, body.version, clientIp(request));
  });

  app.post('/:id/test-consumer', async (request, reply): Promise<CreateTestConsumerResponse> => {
    const { user } = requireAuth(request);
    const { id } = parseOrThrow(idParamSchema, request.params);
    const body = parseOrThrow(testConsumerBody, request.body ?? {});
    const result = await publishing.createTestConsumer(
      user,
      id,
      body.label ?? null,
      clientIp(request),
    );
    reply.status(201);
    return result;
  });
};
