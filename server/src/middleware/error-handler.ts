import type { FastifyInstance } from 'fastify';
import { ApiError, sendError } from '../lib/errors.js';
import { ZodError } from 'zod';

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      sendError(reply, err);
      return;
    }
    if (err instanceof ZodError) {
      reply.status(400).send({
        error: { code: 'invalid_input', message: 'Invalid request payload', details: err.flatten() },
      });
      return;
    }
    const fastifyError = err as { statusCode?: number; code?: string; message?: string };
    if (
      fastifyError.statusCode &&
      fastifyError.statusCode >= 400 &&
      fastifyError.statusCode < 500
    ) {
      reply.status(fastifyError.statusCode).send({
        error: { code: fastifyError.code ?? 'bad_request', message: fastifyError.message },
      });
      return;
    }
    req.log.error({ err }, 'unhandled error');
    reply.status(500).send({
      error: { code: 'internal_error', message: 'Internal server error' },
    });
  });
}
