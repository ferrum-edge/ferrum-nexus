/**
 * `@ferrum-nexus/shared` — zero-dependency types and constants consumed by
 * both the Nexus server (`server/`) and the web SPA (`web/`).
 *
 * This workspace must be built before typechecking or testing the others,
 * because its `main`/`types` point at `dist/`.
 */

export * from './roles.js';
export * from './error-codes.js';
export * from './constants.js';
export * from './entities.js';
export * from './api-contract.js';
