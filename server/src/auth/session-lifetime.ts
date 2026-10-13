/**
 * Session validity, shared by every place that accepts a session row: the
 * request hook in `middleware/auth-plugin.ts`, the SSO linking transaction,
 * and the SPA shell's Content-Security-Policy check.
 *
 * A session is live while it is inside both its sliding expiry
 * (`expires_at`) and its absolute lifetime, `NEXUS_SESSION_MAX_AGE` seconds
 * after `created_at` (issue #582). Activity never carries a session past the
 * second.
 */

import type { NexusConfig } from '../config/index.js';
import type { SessionRecord } from '../db/store.js';

/**
 * The epoch-millisecond instant after which `session` is dead whatever its
 * sliding expiry says: `created_at` plus `NEXUS_SESSION_MAX_AGE`.
 *
 * A row whose `created_at` does not parse yields `-Infinity`, so it reads as
 * already past its cap: an unreadable timestamp must not mean "no cap".
 */
export function sessionAbsoluteDeadlineMs(
  session: Pick<SessionRecord, 'created_at'>,
  config: Pick<NexusConfig, 'sessionMaxAgeSeconds'>,
): number {
  const createdAt = Date.parse(session.created_at);
  if (!Number.isFinite(createdAt)) return Number.NEGATIVE_INFINITY;
  return createdAt + config.sessionMaxAgeSeconds * 1000;
}

/**
 * Whether `session` is still usable at `now`: inside both its sliding expiry
 * and its absolute lifetime. An unreadable `expires_at` is not usable either.
 */
export function sessionIsLive(
  session: Pick<SessionRecord, 'created_at' | 'expires_at'>,
  config: Pick<NexusConfig, 'sessionMaxAgeSeconds'>,
  now: number,
): boolean {
  const expiresAt = Date.parse(session.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return false;
  return sessionAbsoluteDeadlineMs(session, config) > now;
}
