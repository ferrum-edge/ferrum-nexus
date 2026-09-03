/**
 * Turning a stored `apis` row into the wire {@link Api}.
 *
 * Two fields exist only on the wire: `listen_path`, which is always
 * `/<namespace>/<slug>`, and `invoke_url`, the absolute address a client sends
 * traffic to. Neither is stored — an API's listen path follows its namespace
 * and slug, and the gateway's public origin is an operator setting that can
 * change without touching a single API row.
 *
 * Every route and service that returns an {@link Api} or an embedded
 * {@link ApiSummary} goes through here, so "where do I call this?" is answered
 * the same way on the catalog, on a grant and in a message thread.
 *
 * When no origin is configured `invoke_url` is `null`. Nexus deliberately does
 * not fall back to the Admin API's host or the portal's: those are different
 * listeners, and a plausible-looking wrong URL is worse for a client than an
 * honest absent one.
 */

import { listenPathFor, type Api, type ApiSummary } from '@ferrum-nexus/shared';

import type { ApiRecord } from '../db/store.js';

/**
 * Anything that can resolve the gateway's public origin — the settings service
 * in production, which prefers the stored `gateway.public_url` over
 * `FERRUM_GATEWAY_PUBLIC_URL` and caches the answer for a few seconds.
 */
export interface GatewayUrlSource {
  /** The configured proxy-listener origin, or `null` when there is none. */
  getGatewayPublicUrl(): Promise<string | null>;
}

/** `<origin><listen path>`, or `null` when no origin is configured. */
export function invokeUrlFor(listenPath: string, gatewayPublicUrl: string | null): string | null {
  return gatewayPublicUrl === null ? null : `${gatewayPublicUrl}${listenPath}`;
}

/** A stored row as the API serialises it. */
export function presentApi(record: ApiRecord, gatewayPublicUrl: string | null): Api {
  const listenPath = listenPathFor(record.namespace, record.slug);
  return {
    ...record,
    listen_path: listenPath,
    invoke_url: invokeUrlFor(listenPath, gatewayPublicUrl),
  };
}

/** The compact reference embedded in access requests, grants and threads. */
export function presentApiSummary(record: ApiRecord, gatewayPublicUrl: string | null): ApiSummary {
  const listenPath = listenPathFor(record.namespace, record.slug);
  return {
    id: record.id,
    name: record.name,
    slug: record.slug,
    version: record.version,
    owner_user_id: record.owner_user_id,
    listen_path: listenPath,
    invoke_url: invokeUrlFor(listenPath, gatewayPublicUrl),
  };
}
