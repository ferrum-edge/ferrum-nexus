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

import {
  ACCOUNT_IDENTITY_SCOPE,
  type CatalogDetailResponse,
  type CatalogIdentityAccessResponse,
  type CatalogListResponse,
  type CatalogSpecResponse,
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
  visibility: z.enum(['public', 'internal', 'private']).optional(),
  owner_user_id: z.string().trim().min(1).max(64).optional(),
});

const slugParams = z.object({ slug: z.string().trim().min(1).max(120) });

const identityAccessQuery = z.object({
  /**
   * One of the caller's applications, or the literal `account` (and the
   * default) for the account itself. A sentinel, as on the credential list,
   * because a query string has no `null`.
   */
  application_id: z.string().trim().min(1).max(64).optional(),
});

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

  /**
   * One identity's request and grant on this API — what decides whether the
   * access form offers a new request for that identity. Authorization is the
   * detail page's, plus ownership of the application named.
   */
  app.get('/:slug/access', async (request): Promise<CatalogIdentityAccessResponse> => {
    const { user } = requireAuth(request);
    const { slug } = parseOrThrow(slugParams, request.params);
    const query = parseOrThrow(identityAccessQuery, request.query);
    const applicationId =
      query.application_id === undefined || query.application_id === ACCOUNT_IDENTITY_SCOPE
        ? null
        : query.application_id;
    return catalog.identityAccess(user, slug, applicationId);
  });

  app.get('/:slug/spec', async (request): Promise<CatalogSpecResponse> => {
    const { user } = requireAuth(request);
    const { slug } = parseOrThrow(slugParams, request.params);
    return catalog.spec(user, slug);
  });
};
