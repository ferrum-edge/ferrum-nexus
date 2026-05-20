import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CatalogService } from '../api-catalog/service.js';
import type { AccessRequestsService } from '../access-requests/service.js';
import type { ApiAssetRow, NexusStore } from '../db/store.js';
import { requireAuth, requireRole, type AuthenticatedUser } from '../auth/session.js';
import { RequestInput } from '../access-requests/service.js';
import { notFound } from '../lib/errors.js';

export async function registerCatalogRoutes(
  app: FastifyInstance,
  opts: {
    catalog: CatalogService;
    accessRequests: AccessRequestsService;
    store: NexusStore;
  },
): Promise<void> {
  const { catalog, accessRequests, store } = opts;

  app.get('/api/catalog/apis', async (req, reply) => {
    const auth = requireAuth(req);
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).optional(),
        offset: z.coerce.number().int().min(0).optional(),
        search: z.string().optional(),
      })
      .parse(req.query);
    const isAdmin = hasAdminRole(auth);
    const { items, total } = await catalog.list({
      ...q,
      visibility: isAdmin ? undefined : 'public',
    });
    reply.send({ items, total });
  });

  app.get('/api/catalog/apis/:id', async (req, reply) => {
    const user = requireAuth(req);
    const { id } = req.params as { id: string };
    await requireVisibleAsset(user, id, store);
    const asset = await catalog.get(id);
    reply.send({ asset });
  });

  app.get('/api/catalog/apis/:id/spec', async (req, reply) => {
    const user = requireAuth(req);
    const { id } = req.params as { id: string };
    await requireVisibleAsset(user, id, store);
    const latest = await store.apiSpecVersions.latestForAsset(id);
    reply.send({ assetId: id, version: latest?.version, rawSpec: latest?.raw_spec ?? null });
  });

  app.post('/api/catalog/apis/:id/access-requests', async (req, reply) => {
    const user = requireRole(req, 'client', 'provider', 'admin', 'super_admin');
    const { id } = req.params as { id: string };
    const input = RequestInput.parse(req.body);
    await requireVisibleAsset(user, id, store);
    const userRow = await store.users.findById(user.id);
    const request = await accessRequests.create({
      clientUserId: user.id,
      clientEmail: user.email,
      clientName: userRow?.name ?? null,
      apiAssetId: id,
      justification: input.justification,
    });
    reply.status(201).send({ request });
  });
}

function hasAdminRole(user: AuthenticatedUser): boolean {
  return user.roles.includes('admin') || user.roles.includes('super_admin');
}

async function requireVisibleAsset(
  user: AuthenticatedUser,
  assetId: string,
  store: NexusStore,
): Promise<ApiAssetRow> {
  const asset = await store.apiAssets.findById(assetId);
  if (!asset) throw notFound('API asset not found');
  if (hasAdminRole(user) || asset.provider_id === user.id || asset.visibility !== 'private') {
    return asset;
  }
  const grants = await store.grants.listForClient(user.id);
  const hasActiveGrant = grants.some(
    (grant) => grant.api_asset_id === asset.id && grant.status === 'active',
  );
  if (!hasActiveGrant) throw notFound('API asset not found');
  return asset;
}
