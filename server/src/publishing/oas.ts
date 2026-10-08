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
 * - the document parses as JSON or YAML and is a JSON object. YAML is read
 *   with the YAML 1.2 core schema whatever `%YAML` directive it carries — no
 *   merge keys, no `!!omap`/`!!set`/`!!binary`/`!!timestamp` types — and every
 *   mapping key must be a scalar, so the parse yields only plain objects,
 *   arrays and scalars, which is all an OpenAPI document is;
 * - its keys and scalars, plus the indentation needed to serialize each
 *   occurrence, add up to no more than {@link MAX_SPEC_EXPANDED_BYTES} once
 *   YAML aliases are resolved. `MAX_SPEC_BYTES` bounds the upload, but an alias
 *   repeats its anchor at every use and serialization writes each copy out in
 *   full;
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
 * - the document costs no more than {@link MAX_SPEC_RENDER_UNITS} to *render*.
 *   Paths and operations are the wrong unit for that: the documentation viewer
 *   walks one row per schema node, per parameter and per media type and one
 *   card per response, and a single declared operation can carry any number of
 *   all four. A document is provider-authored and is read back by every
 *   signed-in viewer of the catalog entry, so this counts what the viewer walks
 *   and refuses past the ceiling.
 *
 * Everything else (schema correctness, `$ref` resolution, operation shape) is
 * left alone: an over-strict portal would reject specs the gateway is perfectly
 * happy to sit in front of.
 *
 * The first usable `servers[].url` is read as the **default upstream** after
 * substituting server variable defaults, but only when it is an
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
import { isIP, type LookupFunction } from 'node:net';

import {
  isAlias,
  isScalar,
  parseDocument as parseYamlDocument,
  stringify as stringifyYaml,
  visit,
  type Node as YamlNode,
} from 'yaml';

import {
  MAX_OPENAPI_ENUM_CHIPS,
  MAX_OPENAPI_PARAMETER_IN_LENGTH,
  MAX_OPENAPI_PARAMETER_NAME_LENGTH,
  MAX_OPENAPI_REF_LENGTH,
  MAX_SPEC_BYTES,
  MAX_SPEC_DEPTH,
  MAX_SPEC_EXPANDED_BYTES,
  MAX_SPEC_OPERATIONS,
  MAX_SPEC_PATHS,
  MAX_SPEC_RENDER_UNITS,
  MAX_UPSTREAM_URL_LENGTH,
  OPENAPI_OPERATION_METHODS,
  createOpenApiRefResolver,
  expandServerUrl,
  firstUsableSpecServerUrl,
  parseAbsoluteHttpUrl,
  resolveOpenApiPointer,
} from '@ferrum-nexus/shared';

export { slugify } from '@ferrum-nexus/shared';

import { isNexusError, specInvalid, type NexusError } from '../lib/errors.js';

/** Upstream a proxy should forward to, decomposed into Edge's proxy fields. */
export interface SpecUpstream {
  /** The absolute URL after template expansion (or as explicitly supplied). */
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
  /** First usable expanded `servers[].url` when absolute http(s), else `null`. */
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
  const url = parseAbsoluteHttpUrl(trimmed);
  if (!url) return null;

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
   * Every origin that may be the gateway's own proxy listener: the stored
   * `gateway.public_url` override, `FERRUM_GATEWAY_PUBLIC_URL`, and the Admin
   * API host — unioned, so none of them replaces another. An upstream that
   * names or resolves to any of them is refused.
   *
   * The Admin API host is included because the gateway often shares a host
   * between its control and data planes; when no public URL is configured it is
   * the only origin Nexus knows. A gateway origin that cannot be resolved fails
   * the publish closed rather than silently skipping the check.
   */
  getGatewayPublicUrls?: () => Promise<string[]>;
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

/** Refuse a backend that would route a proxy back into the same public gateway. */
function gatewayLoopError(host: string): NexusError {
  return specInvalid(
    `The upstream host '${host}' resolves to the gateway's public origin and would loop requests`,
    { field: 'upstream_url', host, reason: 'gateway_origin' },
  );
}

/**
 * `SPEC_INVALID` when a gateway origin cannot be resolved to compare against.
 *
 * The check fails closed: an unknown gateway answer cannot show the upstream to
 * be distinct from the gateway, so the publish is refused rather than allowed.
 */
function gatewayUnresolvableError(host: string): NexusError {
  return specInvalid(
    `The gateway's own host '${host}' could not be resolved, so the upstream cannot be shown ` +
      'to avoid looping back to the gateway; publishing is refused until the gateway resolves ' +
      '(check FERRUM_ADMIN_URL, FERRUM_GATEWAY_PUBLIC_URL and DNS)',
    { field: 'upstream_url', host, reason: 'gateway_unresolvable' },
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
 * `NEXUS_ALLOW_PRIVATE_UPSTREAMS=true`, which skips the destination privacy
 * checks — but never the gateway-origin loop guard above.
 *
 * @throws NexusError `SPEC_INVALID` naming the host and the setting to change.
 */
export async function assertUpstreamAllowed(
  upstream: SpecUpstream,
  policy: UpstreamPolicy,
): Promise<void> {
  const gatewayOrigins = (await policy.getGatewayPublicUrls?.()) ?? [];
  if (gatewayOrigins.length > 0) {
    const upstreamAddresses = await addressesForHost(upstream.host, policy, false);
    const upstreamHost = canonicalHost(upstream.host);
    for (const origin of gatewayOrigins) {
      let gatewayHost: string;
      try {
        gatewayHost = new URL(origin).hostname.replace(/^\[|\]$/g, '');
      } catch {
        // A malformed stored origin is rejected on write; skip it rather than
        // fail every publish over a value this guard cannot read.
        continue;
      }
      // Canonicalize both sides so an IPv4-mapped, NAT64 or 6to4 literal that
      // embeds the gateway's IPv4 address — or an AAAA answer that does — is
      // caught even though it is textually different.
      if (canonicalHost(gatewayHost) === upstreamHost) throw gatewayLoopError(upstream.host);

      const gatewayAddresses = await addressesForHost(gatewayHost, policy, true);
      if (gatewayAddresses.some((address) => upstreamAddresses.includes(address))) {
        throw gatewayLoopError(upstream.host);
      }
    }
  }

  // Destination privacy is opted out of here. The gateway-origin loop guard
  // above always ran, so a backend that names or resolves to the gateway is
  // still refused even in this mode.
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

/** Resolve host names to comparable addresses without changing the egress policy. */
async function addressesForHost(
  host: string,
  policy: UpstreamPolicy,
  required: boolean,
): Promise<string[]> {
  const normalized = normalizeHost(host).replace(/^\[|\]$/g, '');
  if (isIP(normalized) !== 0) return [canonicalAddress(normalized)];
  let resolved: ResolvedAddress[];
  try {
    resolved = await policy.resolve(normalized);
  } catch {
    if (required) throw gatewayUnresolvableError(host);
    return [];
  }
  if (required && resolved.length === 0) throw gatewayUnresolvableError(host);
  return resolved.map((entry) => canonicalAddress(entry.address));
}

/**
 * The comparable form of a host: a canonical address when it is an IP literal,
 * otherwise the normalized name. Two spellings that name one destination —
 * `API.INTERNAL.` and `api.internal`, or `93.184.216.34` and its IPv4-mapped
 * `::ffff:5db8:d822` — produce the same value.
 */
function canonicalHost(host: string): string {
  const bare = host.replace(/^\[|\]$/g, '');
  return isIP(bare) === 0 ? normalizeHost(bare) : canonicalAddress(bare);
}

/**
 * The comparable spelling of an IP literal.
 *
 * An IPv6 address that carries the IPv4 address the packet is really delivered
 * to — IPv4-mapped (`::ffff:93.184.216.34`), NAT64 (`64:ff9b::5db8:d822`) or
 * 6to4 (`2002:5db8:d822::`) — reads as that IPv4 address, so it compares equal
 * to the bare literal. Any other IPv6 address is expanded to its eight groups,
 * so the several textual forms of one address compare equal.
 */
function canonicalAddress(address: string): string {
  const bare = address.replace(/^\[|\]$/g, '').toLowerCase();
  const version = isIP(bare);
  if (version === 4) return bare;
  if (version !== 6) return bare;
  const hextets = ipv6Hextets(bare);
  if (hextets === null) return bare;
  return embeddedIpv4(hextets) ?? hextets.map((group) => group.toString(16)).join(':');
}

/**
 * Whether one resolved address is a public destination.
 *
 * An IPv6 answer that carries an IPv4 address the packet is really delivered
 * to — IPv4-mapped (`::ffff:10.0.0.1`), NAT64 (`64:ff9b::a00:1`) or 6to4
 * (`2002:a00:1::1`) — is judged as that IPv4 address; see
 * {@link isPublicIpv6}. An answer that is not an IP address at all is refused
 * rather than ignored.
 */
export function isPublicResolvedAddress(entry: ResolvedAddress): boolean {
  const version = isIP(entry.address);
  if (version === 0) return false;
  return version === 4 ? isPublicIpv4(entry.address) : isPublicIpv6(entry.address);
}

/**
 * The canonical spelling of a host for the name-suffix rules.
 *
 * DNS treats letter case and a single trailing root label as equivalent, so
 * `API.INTERNAL.` and `api.internal` name the same destination. Every
 * name-suffix rule reads this form, so a fully-qualified `api.internal.` cannot
 * slip past the rule that refuses `api.internal`.
 */
function normalizeHost(host: string): string {
  return host.replace(/\.$/, '').toLowerCase();
}

/**
 * Whether `host` (a hostname or bare IP literal, in any letter case and with or
 * without a trailing root label) is a public destination. Exported for the
 * policy check above and for tests; the parser itself never consults it.
 */
export function isPublicUpstreamHost(host: string): boolean {
  const name = normalizeHost(host);
  if (
    name === 'localhost' ||
    name.endsWith('.localhost') ||
    name.endsWith('.local') ||
    name.endsWith('.internal') ||
    name.endsWith('.home.arpa')
  ) {
    return false;
  }

  const version = isIP(name);
  if (version === 4) return isPublicIpv4(name);
  if (version === 6) return isPublicIpv6(name);
  return true;
}

/** Why {@link resolvePublicDestination} refused a host. */
export type DestinationRefusal = 'not_public' | 'unresolvable' | 'resolves_non_public';

const DESTINATION_REFUSAL_MESSAGES: Record<DestinationRefusal, string> = {
  not_public: 'host is not a public address',
  unresolvable: 'host could not be resolved',
  resolves_non_public: 'host resolves to a non-public address',
};

/**
 * A destination the public-address policy refused. It is also what a
 * {@link createVettedLookup} lookup hands the socket, so `code` follows the
 * `dns.lookup` convention: `ENOTFOUND` when the answer is unknown, and
 * `ERR_NON_PUBLIC_DESTINATION` when it is known and not public. The message
 * never names an address.
 */
export class DestinationRefusedError extends Error {
  readonly code: string;
  readonly reason: DestinationRefusal;
  readonly host: string;

  constructor(host: string, reason: DestinationRefusal, options?: { cause?: unknown }) {
    super(DESTINATION_REFUSAL_MESSAGES[reason], options as ErrorOptions | undefined);
    this.name = 'DestinationRefusedError';
    this.code = reason === 'unresolvable' ? 'ENOTFOUND' : 'ERR_NON_PUBLIC_DESTINATION';
    this.reason = reason;
    this.host = host;
  }
}

/**
 * Resolve `host` (a hostname or bare IP literal) and return its
 * addresses, but only when every one of them is public — the same rules as
 * {@link assertUpstreamAllowed}, without its opt-out.
 *
 * An IP literal is its own answer. A name is resolved through `resolve`, and a
 * mixed public/private answer set is refused whole; an empty answer or a
 * failed lookup is refused too, because neither shows the destination to be
 * public.
 *
 * @throws DestinationRefusedError naming why.
 */
export async function resolvePublicDestination(
  host: string,
  resolve: UpstreamResolver,
): Promise<ResolvedAddress[]> {
  // `idp.internal.` is `idp.internal`: the root label must not slip a name
  // past the suffix list.
  if (!isPublicUpstreamHost(host)) {
    throw new DestinationRefusedError(host, 'not_public');
  }
  const version = isIP(host);
  if (version !== 0) return [{ address: host, family: version === 6 ? 6 : 4 }];
  let answers: ResolvedAddress[];
  try {
    answers = await resolve(host);
  } catch (cause) {
    throw new DestinationRefusedError(host, 'unresolvable', { cause });
  }
  if (answers.length === 0) throw new DestinationRefusedError(host, 'unresolvable');
  if (!answers.every(isPublicResolvedAddress)) {
    throw new DestinationRefusedError(host, 'resolves_non_public');
  }
  return answers;
}

/** The address family a `dns.lookup` caller asked for; `0` for either. */
function requestedFamily(family: number | 'IPv4' | 'IPv6' | undefined): 0 | 4 | 6 {
  if (family === 4 || family === 'IPv4') return 4;
  if (family === 6 || family === 'IPv6') return 6;
  return 0;
}

/**
 * A `lookup` for `net.connect`/`tls.connect` (an undici `Agent`'s `connect`
 * option) that hands the socket only the addresses `vet` returns.
 *
 * A policy check that resolves a name and then lets the connection resolve it
 * again checks one answer and connects to another: a name whose DNS changes
 * in between (DNS rebinding) passes the check and reaches a private address.
 * With this lookup the address the socket dials *is* the vetted one, while
 * the hostname still drives `Host`, SNI and certificate verification. A
 * refusal from `vet` fails the connection before any packet is sent.
 *
 * `vet` receives the lower-cased hostname; {@link resolvePublicDestination}
 * is the usual one. The caller's `family` and `all` options are honoured.
 */
export function createVettedLookup(
  vet: (host: string) => Promise<ResolvedAddress[]>,
): LookupFunction {
  return function vettedLookup(hostname, options, callback): void {
    const family = requestedFamily(options.family);
    void vet(hostname.toLowerCase()).then(
      (vetted) => {
        const usable = family === 0 ? vetted : vetted.filter((entry) => entry.family === family);
        const first = usable[0];
        if (first === undefined) {
          callback(new DestinationRefusedError(hostname, 'unresolvable'), '');
        } else if (options.all === true) {
          callback(null, usable);
        } else {
          callback(null, first.address, first.family);
        }
      },
      (error: unknown) => {
        const refused =
          error instanceof Error
            ? error
            : new DestinationRefusedError(hostname, 'unresolvable', { cause: error });
        callback(refused, '');
      },
    );
  };
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

/**
 * Whether an IPv6 address is a public destination.
 *
 * Three prefixes are transports for IPv4 rather than IPv6 destinations of
 * their own, and a check that only read the leading hextet would get them
 * wrong in both directions — refusing every mapped public address, and
 * accepting a NAT64 or 6to4 address that a translator or relay delivers to
 * RFC 1918 space (issue #344). Each is unwrapped and the IPv4 address it
 * carries is judged by the IPv4 rules instead:
 *
 * - `::ffff:0:0/96`, IPv4-mapped (RFC 4291 §2.5.5.2);
 * - `64:ff9b::/96`, the NAT64 well-known prefix (RFC 6052), which on a
 *   DNS64/NAT64 network is what an AAAA-only name resolves to;
 * - `2002::/16`, 6to4 (RFC 3056), whose relay forwards to the IPv4 address in
 *   the second and third hextets.
 *
 * Everything else in `::/16` — unspecified, loopback, the deprecated
 * IPv4-compatible `::a.b.c.d` (RFC 4291 §2.5.5.1) and SIIT's `::ffff:0:0:0/96` —
 * is refused outright, whatever IPv4 address it spells: none of them is a
 * destination a public API is published at. So is the rest of `64:ff9b::/32`,
 * including the local-use NAT64 prefix `64:ff9b:1::/48` (RFC 8215), whose
 * embedding position the operator chooses and which is private by definition.
 */
function isPublicIpv6(host: string): boolean {
  const hextets = ipv6Hextets(host);
  if (hextets === null) return false;

  const embedded = embeddedIpv4(hextets);
  if (embedded !== null) return isPublicIpv4(embedded);

  const first = hextets[0] ?? 0;
  const second = hextets[1] ?? 0;
  return !(
    first === 0 || // unspecified, loopback, IPv4-compatible and the rest of ::/16
    (first === 0x64 && second === 0xff9b) || // NAT64 outside the well-known /96
    (first >= 0xfc00 && first <= 0xfdff) || // unique-local fc00::/7
    (first >= 0xfe80 && first <= 0xfeff) || // link-local fe80::/10, site-local fec0::/10
    first >= 0xff00 // multicast ff00::/8
  );
}

/**
 * The IPv4 address an IPv4-mapped, NAT64 well-known-prefix or 6to4 address
 * delivers to, or `null` for any other IPv6 address.
 */
function embeddedIpv4(hextets: readonly number[]): string | null {
  const at = (index: number): number => hextets[index] ?? 0;
  if (allZero(hextets, 0, 5) && at(5) === 0xffff) return dottedQuad(at(6), at(7));
  if (at(0) === 0x64 && at(1) === 0xff9b && allZero(hextets, 2, 6)) {
    return dottedQuad(at(6), at(7));
  }
  if (at(0) === 0x2002) return dottedQuad(at(1), at(2));
  return null;
}

/** Whether the hextets in `[from, to)` are all zero. */
function allZero(hextets: readonly number[], from: number, to: number): boolean {
  return hextets.slice(from, to).every((group) => group === 0);
}

/** The IPv4 address spelled by two hextets, high one first. */
function dottedQuad(high: number, low: number): string {
  return [high >>> 8, high & 0xff, low >>> 8, low & 0xff].join('.');
}

/**
 * The eight 16-bit groups of an IPv6 address in any textual form — compressed
 * (`::`), with a trailing dotted-quad IPv4 part, or with a zone index, which is
 * dropped — or `null` when `address` is not one.
 */
function ipv6Hextets(address: string): number[] | null {
  let text = address.toLowerCase();
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);

  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (isIP(tail) !== 4) return null;
    const [a, b, c, d] = tail.split('.').map(Number) as [number, number, number, number];
    const high = ((a << 8) | b).toString(16);
    const low = ((c << 8) | d).toString(16);
    text = `${text.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = parseHextets(halves[0] ?? '');
  const rest = halves.length === 2 ? parseHextets(halves[1] ?? '') : [];
  if (head === null || rest === null) return null;

  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - rest.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...rest];
}

/** Colon-separated hex groups, or `null` if any group is not one. */
function parseHextets(part: string): number[] | null {
  if (part === '') return [];
  const groups = part.split(':');
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.map((group) => Number.parseInt(group, 16));
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
    return { value: parseYamlSpec(text), contentType: 'application/yaml' };
  } catch (cause) {
    if (isNexusError(cause)) throw cause;
    throw specInvalid('The document is not valid YAML or JSON', {
      reason: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

/**
 * How every OpenAPI document is read as YAML.
 *
 * Explicit options win over a `%YAML 1.1` directive, which would otherwise
 * switch the document to the YAML 1.1 schema: merge keys (`<<: *a`) copy an
 * anchor's entries without counting against the alias limit, and `!!omap`,
 * `!!set`, `!!binary` and `!!timestamp` decode to a `Map`, `Set`,
 * `Uint8Array` or `Date` whose contents a walk over plain objects cannot see.
 * `resolveKnownTags: false` keeps those tags from resolving under the core
 * schema too, where they are otherwise honoured when written explicitly. An
 * unknown tag is only a warning, and its node is read as the plain mapping,
 * sequence or string it is written as.
 */
const YAML_SPEC_OPTIONS = { schema: 'core', merge: false, resolveKnownTags: false } as const;

/** The alias limit yaml applies when converting a document, pinned rather than inherited. */
const YAML_MAX_ALIAS_COUNT = 100;

/**
 * Parse one YAML document into plain data.
 *
 * Parsed in two steps so every mapping key can be checked before anything is
 * converted: a key that is a mapping or a sequence becomes a JavaScript
 * property name only by being stringified, which the parser does once per
 * occurrence and at a cost that grows with the document's anchors. OpenAPI
 * keys are strings, so refusing anything but a scalar key loses no valid
 * document.
 *
 * @throws NexusError `SPEC_INVALID` with `reason: 'non_scalar_key'`; any other
 * throw is a parse failure the caller reports
 */
function parseYamlSpec(text: string): unknown {
  const doc = parseYamlDocument(text, YAML_SPEC_OPTIONS);
  if (doc.errors.length > 0) throw doc.errors[0];

  // An alias names the latest anchor of that name before it, and the visit is
  // in document order, so an anchor is always recorded before an alias of it.
  const anchors = new Map<string, YamlNode>();
  visit(doc, {
    Node(_key, node) {
      if (!isAlias(node) && node.anchor) anchors.set(node.anchor, node);
    },
    Pair(_key, pair) {
      const key = isAlias(pair.key) ? anchors.get(pair.key.source) : pair.key;
      if (!isScalar(key)) {
        throw specInvalid('Every mapping key in the OpenAPI document must be a string', {
          reason: 'non_scalar_key',
        });
      }
    },
  });

  return doc.toJS({ maxAliasCount: YAML_MAX_ALIAS_COUNT }) as unknown;
}

/** `SPEC_INVALID` for resolved text past {@link MAX_SPEC_EXPANDED_BYTES}. */
function expandedTooLarge(): NexusError {
  return specInvalid(
    `The document is larger than the ${Math.floor(MAX_SPEC_EXPANDED_BYTES / 1024)} KiB limit ` +
      'once expanded for serving',
    { reason: 'expanded_too_large', limit: MAX_SPEC_EXPANDED_BYTES },
  );
}

/** An array, or an object whose prototype is `Object.prototype` or `null`. */
function isPlainContainer(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  if (Array.isArray(value)) return prototype === Array.prototype;
  return prototype === Object.prototype || prototype === null;
}

/** UTF-8 bytes one scalar contributes to the resolved document's text. */
function scalarBytes(value: unknown): number {
  if (typeof value === 'string') return byteLength(value);
  if (value === null || value === undefined) return 0;
  return String(value).length;
}

/** A string scalar contributes one indentation item for itself and each YAML newline. */
function stringIndentItems(value: string, contentType: ParsedSpec['contentType']): number {
  let items = 1;
  if (contentType !== 'application/yaml') return items;
  for (const character of value) {
    if (character === '\n') items += 1;
  }
  return items;
}

/**
 * Bound traversal and later serialization without using the JavaScript call
 * stack: nesting past {@link MAX_SPEC_DEPTH}, a cyclic alias, and resolved text
 * plus serialization indentation past {@link MAX_SPEC_EXPANDED_BYTES}.
 *
 * The text is counted per *occurrence*: a YAML alias hands every place that
 * names it the same object or string, and every one of them is written out
 * again when the document is serialized. A subtree is still walked only once —
 * its height and its size are memoised when it completes, and a later
 * occurrence is charged from the memo. The memo stores raw text bytes, the
 * number of charged items, and their relative depths, so indentation is
 * recalculated for each occurrence without re-walking the subtree. The running
 * total is checked after every charge. JSON cannot alias, but is counted the
 * same way.
 */
function assertSpecShape(value: unknown, contentType: ParsedSpec['contentType']): void {
  if (value === null || typeof value !== 'object') return;

  interface Frame {
    value: object;
    depth: number;
    children: unknown[];
    childIndex: number;
    maxChildHeight: number;
    /** Resolved key and scalar bytes, excluding indentation. */
    bytes: number;
    /** Number of keys, scalars, and array elements charged in this subtree. */
    chargedItems: number;
    /** Sum of charged-item depths relative to this frame's depth. */
    relativeDepths: number;
  }

  interface CompletedSize {
    bytes: number;
    chargedItems: number;
    relativeDepths: number;
  }

  const active = new WeakSet<object>();
  const completedHeights = new WeakMap<object, number>();
  const completedSizes = new WeakMap<object, CompletedSize>();
  const pending: Frame[] = [];
  let total = 0;

  const charge = (frame: Frame, bytes: number, items = 1): void => {
    frame.bytes += bytes;
    frame.chargedItems += items;
    total += bytes + items * (2 * (frame.depth - 1) + 4);
    if (total > MAX_SPEC_EXPANDED_BYTES) throw expandedTooLarge();
  };

  const push = (entryValue: object, depth: number): void => {
    // Defence in depth behind the parse options: a `Map`, `Set`, `Date` or
    // typed array has no own enumerable properties, so it would be charged
    // nothing here and still be written out in full by the serializer.
    if (!isPlainContainer(entryValue)) {
      throw specInvalid('The OpenAPI document contains a value that is not JSON data', {
        reason: 'unsupported_node',
      });
    }
    if (depth > MAX_SPEC_DEPTH) {
      throw specInvalid(`The document exceeds the ${MAX_SPEC_DEPTH} level nesting limit`, {
        reason: 'nesting_too_deep',
        limit: MAX_SPEC_DEPTH,
      });
    }
    if (active.has(entryValue)) {
      throw specInvalid('The OpenAPI document contains a cyclic YAML alias', {
        reason: 'cyclic_alias',
      });
    }
    active.add(entryValue);
    const frame: Frame = {
      value: entryValue,
      depth,
      children: Object.values(entryValue),
      childIndex: 0,
      maxChildHeight: 0,
      bytes: 0,
      chargedItems: 0,
      relativeDepths: 0,
    };
    pending.push(frame);
    // Mapping keys are text; array elements are charged when visited below.
    if (!Array.isArray(entryValue)) {
      for (const key of Object.keys(entryValue)) {
        charge(frame, byteLength(key), stringIndentItems(key, contentType));
      }
    }
  };

  push(value, 1);
  while (pending.length > 0) {
    const frame = pending[pending.length - 1]!;
    if (frame.childIndex < frame.children.length) {
      const child = frame.children[frame.childIndex++];
      if (child === null || typeof child !== 'object') {
        const items = typeof child === 'string' ? stringIndentItems(child, contentType) : 1;
        charge(frame, scalarBytes(child), items);
        continue;
      }
      if (Array.isArray(frame.value)) charge(frame, 0);
      if (active.has(child)) {
        throw specInvalid('The OpenAPI document contains a cyclic YAML alias', {
          reason: 'cyclic_alias',
        });
      }
      const completedHeight = completedHeights.get(child);
      if (completedHeight !== undefined) {
        if (frame.depth + completedHeight > MAX_SPEC_DEPTH) {
          throw specInvalid(`The document exceeds the ${MAX_SPEC_DEPTH} level nesting limit`, {
            reason: 'nesting_too_deep',
            limit: MAX_SPEC_DEPTH,
          });
        }
        frame.maxChildHeight = Math.max(frame.maxChildHeight, completedHeight);
        const size = completedSizes.get(child);
        if (size) {
          total += size.bytes + size.chargedItems * (2 * frame.depth + 4) + 2 * size.relativeDepths;
          if (total > MAX_SPEC_EXPANDED_BYTES) throw expandedTooLarge();
          frame.bytes += size.bytes;
          frame.chargedItems += size.chargedItems;
          frame.relativeDepths += size.relativeDepths + size.chargedItems;
        }
        continue;
      }
      push(child, frame.depth + 1);
      continue;
    }

    const height = frame.maxChildHeight + 1;
    completedHeights.set(frame.value, height);
    const size = {
      bytes: frame.bytes,
      chargedItems: frame.chargedItems,
      relativeDepths: frame.relativeDepths,
    };
    completedSizes.set(frame.value, size);
    active.delete(frame.value);
    pending.pop();
    const parent = pending[pending.length - 1];
    if (parent) {
      parent.maxChildHeight = Math.max(parent.maxChildHeight, height);
      // Already in `total`: only the parent's own subtree size grows.
      parent.bytes += frame.bytes;
      parent.chargedItems += frame.chargedItems;
      parent.relativeDepths += frame.relativeDepths + frame.chargedItems;
    }
  }
}

function* objectValues(value: object): Generator<unknown> {
  for (const key in value) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      yield (value as Record<string, unknown>)[key];
    }
  }
}

/** Refuse a `$ref` too long to follow; see {@link MAX_OPENAPI_REF_LENGTH}. */
function refTooLong(ref: string): NexusError {
  return specInvalid(
    `A $ref is ${ref.length} characters long, more than the ${MAX_OPENAPI_REF_LENGTH} a ` +
      'reference may be',
    { field: 'paths', reason: 'ref_too_long', length: ref.length, limit: MAX_OPENAPI_REF_LENGTH },
  );
}

/**
 * Refuse a parameter name too long to key; see
 * {@link MAX_OPENAPI_PARAMETER_NAME_LENGTH}.
 */
function parameterNameTooLong(name: string): NexusError {
  return specInvalid(
    `A parameter name is ${name.length} characters long, more than the ` +
      `${MAX_OPENAPI_PARAMETER_NAME_LENGTH} a parameter name may be`,
    {
      field: 'paths',
      reason: 'parameter_name_too_long',
      length: name.length,
      limit: MAX_OPENAPI_PARAMETER_NAME_LENGTH,
    },
  );
}

/**
 * Refuse a parameter `in` too long to key; see
 * {@link MAX_OPENAPI_PARAMETER_IN_LENGTH}.
 */
function parameterInTooLong(location: string): NexusError {
  return specInvalid(
    `A parameter's 'in' is ${location.length} characters long, more than the ` +
      `${MAX_OPENAPI_PARAMETER_IN_LENGTH} it may be`,
    {
      field: 'paths',
      reason: 'parameter_in_too_long',
      length: location.length,
      limit: MAX_OPENAPI_PARAMETER_IN_LENGTH,
    },
  );
}

/** Unwinds a schema walk whose cost has passed the caller's limit. */
class RenderLimitReached {}

/**
 * The render cost of one document's schemas, as {@link MAX_SPEC_RENDER_UNITS}
 * defines it.
 *
 * Every schema object is walked once: its cost is memoised by identity, so an
 * object a YAML alias repeats costs what it costs at every occurrence without
 * being walked again. A `$ref` is never expanded where it occurs. It costs its
 * own row and its target's, and its target is queued, once per document, for
 * {@link SchemaCostCounter.targets} to charge the rest of. Each distinct `$ref`
 * string is resolved once.
 */
interface SchemaCostCounter {
  /** What one occurrence of `schema` costs, or `limit + 1` once that is past `limit`. */
  occurrence(schema: unknown, limit: number): number;
  /**
   * What the queued `$ref` targets cost beyond the row their references
   * already paid for, or `limit + 1` once that is past `limit`.
   */
  targets(limit: number): number;
}

function createSchemaCostCounter(
  document: Record<string, unknown>,
  stats: RenderCostStats | undefined,
): SchemaCostCounter {
  const costs = new WeakMap<object, number>();
  const targetsByRef = new Map<string, Record<string, unknown> | null>();
  const queued = new WeakSet<object>();
  const pending: Record<string, unknown>[] = [];
  let spent = 0;
  let allowance = 0;

  const spend = (units: number): void => {
    spent += units;
    if (spent > allowance) throw new RenderLimitReached();
  };

  // The object a `$ref` renders, or `null` where the viewer shows the reference
  // as unresolved: anything but a local pointer that names an object.
  const targetOf = (ref: string): Record<string, unknown> | null => {
    if (ref.length > MAX_OPENAPI_REF_LENGTH) throw refTooLong(ref);
    const known = targetsByRef.get(ref);
    if (known !== undefined) return known;
    if (stats) stats.schemaRefLookups += 1;
    const value = ref.startsWith('#/') ? resolveOpenApiPointer(document, ref) : undefined;
    const target = isRecord(value) ? value : null;
    targetsByRef.set(ref, target);
    return target;
  };

  const walk = (schema: unknown): void => {
    if (schema === undefined) return;
    if (!isRecord(schema)) return spend(1);
    const known = costs.get(schema);
    if (known !== undefined) return spend(known);
    if (stats) stats.schemaWalks += 1;
    const start = spent;
    spend(1);

    const ref = typeof schema.$ref === 'string' ? schema.$ref : '';
    if (ref !== '') {
      const target = targetOf(ref);
      if (target) {
        spend(1);
        if (!queued.has(target)) {
          queued.add(target);
          pending.push(target);
        }
      }
    } else {
      if (Array.isArray(schema.enum)) spend(Math.min(schema.enum.length, MAX_OPENAPI_ENUM_CHIPS));
      const composition = Array.isArray(schema.oneOf)
        ? schema.oneOf
        : Array.isArray(schema.anyOf)
          ? schema.anyOf
          : Array.isArray(schema.allOf)
            ? schema.allOf
            : [];
      for (const entry of composition) {
        spend(1);
        walk(entry);
      }
      if (schema.items !== undefined) {
        spend(1);
        walk(schema.items);
      }
      if (isRecord(schema.properties)) {
        for (const property of objectValues(schema.properties)) {
          spend(1);
          walk(property);
        }
      }
    }
    costs.set(schema, spent - start);
  };

  // Iterative, so a chain of references as long as the document allows cannot
  // exhaust the stack; each target queues the ones it names.
  const drain = (): void => {
    for (let target = pending.pop(); target !== undefined; target = pending.pop()) {
      // The row its reference already paid for.
      spent -= 1;
      walk(target);
    }
  };

  const measure = (limit: number, body: () => void): number => {
    spent = 0;
    allowance = limit;
    try {
      body();
    } catch (error) {
      if (error instanceof RenderLimitReached) return limit + 1;
      throw error;
    }
    return spent;
  };

  return {
    occurrence: (schema, limit) => measure(limit, () => walk(schema)),
    targets: (limit) => measure(limit, drain),
  };
}

/**
 * What rendering one occurrence of `schema` costs under
 * {@link MAX_SPEC_RENDER_UNITS}: the occurrence itself, and each object its
 * references reach charged once.
 */
export function schemaRenderUnits(schema: unknown, document: Record<string, unknown>): number {
  const counter = createSchemaCostCounter(document, undefined);
  return counter.occurrence(schema, Infinity) + counter.targets(Infinity);
}

/** The four things the documentation viewer walks, counted separately. */
interface RenderUnits {
  schemaNodes: number;
  parameters: number;
  mediaTypes: number;
  responses: number;
}

/**
 * Work counters a caller may pass to {@link assertRenderCost}, so a test can
 * assert how much counting a document cost without timing it.
 */
export interface RenderCostStats {
  /** `content` maps of request bodies and responses enumerated. */
  contentWalks: number;
  /** Schema objects walked. */
  schemaWalks: number;
  /** Schema `$ref` strings resolved against the document. */
  schemaRefLookups: number;
}

/** What one `content` map costs to render. */
interface ContentCost {
  schemaNodes: number;
  mediaTypes: number;
}

/**
 * Refuse a document that costs more to render than {@link MAX_SPEC_RENDER_UNITS}.
 *
 * Counted over the parts the viewer renders from each declared operation — its
 * parameters, request body and responses, their media types, and the schemas
 * those hold — rather than over the document as a whole, so a component no
 * operation reaches costs nothing. What each part costs, and how that relates
 * to what the viewer spends, is the contract {@link MAX_SPEC_RENDER_UNITS}
 * describes. Every response entry costs one unit, as it costs the viewer a
 * card, whether or not it declares any `content`: an entry that cost nothing
 * could be repeated without bound, and a YAML alias repeats the whole
 * `responses` map at every operation that names it.
 *
 * A parameter, request body or response written as a `$ref` is followed the way
 * the viewer follows it — one memoised resolver for the document — and each
 * distinct object so named has its schemas and media types charged once, at its
 * first reference; every later reference to it costs only its own parameter or
 * response entry. Path-item parameters cost a row under every operation and
 * their schemas once per path item. A schema `$ref` costs two units at every
 * occurrence and its target's own cost once per document. Those repetitions are
 * what the viewer's own page budget absorbs; charging them in full here would
 * refuse documents that merely reuse their components.
 *
 * Each `content` map's cost is computed once and cached, as each schema's is,
 * so neither is enumerated twice however often it is referenced or aliased, and
 * each `$ref` string is resolved once. The running total is checked after every
 * charge, and within every schema walk: counting stops at the first unit past
 * the ceiling, and the error reports the totals reached by then. A `$ref`
 * longer than {@link MAX_OPENAPI_REF_LENGTH} is refused before it is resolved.
 *
 * Every parameter a path item or operation lists, followed through any
 * reference, must have a `name` of at most
 * {@link MAX_OPENAPI_PARAMETER_NAME_LENGTH} characters and an `in` of at most
 * {@link MAX_OPENAPI_PARAMETER_IN_LENGTH}, the two halves of its identity,
 * counted in UTF-16 code units. That is checked on
 * every list, a path item's even when it has no operation (the viewer and the
 * review comparison key those too), and once per parameter object.
 */
export function assertRenderCost(
  document: Record<string, unknown>,
  paths: Record<string, unknown>,
  stats?: RenderCostStats,
): void {
  const contentCosts = new WeakMap<object, ContentCost>();
  const chargedParameters = new WeakSet<object>();
  const chargedContent = new WeakSet<object>();
  const units: RenderUnits = { schemaNodes: 0, parameters: 0, mediaTypes: 0, responses: 0 };
  const resolver = createOpenApiRefResolver(document);
  const schemas = createSchemaCostCounter(document, stats);

  const charge = (
    schemaNodes: number,
    parameters: number,
    mediaTypes: number,
    responses = 0,
  ): void => {
    units.schemaNodes += schemaNodes;
    units.parameters += parameters;
    units.mediaTypes += mediaTypes;
    units.responses += responses;
    const total = units.schemaNodes + units.parameters + units.mediaTypes + units.responses;
    if (total <= MAX_SPEC_RENDER_UNITS) return;
    throw specInvalid(
      `The document declares ${units.schemaNodes} schema nodes, ${units.parameters} parameters, ` +
        `${units.mediaTypes} media types and ${units.responses} responses, more than the ` +
        `${MAX_SPEC_RENDER_UNITS} the documentation viewer can render`,
      {
        field: 'paths',
        reason: 'too_much_to_render',
        schema_nodes: units.schemaNodes,
        parameters: units.parameters,
        media_types: units.mediaTypes,
        responses: units.responses,
        units: total,
        limit: MAX_SPEC_RENDER_UNITS,
      },
    );
  };

  const availableUnits = (): number =>
    MAX_SPEC_RENDER_UNITS -
    units.schemaNodes -
    units.parameters -
    units.mediaTypes -
    units.responses;

  // Called after every charge that may have queued `$ref` targets, so each is
  // charged before the count moves on.
  const chargeTargets = (): void => charge(schemas.targets(availableUnits()), 0, 0);

  const chargeSchema = (schema: unknown): void => {
    charge(schemas.occurrence(schema, availableUnits()), 0, 0);
    chargeTargets();
  };

  // The object an entry names, or `null` when there is nothing further to
  // charge: an entry that cannot be followed renders as a single placeholder,
  // and a `$ref`'d object already charged costs nothing more.
  const chargeable = (value: unknown, charged: WeakSet<object>): Record<string, unknown> | null => {
    if (!isRecord(value)) return null;
    if (typeof value.$ref === 'string' && value.$ref.length > MAX_OPENAPI_REF_LENGTH) {
      throw refTooLong(value.$ref);
    }
    const resolution = resolver.resolve(value);
    if (!resolution.ok) return null;
    const target = resolution.value;
    if (target === value) return target;
    if (charged.has(target)) return null;
    charged.add(target);
    return target;
  };

  // Each parameter object's identity is read once, however many lists name it.
  const namedParameters = new WeakSet<object>();
  const assertParameterIdentities = (list: unknown): void => {
    if (!Array.isArray(list)) return;
    for (const entry of list) {
      if (!isRecord(entry)) continue;
      if (typeof entry.$ref === 'string' && entry.$ref.length > MAX_OPENAPI_REF_LENGTH) {
        throw refTooLong(entry.$ref);
      }
      const resolution = resolver.resolve(entry);
      if (!resolution.ok || namedParameters.has(resolution.value)) continue;
      namedParameters.add(resolution.value);
      const { name, in: location } = resolution.value;
      if (typeof name === 'string' && name.length > MAX_OPENAPI_PARAMETER_NAME_LENGTH) {
        throw parameterNameTooLong(name);
      }
      if (typeof location === 'string' && location.length > MAX_OPENAPI_PARAMETER_IN_LENGTH) {
        throw parameterInTooLong(location);
      }
    }
  };

  const addParameterSchemas = (list: unknown[]): void => {
    for (const entry of list) {
      const parameter = chargeable(entry, chargedParameters);
      if (parameter) chargeSchema(parameter.schema);
    }
  };

  const addParameters = (list: unknown): void => {
    if (!Array.isArray(list)) return;
    charge(0, list.length, 0);
    addParameterSchemas(list);
  };

  // Keyed on the `content` map rather than the object holding it, so a map
  // shared through a YAML alias is enumerated once too.
  const contentCost = (content: Record<string, unknown>): ContentCost => {
    const cached = contentCosts.get(content);
    if (cached) return cached;
    if (stats) stats.contentWalks += 1;
    const cost: ContentCost = { schemaNodes: 0, mediaTypes: 0 };
    for (const media of objectValues(content)) {
      cost.mediaTypes += 1;
      if (cost.schemaNodes + cost.mediaTypes > availableUnits()) {
        charge(cost.schemaNodes, 0, cost.mediaTypes);
      }
      if (isRecord(media)) {
        cost.schemaNodes += schemas.occurrence(
          media.schema,
          availableUnits() - cost.mediaTypes - cost.schemaNodes,
        );
      }
      if (cost.schemaNodes + cost.mediaTypes > availableUnits()) {
        charge(cost.schemaNodes, 0, cost.mediaTypes);
      }
    }
    contentCosts.set(content, cost);
    return cost;
  };

  const addContent = (value: unknown): void => {
    const body = chargeable(value, chargedContent);
    if (!body || !isRecord(body.content)) return;
    const cost = contentCost(body.content);
    charge(cost.schemaNodes, 0, cost.mediaTypes);
    chargeTargets();
  };

  for (const item of objectValues(paths)) {
    if (!isRecord(item)) continue;
    assertParameterIdentities(item.parameters);
    const inherited = Array.isArray(item.parameters) ? item.parameters : [];
    let inheritedSchemasCharged = false;
    for (const method of OPENAPI_OPERATION_METHODS) {
      const operation = item[method];
      if (!isRecord(operation)) continue;
      // The viewer lists path-item parameters under every operation beneath
      // them; the schemas they carry are the same objects each time.
      charge(0, inherited.length, 0);
      if (!inheritedSchemasCharged) {
        inheritedSchemasCharged = true;
        addParameterSchemas(inherited);
      }
      assertParameterIdentities(operation.parameters);
      addParameters(operation.parameters);
      addContent(operation.requestBody);
      if (!isRecord(operation.responses)) continue;
      // Charged per entry before its content, so a map of entries that declare
      // nothing still reaches the ceiling and stops the loop there.
      for (const response of objectValues(operation.responses)) {
        charge(0, 0, 0, 1);
        addContent(response);
      }
    }
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
  assertSpecShape(value, contentType);

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
  // Last of the limits, and the only one that walks the whole document: it runs
  // once the cheap counts have already refused the obvious floods.
  assertRenderCost(value, paths);

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
 * A stored document read back as data only, or `null` when it cannot be: the
 * size, syntax and shape checks every read applies (`MAX_SPEC_BYTES`, nesting,
 * resolved size, scalar keys), but none of the OpenAPI or render-cost ones.
 *
 * For a revision that no longer passes {@link parseOpenApiSpec}, stored before
 * a limit it breaks, where a caller still needs what the document says: which
 * operations it declares, or the document to put back on the gateway. What
 * these checks let through is bounded in size and depth, so a walk over it is
 * linear; a caller must not key or merge its parameters, which the render
 * checks are what bound.
 */
export function parseStoredSpecStructure(text: string): Record<string, unknown> | null {
  try {
    if (byteLength(text) > MAX_SPEC_BYTES) return null;
    const { value, contentType } = parseDocument(text.trim());
    assertSpecShape(value, contentType);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * The text the catalog serves for a parsed document: JSON pretty-printed with
 * two-space indentation, or YAML with line folding disabled and, whenever it
 * fits, no anchors or aliases.
 *
 * yaml's `stringify` otherwise writes an object the document shares once,
 * anchored, and an alias at every other place. The server-URL rewrite shares
 * one `servers` array across the root and every path item and operation that
 * declared servers, so such a rendering could carry more aliases than a YAML
 * reader with the default alias limit of 100 (this server's own parse
 * included) accepts. So YAML is written out in full first.
 *
 * Written out in full, a document can outgrow `MAX_SPEC_EXPANDED_BYTES` where
 * its aliased form does not: a long server URL repeated at thousands of places.
 * Such a document is served aliased, as every YAML document was before, rather
 * than refused, so every document accepted before is still accepted, and the
 * callers' check of the returned text against the limit still bounds what is
 * served. The aliased text is rendered first, and the full one only when
 * {@link estimateUnaliasedYamlBytes} bounds it within the limit, so a document
 * that would expand to many times the limit is never built in full.
 *
 * Shared by the catalog and by {@link parseUploadedOpenApiSpec}, so a document
 * is measured at upload by exactly the serialization it will be served as.
 */
export function renderCatalogSpec(
  document: Record<string, unknown>,
  contentType: ParsedSpec['contentType'],
): string {
  if (contentType === 'application/json') return JSON.stringify(document, null, 2);
  const aliased = stringifyYaml(document, { lineWidth: 0 });
  if (estimateUnaliasedYamlBytes(aliased) > MAX_SPEC_EXPANDED_BYTES) return aliased;
  const unaliased = stringifyYaml(document, { lineWidth: 0, aliasDuplicateObjects: false });
  return byteLength(unaliased) > MAX_SPEC_EXPANDED_BYTES ? aliased : unaliased;
}

/**
 * An upper bound on the UTF-8 size of `aliased` — YAML as yaml's `stringify`
 * writes it with line folding disabled — once every alias is written out in
 * full, computed from the aliased text alone in one walk of its parse.
 *
 * Each alias adds its anchored node's own text, itself with the aliases inside
 * it written out, plus, on every line of that copy, the indentation it may gain
 * by moving from the anchor to the alias: at most the alias's column plus two,
 * less the anchor's indentation. The copy's first line is charged that
 * indentation again, and the alias and anchor markers are never deducted (an
 * alias is longer than the line break its copy may start with), so the bound
 * only over-counts. An alias inside the node it names (a cycle), or
 * text that does not parse, is unbounded.
 *
 * Returns early once past {@link MAX_SPEC_EXPANDED_BYTES}, so a value over the
 * limit means only that: over the limit.
 */
export function estimateUnaliasedYamlBytes(aliased: string): number {
  const doc = parseYamlDocument(aliased);
  if (doc.errors.length > 0) return Number.POSITIVE_INFINITY;

  // What the aliases inside each anchored node add to it, filled in document
  // order: every alias inside a node precedes the end of the node, and every
  // alias of a node follows it.
  const added = new Map<unknown, { bytes: number; lines: number }>();
  const expanded = new Map<YamlNode, { bytes: number; lines: number; indent: number }>();
  const indentAt = (offset: number): number => {
    const lineStart = aliased.lastIndexOf('\n', offset - 1) + 1;
    let end = lineStart;
    while (aliased[end] === ' ') end += 1;
    return end - lineStart;
  };
  const expandedSize = (node: YamlNode): { bytes: number; lines: number; indent: number } => {
    let size = expanded.get(node);
    if (size === undefined) {
      const [start, , end] = node.range ?? [0, 0, aliased.length];
      const text = aliased.slice(start, end);
      const inside = added.get(node) ?? { bytes: 0, lines: 0 };
      size = {
        bytes: byteLength(text) + inside.bytes,
        lines: lineCount(text) + inside.lines,
        indent: indentAt(start),
      };
      expanded.set(node, size);
    }
    return size;
  };

  let total = byteLength(aliased);
  const anchors = new Map<string, YamlNode>();
  visit(doc, {
    Node(_key, node, path) {
      if (!isAlias(node)) {
        if (node.anchor) {
          anchors.set(node.anchor, node);
          added.set(node, { bytes: 0, lines: 0 });
        }
        return undefined;
      }
      const target = anchors.get(node.source);
      if (target === undefined || path.includes(target)) {
        total = Number.POSITIVE_INFINITY;
        return visit.BREAK;
      }
      const size = expandedSize(target);
      const aliasStart = node.range?.[0] ?? 0;
      const column = aliasStart - (aliased.lastIndexOf('\n', aliasStart - 1) + 1);
      const shift = Math.max(0, column + 2 - size.indent);
      const bytes = size.bytes + size.lines * shift + size.indent;
      total += bytes;
      for (const ancestor of path) {
        const inside = added.get(ancestor);
        if (inside !== undefined) {
          inside.bytes += bytes;
          inside.lines += size.lines;
        }
      }
      return total > MAX_SPEC_EXPANDED_BYTES ? visit.BREAK : undefined;
    },
  });
  return total;
}

/** Lines in `text`: one more than its line breaks. */
function lineCount(text: string): number {
  let lines = 1;
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) lines += 1;
  return lines;
}

/**
 * {@link parseOpenApiSpec} for a document being *uploaded* — a publish, a spec
 * revision, a rollback or a diff preview — which must also be one the catalog
 * will serve.
 *
 * The parse-time walk charges indentation before serialization, and this render
 * check remains the backstop for quoting and line breaks. The catalog refuses
 * to serve a rendering over {@link MAX_SPEC_EXPANDED_BYTES}; the catalog check
 * also refuses (fails closed for) the rare document the server-URL rewrite
 * pushes over that limit. The catalog still checks its own output for rows
 * stored before this check existed.
 *
 * @throws NexusError `SPEC_INVALID` with `reason: 'expanded_too_large'` for a
 * rendering past the limit, and everything {@link parseOpenApiSpec} throws
 */
export function parseUploadedOpenApiSpec(text: string): ParsedSpec {
  const parsed = parseOpenApiSpec(text);
  const rendered = renderCatalogSpec(parsed.document, parsed.contentType);
  if (byteLength(rendered) > MAX_SPEC_EXPANDED_BYTES) {
    throw specInvalid(
      `The document is larger than the ${Math.floor(MAX_SPEC_EXPANDED_BYTES / 1024)} KiB limit ` +
        'once formatted for the catalog',
      { reason: 'expanded_too_large', limit: MAX_SPEC_EXPANDED_BYTES },
    );
  }
  return parsed;
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

/** First usable expanded server URL, skipping relative or unresolved entries. */
function readDefaultUpstream(servers: unknown): SpecUpstream | null {
  const result = firstUsableSpecServerUrl(servers);
  if (result.oversizedField) {
    throw specInvalid(
      `${result.oversizedField} must not exceed ${MAX_UPSTREAM_URL_LENGTH} characters after expansion`,
      { field: result.oversizedField, limit: MAX_UPSTREAM_URL_LENGTH },
    );
  }
  return result.url === null ? null : parseUpstreamUrl(result.url);
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
  const servers = spec.document.servers;
  if (
    Array.isArray(servers) &&
    servers.some(
      (server) =>
        isRecord(server) && typeof server.url === 'string' && expandServerUrl(server).url === null,
    )
  ) {
    throw specInvalid(
      'OpenAPI server variables could not be expanded: provide valid string defaults or an explicit upstream_url',
      { field: 'servers', reason: 'invalid_server_variables' },
    );
  }
  throw specInvalid(
    "No upstream could be determined: supply 'upstream_url', or give the document an absolute 'servers[].url'",
    { field: 'upstream_url' },
  );
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
