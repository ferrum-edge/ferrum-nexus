/**
 * Key generators for `@fastify/rate-limit`.
 *
 * The default generator keys on `request.ip`, which is the right answer for
 * the pre-authentication surface (`/api/auth/*`) but the wrong one for an
 * authenticated abuse budget: everyone behind one NAT would share a bucket,
 * and one account could still spread its traffic across many addresses.
 */

import type { FastifyRequest } from 'fastify';

/**
 * Bucket an authenticated request by account, falling back to the client
 * address when there is no session.
 *
 * **Hook ordering matters.** `request.currentUser` is set by the auth plugin's
 * `onRequest` hook, which is registered on the *root* instance before any route
 * scope, so it has already run by the time a scope-level `onRequest` limiter
 * calls this. A limiter registered with an earlier hook — or on an instance
 * that outranks the auth plugin — would see `null` here and silently degrade
 * every authenticated caller onto the shared IP bucket.
 *
 * The `user:` / `ip:` prefixes keep the two namespaces from colliding: without
 * them an account whose id happened to look like an address would share a
 * bucket with that address.
 */
export function userOrIpKey(request: FastifyRequest): string {
  const user = request.currentUser;
  return user ? `user:${user.id}` : `ip:${request.ip}`;
}
