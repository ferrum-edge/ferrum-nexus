/**
 * Fastify instance type alias. Bypasses the generic mismatch between pino's
 * `Logger` type and Fastify's `FastifyBaseLogger` constraint — both share the
 * same runtime shape, so route registrations accept either.
 */

import type { FastifyInstance, FastifyBaseLogger } from 'fastify';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

export type NexusFastify = FastifyInstance<
  Server,
  IncomingMessage,
  ServerResponse,
  FastifyBaseLogger
>;
