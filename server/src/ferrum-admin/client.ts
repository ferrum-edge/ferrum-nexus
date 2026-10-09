/**
 * The only module in Nexus that speaks the Ferrum Edge Admin API's HTTP shape.
 *
 * Everything above it deals in domain objects and `NexusError`s. Failures are
 * classified into four codes:
 *
 * - `EDGE_UNAVAILABLE` — DNS, connect, TLS, socket or timeout. A write may
 *   already have reached the gateway; the client never retries it. A **read**
 *   whose pooled connection the gateway closed before answering is retried
 *   once on a fresh connection inside the same deadline first — see
 *   {@link shouldRetryOnFreshConnection}.
 * - `EDGE_ERROR` — a refused request.
 * - `EDGE_REJECTED_SPEC` — a 4xx API-spec parse/validation refusal (HTTP 400).
 * - `EDGE_PROTOCOL_ERROR` — an invalid HTTP/JSON response.
 *
 * Edge's flat `{"error": "..."}` text is logged. Whether it is *also* echoed to
 * the caller depends on who the message is about:
 *
 * - `400`, `409` and `422` are Edge validating the body Nexus just built out of
 *   the caller's own request ("FERRUM_BASIC_AUTH_HMAC_SECRET must be set…",
 *   "listen_path already exists in this namespace"). A provider cannot fix
 *   those without reading them, so the text rides along in
 *   `details.gateway_message` (trimmed to {@link MAX_GATEWAY_MESSAGE} chars).
 * - `401`, `403` and every `5xx` stay **opaque**: those describe the gateway's
 *   own configuration or the Nexus↔Edge trust relationship, not the caller's
 *   request, and can name internal hosts and settings.
 *
 * Credential writes to `/consumers` carry show-once material; their Edge error
 * bodies are untrusted and are never logged or returned, and the two rules
 * above do not apply to them. Every other endpoint keeps the behaviour above.
 *
 * A `503` carrying `applied: false` is a special case worth knowing about: the
 * write **is durable**, it just is not live yet. It surfaces as `EDGE_ERROR`
 * with an explicit message and is never retried automatically — a blind retry
 * of a create would `409`.
 */

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { TextDecoder } from 'node:util';

import { Agent, request, type Dispatcher } from 'undici';

import {
  FERRUM_NAMESPACE_HEADER,
  FERRUM_PROVISIONED_BY_HEADER,
  FERRUM_PROVISIONED_BY_VALUE,
  type ApiUsageUnavailableCode,
  type EdgeCredentialType,
} from '@ferrum-nexus/shared';

import type { EdgeConfig } from '../config/index.js';
import type { LeaseRepo } from '../db/store.js';
import { conflict, edgeError, edgeUnavailable, internal, NexusError } from '../lib/errors.js';
import { createKeyedSerializer, type KeyedSerializer } from '../lib/keyed-serializer.js';
import {
  createAdminTokenMinter,
  createFleetReadTokenMinter,
  DEFAULT_ADMIN_SUBJECT,
  type AdminTokenMinter,
} from './jwt.js';
import {
  createNamespaceMonitor,
  parseNamespaceServing,
  NAMESPACE_UNSERVED_HEADER,
  NAMESPACE_UNSERVED_HEADER_VALUE,
  type NamespaceMonitor,
} from './namespace.js';
import { parsePrometheusText, type PrometheusSample } from './prometheus.js';
import {
  assessBackendEgress,
  createDataPlaneSightings,
  describeDataPlaneAttestation,
  isUnsupportedEgressPolicySchema,
  readBackendEgressPolicy,
  type BackendEgressAdmission,
  type BackendEgressPolicy,
  type BackendEgressPolicyReading,
  type DataPlaneFreshness,
} from './egress-policy.js';
import type {
  EdgeApiSpecDocument,
  EdgeApiSpecPage,
  EdgeApiSpecRef,
  EdgeApiSpecSummary,
  EdgeBackendState,
  EdgeCircuitBreaker,
  EdgeConsumer,
  EdgeConsumerWrite,
  EdgeConsumerReplacement,
  EdgeVerifiedConsumer,
  EdgeCredentialEntry,
  EdgeDeploymentAcknowledgement,
  EdgeDeploymentSnapshot,
  EdgeHealth,
  EdgeLatencyBucket,
  EdgeListQuery,
  EdgePage,
  EdgePluginConfig,
  EdgePluginConfigWrite,
  EdgeProbe,
  EdgeProxy,
  EdgeProxyMetrics,
  EdgeProxyReplace,
  EdgeProxyWrite,
  EdgeUnhealthyTarget,
} from './types.js';
import { consumerMetadataCredentials } from './consumer-metadata.js';
import {
  assertDeploymentApplied,
  assertDeploymentEvidence,
  deploymentTarget,
  isDeploymentAcknowledgement,
  isDeploymentNonCommit,
  isDeploymentSnapshot,
  isDeploymentTag,
  isSnapshotTooLargeRefusal,
} from './deployment.js';

/** Minimal logger surface, so this module does not depend on Fastify. */
export interface EdgeLogger {
  debug(obj: Record<string, unknown>, message?: string): void;
  warn(obj: Record<string, unknown>, message?: string): void;
  error(obj: Record<string, unknown>, message?: string): void;
}

/** A logger that drops everything — the default when none is supplied. */
export const silentEdgeLogger: EdgeLogger = {
  debug: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/* ── Per-key serialization ──────────────────────────────────────────────── */

/**
 * Re-exported from `lib/keyed-serializer.ts`, which is where it lives now.
 *
 * The store-level locks in the composition root take the same kind of section
 * over the same `leases` table, and that has nothing to do with the gateway —
 * so the implementation moved out of this module and the Edge client became
 * one of its two callers. Importing it from `ferrum-admin/` still works.
 */
export {
  createKeyedSerializer,
  LEASE_CONFLICT_MESSAGE,
  LEASE_POLL_MS,
  LEASE_TTL_MS,
  LEASE_WAIT_MS,
  type KeyedSerializer,
  type KeyedSerializerOptions,
} from '../lib/keyed-serializer.js';

/* ── Client ─────────────────────────────────────────────────────────────── */

/** Options for one Admin API call. */
interface CallOptions {
  /** Shared deadline for a sequence of health-probe calls. */
  signal?: AbortSignal;
  /** JSON request body. */
  body?: unknown;
  /** Query string parameters; `undefined` values are dropped. */
  query?: Record<string, string | number | boolean | undefined>;
  /** Return `null` instead of throwing when Edge answers `404`. */
  allow404?: boolean;
  /**
   * With `allow404`, the exact `error` Edge answers a missing resource with. A
   * `404` then reads as absence only when its body is that acknowledgement;
   * any other `404` — an unknown route, a proxy in front of Edge, an HTML page —
   * proves nothing about the resource and is a protocol error (issue #535).
   */
  absentError?: string;
  /** Additional statuses to treat as success (e.g. `409` for "already exists"). */
  tolerate?: number[];
  /** Override the JWT `sub` claim so Edge's audit log names the acting user. */
  subject?: string;
  /** Sign with this minter instead of the admin one (the fleet-read token). */
  minter?: AdminTokenMinter;
  /**
   * Skip the per-call log of a gateway error status, every one (`true`) or
   * those listed: the caller logs the failure itself, once per change rather
   * than once per call.
   */
  quiet?: true | readonly number[];
  /** Refuse to buffer a response larger than this many bytes. */
  maxResponseBytes?: number;
  ifMatch?: string;
  /** Released deployment-v1 partial write, with its own response and secret boundary. */
  deployment?: boolean;
  /** Recreate retained resources without adding informational origin labels. */
  preserveLabels?: true;
  /** Keep the matching response headers with this call, never in shared state. */
  responseHeaders?: (headers: Record<string, string | string[] | undefined>) => void;
}

/** Typed client for the subset of the Ferrum Edge Admin API that Nexus uses. */
export interface FerrumAdminClient {
  /** Namespace sent in `X-Ferrum-Namespace` on every namespace-scoped call. */
  readonly namespace: string;

  /**
   * Whether the gateway's data plane actually routes {@link namespace}.
   *
   * Fed by {@link probe} (the `namespace` block of the authenticated health
   * payload) and by the `X-Ferrum-Namespace-Unserved` header this client
   * watches on every accepted mutation. Reading it costs nothing — it never
   * touches the network — so a request path may gate on it per call.
   */
  readonly namespaceMonitor: NamespaceMonitor;

  /**
   * Authenticated `GET /health` — reports `status`, `ready`, `mode` and
   * `admin_writes_enabled`.
   *
   * Edge answers **`503` with a complete health payload** whenever it is not
   * ready (`starting`, `draining`, `unavailable`). That is a reachable gateway
   * reporting its own state, so the body is parsed and returned rather than
   * classified as a failure; only a `503` that is *not* a health payload (or
   * any other non-2xx) throws.
   */
  health(): Promise<EdgeHealth>;
  /** Unauthenticated `GET /live`. `true` when the gateway answered `200`. */
  live(): Promise<boolean>;
  /**
   * Best-effort version probe. Edge has **no `/version` endpoint** (none in its
   * `docs/admin_api.md`), so this returns `null` on a 404 rather than
   * failing; take the real version from your deployment metadata. Edge v0.9.16
   * answers an unknown global path `403` to a token with an `ns` claim, which is
   * the same "no endpoint" and also reads `null`; because a `403` can also be a
   * refused credential, it is logged distinctly (once per transition).
   */
  version(): Promise<string | null>;
  /** Combined reachability probe for `GET /api/health`; never throws. */
  probe(timeoutMs?: number): Promise<EdgeProbe>;
  /** Fresh authenticated process policy; never backed by health or startup caches. */
  backendEgressPolicy(signal?: AbortSignal): Promise<BackendEgressPolicy>;
  /**
   * Admission before side effects; each backend write repeats it at the
   * boundary. Returns the bounded verdict the caller records in its audit row.
   */
  assertBackendEgress(): Promise<BackendEgressAdmission>;

  readonly deployments: {
    snapshot(subject?: string): Promise<EdgeDeploymentSnapshot>;
    /**
     * Every check `remove`/`replace` makes before sending anything: evidence,
     * target ownership and fresh egress admission. A caller journals a pending
     * mutation only after this passes, so a refusal here never leaves an
     * unconfirmed entry behind. `remove`/`replace` repeat it at the boundary;
     * a refusal there is marked {@link deploymentNotDispatched}.
     */
    prepare(
      kind: 'remove' | 'replace',
      id: string,
      original: EdgeDeploymentSnapshot,
    ): Promise<void>;
    remove(id: string, original: EdgeDeploymentSnapshot, subject?: string): Promise<void>;
    replace(
      id: string,
      document: EdgeApiSpecDocument,
      original: EdgeDeploymentSnapshot,
      subject?: string,
    ): Promise<void>;
  };

  /**
   * `GET /namespaces` — a list of name strings. Edge v0.9.16 lists only the
   * namespaces the token's `ns` claim names, so for this portal at most its own.
   */
  listNamespaces(): Promise<string[]>;
  /**
   * Make sure the configured namespace exists. Writing any resource with a new
   * `X-Ferrum-Namespace` already isolates data, so a failure here is logged and
   * swallowed rather than blocking startup.
   */
  ensureNamespace(description?: string): Promise<void>;
  /** Create the namespace-global metrics prerequisite if absent; return only a new config. */
  ensureMetricsConfig(): Promise<EdgePluginConfig | null>;

  readonly consumers: {
    list(query?: EdgeListQuery): Promise<EdgePage<EdgeConsumer>>;
    /**
     * `null` for a `404`. With `confirmedAbsence`, only for Edge's own
     * `Consumer not found` answer: any other `404` is a protocol error, for a
     * caller that acts on the consumer being gone (issue #535).
     */
    get(id: string, options?: { confirmedAbsence?: boolean }): Promise<EdgeConsumer | null>;
    /** Credential-bearing snapshot. Keep it transient and inside the server boundary. */
    verification(
      id: string,
      subject?: string,
    ): Promise<{ consumer: EdgeVerifiedConsumer; etag: string } | null>;
    /**
     * Find a consumer by `username` by scanning `GET /consumers` pages — Edge
     * has no username filter. Nexus normally reads the mapping from its own
     * `consumers` table; this is the reconciliation path.
     *
     * `null` means the whole namespace was read and holds no such consumer.
     * A scan that reaches its page cap without a match **throws** rather than
     * answering `null`: on a gateway that large "not found" would only mean
     * "not searched", and a caller acting on it — creating a duplicate, or
     * closing a teardown with the consumer still up — would be wrong.
     */
    getByUsername(username: string): Promise<EdgeConsumer | null>;
    /**
     * The id {@link ensure} assigns to the first consumer of `username` in the
     * configured namespace, without touching the gateway. Not the id of a
     * consumer that replaces it — see {@link derivedConsumerId}.
     */
    derivedId(username: string): string;
    /** Direct stable-id lookup/create; only a legacy identity conflict scans. */
    ensure(
      body: EdgeConsumerWrite,
      subject?: string,
    ): Promise<{ consumer: EdgeConsumer; created: boolean }>;
    create(body: EdgeConsumerWrite, subject?: string): Promise<EdgeConsumer>;
    /**
     * Metadata replace from `verification()` via the owner projection and original row tag.
     * No automatic retry: a stale snapshot must be read and recomputed.
     */
    replace(
      id: string,
      body: EdgeConsumerReplacement,
      subject?: string,
      ifMatch?: string,
    ): Promise<EdgeConsumer>;
    delete(id: string, subject?: string): Promise<void>;
    /** Append one credential entry (rotation step 1). */
    addCredential(
      id: string,
      type: EdgeCredentialType,
      entry: EdgeCredentialEntry,
      subject?: string,
    ): Promise<EdgeConsumer>;
    /** Replace every entry of a credential type. */
    replaceCredentials(
      id: string,
      type: EdgeCredentialType,
      entries: EdgeCredentialEntry[],
      subject?: string,
    ): Promise<EdgeConsumer>;
    /** Remove one entry by 0-based index (rotation step 3); the array re-indexes. */
    deleteCredentialAt(
      id: string,
      type: EdgeCredentialType,
      index: number,
      subject?: string,
    ): Promise<EdgeConsumer>;
    /** Remove a whole credential type. Idempotent for the built-in types. */
    deleteCredentialType(id: string, type: EdgeCredentialType, subject?: string): Promise<void>;
  };

  readonly proxies: {
    list(query?: EdgeListQuery): Promise<EdgePage<EdgeProxy>>;
    /**
     * `null` for a `404`. With `confirmedAbsence`, only for Edge's own
     * `Proxy not found` answer: any other `404` is a protocol error, for a
     * caller that acts on the proxy being gone (issue #548).
     */
    get(id: string, options?: { confirmedAbsence?: boolean }): Promise<EdgeProxy | null>;
    create(
      body: EdgeProxyWrite,
      subject?: string,
      options?: { preserveLabels: true },
    ): Promise<EdgeProxy>;
    /**
     * Whole-resource replace. The body must be a `GET` response with the
     * changed fields overwritten — see {@link EdgeProxyReplace}.
     */
    replace(id: string, body: EdgeProxyReplace, subject?: string): Promise<EdgeProxy>;
    /**
     * Already gone counts as deleted only on Edge's own `Proxy not found`
     * answer; any other `404` is a protocol error (issue #548).
     */
    delete(
      id: string,
      subject?: string,
      options?: { cleanupOrphanedUpstream: false },
    ): Promise<void>;
  };

  readonly pluginConfigs: {
    list(query?: EdgeListQuery): Promise<EdgePage<EdgePluginConfig>>;
    /**
     * Every plugin config attached to one proxy.
     *
     * Reads `GET /plugins/config?proxy_id=…` (Edge v0.9.7+), which filters on
     * the gateway and counts `pagination.total` over the filtered set. Edge
     * still clamps `limit` to its `MAX_PAGE_SIZE` of 1000, so this walks every
     * page of that set: a single-page read would silently truncate a proxy
     * carrying more than 1000 configs.
     */
    listByProxy(proxyId: string): Promise<EdgePluginConfig[]>;
    /**
     * `null` for a `404`. With `confirmedAbsence`, only for Edge's own
     * `Plugin config not found` answer: any other `404` is a protocol error,
     * for a caller that acts on the config being gone (issue #548).
     */
    get(id: string, options?: { confirmedAbsence?: boolean }): Promise<EdgePluginConfig | null>;
    create(
      body: EdgePluginConfigWrite,
      subject?: string,
      options?: { preserveLabels: true },
    ): Promise<EdgePluginConfig>;
    replace(id: string, body: EdgePluginConfigWrite, subject?: string): Promise<EdgePluginConfig>;
    /**
     * Already gone counts as deleted only on Edge's own `Plugin config not
     * found` answer; any other `404` is a protocol error (issue #548).
     */
    delete(id: string, subject?: string): Promise<void>;
  };

  /**
   * The API-spec importer — Edge's *only* route to an `openapi_validator`.
   *
   * A proxy submitted this way is **spec-owned**: Edge stamps `api_spec_id` on
   * it, generates the validator from the document's operation table and
   * associates it, all in one transaction. Admission then refuses a hand-built
   * `openapi_validator` on any proxy without that stamp, which is why
   * `routes` enforcement cannot be expressed as a plugin config Nexus composes
   * itself (issue #49).
   *
   * Ownership is one spec per proxy (`UNIQUE(namespace, proxy_id)`) and the
   * cascade runs both ways: deleting the spec deletes the proxy, and deleting
   * the proxy deletes the spec.
   */
  readonly apiSpecs: {
    /**
     * Submit a document; Edge creates the proxy named by `x-ferrum-proxy.id`
     * and the plugins the extensions describe.
     *
     * Conflicts on an existing proxy id, an existing listen path, or a proxy
     * that already has a spec, so converting a hand-owned proxy to a
     * spec-owned one means deleting it first.
     */
    create(
      document: EdgeApiSpecDocument,
      subject?: string,
      options?: { preserveLabels: true },
    ): Promise<EdgeApiSpecRef>;
    /**
     * Replace the document. Edge re-inserts the proxy **from the submitted
     * `x-ferrum-proxy`** and regenerates the spec-owned plugins; hand-owned
     * plugin configs and their associations survive untouched.
     *
     * Because the proxy is re-inserted rather than merged, the body must be
     * built from a fresh `proxies.get()` or every field it omits reverts.
     */
    replace(id: string, document: EdgeApiSpecDocument, subject?: string): Promise<EdgeApiSpecRef>;
    /**
     * The spec that owns `proxyId`, or `null`.
     *
     * Reads `GET /api-specs?proxy_id=…` rather than
     * `GET /api-specs/by-proxy/{id}`, which returns the raw *document* and not
     * the id Nexus needs. Same reasoning as the plugin configs: Nexus stores no
     * Edge spec id and looks it up from the proxy whenever one is needed.
     */
    findByProxy(proxyId: string): Promise<EdgeApiSpecSummary | null>;
    /** Stored document, used to verify deployment configuration and spec ownership. */
    documentByProxy(proxyId: string): Promise<Record<string, unknown> | null>;
    /**
     * Delete the spec — and, by cascade, its proxy and every plugin on it.
     * Already gone counts as deleted only on Edge's own `API spec not found`
     * answer; any other `404` is a protocol error (issue #548).
     */
    delete(id: string, subject?: string): Promise<void>;
  };

  /**
   * Read-only runtime telemetry for one proxy.
   *
   * Both calls are **best-effort diagnostics and never throw**: an unreachable
   * gateway, a non-2xx answer or an unparseable body all resolve to a result
   * with `available: false`, empty counters and a `reason`. They are rendered
   * on a provider's overview card, and a gateway hiccup must not turn that page
   * into an error.
   *
   * Both endpoints are fleet-global, so Edge v0.9.16 refuses the portal's
   * namespace-scoped admin token on them with `403`. Each therefore has its own
   * optional credential, and a refusal reads as unavailable with the cause,
   * never as "no traffic" or "no circuit breakers".
   *
   * Both are cached in-process per proxy for {@link METRICS_CACHE_TTL_MS}. Edge
   * caches its own rendering for 5 seconds, so polling faster than this buys
   * nothing but load.
   */
  readonly metrics: {
    /**
     * Scrape `GET /metrics` and reduce the Prometheus exposition to this
     * proxy's request counters and latency histogram. Presents the gateway's
     * metrics bearer token when `FERRUM_METRICS_BEARER_TOKEN` is set, and the
     * admin JWT otherwise.
     */
    scrapeProxy(proxyId: string): Promise<EdgeProxyMetrics>;
    /**
     * Read `GET /admin/metrics` and pick out this proxy's circuit breakers and
     * unhealthy targets. Signs with the fleet-read key when
     * `FERRUM_ADMIN_FLEET_READ_JWT_SECRET` is set, and the admin key otherwise.
     */
    backendState(proxyId: string): Promise<EdgeBackendState>;
  };

  /**
   * Run work exclusively per Edge resource — across every Nexus instance when
   * the client was built with a `leases` repository. See
   * {@link createKeyedSerializer}.
   */
  serializePerKey: KeyedSerializer;

  /** Release the undici dispatcher. */
  close(): Promise<void>;
}

const MAX_CONSUMER_SCAN_PAGES = 20;
const CONSUMER_SCAN_PAGE_SIZE = 500;

/**
 * How many consumers `consumers.getByUsername` reads before giving up. Past
 * this the lookup throws instead of answering `null`, because "not in the
 * first 10,000" is not "not there".
 */
export const CONSUMER_SCAN_LIMIT = MAX_CONSUMER_SCAN_PAGES * CONSUMER_SCAN_PAGE_SIZE;

/**
 * The consumer id Nexus assigns to the **first** consumer of `username` in
 * `namespace`.
 *
 * UUIDv8: a domain-separated SHA-256 of the namespace and the canonical name.
 * Edge accepts caller-assigned ids, so {@link FerrumAdminClient.consumers}'
 * `ensure` creates under this one — which makes it a *pure function of the
 * name*, computable without asking the gateway anything, and lets a create
 * whose acknowledgement was lost be resolved with a single
 * `GET /consumers/{id}` rather than a namespace-wide username scan (issue
 * #139). Keep the derivation stable across restores.
 *
 * It is deliberately **not** the id of a consumer that *replaces* one of the
 * same name: a replacement must be a distinct resource, or the rows keyed on
 * the replaced consumer's id (`credential_metadata.ferrum_consumer_id`, and
 * every revocation and lookup that names it) would be indistinguishable from
 * the replacement's. A replacement is named by its creator instead and the id
 * recorded on `gateway_identities` before the `POST`, which buys the same
 * single-`GET` recovery without the collision.
 */
export function derivedConsumerId(namespace: string, username: string): string {
  const bytes = createHash('sha256')
    .update(JSON.stringify(['ferrum-nexus-consumer-v1', namespace, username]))
    .digest();
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

/**
 * Edge's `MAX_PAGE_SIZE` (`src/admin/mod.rs`). A larger `limit` is clamped to
 * this, so asking for more only costs a wasted parameter.
 */
const EDGE_MAX_PAGE_SIZE = 1000;

/**
 * Page cap for a plugin-config scan: 50 × 1000 rows — one proxy's configs for
 * `listByProxy`, the whole namespace for the metrics-config lookup.
 */
const MAX_PLUGIN_CONFIG_SCAN_PAGES = 50;

/** Longest Edge validation text echoed back to the caller. */
const MAX_GATEWAY_MESSAGE = 500;

/** Bound all JSON responses, including intermediary error pages and resource lists. */
export const ADMIN_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;

type BodyValidator = (value: unknown) => boolean;

/** Opaque single strong entity-tag syntax; this does not validate its MAC or freshness. */
function isStrongRowTag(value: unknown): value is string {
  return typeof value === 'string' && /^"[\x21\x23-\x7e]+"(?![\s\S])/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isIdentifier(value: unknown): boolean {
  return isString(value) && value.length > 0;
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(isString);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Edge's `404` `error` for each resource that does not exist in the namespace:
 * `NOT_FOUND_MESSAGE` of its `AdminResource` (`src/admin/crud.rs`), and
 * `ApiSpecError::NotFound` (`src/admin/api_specs/handlers.rs`). Edge answers an
 * unknown route with `{"error": "Not Found"}`, which none of these match.
 */
const CONSUMER_NOT_FOUND = 'Consumer not found';
const PROXY_NOT_FOUND = 'Proxy not found';
const PLUGIN_CONFIG_NOT_FOUND = 'Plugin config not found';
const API_SPEC_NOT_FOUND = 'API spec not found';

/**
 * Whether a `404` body is Edge's `{"error": <expected>}` answer for a missing
 * resource. Anything else — empty, HTML, malformed, a router's generic
 * `{"error": "Not Found"}` — is not evidence of absence. The `error` value is
 * what tells them apart, so a field Edge adds beside it later is ignored.
 */
function isAbsenceAcknowledgement(bytes: Buffer, expected: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    return false;
  }
  return isRecord(parsed) && parsed.error === expected;
}

function isConsumerBody(value: unknown): boolean {
  return (
    isRecord(value) &&
    isIdentifier(value.id) &&
    isIdentifier(value.namespace) &&
    isIdentifier(value.username) &&
    (value.custom_id == null || isString(value.custom_id)) &&
    isRecord(value.credentials) &&
    Object.entries(value.credentials).every(([type, entries]) => {
      if (!Array.isArray(entries) || entries.length === 0 || !entries.every(isRecord)) return false;
      if (type === 'keyauth') return entries.every((entry) => isString(entry.key));
      if (type === 'jwt' || type === 'hmac_auth') {
        return entries.every((entry) => isString(entry.secret));
      }
      if (type === 'mtls_auth') return entries.every((entry) => isString(entry.identity));
      return true;
    }) &&
    isStringArray(value.acl_groups)
  );
}

/** Verification preserves historical JSON credential shapes, unlike ordinary reads. */
function isVerifiedConsumerBody(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !isIdentifier(value.id) ||
    !isIdentifier(value.namespace) ||
    !isString(value.username) ||
    !isRecord(value.credentials) ||
    !isStringArray(value.acl_groups)
  ) {
    return false;
  }
  for (const [type, credential] of Object.entries(value.credentials)) {
    const entries = Array.isArray(credential) ? credential : [credential];
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      if (type === 'basicauth' && 'password' in entry) return false;
      const field = type === 'keyauth' ? 'key' : 'secret';
      if (['keyauth', 'jwt', 'hmac_auth'].includes(type) && entry[field] === '[REDACTED]') {
        return false;
      }
    }
  }
  return true;
}

function isProxyBody(value: unknown): boolean {
  // Preserve unmodelled Edge fields for whole-resource PUTs. Validate the
  // identity and fields Nexus interprets, without imposing HTTP-only routing.
  return (
    isRecord(value) &&
    isIdentifier(value.id) &&
    isIdentifier(value.namespace) &&
    (value.listen_path == null || isString(value.listen_path)) &&
    (value.hosts === undefined || isStringArray(value.hosts)) &&
    (value.backend_host === undefined || isString(value.backend_host)) &&
    (value.backend_port === undefined || isCount(value.backend_port)) &&
    Array.isArray(value.plugins) &&
    value.plugins.every((item) => isRecord(item) && isIdentifier(item.plugin_config_id))
  );
}

function isPluginBody(value: unknown): boolean {
  return (
    isRecord(value) &&
    isIdentifier(value.id) &&
    isIdentifier(value.namespace) &&
    isIdentifier(value.plugin_name) &&
    isString(value.scope) &&
    ['global', 'proxy', 'proxy_group'].includes(value.scope) &&
    (value.proxy_id == null || isIdentifier(value.proxy_id)) &&
    typeof value.enabled === 'boolean' &&
    // Edge permits null for plugins whose settings are all optional (e.g. basic_auth).
    (value.config === null || isRecord(value.config))
  );
}

function isSpecRefBody(value: unknown): boolean {
  return isRecord(value) && isIdentifier(value.id) && isIdentifier(value.proxy_id);
}

function isPageBody(value: unknown, item: BodyValidator): boolean {
  if (!isRecord(value) || !Array.isArray(value.data) || !value.data.every(item)) return false;
  const page = value.pagination;
  return (
    isRecord(page) &&
    isCount(page.offset) &&
    isCount(page.limit) &&
    page.limit > 0 &&
    isCount(page.total) &&
    value.data.length <= page.limit &&
    value.data.length === Math.min(page.limit, Math.max(0, page.total - page.offset))
  );
}

interface ResponseContract {
  statuses: number[];
  body: BodyValidator;
  /** Only an acknowledged no-content write or the status-only liveness probe. */
  empty?: 'void' | 'live';
}

/** Endpoint contracts checked against Edge's admin handlers, not generic HTTP success. */
function responseContract(method: string, path: string): ResponseContract {
  const parts = path.split('/').slice(1);
  const resource = parts[0];
  const credentials = resource === 'consumers' && parts[2] === 'credentials';
  if (method === 'DELETE' && !(credentials && parts.length === 5)) {
    return { statuses: [204], body: () => false, empty: 'void' };
  }
  let body: BodyValidator;
  switch (resource) {
    case 'consumers':
      body = parts[2] === 'verification' ? isVerifiedConsumerBody : isConsumerBody;
      break;
    case 'proxies':
      body = isProxyBody;
      break;
    case 'plugins':
      body = isPluginBody;
      break;
    case 'namespaces':
      body = (value) => isRecord(value) && isIdentifier(value.name);
      break;
    case 'api-specs':
      body = isSpecRefBody;
      if (method === 'GET' && parts[1] === 'by-proxy') {
        body = (value) => isRecord(value) && isString(value.openapi) && isRecord(value.paths);
      } else if (method === 'GET') {
        body = (value) =>
          isRecord(value) &&
          Array.isArray(value.items) &&
          value.items.every(isSpecRefBody) &&
          isCount(value.limit) &&
          value.limit > 0 &&
          isCount(value.offset) &&
          isCount(value.total) &&
          value.items.length <= value.limit &&
          value.items.length === Math.min(value.limit, Math.max(0, value.total - value.offset));
      }
      break;
    case 'health':
      return {
        statuses: [200, 503],
        body: (value) =>
          isRecord(value) &&
          isIdentifier(value.status) &&
          (value.ready === undefined || typeof value.ready === 'boolean') &&
          (value.mode === undefined || isString(value.mode)) &&
          (value.admin_writes_enabled === undefined ||
            typeof value.admin_writes_enabled === 'boolean'),
      };
    case 'backend-egress-policy':
      return {
        statuses: [200],
        body: (value) => isRecord(value) && isString(value.namespace),
      };
    case 'deployment-snapshot':
      return { statuses: [200], body: isDeploymentSnapshot };
    case 'live':
      return {
        statuses: [200],
        body: (value) => isRecord(value) && value.status === 'ok',
        empty: 'live',
      };
    case 'version':
      return { statuses: [200], body: (value) => isRecord(value) && isIdentifier(value.version) };
    case 'admin':
      return {
        statuses: [200],
        body: (value) =>
          isRecord(value) &&
          isRecord(value.gateway) &&
          Array.isArray(value.circuit_breakers) &&
          isRecord(value.health_check) &&
          Array.isArray(value.health_check.unhealthy_targets),
      };
    default:
      throw internal('Missing Ferrum Edge response contract');
  }
  const list = method === 'GET' && parts.length === (resource === 'plugins' ? 2 : 1);
  if (list && resource !== 'api-specs') {
    const item = resource === 'namespaces' ? isString : body;
    body = (value) => isPageBody(value, item);
  }
  return { statuses: [method === 'POST' && !credentials ? 201 : 200], body };
}

/**
 * How long a metrics read is reused before Edge is asked again.
 *
 * Edge renders both `/metrics` and `/admin/metrics` from a 5-second cache, so a
 * shorter TTL here would only add HTTP round trips to identical bytes. Ten
 * seconds also comfortably absorbs the SPA's 30-second refetch when several
 * viewers watch the same API.
 */
export const METRICS_CACHE_TTL_MS = 10_000;

/**
 * Hard ceiling for either gateway-wide telemetry document. Both are
 * *gateway-wide* rather than per-proxy, so a mid-size gateway's exposition
 * passes 2 MiB and every usage card would read "unavailable" for good.
 */
export const METRICS_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;

/** Prometheus families Nexus reads. Everything else in the body is ignored. */
const REQUESTS_FAMILY = 'ferrum_requests_total';
const DURATION_FAMILY = 'ferrum_request_duration_ms';

/** One memoised metrics read. */
interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

class ResponseTooLargeError extends Error {}

async function readBoundedBody(body: AsyncIterable<Uint8Array>, maxBytes: number): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of body) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) throw new ResponseTooLargeError('Response exceeded the byte limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** An unavailable scrape: zeroed rather than absent, so callers never branch. */
function emptyProxyMetrics(code: ApiUsageUnavailableCode, reason: string): EdgeProxyMetrics {
  return {
    available: false,
    reason,
    unavailableCode: code,
    requests: { byMethod: {}, byStatus: {}, total: 0 },
    latency: { buckets: [], count: null, sum: null },
  };
}

/** An unavailable backend read. */
function emptyBackendState(reason: string): EdgeBackendState {
  return { available: false, reason, breakers: [], unhealthyTargets: [], uptimeSeconds: null };
}

/**
 * Why a metrics read yielded nothing, said twice: once for whoever reads the
 * usage card and once for the operator's log.
 *
 * Providers see `reason`, so it stays generic: it never names a portal or
 * gateway setting or a gateway version. `hint` carries that detail, and only
 * ever reaches the server log.
 */
export interface MetricsReadFailure {
  /** Provider-safe explanation, shown on the usage card. */
  reason: string;
  /** What an operator should check or set; logged, never shown. `null` when `reason` suffices. */
  hint: string | null;
}

/** Why a `GET /metrics` scrape yielded nothing; cached like a successful one. */
export interface ScrapeFailure extends MetricsReadFailure {
  code: ApiUsageUnavailableCode;
}

/** A `GET` of a non-JSON body: its status, and its text unless that could not be read. */
interface TextResponse {
  statusCode: number;
  body: string | null;
  /** Why `body` is `null`. */
  bodyError?: 'response_too_large' | 'body_read_failed';
}

/** One `GET /admin/metrics` read: the payload, or why there is none. */
type BackendRead =
  { payload: Record<string, unknown> } | { payload: null; failure: MetricsReadFailure };

/** What a metrics read's failure log carries, or `null` for a read that worked. */
type FailureLogFields = Record<string, unknown> | null;

const METRICS_UNREACHABLE: ScrapeFailure = {
  code: 'unreachable',
  reason: 'The gateway could not be reached for its request metrics.',
  hint: null,
};

const METRICS_UNREADABLE: ScrapeFailure = {
  code: 'gateway_error',
  reason: 'The gateway sent no readable request metrics.',
  hint: null,
};

/** The provider-facing sentence for a refused read; the operator's detail is in the log. */
function refusedReason(what: string): string {
  return (
    `The gateway did not allow this portal to read its ${what}. ` +
    'A portal operator can enable this.'
  );
}

/**
 * Why a non-2xx `GET /metrics` answer yielded nothing.
 *
 * A `403` to the admin JWT is Edge v0.9.16 refusing a token with an `ns` claim
 * on a fleet-global route, and the log says so, because the fix is a setting
 * on the portal: the gateway's metrics bearer token. With that token
 * configured, a `401`/`403` means the two sides disagree about it.
 */
export function metricsScrapeFailure(status: number, bearerConfigured: boolean): ScrapeFailure {
  if ((status === 401 || status === 403) && bearerConfigured) {
    return {
      code: 'refused',
      reason: refusedReason('request metrics'),
      hint:
        'The gateway refused the metrics bearer token this portal presents; ' +
        "FERRUM_METRICS_BEARER_TOKEN must equal the gateway's.",
    };
  }
  if (status === 403) {
    return {
      code: 'refused',
      reason: refusedReason('request metrics'),
      hint:
        "Ferrum Edge v0.9.16 and later refuse the portal's namespace-scoped admin token on " +
        "GET /metrics. Set FERRUM_METRICS_BEARER_TOKEN on the portal to the gateway's.",
    };
  }
  if (status === 401) {
    return {
      code: 'refused',
      reason: refusedReason('request metrics'),
      hint:
        "The gateway rejected the portal's admin JWT; check FERRUM_ADMIN_JWT_SECRET and " +
        'FERRUM_ADMIN_JWT_ISSUER.',
    };
  }
  return {
    code: 'gateway_error',
    reason: `The gateway answered its request metrics with HTTP ${status}.`,
    hint: null,
  };
}

/**
 * Why `GET /admin/metrics` yielded nothing, from the failed call's status:
 * an error status, the (successful) status of an unusable body, or `undefined`
 * when nothing answered.
 */
export function backendStateFailure(
  status: unknown,
  fleetReadConfigured: boolean,
): MetricsReadFailure {
  if ((status === 401 || status === 403) && fleetReadConfigured) {
    return {
      reason: refusedReason('runtime metrics'),
      hint:
        'The gateway refused the fleet-read token this portal signs with ' +
        "FERRUM_ADMIN_FLEET_READ_JWT_SECRET; it must equal the gateway's " +
        'FERRUM_ADMIN_JWT_VIEWER_SECRET, with no FERRUM_ADMIN_JWT_VIEWER_NAMESPACES ceiling.',
    };
  }
  if (status === 403) {
    return {
      reason: refusedReason('runtime metrics'),
      hint:
        "Ferrum Edge v0.9.16 and later refuse the portal's namespace-scoped admin token on " +
        'GET /admin/metrics. FERRUM_ADMIN_FLEET_READ_JWT_SECRET restores the read; see the ' +
        'operations guide for what that key can read.',
    };
  }
  if (status === 401) {
    return {
      reason: refusedReason('runtime metrics'),
      hint:
        "The gateway rejected the portal's admin JWT; check FERRUM_ADMIN_JWT_SECRET and " +
        'FERRUM_ADMIN_JWT_ISSUER.',
    };
  }
  if (typeof status !== 'number') {
    return { reason: 'The gateway could not be reached for its runtime metrics.', hint: null };
  }
  return status >= 400
    ? { reason: `The gateway answered its runtime metrics with HTTP ${status}.`, hint: null }
    : { reason: 'The gateway sent no readable runtime metrics.', hint: null };
}

/** A finite, non-negative sample value, or `null`. */
function counterValue(value: number): number | null {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** Parse an `le` label. `+Inf` is the histogram's open-ended top bucket. */
function parseLe(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  if (raw === '+Inf' || raw === 'Inf') return Number.POSITIVE_INFINITY;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** Read a number off an unknown JSON object, or `null`. */
function numberAt(value: unknown, key: string): number | null {
  if (typeof value !== 'object' || value === null) return null;
  const found = (value as Record<string, unknown>)[key];
  return typeof found === 'number' && Number.isFinite(found) ? found : null;
}

/**
 * Edge statuses whose `{"error": …}` text is about the caller's own request and
 * is therefore safe — and necessary — to surface. See the module doc comment.
 */
const ECHOED_EDGE_STATUSES = new Set([400, 409, 422]);

/* ── Connection pooling ─────────────────────────────────────────────────── */

/**
 * Edge's default admin idle/header bound
 * (`FERRUM_HTTP_HEADER_READ_TIMEOUT_SECONDS=10`), in milliseconds.
 *
 * Nexus cannot read the gateway's configuration, so this is the number the
 * client's own keep-alive settings are held under. An operator who *lowers*
 * Edge's bound below {@link ADMIN_KEEP_ALIVE_TIMEOUT_MS} moves the boundary
 * back under this client — the bounded read retry below is what keeps that
 * from surfacing as a false `EDGE_UNAVAILABLE`.
 */
export const EDGE_DEFAULT_IDLE_TIMEOUT_MS = 10_000;

/**
 * How long this client keeps an idle pooled socket before closing it itself.
 *
 * It used to be {@link EDGE_DEFAULT_IDLE_TIMEOUT_MS} exactly, which is a race
 * the client loses intermittently: a socket reused in the same instant the
 * gateway closes it fails with `ECONNRESET` against a perfectly healthy Edge,
 * and `/api/health` then reports the dependency down for a whole cache
 * interval (#248). Six seconds of margin is far more than any plausible
 * scheduling, timer or loopback delay, and four seconds still amortises the
 * TCP (and TLS) handshake across the burst of calls one publish makes.
 */
export const ADMIN_KEEP_ALIVE_TIMEOUT_MS = 4_000;

/**
 * Ceiling on the idle lifetime a gateway may negotiate upwards through a
 * `Keep-Alive: timeout=N` response header. Held below
 * {@link EDGE_DEFAULT_IDLE_TIMEOUT_MS} so a gateway that advertises its own
 * bound verbatim cannot put this client back on the boundary.
 */
export const ADMIN_KEEP_ALIVE_MAX_TIMEOUT_MS = 8_000;

/**
 * Safety margin undici subtracts from a server-advertised keep-alive hint
 * before adopting it, so the client always abandons a socket first. A hint
 * this margin cannot fit under (`timeout=1`, say) closes the connection after
 * the response instead of pooling it.
 */
export const ADMIN_KEEP_ALIVE_TIMEOUT_THRESHOLD_MS = 2_000;

function buildDispatcher(config: EdgeConfig): Dispatcher {
  const isHttps = config.adminUrl.startsWith('https://');
  let ca: string | undefined;
  if (config.caFile) {
    try {
      ca = readFileSync(config.caFile, 'utf8');
    } catch (cause) {
      throw internal('FERRUM_ADMIN_CA_FILE could not be read', cause);
    }
  }
  return new Agent({
    // Undici 8 enables HTTP/2 by default; retain the released H1 pooling/retry contract.
    allowH2: false,
    connect: {
      timeout: config.timeoutMs,
      ...(isHttps && ca ? { ca } : {}),
    },
    headersTimeout: Math.max(config.timeoutMs, 30_000),
    bodyTimeout: Math.max(config.timeoutMs, 30_000),
    keepAliveTimeout: ADMIN_KEEP_ALIVE_TIMEOUT_MS,
    keepAliveMaxTimeout: ADMIN_KEEP_ALIVE_MAX_TIMEOUT_MS,
    keepAliveTimeoutThreshold: ADMIN_KEEP_ALIVE_TIMEOUT_THRESHOLD_MS,
  });
}

/* ── Stale pooled sockets ───────────────────────────────────────────────── */

/** Methods whose replay is free of side effects, so a lost socket may be redone. */
const REPLAYABLE_METHODS = new Set(['GET', 'HEAD']);

/**
 * Socket-level failures a connection closed under the client produces.
 *
 * An **allowlist**, deliberately: a connect-phase refusal (`ECONNREFUSED`), a
 * DNS failure, a TLS failure and every timeout describe the gateway or the
 * network, not a pooled socket that outlived its welcome, and none of them may
 * buy a second attempt.
 */
const STALE_SOCKET_CODES = new Set(['UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE']);

/**
 * Every `code` on an error's `cause` chain, outermost first.
 *
 * undici reports a connection the peer closed as its own `SocketError`
 * (`UND_ERR_SOCKET`) and carries the operating system's `ECONNRESET` beneath
 * it, but which of the two surfaces depends on where in the exchange the
 * socket died — so both are inspected. The walk is bounded because a `cause`
 * chain can be cyclic.
 */
function errorCodes(error: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    const code = (current as NodeJS.ErrnoException).code;
    if (typeof code === 'string') codes.push(code);
    current = (current as { cause?: unknown }).cause;
  }
  return codes;
}

/**
 * Whether a transport failure looks like a pooled connection the peer closed
 * rather than a gateway that is not answering.
 *
 * An abort or a timeout is never one of these: the deadline expiring says
 * nothing about the socket, and retrying it would spend a budget the caller
 * already declared exhausted.
 */
export function isStalePooledSocketError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return false;
  return errorCodes(error).some((code) => STALE_SOCKET_CODES.has(code));
}

/**
 * Whether one more attempt is owed to a failed Admin API request.
 *
 * Three conditions, all required:
 *
 * - the method is a **read**, so a replay cannot duplicate a gateway change —
 *   a `POST`/`PUT`/`PATCH`/`DELETE` whose socket died may already have been
 *   applied and is never repeated;
 * - **no response byte arrived**, so the gateway had not begun answering;
 * - the failure is a {@link isStalePooledSocketError stale socket}, and the
 *   caller's deadline has not expired — the retry rides inside the original
 *   overall request/probe budget, it does not extend it.
 *
 * The retry itself needs no special dispatcher handling: undici destroys and
 * evicts a socket that errors, so the next request opens a fresh connection.
 */
export function shouldRetryOnFreshConnection(
  method: string,
  error: unknown,
  responseStarted: boolean,
  signal: AbortSignal,
): boolean {
  if (!REPLAYABLE_METHODS.has(method)) return false;
  if (responseStarted || signal.aborted) return false;
  return isStalePooledSocketError(error);
}

/**
 * The outcome of one transport attempt.
 *
 * A transport failure is returned rather than thrown so the retry decision can
 * see whether the gateway had started to answer before deciding, and so the
 * classification below runs exactly once however many attempts were made.
 */
type TransportAttempt =
  { ok: true; bytes: Buffer } | { ok: false; error: unknown; responseStarted: boolean };

function isUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return true;
  const code = (error as NodeJS.ErrnoException).code;
  if (typeof code === 'string') {
    return (
      code.startsWith('E') ||
      code === 'UND_ERR_CONNECT_TIMEOUT' ||
      code === 'UND_ERR_HEADERS_TIMEOUT' ||
      code === 'UND_ERR_BODY_TIMEOUT' ||
      code === 'UND_ERR_SOCKET'
    );
  }
  return error.message.includes('fetch failed');
}

/** Deployment-mutation errors raised before the request was sent. */
const NOT_DISPATCHED = new WeakSet<object>();

/**
 * True when a deployment `remove`/`replace` refused before sending any request,
 * so the gateway cannot have applied it. Transport, `409`/`412`, `503` and
 * acknowledgement failures are never marked: those may still settle. Nor is a
 * `507` refusal: it reached the gateway, so its journal entry is kept too.
 */
export function deploymentNotDispatched(error: unknown): boolean {
  return typeof error === 'object' && error !== null && NOT_DISPATCHED.has(error);
}

/** Protocol-error reason for a policy schema this portal does not read (older or newer). */
const UNSUPPORTED_SCHEMA_REASON = 'unsupported_egress_policy_schema';

/**
 * Bound on one `GET /backend-egress-policy` answer. A control plane lists every
 * connected data-plane stream of the namespace (about 400 bytes each with
 * realistic node ids), so this leaves room for roughly 10,000 streams, above
 * Edge's default `FERRUM_XDS_MAX_TOTAL_STREAMS`. A larger answer is a protocol
 * error, refused in every profile like any other unreadable policy.
 */
export const EGRESS_POLICY_MAX_BYTES = 4 * 1024 * 1024;

/** The shape of an RFC 9110 IMF-fixdate, the only `Date` form a server may generate. */
const IMF_FIXDATE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * The gateway's clock from a response `Date` header, in epoch milliseconds, or
 * `undefined` when it sent none Nexus can read. The header has whole seconds
 * and is stamped no earlier than the answer was built. Without it, stream age
 * is never read from `connected_at`; only this process's sightings settle.
 */
export function gatewayDateMillis(value: string | string[] | undefined): number | undefined {
  if (typeof value !== 'string' || !IMF_FIXDATE.test(value)) return undefined;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : undefined;
}

/** One policy reading, with what tells how long its listed data planes have existed. */
interface EgressPolicyObservation {
  reading: BackendEgressPolicyReading;
  freshness: DataPlaneFreshness;
}

function isUnsupportedSchemaRefusal(error: unknown): boolean {
  if (!(error instanceof NexusError)) return false;
  const details = error.details as { reason?: unknown } | undefined;
  return details?.reason === UNSUPPORTED_SCHEMA_REASON;
}

/** Injectable dependencies of {@link createFerrumAdminClient}. */
export interface FerrumAdminClientDeps {
  /** Admin JWT minter. Defaults to one derived from `config`. */
  minter?: AdminTokenMinter;
  /** undici dispatcher. Defaults to a pooled agent; an injected one is not closed. */
  dispatcher?: Dispatcher;
  /**
   * Cross-instance lock table backing {@link FerrumAdminClient.serializePerKey}.
   *
   * Pass `store.leases` in every real deployment: without it consumer and proxy
   * read-modify-writes are ordered only within this process, which is the
   * lost-update hazard the leases exist to close.
   */
  leases?: LeaseRepo;
  /** Derived only from NEXUS_ALLOW_PRIVATE_UPSTREAMS; defaults to the public profile. */
  allowPrivateUpstreams?: boolean;
  /**
   * Derived only from NEXUS_ALLOW_UNATTESTED_EDGE_EGRESS. Waives the gateway's
   * public-only attestation and nothing else; defaults to requiring it.
   */
  allowUnattestedEdgeEgress?: boolean;
  /**
   * Derived only from NEXUS_EXPECTED_DATA_PLANES. Unset, a control plane's
   * data-plane attestation never proves public-only egress.
   */
  expectedDataPlanes?: number;
}

/** Build the Ferrum Edge Admin API client. */
export function createFerrumAdminClient(
  config: EdgeConfig,
  logger: EdgeLogger = silentEdgeLogger,
  deps: FerrumAdminClientDeps = {},
): FerrumAdminClient {
  const minter = deps.minter ?? createAdminTokenMinter(config);
  // Only `GET /admin/metrics` uses it; `null` keeps that read on the admin key.
  const fleetReadMinter = createFleetReadTokenMinter(config);
  const metricsBearerToken = config.metricsBearerToken;
  const dispatcher = deps.dispatcher ?? buildDispatcher(config);
  // Without `leases` this is the historical in-process queue: correct for a
  // single writer, and what the client's own unit tests construct.
  const serializePerKey = createKeyedSerializer(
    deps.leases === undefined ? {} : { leases: deps.leases },
  );
  const namespace = config.namespace;
  const namespaceMonitor = createNamespaceMonitor(namespace);
  // Every policy read feeds it, so a data plane's routine reconnect keeps the
  // guarantee once this process has seen its node_id long enough (#540).
  const dataPlaneSightings = createDataPlaneSightings();

  function urlFor(path: string, query?: CallOptions['query']): string {
    const url = new URL(config.adminUrl + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  /**
   * Watch for `X-Ferrum-Namespace-Unserved: true` on an accepted mutation.
   *
   * Edge stamps it only on a `2xx` answer to a `POST`/`PUT`/`PATCH`/`DELETE`
   * whose `X-Ferrum-Namespace` its data plane does not route: the write
   * committed, is Admin-visible, and will never be matched by the router. Its
   * absence asserts nothing — an older gateway never sends it — so only the
   * literal `true` is read, and the status filter is repeated here rather than
   * trusted, because a header on a `4xx` would describe a write that never
   * happened.
   *
   * Logged once per transition, not once per write: a misconfigured portal
   * makes many gateway calls per publish and the condition is one fact.
   */
  function noteUnservedNamespace(
    method: string,
    path: string,
    status: number,
    headers: Record<string, string | string[] | undefined>,
  ): void {
    if (method === 'GET') return;
    if (status < 200 || status >= 300) return;
    const raw = headers[NAMESPACE_UNSERVED_HEADER];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value !== NAMESPACE_UNSERVED_HEADER_VALUE) return;
    if (!namespaceMonitor.observeUnservedMutation()) return;
    logger.error(
      { namespace, method, path, header: NAMESPACE_UNSERVED_HEADER },
      'Ferrum Edge accepted a write into a namespace its data plane does not serve; ' +
        'published APIs in this namespace will answer 404',
    );
  }

  /** Whether the last health answer was the minimal tier; logged once per transition. */
  let minimalHealthTier = false;

  /**
   * Notice a `GET /health` answer that carries neither `mode` nor
   * `admin_writes_enabled`: the minimal tier, which Edge serves a caller it
   * does not trust with detail. Edge v0.9.16 serves the portal's
   * namespace-scoped token its bounded tenant tier instead, which keeps both
   * fields; a gateway that pairs the token bound with no tenant tier leaves the
   * portal blind to its mode, write state and namespace routing, and says so
   * once rather than on every probe.
   */
  function noteHealthTier(health: EdgeHealth): void {
    const minimal = health.mode === undefined && health.admin_writes_enabled === undefined;
    if (minimal && !minimalHealthTier) {
      logger.warn(
        { namespace },
        'Ferrum Edge answered GET /health with its minimal tier; the gateway mode, admin ' +
          'write state and namespace routing are unknown to the portal',
      );
    }
    minimalHealthTier = minimal;
  }

  /** Whether the last `GET /version` was refused with `403`; logged once per transition. */
  let versionRefused = false;

  /**
   * `GET /version`, best effort. Edge has no such endpoint and answers `404`
   * (or `405`), which reads `null`. Edge v0.9.16 answers an unknown global path
   * `403` to a token with an `ns` claim, so a `403` reads `null` too. But a
   * `403` is also what a refused admin credential looks like on an earlier
   * gateway, so it is logged on its own, once per transition, rather than
   * folded in silently.
   */
  async function readVersion(signal?: AbortSignal): Promise<string | null> {
    let result: { version?: unknown } | null;
    try {
      result = await call<{ version?: unknown }>('GET', '/version', {
        ...(signal === undefined ? {} : { signal }),
        allow404: true,
        tolerate: [404, 405],
        quiet: [403],
      });
    } catch (error) {
      const details = error instanceof NexusError ? error.details : undefined;
      if (!isRecord(details) || details.status !== 403) throw error;
      if (!versionRefused) {
        logger.warn(
          { path: '/version', status: 403 },
          'Ferrum Edge refused GET /version. Edge v0.9.16 and later refuse it to the ' +
            "portal's namespace-scoped admin token, which is expected; on an earlier gateway " +
            'it means the admin credential itself was refused',
        );
      }
      versionRefused = true;
      return null;
    }
    versionRefused = false;
    const version = result?.version;
    return typeof version === 'string' ? version : null;
  }

  /**
   * Log a metrics read's failures once per change of cause rather than on
   * every cache miss, which is one per {@link METRICS_CACHE_TTL_MS} per page
   * view: a gateway that refuses the portal's token refuses it on every read,
   * and that is one fact. A recovery resets it, so a later failure logs again.
   */
  function createFailureLog(path: string, message: string): (fields: FailureLogFields) => void {
    let last: string | null = null;
    return (fields) => {
      const key = fields === null ? null : JSON.stringify(fields);
      if (key === last) return;
      last = key;
      if (fields === null) {
        logger.debug({ path }, `${message}: readable again`);
      } else {
        logger.warn({ path, ...fields }, message);
      }
    };
  }

  const noteScrape = createFailureLog('/metrics', 'Ferrum Edge request metrics could not be read');
  const noteBackendRead = createFailureLog(
    '/admin/metrics',
    'Ferrum Edge runtime metrics could not be read',
  );

  async function call<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    options: CallOptions = {},
  ): Promise<T | null> {
    const contract: ResponseContract = options.deployment
      ? { statuses: [200], body: isDeploymentAcknowledgement }
      : responseContract(method, path);
    const signer = options.minter ?? minter;
    const token = await signer.getToken(options.subject ?? DEFAULT_ADMIN_SUBJECT);
    const url = urlFor(path, options.query);
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      [FERRUM_NAMESPACE_HEADER.toLowerCase()]: namespace,
      ...(options.preserveLabels
        ? {}
        : { [FERRUM_PROVISIONED_BY_HEADER.toLowerCase()]: FERRUM_PROVISIONED_BY_VALUE }),
      accept: 'application/json',
    };
    const hasBody = options.body !== undefined;
    if (hasBody) headers['content-type'] = 'application/json';
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;

    let serializedBody: string | undefined;
    try {
      serializedBody = hasBody ? JSON.stringify(options.body) : undefined;
    } catch (cause) {
      logger.error({ method, path }, 'Ferrum Edge Admin API request serialization failed');
      throw internal(`Could not serialize Ferrum Edge request ${method} ${path}`, cause);
    }

    let statusCode = 0;
    let responseHeaders: Record<string, string | string[] | undefined> = {};
    // One deadline for the whole call, created once so that a retry below
    // spends what is left of it rather than starting a second budget.
    const signal = options.signal ?? AbortSignal.timeout(config.timeoutMs);

    async function send(): Promise<TransportAttempt> {
      let responseStarted = false;
      try {
        const response = await request(url, {
          method,
          headers,
          dispatcher,
          // undici.request does not follow redirects; do not install a redirect interceptor.
          ...(hasBody ? { body: serializedBody } : {}),
          signal,
        });
        responseStarted = true;
        statusCode = response.statusCode;
        responseHeaders = response.headers;
        noteUnservedNamespace(method, path, statusCode, response.headers);
        return {
          ok: true,
          bytes: await readBoundedBody(
            response.body,
            options.maxResponseBytes ?? ADMIN_RESPONSE_MAX_BYTES,
          ),
        };
      } catch (error) {
        return { ok: false, error, responseStarted };
      }
    }

    let attempt = await send();
    if (
      !attempt.ok &&
      shouldRetryOnFreshConnection(method, attempt.error, attempt.responseStarted, signal)
    ) {
      logger.warn(
        { method, path, code: errorCodes(attempt.error)[0] ?? null },
        'Ferrum Edge Admin API closed a pooled connection; retrying the read on a fresh one',
      );
      attempt = await send();
    }
    if (!attempt.ok) {
      const cause = attempt.error;
      if (cause instanceof ResponseTooLargeError) {
        throw protocolError(statusCode, 'response_too_large', method, path);
      }
      logger.error(
        { method, path, code: (cause as NodeJS.ErrnoException).code ?? null },
        'Ferrum Edge Admin API is unreachable',
      );
      if (isUnavailable(cause)) throw edgeUnavailable(undefined, cause);
      throw edgeUnavailable('The Ferrum Edge Admin API request failed', cause);
    }
    const bytes = attempt.bytes;

    if (statusCode === 404 && options.allow404) {
      if (options.absentError === undefined) return null;
      if (isAbsenceAcknowledgement(bytes, options.absentError)) return null;
      throw protocolError(statusCode, 'unconfirmed_absence', method, path);
    }
    // These are explicit best-effort namespace/version exceptions, never
    // resource reads. Health's 503 must still satisfy its full body contract.
    if ((options.tolerate ?? []).includes(statusCode) && !contract.statuses.includes(statusCode)) {
      return null;
    }
    if (statusCode < 200 || (statusCode >= 300 && statusCode < 400)) {
      throw protocolError(statusCode, 'unexpected_status', method, path);
    }
    let raw: string;
    if (contract.statuses.includes(statusCode)) {
      try {
        // Decode only after absence/tolerated-status handling, and outside the
        // transport catch. Replacement characters could rewrite credentials or
        // identities. Keep BOM handling unchanged: JSON.parse still rejects it.
        raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch {
        throw protocolError(statusCode, 'invalid_utf8', method, path);
      }
    } else {
      // Preserve existing diagnostics for rejected requests; no resource body
      // from this branch can be returned as a successful acknowledgement.
      raw = bytes.toString('utf8');
    }
    let parsed: unknown = null;
    let validJson = false;
    try {
      parsed = JSON.parse(raw);
      validJson = true;
    } catch {
      // Only error-status classification may inspect an absent JSON body.
    }
    if (statusCode >= 400 && !contract.statuses.includes(statusCode)) {
      const quiet = options.quiet === true || (options.quiet ?? []).includes(statusCode);
      throw classify(statusCode, parsed, method, path, options.deployment, quiet);
    }
    if (!contract.statuses.includes(statusCode)) {
      throw protocolError(statusCode, 'unexpected_status', method, path);
    }
    if (raw.trim() === '') {
      if (contract.empty === 'void') return null;
      if (contract.empty === 'live') return { status: 'ok' } as T;
      throw protocolError(statusCode, 'empty_body', method, path);
    }
    if (!validJson) throw protocolError(statusCode, 'invalid_json', method, path);
    if (!contract.body(parsed)) {
      throw protocolError(statusCode, 'invalid_body', method, path);
    }
    if (
      path === '/backend-egress-policy' ||
      path === '/deployment-snapshot' ||
      /\/consumers\/[^/]+\/verification$/.test(path)
    ) {
      // These endpoints promise authoritative no-store reads. Refuse intermediary
      // cache evidence rather than treating an old policy/snapshot as admission.
      if (
        responseHeaders['cache-control'] !== 'no-store' ||
        (responseHeaders.age !== undefined && responseHeaders.age !== '0') ||
        (responseHeaders['x-data-source'] !== undefined &&
          responseHeaders['x-data-source'] !== 'database')
      ) {
        throw protocolError(statusCode, 'non_authoritative_read', method, path);
      }
    }
    if (isRecord(parsed)) {
      const scoped = /^\/(consumers|proxies|plugins\/config)(?:\/|$)/.exec(path);
      if (scoped && !options.deployment) {
        const rows = Array.isArray(parsed.data) ? parsed.data : [parsed];
        const id = path.slice(scoped[1]!.length + 2).split('/')[0];
        if (
          rows.some((row: unknown) => !isRecord(row) || row.namespace !== namespace) ||
          (id && parsed.id !== decodeURIComponent(id))
        ) {
          throw protocolError(statusCode, 'resource_mismatch', method, path);
        }
      }
      if (method === 'GET' && isRecord(parsed.pagination)) {
        if (parsed.pagination.offset !== (options.query?.offset ?? 0)) {
          throw protocolError(statusCode, 'page_mismatch', method, path);
        }
      }
      if (path === '/api-specs' && method === 'GET' && Array.isArray(parsed.items)) {
        if (
          parsed.offset !== (options.query?.offset ?? 0) ||
          parsed.items.some(
            (item: unknown) => isRecord(item) && item.proxy_id !== options.query?.proxy_id,
          )
        ) {
          throw protocolError(statusCode, 'page_mismatch', method, path);
        }
      }
    }
    options.responseHeaders?.(responseHeaders);
    return parsed as T;
  }

  function protocolError(status: number, reason: string, method: string, path: string): NexusError {
    // Never log response bytes, Location, parser exceptions, JWTs or request
    // bodies. Even a bounded prefix can expose credentials or an HTML login.
    logger.error(
      { method, path, status, reason },
      'Ferrum Edge Admin API returned an invalid protocol response',
    );
    return new NexusError(
      'EDGE_PROTOCOL_ERROR',
      'The gateway returned an invalid protocol response',
      { status, kind: 'protocol_error', reason },
    );
  }

  function classify(
    status: number,
    parsed: unknown,
    method: string,
    path: string,
    deployment = false,
    quiet = false,
  ): Error {
    const body = (parsed ?? {}) as {
      error?: unknown;
      applied?: unknown;
      reason?: unknown;
      details?: unknown;
      code?: unknown;
      failures?: unknown;
    };
    const credentialWrite = method !== 'GET' && /^\/consumers(?:\/|$)/.test(path);
    const sensitive =
      credentialWrite ||
      /^\/consumers\/[^/]+\/verification$/.test(path) ||
      path === '/backend-egress-policy' ||
      path === '/deployment-snapshot' ||
      deployment;
    const isApiSpecWrite =
      (method === 'POST' || method === 'PUT') && /^\/api-specs(?:\/[^/]+)?$/.test(path);
    if (quiet) {
      // The caller logs this failure itself, once per change.
    } else if (sensitive) {
      logger.error(
        { method, path, status },
        'Ferrum Edge Admin API returned an error; response content was omitted',
      );
    } else {
      const upstream = typeof body.error === 'string' ? body.error : `HTTP ${status}`;
      logger.error(
        {
          method,
          path,
          status,
          upstream,
          reason: body.reason ?? null,
          // readBoundedBody caps this structure before JSON parsing. Keep the full
          // diagnostics server-side; never reflect the raw document to the caller.
          ...(isApiSpecWrite ? { gateway_response: parsed } : {}),
        },
        'Ferrum Edge Admin API returned an error',
      );
    }

    if (deployment) {
      if (status === 412 || status === 409) {
        return conflict('The original gateway deployment authority was refused', {
          status,
          kind: 'deployment_precondition_failed',
        });
      }
      // A definite refusal: the namespace exceeds Edge's conditional snapshot
      // bound and nothing was applied. Deterministic for unchanged state, so the
      // caller keeps its journal and never retries it.
      if (status === 507 && isSnapshotTooLargeRefusal(parsed)) {
        return conflict(
          'The gateway namespace is too large for conditional deployment authority; nothing ' +
            'was applied',
          { status, kind: 'namespace_snapshot_too_large' },
        );
      }
      // A definite non-commit (Edge v0.9.14 also reports a store failure before or
      // inside the rolled-back transaction this way). Nothing was applied, but it
      // authorizes neither cleanup nor replay: the caller keeps its journal. Only
      // `durable: "unknown"` (a failed commit or its acknowledgement) is uncertain.
      if (isDeploymentNonCommit(parsed)) {
        return edgeError(
          'The gateway did not commit the deployment mutation; nothing was applied. Retain ' +
            'recovery state',
          { status, kind: 'deployment_not_committed' },
        );
      }
      return edgeError('Gateway deployment mutation was not confirmed; retain recovery state', {
        status,
        kind: 'deployment_acknowledgement_uncertain',
      });
    }
    if (path === '/deployment-snapshot') {
      if (status === 507) {
        return conflict(
          'The gateway namespace is too large for conditional deployment authority; none was ' +
            'issued',
          { status, kind: 'namespace_snapshot_too_large' },
        );
      }
      return edgeError('The gateway deployment authority is unavailable', { status });
    }
    // Edge v0.9.13 answers a bare 507 when the namespace exceeds its conditional
    // snapshot bound. The verification read issued nothing; name the cause and
    // keep failing closed.
    if (status === 507 && /^\/consumers\/[^/]+\/verification$/.test(path)) {
      return edgeError('The gateway namespace is too large for consumer verification', {
        status,
        kind: 'namespace_snapshot_too_large',
      });
    }
    if (credentialWrite && status === 412) {
      return conflict('The gateway consumer changed; read it again before retrying', {
        status,
        kind: 'precondition_failed',
      });
    }
    if (status === 503 && body.applied === false && method !== 'GET') {
      return edgeError(
        credentialWrite
          ? 'The gateway accepted the change but has not applied it; verify state before retrying'
          : 'The gateway accepted the change but has not applied it yet; do not retry — verify ' +
              'the gateway configuration and try again once it recovers',
        {
          status,
          ...(credentialWrite
            ? { kind: 'write_durable_not_live' }
            : { reason: typeof body.reason === 'string' ? body.reason : null }),
        },
      );
    }
    if (credentialWrite && status === 503) {
      return edgeError(
        'The gateway may have accepted the change; verify its state before retrying',
        { status, kind: 'write_acknowledgement_uncertain' },
      );
    }
    if (status === 401 || status === 403) {
      return edgeError('The gateway rejected the Nexus admin credentials', { status });
    }
    if (
      isApiSpecWrite &&
      status >= 400 &&
      status < 500 &&
      (body.error === 'Spec parse failed' || body.error === 'Spec validation failed')
    ) {
      let gatewayMessage: string = body.error;
      if (typeof body.details === 'string' && body.details.trim() !== '') {
        gatewayMessage += `: ${body.details.trim().slice(0, MAX_GATEWAY_MESSAGE)}`;
      }
      if (Array.isArray(body.failures)) {
        for (const failure of body.failures) {
          if (gatewayMessage.length >= MAX_GATEWAY_MESSAGE) break;
          if (!isRecord(failure) || typeof failure.resource_type !== 'string') continue;
          const firstError = Array.isArray(failure.errors) ? failure.errors[0] : undefined;
          if (typeof firstError !== 'string') continue;
          const resource = failure.resource_type.slice(0, MAX_GATEWAY_MESSAGE);
          gatewayMessage += `; ${resource}: ${firstError.slice(0, MAX_GATEWAY_MESSAGE)}`;
        }
      }
      gatewayMessage = gatewayMessage.slice(0, MAX_GATEWAY_MESSAGE);
      return new NexusError(
        'EDGE_REJECTED_SPEC',
        `The gateway rejected the spec: ${gatewayMessage}`,
        {
          status,
          gateway_message: gatewayMessage,
          ...(typeof body.code === 'string'
            ? { gateway_code: body.code.slice(0, MAX_GATEWAY_MESSAGE) }
            : {}),
        },
      );
    }
    // A validation refusal is about the body Nexus built from the caller's own
    // request, so the provider needs the gateway's reason to act on it.
    if (!sensitive && ECHOED_EDGE_STATUSES.has(status) && typeof body.error === 'string') {
      const gatewayMessage = body.error.trim().slice(0, MAX_GATEWAY_MESSAGE);
      if (gatewayMessage !== '') {
        return edgeError(`The gateway rejected the request: ${gatewayMessage}`, {
          status,
          gateway_message: gatewayMessage,
        });
      }
    }
    return edgeError('The gateway rejected the request', { status });
  }

  async function readEgressPolicy(signal?: AbortSignal): Promise<EgressPolicyObservation> {
    // Taken before the request: the answer describes a later moment, so stream
    // ages measured from here never overstate it.
    const readAt = Date.now();
    const startedAt = performance.now();
    let gatewayDate: number | undefined;
    const value = await callRequired<unknown>('GET', '/backend-egress-policy', {
      signal,
      maxResponseBytes: EGRESS_POLICY_MAX_BYTES,
      responseHeaders: (headers) => {
        gatewayDate = gatewayDateMillis(headers.date);
      },
    });
    // Another schema (schema 1 from Edge v0.9.12 or earlier, or a newer one) is
    // still refused, under its own reason: the operator needs to tell a version
    // mismatch from a malformed answer.
    if (isUnsupportedEgressPolicySchema(value)) {
      throw protocolError(200, UNSUPPORTED_SCHEMA_REASON, 'GET', '/backend-egress-policy');
    }
    const reading = readBackendEgressPolicy(value, namespace);
    if (!reading) {
      throw protocolError(200, 'invalid_egress_policy', 'GET', '/backend-egress-policy');
    }
    // The attestation can only add a guarantee, so a problem in it degrades to
    // "not guaranteed" instead of refusing the answer. Bounded reason only.
    if (reading.attestationProblem !== null) {
      logger.warn(
        { namespace, reason: reading.attestationProblem },
        'Ferrum Edge data-plane egress attestation set aside; public-only egress not guaranteed',
      );
    }
    const settledNodeIds =
      reading.attestationProblem === null
        ? dataPlaneSightings.observe(reading.policy, startedAt)
        : new Set<string>();
    return { reading, freshness: { readAt, gatewayDate, settledNodeIds } };
  }

  async function backendEgressPolicy(signal?: AbortSignal): Promise<BackendEgressPolicy> {
    return (await readEgressPolicy(signal)).reading.policy;
  }

  async function assertBackendEgress(): Promise<BackendEgressAdmission> {
    const { reading, freshness } = await readEgressPolicy();
    // Either opt-out admits a recognized weaker process policy, but neither
    // describes it as public-only, and neither skips the parse above.
    const assessment = assessBackendEgress(reading, deps, freshness);
    if (assessment.admission === null) {
      const message = 'The gateway cannot establish the required local public egress policy';
      // A control plane's refusal also says why its attestation did not count.
      const why = describeDataPlaneAttestation(assessment.dataPlaneAttestation);
      if (why === null) throw edgeError(message, { kind: 'backend_egress_unverified' });
      throw edgeError(`${message}: ${why}`, {
        kind: 'backend_egress_unverified',
        data_plane_attestation: assessment.dataPlaneAttestation,
      });
    }
    return assessment.admission;
  }

  async function prepareDeploymentMutation(
    method: 'PUT' | 'DELETE',
    id: string,
    original: EdgeDeploymentSnapshot,
  ): Promise<void> {
    assertDeploymentEvidence(original, namespace);
    if (!isDeploymentTag(original.namespace_etag)) {
      throw edgeError('Original deployment-v1 authority is required');
    }
    if (method === 'DELETE') {
      deploymentTarget(original, id);
    } else {
      const specs = original.api_specs.filter((spec) => spec.id === id);
      if (specs.length !== 1 || typeof specs[0]!.proxy_id !== 'string') {
        throw conflict('The replacement target is not owned by the original deployment');
      }
      deploymentTarget(original, specs[0]!.proxy_id);
    }
    await assertBackendEgress();
  }

  async function deploymentMutation(
    method: 'PUT' | 'DELETE',
    id: string,
    original: EdgeDeploymentSnapshot,
    subject?: string,
    document?: EdgeApiSpecDocument,
  ): Promise<void> {
    try {
      await prepareDeploymentMutation(method, id, original);
    } catch (error) {
      // Nothing was sent: the caller may retract its pending journal entry.
      if (typeof error === 'object' && error !== null) NOT_DISPATCHED.add(error);
      throw error;
    }
    let headers: Record<string, string | string[] | undefined> = {};
    const acknowledgement = await callRequired<EdgeDeploymentAcknowledgement>(
      method,
      `/${method === 'DELETE' ? 'proxies' : 'api-specs'}/${encodeURIComponent(id)}`,
      {
        subject,
        body: document,
        query: {
          conditional: true,
          ...(method === 'DELETE' ? { cleanup_orphaned_upstream: false } : {}),
        },
        ifMatch: original.namespace_etag,
        deployment: true,
        responseHeaders: (value) => {
          headers = value;
        },
      },
    );
    assertDeploymentApplied(acknowledgement, id);
    const cursor = headers['x-ferrum-config-cursor'];
    if (
      typeof cursor !== 'string' ||
      !/^[0-9]+:[0-9]+(?![\s\S])/.test(cursor) ||
      headers[NAMESPACE_UNSERVED_HEADER] === NAMESPACE_UNSERVED_HEADER_VALUE
    ) {
      throw edgeError('Gateway deployment covering application proof is unavailable', {
        kind: 'deployment_acknowledgement_uncertain',
      });
    }
  }

  /** Same as `call`, for endpoints that must return a body. */
  async function callRequired<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    options: CallOptions = {},
  ): Promise<T> {
    const result = await call<T>(method, path, options);
    if (result === null || result === undefined) {
      throw edgeError('The gateway returned an empty response where one was expected');
    }
    return result;
  }

  /**
   * `GET` a non-JSON body (the Prometheus exposition).
   *
   * Presents the gateway's metrics bearer token when one is configured and
   * the admin JWT otherwise. Edge reads either from `Authorization: Bearer`;
   * the bearer token is the one that still works once the admin JWT's `ns`
   * claim bounds it to namespace routes (Edge v0.9.16).
   *
   * Returns `null` rather than throwing when nothing reached the gateway, and
   * `body: null` when the gateway answered but its body could not be read; the
   * only caller is the metrics scrape, which must never fail a page render.
   */
  async function callText(path: string, accept: string): Promise<TextResponse | null> {
    const token = metricsBearerToken ?? (await minter.getToken(DEFAULT_ADMIN_SUBJECT));
    const signal = AbortSignal.timeout(config.timeoutMs);
    const send = () =>
      request(urlFor(path), {
        method: 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          [FERRUM_NAMESPACE_HEADER.toLowerCase()]: namespace,
          [FERRUM_PROVISIONED_BY_HEADER.toLowerCase()]: FERRUM_PROVISIONED_BY_VALUE,
          accept,
        },
        dispatcher,
        signal,
      });
    let response: Awaited<ReturnType<typeof send>>;
    try {
      // The same stale-pooled-socket recovery as `call`, on the one other read
      // this client makes. Nothing has been read yet, so no response byte can
      // have arrived.
      response = await send().catch((error: unknown) => {
        if (!shouldRetryOnFreshConnection('GET', error, false, signal)) throw error;
        return send();
      });
    } catch (cause) {
      logger.warn(
        { path, code: (cause as NodeJS.ErrnoException).code ?? null },
        'Ferrum Edge metrics scrape could not reach the gateway',
      );
      return null;
    }
    try {
      const bytes = await readBoundedBody(response.body, METRICS_RESPONSE_MAX_BYTES);
      return { statusCode: response.statusCode, body: bytes.toString('utf8') };
    } catch (cause) {
      // The gateway answered; its body was too large or broke off mid-read.
      // That is an unusable answer, not an unreachable gateway.
      return {
        statusCode: response.statusCode,
        body: null,
        bodyError:
          cause instanceof ResponseTooLargeError ? 'response_too_large' : 'body_read_failed',
      };
    }
  }

  /* ── Metrics caches ───────────────────────────────────────────────────── */

  let scrapeCache: CacheEntry<PrometheusSample[] | ScrapeFailure> | null = null;
  let scrapePending: Promise<PrometheusSample[] | ScrapeFailure> | null = null;
  let backendCache: CacheEntry<BackendRead> | null = null;
  let backendPending: Promise<BackendRead> | null = null;

  function readGlobalCache<T>(cache: CacheEntry<T> | null): T | undefined {
    return cache && cache.expiresAt > Date.now() ? cache.value : undefined;
  }

  /**
   * Whether a series belongs to the namespace this client speaks for.
   *
   * A **missing** `namespace` label counts as a match: Edge only labels series
   * when a gateway namespace is configured, so an unlabelled exposition comes
   * from a single-namespace gateway and there is no other tenant it could be
   * confused with. Requiring the label would make every such deployment report
   * zero traffic forever.
   */
  function namespaceMatches(label: unknown): boolean {
    return label === undefined || label === null || label === namespace;
  }

  /** Reduce one scrape's samples to the counters and histogram for `proxyId`. */
  function reduceProxySamples(samples: PrometheusSample[], proxyId: string): EdgeProxyMetrics {
    const byMethod: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    let total = 0;
    let hasRequests = false;
    const buckets = new Map<number, number>();
    let count: number | null = null;
    let sum: number | null = null;

    for (const sample of samples) {
      const { labels } = sample;
      if (labels.proxy_id !== proxyId) continue;
      if (!namespaceMatches(labels.namespace)) continue;

      if (sample.name === REQUESTS_FAMILY) {
        const value = counterValue(sample.value);
        if (value === null) continue;
        hasRequests = true;
        // One (method, status) pair can appear several times — `error_class`
        // and `grpc_status` split it further — so these accumulate.
        if (labels.method !== undefined) {
          byMethod[labels.method] = (byMethod[labels.method] ?? 0) + value;
        }
        if (labels.status_code !== undefined) {
          byStatus[labels.status_code] = (byStatus[labels.status_code] ?? 0) + value;
        }
        total += value;
        continue;
      }

      if (sample.name === `${DURATION_FAMILY}_bucket`) {
        const le = parseLe(labels.le);
        const value = counterValue(sample.value);
        if (le === null || value === null) continue;
        // Cumulative buckets: a repeated `le` should carry the same count, so
        // keeping the larger of the two cannot understate the histogram.
        buckets.set(le, Math.max(buckets.get(le) ?? 0, value));
        continue;
      }

      if (sample.name === `${DURATION_FAMILY}_count`) {
        count = counterValue(sample.value);
        continue;
      }
      if (sample.name === `${DURATION_FAMILY}_sum`) {
        sum = counterValue(sample.value);
      }
    }

    if (!hasRequests) {
      return emptyProxyMetrics('no_series', 'The gateway has no request metrics for this API yet.');
    }

    const sorted: EdgeLatencyBucket[] = [...buckets.entries()]
      .map(([le, bucketCount]) => ({ le, count: bucketCount }))
      .sort((a, b) => a.le - b.le);

    return {
      available: true,
      requests: { byMethod, byStatus, total },
      latency: { buckets: sorted, count, sum },
    };
  }

  /**
   * Walk every page of an Edge list endpoint.
   *
   * `visit` returns `false` to stop early. The walk also stops on an empty or
   * short page, once `offset + data.length` covers `pagination.total`, or after
   * `maxPages` pages — the cap keeps a runaway `total` from turning one probe
   * into an unbounded scan.
   *
   * Resolves `true` when the walk ended on its own terms — `visit` stopped it,
   * or the last page was read — and `false` when the page cap cut it short
   * with pages unread, so a caller can tell "not there" from "not looked".
   *
   * `filter` rides on every page request; Edge pages (and totals) the filtered
   * set, so the walk covers it exactly as it would an unfiltered list.
   */
  async function scanPages<T>(
    path: string,
    pageSize: number,
    maxPages: number,
    visit: (items: T[]) => boolean,
    filter: Record<string, string> = {},
  ): Promise<boolean> {
    for (let page = 0; page < maxPages; page += 1) {
      const offset = page * pageSize;
      const result = await callRequired<EdgePage<T>>('GET', path, {
        query: { ...filter, limit: pageSize, offset },
      });
      // Both scan sizes are within Edge's documented cap. A different size
      // would make the next offset skip rows and could falsely imply absence.
      if (result.pagination.limit !== pageSize) {
        throw protocolError(200, 'page_mismatch', 'GET', path);
      }
      const items = result.data;
      if (!visit(items)) return true;
      if (items.length === 0 || items.length < pageSize) return true;
      const total = result.pagination.total;
      if (offset + items.length >= total) return true;
    }
    return false;
  }

  return {
    namespace,
    namespaceMonitor,
    backendEgressPolicy,
    assertBackendEgress,
    deployments: {
      async snapshot(subject?: string): Promise<EdgeDeploymentSnapshot> {
        let etag: string | string[] | undefined;
        const snapshot = await callRequired<EdgeDeploymentSnapshot>('GET', '/deployment-snapshot', {
          subject,
          responseHeaders: (headers) => {
            etag = headers.etag;
          },
        });
        if (!isDeploymentTag(etag) || etag !== snapshot.namespace_etag) {
          throw protocolError(200, 'invalid_deployment_authority', 'GET', '/deployment-snapshot');
        }
        assertDeploymentEvidence(snapshot, namespace);
        return snapshot;
      },
      async prepare(kind, id, original): Promise<void> {
        await prepareDeploymentMutation(kind === 'remove' ? 'DELETE' : 'PUT', id, original);
      },
      async remove(id, original, subject): Promise<void> {
        await deploymentMutation('DELETE', id, original, subject);
      },
      async replace(id, document, original, subject): Promise<void> {
        await deploymentMutation('PUT', id, original, subject, document);
      },
    },

    async health(): Promise<EdgeHealth> {
      // `503` is reachable-but-not-ready only with a valid health payload.
      return callRequired<EdgeHealth>('GET', '/health');
    },

    async live(): Promise<boolean> {
      const result = await call<{ status?: string }>('GET', '/live', { allow404: true });
      return result !== null;
    },

    async version(): Promise<string | null> {
      return readVersion();
    },

    async probe(timeoutMs = config.timeoutMs): Promise<EdgeProbe> {
      const started = Date.now();
      const signal = AbortSignal.timeout(timeoutMs);
      try {
        const health = await callRequired<EdgeHealth>('GET', '/health', { signal });
        let backendEgressVerified = false;
        let publicEgressGuaranteed = false;
        let backendEgressSchemaUnsupported = false;
        let backendEgressDetail: string | null = null;
        try {
          const { reading, freshness } = await readEgressPolicy(signal);
          const assessment = assessBackendEgress(reading, deps, freshness);
          // The guarantee is the gateway's alone: an opt-out accepts a weaker
          // policy for writes, but never turns it into public-only egress.
          publicEgressGuaranteed = assessment.publicEgressGuaranteed;
          backendEgressVerified = assessment.admission !== null;
          backendEgressDetail = describeDataPlaneAttestation(assessment.dataPlaneAttestation);
        } catch (error) {
          // Observational only. No mutation ever consults this sampled result.
          backendEgressSchemaUnsupported = isUnsupportedSchemaRefusal(error);
        }
        let version: string | null = null;
        try {
          version = await readVersion(signal);
        } catch {
          version = null;
        }
        // Folded in here rather than by the caller so that *every* probe
        // refreshes the verdict — `/api/health`, the startup check, and any
        // future one — and an operator who fixes the gateway sees the portal
        // recover without restarting it.
        const serving = parseNamespaceServing(health.namespace);
        namespaceMonitor.observeHealth(serving);
        // The minimal tier (`status` and `ready` only) is what a gateway
        // serves a credential it does not trust with detail. Nothing it omits
        // is assumed: mode, write state and routability all read unknown.
        noteHealthTier(health);
        return {
          reachable: true,
          latencyMs: Date.now() - started,
          status: typeof health.status === 'string' ? health.status : null,
          ready: typeof health.ready === 'boolean' ? health.ready : null,
          mode: typeof health.mode === 'string' ? health.mode : null,
          adminWritesEnabled:
            typeof health.admin_writes_enabled === 'boolean' ? health.admin_writes_enabled : null,
          version,
          error: null,
          namespace: serving,
          backendEgressVerified,
          publicEgressGuaranteed,
          backendEgressSchemaUnsupported,
          backendEgressDetail,
        };
      } catch (error) {
        return {
          reachable: false,
          latencyMs: Date.now() - started,
          status: null,
          ready: null,
          mode: null,
          adminWritesEnabled: null,
          version: null,
          error: error instanceof Error ? error.message : 'unknown error',
          namespace: null,
          backendEgressVerified: false,
          publicEgressGuaranteed: false,
          backendEgressSchemaUnsupported: false,
        };
      }
    },

    async listNamespaces(): Promise<string[]> {
      const page = await callRequired<EdgePage<string>>('GET', '/namespaces', {
        query: { limit: 1000 },
      });
      return page.data;
    },

    async ensureNamespace(description?: string): Promise<void> {
      try {
        const existing = await call<unknown>(
          'GET',
          `/namespaces/${encodeURIComponent(namespace)}`,
          {
            allow404: true,
          },
        );
        if (existing !== null) return;
        await call('POST', '/namespaces', {
          body: { name: namespace, ...(description ? { description } : {}) },
          // 409: created concurrently. 501: MongoDB standalone refuses namespace writes.
          tolerate: [409, 501],
        });
      } catch (error) {
        // Namespaces are created implicitly by the first resource write, so a
        // failure here must not block startup.
        logger.warn(
          { namespace, error: error instanceof Error ? error.message : String(error) },
          'Could not pre-create the Ferrum namespace; it will be created implicitly',
        );
      }
    },

    async ensureMetricsConfig(): Promise<EdgePluginConfig | null> {
      return serializePerKey(`namespace:${namespace}:prometheus_metrics`, async () => {
        let found = false;
        const complete = await scanPages<EdgePluginConfig>(
          '/plugins/config',
          EDGE_MAX_PAGE_SIZE,
          MAX_PLUGIN_CONFIG_SCAN_PAGES,
          (items) => {
            found = items.some(
              (item) => item.plugin_name === 'prometheus_metrics' && item.scope === 'global',
            );
            return !found;
          },
        );
        // Even a disabled operator config is intentional; never replace it.
        if (found) return null;
        if (!complete) throw edgeError('Could not scan all gateway plugin configs');
        return this.pluginConfigs.create({
          plugin_name: 'prometheus_metrics',
          scope: 'global',
          enabled: true,
          config: {},
        });
      });
    },

    consumers: {
      async list(query?: EdgeListQuery): Promise<EdgePage<EdgeConsumer>> {
        return callRequired<EdgePage<EdgeConsumer>>('GET', '/consumers', { query: { ...query } });
      },

      async get(id, options): Promise<EdgeConsumer | null> {
        return call<EdgeConsumer>('GET', `/consumers/${encodeURIComponent(id)}`, {
          allow404: true,
          ...(options?.confirmedAbsence ? { absentError: CONSUMER_NOT_FOUND } : {}),
        });
      },

      async verification(
        id,
        subject,
      ): Promise<{ consumer: EdgeVerifiedConsumer; etag: string } | null> {
        let etag: string | undefined;
        const consumer = await call<EdgeVerifiedConsumer>(
          'GET',
          `/consumers/${encodeURIComponent(id)}/verification`,
          {
            allow404: true,
            // Callers act on absence: ACL cleanup counts a missing consumer
            // as done. Only Edge's own answer for that consumer proves it.
            absentError: CONSUMER_NOT_FOUND,
            subject,
            responseHeaders: (headers) => {
              if (typeof headers.etag === 'string') etag = headers.etag;
            },
          },
        );
        if (!consumer) return null;
        if (!isStrongRowTag(etag)) {
          throw protocolError(
            200,
            'invalid_consumer_verification',
            'GET',
            '/consumers/verification',
          );
        }
        return { consumer, etag };
      },

      async getByUsername(username: string): Promise<EdgeConsumer | null> {
        logger.warn({ username }, 'Scanning legacy consumer identity without a stored gateway id');
        let found: EdgeConsumer | null = null;
        const complete = await scanPages<EdgeConsumer>(
          '/consumers',
          CONSUMER_SCAN_PAGE_SIZE,
          MAX_CONSUMER_SCAN_PAGES,
          (items) => {
            // access_control matches usernames byte-for-byte, so this does too.
            const match = items.find((consumer) => consumer.username === username);
            if (!match) return true;
            found = match;
            return false;
          },
        );
        if (found === null && !complete) {
          // Not "no such consumer" — the namespace holds more than the scan
          // reads, and a `null` here would be acted on as if it were.
          logger.warn(
            { path: '/consumers', scanned: CONSUMER_SCAN_LIMIT, username },
            'Consumer lookup by username gave up before the end of the namespace',
          );
          throw edgeError(
            'The gateway holds more consumers than a legacy username lookup can scan; an administrator must restore the consumer id mapping from backup after verifying its namespace and username (docs/operations.md, Consumer identity recovery)',
            { scanned: CONSUMER_SCAN_LIMIT, username },
          );
        }
        return found;
      },

      derivedId(username: string): string {
        return derivedConsumerId(namespace, username);
      },

      async ensure(body, subject): Promise<{ consumer: EdgeConsumer; created: boolean }> {
        const id = derivedConsumerId(namespace, body.username);
        const existing = await this.get(id);
        if (existing) {
          if (existing.username !== body.username) {
            throw edgeError(
              'The derived consumer id belongs to another username; contact an administrator',
            );
          }
          return { consumer: existing, created: false };
        }
        try {
          return { consumer: await this.create({ ...body, id }, subject), created: true };
        } catch (error) {
          // A 409 is a refused write, never an uncertain acknowledgement. Do not
          // parse an incumbent id out of Edge's free-form error text.
          if (
            !(error instanceof NexusError) ||
            !isRecord(error.details) ||
            error.details.status !== 409
          ) {
            throw error;
          }
          const legacy = await this.getByUsername(body.username);
          if (!legacy) throw error;
          return { consumer: legacy, created: false };
        }
      },

      async create(body: EdgeConsumerWrite, subject?: string): Promise<EdgeConsumer> {
        return callRequired<EdgeConsumer>('POST', '/consumers', { body, subject });
      },

      async replace(id, body, subject, ifMatch): Promise<EdgeConsumer> {
        if (!isStrongRowTag(ifMatch)) {
          throw edgeError(
            'A credential-complete consumer snapshot and strong row tag are required',
          );
        }
        return callRequired<EdgeConsumer>('PUT', `/consumers/${encodeURIComponent(id)}`, {
          body: {
            ...body,
            ...(body.credentials === undefined
              ? {}
              : { credentials: consumerMetadataCredentials(body.credentials) }),
          },
          subject,
          ifMatch,
        });
      },

      async delete(id: string, subject?: string): Promise<void> {
        await call('DELETE', `/consumers/${encodeURIComponent(id)}`, { subject });
      },

      async addCredential(
        id: string,
        type: EdgeCredentialType,
        entry: EdgeCredentialEntry,
        subject?: string,
      ): Promise<EdgeConsumer> {
        return callRequired<EdgeConsumer>(
          'POST',
          `/consumers/${encodeURIComponent(id)}/credentials/${type}`,
          { body: entry, subject },
        );
      },

      async replaceCredentials(
        id: string,
        type: EdgeCredentialType,
        entries: EdgeCredentialEntry[],
        subject?: string,
      ): Promise<EdgeConsumer> {
        return callRequired<EdgeConsumer>(
          'PUT',
          `/consumers/${encodeURIComponent(id)}/credentials/${type}`,
          { body: entries, subject },
        );
      },

      async deleteCredentialAt(
        id: string,
        type: EdgeCredentialType,
        index: number,
        subject?: string,
      ): Promise<EdgeConsumer> {
        return callRequired<EdgeConsumer>(
          'DELETE',
          `/consumers/${encodeURIComponent(id)}/credentials/${type}/${index}`,
          { subject },
        );
      },

      async deleteCredentialType(
        id: string,
        type: EdgeCredentialType,
        subject?: string,
      ): Promise<void> {
        await call('DELETE', `/consumers/${encodeURIComponent(id)}/credentials/${type}`, {
          subject,
        });
      },
    },

    proxies: {
      async list(query?: EdgeListQuery): Promise<EdgePage<EdgeProxy>> {
        return callRequired<EdgePage<EdgeProxy>>('GET', '/proxies', { query: { ...query } });
      },
      async get(id, options): Promise<EdgeProxy | null> {
        return call<EdgeProxy>('GET', `/proxies/${encodeURIComponent(id)}`, {
          allow404: true,
          ...(options?.confirmedAbsence ? { absentError: PROXY_NOT_FOUND } : {}),
        });
      },
      async create(
        body: EdgeProxyWrite,
        subject?: string,
        options?: { preserveLabels: true },
      ): Promise<EdgeProxy> {
        await assertBackendEgress();
        return callRequired<EdgeProxy>('POST', '/proxies', { body, subject, ...options });
      },
      async replace(id: string, body: EdgeProxyReplace, subject?: string): Promise<EdgeProxy> {
        await assertBackendEgress();
        return callRequired<EdgeProxy>('PUT', `/proxies/${encodeURIComponent(id)}`, {
          body,
          subject,
        });
      },
      async delete(
        id: string,
        subject?: string,
        options?: { cleanupOrphanedUpstream: false },
      ): Promise<void> {
        await call('DELETE', `/proxies/${encodeURIComponent(id)}`, {
          subject,
          // Callers record the proxy as removed. Only Edge's own answer for
          // that proxy proves it; a router's `404` does not.
          allow404: true,
          absentError: PROXY_NOT_FOUND,
          query: { cleanup_orphaned_upstream: options?.cleanupOrphanedUpstream },
        });
      },
    },

    pluginConfigs: {
      async list(query?: EdgeListQuery): Promise<EdgePage<EdgePluginConfig>> {
        return callRequired<EdgePage<EdgePluginConfig>>('GET', '/plugins/config', {
          query: { ...query },
        });
      },
      async listByProxy(proxyId: string): Promise<EdgePluginConfig[]> {
        const attached: EdgePluginConfig[] = [];
        const complete = await scanPages<EdgePluginConfig>(
          '/plugins/config',
          EDGE_MAX_PAGE_SIZE,
          MAX_PLUGIN_CONFIG_SCAN_PAGES,
          (items) => {
            // The gateway already filtered; the check only keeps a gateway
            // older than the filter (which ignores the parameter and pages
            // the whole namespace) from attributing another proxy's configs.
            for (const config of items) {
              if (config.proxy_id === proxyId) attached.push(config);
            }
            return true;
          },
          { proxy_id: proxyId },
        );
        // A partial list is not "everything on this proxy": callers act on
        // what is missing from it — create a config that seems absent, or
        // conclude a teardown left nothing behind — so a scan the page cap cut
        // short has to fail rather than answer (#335).
        if (!complete) {
          throw edgeError('Could not scan all gateway plugin configs', {
            proxy_id: proxyId,
            scanned: EDGE_MAX_PAGE_SIZE * MAX_PLUGIN_CONFIG_SCAN_PAGES,
          });
        }
        return attached;
      },
      async get(id, options): Promise<EdgePluginConfig | null> {
        return call<EdgePluginConfig>('GET', `/plugins/config/${encodeURIComponent(id)}`, {
          allow404: true,
          ...(options?.confirmedAbsence ? { absentError: PLUGIN_CONFIG_NOT_FOUND } : {}),
        });
      },
      async create(
        body: EdgePluginConfigWrite,
        subject?: string,
        options?: { preserveLabels: true },
      ): Promise<EdgePluginConfig> {
        return callRequired<EdgePluginConfig>('POST', '/plugins/config', {
          body,
          subject,
          ...options,
        });
      },
      async replace(
        id: string,
        body: EdgePluginConfigWrite,
        subject?: string,
      ): Promise<EdgePluginConfig> {
        return callRequired<EdgePluginConfig>('PUT', `/plugins/config/${encodeURIComponent(id)}`, {
          body,
          subject,
        });
      },
      async delete(id: string, subject?: string): Promise<void> {
        await call('DELETE', `/plugins/config/${encodeURIComponent(id)}`, {
          subject,
          allow404: true,
          absentError: PLUGIN_CONFIG_NOT_FOUND,
        });
      },
    },

    apiSpecs: {
      async create(
        document: EdgeApiSpecDocument,
        subject?: string,
        options?: { preserveLabels: true },
      ): Promise<EdgeApiSpecRef> {
        await assertBackendEgress();
        return callRequired<EdgeApiSpecRef>('POST', '/api-specs', {
          body: document,
          subject,
          ...options,
        });
      },
      async replace(
        id: string,
        document: EdgeApiSpecDocument,
        subject?: string,
      ): Promise<EdgeApiSpecRef> {
        await assertBackendEgress();
        return callRequired<EdgeApiSpecRef>('PUT', `/api-specs/${encodeURIComponent(id)}`, {
          body: document,
          subject,
        });
      },
      async findByProxy(proxyId: string): Promise<EdgeApiSpecSummary | null> {
        // `(namespace, proxy_id)` is unique, so one page of one is the whole
        // answer; the filter is applied by the gateway rather than here.
        const page = await callRequired<EdgeApiSpecPage>('GET', '/api-specs', {
          query: { proxy_id: proxyId, limit: 1 },
        });
        return page.items[0] ?? null;
      },
      async documentByProxy(proxyId: string): Promise<Record<string, unknown> | null> {
        return call<Record<string, unknown>>(
          'GET',
          `/api-specs/by-proxy/${encodeURIComponent(proxyId)}`,
          { allow404: true },
        );
      },
      async delete(id: string, subject?: string): Promise<void> {
        await call('DELETE', `/api-specs/${encodeURIComponent(id)}`, {
          subject,
          allow404: true,
          absentError: API_SPEC_NOT_FOUND,
        });
      },
    },

    metrics: {
      async scrapeProxy(proxyId: string): Promise<EdgeProxyMetrics> {
        let scraped = readGlobalCache(scrapeCache);
        if (scraped === undefined) {
          scrapePending ??= (async (): Promise<PrometheusSample[] | ScrapeFailure> => {
            const response = await callText('/metrics', 'text/plain;version=0.0.4');
            let result: PrometheusSample[] | ScrapeFailure;
            let detail: string | null = null;
            if (response === null) {
              result = METRICS_UNREACHABLE;
            } else if (response.statusCode >= 200 && response.statusCode < 300) {
              result = response.body === null ? [] : parsePrometheusText(response.body);
              if (result.length === 0) {
                detail = response.bodyError ?? 'no_parseable_samples';
                result = METRICS_UNREADABLE;
              }
            } else {
              result = metricsScrapeFailure(response.statusCode, metricsBearerToken !== undefined);
            }
            // An unreachable gateway is logged where it happens, in `callText`.
            if (Array.isArray(result)) {
              noteScrape(null);
            } else if (result !== METRICS_UNREACHABLE) {
              noteScrape({
                code: result.code,
                status: response?.statusCode ?? null,
                credential: metricsBearerToken === undefined ? 'admin_jwt' : 'metrics_bearer',
                detail,
                hint: result.hint,
              });
            }
            scrapeCache = { value: result, expiresAt: Date.now() + METRICS_CACHE_TTL_MS };
            return result;
          })().finally(() => {
            scrapePending = null;
          });
          scraped = await scrapePending;
        }
        return Array.isArray(scraped)
          ? reduceProxySamples(scraped, proxyId)
          : emptyProxyMetrics(scraped.code, scraped.reason);
      },

      async backendState(proxyId: string): Promise<EdgeBackendState> {
        let read = readGlobalCache(backendCache);
        if (read === undefined) {
          backendPending ??= call<unknown>('GET', '/admin/metrics', {
            maxResponseBytes: METRICS_RESPONSE_MAX_BYTES,
            quiet: true,
            ...(fleetReadMinter === null ? {} : { minter: fleetReadMinter }),
          })
            .then((value): BackendRead => {
              const result: BackendRead = isRecord(value)
                ? { payload: value }
                : { payload: null, failure: backendStateFailure(200, false) };
              noteBackendRead(result.payload === null ? { status: 200, hint: null } : null);
              backendCache = { value: result, expiresAt: Date.now() + METRICS_CACHE_TTL_MS };
              return result;
            })
            .catch((error: unknown): BackendRead => {
              const details = error instanceof NexusError ? error.details : undefined;
              const status = isRecord(details) ? details.status : undefined;
              const failure = backendStateFailure(status, fleetReadMinter !== null);
              noteBackendRead({
                status: typeof status === 'number' ? status : null,
                credential: fleetReadMinter === null ? 'admin_jwt' : 'fleet_read_jwt',
                error: error instanceof Error ? error.message : 'unknown',
                hint: failure.hint,
              });
              const result: BackendRead = { payload: null, failure };
              backendCache = { value: result, expiresAt: Date.now() + METRICS_CACHE_TTL_MS };
              return result;
            })
            .finally(() => {
              backendPending = null;
            });
          read = await backendPending;
        }
        if (read.payload === null) {
          return emptyBackendState(read.failure.reason);
        }

        const body = read.payload;
        const rawBreakers = Array.isArray(body.circuit_breakers) ? body.circuit_breakers : [];
        const breakers: EdgeCircuitBreaker[] = [];
        for (const entry of rawBreakers) {
          if (typeof entry !== 'object' || entry === null) continue;
          const breaker = entry as Record<string, unknown>;
          if (breaker.proxy_id !== proxyId) continue;
          if (!namespaceMatches(breaker.namespace)) continue;
          if (typeof breaker.state !== 'string') continue;
          breakers.push(breaker as unknown as EdgeCircuitBreaker);
        }

        const healthCheck = body.health_check;
        const rawTargets =
          typeof healthCheck === 'object' &&
          healthCheck !== null &&
          Array.isArray((healthCheck as Record<string, unknown>).unhealthy_targets)
            ? ((healthCheck as Record<string, unknown>).unhealthy_targets as unknown[])
            : [];
        const unhealthyTargets: EdgeUnhealthyTarget[] = [];
        for (const entry of rawTargets) {
          if (typeof entry !== 'object' || entry === null) continue;
          const target = entry as Record<string, unknown>;
          if (!namespaceMatches(target.namespace)) continue;
          // Only `proxy_id`-keyed entries are attributable. Nexus publishes a
          // direct backend on the proxy and never creates an Edge `upstream`,
          // so an `upstream_id`-keyed ejection belongs to a resource an
          // operator built by hand and cannot be pinned to this API.
          if (target.proxy_id !== proxyId) continue;
          unhealthyTargets.push(target as unknown as EdgeUnhealthyTarget);
        }

        return {
          available: true,
          breakers,
          unhealthyTargets,
          uptimeSeconds: numberAt(body.gateway, 'uptime_seconds'),
        };
      },
    },

    serializePerKey,

    async close(): Promise<void> {
      if (deps.dispatcher) return;
      await dispatcher.close();
    },
  };
}
