/**
 * Ferrum Edge Admin API rules the client depends on, copied from Edge.
 *
 * Kept free of imports so the acceptance suite (`e2e/src/dataplane.test.ts`)
 * can load this file and compare every value with the real gateway: the
 * pinned release in the required `acceptance` job, and Edge `main` in the
 * Edge Main Drift workflow. A value that stops matching fails there, not in
 * production.
 */

/**
 * Edge's `MAX_PAGE_SIZE` (`src/admin/mod.rs`). A larger `limit` is clamped to
 * this, so asking for more only costs a wasted parameter.
 */
export const EDGE_MAX_PAGE_SIZE = 1000;

/**
 * Edge's `404` `error` for each resource that does not exist in the namespace:
 * `NOT_FOUND_MESSAGE` of its `AdminResource` (`src/admin/crud.rs`), and
 * `ApiSpecError::NotFound` (`src/admin/api_specs/handlers.rs`). Edge answers an
 * unknown route with `{"error": "Not Found"}`, which none of these match.
 */
export const CONSUMER_NOT_FOUND = 'Consumer not found';
export const PROXY_NOT_FOUND = 'Proxy not found';
export const PLUGIN_CONFIG_NOT_FOUND = 'Plugin config not found';
export const API_SPEC_NOT_FOUND = 'API spec not found';

/**
 * The start of the `400` Edge's router answers to `If-Match` on a mutating
 * route that does not evaluate it (`IF_MATCH_UNSUPPORTED_MESSAGE`,
 * `src/admin/mod.rs`), before dispatch, so nothing was written. Releases
 * before ferrum-edge#7393 (v0.9.20 and earlier) answer it on the consumer
 * credential routes, which Edge v0.9.21 evaluates.
 */
export const IF_MATCH_UNSUPPORTED = 'If-Match is only supported on';

/**
 * The `error` of an API-spec write Edge refuses for the document itself
 * (`ApiSpecError::Extract` and `ApiSpecError::ValidationFailures`,
 * `src/admin/api_specs/handlers.rs`).
 */
export const SPEC_PARSE_FAILED = 'Spec parse failed';
export const SPEC_VALIDATION_FAILED = 'Spec validation failed';
