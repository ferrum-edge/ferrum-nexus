/**
 * Ferrum Edge Admin API integration.
 *
 * Import the client from here, never from `client.ts` directly, so the module
 * boundary stays obvious: nothing outside `ferrum-admin/` may know Edge's HTTP
 * shape.
 */

import type { NexusConfig } from '../config/index.js';
import type { LeaseRepo } from '../db/store.js';
import {
  createFerrumAdminClient,
  silentEdgeLogger,
  type EdgeLogger,
  type FerrumAdminClient,
} from './client.js';

export {
  createFerrumAdminClient,
  createKeyedSerializer,
  silentEdgeLogger,
  LEASE_POLL_MS,
  LEASE_TTL_MS,
  LEASE_WAIT_MS,
  type EdgeLogger,
  type FerrumAdminClient,
  type FerrumAdminClientDeps,
  type KeyedSerializer,
  type KeyedSerializerOptions,
} from './client.js';

export {
  createAdminTokenMinter,
  signAdminJwt,
  DEFAULT_ADMIN_SUBJECT,
  MAX_TTL_SECONDS,
  MIN_SECRET_LENGTH,
  type AdminTokenMinter,
  type EdgeRole,
  type SignAdminJwtOptions,
} from './jwt.js';

export type * from './types.js';

/**
 * Build the Edge client from the whole Nexus config.
 *
 * This is the composition-root entry point; `main()` calls it (or `buildServer`
 * accepts an injected client in tests).
 *
 * `leases` is what makes the client's per-resource serialisation hold across
 * instances rather than only within this process. It is optional so a
 * throwaway client (a config probe, a unit test) needs no store, but every
 * process that mutates the gateway must pass `store.leases`.
 */
export function createFerrumAdmin(
  config: NexusConfig,
  logger: EdgeLogger = silentEdgeLogger,
  leases?: LeaseRepo,
): FerrumAdminClient {
  return createFerrumAdminClient(config.edge, logger, leases === undefined ? {} : { leases });
}
