/**
 * The **provider plugin palette** — the curated set of Ferrum Edge plugins an
 * API provider may switch on for their own API from the portal, described once
 * so the server, the SPA and the docs cannot drift apart.
 *
 * ## Why a descriptor catalog rather than a form per plugin
 *
 * Edge validates every plugin `config` against a **closed key set**: a typo'd
 * field is a `400`, not a silently ignored key. A hand-written form per plugin
 * would put that contract in three places (the SPA's inputs, the server's
 * validator, the body actually sent) and let them rot independently. Instead
 * each plugin is described once here as a {@link ProviderPluginDescriptor}:
 *
 * - the server builds a zod schema from {@link ProviderPluginDescriptor.fields}
 *   (`server/src/plugins/schema.ts`) and sends **only** those keys to Edge;
 * - the SPA renders the same fields generically
 *   (`web/src/components/plugins/PluginForm.tsx`);
 * - `field.key` **is** the Edge config key, so there is no mapping layer to get
 *   wrong.
 *
 * ## This is a curated subset, on purpose
 *
 * Every descriptor exposes a *slice* of its Edge schema — the knobs a provider
 * selling an API product actually turns — and leaves the rest at Edge's own
 * defaults. Sending a key the portal cannot let the provider change would only
 * freeze that default in place, which is exactly the reasoning behind the
 * `cors` plugin's two-key body in `publishing/service.ts`.
 *
 * ## What is deliberately **not** here
 *
 * - **The auth family** (`hmac_auth`, `jwks_auth`, `oauth2_introspection`,
 *   `mtls_auth`) — these change the *credential model*: Nexus would have to
 *   grow credential types, issue/rotate flows and show-once material for each.
 *   They belong with the `key_auth`/`basic_auth`/`jwt_auth` slot on the API
 *   row, not in a generic palette.
 * - **`spec_expose`** — it needs a canonical public spec endpoint and a
 *   decision about what the catalog serves; that is a routing change, not a
 *   plugin toggle.
 * - **`key_auth` / `basic_auth` / `jwt_auth` / `access_control` /
 *   `rate_limiting` / `cors` / `openapi_validator`** — already first-class
 *   fields on the API row, with their own semantics (auth is one-of, the ACL
 *   group is derived from the API id, the validator is generated from the
 *   spec). {@link isFirstClassPlugin} names them so the route can answer with a
 *   message pointing at the right field instead of a bare 404.
 * - **Operator plugins** — logging sinks, telemetry, mesh, chaos, load
 *   testing. Those are how you *run* the gateway, not how you *sell* an API.
 *
 * Adding a plugin is a descriptor plus (usually) nothing else: the storage, the
 * routes, the gateway writes and the SPA form are all generic.
 */

import type { HttpMethod } from './constants.js';
import type { IsoTimestamp } from './entities.js';

/* ── Field specs ────────────────────────────────────────────────────────── */

/** A checkbox. */
export interface BooleanFieldSpec {
  kind: 'boolean';
  key: string;
  label: string;
  help?: string;
  required?: boolean;
  default?: boolean;
}

/** A bounded whole number. */
export interface IntegerFieldSpec {
  kind: 'integer';
  key: string;
  label: string;
  help?: string;
  required?: boolean;
  min: number;
  max: number;
  default?: number;
  /** Rendered after the input, e.g. `bytes` or `seconds`. */
  unit?: string;
}

/** A single-line string, optionally constrained by a regex. */
export interface StringFieldSpec {
  kind: 'string';
  key: string;
  label: string;
  help?: string;
  required?: boolean;
  /** Anchored on the server as `^(?:…)$`; keep it anchor-free here. */
  pattern?: string;
  max_length: number;
  default?: string;
  placeholder?: string;
}

/** A closed set of string values, rendered as a select. */
export interface EnumFieldSpec {
  kind: 'enum';
  key: string;
  label: string;
  help?: string;
  required?: boolean;
  options: readonly { value: string; label: string }[];
  default?: string;
}

/**
 * A list of strings.
 *
 * With `options` the SPA renders a checkbox group (a closed multi-select, e.g.
 * `compression.algorithms`); without them, a one-per-line textarea.
 */
export interface StringListFieldSpec {
  kind: 'string_list';
  key: string;
  label: string;
  help?: string;
  required?: boolean;
  max_entries: number;
  /** Minimum number of entries once the field is sent at all. Defaults to `0`. */
  min_entries?: number;
  /** Anchored on the server as `^(?:…)$`. Ignored when `options` is set. */
  item_pattern?: string;
  item_max_length?: number;
  /** Closed set of accepted entries; renders as checkboxes. */
  options?: readonly { value: string; label: string }[];
  default?: readonly string[];
}

/**
 * A list of whole numbers — the integer sibling of {@link StringListFieldSpec},
 * needed because `response_caching.cacheable_status_codes` is an array of
 * `uint16` and Edge rejects the string spelling.
 */
export interface IntegerListFieldSpec {
  kind: 'integer_list';
  key: string;
  label: string;
  help?: string;
  required?: boolean;
  max_entries: number;
  min_entries?: number;
  /** Inclusive bounds on each entry. */
  item_min: number;
  item_max: number;
  /** Closed set of accepted entries; renders as checkboxes. */
  options?: readonly { value: number; label: string }[];
  default?: readonly number[];
}

/**
 * One configurable field of a palette plugin.
 *
 * `key` is the **exact Edge config key** — nothing translates between this and
 * the body sent to `POST /plugins/config`.
 */
export type PluginFieldSpec =
  | BooleanFieldSpec
  | IntegerFieldSpec
  | StringFieldSpec
  | EnumFieldSpec
  | StringListFieldSpec
  | IntegerListFieldSpec;

/* ── Descriptors ────────────────────────────────────────────────────────── */

/**
 * How the palette is grouped in the UI. Mirrors the families in issue #43:
 * `protection` (who and what may reach the API), `traffic` (how much and how
 * often), `contract` (what the API promises), `experience` (what the consumer
 * sees), `transform` (rewriting on the way through).
 */
export const PLUGIN_CATEGORIES = [
  'protection',
  'traffic',
  'contract',
  'experience',
  'transform',
] as const satisfies readonly string[];

/** One entry of {@link PLUGIN_CATEGORIES}. */
export type PluginCategory = (typeof PLUGIN_CATEGORIES)[number];

/** Display order and headings for {@link PLUGIN_CATEGORIES}. */
export const PLUGIN_CATEGORY_LABELS: Readonly<Record<PluginCategory, string>> = {
  protection: 'Protection',
  traffic: 'Traffic',
  contract: 'Contract',
  experience: 'Experience',
  transform: 'Transform',
};

/** One plugin a provider may switch on for their own API. */
export interface ProviderPluginDescriptor {
  /** Exact Ferrum Edge plugin name, as listed by `GET /plugins`. */
  name: string;
  category: PluginCategory;
  /** Short human name for the palette card. */
  label: string;
  /** One or two sentences of plain provider language: what turning this on does. */
  summary: string;
  fields: readonly PluginFieldSpec[];
  /** What consumers of the API will see or have to do once this is on. */
  consumer_recipe?: string;
  /**
   * Whether Edge accepts a per-instance execution `trigger` on this plugin.
   *
   * Edge refuses one on a plugin that publishes contextless
   * initial-response-header policy (`security_headers`), a fixed per-proxy body
   * ceiling (`request_size_limiting`, `response_size_limiting`) or contextless
   * response-trailer ownership (`compression`, `correlation_id`, and
   * `response_caching` while `add_cache_status_header` is at its `true`
   * default). See Edge `docs/plugin_execution_order.md` §"Phases outside the
   * trigger boundary".
   */
  supports_trigger: boolean;
}

/* ── Shared field fragments ─────────────────────────────────────────────── */

/** RFC 9110 field-name token — the grammar Edge accepts for a header name. */
const HTTP_FIELD_NAME_PATTERN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";

/** RFC 9110 method token. */
const HTTP_METHOD_PATTERN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";

/** A media type without parameters, e.g. `application/json`. */
const MEDIA_TYPE_PATTERN = "[A-Za-z0-9!#$%&'*+.^_`|~-]+/[A-Za-z0-9!#$%&'*+.^_`|~-]+";

/** IPv4/IPv6 address or CIDR range. Edge does the authoritative parse. */
const IP_OR_CIDR_PATTERN = '[0-9A-Fa-f:.]+(?:/[0-9]{1,3})?';

/** Printable ASCII plus HTAB — Edge's `HeaderValue` builder rule. */
const HEADER_VALUE_PATTERN = '[\\t\\u0020-\\u007E]*';

/**
 * Header names Edge rejects for `correlation_id.header_name`.
 *
 * The gateway's list is longer (and partly deployment-specific, since it also
 * refuses the effective `FERRUM_REAL_IP_HEADER`), but these are the ones a
 * provider plausibly types. Catching them here turns a gateway `400` mid-write
 * into a field-level validation message.
 */
export const CORRELATION_ID_RESERVED_HEADERS: readonly string[] = [
  'authorization',
  'authentication-info',
  'connection',
  'content-encoding',
  'content-length',
  'cookie',
  'early-data',
  'expect',
  'forwarded',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'set-cookie',
  'te',
  'traceparent',
  'tracestate',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'via',
  'www-authenticate',
  'x-api-key',
  'api-key',
  'x-auth-token',
  'x-csrf-token',
  'x-forwarded-authorization',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-goog-api-key',
  'x-xsrf-token',
];

/* ── The palette ────────────────────────────────────────────────────────── */

/**
 * Every plugin a provider may configure from the portal, in palette order.
 *
 * Each `fields` entry was read off Ferrum Edge's `openapi.yaml` (`PluginConfig`
 * `config` discriminator → the plugin's `*Config` schema); the bounds below are
 * the gateway's own, tightened only where a portal ceiling is friendlier than a
 * `uint64`.
 */
export const PROVIDER_PLUGINS: readonly ProviderPluginDescriptor[] = [
  {
    name: 'security_headers',
    category: 'protection',
    label: 'Security headers',
    summary:
      'Adds the browser hardening headers to every response and strips the ones that advertise ' +
      'your stack. Sensible defaults are applied for anything you leave alone.',
    consumer_recipe:
      'Nothing changes in how the API is called; browser clients simply receive the hardening ' +
      'headers on every response.',
    supports_trigger: false,
    fields: [
      {
        kind: 'boolean',
        key: 'content_type_options',
        label: 'X-Content-Type-Options: nosniff',
        help: 'Stops browsers guessing a response body’s type from its content.',
        default: true,
      },
      {
        kind: 'enum',
        key: 'frame_options',
        label: 'X-Frame-Options',
        help: 'Whether other sites may embed a response in a frame.',
        options: [
          { value: 'SAMEORIGIN', label: 'SAMEORIGIN — only your own pages' },
          { value: 'DENY', label: 'DENY — nobody' },
        ],
        default: 'SAMEORIGIN',
      },
      {
        kind: 'enum',
        key: 'referrer_policy',
        label: 'Referrer-Policy',
        help: 'How much of the calling URL browsers forward to your API.',
        options: [
          { value: 'no-referrer', label: 'no-referrer' },
          { value: 'same-origin', label: 'same-origin' },
          { value: 'strict-origin', label: 'strict-origin' },
          { value: 'strict-origin-when-cross-origin', label: 'strict-origin-when-cross-origin' },
          { value: 'origin-when-cross-origin', label: 'origin-when-cross-origin' },
          { value: 'no-referrer-when-downgrade', label: 'no-referrer-when-downgrade' },
        ],
        default: 'strict-origin-when-cross-origin',
      },
      {
        kind: 'boolean',
        key: 'hsts',
        label: 'Strict-Transport-Security',
        help:
          'Opt-in. Sends max-age=31536000; includeSubDomains, which pins browsers to HTTPS for a ' +
          'year — including on every subdomain. Only turn it on when the whole domain is HTTPS.',
        default: false,
      },
      {
        kind: 'string',
        key: 'content_security_policy',
        label: 'Content-Security-Policy',
        help: 'Optional. Sent verbatim; leave empty to send no CSP at all.',
        pattern: HEADER_VALUE_PATTERN,
        max_length: 2_000,
        placeholder: "default-src 'none'; frame-ancestors 'none'",
      },
      {
        kind: 'string',
        key: 'permissions_policy',
        label: 'Permissions-Policy',
        help: 'Optional. Sent verbatim; leave empty to send no Permissions-Policy.',
        pattern: HEADER_VALUE_PATTERN,
        max_length: 2_000,
        placeholder: 'geolocation=(), camera=()',
      },
    ],
  },

  {
    name: 'request_size_limiting',
    category: 'protection',
    label: 'Request size limit',
    summary:
      'Rejects an upload larger than the ceiling you set with 413, before a single byte reaches ' +
      'your backend.',
    consumer_recipe:
      'A consumer sending a body over the limit gets 413 Payload Too Large from the gateway. ' +
      'Document the ceiling alongside any upload endpoint.',
    supports_trigger: false,
    fields: [
      {
        kind: 'integer',
        key: 'max_bytes',
        label: 'Maximum request body',
        help: 'Applies to every request on this API, including streamed and chunked uploads.',
        required: true,
        min: 1,
        max: 1_073_741_824,
        default: 1_048_576,
        unit: 'bytes',
      },
    ],
  },

  {
    name: 'response_size_limiting',
    category: 'protection',
    label: 'Response size limit',
    summary:
      'Refuses to relay a backend response larger than the ceiling you set, answering the ' +
      'consumer with 502 instead.',
    consumer_recipe:
      'A response your backend produces over the limit reaches the consumer as 502 Bad Gateway. ' +
      'Paginate anything that can grow without bound.',
    supports_trigger: false,
    fields: [
      {
        kind: 'integer',
        key: 'max_bytes',
        label: 'Maximum response body',
        required: true,
        min: 1,
        max: 1_073_741_824,
        default: 8_388_608,
        unit: 'bytes',
      },
    ],
  },

  {
    name: 'ip_restriction',
    category: 'protection',
    label: 'IP allow / deny list',
    summary:
      'Restricts who may call this API by source address — the classic partner allow-list. ' +
      'A deny match always wins over an allow match.',
    consumer_recipe:
      'Consumers must call from an address you listed; anything else is rejected before ' +
      'authentication. Tell partners to send you their egress ranges.',
    supports_trigger: true,
    fields: [
      {
        kind: 'string_list',
        key: 'allow',
        label: 'Allowed addresses',
        help:
          'IPv4/IPv6 addresses or CIDR ranges, one per line. When this list is non-empty, an ' +
          'address that is not in it is rejected.',
        max_entries: 128,
        item_pattern: IP_OR_CIDR_PATTERN,
        item_max_length: 64,
      },
      {
        kind: 'string_list',
        key: 'deny',
        label: 'Denied addresses',
        help: 'Always wins over the allow list, whatever the evaluation order.',
        max_entries: 128,
        item_pattern: IP_OR_CIDR_PATTERN,
        item_max_length: 64,
      },
      {
        kind: 'enum',
        key: 'mode',
        label: 'Evaluation order',
        options: [
          { value: 'allow_first', label: 'Allow list first' },
          { value: 'deny_first', label: 'Deny list first' },
        ],
        default: 'allow_first',
      },
    ],
  },

  {
    name: 'bot_detection',
    category: 'protection',
    label: 'Bot filter',
    summary:
      'Blocks requests whose User-Agent matches a pattern you listed. The User-Agent is ' +
      'client-controlled, so this is a coarse filter for casual scrapers, not real bot defence.',
    consumer_recipe:
      'Legitimate SDKs should send a recognisable User-Agent. Add anything you block by accident ' +
      'to the allow list — it is checked first.',
    supports_trigger: true,
    fields: [
      {
        kind: 'string_list',
        key: 'blocked_patterns',
        label: 'Blocked User-Agent substrings',
        help:
          'Case-insensitive substring matches, one per line. Leaving this empty is only valid ' +
          'when requests with no User-Agent are rejected — an allow list alone enforces nothing.',
        max_entries: 64,
        item_pattern: '\\S(?:.*\\S)?',
        item_max_length: 200,
        default: ['curl', 'wget', 'python-requests', 'scrapy', 'libwww-perl'],
      },
      {
        kind: 'string_list',
        key: 'allow_list',
        label: 'Always-allowed User-Agent tokens',
        help:
          'Checked before the blocked list and matched on word boundaries, so `GoogleBot` can ' +
          'pass while a generic `bot` pattern is blocked.',
        max_entries: 64,
        item_pattern: '\\S(?:.*\\S)?',
        item_max_length: 200,
      },
      {
        kind: 'boolean',
        key: 'allow_missing_user_agent',
        label: 'Allow requests with no User-Agent',
        help: 'Keeps health checks and load-balancer probes working. Rarely worth turning off.',
        default: true,
      },
      {
        kind: 'integer',
        key: 'custom_response_code',
        label: 'Rejection status',
        min: 400,
        max: 599,
        default: 403,
      },
    ],
  },

  {
    name: 'correlation_id',
    category: 'experience',
    label: 'Correlation ID',
    summary:
      'Gives every call a stable id, forwards it to your backend and echoes it back to the ' +
      'consumer, so a support ticket can name one exact request.',
    consumer_recipe:
      'Consumers may send their own id in the header and will see it on the response; if they ' +
      'do not, the gateway mints one. Ask them to quote it when reporting a problem.',
    supports_trigger: false,
    fields: [
      {
        kind: 'string',
        key: 'header_name',
        label: 'Header name',
        help: 'A valid HTTP header name. Protocol, tracing and credential names are rejected.',
        pattern: HTTP_FIELD_NAME_PATTERN,
        max_length: 128,
        default: 'x-request-id',
      },
      {
        kind: 'boolean',
        key: 'echo_downstream',
        label: 'Echo the id on responses',
        default: true,
      },
    ],
  },

  {
    name: 'compression',
    category: 'experience',
    label: 'Response compression',
    summary:
      'Compresses responses on the way out when the caller asks for it, which is usually a large ' +
      'win for browser and mobile clients on text payloads.',
    consumer_recipe:
      'Consumers get a compressed body when they send `Accept-Encoding`. Every mainstream HTTP ' +
      'client does this and decompresses transparently.',
    supports_trigger: false,
    fields: [
      {
        kind: 'string_list',
        key: 'algorithms',
        label: 'Algorithms',
        help: 'In server preference order.',
        max_entries: 3,
        min_entries: 1,
        options: [
          { value: 'gzip', label: 'gzip' },
          { value: 'br', label: 'Brotli' },
        ],
        default: ['gzip', 'br'],
      },
      {
        kind: 'integer',
        key: 'min_content_length',
        label: 'Skip bodies smaller than',
        help: 'Compressing a tiny body costs more than it saves.',
        min: 0,
        max: 10_485_760,
        default: 256,
        unit: 'bytes',
      },
      {
        kind: 'string_list',
        key: 'content_types',
        label: 'Content types to compress',
        help:
          'One media type per line, matched exactly (parameters like `; charset=utf-8` are ' +
          'ignored). Leave empty for the gateway’s list of common text and application types.',
        max_entries: 32,
        item_pattern: MEDIA_TYPE_PATTERN,
        item_max_length: 128,
      },
    ],
  },

  {
    name: 'response_caching',
    category: 'traffic',
    label: 'Response caching',
    summary:
      'Serves a repeated read from the gateway instead of your backend for as long as you allow. ' +
      'Each caller keeps its own cache partition, so one consumer never sees another’s response.',
    consumer_recipe:
      'Consumers see an `X-Cache-Status` header (`HIT`/`MISS`) and an `Age` on a cached ' +
      'response. `Cache-Control: no-cache` on their request bypasses the cache.',
    supports_trigger: false,
    fields: [
      {
        kind: 'integer',
        key: 'ttl_seconds',
        label: 'Default freshness',
        help: 'Used when your backend sends no `Cache-Control` of its own; yours always wins.',
        min: 1,
        max: 86_400,
        default: 300,
        unit: 'seconds',
      },
      {
        kind: 'string_list',
        key: 'cacheable_methods',
        label: 'Methods to cache',
        help: 'Only bodyless reads can be cached — the gateway refuses anything else.',
        max_entries: 2,
        min_entries: 1,
        options: [
          { value: 'GET', label: 'GET' },
          { value: 'HEAD', label: 'HEAD' },
        ],
        default: ['GET'],
      },
      {
        kind: 'integer_list',
        key: 'cacheable_status_codes',
        label: 'Statuses to cache',
        help: 'Partial (206) and validator-only (304) responses are never stored.',
        max_entries: 8,
        min_entries: 1,
        item_min: 200,
        item_max: 599,
        options: [
          { value: 200, label: '200 OK' },
          { value: 203, label: '203 Non-Authoritative' },
          { value: 301, label: '301 Moved Permanently' },
          { value: 308, label: '308 Permanent Redirect' },
          { value: 404, label: '404 Not Found' },
          { value: 410, label: '410 Gone' },
        ],
        default: [200, 301, 404],
      },
      {
        kind: 'boolean',
        key: 'cache_key_include_query',
        label: 'Separate cache entries per query string',
        help:
          'The query string is always part of the key; changing this only rotates the keyspace, ' +
          'so a cached response is never replayed across different queries either way.',
        default: true,
      },
      {
        kind: 'string_list',
        key: 'vary_by_headers',
        label: 'Also vary by these request headers',
        help: 'One header name per line, e.g. `accept-language`.',
        max_entries: 16,
        item_pattern: HTTP_FIELD_NAME_PATTERN,
        item_max_length: 128,
      },
    ],
  },

  {
    name: 'request_deduplication',
    category: 'traffic',
    label: 'Idempotency keys',
    summary:
      'Makes a retried write safe: the first call with a given key runs, and an identical retry ' +
      'replays the first response instead of charging the card twice.',
    consumer_recipe:
      'Consumers send a unique key per logical operation in the header below and may safely ' +
      'retry. Reusing a key with a different body is answered with 409 Conflict.',
    supports_trigger: true,
    fields: [
      {
        kind: 'string',
        key: 'header_name',
        label: 'Header name',
        pattern: HTTP_FIELD_NAME_PATTERN,
        max_length: 128,
        default: 'Idempotency-Key',
      },
      {
        kind: 'integer',
        key: 'ttl_seconds',
        label: 'Remember a completed call for',
        help: 'How long a retry with the same key replays the original response.',
        min: 1,
        max: 86_400,
        default: 300,
        unit: 'seconds',
      },
      {
        kind: 'string_list',
        key: 'applicable_methods',
        label: 'Methods that require a key',
        max_entries: 4,
        min_entries: 1,
        options: [
          { value: 'POST', label: 'POST' },
          { value: 'PUT', label: 'PUT' },
          { value: 'PATCH', label: 'PATCH' },
          { value: 'DELETE', label: 'DELETE' },
        ],
        default: ['POST', 'PUT', 'PATCH'],
      },
      {
        kind: 'boolean',
        key: 'enforce_required',
        label: 'Reject a call that omits the header',
        help: 'Answers 400 when one of the methods above arrives without a key.',
        default: false,
      },
    ],
  },

  {
    name: 'request_termination',
    category: 'traffic',
    label: 'Maintenance / sunset',
    summary:
      'Answers with a canned response instead of calling your backend. With no trigger the whole ' +
      'API is down for maintenance; with one, you can retire a single path.',
    consumer_recipe:
      'Consumers get the status and message you choose, with no call reaching your backend. Use ' +
      '503 for a maintenance window and 410 for a permanently retired endpoint.',
    supports_trigger: true,
    fields: [
      {
        kind: 'integer',
        key: 'status_code',
        label: 'Status code',
        help: '503 while you are down, 410 once an endpoint is gone for good.',
        min: 200,
        max: 599,
        default: 503,
      },
      {
        kind: 'string',
        key: 'message',
        label: 'Message',
        help: 'Returned as a JSON `message`.',
        pattern: HEADER_VALUE_PATTERN,
        max_length: 1_000,
        default: 'Service unavailable',
      },
    ],
  },
];

/** Palette descriptor for `name`, or `undefined` when it is not in the palette. */
export function findProviderPlugin(name: string): ProviderPluginDescriptor | undefined {
  return PROVIDER_PLUGINS.find((plugin) => plugin.name === name);
}

/**
 * Edge plugins Nexus manages from a dedicated field on the API rather than from
 * the palette, mapped to the field that owns them.
 *
 * The route uses this to answer a `PUT /plugins/key_auth` with a `400` that
 * names the right control, instead of a `404` that reads like the gateway does
 * not have the plugin.
 */
export const FIRST_CLASS_PLUGIN_FIELDS: Readonly<Record<string, string>> = {
  key_auth: 'auth_plugin',
  basic_auth: 'auth_plugin',
  jwt_auth: 'auth_plugin',
  access_control: 'requestable',
  rate_limiting: 'rate_limit',
  cors: 'cors',
  openapi_validator: 'spec_enforcement',
};

/** Whether `name` is owned by a first-class API field rather than the palette. */
export function isFirstClassPlugin(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(FIRST_CLASS_PLUGIN_FIELDS, name);
}

/* ── Wire shapes ────────────────────────────────────────────────────────── */

/** Longest `path_prefix` a portal trigger may carry. */
export const MAX_PLUGIN_TRIGGER_PATH_LENGTH = 512;

/**
 * The portal's slice of Edge's `PluginConfig.trigger` predicate tree.
 *
 * Edge accepts a full boolean expression over method, path, host, headers,
 * query, cookies, protocol, source CIDR and identity. The portal offers the two
 * predicates a provider actually reaches for — "only these methods" and "only
 * under this path" — and the service compiles them into the `all`/`match` tree
 * Edge expects. At least one of the two must be present; both together are an
 * AND.
 */
export interface ApiPluginTrigger {
  /** Methods the plugin runs for. Absent means "any method". */
  methods?: HttpMethod[];
  /**
   * Path prefix the plugin runs under, matched against the canonical request
   * path — which includes the API's gateway listen path. Absent means "any
   * path".
   */
  path_prefix?: string;
}

/** One palette plugin as configured on an API. */
export interface ApiPlugin {
  /** Exact Edge plugin name; always one of {@link PROVIDER_PLUGINS}. */
  plugin_name: string;
  /**
   * When `false` the config still exists on the gateway and stays associated
   * with the proxy, but Edge does not run it — the provider's settings are
   * preserved for the next time they switch it back on.
   */
  enabled: boolean;
  /** Exactly the keys the descriptor's fields declare. */
  config: Record<string, unknown>;
  trigger: ApiPluginTrigger | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}
