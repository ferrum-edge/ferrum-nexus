/**
 * Centralized configuration loader. Reads from environment variables (already
 * loaded into `process.env` by dotenv) and produces a strongly-typed
 * `ResolvedConfig` consumed throughout the server.
 *
 * Required environment variables fail loudly at startup so misconfigurations
 * never silently weaken security.
 */

import { z } from 'zod';

const DbDriver = z.enum(['sqlite', 'postgres', 'mysql', 'mongodb']);
const EnvBoolean = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off', ''].includes(normalized)) return false;
  return value;
}, z.boolean());

const Schema = z.object({
  nodeEnv: z.enum(['development', 'production', 'test']).default('development'),
  host: z.string().default('127.0.0.1'),
  port: z.coerce.number().int().positive().default(8787),
  publicUrl: z.string().url().default('http://127.0.0.1:8787'),
  corsOrigins: z.string().default(''),
  trustProxy: EnvBoolean.default(false),
  secretKey: z
    .string()
    .min(32, 'NEXUS_SECRET_KEY must be at least 32 characters (use `openssl rand -hex 32`).'),

  db: z.object({
    driver: DbDriver.default('sqlite'),
    url: z.string().optional(),
    /**
     * When the driver is `mongodb`, refuse to start if the target deployment
     * isn't a replica set. Set to false (NEXUS_DB_ALLOW_STANDALONE=true) only
     * if you accept that multi-document workflows (credential rotation, grant
     * approval) will not be atomic.
     */
    requireReplicaSet: EnvBoolean.default(true),
  }),

  session: z.object({
    cookieName: z.string().default('nexus_sid'),
    ttlSeconds: z.coerce.number().int().positive().default(86_400),
    secure: EnvBoolean.default(false),
  }),

  ferrum: z.object({
    adminUrl: z.string().url(),
    jwtSecret: z.string().min(16),
    jwtIssuer: z.string().default('ferrum-nexus'),
    jwtSubject: z.string().default('nexus-bff'),
    jwtRole: z.string().default('admin'),
    jwtTtl: z.coerce.number().int().positive().default(300),
    defaultNamespace: z.string().default('default'),
    caPath: z.string().optional(),
  }),

  email: z.object({
    from: z.string().default('Ferrum Nexus <noreply@example.com>'),
    smtpHost: z.string().optional(),
    smtpPort: z.coerce.number().int().positive().default(587),
    smtpUsername: z.string().optional(),
    smtpPassword: z.string().optional(),
    smtpSecure: EnvBoolean.default(false),
  }),
});

export type ResolvedConfig = z.infer<typeof Schema>;

export function loadConfig(): ResolvedConfig {
  const parsed = Schema.safeParse({
    nodeEnv: process.env.NODE_ENV,
    host: process.env.NEXUS_HOST,
    port: process.env.NEXUS_PORT,
    publicUrl: process.env.NEXUS_PUBLIC_URL,
    corsOrigins: process.env.NEXUS_CORS_ORIGINS,
    trustProxy: process.env.NEXUS_TRUST_PROXY,
    secretKey: process.env.NEXUS_SECRET_KEY,
    db: {
      driver: process.env.NEXUS_DB_DRIVER,
      url: process.env.NEXUS_DB_URL,
      requireReplicaSet:
        process.env.NEXUS_DB_ALLOW_STANDALONE === undefined
          ? undefined
          : process.env.NEXUS_DB_ALLOW_STANDALONE === 'true'
            ? false
            : true,
    },
    session: {
      cookieName: process.env.NEXUS_SESSION_COOKIE_NAME,
      ttlSeconds: process.env.NEXUS_SESSION_TTL_SECONDS,
      secure: process.env.NEXUS_SESSION_SECURE,
    },
    ferrum: {
      adminUrl: process.env.FERRUM_ADMIN_URL,
      jwtSecret: process.env.FERRUM_ADMIN_JWT_SECRET,
      jwtIssuer: process.env.FERRUM_ADMIN_JWT_ISSUER,
      jwtSubject: process.env.FERRUM_ADMIN_JWT_SUBJECT,
      jwtRole: process.env.FERRUM_ADMIN_JWT_ROLE,
      jwtTtl: process.env.FERRUM_ADMIN_JWT_TTL,
      defaultNamespace: process.env.FERRUM_DEFAULT_NAMESPACE,
      caPath: process.env.FERRUM_ADMIN_CA_PATH,
    },
    email: {
      from: process.env.NEXUS_EMAIL_FROM,
      smtpHost: process.env.NEXUS_SMTP_HOST,
      smtpPort: process.env.NEXUS_SMTP_PORT,
      smtpUsername: process.env.NEXUS_SMTP_USERNAME,
      smtpPassword: process.env.NEXUS_SMTP_PASSWORD,
      smtpSecure: process.env.NEXUS_SMTP_SECURE,
    },
  });

  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const data = parsed.data;
  if (process.env.NEXUS_SESSION_SECURE === undefined) {
    data.session.secure = data.nodeEnv === 'production';
  }
  return data;
}
