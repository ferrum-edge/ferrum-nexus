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
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      reply.status(err.statusCode).send({
        error: { code: err.code ?? 'bad_request', message: err.message },
      });
      return;
    }
    req.log.error({ err }, 'unhandled error');
    reply.status(500).send({
      error: { code: 'internal_error', message: 'Internal server error' },
    });
  });
}
