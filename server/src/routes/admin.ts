import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../auth/session.js';
import type { UsersService } from '../users/service.js';
import type { OrganizationsService } from '../organizations/service.js';
import { auditActorFromRequest, type AuditService } from '../audit/service.js';
import type { SettingsService } from '../admin/settings-service.js';
import type { MassEmailService } from '../admin/mass-email-service.js';
import type { DriftService } from '../drift/service.js';
import type { PublishingService } from '../api-publishing/service.js';
import type { AccessRequestsService } from '../access-requests/service.js';
import type { CatalogService } from '../api-catalog/service.js';
import type { NexusStore } from '../db/store.js';
import {
  BrandingInput,
  CaptchaInput,
  SenderInput,
  RegistrationInput,
} from '../admin/settings-service.js';
import { MassEmailInput } from '../admin/mass-email-service.js';
import { USER_ROLES, type UserRole } from '@ferrum-nexus/shared';
import { badRequest } from '../lib/errors.js';

const requireAdmin = (req: FastifyRequest) => requireRole(req, 'admin', 'super_admin');
const requireSuperAdmin = (req: FastifyRequest) => requireRole(req, 'super_admin');

export async function registerAdminRoutes(
  app: FastifyInstance,
  opts: {
    users: UsersService;
    organizations: OrganizationsService;
    audit: AuditService;
    settings: SettingsService;
    massEmail: MassEmailService;
    drift: DriftService;
    publishing: PublishingService;
    accessRequests: AccessRequestsService;
    catalog: CatalogService;
    store: NexusStore;
  },
): Promise<void> {
  const {
    users,
    organizations,
    audit,
    settings,
    massEmail,
    drift,
    publishing,
    accessRequests,
    catalog,
    store,
  } = opts;

  app.get('/api/admin/users', async (req, reply) => {
    requireAdmin(req);
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).optional(),
        offset: z.coerce.number().int().min(0).optional(),
        search: z.string().optional(),
      })
      .parse(req.query);
    const { rows, total } = await store.users.list(q);
    const enriched = await Promise.all(
      rows.map(async (row) => {
        const roles = await store.userRoles.forUser(row.id);
        return users.toPortalUser(row, roles);
      }),
    );
    reply.send({ users: await Promise.all(enriched), total });
  });

  app.put('/api/admin/users/:id/status', async (req, reply) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    const { status } = z
      .object({ status: z.enum(['pending', 'active', 'disabled']) })
      .parse(req.body);
    if (status === 'disabled') await ensureNotLastActiveSuperAdmin(id, store);
    const user = await users.setStatus(id, status);
    await audit.record(req, {
      action: 'admin.user_status',
      targetType: 'user',
      targetId: id,
      after: { status },
    });
    reply.send({ user });
  });

  app.put('/api/admin/users/:id/roles', async (req, reply) => {
    requireSuperAdmin(req);
    const { id } = req.params as { id: string };
    const { roles } = z
      .object({ roles: z.array(z.enum(USER_ROLES)).min(1) })
      .parse(req.body);
    await ensureNotRemovingLastSuperAdmin(id, roles as UserRole[], store);
    const user = await users.setRoles(id, roles as UserRole[]);
    await audit.record(req, {
      action: 'admin.user_roles',
      targetType: 'user',
      targetId: id,
      after: { roles },
    });
    reply.send({ user });
  });

  app.get('/api/admin/organizations', async (req, reply) => {
    requireAdmin(req);
    reply.send({ organizations: await organizations.list() });
  });

  app.post('/api/admin/organizations', async (req, reply) => {
    requireAdmin(req);
    const input = z
      .object({ name: z.string().min(1), domain: z.string().optional() })
      .parse(req.body);
    const org = await organizations.create(input);
    await audit.record(req, { action: 'admin.org_create', targetType: 'organization', targetId: org.id });
    reply.status(201).send({ organization: org });
  });

  app.get('/api/admin/settings', async (req, reply) => {
    requireAdmin(req);
    reply.send(await settings.full());
  });

  app.put('/api/admin/settings/branding', async (req, reply) => {
    requireAdmin(req);
    const branding = await settings.setBranding(BrandingInput.parse(req.body));
    await audit.record(req, { action: 'admin.branding_update', targetType: 'settings', after: branding });
    reply.send({ branding });
  });

  app.put('/api/admin/settings/captcha', async (req, reply) => {
    requireAdmin(req);
    const captcha = await settings.setCaptcha(CaptchaInput.parse(req.body));
    await audit.record(req, { action: 'admin.captcha_update', targetType: 'settings', after: captcha });
    reply.send({ captcha });
  });

  app.put('/api/admin/settings/sender', async (req, reply) => {
    requireAdmin(req);
    await settings.setSender(SenderInput.parse(req.body));
    await audit.record(req, { action: 'admin.sender_update', targetType: 'settings' });
    reply.status(204).send();
  });

  app.put('/api/admin/settings/registration', async (req, reply) => {
    requireAdmin(req);
    await settings.setRegistration(RegistrationInput.parse(req.body));
    await audit.record(req, { action: 'admin.registration_update', targetType: 'settings' });
    reply.status(204).send();
  });

  app.get('/api/admin/audit-logs', async (req, reply) => {
    requireAdmin(req);
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(500).optional(),
        offset: z.coerce.number().int().min(0).optional(),
        action: z.string().optional(),
        actorId: z.string().optional(),
      })
      .parse(req.query);
    const { rows, total } = await audit.list(q);
    reply.send({ entries: rows, total });
  });

  app.post('/api/admin/mass-email', async (req, reply) => {
    const user = requireAdmin(req);
    const input = MassEmailInput.parse(req.body);
    const out = await massEmail.send({ actorId: user.id, input });
    await audit.record(req, {
      action: 'admin.mass_email',
      targetType: 'mass_email',
      targetId: out.campaignId,
      after: { queued: out.queued, filter: input.filter },
    });
    reply.status(201).send(out);
  });

  app.get('/api/admin/mass-email', async (req, reply) => {
    requireAdmin(req);
    reply.send({ campaigns: await massEmail.list() });
  });

  // Dead-letter view: messages that hit the max attempt count and stopped
  // retrying. Admins can inspect the last error and either re-queue or leave
  // the row in place pending a fix to the underlying delivery issue.
  app.get('/api/admin/email/failed', async (req, reply) => {
    requireAdmin(req);
    const { limit, offset } = z
      .object({
        limit: z.coerce.number().int().positive().max(200).default(50),
        offset: z.coerce.number().int().nonnegative().default(0),
      })
      .parse(req.query ?? {});
    const result = await store.email.listFailed({ limit, offset });
    reply.send(result);
  });

  app.post('/api/admin/email/failed/:id/requeue', async (req, reply) => {
    const actor = requireAdmin(req);
    const { id } = req.params as { id: string };
    const requeued = await store.email.requeue(id);
    if (!requeued) {
      reply.status(404).send({ error: { code: 'not_found', message: 'Not found or not failed' } });
      return;
    }
    await audit.record(req, {
      action: 'admin.email_requeue',
      targetType: 'email_outbox',
      targetId: id,
      after: { actorId: actor.id },
    });
    reply.status(202).send({ ok: true });
  });

  app.get('/api/admin/drift', async (req, reply) => {
    requireAdmin(req);
    const { namespace } = (req.query ?? {}) as { namespace?: string };
    reply.send(await drift.detect({ namespace }));
  });

  app.post('/api/admin/drift/sync', async (req, reply) => {
    requireAdmin(req);
    const { namespace } = (req.query ?? {}) as { namespace?: string };
    const result = await publishing.syncFromEdge({ namespace });
    await audit.record(req, { action: 'admin.drift_sync', targetType: 'gateway', after: result });
    reply.send(result);
  });

  app.post('/api/admin/imports/api-spec', async (req, reply) => {
    const user = requireAdmin(req);
    const { specId, namespace, ownerId } = z
      .object({ specId: z.string(), namespace: z.string().optional(), ownerId: z.string() })
      .parse(req.body);
    const asset = await publishing.importFromEdge({
      ownerId,
      specId,
      namespace,
      actor: auditActorFromRequest(req),
    });
    await audit.record(req, {
      action: 'admin.import_api',
      targetType: 'api_asset',
      targetId: asset.id,
      after: { actorId: user.id },
    });
    reply.status(201).send({ asset });
  });

  app.get('/api/admin/apis', async (req, reply) => {
    requireAdmin(req);
    const { items, total } = await catalog.list({ limit: 200 });
    reply.send({ items, total });
  });

  app.delete('/api/admin/god-mode/apis/:id', async (req, reply) => {
    const user = requireSuperAdmin(req);
    const { id } = req.params as { id: string };
    const { reason } = z.object({ reason: z.string().min(1) }).parse(req.body ?? {});
    await publishing.deleteAsset({ actorId: user.id, assetId: id, actor: auditActorFromRequest(req) });
    await audit.record(req, {
      action: 'admin.god_delete_api',
      targetType: 'api_asset',
      targetId: id,
      reason,
    });
    reply.status(204).send();
  });

  app.post('/api/admin/god-mode/grants/:id/revoke', async (req, reply) => {
    const user = requireSuperAdmin(req);
    const { id } = req.params as { id: string };
    const { reason } = z.object({ reason: z.string().min(1) }).parse(req.body);
    await accessRequests.godRevoke({
      actorId: user.id,
      grantId: id,
      reason,
      actor: auditActorFromRequest(req),
    });
    reply.status(204).send();
  });

  app.post('/api/admin/god-mode/users/:id/disable', async (req, reply) => {
    requireSuperAdmin(req);
    const { id } = req.params as { id: string };
    const { reason } = z.object({ reason: z.string().min(1) }).parse(req.body);
    await ensureNotLastActiveSuperAdmin(id, store);
    const user = await users.setStatus(id, 'disabled');
    await audit.record(req, {
      action: 'admin.god_disable_user',
      targetType: 'user',
      targetId: id,
      reason,
    });
    reply.send({ user });
  });
}

async function ensureNotRemovingLastSuperAdmin(
  targetUserId: string,
  nextRoles: UserRole[],
  store: NexusStore,
): Promise<void> {
  if (nextRoles.includes('super_admin')) return;
  const currentRoles = await store.userRoles.forUser(targetUserId);
  if (!currentRoles.includes('super_admin')) return;
  await ensureMoreThanOneActiveSuperAdmin(targetUserId, store);
}

async function ensureNotLastActiveSuperAdmin(
  targetUserId: string,
  store: NexusStore,
): Promise<void> {
  const currentRoles = await store.userRoles.forUser(targetUserId);
  if (!currentRoles.includes('super_admin')) return;
  await ensureMoreThanOneActiveSuperAdmin(targetUserId, store);
}

async function ensureMoreThanOneActiveSuperAdmin(
  targetUserId: string,
  store: NexusStore,
): Promise<void> {
  const { rows } = await store.users.list({ limit: 10_000 });
  let activeSuperAdmins = 0;
  for (const row of rows) {
    if (row.status === 'disabled') continue;
    const roles = await store.userRoles.forUser(row.id);
    if (roles.includes('super_admin')) activeSuperAdmins++;
  }
  if (activeSuperAdmins <= 1) {
    throw badRequest(
      'last_super_admin',
      `Cannot remove or disable the last active super_admin (${targetUserId})`,
    );
  }
}
