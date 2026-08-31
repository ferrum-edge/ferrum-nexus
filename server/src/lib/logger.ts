/**
 * Fastify logger options.
 *
 * The only interesting part is the redaction list: cookies and `Authorization`
 * headers must never reach a log line, in either direction. Nexus session
 * cookies are bearer-equivalent, and the outbound `Authorization` header
 * carries a live Ferrum Edge admin JWT.
 */

import type { FastifyServerOptions } from 'fastify';

import type { NexusConfig } from '../config/index.js';

/** Paths pino replaces with `[Redacted]` before serialising a log record. */
export const REDACTED_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-nexus-csrf"]',
  'res.headers["set-cookie"]',
  'headers.cookie',
  'headers.authorization',
  'password',
  'new_password',
  'current_password',
  'secret',
  'secret_key',
  'jwt_secret',
  'captcha_token',
  '*.password',
  '*.secret',
] as const;

/** Fastify's logger option — either pino options or `false` for a silent instance. */
export type LoggerOptions = FastifyServerOptions['logger'];

/**
 * Build the logger options for a config. `NEXUS_LOG_LEVEL=silent` (or the
 * `test` environment without an explicit level) disables logging entirely so
 * `node --test` output stays readable.
 */
export function buildLoggerOptions(config: NexusConfig): LoggerOptions {
  if (config.logLevel === 'silent') return false;
  return {
    level: config.logLevel,
    redact: { paths: [...REDACTED_PATHS], censor: '[Redacted]' },
    serializers: {
      req(request: { method?: string; url?: string; ip?: string }) {
        return { method: request.method, url: request.url, ip: request.ip };
      },
    },
  };
}
