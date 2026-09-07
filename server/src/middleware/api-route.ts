import type { FastifyRequest } from 'fastify';

/** Use the router's registered identity, never a separately decoded request URL. */
export function isApiRequest(request: FastifyRequest): boolean {
  const route = request.routeOptions.url;
  return route === '/api' || route?.startsWith('/api/') === true;
}
