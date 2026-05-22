import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole, type AuthenticatedUser } from '../auth/session.js';
import type { PublishingService } from '../api-publishing/service.js';
import { PublishInput, SettingsUpdate } from '../api-publishing/service.js';
import type { AccessRequestsService } from '../access-requests/service.js';
import { ApproveInput, DenyInput, RevokeInput } from '../access-requests/service.js';
import type { CatalogService } from '../api-catalog/service.js';
import type { GrantsService } from '../grants/service.js';
import type { CredentialsService } from '../credentials/service.js';
import { CredentialCreateInput as CredentialInputSchema } from '../credentials/service.js';
import type { MessagingService } from '../messaging/service.js';
import type { PolicyExceptionService } from '../governance/exception-service.js';
import type { NexusStore } from '../db/store.js';
import { auditActorFromRequest } from '../audit/service.js';

export async function registerProviderRoutes(
  app: FastifyInstance,
  opts: {
    publishing: PublishingService;
    catalog: CatalogService;
    accessRequests: AccessRequestsService;
    grants: GrantsService;
    credentials: CredentialsService;
    messaging: MessagingService;
    policyExceptions: PolicyExceptionService;
    store: NexusStore;
  },
): Promise<void> {
  const {
    publishing,
    catalog,
    accessRequests,
    grants,
    credentials,
    messaging,
    policyExceptions,
    store,
  } = opts;

  // OAS specs are the only large payloads we routinely accept. Allow up to
  // 10 MiB only on the publish + replace-spec endpoints; every other route
  // inherits the smaller default body limit.
  const SPEC_UPLOAD_LIMIT = { bodyLimit: 10 * 1024 * 1024 };

  app.get('/api/provider/apis', async (req, reply) => {
    const user = requireRole(req, 'provider', 'admin', 'super_admin');
    const { items, total } = await catalog.list({ providerId: user.id, limit: 200 });
    reply.send({ items, total });
  });

  app.post('/api/provider/apis', SPEC_UPLOAD_LIMIT, async (req, reply) => {
    const user = requireRole(req, 'provider', 'admin', 'super_admin');
    const input = PublishInput.parse(req.body);
    const asset = await publishing.publish({ providerId: user.id, input, actor: auditActorFromRequest(req) });
    reply.status(201).send({ asset });
  });

  app.post('/api/provider/governance/exceptions', async (req, reply) => {
    const user = requireRole(req, 'provider', 'admin', 'super_admin');
    const input = z
      .object({ pendingPublishId: z.string(), justification: z.string().min(10).max(4000) })
      .parse(req.body);
    const exception = await policyExceptions.requestException({
      providerId: user.id,
      pendingPublishId: input.pendingPublishId,
      justification: input.justification,
      actor: auditActorFromRequest(req),
    });
    reply.status(201).send({ exception });
  });

  app.get('/api/provider/governance/exceptions', async (req, reply) => {
    const user = requireRole(req, 'provider', 'admin', 'super_admin');
    reply.send({ exceptions: await policyExceptions.listForProvider(user.id) });
  });

  app.put('/api/provider/apis/:id/spec', SPEC_UPLOAD_LIMIT, async (req, reply) => {
    const user = requireRole(req, 'provider', 'admin', 'super_admin');
    const { id } = req.params as { id: string };
    const { rawSpec } = z.object({ rawSpec: z.string().min(1) }).parse(req.body);
    const asset = await publishing.replaceSpec({
      providerId: user.id,
      assetId: id,
      rawSpec,
      actor: auditActorFromRequest(req),
    });
    reply.send({ asset });
  });

  app.put('/api/provider/apis/:id/settings', async (req, reply) => {
    const user = requireRole(req, 'provider', 'admin', 'super_admin');
    const { id } = req.params as { id: string };
    const patch = SettingsUpdate.parse(req.body);
    const asset = await publishing.updateSettings({
      providerId: user.id,
      assetId: id,
      patch,
      actor: auditActorFromRequest(req),
    });
    reply.send({ asset });
  });

  app.delete('/api/provider/apis/:id', async (req, reply) => {
    const user = requireRole(req, 'provider', 'admin', 'super_admin');
    const { id } = req.params as { id: string };
    // Allow provider to delete only their own asset; admins handled in /api/admin.
    const asset = await store.apiAssets.findById(id);
    if (!asset || asset.provider_id !== user.id) {
      reply.status(404).send({ error: { code: 'not_found', message: 'Not found' } });
      return;
    }
    await publishing.deleteAsset({ actorId: user.id, assetId: id, actor: auditActorFromRequest(req) });
    reply.status(204).send();
  });

  app.get('/api/provider/apis/:id/access-requests', async (req, reply) => {
    const user = requireRole(req, 'provider', 'admin', 'super_admin');
    const { id } = req.params as { id: string };
    const all = await accessRequests.listForProvider(user.id);
    reply.send({ requests: all.filter((r) => r.apiAssetId === id) });
  });

  app.get('/api/provider/access-requests', async (req, reply) => {
    const user = requireRole(req, 'provider', 'admin', 'super_admin');
    const status = (req.query as { status?: string }).status as
      | 'pending'
      | 'approved'
      | 'denied'
      | undefined;
    const items = await accessRequests.listForProvider(user.id, status);
    reply.send({ requests: items });
  });

  app.post('/api/provider/access-requests/:id/approve', async (req, reply) => {
    const user = requireRole(req, 'provider', 'admin', 'super_admin');
    const { id } = req.params as { id: string };
    const { providerReason } = ApproveInput.parse(req.body ?? {});
    const result = await accessRequests.approve({
      providerId: user.id,
      requestId: id,
      providerReason: providerReason ?? null,
      actor: auditActorFromRequest(req),
    });
    reply.send(result);
  });

  app.post('/api/provider/access-requests/:id/deny', async (req, reply) => {
    const user = requireRole(req, 'provider', 'admin', 'super_admin');
    const { id } = req.params as { id: string };
    const { providerReason } = DenyInput.parse(req.body);
    const updated = await accessRequests.deny({
      providerId: user.id,
      requestId: id,
      providerReason,
      actor: auditActorFromRequest(req),
    });
    reply.send({ request: updated });
  });

  app.get('/api/provider/apis/:id/consumers', async (req, reply) => {
    const user = requireRole(req, 'provider', 'admin', 'super_admin');
    const { id } = req.params as { id: string };
    if (!(await canManageProviderAsset(user, id, store, true))) {
      reply.status(404).send({ error: { code: 'not_found', message: 'Not found' } });
      return;
    }
    const items = await grants.listForAsset(id);
    reply.send({ grants: items.filter((g) => g.status === 'active') });
  });

  app.post('/api/provider/grants/:id/revoke', async (req, reply) => {
    const user = requireRole(req, 'provider', 'admin', 'super_admin');
    const { id } = req.params as { id: string };
    const { reason } = RevokeInput.parse(req.body);
    await accessRequests.revoke({
      providerId: user.id,
      grantId: id,
      reason,
      actor: auditActorFromRequest(req),
    });
    reply.status(204).send();
  });

  app.post('/api/provider/test-credentials', async (req, reply) => {
    const user = requireRole(req, 'provider', 'admin', 'super_admin');
    const input = CredentialInputSchema.parse(req.body);
    const result = await credentials.issue({ userId: user.id, input, actor: auditActorFromRequest(req) });
    reply.status(201).send({ credential: result.metadata, secret: result.secret });
  });

  app.post('/api/provider/apis/:id/announce', async (req, reply) => {
    const user = requireRole(req, 'provider', 'admin', 'super_admin');
    const { id } = req.params as { id: string };
    if (!(await canManageProviderAsset(user, id, store, false))) {
      reply.status(404).send({ error: { code: 'not_found', message: 'Not found' } });
      return;
    }
    const { subject, body } = z
      .object({ subject: z.string().min(1).max(255), body: z.string().min(1).max(10_000) })
      .parse(req.body);
    const out = await messaging.broadcast({
      actorId: user.id,
      apiAssetId: id,
      subject,
      body,
    });
    reply.status(201).send(out);
  });
}

async function canManageProviderAsset(
  user: AuthenticatedUser,
  assetId: string,
  store: NexusStore,
  allowAdmin: boolean,
): Promise<boolean> {
  const asset = await store.apiAssets.findById(assetId);
  if (!asset) return false;
  return (
    asset.provider_id === user.id ||
    (allowAdmin && (user.roles.includes('admin') || user.roles.includes('super_admin')))
  );
}
