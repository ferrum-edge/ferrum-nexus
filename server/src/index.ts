/**
 * Composition root.
 *
 * `buildServer(config, deps)` wires the whole BFF and returns the Fastify
 * instance; `main()` runs it. Nothing here contains business logic — services
 * are constructed in the COMPOSITION section below and handed to route plugins
 * through their registration options, so adding a feature is:
 *
 *   1. write `<domain>/service.ts` exporting `create<Domain>Service(deps)`;
 *   2. construct it in "COMPOSITION — services";
 *   3. register its route plugin in "COMPOSITION — routes".
 *
 * No route file ever imports a service module directly.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';

import type { EmailTemplateKey } from '@ferrum-nexus/shared';

import { createAccessService, type AccessService } from './access/service.js';
import { createGodService, type GodService } from './admin/god-service.js';
import { createMassEmailService, type MassEmailService } from './admin/mass-email-service.js';
import { createSettingsService, type SettingsService } from './admin/settings-service.js';
import { createAuditService, type AuditService } from './audit/service.js';
import {
  createCaptchaService,
  type CaptchaService,
  type CaptchaTransport,
} from './auth/captcha.js';
import {
  createAuthService,
  type AuthService,
  type OnEmailTokenIssued,
  type OnRegistered,
} from './auth/service.js';
import { createCatalogService, type CatalogService } from './catalog/service.js';
import { loadConfig, type NexusConfig } from './config/index.js';
import { createConsumerProvisioner } from './credentials/consumers.js';
import { createCredentialsService, type CredentialsService } from './credentials/service.js';
import { createStore } from './db/index.js';
import type { NexusStore } from './db/store.js';
import {
  createEmailService,
  createSmtpTransport,
  type EmailService,
  type MailTransportFactory,
} from './email/service.js';
import { createOutboxWorker, type OutboxWorker } from './email/outbox-worker.js';
import { createFerrumAdmin, type FerrumAdminClient } from './ferrum-admin/index.js';
import { createCrypto, type NexusCrypto } from './lib/crypto.js';
import { isNexusError } from './lib/errors.js';
import { buildLoggerOptions, type LoggerOptions } from './lib/logger.js';
import { createMessagingService, type MessagingService } from './messaging/service.js';
import { registerAuthPlugin } from './middleware/auth-plugin.js';
import { registerErrorHandler } from './middleware/error-handler.js';
import { createNotificationsService, type NotificationsService } from './notifications/service.js';
import { createApiPluginsService, type ApiPluginsService } from './plugins/service.js';
import { createPublishingService, type PublishingService } from './publishing/service.js';
import { accessRequestRoutes, grantRoutes } from './routes/access.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { brandingRoutes } from './routes/branding.js';
import { catalogRoutes } from './routes/catalog.js';
import { credentialsRoutes } from './routes/credentials.js';
import { healthRoutes } from './routes/health.js';
import { messagingRoutes } from './routes/messaging.js';
import { notificationsRoutes } from './routes/notifications.js';
import { publishingRoutes } from './routes/publishing.js';
import { organizationRoutes, usersRoutes } from './routes/users.js';
import { createUsageService, type UsageService } from './usage/service.js';
import { createUsersService, type UsersService } from './users/service.js';

/** Services composed by {@link buildServer} and exposed for tests. */
export interface NexusServices {
  audit: AuditService;
  captcha: CaptchaService;
  auth: AuthService;
  email: EmailService;
  /** Background sender; `tick()` runs one cycle deterministically in tests. */
  outbox: OutboxWorker;
  notifications: NotificationsService;
  settings: SettingsService;
  users: UsersService;
  messaging: MessagingService;
  massEmail: MassEmailService;
  catalog: CatalogService;
  credentials: CredentialsService;
  publishing: PublishingService;
  usage: UsageService;
  apiPlugins: ApiPluginsService;
  access: AccessService;
  god: GodService;
}

/** Everything `buildServer` hangs off the Fastify instance. */
export interface NexusContext {
  config: NexusConfig;
  store: NexusStore;
  edge: FerrumAdminClient;
  crypto: NexusCrypto;
  services: NexusServices;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Config, store, Edge client, crypto helper and every composed service. */
    nexus: NexusContext;
  }
}

/** Injectable dependencies; tests substitute the store, Edge client and logger. */
export interface BuildServerDeps {
  store: NexusStore;
  edge: FerrumAdminClient;
  /** Defaults to one derived from `config.secretKey`. */
  crypto?: NexusCrypto;
  /** Defaults to `buildLoggerOptions(config)`. */
  logger?: LoggerOptions;
  /** Replace the post-registration hook (which enqueues the verification email). */
  onRegistered?: OnRegistered;
  /** Override the CAPTCHA vendor call in tests. */
  captchaTransport?: CaptchaTransport;
  /** Replace the SMTP transport used by the outbox worker and the SMTP test. */
  mailTransportFactory?: MailTransportFactory;
  /**
   * Start the outbox poller. Defaults to `false` under `NEXUS_ENV=test`, where
   * tests drive `services.outbox.tick()` themselves, and `true` elsewhere.
   */
  startOutboxWorker?: boolean;
  /** Serve the built SPA. Defaults to "yes when the dist directory exists". */
  serveStatic?: boolean;
}

/** Rate limit applied to `/api/auth/*` when `config.rateLimitEnabled` is true. */
export const AUTH_RATE_LIMIT = { max: 20, timeWindow: '1 minute' } as const;

/**
 * Translate `config.trustedProxies` into a value Fastify accepts.
 *
 * A hop count becomes a `TrustProxyFunction` rather than being passed through:
 * this Fastify version maps a numeric `trustProxy` to "trust nothing"
 * (`lib/request.js`), which would silently stop honouring `X-Forwarded-For`
 * for anyone who set it. `(_, hop) => hop < hops` is the semantics
 * `proxy-addr` — and Express's numeric `trust proxy` — implement: walk that
 * many entries in from the right and stop.
 *
 * `true` is deliberately unreachable, because it makes `request.ip` the
 * left-most `X-Forwarded-For` entry, which the client writes.
 */
export function fastifyTrustProxy(
  trusted: NexusConfig['trustedProxies'],
): boolean | string[] | ((address: string, hop: number) => boolean) {
  if (trusted === false) return false;
  if (typeof trusted === 'number') return (_address, hop) => hop < trusted;
  return trusted;
}

/** Directory of the built SPA, when there is one. */
function resolveWebDist(config: NexusConfig): string | null {
  const candidates = [
    config.webDistPath,
    resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'web', 'dist'),
    resolve(process.cwd(), 'web', 'dist'),
  ].filter((candidate): candidate is string => typeof candidate === 'string');
  for (const candidate of candidates) {
    if (existsSync(resolve(candidate, 'index.html'))) return resolve(candidate);
  }
  return null;
}

/** Build the Fastify server. The caller owns `store.init()`/`store.migrate()`. */
export async function buildServer(
  config: NexusConfig,
  deps: BuildServerDeps,
): Promise<FastifyInstance> {
  const crypto = deps.crypto ?? createCrypto(config.secretKey);
  const app = Fastify({
    logger: deps.logger ?? buildLoggerOptions(config),
    trustProxy: fastifyTrustProxy(config.trustedProxies),
    bodyLimit: 4 * 1024 * 1024,
  });

  /* ── COMPOSITION — services ─────────────────────────────────────────────
   * Construct every service exactly once, in dependency order. Services take
   * an explicit dependency object; none of them reads process.env.
   */
  const warn = (obj: Record<string, unknown>, message: string): void => app.log.warn(obj, message);

  const audit = createAuditService(deps.store);
  const captcha = createCaptchaService({
    store: deps.store,
    crypto,
    ...(deps.captchaTransport ? { transport: deps.captchaTransport } : {}),
    log: warn,
  });
  const email = createEmailService({
    config,
    store: deps.store,
    crypto,
    log: warn,
    ...(deps.mailTransportFactory ? { transportFactory: deps.mailTransportFactory } : {}),
  });
  const notifications = createNotificationsService({ store: deps.store });
  const auth = createAuthService({
    config,
    store: deps.store,
    crypto,
    audit,
    captcha,
    onRegistered: deps.onRegistered ?? defaultOnRegistered(config, email, notifications, warn),
    onVerificationResend: emailTokenSender(config, email, warn, {
      templateKey: 'verification',
      keyPrefix: 'verify',
      path: '/verify-email',
      urlVar: 'verification_url',
      tokenVar: 'verification_token',
    }),
    onPasswordResetRequested: emailTokenSender(config, email, warn, {
      templateKey: 'password_reset',
      keyPrefix: 'reset',
      path: '/reset-password',
      urlVar: 'reset_url',
      tokenVar: 'reset_token',
    }),
  });
  const settings = createSettingsService({ config, store: deps.store, crypto, audit, auth });
  const messaging = createMessagingService({
    config,
    store: deps.store,
    notifications,
    email,
    audit,
    settings,
    log: warn,
  });
  const massEmail = createMassEmailService({ store: deps.store, email, audit });

  // ── Gateway workflow ────────────────────────────────────────────────────
  // One consumer provisioner is shared by credentials and access so both
  // mutate the same Edge consumer through the same per-consumer queue.
  const provisioner = createConsumerProvisioner({
    config,
    store: deps.store,
    edge: deps.edge,
  });
  const catalog = createCatalogService({ store: deps.store, settings });
  const credentials = createCredentialsService({
    config,
    store: deps.store,
    edge: deps.edge,
    crypto,
    audit,
    notifications,
    email,
    provisioner,
  });
  // Users is composed after credentials: disabling an account has to strip the
  // gateway identity, not merely the browser session.
  const users = createUsersService({
    store: deps.store,
    crypto,
    audit,
    notifications,
    auth,
    credentials,
    log: warn,
  });
  const publishing = createPublishingService({
    config,
    store: deps.store,
    edge: deps.edge,
    audit,
    notifications,
    credentials,
    settings,
  });
  const usage = createUsageService({ store: deps.store, edge: deps.edge, publishing });
  // Composed after publishing: the palette reuses its owner-or-admin check, so
  // there is one definition of "may administer this API" rather than two.
  const apiPlugins = createApiPluginsService({
    config,
    store: deps.store,
    edge: deps.edge,
    audit,
    publishing,
  });
  const access = createAccessService({
    config,
    store: deps.store,
    audit,
    notifications,
    email,
    provisioner,
    settings,
    log: warn,
  });
  const god = createGodService({
    store: deps.store,
    audit,
    notifications,
    email,
    massEmail,
    access,
    publishing,
    credentials,
    log: warn,
  });

  // The worker owns no SMTP knowledge of its own: it asks the email service for
  // the current settings on every tick, so an admin editing them takes effect
  // on the next poll without a restart.
  const outbox = createOutboxWorker({
    store: deps.store,
    log: warn,
    transportFactory:
      deps.mailTransportFactory ??
      (async () => {
        const smtp = await email.resolveSettings();
        return smtp.host ? createSmtpTransport(smtp) : null;
      }),
  });

  const services: NexusServices = {
    audit,
    captcha,
    auth,
    email,
    outbox,
    notifications,
    settings,
    users,
    messaging,
    massEmail,
    catalog,
    credentials,
    publishing,
    usage,
    apiPlugins,
    access,
    god,
  };
  const webDist = (deps.serveStatic ?? true) ? resolveWebDist(config) : null;

  app.decorate('nexus', { config, store: deps.store, edge: deps.edge, crypto, services });

  /* ── COMPOSITION — platform plugins ─────────────────────────────────── */
  registerErrorHandler(app, {
    ...(webDist
      ? {
          spaFallback: (_request, reply) =>
            // no-cache: browsers must revalidate the shell so a fresh deploy's
            // hashed asset references are picked up immediately.
            reply.type('text/html').header('cache-control', 'no-cache').sendFile('index.html'),
        }
      : {}),
  });

  await app.register(cookie, { parseOptions: { path: '/' } });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        // CAPTCHA widgets load a vendor script and iframe; the hosts are fixed
        // and inert unless an admin enables the corresponding provider.
        scriptSrc: [
          "'self'",
          'https://challenges.cloudflare.com',
          'https://hcaptcha.com',
          'https://*.hcaptcha.com',
          'https://www.google.com',
          'https://www.gstatic.com',
        ],
        frameSrc: [
          "'self'",
          'https://challenges.cloudflare.com',
          'https://hcaptcha.com',
          'https://*.hcaptcha.com',
          'https://www.google.com',
        ],
        connectSrc: ["'self'", 'https://hcaptcha.com', 'https://*.hcaptcha.com'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: null,
      },
    },
    crossOriginEmbedderPolicy: false,
    frameguard: { action: 'deny' },
    hsts: config.cookieSecure ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    referrerPolicy: { policy: 'no-referrer' },
  });

  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url.startsWith('/api') && !reply.hasHeader('cache-control')) {
      reply.header('cache-control', 'no-store');
    }
    return payload;
  });

  await registerAuthPlugin(app, { config, store: deps.store, crypto });

  /* ── COMPOSITION — routes ───────────────────────────────────────────────
   * One `register` per domain, all under /api. Add new route plugins here and
   * pass them their services explicitly.
   */
  await app.register(
    async (scope) => {
      await scope.register(healthRoutes, { config, store: deps.store, edge: deps.edge });
    },
    { prefix: '/api/health' },
  );

  await app.register(
    async (scope) => {
      // Rate limiting is scoped to this child instance, so it protects the
      // credential-guessing surface without throttling the rest of the API.
      if (config.rateLimitEnabled) {
        await scope.register(rateLimit, { ...AUTH_RATE_LIMIT });
      }
      await scope.register(authRoutes, { config, auth, captcha });
    },
    { prefix: '/api/auth' },
  );

  await app.register(async (scope) => scope.register(brandingRoutes, { settings, captcha }), {
    prefix: '/api/branding',
  });

  await app.register(async (scope) => scope.register(usersRoutes, { users, config }), {
    prefix: '/api/users',
  });

  await app.register(async (scope) => scope.register(organizationRoutes, { users, config }), {
    prefix: '/api/organizations',
  });

  await app.register(async (scope) => scope.register(messagingRoutes, { messaging }), {
    prefix: '/api/threads',
  });

  await app.register(
    async (scope) => scope.register(notificationsRoutes, { notifications, audit }),
    { prefix: '/api/notifications' },
  );

  await app.register(
    async (scope) => scope.register(adminRoutes, { settings, massEmail, email, audit, god }),
    { prefix: '/api/admin' },
  );

  await app.register(async (scope) => scope.register(catalogRoutes, { catalog }), {
    prefix: '/api/catalog',
  });

  await app.register(
    async (scope) => {
      if (config.rateLimitEnabled) {
        await scope.register(rateLimit, { global: false });
      }
      await scope.register(publishingRoutes, { publishing, usage, apiPlugins });
    },
    { prefix: '/api/apis' },
  );

  await app.register(async (scope) => scope.register(accessRequestRoutes, { access }), {
    prefix: '/api/access-requests',
  });

  await app.register(async (scope) => scope.register(grantRoutes, { access }), {
    prefix: '/api/grants',
  });

  await app.register(async (scope) => scope.register(credentialsRoutes, { credentials }), {
    prefix: '/api/credentials',
  });

  /* ── COMPOSITION — static SPA (production) ──────────────────────────── */
  if (webDist) {
    const fastifyStatic = (await import('@fastify/static')).default;
    await app.register(fastifyStatic, { root: webDist, wildcard: false, index: false });
  }

  app.addHook('onClose', async () => {
    await outbox.stop();
    await deps.edge.close();
  });

  await app.ready();

  // Tests drive `services.outbox.tick()` by hand so no timer ever fires mid-assert.
  if (deps.startOutboxWorker ?? config.env !== 'test') outbox.start();

  return app;
}

/** How one flavour of single-use link is turned into a queued message. */
interface EmailTokenDelivery {
  templateKey: EmailTemplateKey;
  /** Outbox idempotency keys are `<keyPrefix>:<token id>` — one message per token. */
  keyPrefix: string;
  /** SPA path the link points at, e.g. `/reset-password`. */
  path: string;
  /** Template variable carrying the full link. */
  urlVar: string;
  /** Template variable carrying the bare token, for admins who reword the mail. */
  tokenVar: string;
}

/**
 * Build the hook that delivers a minted link — a password reset, or a re-sent
 * verification.
 *
 * The idempotency key is bound to the *token*, not the user, so a second
 * request that mints a second token can still be delivered while one minted
 * token stays at most one message. A queueing failure is logged and swallowed:
 * the token is already in the database and the endpoint's whole contract is
 * that its answer never varies, so throwing here would turn a broken outbox
 * into precisely the signal the endpoint exists to withhold.
 */
function emailTokenSender(
  config: NexusConfig,
  email: EmailService,
  log: (obj: Record<string, unknown>, message: string) => void,
  delivery: EmailTokenDelivery,
): OnEmailTokenIssued {
  return async ({ user, token, tokenId }) => {
    try {
      const url = `${config.publicUrl}${delivery.path}?token=${encodeURIComponent(token)}`;
      await email.enqueue({
        to: user.email,
        templateKey: delivery.templateKey,
        idempotencyKey: `${delivery.keyPrefix}:${tokenId}`,
        vars: {
          recipient_name: user.display_name,
          recipient_email: user.email,
          [delivery.urlVar]: url,
          [delivery.tokenVar]: token,
        },
      });
    } catch (error) {
      log(
        {
          user_id: user.id,
          template: delivery.templateKey,
          error: error instanceof Error ? error.message : String(error),
        },
        'Could not queue a single-use link email',
      );
    }
  };
}

/**
 * Default post-registration hook: queue the verification email (when one is
 * required) and drop a welcome notification in the new account's bell.
 *
 * Neither is allowed to fail the registration — the account already exists by
 * the time this runs, and a queue problem must not leave the visitor unable to
 * retry with the same address.
 */
function defaultOnRegistered(
  config: NexusConfig,
  email: EmailService,
  notifications: NotificationsService,
  log: (obj: Record<string, unknown>, message: string) => void,
): OnRegistered {
  return async ({ user, verificationToken }) => {
    try {
      if (verificationToken) {
        const url = `${config.publicUrl}/verify-email?token=${encodeURIComponent(verificationToken)}`;
        await email.enqueue({
          to: user.email,
          templateKey: 'verification',
          idempotencyKey: `verify:${user.id}`,
          vars: {
            recipient_name: user.display_name,
            recipient_email: user.email,
            verification_url: url,
            verification_token: verificationToken,
          },
        });
      }
      await notifications.notify(
        user.id,
        'system',
        'Welcome to the portal',
        'Your account is ready. Browse the catalog to request access to an API.',
        '/catalog',
      );
    } catch (error) {
      log(
        { user_id: user.id, error: error instanceof Error ? error.message : String(error) },
        'Post-registration hook failed',
      );
    }
  };
}

/* ── Entry point ────────────────────────────────────────────────────────── */

/** Boot the server from `process.env` and listen. */
export async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const store = createStore(config);
  await store.init();
  await store.migrate();

  // The store is built first because the Edge client borrows its lease table:
  // that is what makes consumer and proxy read-modify-writes exclusive across
  // every Nexus instance, not just within this process.
  const app = await buildServer(config, {
    store,
    edge: createFerrumAdmin(config, undefined, store.leases),
  });
  // Best-effort: the namespace is also created implicitly by the first write.
  void app.nexus.edge.ensureNamespace('Managed by Ferrum Nexus');

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'Shutting down');
    try {
      await app.close();
    } finally {
      await store.close();
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.host, port: config.port });
}

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  main().catch((error: unknown) => {
    if (isNexusError(error)) {
      process.stderr.write(`${error.message}\n`);
    } else {
      process.stderr.write(
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
    }
    process.exit(1);
  });
}
