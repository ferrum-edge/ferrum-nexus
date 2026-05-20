import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CatalogService } from '../api-catalog/service.js';
import type { AccessRequestsService } from '../access-requests/service.js';
import type { NexusStore } from '../db/store.js';
import { requireAuth, requireRole } from '../auth/session.js';
import { RequestInput } from '../access-requests/service.js';

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
    // Clients see internal+public; providers see their own + internal+public.
    const isProvider = auth.roles.includes('provider');
    const visibility = auth.roles.includes('admin') || auth.roles.includes('super_admin') ? undefined : 'public';
    const { items, total } = await catalog.list({
      ...q,
      visibility: isProvider ? undefined : visibility,
    });
    reply.send({ items, total });
  });

  app.get('/api/catalog/apis/:id', async (req, reply) => {
    requireAuth(req);
    const { id } = req.params as { id: string };
    const asset = await catalog.get(id);
    reply.send({ asset });
  });

  app.get('/api/catalog/apis/:id/spec', async (req, reply) => {
    requireAuth(req);
    const { id } = req.params as { id: string };
    const asset = await store.apiAssets.findById(id);
    if (!asset) {
      reply.status(404).send({ error: { code: 'not_found', message: 'Not found' } });
      return;
    }
    const latest = await store.apiSpecVersions.latestForAsset(id);
    reply.send({ assetId: id, version: latest?.version, rawSpec: latest?.raw_spec ?? null });
  });

  app.post('/api/catalog/apis/:id/access-requests', async (req, reply) => {
    const user = requireRole(req, 'client', 'provider', 'admin', 'super_admin');
    const { id } = req.params as { id: string };
    const input = RequestInput.parse(req.body);
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
