import 'dotenv/config';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifySensible from '@fastify/sensible';
import fastifyStatic from '@fastify/static';
import { loadConfig } from './config/index.js';
import { createLogger, loggerConfig } from './lib/logger.js';
import { createStore } from './db/index.js';
import { createFerrumAdminClient } from './ferrum-admin/client.js';
import { createSessionService } from './auth/session.js';
import { createUsersService } from './users/service.js';
import { createOrganizationsService } from './organizations/service.js';
import { createCatalogService } from './api-catalog/service.js';
import { createPublishingService } from './api-publishing/service.js';
import { createCredentialsService } from './credentials/service.js';
import { createAccessRequestsService } from './access-requests/service.js';
import { createGrantsService } from './grants/service.js';
import { createMessagingService } from './messaging/service.js';
import { createNotificationService } from './notifications/service.js';
import { createEmailService } from './email/service.js';
import { createAuditService } from './audit/service.js';
import { createSettingsService } from './admin/settings-service.js';
import { createMassEmailService } from './admin/mass-email-service.js';
import { createDriftService } from './drift/service.js';
import { registerAuthPlugin } from './middleware/auth-plugin.js';
import { registerErrorHandler } from './middleware/error-handler.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerCatalogRoutes } from './routes/catalog.js';
import { registerClientRoutes } from './routes/client.js';
import { registerProviderRoutes } from './routes/provider.js';
import { registerMessageRoutes } from './routes/messages.js';
import { registerNotificationRoutes } from './routes/notifications.js';
import { registerAdminRoutes } from './routes/admin.js';
import { existsSync } from 'node:fs';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.nodeEnv);

  logger.info({ driver: config.db.driver }, 'starting Ferrum Nexus');

  const store = await createStore(config);
  // Migrate at startup so the operator doesn't need to remember to run it.
  await store.migrate();

  const ferrum = createFerrumAdminClient(config, logger);
  const sessions = createSessionService(config, store);
  const audit = createAuditService(store);
  const notifications = createNotificationService(store);
  const email = createEmailService(config, store, logger);
  await email.seedTemplates();
  email.startWorker();

  const users = createUsersService(config, store, email, audit, notifications);
  const organizations = createOrganizationsService(store);
  const settings = createSettingsService(config, store);
  const catalog = createCatalogService(store);
  const publishing = createPublishingService(config, store, ferrum, audit);
  const credentials = createCredentialsService(
    config,
    store,
    ferrum,
    audit,
    notifications,
    email,
  );
  const accessRequests = createAccessRequestsService(
    config,
    store,
    credentials,
    audit,
    notifications,
    email,
  );
  const grants = createGrantsService(store);
  const messaging = createMessagingService(store, notifications, email);
  const massEmail = createMassEmailService(store, email);
  const drift = createDriftService(store, ferrum);

  const app = Fastify({
    logger: loggerConfig(config.nodeEnv),
    trustProxy: config.trustProxy,
    bodyLimit: 10 * 1024 * 1024, // 10 MiB — large OAS specs are common.
  });

  await app.register(fastifySensible);
  await app.register(fastifyCookie);
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: false, // CSP is configured at the SPA layer if served externally.
    crossOriginEmbedderPolicy: false,
  });
  await app.register(fastifyCors, {
    origin: config.corsOrigins
      ? config.corsOrigins.split(',').map((s) => s.trim()).filter(Boolean)
      : [config.publicUrl],
    credentials: true,
  });
  await app.register(fastifyRateLimit, {
    global: true,
    max: 600,
    timeWindow: '1 minute',
  });

  registerErrorHandler(app);
  registerAuthPlugin(app, sessions);

  await registerAuthRoutes(app, { config, users, sessions, settings });
  await registerCatalogRoutes(app, { catalog, accessRequests, store });
  await registerClientRoutes(app, { accessRequests, grants, credentials });
  await registerProviderRoutes(app, {
    publishing,
    catalog,
    accessRequests,
    grants,
    credentials,
    messaging,
    store,
  });
  await registerMessageRoutes(app, { messaging });
  await registerNotificationRoutes(app, { notifications });
  await registerAdminRoutes(app, {
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
  });

  app.get('/api/health', async () => {
    const edge = await ferrum.health().catch(() => ({ ok: false, details: 'unreachable' }));
    return { ok: true, edge, time: new Date().toISOString() };
  });

  // Serve the SPA in production. In dev the Vite server proxies /api here.
  const spaDir = resolve(process.cwd(), 'web/dist');
  if (existsSync(spaDir)) {
    await app.register(fastifyStatic, { root: spaDir, prefix: '/' });
    app.setNotFoundHandler(async (req, reply) => {
      if (req.raw.url?.startsWith('/api/')) {
        reply.status(404).send({ error: { code: 'not_found', message: 'Not found' } });
        return;
      }
      return reply.type('text/html').sendFile('index.html', spaDir);
    });
  }

  const cleanupExpiredSessions = (): void => {
    store.sessions
      .cleanupExpired(new Date().toISOString())
      .catch((err) => logger.warn({ err }, 'session cleanup failed'));
  };
  setInterval(cleanupExpiredSessions, 60_000).unref();

  await app.listen({ host: config.host, port: config.port });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    await app.close();
    await store.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
