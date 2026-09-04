/**
 * Test harness: a real Fastify app on an in-memory SQLite database, talking to
 * a real (in-process) mock Ferrum Edge Admin API over HTTP.
 *
 * Nothing is stubbed above the network boundary, so route wiring, the auth
 * plugin, CSRF, the error handler and the store are all exercised exactly as
 * they are in production.
 */

import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';

import {
  CSRF_COOKIE,
  CSRF_HEADER,
  MAX_PAGE_SIZE,
  SESSION_COOKIE,
  type AuditLog,
  type User,
} from '@ferrum-nexus/shared';

import { loadConfig, type EnvRecord, type NexusConfig } from '../config/index.js';
import { createStore } from '../db/index.js';
import type { EmailOutboxRecord, NexusStore } from '../db/store.js';
import type { MailTransport, MailTransportFactory, OutboundMail } from '../email/service.js';
import type { OutboxTickResult } from '../email/outbox-worker.js';
import { createFerrumAdminClient, type FerrumAdminClient } from '../ferrum-admin/index.js';
import type { ResolvedAddress, UpstreamResolver } from '../publishing/oas.js';
import { buildServer, type BuildServerDeps, type NexusServices } from '../index.js';
import { createMockFerrumEdge, type MockFerrumEdge } from './mock-ferrum-edge.js';

/** 32+ character secrets so config validation passes. */
export const TEST_SECRET_KEY = 'test-nexus-secret-key-0123456789abcdef';
/** Shared with the mock gateway so its JWT verification succeeds. */
export const TEST_EDGE_JWT_SECRET = 'test-ferrum-admin-jwt-secret-0123456789';

/** Default password used by {@link TestApp.registerUser}. */
export const TEST_PASSWORD = 'correct-horse-battery-staple';

/**
 * `NEXUS_BOOTSTRAP_TOKEN` every harness is built with.
 *
 * Only the very first registration against a harness needs it; the server
 * ignores the field once any account exists, so {@link TestApp.registerUser}
 * sends it unconditionally and a test that injects `POST /api/auth/register`
 * by hand only has to include it when it is creating the founder.
 */
export const TEST_BOOTSTRAP_TOKEN = 'test-bootstrap-token-0123456789abcdef';

/* ── OpenAPI fixtures ───────────────────────────────────────────────────── */

/** A minimal but valid OpenAPI 3.1 document with an absolute `servers[0].url`. */
export const SAMPLE_SPEC_YAML = [
  'openapi: 3.1.0',
  'info:',
  '  title: Billing API',
  '  version: 2.4.0',
  '  description: Invoices and payments.',
  'servers:',
  '  - url: https://billing.example.com:8443/v2',
  'paths:',
  '  /invoices:',
  '    get:',
  '      summary: List invoices',
  '      responses:',
  "        '200':",
  '          description: OK',
  '  /invoices/{id}:',
  '    get:',
  '      summary: Get one invoice',
  '      responses:',
  "        '200':",
  '          description: OK',
  '',
].join('\n');

/** The same document as JSON, for the "either format parses" tests. */
export const SAMPLE_SPEC_JSON = JSON.stringify(
  {
    openapi: '3.0.3',
    info: { title: 'Shipping API', version: '1.0.0' },
    servers: [{ url: 'https://shipping.example.com/api' }],
    paths: { '/shipments': { get: { responses: { '200': { description: 'OK' } } } } },
  },
  null,
  2,
);

/* ── Upstream DNS ───────────────────────────────────────────────────────── */

/**
 * The address every hostname resolves to under {@link buildTestApp}.
 *
 * The private-upstream policy resolves the name it is about to publish, and the
 * fixtures point at `billing.example.com`, `api.example.com` and friends —
 * names whose real records are not ours to depend on, and which a sandboxed
 * test run cannot look up at all. The harness therefore injects a resolver that
 * answers this public address for anything, and a test that cares about the
 * policy passes its own through `deps.upstreamResolver`.
 */
export const TEST_PUBLIC_ADDRESS = '93.184.216.34';

/** A resolver answering {@link TEST_PUBLIC_ADDRESS} for every hostname. */
export function publicUpstreamResolver(): UpstreamResolver {
  return async () => [{ address: TEST_PUBLIC_ADDRESS, family: 4 }];
}

/**
 * A resolver answering `answers[host]`, falling back to a public address.
 *
 * `null` as an answer rejects, which is how a test drives the
 * `unresolvable_upstream` branch.
 */
export function fakeUpstreamResolver(
  answers: Record<string, ResolvedAddress[] | null>,
): UpstreamResolver {
  return async (host) => {
    const answer = answers[host];
    if (answer === undefined) return [{ address: TEST_PUBLIC_ADDRESS, family: 4 }];
    if (answer === null)
      throw Object.assign(new Error(`no record for ${host}`), { code: 'ENOTFOUND' });
    return answer;
  };
}

/** Build a spec whose `servers[0].url` is `url` — used by the spec-update tests. */
export function specWithServer(url: string, version = '1.0.0'): string {
  return JSON.stringify({
    openapi: '3.1.0',
    info: { title: 'Billing API', version },
    servers: [{ url }],
    paths: { '/invoices': { get: { responses: { '200': { description: 'OK' } } } } },
  });
}

/** Options for {@link buildTestApp}. */
export interface BuildTestAppOptions {
  /** Extra/overriding environment variables. */
  env?: EnvRecord;
  /** Override injected server dependencies (e.g. `onRegistered`). */
  deps?: Partial<Omit<BuildServerDeps, 'store' | 'edge'>>;
}

/** An authenticated identity produced by the register/login helpers. */
export interface TestSession {
  user: User;
  /** Value of the `nexus_session` cookie. */
  sessionToken: string;
  /** Value of the `nexus_csrf` cookie and the `X-Nexus-CSRF` header. */
  csrfToken: string;
  /** Ready-made `cookie` header for `app.inject`. */
  cookieHeader: string;
}

/**
 * Recording mail sink installed in place of SMTP.
 *
 * The outbox worker never starts on its own under `NEXUS_ENV=test`, so nothing
 * is delivered until a test calls {@link TestApp.tick}.
 */
export interface TestMailbox {
  /** Every message the worker (or an SMTP test) handed to the transport. */
  sent: OutboundMail[];
  /** When set, each `send` rejects with this error — drives the retry tests. */
  failure: Error | null;
  /** When true the factory returns `null`, i.e. "SMTP is not configured". */
  unconfigured: boolean;
  clear(): void;
}

/** Build a recording mailbox and the transport factory that feeds it. */
export function createTestMailbox(): { mailbox: TestMailbox; factory: MailTransportFactory } {
  const mailbox: TestMailbox = {
    sent: [],
    failure: null,
    unconfigured: false,
    clear() {
      mailbox.sent = [];
      mailbox.failure = null;
    },
  };
  const transport: MailTransport = {
    async send(mail) {
      if (mailbox.failure) throw mailbox.failure;
      mailbox.sent.push(mail);
    },
  };
  return {
    mailbox,
    factory: async () => (mailbox.unconfigured ? null : transport),
  };
}

/** Everything a test needs, plus a single `close()`. */
export interface TestApp {
  app: FastifyInstance;
  store: NexusStore;
  edge: MockFerrumEdge;
  edgeClient: FerrumAdminClient;
  config: NexusConfig;
  /** Every composed service, for tests that go below the HTTP layer. */
  services: NexusServices;
  /** Messages the fake SMTP transport received. */
  mailbox: TestMailbox;
  /** Run exactly one outbox poll cycle. */
  tick(): Promise<OutboxTickResult>;
  /** Current `email_outbox` rows, oldest first. */
  outbox(): Promise<EmailOutboxRecord[]>;
  /** Audit rows, optionally filtered to one action, newest first. */
  auditRows(action?: string): Promise<AuditLog[]>;
  /** Register a new account and return its session. */
  registerUser(overrides?: Partial<RegisterPayload>): Promise<TestSession>;
  /** Sign in an existing account. */
  loginUser(email: string, password?: string): Promise<TestSession>;
  /** `app.inject` with the session cookies and the CSRF header attached. */
  authed(session: TestSession, options: InjectOptions): Promise<LightMyRequestResponse>;
  close(): Promise<void>;
}

/** Body accepted by `POST /api/auth/register`. */
export interface RegisterPayload {
  email: string;
  password: string;
  display_name: string;
  role: 'client' | 'provider';
  company?: string | null;
  phone?: string | null;
  captcha_token?: string;
  bootstrap_token?: string;
}

let userCounter = 0;

/** Read one cookie value out of an inject response. */
export function cookieValue(response: LightMyRequestResponse, name: string): string | undefined {
  const cookies = response.cookies as { name: string; value: string }[];
  return cookies.find((cookie) => cookie.name === name)?.value;
}

function sessionFrom(response: LightMyRequestResponse, user: User): TestSession {
  const sessionToken = cookieValue(response, SESSION_COOKIE);
  const csrfToken = cookieValue(response, CSRF_COOKIE);
  if (!sessionToken || !csrfToken) {
    throw new Error(
      `Expected session cookies on ${response.statusCode} response: ${response.body}`,
    );
  }
  return {
    user,
    sessionToken,
    csrfToken,
    cookieHeader: `${SESSION_COOKIE}=${sessionToken}; ${CSRF_COOKIE}=${csrfToken}`,
  };
}

/** Boot a full test application. Always `await close()` in an `after` hook. */
export async function buildTestApp(options: BuildTestAppOptions = {}): Promise<TestApp> {
  const edge = createMockFerrumEdge({ jwtSecret: TEST_EDGE_JWT_SECRET, issuer: 'ferrum-edge' });
  const edgeUrl = await edge.start();

  const config = loadConfig({
    NEXUS_ENV: 'test',
    NEXUS_LOG_LEVEL: 'silent',
    NEXUS_SECRET_KEY: TEST_SECRET_KEY,
    NEXUS_BOOTSTRAP_TOKEN: TEST_BOOTSTRAP_TOKEN,
    // The health probes are uncached by default here: several tests flip the
    // database or the gateway between two requests and expect the second one
    // to see the new state. Tests that exercise the cache set their own value.
    NEXUS_HEALTH_CACHE_MS: '0',
    NEXUS_SQLITE_PATH: ':memory:',
    NEXUS_DB_DRIVER: 'sqlite',
    FERRUM_ADMIN_URL: edgeUrl,
    FERRUM_ADMIN_JWT_SECRET: TEST_EDGE_JWT_SECRET,
    FERRUM_NAMESPACE: 'nexus',
    // Off by default, the way `NEXUS_RATE_LIMIT_ENABLED` is: most suites share
    // one provider account across dozens of publishes, and a production ceiling
    // silently turning half a suite into `429`s would be a confusing way to
    // discover it. The quota tests set a small limit explicitly.
    NEXUS_MAX_APIS_PER_OWNER: '0',
    ...options.env,
  });

  const store = createStore(config);
  await store.init();
  await store.migrate();

  const edgeClient = createFerrumAdminClient(config.edge);
  const { mailbox, factory } = createTestMailbox();
  const app = await buildServer(config, {
    store,
    edge: edgeClient,
    serveStatic: false,
    mailTransportFactory: factory,
    upstreamResolver: publicUpstreamResolver(),
    ...options.deps,
  });

  const testApp: TestApp = {
    app,
    store,
    edge,
    edgeClient,
    config,
    services: app.nexus.services,
    mailbox,

    async tick(): Promise<OutboxTickResult> {
      return app.nexus.services.outbox.tick();
    },

    async outbox(): Promise<EmailOutboxRecord[]> {
      const page = await store.emailOutbox.list({}, { limit: MAX_PAGE_SIZE });
      return [...page.items].sort((a, b) => a.created_at.localeCompare(b.created_at));
    },

    async auditRows(action?: string): Promise<AuditLog[]> {
      const page = await store.auditLogs.list(action === undefined ? {} : { action }, {
        limit: MAX_PAGE_SIZE,
      });
      return page.items;
    },

    async registerUser(overrides = {}): Promise<TestSession> {
      userCounter += 1;
      const payload: RegisterPayload = {
        email: `user${userCounter}@example.test`,
        password: TEST_PASSWORD,
        display_name: `User ${userCounter}`,
        role: 'client',
        // Ignored unless this is the portal's first account, in which case it
        // is what allows the founder to be elected at all.
        bootstrap_token: TEST_BOOTSTRAP_TOKEN,
        ...overrides,
      };
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload,
      });
      if (response.statusCode !== 201) {
        throw new Error(`register failed (${response.statusCode}): ${response.body}`);
      }
      const parsed = response.json<{ user: User }>();
      return sessionFrom(response, parsed.user);
    },

    async loginUser(email: string, password: string = TEST_PASSWORD): Promise<TestSession> {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email, password },
      });
      if (response.statusCode !== 200) {
        throw new Error(`login failed (${response.statusCode}): ${response.body}`);
      }
      const parsed = response.json<{ user: User }>();
      return sessionFrom(response, parsed.user);
    },

    async authed(session: TestSession, injectOptions: InjectOptions) {
      const headers: Record<string, string> = {
        cookie: session.cookieHeader,
        [CSRF_HEADER]: session.csrfToken,
        ...((injectOptions.headers ?? {}) as Record<string, string>),
      };
      return app.inject({ ...injectOptions, headers });
    },

    async close(): Promise<void> {
      await app.close();
      await store.close();
      await edge.stop();
    },
  };

  return testApp;
}
