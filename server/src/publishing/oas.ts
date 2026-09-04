/**
 * OpenAPI document parsing and validation.
 *
 * Text in, metadata out: the module never touches the store or the Edge client,
 * which is what makes the publishing service testable without either. Its one
 * network dependency — the DNS lookup behind the upstream policy — is injected,
 * so it is testable without that too.
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
 *
 * Parsing is deliberately policy-free. Whether a given host may be *used* as an
 * upstream (loopback, RFC 1918, cloud metadata, `.internal` names — the SSRF
 * surface a provider-owned proxy opens) is decided by
 * {@link assertUpstreamAllowed}, which the publishing service applies at every
 * point it is about to write a backend to the gateway. Keeping the two apart
 * lets a spec with a private `servers[0]` still be *stored* for an API whose
 * backend is pinned elsewhere.
 *
 * That policy check is the one thing in this module that is **not** pure: a
 * hostname says nothing about where it points, so it resolves the name (through
 * an injected {@link UpstreamResolver}) and judges the addresses. Everything
 * above it — parsing, limits, `servers[0]` — still runs without a network.
 */

import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';

import { parse as parseYaml } from 'yaml';

import {
  MAX_SPEC_BYTES,
  MAX_SPEC_OPERATIONS,
  MAX_SPEC_PATHS,
  OPENAPI_OPERATION_METHODS,
} from '@ferrum-nexus/shared';

import { specInvalid, type NexusError } from '../lib/errors.js';

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

/**
 * One declared path item: the template exactly as the document spells it, and
 * the HTTP methods it declares an operation for.
 *
 * Uppercased and de-duplicated, in {@link OPENAPI_OPERATION_METHODS} order, so
 * the generated validator config is stable across two uploads of the same
 * document with its keys in a different order.
 */
export interface SpecPath {
  /** The path template as written, e.g. `/invoices/{id}`. */
  path: string;
  /** Uppercase HTTP methods declared on it, e.g. `['GET', 'POST']`. */
  methods: string[];
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
  /**
   * Every declared path item with the methods it carries, in document order.
   *
   * This is what `routes` enforcement is generated from. A path item that is
   * not an object, or that declares no HTTP-method key at all, is omitted
   * rather than rejected — the parser stays as permissive as it has always
   * been, and a document made entirely of such entries simply yields nothing
   * to enforce.
   */
  paths: SpecPath[];
  /** Content type matching {@link ParsedSpec.raw}. */
  contentType: 'application/json' | 'application/yaml';
  /** The document as uploaded, with only surrounding whitespace trimmed. */
  raw: string;
  /**
   * The parsed document itself — the object {@link ParsedSpec.raw} decoded to,
   * whether it arrived as JSON or as YAML.
   *
   * `routes` enforcement submits the document *back* to Edge's spec importer
   * with a rewritten `servers` and the Ferrum extensions stamped on, and doing
   * that from the object rather than from the text is what lets a YAML upload
   * be submitted as JSON without a second parser. Nothing else reads it; the
   * catalog and every diff still work from {@link ParsedSpec.raw}, which is the
   * provider's own bytes.
   */
  document: Record<string, unknown>;
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

  // `URL.hostname` keeps IPv6 literals in brackets; Edge wants the bare form.
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();

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

/** One address a hostname currently resolves to. */
export interface ResolvedAddress {
  /** The address in its textual form, e.g. `10.0.0.5` or `2606:4700::1111`. */
  address: string;
  /** `4` for an A record, `6` for an AAAA record. */
  family: 4 | 6;
}

/**
 * Resolve a DNS name to every address it currently answers with.
 *
 * Injected into {@link UpstreamPolicy} rather than called directly so the
 * publishing tests never touch real DNS, and so a deployment that needs a
 * different resolver (a pinned server, a shorter timeout) can supply one.
 *
 * A rejection means "the answer is unknown", which the policy treats as a
 * refusal — never as "no private address was found".
 */
export type UpstreamResolver = (host: string) => Promise<ResolvedAddress[]>;

/** How long one upstream lookup may take before it is failed closed. */
export const UPSTREAM_DNS_TIMEOUT_MS = 5_000;

/** Attempts per query before the resolver gives up. */
export const UPSTREAM_DNS_TRIES = 2;

/** Resolver codes that mean "this family has no record", not "the lookup failed". */
const EMPTY_FAMILY_CODES = new Set(['ENODATA', 'ENOTFOUND']);

function isEmptyFamilyError(reason: unknown): boolean {
  const code = (reason as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && EMPTY_FAMILY_CODES.has(code);
}

/**
 * The real resolver: A and AAAA over `dns.promises.Resolver`, bounded.
 *
 * Both families are queried because the policy has to see the *whole* answer
 * set — a name with a public A record and a loopback AAAA record is still a way
 * into the gateway's network. `ENODATA`/`ENOTFOUND` from one family is normal
 * (most names are v4-only) and is tolerated as long as the other family
 * answered; any other failure — `SERVFAIL`, a timeout, a refused query — is
 * rethrown, because a partial view of the answer set cannot show the
 * destination to be public.
 *
 * `Resolver` talks to the configured nameservers directly, so `/etc/hosts` is
 * not consulted: a name mapped only in the hosts file reads as unresolvable and
 * is refused. That is the intended reading — Edge resolves the name from *its*
 * network, not from the portal's hosts file.
 */
export function createUpstreamResolver(
  options: { timeoutMs?: number; tries?: number } = {},
): UpstreamResolver {
  const timeout = options.timeoutMs ?? UPSTREAM_DNS_TIMEOUT_MS;
  const tries = options.tries ?? UPSTREAM_DNS_TRIES;
  return async function resolveUpstreamHost(host: string): Promise<ResolvedAddress[]> {
    const resolver = new Resolver({ timeout, tries });
    const [v4, v6] = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]);
    const addresses: ResolvedAddress[] = [];
    for (const [family, settled] of [
      [4, v4],
      [6, v6],
    ] as const) {
      if (settled.status === 'rejected') {
        if (isEmptyFamilyError(settled.reason)) continue;
        throw settled.reason;
      }
      for (const address of settled.value) addresses.push({ address, family });
    }
    return addresses;
  };
}

/** How the publishing service decides which upstream destinations are acceptable. */
export interface UpstreamPolicy {
  /**
   * `NEXUS_ALLOW_PRIVATE_UPSTREAMS`. When `false` (the default) a proxy may only
   * be pointed at a public destination; loopback, link-local, RFC 1918,
   * carrier-grade NAT, IPv4-mapped IPv6, multicast and the `.local`/`.internal`/
   * `.localhost`/`.home.arpa` name suffixes are refused.
   */
  allowPrivate: boolean;
  /**
   * Resolves a DNS name to its A/AAAA answers.
   *
   * {@link createUpstreamResolver} builds the production one; the server wires
   * it in {@link "../index.js"} and the tests inject a fake.
   */
  resolve: UpstreamResolver;
}

/** `SPEC_INVALID` for a destination the deployment does not allow. */
function privateUpstreamError(host: string, resolved?: string[]): NexusError {
  const via =
    resolved === undefined ? '' : ` (it resolves to ${resolved.join(', ')}, which is not public)`;
  return specInvalid(
    `The upstream host '${host}' is a loopback, private, link-local or internal destination${via}; ` +
      'this portal only publishes APIs with public upstreams (set NEXUS_ALLOW_PRIVATE_UPSTREAMS=true to change that)',
    {
      field: 'upstream_url',
      host,
      reason: 'private_upstream',
      ...(resolved === undefined ? {} : { resolved }),
    },
  );
}

/** `SPEC_INVALID` for a name whose addresses could not be established. */
function unresolvableUpstreamError(host: string): NexusError {
  return specInvalid(
    `The upstream host '${host}' could not be resolved, so it cannot be shown to point at a ` +
      'public destination; this portal only publishes APIs with public upstreams ' +
      '(set NEXUS_ALLOW_PRIVATE_UPSTREAMS=true to change that)',
    { field: 'upstream_url', host, reason: 'unresolvable_upstream' },
  );
}

/**
 * Refuse an upstream the deployment's policy does not allow.
 *
 * A provider account is only semi-trusted, and a proxy is an egress path from
 * the gateway's network: without this check any provider could publish an API
 * whose backend is the cloud metadata service, a database on the gateway's
 * subnet, or the Admin API itself.
 *
 * Three lines, in order of cost:
 *
 * 1. the `.local`/`.internal`/`.localhost`/`.home.arpa` **name suffixes**;
 * 2. the host as an **IP literal**, which is already the destination;
 * 3. otherwise the name is **resolved**, and *every* address it answers with
 *    must be public. A name on no denylist still reaches loopback when its A
 *    record says so (`127.0.0.1.nip.io`), which is exactly the bypass this
 *    step closes. A mixed public/private answer set is refused whole.
 *
 * The lookup fails **closed**: an empty answer set, a `SERVFAIL`, or a timeout
 * all refuse the publish, because none of them shows the destination to be
 * public.
 *
 * What this cannot see is a name re-pointed *after* the check — Nexus validates
 * once, at write time, and the gateway resolves the name again on every
 * request. Edge's own `FERRUM_BACKEND_ALLOW_IPS=public` egress mode is the
 * layer that screens the address actually connected to; see
 * [`docs/security.md`](../../../docs/security.md).
 *
 * Deployments that legitimately front internal services opt out with
 * `NEXUS_ALLOW_PRIVATE_UPSTREAMS=true`, which short-circuits before any lookup.
 *
 * @throws NexusError `SPEC_INVALID` naming the host and the setting to change.
 */
export async function assertUpstreamAllowed(
  upstream: SpecUpstream,
  policy: UpstreamPolicy,
): Promise<void> {
  // Opting in short-circuits before the network: the answer cannot change the
  // outcome, and the documented local-development upstream
  // (`host.docker.internal`) does not resolve from most hosts at all.
  if (policy.allowPrivate) return;

  if (!isPublicUpstreamHost(upstream.host)) throw privateUpstreamError(upstream.host);

  // An IP literal *is* the destination; the check above already decided it.
  if (isIP(upstream.host) !== 0) return;

  let resolved: ResolvedAddress[];
  try {
    resolved = await policy.resolve(upstream.host);
  } catch {
    throw unresolvableUpstreamError(upstream.host);
  }
  if (resolved.length === 0) throw unresolvableUpstreamError(upstream.host);
  if (!resolved.every(isPublicResolvedAddress)) {
    throw privateUpstreamError(
      upstream.host,
      resolved.map((entry) => entry.address),
    );
  }
}

/**
 * Whether one resolved address is a public destination.
 *
 * An IPv4-mapped answer (`::ffff:10.0.0.1`) is judged as the IPv4 address it
 * carries. Reading it as "some address in `::/8`" would refuse every mapped
 * public address, and a naive `fc00::`-style check would accept every mapped
 * private one; the mapping is unwrapped instead so the RFC 1918 rules apply to
 * what the packet actually reaches. An answer that is not an IP address at all
 * is refused rather than ignored.
 */
export function isPublicResolvedAddress(entry: ResolvedAddress): boolean {
  const version = isIP(entry.address);
  if (version === 0) return false;
  if (version === 4) return isPublicIpv4(entry.address);
  const mapped = ipv4FromMapped(entry.address);
  return mapped === null ? isPublicIpv6(entry.address) : isPublicIpv4(mapped);
}

/** The IPv4 address inside an IPv4-mapped IPv6 address, in either spelling. */
function ipv4FromMapped(address: string): string | null {
  const normalized = address.toLowerCase();
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(normalized);
  if (dotted) return dotted[1] ?? null;
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalized);
  if (!hex) return null;
  const high = Number.parseInt(hex[1] as string, 16);
  const low = Number.parseInt(hex[2] as string, 16);
  return [high >>> 8, high & 0xff, low >>> 8, low & 0xff].join('.');
}

/**
 * Whether `host` (a lower-cased hostname or bare IP literal) is a public
 * destination. Exported for the policy check above and for tests; the parser
 * itself never consults it.
 */
export function isPublicUpstreamHost(host: string): boolean {
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
    // Walked only after both limits have been cleared, so a document built to
    // be expensive to enumerate is rejected before it is enumerated.
    paths: readPaths(paths),
    contentType,
    raw,
    document: value,
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

/**
 * Every path item that declares at least one operation, with its methods.
 *
 * A second walk over `paths` rather than a by-product of {@link countOperations},
 * deliberately: that function's exact counting rule (a method *key* present,
 * whatever its value) is what the `MAX_SPEC_OPERATIONS` limit has always meant,
 * and reusing one traversal for both would tie the two together. The two agree
 * on which keys count, and this one is only reached once the limits pass.
 *
 * Path items that are not objects, and objects declaring no method key, are
 * skipped: they contribute no operation to enforce, and rejecting them would
 * make the portal stricter than the gateway it fronts.
 */
function readPaths(paths: Record<string, unknown>): SpecPath[] {
  const declared: SpecPath[] = [];
  for (const [path, item] of Object.entries(paths)) {
    if (!isRecord(item)) continue;
    const methods = OPENAPI_OPERATION_METHODS.filter((method) => item[method] !== undefined).map(
      (method) => method.toUpperCase(),
    );
    if (methods.length > 0) declared.push({ path, methods });
  }
  return declared;
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

/**
 * Normalized textual form of an upstream: `scheme://host:port[/basePath]`.
 *
 * This is what Nexus records on the `apis` row as "where the proxy is pointed",
 * so it has to be canonical rather than whatever the provider typed: the port
 * is always explicit (the scheme default when none was given), the host was
 * lowercased by {@link parseUpstreamUrl}, and a trailing slash is not a base
 * path. An IPv6 host is re-bracketed here because the parser keeps it bare for
 * Edge's `backend_host`, and `https://::1:8080` would otherwise be
 * unparseable.
 */
export function formatUpstreamUrl(upstream: SpecUpstream): string {
  const host = upstream.host.includes(':') ? `[${upstream.host}]` : upstream.host;
  return `${upstream.scheme}://${host}:${upstream.port}${upstream.basePath ?? ''}`;
}
