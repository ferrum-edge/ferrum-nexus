/**
 * Environment configuration, validated once at startup with zod.
 *
 * Nothing else in the server reads `process.env`. `loadConfig(env)` is pure —
 * pass it any record of strings — so tests can build a config without touching
 * the real process environment.
 *
 * Every variable documented in the repo-root `.env.example` is covered here
 * with the same default. A handful of extra variables exist for testing and
 * container deployment (`NEXUS_ENV`, `NEXUS_RATE_LIMIT_ENABLED`,
 * `NEXUS_HEALTH_CACHE_MS`, `NEXUS_WEB_DIST`, `NEXUS_ALLOW_PRIVATE_UPSTREAMS`,
 * `FERRUM_ADMIN_TIMEOUT_MS`, `FERRUM_MAX_CREDENTIALS_PER_TYPE`);
 * they are all optional and default to production-safe values.
 */

import { z } from 'zod';

import { DEFAULT_FERRUM_NAMESPACE, DEFAULT_SESSION_TTL_SECONDS } from '@ferrum-nexus/shared';
import type { DbDriver } from '@ferrum-nexus/shared';
import { NexusError } from '../lib/errors.js';
import { GATEWAY_PUBLIC_URL_RULE, normalizeGatewayPublicUrl } from '../lib/gateway-url.js';

/** Raw environment shape accepted by {@link loadConfig}. */
export type EnvRecord = Record<string, string | undefined>;

/** Log levels accepted by `NEXUS_LOG_LEVEL` (pino levels). */
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

/** A pino log level. */
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Runtime environment; `test` disables rate limiting and quietens the logger. */
export type NodeEnv = 'development' | 'test' | 'production';

/**
 * Value handed to Fastify's `trustProxy`.
 *
 * `false` — the default — means `X-Forwarded-For` is ignored entirely and
 * `request.ip` is always the socket address. A number is a hop count counted
 * from the *right* of the header; a list is a CIDR/IP allowlist. Both forms are
 * passed to `proxy-addr` unchanged.
 */
export type TrustedProxies = false | number | string[];

/**
 * Default ceiling on APIs owned by one account (`NEXUS_MAX_APIS_PER_OWNER`).
 *
 * High enough that no honest provider meets it — a team publishing fifty
 * distinct APIs from one portal account is already unusual — and low enough
 * that a scripted account cannot exhaust the gateway or the database before an
 * operator notices. `0` turns the ceiling off for a closed deployment where
 * every provider is vetted.
 */
export const DEFAULT_MAX_APIS_PER_OWNER = 50;

/** Aliases `proxy-addr` understands in place of a literal CIDR. */
const PROXY_KEYWORDS = ['loopback', 'linklocal', 'uniquelocal'] as const;

/** An IPv4/IPv6 address, a CIDR block, or one of the `proxy-addr` keywords. */
function isTrustedProxyEntry(entry: string): boolean {
  if ((PROXY_KEYWORDS as readonly string[]).includes(entry.toLowerCase())) return true;
  return /^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(entry);
}

/** Persistence configuration. */
export interface DbConfig {
  /** Which adapter `createStore` instantiates. */
  driver: DbDriver;
  /** Connection URL for postgres/mysql/mongodb. Empty for sqlite. */
  url: string;
  /** File path for the sqlite adapter; `:memory:` is honoured for tests. */
  sqlitePath: string;
  /** Allow a standalone (non-replica-set) MongoDB, degrading transactions. */
  allowStandalone: boolean;
}

/** Ferrum Edge Admin API integration configuration. */
export interface EdgeConfig {
  /** Base URL of the Admin API, without a trailing slash. */
  adminUrl: string;
  /** HS256 signing secret shared with the gateway (min 32 chars). */
  jwtSecret: string;
  /** Admin JWT lifetime in seconds. Edge caps this at 3600. */
  jwtTtlSeconds: number;
  /** `iss` claim; must equal the gateway's `FERRUM_ADMIN_JWT_ISSUER`. */
  jwtIssuer: string;
  /** `aud` claim — only stamped when the gateway configures an audience. */
  jwtAudience: string | undefined;
  /** Namespace sent in `X-Ferrum-Namespace` on every call. */
  namespace: string;
  /**
   * Default public origin of the gateway's **proxy listener**
   * (`FERRUM_GATEWAY_PUBLIC_URL`), used to build each API's `invoke_url`.
   *
   * Not {@link EdgeConfig.adminUrl} (the control plane) and not
   * {@link NexusConfig.publicUrl} (the portal). `undefined` when unset, in
   * which case only the `gateway.public_url` setting can supply one.
   */
  gatewayPublicUrl: string | undefined;
  /** Optional PEM CA bundle path for a TLS-protected Admin API. */
  caFile: string | undefined;
  /** Set to allow a plaintext `http://` Admin URL on a non-loopback host. */
  allowInsecureHttp: boolean;
  /** Per-request deadline for Admin API calls, in milliseconds. */
  timeoutMs: number;
  /** Mirror of the gateway's `FERRUM_MAX_CREDENTIALS_PER_TYPE` (append cap). */
  maxCredentialsPerType: number;
  /** How Edge should store the counters of every rate limit Nexus writes. */
  rateLimit: EdgeRateLimitSyncConfig;
}

/**
 * Counter storage for the `rate_limiting` plugin configs Nexus writes.
 *
 * Edge keeps rate-limit counters **per gateway process** unless a rule names a
 * Redis endpoint, so a portal in front of N data-plane replicas enforces N
 * times the quota the provider chose. There is no gateway-level environment
 * variable for this — the endpoint lives in each plugin config — which is why
 * it is configured on Nexus and stamped onto every rate limit it writes.
 */
export interface EdgeRateLimitSyncConfig {
  /** `local` (default, per process) or `redis` (shared across replicas). */
  syncMode: 'local' | 'redis';
  /** `redis://` or `rediss://` endpoint; only set when `syncMode` is `redis`. */
  redisUrl: string | undefined;
  /** Upgrade a `redis://` endpoint to TLS. */
  redisTls: boolean;
}

/** SMTP configuration; may be overridden at runtime from encrypted `app_settings`. */
export interface SmtpConfig {
  host: string | undefined;
  port: number;
  secure: boolean;
  user: string | undefined;
  password: string | undefined;
  /** RFC 5322 `From` header, e.g. `Ferrum Nexus <no-reply@example.com>`. */
  from: string;
}

/** The fully-validated configuration passed to `buildServer`. */
export interface NexusConfig {
  env: NodeEnv;
  /** Bind address. */
  host: string;
  /** Bind port. */
  port: number;
  /** Public origin of the portal, used in emails and verification links. */
  publicUrl: string;
  /**
   * Which proxies may set `X-Forwarded-For` (`NEXUS_TRUSTED_PROXIES`).
   *
   * Defaults to `false`: a client-supplied header never reaches `request.ip`,
   * so the rate limiter and the audit trail key on the socket address.
   */
  trustedProxies: TrustedProxies;
  /**
   * Mark the session/CSRF cookies `Secure` and enable HSTS
   * (`NEXUS_COOKIE_SECURE`). Defaults to `true` outside development.
   *
   * Deliberately independent of {@link NexusConfig.trustedProxies}: TLS in
   * front of the portal and "this proxy may rewrite the client address" are
   * different claims, and coupling them made one of them wrong.
   */
  cookieSecure: boolean;
  logLevel: LogLevel;
  /** Master secret; every other key is HKDF-derived from it. */
  secretKey: string;
  /**
   * Secret the first-ever registration must present to become the founding
   * `super_admin` (`NEXUS_BOOTSTRAP_TOKEN`).
   *
   * `undefined` means the variable is unset, in which case the entry point
   * generates one per process and prints it — see `main()` in `../index.ts`.
   * A server built with this still `undefined` refuses every registration
   * against an empty portal, because there is no token that could match.
   */
  bootstrapToken: string | undefined;
  /** Session idle lifetime in seconds (sliding). */
  sessionTtlSeconds: number;
  /** Whether the `/api/auth/*`, `/api/health` and `/api/apis/*` rate limiters are installed. Off under `NEXUS_ENV=test`. */
  rateLimitEnabled: boolean;
  /**
   * How long `GET /api/health` reuses a dependency probe
   * (`NEXUS_HEALTH_CACHE_MS`).
   *
   * The endpoints are unauthenticated, and each one used to turn a cheap public
   * request into a database query and an authenticated Admin API call. Within
   * this window the database and gateway probes are each taken once and shared,
   * including a failing one — a probe keys on the status code, and a few
   * seconds of lag is cheaper than letting anonymous traffic drive the
   * control plane.
   *
   * `0` disables the cache: every request probes, which is what the tests that
   * flip dependency state between requests rely on.
   */
  healthCacheMs: number;
  /**
   * How many APIs one account may own at a time (`NEXUS_MAX_APIS_PER_OWNER`).
   * `0` disables the ceiling.
   *
   * Registration may be open, so a `provider` is only semi-trusted, and each
   * publish stores a document of up to `MAX_SPEC_BYTES` and allocates a proxy,
   * several plugin configs and a slug on the gateway. Without a ceiling one
   * account can exhaust all of it (GHSA-g32g-g9q4-q5wr). Aggregate spec storage
   * per account is therefore bounded by `MAX_SPEC_BYTES × this` — 100 MB at the
   * default of 50.
   */
  maxApisPerOwner: number;
  /**
   * Whether a provider may publish an API whose upstream is a loopback, private,
   * link-local or internal destination (`NEXUS_ALLOW_PRIVATE_UPSTREAMS`).
   *
   * Defaults to `false`: a proxy is an egress path from the gateway's network,
   * so an open portal must not let a provider aim one at cloud metadata or the
   * gateway's own subnet. Deployments fronting internal services opt in.
   */
  allowPrivateUpstreams: boolean;
  /** Directory of the built SPA to serve in production; `undefined` disables static serving. */
  webDistPath: string | undefined;
  db: DbConfig;
  edge: EdgeConfig;
  smtp: SmtpConfig;
}

/* ── Parsing helpers ────────────────────────────────────────────────────── */

const boolish = (
  defaultValue: boolean,
): z.ZodEffects<z.ZodOptional<z.ZodString>, boolean, string | undefined> =>
  z
    .string()
    .optional()
    .transform((raw, ctx) => {
      if (raw === undefined || raw.trim() === '') return defaultValue;
      const value = raw.trim().toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(value)) return true;
      if (['0', 'false', 'no', 'off'].includes(value)) return false;
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be true or false' });
      return z.NEVER;
    });

const intish = (
  defaultValue: number,
  min: number,
  max: number,
): z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined> =>
  z
    .string()
    .optional()
    .transform((raw, ctx) => {
      if (raw === undefined || raw.trim() === '') return defaultValue;
      const value = Number(raw);
      if (!Number.isSafeInteger(value) || value < min || value > max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `must be an integer between ${min} and ${max}`,
        });
        return z.NEVER;
      }
      return value;
    });

const stringish = (
  defaultValue: string,
): z.ZodEffects<z.ZodOptional<z.ZodString>, string, string | undefined> =>
  z
    .string()
    .optional()
    .transform((raw) => (raw === undefined || raw.trim() === '' ? defaultValue : raw.trim()));

/** An optional variable: blank and absent both mean "not configured". */
const optionalString = (): z.ZodEffects<
  z.ZodOptional<z.ZodString>,
  string | undefined,
  string | undefined
> =>
  z
    .string()
    .optional()
    .transform((raw) => (raw === undefined || raw.trim() === '' ? undefined : raw.trim()));

/** Hosts that never need `FERRUM_ADMIN_ALLOW_INSECURE_HTTP` to be spoken to over plaintext. */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  if (host.endsWith('.localhost')) return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

const envSchema = z.object({
  NEXUS_ENV: z.enum(['development', 'test', 'production']).optional(),
  NODE_ENV: z.string().optional(),

  NEXUS_SECRET_KEY: z
    .string({ required_error: 'is required' })
    .min(32, 'must be at least 32 characters (generate with `openssl rand -hex 32`)'),

  NEXUS_BOOTSTRAP_TOKEN: optionalString(),

  NEXUS_HOST: stringish('127.0.0.1'),
  NEXUS_PORT: intish(8787, 0, 65_535),
  NEXUS_PUBLIC_URL: stringish('http://127.0.0.1:5173'),
  NEXUS_TRUSTED_PROXIES: optionalString(),
  /** @deprecated alias for `NEXUS_TRUSTED_PROXIES=1`. */
  NEXUS_TRUST_PROXY: boolish(false),
  NEXUS_COOKIE_SECURE: optionalString(),
  NEXUS_LOG_LEVEL: z
    .string()
    .optional()
    .transform((raw, ctx) => {
      if (raw === undefined || raw.trim() === '') return 'info' as LogLevel;
      const value = raw.trim().toLowerCase();
      if ((LOG_LEVELS as readonly string[]).includes(value)) return value as LogLevel;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `must be one of ${LOG_LEVELS.join(', ')}`,
      });
      return z.NEVER;
    }),
  NEXUS_SESSION_TTL: intish(DEFAULT_SESSION_TTL_SECONDS, 60, 60 * 60 * 24 * 30),
  NEXUS_RATE_LIMIT_ENABLED: boolish(true),
  NEXUS_HEALTH_CACHE_MS: intish(5_000, 0, 60_000),
  NEXUS_MAX_APIS_PER_OWNER: intish(DEFAULT_MAX_APIS_PER_OWNER, 0, 100_000),
  NEXUS_ALLOW_PRIVATE_UPSTREAMS: boolish(false),
  NEXUS_WEB_DIST: optionalString(),

  NEXUS_DB_DRIVER: z
    .string()
    .optional()
    .transform((raw, ctx) => {
      const value = (raw ?? 'sqlite').trim().toLowerCase() || 'sqlite';
      if (['sqlite', 'postgres', 'mysql', 'mongodb'].includes(value)) return value as DbDriver;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'must be one of sqlite, postgres, mysql, mongodb',
      });
      return z.NEVER;
    }),
  NEXUS_DB_URL: stringish(''),
  NEXUS_SQLITE_PATH: stringish('./data/nexus.sqlite'),
  NEXUS_DB_ALLOW_STANDALONE: boolish(false),

  FERRUM_ADMIN_URL: stringish('http://127.0.0.1:9000'),
  FERRUM_ADMIN_JWT_SECRET: z
    .string({ required_error: 'is required' })
    .min(32, 'must be at least 32 characters and match the gateway'),
  FERRUM_ADMIN_JWT_TTL: intish(60, 5, 3_600),
  FERRUM_ADMIN_JWT_ISSUER: stringish('ferrum-edge'),
  FERRUM_ADMIN_JWT_AUDIENCE: optionalString(),
  FERRUM_NAMESPACE: stringish(DEFAULT_FERRUM_NAMESPACE),
  FERRUM_GATEWAY_PUBLIC_URL: optionalString(),
  FERRUM_ADMIN_CA_FILE: optionalString(),
  FERRUM_ADMIN_ALLOW_INSECURE_HTTP: boolish(false),
  FERRUM_ADMIN_TIMEOUT_MS: intish(5_000, 250, 60_000),
  FERRUM_MAX_CREDENTIALS_PER_TYPE: intish(2, 1, 10),
  FERRUM_RATE_LIMIT_SYNC_MODE: z
    .string()
    .optional()
    .transform((raw, ctx) => {
      const value = (raw ?? '').trim().toLowerCase();
      if (value === '') return 'local' as const;
      if (value === 'local' || value === 'redis') return value;
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be local or redis' });
      return z.NEVER;
    }),
  FERRUM_RATE_LIMIT_REDIS_URL: optionalString(),
  FERRUM_RATE_LIMIT_REDIS_TLS: boolish(false),

  NEXUS_SMTP_HOST: optionalString(),
  NEXUS_SMTP_PORT: intish(587, 1, 65_535),
  NEXUS_SMTP_SECURE: boolish(false),
  NEXUS_SMTP_USER: optionalString(),
  NEXUS_SMTP_PASSWORD: optionalString(),
  NEXUS_EMAIL_FROM: stringish('Ferrum Nexus <no-reply@example.com>'),
});

const NAMESPACE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** Shortest `NEXUS_BOOTSTRAP_TOKEN` accepted; the generated one is 64 hex chars. */
export const MIN_BOOTSTRAP_TOKEN_LENGTH = 16;

/**
 * Validate an environment record into a {@link NexusConfig}.
 *
 * Throws `NexusError(INTERNAL)` listing every offending variable — the process
 * should print `error.details` and exit rather than start half-configured.
 */
export function loadConfig(env: EnvRecord): NexusConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw configError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`),
    );
  }
  const raw = parsed.data;
  const problems: string[] = [];

  const nodeEnv: NodeEnv =
    raw.NEXUS_ENV ??
    (raw.NODE_ENV === 'production' || raw.NODE_ENV === 'test' ? raw.NODE_ENV : 'development');

  // ── Admin URL: shape + plaintext-http guard ──────────────────────────────
  let adminUrl = raw.FERRUM_ADMIN_URL;
  let adminParsed: URL | undefined;
  try {
    adminParsed = new URL(adminUrl);
  } catch {
    problems.push('FERRUM_ADMIN_URL must be an absolute URL, e.g. http://127.0.0.1:9000');
  }
  if (adminParsed) {
    if (adminParsed.protocol !== 'http:' && adminParsed.protocol !== 'https:') {
      problems.push('FERRUM_ADMIN_URL must use http:// or https://');
    } else if (
      adminParsed.protocol === 'http:' &&
      !isLoopbackHost(adminParsed.hostname) &&
      !raw.FERRUM_ADMIN_ALLOW_INSECURE_HTTP
    ) {
      problems.push(
        `FERRUM_ADMIN_URL uses plaintext http:// for non-loopback host '${adminParsed.hostname}'; ` +
          'use https:// or set FERRUM_ADMIN_ALLOW_INSECURE_HTTP=true',
      );
    }
    adminUrl = adminParsed.origin + adminParsed.pathname.replace(/\/+$/, '');
  }

  // ── Public URL ───────────────────────────────────────────────────────────
  let publicUrl = raw.NEXUS_PUBLIC_URL;
  try {
    publicUrl = new URL(publicUrl).toString().replace(/\/+$/, '');
  } catch {
    problems.push('NEXUS_PUBLIC_URL must be an absolute URL, e.g. https://portal.example.com');
  }

  // ── Namespace ────────────────────────────────────────────────────────────
  if (!NAMESPACE_PATTERN.test(raw.FERRUM_NAMESPACE) || raw.FERRUM_NAMESPACE.length > 254) {
    problems.push(
      'FERRUM_NAMESPACE must match ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ and be at most 254 characters',
    );
  }

  // ── Gateway proxy-listener origin ────────────────────────────────────────
  // Optional: with neither this nor the `gateway.public_url` setting, APIs
  // report a null `invoke_url` rather than a guessed address.
  let gatewayPublicUrl: string | undefined;
  if (raw.FERRUM_GATEWAY_PUBLIC_URL !== undefined) {
    const normalized = normalizeGatewayPublicUrl(raw.FERRUM_GATEWAY_PUBLIC_URL);
    if (normalized === null) {
      problems.push(`FERRUM_GATEWAY_PUBLIC_URL ${GATEWAY_PUBLIC_URL_RULE}`);
    } else {
      gatewayPublicUrl = normalized;
    }
  }

  // ── Proxy trust and cookie policy ────────────────────────────────────────
  // Two independent decisions. `NEXUS_TRUST_PROXY=true` survives only as an
  // alias for "one hop", so an existing deployment keeps working.
  const trustedProxies = parseTrustedProxies(
    raw.NEXUS_TRUSTED_PROXIES,
    raw.NEXUS_TRUST_PROXY,
    problems,
  );
  const cookieSecure = parseBoolish(
    raw.NEXUS_COOKIE_SECURE,
    'NEXUS_COOKIE_SECURE',
    nodeEnv !== 'development',
    problems,
  );

  // ── Redis-backed rate limits need an endpoint ────────────────────────────
  // Edge validates `redis_url` against `^rediss?://…` and rejects the whole
  // plugin config otherwise, which would surface as a `502 EDGE_ERROR` on the
  // provider's *publish* rather than as a misconfigured portal. Catch it here.
  const redisUrl = raw.FERRUM_RATE_LIMIT_REDIS_URL;
  if (raw.FERRUM_RATE_LIMIT_SYNC_MODE === 'redis' && redisUrl === undefined) {
    problems.push('FERRUM_RATE_LIMIT_REDIS_URL is required when FERRUM_RATE_LIMIT_SYNC_MODE=redis');
  }
  if (redisUrl !== undefined && !/^rediss?:\/\/[^\s]+$/.test(redisUrl)) {
    problems.push(
      'FERRUM_RATE_LIMIT_REDIS_URL must be a redis:// or rediss:// URL, e.g. redis://127.0.0.1:6379/0',
    );
  }

  // ── Bootstrap token ──────────────────────────────────────────────────────
  // Optional, but a short one is worse than none: it looks configured while
  // being guessable, and what it guards is the founding super_admin.
  const bootstrapToken = raw.NEXUS_BOOTSTRAP_TOKEN;
  if (bootstrapToken !== undefined && bootstrapToken.length < MIN_BOOTSTRAP_TOKEN_LENGTH) {
    problems.push(
      `NEXUS_BOOTSTRAP_TOKEN must be at least ${MIN_BOOTSTRAP_TOKEN_LENGTH} characters ` +
        '(generate with `openssl rand -hex 32`), or be left unset so the server generates one',
    );
  }

  // ── Non-sqlite drivers need a connection URL ─────────────────────────────
  if (raw.NEXUS_DB_DRIVER !== 'sqlite' && raw.NEXUS_DB_URL === '') {
    problems.push(`NEXUS_DB_URL is required when NEXUS_DB_DRIVER=${raw.NEXUS_DB_DRIVER}`);
  }

  if (problems.length > 0) throw configError(problems);

  return {
    env: nodeEnv,
    host: raw.NEXUS_HOST,
    port: raw.NEXUS_PORT,
    publicUrl,
    trustedProxies,
    cookieSecure,
    logLevel: raw.NEXUS_LOG_LEVEL,
    secretKey: raw.NEXUS_SECRET_KEY,
    bootstrapToken,
    sessionTtlSeconds: raw.NEXUS_SESSION_TTL,
    rateLimitEnabled: nodeEnv === 'test' ? false : raw.NEXUS_RATE_LIMIT_ENABLED,
    healthCacheMs: raw.NEXUS_HEALTH_CACHE_MS,
    maxApisPerOwner: raw.NEXUS_MAX_APIS_PER_OWNER,
    allowPrivateUpstreams: raw.NEXUS_ALLOW_PRIVATE_UPSTREAMS,
    webDistPath: raw.NEXUS_WEB_DIST,
    db: {
      driver: raw.NEXUS_DB_DRIVER,
      url: raw.NEXUS_DB_URL,
      sqlitePath: raw.NEXUS_SQLITE_PATH,
      allowStandalone: raw.NEXUS_DB_ALLOW_STANDALONE,
    },
    edge: {
      adminUrl,
      jwtSecret: raw.FERRUM_ADMIN_JWT_SECRET,
      jwtTtlSeconds: raw.FERRUM_ADMIN_JWT_TTL,
      jwtIssuer: raw.FERRUM_ADMIN_JWT_ISSUER,
      jwtAudience: raw.FERRUM_ADMIN_JWT_AUDIENCE,
      namespace: raw.FERRUM_NAMESPACE,
      gatewayPublicUrl,
      caFile: raw.FERRUM_ADMIN_CA_FILE,
      allowInsecureHttp: raw.FERRUM_ADMIN_ALLOW_INSECURE_HTTP,
      timeoutMs: raw.FERRUM_ADMIN_TIMEOUT_MS,
      maxCredentialsPerType: raw.FERRUM_MAX_CREDENTIALS_PER_TYPE,
      rateLimit: {
        syncMode: raw.FERRUM_RATE_LIMIT_SYNC_MODE,
        // Carried only in `redis` mode: a stale endpoint left in the
        // environment must not end up on a plugin config that says `local`.
        redisUrl: raw.FERRUM_RATE_LIMIT_SYNC_MODE === 'redis' ? redisUrl : undefined,
        redisTls: raw.FERRUM_RATE_LIMIT_REDIS_TLS,
      },
    },
    smtp: {
      host: raw.NEXUS_SMTP_HOST,
      port: raw.NEXUS_SMTP_PORT,
      secure: raw.NEXUS_SMTP_SECURE,
      user: raw.NEXUS_SMTP_USER,
      password: raw.NEXUS_SMTP_PASSWORD,
      from: raw.NEXUS_EMAIL_FROM,
    },
  };
}

/**
 * Parse a boolean whose default depends on something the schema cannot see
 * (here: `NEXUS_ENV`). Unparsable values are collected, not thrown.
 */
function parseBoolish(
  raw: string | undefined,
  name: string,
  defaultValue: boolean,
  problems: string[],
): boolean {
  if (raw === undefined || raw.trim() === '') return defaultValue;
  const value = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  problems.push(`${name} must be true or false`);
  return defaultValue;
}

/**
 * Parse `NEXUS_TRUSTED_PROXIES` — an integer hop count or a comma-separated
 * CIDR/IP allowlist — falling back to the deprecated `NEXUS_TRUST_PROXY=true`
 * alias, which means "trust exactly one hop".
 *
 * Trusting *every* proxy is deliberately not expressible: `trustProxy: true`
 * makes `proxy-addr` take the left-most `X-Forwarded-For` entry, which any
 * client can write, and that value then keys the rate limiter and the audit
 * trail.
 */
function parseTrustedProxies(
  raw: string | undefined,
  legacyTrustProxy: boolean,
  problems: string[],
): TrustedProxies {
  const value = raw?.trim() ?? '';
  if (value === '') return legacyTrustProxy ? 1 : false;

  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    if (!Number.isSafeInteger(hops) || hops < 1 || hops > 32) {
      problems.push('NEXUS_TRUSTED_PROXIES hop count must be an integer between 1 and 32');
      return false;
    }
    return hops;
  }

  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  const invalid = entries.filter((entry) => !isTrustedProxyEntry(entry));
  if (entries.length === 0 || invalid.length > 0) {
    problems.push(
      'NEXUS_TRUSTED_PROXIES must be an integer hop count or a comma-separated list of ' +
        `IP addresses, CIDR blocks or ${PROXY_KEYWORDS.join('/')}${
          invalid.length > 0 ? ` (rejected: ${invalid.join(', ')})` : ''
        }`,
    );
    return false;
  }
  return entries;
}

function configError(problems: string[]): NexusError {
  return new NexusError('INTERNAL', `Invalid configuration: ${problems.join('; ')}`, { problems });
}
