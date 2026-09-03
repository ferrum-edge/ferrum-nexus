/**
 * Turning an uploaded OpenAPI document into Ferrum Edge's `openapi_validator`
 * config.
 *
 * A pure module: paths in, plugin config out. It never touches the store, the
 * Edge client or the network, so the exact body Nexus will write to the gateway
 * can be asserted character for character without either.
 *
 * ## What this level enforces, and what it deliberately does not
 *
 * `routes` enforcement answers exactly one question: *is this path and method
 * in the document?* A request that matches no generated operation is rejected
 * with `400` and an `application/problem+json` body. Everything else the
 * plugin can do — request bodies, response bodies, media types, required
 * payloads — is switched off:
 *
 * ```
 * validate_request:  false
 * validate_response: false
 * ```
 *
 * That is not timidity, it is the honest boundary of what a portal can
 * generate. Body validation needs the *schemas* materialised out of the
 * document: local and remote `$ref` resolution, Swagger 2.0 → Draft 7
 * conversion, 3.0 → 3.1 draft selection, media-type and encoding handling.
 * Edge's own spec importer does all of that behind `x-ferrum-validate`; Nexus
 * re-implementing it would be a second, subtly different linter that rejects
 * traffic the gateway's own importer would have accepted. So the portal
 * generates only the part it can generate exactly — the operation table — and
 * leaves `operations[].request_body` / `responses` empty.
 *
 * Edge accepts that combination: `operations` entries need only
 * `method` + `path_template` + `path_regex`, and a schema-free config is
 * refused *only* when `fail_on_unknown_operation` is also false, which is the
 * one thing this config always sets to true.
 *
 * ## The path a regex has to match
 *
 * Edge matches operations against the **canonical policy path** — the full
 * client request path, derived once at the frontend boundary and shared with
 * routing, the WAF and the backend request line. That path still carries the
 * proxy's listen path: `strip_listen_path` governs what is sent *upstream*,
 * not what policy sees. So a document declaring `/invoices` published at
 * `/nexus/billing` must be enforced as `/nexus/billing/invoices`.
 *
 * The spec's own `servers[].url` pathname is **not** part of it. Nexus puts
 * that base path on the proxy's `backend_path`, so it is added on the way out
 * to the upstream and never appears in what the client sent.
 *
 * Since the canonical path never contains a `%` (Edge decodes or rejects every
 * escape before policy runs) the templates here are matched against decoded
 * text, and every literal character is regex-escaped so a `.` in a path such as
 * `/files/report.pdf` cannot match anything else.
 *
 * @see docs/openapi_validator.md, docs/request_path_canonicalization.md in the
 * Ferrum Edge repository.
 */

import type {
  EdgeOpenapiValidatorConfig,
  EdgeOpenapiValidatorOperation,
} from '../ferrum-admin/types.js';
import type { SpecPath } from './oas.js';

/** Name of the Edge plugin that enforces the operation table. */
export const OPENAPI_VALIDATOR_PLUGIN = 'openapi_validator';

/** Inputs beyond the document that shape the generated config. */
export interface ValidatorConfigOptions {
  /**
   * Whether the API has a CORS policy.
   *
   * A browser preflight is an `OPTIONS` to the *same* path with no declared
   * operation behind it, and `fail_on_unknown_operation` would reject it with
   * `400` before the `cors` plugin ever answered. Edge evaluates `bypass`
   * ahead of the unknown-operation check in `before_proxy`, so listing
   * `OPTIONS` there is what keeps CORS working — and it is only added when
   * there is a CORS policy to keep working, so an API without one still has
   * its `OPTIONS` surface closed.
   */
  hasCors: boolean;
}

/**
 * Escape a literal for Rust's `regex` crate.
 *
 * Exactly the set `regex::escape` escapes — the crate's meta characters, which
 * include the reserved-but-inert `#`, `&`, `-` and `~`. `/` is deliberately
 * *not* in it: it is not a meta character there, and Edge's own spec importer
 * (`path_template_to_regex` in `admin/api_specs/extractor.rs`) calls
 * `regex::escape` too, so a config generated here reads exactly like one the
 * gateway generated for itself.
 */
function escapeRegex(literal: string): string {
  return literal.replace(/[\\.+*?()|[\]{}^$#&\-~]/g, '\\$&');
}

/**
 * A path template as a full-match regex body, with `{param}` widened.
 *
 * Edge does not interpret path-parameter constraints, so `{id}` becomes
 * `[^/]+` exactly as its own importer emits — one or more non-separator
 * characters, which cannot swallow a `/` and reach a different operation.
 * Everything outside the braces is escaped as a literal, so a trailing slash
 * stays a required trailing slash and a `.` stays a `.`.
 *
 * A brace group that is not a parameter — unclosed, empty, blank, or carrying
 * a `/` — is escaped as literal text rather than widened. Edge's importer
 * rejects the document outright in those cases; treating them as literals here
 * fails in the narrower direction, which for an enforcement config is the safe
 * one: the worst outcome is a declared path nothing can reach, never an
 * undeclared path that slips through.
 */
function pathTemplateRegex(template: string): string {
  let out = '';
  let index = 0;
  while (index < template.length) {
    const open = template.indexOf('{', index);
    if (open === -1) break;
    const close = template.indexOf('}', open + 1);
    const name = close === -1 ? '' : template.slice(open + 1, close);
    if (close === -1 || name.trim() === '' || name.includes('/') || name.includes('{')) {
      // Not a parameter: keep scanning past this brace, and let it fall through
      // to the literal escaping below.
      index = open + 1;
      continue;
    }
    out += escapeRegex(template.slice(0, open)) + '[^/]+';
    template = template.slice(close + 1);
    index = 0;
  }
  return out + escapeRegex(template);
}

/**
 * The `openapi_validator` config for one API, or `null` when the document
 * declares nothing to enforce.
 *
 * `null` is a real outcome rather than an error: Edge refuses an `operations`
 * array that is empty, and a document whose every path item is metadata-only
 * would produce exactly that. The caller treats it the same way it treats an
 * API with no CORS policy — no plugin config at all, which leaves the proxy
 * behaving as it did before enforcement was switched on. That is the safe
 * direction: the alternative is a live API that rejects *every* request.
 *
 * @param paths the document's declared path items, from `parseOpenApiSpec`
 * @param listenPath the proxy's listen path, e.g. `/nexus/billing`
 */
export function validatorConfigFor(
  paths: SpecPath[],
  listenPath: string,
  options: ValidatorConfigOptions,
): EdgeOpenapiValidatorConfig | null {
  const operations: EdgeOpenapiValidatorOperation[] = [];
  for (const item of paths) {
    for (const method of item.methods) {
      operations.push({
        method,
        path_template: `${listenPath}${item.path}`,
        path_regex: `^${escapeRegex(listenPath)}${pathTemplateRegex(item.path)}$`,
      });
    }
  }
  if (operations.length === 0) return null;

  // Only the keys Edge's strict admission accepts, and only the ones the portal
  // actually decides. Every omitted key keeps the gateway's own default, which
  // is what a portal that cannot let the provider change it should do: sending
  // a value here would freeze a default the provider has no way to move.
  return {
    enforcement_mode: 'block',
    validate_request: false,
    validate_response: false,
    fail_on_unknown_operation: true,
    operations,
    ...(options.hasCors ? { bypass: { methods: ['OPTIONS'] } } : {}),
  };
}
