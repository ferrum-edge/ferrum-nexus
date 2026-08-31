/**
 * The single place an exception becomes an HTTP response.
 *
 * Everything leaves the API as the shared `ApiErrorBody`:
 * `{ error: { code, message, details? } }`. Unknown failures are logged in
 * full and answered with a generic message, so internals never leak.
 */

import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError, type ZodType } from 'zod';

import type { ApiErrorBody, ErrorCode } from '@ferrum-nexus/shared';

import { NexusError, isNexusError } from '../lib/errors.js';

/** Turn a `ZodError` into `VALIDATION_FAILED` with per-field issue details. */
export function fromZodError(error: ZodError, message = 'Request validation failed'): NexusError {
  const details = error.issues.map((issue) => ({
    path: issue.path.join('.'),
    code: issue.code,
    message: issue.message,
  }));
  return new NexusError('VALIDATION_FAILED', message, details);
}

/**
 * Validate `data` against `schema`, throwing `VALIDATION_FAILED` with
 * field-level details instead of a raw `ZodError`. Every route body, query and
 * params object goes through this.
 */
export function parseOrThrow<T>(schema: ZodType<T>, data: unknown, message?: string): T {
  const result = schema.safeParse(data);
  if (!result.success) throw fromZodError(result.error, message);
  return result.data;
}

/** Map a Fastify/HTTP status onto the closest shared error code. */
function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
    case 413:
    case 415:
    case 422:
      return 'VALIDATION_FAILED';
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 429:
      return 'RATE_LIMITED';
    default:
      return 'INTERNAL';
  }
}

function body(error: NexusError): ApiErrorBody {
  return { error: error.toBody() };
}

/** Normalise any thrown value into a {@link NexusError}. */
export function toNexusError(error: unknown): NexusError {
  if (isNexusError(error)) return error;
  if (error instanceof ZodError) return fromZodError(error);

  const fastifyError = error as Partial<FastifyError> & { statusCode?: number };
  const status = typeof fastifyError.statusCode === 'number' ? fastifyError.statusCode : 500;
  if (status < 500) {
    const code = codeForStatus(status);
    const message =
      typeof fastifyError.message === 'string' && fastifyError.message.length > 0
        ? fastifyError.message
        : 'Request could not be processed';
    return new NexusError(code, message);
  }
  return new NexusError('INTERNAL', 'Internal server error', undefined, { cause: error });
}

/** Options for {@link registerErrorHandler}. */
export interface ErrorHandlerOptions {
  /**
   * Called for non-`/api` 404s when the SPA is being served, so client-side
   * routes fall back to `index.html`. `/api` 404s always answer with JSON.
   */
  spaFallback?: (request: FastifyRequest, reply: FastifyReply) => unknown;
}

/**
 * Install the error and not-found handlers.
 *
 * `/api/*` 404s answer with the JSON error body; everything else falls through
 * to `options.spaFallback` when one is supplied.
 */
export function registerErrorHandler(
  app: FastifyInstance,
  options: ErrorHandlerOptions = {},
): void {
  app.setErrorHandler((error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    const nexusError = toNexusError(error);

    if (nexusError.statusCode >= 500) {
      request.log.error({ err: error, url: request.url }, 'Unhandled server error');
    } else {
      request.log.debug(
        { code: nexusError.code, status: nexusError.statusCode, url: request.url },
        'Request failed',
      );
    }

    return reply
      .status(nexusError.statusCode)
      .header('cache-control', 'no-store')
      .send(body(nexusError));
  });

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    // The SPA fallback only applies to navigations (GET, no file extension in
    // the last path segment); a missing hashed asset must 404 so a stale
    // index.html fails fast instead of executing HTML as a module script.
    const path = request.url.split('?')[0] ?? '';
    const lastSegment = path.slice(path.lastIndexOf('/') + 1);
    const looksLikeAsset = lastSegment.includes('.');
    if (
      options.spaFallback &&
      request.method === 'GET' &&
      !path.startsWith('/api') &&
      !looksLikeAsset
    ) {
      return options.spaFallback(request, reply);
    }
    return reply
      .status(404)
      .header('cache-control', 'no-store')
      .send(body(new NexusError('NOT_FOUND', `Route ${request.method} ${request.url} not found`)));
  });
}
