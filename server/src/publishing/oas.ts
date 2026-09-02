/**
 * OpenAPI document parsing and validation.
 *
 * A pure module: text in, metadata out. It never touches the store, the Edge
 * client or the network, which is what makes the publishing service testable
 * without either.
 *
 * ## What Nexus validates, and what it deliberately does not
 *
 * Nexus is a portal, not a spec linter. It checks only what publishing actually
 * depends on:
 *
 * - the document parses as JSON or YAML and is a JSON object;
 * - `openapi` is a **3.x** version string — Swagger 2.0 (`swagger: "2.0"`) is
 *   rejected, because the gateway-facing fields Nexus reads (`servers`) do not
 *   exist there;
 * - `info.title` and `info.version` are present, because they become the
 *   catalog's display title and the spec revision label;
 * - `paths` is an object, because a document with no operations cannot be
 *   rendered or usefully proxied;
 * - the document declares no more than {@link MAX_SPEC_PATHS} paths and
 *   {@link MAX_SPEC_OPERATIONS} operations. That is a *client* protection
 *   rather than a gateway one: `MAX_SPEC_BYTES` bounds the transfer but not the
 *   structure, and a server-valid 2 MiB document holding tens of thousands of
 *   minimal operations would freeze every catalog viewer that renders one card
 *   per operation.
 *
 * Everything else (schema correctness, `$ref` resolution, operation shape) is
 * left alone: an over-strict portal would reject specs the gateway is perfectly
 * happy to sit in front of.
 *
 * `servers[0].url` is read as the **default upstream**, but only when it is an
 * absolute `http(s)` URL. Relative server URLs (`/v1`, `./api`) are legal
 * OpenAPI and simply mean "same origin as wherever this document is served
 * from" — there is no origin to resolve them against here, so they yield no
 * upstream and the provider must supply one.
 */

import { isIP } from 'node:net';

import { parse as parseYaml } from 'yaml';

import {
  MAX_SPEC_BYTES,
  MAX_SPEC_OPERATIONS,
  MAX_SPEC_PATHS,
  OPENAPI_OPERATION_METHODS,
} from '@ferrum-nexus/shared';

import { specInvalid } from '../lib/errors.js';

/** Upstream a proxy should forward to, decomposed into Edge's proxy fields. */
export interface SpecUpstream {
  /** The absolute URL exactly as it appeared (or was supplied). */
  url: string;
  scheme: 'http' | 'https';
  /** Hostname only — Edge rejects a `backend_host` that contains a scheme. */
  host: string;
  /** Explicit port, or the scheme default (80/443). */
  port: number;
  /** Path component to prepend to forwarded requests, or `null` for none. */
  basePath: string | null;
}

/** Everything the publishing service needs out of an uploaded document. */
export interface ParsedSpec {
  /** `info.title`. */
  title: string;
  /** `info.version`. */
  version: string;
  /** `info.description`, trimmed, or `null`. */
  description: string | null;
  /** The `openapi` version string, e.g. `3.1.0`. */
  openapiVersion: string;
  /** `servers[0].url` when it is absolute http(s), else `null`. */
  defaultUpstream: SpecUpstream | null;
  /** Number of path items — surfaced in audit details and the provider UI. */
  pathCount: number;
  /** Number of operations (path item × HTTP method) across the whole document. */
  operationCount: number;
  /** Content type matching {@link ParsedSpec.raw}. */
  contentType: 'application/json' | 'application/yaml';
  /** The document as uploaded, with only surrounding whitespace trimmed. */
  raw: string;
}

/** Byte length of a UTF-8 string. */
function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Split an absolute `http(s)` URL into Edge's `backend_*` fields.
 *
 * Returns `null` for anything that is not an absolute http(s) URL — including
 * the relative server URLs OpenAPI permits.
 */
export function parseUpstreamUrl(raw: string): SpecUpstream | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.hostname === '' || url.username !== '' || url.password !== '') return null;

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!isPublicUpstreamHost(host)) return null;

  const scheme = url.protocol === 'https:' ? 'https' : 'http';
  const port = url.port === '' ? (scheme === 'https' ? 443 : 80) : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;

  const path = url.pathname.replace(/\/+$/, '');
  return {
    url: trimmed,
    scheme,
    host,
    port,
    basePath: path === '' || path === '/' ? null : path,
  };
}

/**
 * Reject destinations that must never be reachable through a provider-owned proxy.
 *
 * This check intentionally happens while parsing so it covers explicit upstreams,
 * OpenAPI `servers`, API updates, and spec-following proxy moves alike. Network
 * egress controls should still be used to defend against a public DNS name that is
 * changed after publication.
 */
function isPublicUpstreamHost(host: string): boolean {
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.home.arpa')
  ) {
    return false;
  }

  const version = isIP(host);
  if (version === 4) return isPublicIpv4(host);
  if (version === 6) return isPublicIpv6(host);
  return true;
}

function isPublicIpv4(host: string): boolean {
  const octets = host.split('.').map(Number);
  const a = octets[0] ?? 0;
  const b = octets[1] ?? 0;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPublicIpv6(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized === '::' || normalized === '::1') return false;

  const first = Number.parseInt(normalized.split(':', 1)[0] || '0', 16);
  return !(
    first === 0 || // unspecified, IPv4-compatible, and IPv4-mapped forms
    (first >= 0xfc00 && first <= 0xfdff) || // unique-local fc00::/7
    (first >= 0xfe80 && first <= 0xfebf) || // link-local fe80::/10
    (first >= 0xff00 && first <= 0xffff) // multicast ff00::/8
  );
}

/** Parse `text` as JSON, falling back to YAML (JSON is a subset, so order matters). */
function parseDocument(text: string): { value: unknown; contentType: ParsedSpec['contentType'] } {
  const looksJson = text.startsWith('{') || text.startsWith('[');
  if (looksJson) {
    try {
      return { value: JSON.parse(text) as unknown, contentType: 'application/json' };
    } catch (cause) {
      throw specInvalid('The document is not valid JSON', {
        reason: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
  try {
    return { value: parseYaml(text) as unknown, contentType: 'application/yaml' };
  } catch (cause) {
    throw specInvalid('The document is not valid YAML or JSON', {
      reason: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

/**
 * Parse and validate an uploaded OpenAPI document.
 *
 * @throws NexusError `SPEC_INVALID` with a `details` object naming the offending
 * field, so the provider UI can point at the right line of their document.
 */
export function parseOpenApiSpec(text: string): ParsedSpec {
  if (typeof text !== 'string' || text.trim() === '') {
    throw specInvalid('An OpenAPI document is required');
  }
  const size = byteLength(text);
  if (size > MAX_SPEC_BYTES) {
    throw specInvalid(
      `The OpenAPI document is larger than the ${Math.floor(MAX_SPEC_BYTES / 1024)} KiB limit`,
      { bytes: size, limit: MAX_SPEC_BYTES },
    );
  }

  const raw = text.trim();
  const { value, contentType } = parseDocument(raw);

  if (!isRecord(value)) {
    throw specInvalid('The OpenAPI document must be a JSON or YAML object');
  }

  if (typeof value.swagger === 'string') {
    throw specInvalid('Swagger 2.0 documents are not supported; upload an OpenAPI 3.x document', {
      field: 'swagger',
      value: value.swagger,
    });
  }

  const openapiVersion = value.openapi;
  if (typeof openapiVersion !== 'string' || openapiVersion.trim() === '') {
    throw specInvalid("The document is missing the 'openapi' version field", { field: 'openapi' });
  }
  if (!/^3\.\d+(\.\d+)?/.test(openapiVersion.trim())) {
    throw specInvalid('Only OpenAPI 3.x documents are supported', {
      field: 'openapi',
      value: openapiVersion,
    });
  }

  const info = value.info;
  if (!isRecord(info)) {
    throw specInvalid("The document is missing the 'info' object", { field: 'info' });
  }
  const title = typeof info.title === 'string' ? info.title.trim() : '';
  if (title === '') {
    throw specInvalid("The document is missing 'info.title'", { field: 'info.title' });
  }
  const version = typeof info.version === 'string' ? info.version.trim() : '';
  if (version === '') {
    throw specInvalid("The document is missing 'info.version'", { field: 'info.version' });
  }
  const description =
    typeof info.description === 'string' && info.description.trim() !== ''
      ? info.description.trim()
      : null;

  const paths = value.paths;
  if (!isRecord(paths)) {
    throw specInvalid("The document is missing a 'paths' object", { field: 'paths' });
  }

  const pathCount = Object.keys(paths).length;
  if (pathCount > MAX_SPEC_PATHS) {
    throw specInvalid(
      `The document declares ${pathCount} paths, more than the ${MAX_SPEC_PATHS} path limit`,
      { field: 'paths', paths: pathCount, limit: MAX_SPEC_PATHS },
    );
  }
  const operationCount = countOperations(paths);
  if (operationCount > MAX_SPEC_OPERATIONS) {
    throw specInvalid(
      `The document declares ${operationCount} operations, more than the ${MAX_SPEC_OPERATIONS} operation limit`,
      { field: 'paths', operations: operationCount, limit: MAX_SPEC_OPERATIONS },
    );
  }

  return {
    title,
    version,
    description,
    openapiVersion: openapiVersion.trim(),
    defaultUpstream: readDefaultUpstream(value.servers),
    pathCount,
    operationCount,
    contentType,
    raw,
  };
}

/**
 * Operations across every path item.
 *
 * Only the eight OpenAPI HTTP-method keys count; `parameters`, `summary`,
 * `servers`, `$ref` and `x-` extensions are path-item metadata, not operations.
 * A non-object path item contributes nothing rather than failing the document —
 * Nexus is not a spec linter (see the module docblock).
 */
function countOperations(paths: Record<string, unknown>): number {
  let count = 0;
  for (const item of Object.values(paths)) {
    if (!isRecord(item)) continue;
    for (const method of OPENAPI_OPERATION_METHODS) {
      if (item[method] !== undefined) count += 1;
    }
  }
  return count;
}

/** `servers[0].url` as an upstream, when it is absolute http(s). */
function readDefaultUpstream(servers: unknown): SpecUpstream | null {
  if (!Array.isArray(servers)) return null;
  for (const server of servers) {
    if (!isRecord(server) || typeof server.url !== 'string') continue;
    const parsed = parseUpstreamUrl(server.url);
    if (parsed) return parsed;
    // A relative URL is valid OpenAPI but unusable as a backend; keep looking
    // in case a later entry is absolute.
  }
  return null;
}

/**
 * Resolve the upstream a proxy should use: the provider's explicit value when
 * they gave one, otherwise the spec's first absolute server URL.
 *
 * @throws NexusError `SPEC_INVALID` when neither source yields one.
 */
export function resolveUpstream(spec: ParsedSpec, explicit?: string | null): SpecUpstream {
  if (explicit !== undefined && explicit !== null && explicit.trim() !== '') {
    const parsed = parseUpstreamUrl(explicit);
    if (!parsed) {
      throw specInvalid('The upstream URL must be an absolute http:// or https:// URL', {
        field: 'upstream_url',
        value: explicit,
      });
    }
    return parsed;
  }
  if (spec.defaultUpstream) return spec.defaultUpstream;
  throw specInvalid(
    "No upstream could be determined: supply 'upstream_url', or give the document an absolute 'servers[0].url'",
    { field: 'upstream_url' },
  );
}

/** Turn a name into a URL-safe slug candidate (`Billing API v2` → `billing-api-v2`). */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
