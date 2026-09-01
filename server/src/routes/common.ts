/**
 * Pieces every route plugin needs: pagination parsing and query coercion.
 *
 * Query strings are always strings, so numbers and booleans are coerced here
 * once instead of in each handler. `limit` is clamped to the shared
 * `[1, MAX_PAGE_SIZE]` window at validation time, which means a route never
 * hands the store a page size it would have had to clamp anyway.
 */

import { z } from 'zod';

import { MAX_PAGE_SIZE } from '@ferrum-nexus/shared';

import type { ListOptions } from '../db/store.js';

/** `?limit=&offset=` accepted by every list endpoint. */
export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

/**
 * A query-string boolean. Kept as a plain enum rather than a `transform` so the
 * schema's input and output types stay identical, which is what `parseOrThrow`
 * needs to infer a single result type.
 */
export const booleanQuerySchema = z
  .enum(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'])
  .optional();

/** Interpret a value parsed by {@link booleanQuerySchema}. */
export function toBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  return ['true', '1', 'yes', 'on'].includes(value);
}

/** Turn parsed pagination into the store's {@link ListOptions}. */
export function listOptions(query: { limit?: number; offset?: number }): ListOptions {
  return {
    ...(query.limit !== undefined ? { limit: query.limit } : {}),
    ...(query.offset !== undefined ? { offset: query.offset } : {}),
  };
}

/** A UUID path parameter. Ids are opaque strings, so length is all we check. */
export const idParamSchema = z.object({ id: z.string().trim().min(1).max(64) });
