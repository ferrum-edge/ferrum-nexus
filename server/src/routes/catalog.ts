/**
 * `/api/catalog` — the browse surface, readable by any signed-in account.
 *
 * Everything here is a `GET`; there is no mutation and therefore no CSRF
 * concern. The visibility policy lives entirely in the catalog service, which
 * answers `404` rather than `403` for an API the caller may not see, so the
 * catalog never confirms that an internal API exists.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import type {
  CatalogDetailResponse,
  CatalogListResponse,
  CatalogSpecResponse,
} from '@ferrum-nexus/shared';

import type { CatalogService } from '../catalog/service.js';
import { requireAuth, requireAuthHook } from '../middleware/auth-plugin.js';
import { parseOrThrow } from '../middleware/error-handler.js';
import { booleanQuerySchema, listOptions, listQuerySchema, toBoolean } from './common.js';

/** Services this route plugin needs. */
export interface CatalogRoutesOptions {
  catalog: CatalogService;
}

const catalogQuery = listQuerySchema.extend({
  q: z.string().trim().max(200).optional(),
  requestable: booleanQuerySchema,
  visibility: z.enum(['public', 'internal']).optional(),
  owner_user_id: z.string().trim().min(1).max(64).optional(),
});

const slugParams = z.object({ slug: z.string().trim().min(1).max(120) });

/** `/api/catalog` route plugin. */
export const catalogRoutes: FastifyPluginAsync<CatalogRoutesOptions> = async (app, options) => {
  const { catalog } = options;
  app.addHook('onRequest', requireAuthHook);

  app.get('/', async (request): Promise<CatalogListResponse> => {
    const { user } = requireAuth(request);
    const query = parseOrThrow(catalogQuery, request.query);
    const requestable = toBoolean(query.requestable);
    return catalog.list(
      user,
      {
        ...(query.q !== undefined ? { q: query.q } : {}),
        ...(requestable !== undefined ? { requestable } : {}),
        ...(query.visibility !== undefined ? { visibility: query.visibility } : {}),
        ...(query.owner_user_id !== undefined ? { owner_user_id: query.owner_user_id } : {}),
      },
      listOptions(query),
    );
  });

  app.get('/:slug', async (request): Promise<CatalogDetailResponse> => {
    const { user } = requireAuth(request);
    const { slug } = parseOrThrow(slugParams, request.params);
    return catalog.detail(user, slug);
  });

  app.get('/:slug/spec', async (request): Promise<CatalogSpecResponse> => {
    const { user } = requireAuth(request);
    const { slug } = parseOrThrow(slugParams, request.params);
    return catalog.spec(user, slug);
  });
};
