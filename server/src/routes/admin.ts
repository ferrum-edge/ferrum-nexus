/**
 * `/api/admin` — settings, email templates, mass email and the audit log.
 *
 * The whole plugin is behind `requireRole('admin')`; god-mode endpoints add a
 * `super_admin` check of their own (see the marked section at the bottom), and
 * so do the `smtp`/`captcha` sections of `PUT /settings`, which are escalation
 * surfaces rather than preferences. Secrets are write-only everywhere here:
 * `smtp.password` and `captcha.secret_key` go in and are never read back out.
 *
 * A `captcha` section that turns the challenge on, or moves it, also has to
 * carry a `captcha_token` the new configuration accepts — the settings service
 * verifies it with the vendor before storing anything, so a portal cannot adopt
 * a challenge it is unable to check and lock every account out of sign-in.
 *
 * `POST /settings/smtp-test` sends straight through the relay, outside the
 * outbox, so it is bounded on its own: an `admin` may probe only their own
 * address, a `super_admin` any address, each within an hourly budget and a
 * per-minute limiter.
 *
 * The two `/gateway/*` endpoints raise the bar the same way: one reports which
 * of the portal's stored Ferrum Edge references the gateway no longer holds,
 * the other recreates them. Both name accounts and APIs and both exist for the
 * cutover case — a retargeted or rebuilt gateway — so neither is an `admin`
 * operation.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import {
  EMAIL_TEMPLATE_KEYS,
  LOGIN_POLICIES,
  MAX_BRANDING_FOOTER_LINKS,
  MAX_BRANDING_FOOTER_TEXT_LENGTH,
  MAX_BRANDING_LINK_LABEL_LENGTH,
  normalizeBrandingHexColor,
  ROLE_ORDER,
  type AdminSettingsResponse,
  type GetEmailTemplateResponse,
  type GodBroadcastResponse,
  type GodDeleteApiResponse,
  type GodDisableUserResponse,
  type GodRevokeGrantResponse,
  type ListAuditLogsResponse,
  type ListEmailTemplatesResponse,
  type MassEmailResponse,
  type ReconcileCredentialsResponse,
  type ReconcileGatewayResponse,
  type RepairGatewayReferencesResponse,
  type SmtpTestResponse,
  type SsoAdminSettingsResponse,
  type UpdateEmailTemplateResponse,
  type UpdateSettingsRequest,
  type UpdateSettingsResponse,
  type UpdateSsoSettingsRequest,
  type UpdateSsoSettingsResponse,
} from '@ferrum-nexus/shared';

import type { GatewayReconciliationService } from '../admin/gateway-reconciliation.js';
import type { GodService } from '../admin/god-service.js';
import type { MassEmailService } from '../admin/mass-email-service.js';
import type { SettingsService } from '../admin/settings-service.js';
import type { SmtpTestService } from '../admin/smtp-test-service.js';
import { AuditAction, type AuditService } from '../audit/service.js';
import { CREDENTIAL_TYPES, type CredentialsService } from '../credentials/service.js';
import type { AuditLogFilter } from '../db/store.js';
import { assertRole, clientIp, requireAuth, requireRole } from '../middleware/auth-plugin.js';
import { parseOrThrow } from '../middleware/error-handler.js';
import {
  MAX_ALLOWED_EMAIL_DOMAINS,
  MAX_CLIENT_SECRET_LENGTH,
  MAX_SSO_PROVIDERS,
  ssoProviderSettingsShape,
} from '../sso/config.js';
import type { SsoService } from '../sso/service.js';
import { listOptions, listQuerySchema } from './common.js';

/** Services this route plugin needs. */
export interface AdminRoutesOptions {
  settings: SettingsService;
  massEmail: MassEmailService;
  smtpTest: SmtpTestService;
  audit: AuditService;
  god: GodService;
  credentials: CredentialsService;
  reconciliation: GatewayReconciliationService;
  sso: SsoService;
}

/**
 * Per-account burst limit on `POST /settings/smtp-test`, applied when
 * `NEXUS_RATE_LIMIT_ENABLED` is on. The probe contacts the SMTP relay directly,
 * outside the outbox; the hourly budget in the SMTP-test service, which counts
 * durable rows, bounds the hour. In-memory, so N instances allow N × this.
 */
export const SMTP_TEST_RATE_LIMIT = { max: 3, timeWindow: '1 minute' } as const;

/**
 * Per-account burst limit on `POST /mass-email`. Generous enough for retries
 * with the same `idempotency_key`; the per-campaign ceilings and the daily
 * campaign budget are what bound the cost.
 */
export const MASS_EMAIL_RATE_LIMIT = { max: 10, timeWindow: '1 minute' } as const;

/** Largest accepted logo, as a data URL. Roughly 384 KiB of binary. */
export const MAX_LOGO_DATA_URL_LENGTH = 512 * 1024;

/**
 * Opaque `#rgb` / `#rrggbb` only. The native colour swatch and derived palette
 * cannot render alpha, so 4- and 8-digit CSS hex values are refused rather than
 * stripped. Five- and seven-digit strings are not CSS colours. Accepted values
 * are stored as lowercase `#rrggbb`.
 */
const hexColor = z
  .string()
  .trim()
  .transform((value, ctx) => {
    const normalized = normalizeBrandingHexColor(value);
    if (normalized === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'must be a CSS hex colour (#rgb or #rrggbb)',
      });
      return z.NEVER;
    }
    return normalized;
  });

const updateSettingsBody: z.ZodType<UpdateSettingsRequest> = z
  .object({
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
        radius: z.enum(['none', 'sm', 'md', 'lg']).optional(),
        font_preset: z.enum(['system', 'inter', 'manrope']).optional(),
        sidebar_style: z.enum(['surface', 'contrast']).optional(),
        login_layout: z.enum(['split', 'centered']).optional(),
        footer_text: z.string().trim().max(MAX_BRANDING_FOOTER_TEXT_LENGTH).nullish(),
        // Rendered as anchors on the unauthenticated sign-in page, so the scheme
        // is pinned to http(s): a stored `javascript:` URL would be an XSS.
        footer_links: z
          .array(
            z
              .object({
                label: z.string().trim().min(1).max(MAX_BRANDING_LINK_LABEL_LENGTH),
                url: z
                  .string()
                  .trim()
                  .max(2048)
                  .url()
                  .refine((url) => /^https?:\/\//i.test(url), 'must be an http(s) URL'),
              })
              .strict(),
          )
          .max(MAX_BRANDING_FOOTER_LINKS)
          .optional(),
      })
      .strict()
      .optional(),
    captcha: z
      .object({
        enabled: z.boolean().optional(),
        provider: z.enum(['none', 'recaptcha', 'hcaptcha', 'turnstile']).optional(),
        site_key: z.string().trim().max(512).nullish(),
        secret_key: z.string().trim().max(512).nullish(),
        // The activation self-test's token, bounded like the login one. The
        // service decides when it is required and verifies it against the
        // configuration this patch describes.
        captcha_token: z.string().max(4096).optional(),
      })
      .strict()
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
      .strict()
      .optional(),
    registration: z
      .object({
        open_registration: z.boolean().optional(),
        require_email_verification: z.boolean().optional(),
        allowed_roles: z.array(z.enum(ROLE_ORDER)).max(4).optional(),
      })
      .strict()
      .optional(),
    // Only length is checked here; the settings service owns the origin rule and
    // the normalisation, so a caller cannot store a path or a credential pair.
    gateway: z
      .object({ public_url: z.string().trim().max(2048).nullish() })
      .strict()
      .optional(),
  })
  .strict();

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
  from: z
    .string()
    .trim()
    .datetime()
    .transform((value) => new Date(value).toISOString())
    .describe('UTC timestamp normalized to milliseconds before comparison')
    .optional(),
  to: z
    .string()
    .trim()
    .datetime()
    .transform((value) => new Date(value).toISOString())
    .describe('UTC timestamp normalized to milliseconds before comparison')
    .optional(),
});

/* ── God-mode bodies ──────────────────────────────────────────────────────
 * `reason` is required and non-empty on all four: an emergency action without
 * a recorded justification is exactly the kind of thing the audit log exists to
 * make impossible.
 */

const godReason = z.string().trim().min(1).max(2_000);

const reconcileCredentialsBody = z.object({
  consumer_id: z.string().trim().min(1).max(128),
  credential_type: z.enum(CREDENTIAL_TYPES),
  reason: z.string().trim().max(500).nullish(),
});

/** Whether a gateway repair body names at least one explicit target. */
function namesRepairTargets(body: { user_ids?: string[]; api_ids?: string[] }): boolean {
  return (body.user_ids?.length ?? 0) > 0 || (body.api_ids?.length ?? 0) > 0;
}

/**
 * At least one of `all`, `user_ids` and `api_ids` is required — an empty body
 * would otherwise read as either "repair everything" or "repair nothing", and
 * the first of those is not a thing to guess at. The id lists are capped the
 * way the audience selectors are.
 */
const repairGatewayBody = z
  .object({
    user_ids: z.array(z.string().trim().min(1).max(64)).max(1_000).optional(),
    api_ids: z.array(z.string().trim().min(1).max(64)).max(1_000).optional(),
    all: z.boolean().optional(),
    reason: z.string().trim().max(500).nullish(),
  })
  .refine((value) => value.all === true || namesRepairTargets(value), {
    message: 'Provide account ids, API ids, or all: true',
  });

const godRevokeGrantBody = z.object({
  grant_id: z.string().trim().min(1).max(64),
  reason: godReason,
});

const godDeleteApiBody = z.object({
  api_id: z.string().trim().min(1).max(64),
  reason: godReason,
  revoke_grants: z.boolean().optional(),
});

const godDisableUserBody = z.object({
  user_id: z.string().trim().min(1).max(64),
  reason: godReason,
  revoke_grants: z.boolean().optional(),
});

const godBroadcastBody = z.object({
  subject: z.string().trim().min(1).max(300),
  body: z.string().trim().min(1).max(20_000),
  audience: z.object({
    scope: z.enum(['all', 'filtered', 'explicit']),
    roles: z.array(z.enum(ROLE_ORDER)).max(4).optional(),
    status: z.enum(['active', 'disabled']).optional(),
    org_id: z.string().trim().min(1).max(64).optional(),
    user_ids: z.array(z.string().trim().min(1).max(64)).max(5_000).optional(),
  }),
  send_email: z.boolean().optional(),
  idempotency_key: z.string().trim().min(8).max(128).optional(),
});

/**
 * `PUT /admin/sso`. The provider shape is the one `NEXUS_OIDC_PROVIDERS` is
 * validated against (`sso/config.ts`), plus the write-only secret; the
 * service checks issuers, organizations and the provider count.
 */
const updateSsoBody: z.ZodType<UpdateSsoSettingsRequest> = z
  .object({
    policy: z.enum(LOGIN_POLICIES).optional(),
    allowed_email_domains: z
      .array(z.string().trim().min(1).max(253))
      .max(MAX_ALLOWED_EMAIL_DOMAINS)
      .optional(),
    deprovision_on_access_loss: z.boolean().optional(),
    providers: z
      .array(
        z
          .object({
            ...ssoProviderSettingsShape,
            client_secret: z.string().min(1).max(MAX_CLIENT_SECRET_LENGTH).nullish(),
          })
          .strict(),
      )
      .max(MAX_SSO_PROVIDERS)
      .optional(),
  })
  .strict();

/** `/api/admin` route plugin. */
export const adminRoutes: FastifyPluginAsync<AdminRoutesOptions> = async (app, options) => {
  const { settings, massEmail, smtpTest, audit, god, credentials, reconciliation, sso } = options;
  app.addHook('onRequest', requireRole('admin'));

  /* ── Settings ─────────────────────────────────────────────────────────── */

  app.get('/settings', async (): Promise<AdminSettingsResponse> => settings.getAdminSettings());

  app.put('/settings', async (request): Promise<UpdateSettingsResponse> => {
    const { user } = requireAuth(request);
    const patch = parseOrThrow(updateSettingsBody, request.body);
    // Branding and registration policy are `admin`; the `smtp`, `captcha`, and
    // `gateway` sections need `super_admin`, enforced by the service so the rule
    // holds wherever `updateSettings` is called from.
    return settings.updateSettings({ id: user.id, role: user.role }, patch, clientIp(request));
  });

  /* ── Single sign-on ───────────────────────────────────────────────────── */

  // Readable by any admin — client secrets are never part of it. Writable by
  // a super admin only (the service enforces it): the role mappings decide
  // who becomes an admin.
  app.get('/sso', async (): Promise<SsoAdminSettingsResponse> => sso.getAdminSettings());

  app.put('/sso', async (request): Promise<UpdateSsoSettingsResponse> => {
    const { user } = assertRole(request, 'super_admin');
    const patch = parseOrThrow(updateSsoBody, request.body);
    return sso.updateAdminSettings({ id: user.id, role: user.role }, patch, clientIp(request));
  });

  // An `admin` may probe only their own address; another recipient needs
  // `super_admin`. The service enforces it, with the hourly budget, and
  // commits the audit row before the relay is contacted.
  app.post(
    '/settings/smtp-test',
    { config: { rateLimit: { ...SMTP_TEST_RATE_LIMIT } } },
    async (request): Promise<SmtpTestResponse> => {
      const { user } = requireAuth(request);
      const input = parseOrThrow(smtpTestBody, request.body ?? {});
      return smtpTest.send(
        { id: user.id, role: user.role, email: user.email },
        input.to_email,
        clientIp(request),
      );
    },
  );

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

  app.post(
    '/mass-email',
    { config: { rateLimit: { ...MASS_EMAIL_RATE_LIMIT } } },
    async (request): Promise<MassEmailResponse> => {
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
    },
  );

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

  /* ── Credential reconciliation ────────────────────────────────────────── */

  /**
   * Empty one credential type on a gateway consumer, on both sides. The repair
   * for a consumer whose credential positions can no longer be trusted; see
   * `docs/operations.md` §12. Destructive by design — every live credential of
   * that type stops working — so it is admin-only and audited.
   */
  app.post('/credentials/reconcile', async (request): Promise<ReconcileCredentialsResponse> => {
    const { user } = requireAuth(request);
    const body = parseOrThrow(reconcileCredentialsBody, request.body);
    return credentials.reconcile(
      user,
      {
        consumerId: body.consumer_id,
        credentialType: body.credential_type,
        reason: body.reason ?? null,
      },
      clientIp(request),
    );
  });

  /* ── Gateway reference reconciliation ─────────────────────────────────── */

  /**
   * Check whether the gateway still holds the consumer and proxy ids the portal
   * stored, and cache the answer for `/api/health`.
   *
   * `super_admin` rather than `admin`: the report names every account and API
   * whose gateway object is missing, and it is the reconnaissance step of a
   * repair that recreates gateway identities. A `POST` because it costs one
   * Admin API read per stored reference — this is not something a dashboard
   * should be able to poll.
   */
  app.post('/gateway/reconcile', async (request): Promise<ReconcileGatewayResponse> => {
    const { user } = assertRole(request, 'super_admin');
    const report = await reconciliation.scan();
    await audit.record(
      { id: user.id, role: user.role },
      AuditAction.GATEWAY_RECONCILE,
      { type: 'gateway', id: report.namespace },
      {
        status: report.status,
        checked_consumers: report.consumers.checked,
        orphaned_consumers: report.consumers.orphaned,
        checked_proxies: report.proxies.checked,
        orphaned_proxies: report.proxies.orphaned,
        complete: report.consumers.complete && report.proxies.complete,
        ...(report.error === null ? {} : { error: report.error }),
      },
      clientIp(request),
    );
    return report;
  });

  /**
   * Re-link the references a fresh pass finds orphaned: recreate the missing
   * gateway consumers, clear the dead proxy ids. `super_admin` only, audited
   * per account and per API by the service. See `docs/operations.md` §13.
   */
  app.post('/gateway/repair', async (request): Promise<RepairGatewayReferencesResponse> => {
    const { user } = assertRole(request, 'super_admin');
    const body = parseOrThrow(repairGatewayBody, request.body);
    return reconciliation.repair(
      user,
      {
        ...(body.user_ids === undefined ? {} : { userIds: body.user_ids }),
        ...(body.api_ids === undefined ? {} : { apiIds: body.api_ids }),
        ...(body.all === undefined ? {} : { all: body.all }),
        reason: body.reason ?? null,
      },
      clientIp(request),
    );
  });

  /* ── God mode (super_admin only) ───────────────────────────────────────
   * These four sit behind the plugin's `admin` hook and then raise the bar to
   * `super_admin` per handler. Every one of them demands a non-empty `reason`,
   * which the god service writes into the `god.*` audit row alongside the
   * ordinary audit row the underlying operation produces.
   */

  app.post('/god/revoke-grant', async (request): Promise<GodRevokeGrantResponse> => {
    const { user } = assertRole(request, 'super_admin');
    const body = parseOrThrow(godRevokeGrantBody, request.body);
    return { grant: await god.revokeGrant(user, body.grant_id, body.reason, clientIp(request)) };
  });

  app.post('/god/delete-api', async (request): Promise<GodDeleteApiResponse> => {
    const { user } = assertRole(request, 'super_admin');
    const body = parseOrThrow(godDeleteApiBody, request.body);
    return god.deleteApi(
      user,
      body.api_id,
      body.reason,
      body.revoke_grants ?? false,
      clientIp(request),
    );
  });

  app.post('/god/disable-user', async (request): Promise<GodDisableUserResponse> => {
    const { user } = assertRole(request, 'super_admin');
    const body = parseOrThrow(godDisableUserBody, request.body);
    return god.disableUser(
      user,
      body.user_id,
      body.reason,
      body.revoke_grants ?? false,
      clientIp(request),
    );
  });

  app.post('/god/broadcast', async (request): Promise<GodBroadcastResponse> => {
    const { user } = assertRole(request, 'super_admin');
    const body = parseOrThrow(godBroadcastBody, request.body);
    return god.broadcast(
      user,
      {
        subject: body.subject,
        body: body.body,
        audience: body.audience,
        ...(body.send_email !== undefined ? { send_email: body.send_email } : {}),
        ...(body.idempotency_key !== undefined ? { idempotency_key: body.idempotency_key } : {}),
      },
      clientIp(request),
    );
  });
};
