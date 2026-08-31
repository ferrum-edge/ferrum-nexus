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

import { createAuditService, type AuditService } from './audit/service.js';
import {
  createCaptchaService,
  type CaptchaService,
  type CaptchaTransport,
} from './auth/captcha.js';
import { createAuthService, type AuthService, type OnRegistered } from './auth/service.js';
import { loadConfig, type NexusConfig } from './config/index.js';
import { createStore } from './db/index.js';
import type { NexusStore } from './db/store.js';
import { createFerrumAdmin, type FerrumAdminClient } from './ferrum-admin/index.js';
import { createCrypto, type NexusCrypto } from './lib/crypto.js';
import { isNexusError } from './lib/errors.js';
import { buildLoggerOptions, type LoggerOptions } from './lib/logger.js';
import { registerAuthPlugin } from './middleware/auth-plugin.js';
import { registerErrorHandler } from './middleware/error-handler.js';
import { authRoutes } from './routes/auth.js';
import { healthRoutes } from './routes/health.js';

/** Services composed by {@link buildServer} and exposed for tests. */
export interface NexusServices {
  audit: AuditService;
  captcha: CaptchaService;
  auth: AuthService;
  // NOTE(services agent): add users, catalog, publishing, access, credentials,
  // messaging, notifications, email and admin services here.
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
  /** Hook the email service will supply once it exists. */
  onRegistered?: OnRegistered;
  /** Override the CAPTCHA vendor call in tests. */
  captchaTransport?: CaptchaTransport;
  /** Serve the built SPA. Defaults to "yes when the dist directory exists". */
  serveStatic?: boolean;
}

/** Rate limit applied to `/api/auth/*` when `config.rateLimitEnabled` is true. */
export const AUTH_RATE_LIMIT = { max: 20, timeWindow: '1 minute' } as const;

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
    trustProxy: config.trustProxy,
    bodyLimit: 4 * 1024 * 1024,
  });

  /* ── COMPOSITION — services ─────────────────────────────────────────────
   * Construct every service exactly once, in dependency order. Services take
   * an explicit dependency object; none of them reads process.env.
   */
  const audit = createAuditService(deps.store);
  const captcha = createCaptchaService({
    store: deps.store,
    crypto,
    ...(deps.captchaTransport ? { transport: deps.captchaTransport } : {}),
    log: (obj, message) => app.log.warn(obj, message),
  });
  const auth = createAuthService({
    config,
    store: deps.store,
    crypto,
    audit,
    captcha,
    ...(deps.onRegistered ? { onRegistered: deps.onRegistered } : {}),
  });

  const services: NexusServices = { audit, captcha, auth };
  const webDist = (deps.serveStatic ?? true) ? resolveWebDist(config) : null;

  app.decorate('nexus', { config, store: deps.store, edge: deps.edge, crypto, services });

  /* ── COMPOSITION — platform plugins ─────────────────────────────────── */
  registerErrorHandler(app, {
    ...(webDist
      ? { spaFallback: (_request, reply) => reply.type('text/html').sendFile('index.html') }
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
    hsts: config.trustProxy ? { maxAge: 31_536_000, includeSubDomains: true } : false,
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

  // NOTE(services agent): register /api/users, /api/catalog, /api/apis,
  // /api/access-requests, /api/grants, /api/credentials, /api/threads,
  // /api/notifications, /api/admin, /api/branding here, in the same shape.

  /* ── COMPOSITION — static SPA (production) ──────────────────────────── */
  if (webDist) {
    const fastifyStatic = (await import('@fastify/static')).default;
    await app.register(fastifyStatic, { root: webDist, wildcard: false, index: false });
  }

  app.addHook('onClose', async () => {
    await deps.edge.close();
  });

  await app.ready();
  return app;
}

/* ── Entry point ────────────────────────────────────────────────────────── */

/** Boot the server from `process.env` and listen. */
export async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const store = createStore(config);
  await store.init();
  await store.migrate();

  const app = await buildServer(config, { store, edge: createFerrumAdmin(config) });
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
