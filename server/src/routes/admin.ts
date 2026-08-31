/**
 * `/api/admin` — settings, email templates, mass email and the audit log.
 *
 * The whole plugin is behind `requireRole('admin')`; god-mode endpoints add a
 * `super_admin` check of their own (see the marked section at the bottom).
 * Secrets are write-only everywhere here: `smtp.password` and
 * `captcha.secret_key` go in and are never read back out.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import {
  EMAIL_TEMPLATE_KEYS,
  ROLE_ORDER,
  type AdminSettingsResponse,
  type GetEmailTemplateResponse,
  type ListAuditLogsResponse,
  type ListEmailTemplatesResponse,
  type MassEmailResponse,
  type SmtpTestResponse,
  type UpdateEmailTemplateResponse,
  type UpdateSettingsResponse,
} from '@ferrum-nexus/shared';

import type { MassEmailService } from '../admin/mass-email-service.js';
import type { SettingsService } from '../admin/settings-service.js';
import { AuditAction, type AuditService } from '../audit/service.js';
import type { AuditLogFilter } from '../db/store.js';
import type { EmailService } from '../email/service.js';
import { clientIp, requireAuth, requireRole } from '../middleware/auth-plugin.js';
import { parseOrThrow } from '../middleware/error-handler.js';
import { listOptions, listQuerySchema } from './common.js';

/** Services this route plugin needs. */
export interface AdminRoutesOptions {
  settings: SettingsService;
  massEmail: MassEmailService;
  email: EmailService;
  audit: AuditService;
}

/** Largest accepted logo, as a data URL. Roughly 384 KiB of binary. */
export const MAX_LOGO_DATA_URL_LENGTH = 512 * 1024;

const hexColor = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{3,8}$/, 'must be a CSS hex colour');

const updateSettingsBody = z.object({
  branding: z
    .object({
      portal_name: z.string().trim().min(1).max(120).optional(),
      logo_data_url: z
        .string()
        .trim()
        .max(MAX_LOGO_DATA_URL_LENGTH)
        .regex(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, 'must be a base64 image data URL')
        .nullish(),
      primary_color: hexColor.optional(),
      accent_color: hexColor.optional(),
      default_theme: z.enum(['dark', 'light', 'system']).optional(),
      tagline: z.string().trim().max(280).nullish(),
      support_email: z.string().trim().email().max(320).nullish(),
    })
    .optional(),
  captcha: z
    .object({
      enabled: z.boolean().optional(),
      provider: z.enum(['none', 'recaptcha', 'hcaptcha', 'turnstile']).optional(),
      site_key: z.string().trim().max(512).nullish(),
      secret_key: z.string().trim().max(512).nullish(),
    })
    .optional(),
  smtp: z
    .object({
      host: z.string().trim().max(255).nullish(),
      port: z.number().int().min(1).max(65_535).optional(),
      secure: z.boolean().optional(),
      username: z.string().trim().max(255).nullish(),
      password: z.string().max(1024).nullish(),
      from_address: z.string().trim().max(320).nullish(),
    })
    .optional(),
  registration: z
    .object({
      open_registration: z.boolean().optional(),
      require_email_verification: z.boolean().optional(),
      allowed_roles: z.array(z.enum(ROLE_ORDER)).max(4).optional(),
    })
    .optional(),
});

const smtpTestBody = z.object({ to_email: z.string().trim().email().max(320).optional() });

const templateKeyParams = z.object({ key: z.enum(EMAIL_TEMPLATE_KEYS) });

const updateTemplateBody = z.object({
  subject: z.string().trim().min(1).max(300),
  body_html: z.string().min(1).max(100_000),
  body_text: z.string().min(1).max(100_000),
});

const massEmailBody = z.object({
  subject: z.string().trim().min(1).max(300),
  body_html: z.string().max(100_000).optional(),
  body_text: z.string().max(100_000).optional(),
  audience: z.object({
    scope: z.enum(['all', 'filtered', 'explicit']),
    roles: z.array(z.enum(ROLE_ORDER)).max(4).optional(),
    status: z.enum(['active', 'disabled']).optional(),
    org_id: z.string().trim().min(1).max(64).optional(),
    user_ids: z.array(z.string().trim().min(1).max(64)).max(5_000).optional(),
  }),
  idempotency_key: z.string().trim().min(8).max(128).optional(),
});

const auditLogsQuery = listQuerySchema.extend({
  actor_user_id: z.string().trim().min(1).max(64).optional(),
  action: z.string().trim().max(120).optional(),
  target_type: z.string().trim().max(120).optional(),
  target_id: z.string().trim().max(120).optional(),
  from: z.string().trim().datetime().optional(),
  to: z.string().trim().datetime().optional(),
});

/** `/api/admin` route plugin. */
export const adminRoutes: FastifyPluginAsync<AdminRoutesOptions> = async (app, options) => {
  const { settings, massEmail, email, audit } = options;
  app.addHook('onRequest', requireRole('admin'));

  /* ── Settings ─────────────────────────────────────────────────────────── */

  app.get('/settings', async (): Promise<AdminSettingsResponse> => settings.getAdminSettings());

  app.put('/settings', async (request): Promise<UpdateSettingsResponse> => {
    const { user } = requireAuth(request);
    const patch = parseOrThrow(updateSettingsBody, request.body);
    return settings.updateSettings({ id: user.id, role: user.role }, patch, clientIp(request));
  });

  app.post('/settings/smtp-test', async (request): Promise<SmtpTestResponse> => {
    const { user } = requireAuth(request);
    const input = parseOrThrow(smtpTestBody, request.body ?? {});
    const to = input.to_email ?? user.email;
    const result = await email.sendTest(to);
    await audit.record(
      { id: user.id, role: user.role },
      AuditAction.ADMIN_SMTP_TEST,
      { type: 'settings', id: 'smtp' },
      { to_email: to, ok: result.ok },
      clientIp(request),
    );
    return result;
  });

  /* ── Email templates ──────────────────────────────────────────────────── */

  app.get('/email-templates', async (): Promise<ListEmailTemplatesResponse> =>
    settings.listEmailTemplates(),
  );

  app.get('/email-templates/:key', async (request): Promise<GetEmailTemplateResponse> => {
    const { key } = parseOrThrow(templateKeyParams, request.params);
    return settings.getEmailTemplate(key);
  });

  app.put('/email-templates/:key', async (request): Promise<UpdateEmailTemplateResponse> => {
    const { user } = requireAuth(request);
    const { key } = parseOrThrow(templateKeyParams, request.params);
    const body = parseOrThrow(updateTemplateBody, request.body);
    const template = await settings.upsertEmailTemplate(
      { id: user.id, role: user.role },
      key,
      body,
      clientIp(request),
    );
    return { template };
  });

  /* ── Mass email ───────────────────────────────────────────────────────── */

  app.post('/mass-email', async (request): Promise<MassEmailResponse> => {
    const { user } = requireAuth(request);
    const body = parseOrThrow(massEmailBody, request.body);
    return massEmail.send(
      { id: user.id, role: user.role },
      {
        ...body,
        body_html: body.body_html ?? '',
        body_text: body.body_text ?? '',
      },
      clientIp(request),
    );
  });

  /* ── Audit log ────────────────────────────────────────────────────────── */

  app.get('/audit-logs', async (request): Promise<ListAuditLogsResponse> => {
    const query = parseOrThrow(auditLogsQuery, request.query);
    const filter: AuditLogFilter = {
      ...(query.actor_user_id !== undefined ? { actor_user_id: query.actor_user_id } : {}),
      ...(query.action !== undefined ? { action: query.action } : {}),
      ...(query.target_type !== undefined ? { target_type: query.target_type } : {}),
      ...(query.target_id !== undefined ? { target_id: query.target_id } : {}),
      ...(query.from !== undefined ? { from: query.from } : {}),
      ...(query.to !== undefined ? { to: query.to } : {}),
    };
    return audit.list(filter, listOptions(query));
  });

  /* ── God mode (super_admin only) ───────────────────────────────────────
   * NOTE(gateway agent): register `POST /god/revoke-grant`, `/god/delete-api`,
   * `/god/disable-user` and `/god/broadcast` here. They live behind this
   * plugin's `admin` hook, so each handler must additionally call
   * `assertRole(request, 'super_admin')` (from `middleware/auth-plugin.js`),
   * take its services through {@link AdminRoutesOptions}, and audit with the
   * `AuditAction.GOD_*` actions.
   */
};
