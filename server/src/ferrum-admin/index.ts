/**
 * Ferrum Edge Admin API integration.
 *
 * Import the client from here, never from `client.ts` directly, so the module
 * boundary stays obvious: nothing outside `ferrum-admin/` may know Edge's HTTP
 * shape.
 */

import type { NexusConfig } from '../config/index.js';
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
  type EdgeLogger,
  type FerrumAdminClient,
  type KeyedSerializer,
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
 * This is the composition-root entry point; `buildServer` calls it (or accepts
 * an injected client in tests).
 */
export function createFerrumAdmin(
  config: NexusConfig,
  logger: EdgeLogger = silentEdgeLogger,
): FerrumAdminClient {
  return createFerrumAdminClient(config.edge, logger);
}
