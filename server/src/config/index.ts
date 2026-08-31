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
 * `NEXUS_WEB_DIST`, `FERRUM_ADMIN_TIMEOUT_MS`, `FERRUM_MAX_CREDENTIALS_PER_TYPE`);
 * they are all optional and default to production-safe values.
 */

import { z } from 'zod';

import { DEFAULT_FERRUM_NAMESPACE, DEFAULT_SESSION_TTL_SECONDS } from '@ferrum-nexus/shared';
import type { DbDriver } from '@ferrum-nexus/shared';
import { NexusError } from '../lib/errors.js';

/** Raw environment shape accepted by {@link loadConfig}. */
export type EnvRecord = Record<string, string | undefined>;

/** Log levels accepted by `NEXUS_LOG_LEVEL` (pino levels). */
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

/** A pino log level. */
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Runtime environment; `test` disables rate limiting and quietens the logger. */
export type NodeEnv = 'development' | 'test' | 'production';

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
  /** Optional PEM CA bundle path for a TLS-protected Admin API. */
  caFile: string | undefined;
  /** Set to allow a plaintext `http://` Admin URL on a non-loopback host. */
  allowInsecureHttp: boolean;
  /** Per-request deadline for Admin API calls, in milliseconds. */
  timeoutMs: number;
  /** Mirror of the gateway's `FERRUM_MAX_CREDENTIALS_PER_TYPE` (append cap). */
  maxCredentialsPerType: number;
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
  /** True behind a TLS-terminating proxy: enables `Secure` cookies and `X-Forwarded-For`. */
  trustProxy: boolean;
  logLevel: LogLevel;
  /** Master secret; every other key is HKDF-derived from it. */
  secretKey: string;
  /** Session idle lifetime in seconds (sliding). */
  sessionTtlSeconds: number;
  /** Whether the `/api/auth/*` rate limiter is installed. Off under `NEXUS_ENV=test`. */
  rateLimitEnabled: boolean;
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

  NEXUS_HOST: stringish('127.0.0.1'),
  NEXUS_PORT: intish(8787, 0, 65_535),
  NEXUS_PUBLIC_URL: stringish('http://127.0.0.1:5173'),
  NEXUS_TRUST_PROXY: boolish(false),
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
  FERRUM_ADMIN_CA_FILE: optionalString(),
  FERRUM_ADMIN_ALLOW_INSECURE_HTTP: boolish(false),
  FERRUM_ADMIN_TIMEOUT_MS: intish(5_000, 250, 60_000),
  FERRUM_MAX_CREDENTIALS_PER_TYPE: intish(2, 1, 10),

  NEXUS_SMTP_HOST: optionalString(),
  NEXUS_SMTP_PORT: intish(587, 1, 65_535),
  NEXUS_SMTP_SECURE: boolish(false),
  NEXUS_SMTP_USER: optionalString(),
  NEXUS_SMTP_PASSWORD: optionalString(),
  NEXUS_EMAIL_FROM: stringish('Ferrum Nexus <no-reply@example.com>'),
});

const NAMESPACE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

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
    trustProxy: raw.NEXUS_TRUST_PROXY,
    logLevel: raw.NEXUS_LOG_LEVEL,
    secretKey: raw.NEXUS_SECRET_KEY,
    sessionTtlSeconds: raw.NEXUS_SESSION_TTL,
    rateLimitEnabled: nodeEnv === 'test' ? false : raw.NEXUS_RATE_LIMIT_ENABLED,
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
      caFile: raw.FERRUM_ADMIN_CA_FILE,
      allowInsecureHttp: raw.FERRUM_ADMIN_ALLOW_INSECURE_HTTP,
      timeoutMs: raw.FERRUM_ADMIN_TIMEOUT_MS,
      maxCredentialsPerType: raw.FERRUM_MAX_CREDENTIALS_PER_TYPE,
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

function configError(problems: string[]): NexusError {
  return new NexusError('INTERNAL', `Invalid configuration: ${problems.join('; ')}`, { problems });
}
