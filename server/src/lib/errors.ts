import type { FastifyReply } from 'fastify';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public override readonly message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new ApiError(400, code, message, details);
export const unauthorized = (message = 'Unauthenticated') =>
  new ApiError(401, 'unauthorized', message);
export const forbidden = (message = 'Forbidden') => new ApiError(403, 'forbidden', message);
export const notFound = (message = 'Not found') => new ApiError(404, 'not_found', message);
export const conflict = (code: string, message: string) => new ApiError(409, code, message);
export const tooManyRequests = (message = 'Too many requests') =>
  new ApiError(429, 'rate_limited', message);
export const upstreamError = (message = 'Upstream gateway error', details?: unknown) =>
  new ApiError(502, 'upstream_error', message, details);

export function sendError(reply: FastifyReply, err: ApiError): FastifyReply {
  return reply.status(err.status).send({
    error: { code: err.code, message: err.message, details: err.details },
  });
}
