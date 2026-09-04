/**
 * Key generators for `@fastify/rate-limit`.
 *
 * The default generator keys on `request.ip`, which is the right answer for the
 * pre-authentication surface (`/api/auth/*`) — there is no identity yet, and the
 * thing being limited is credential guessing from one place.
 *
 * It is the wrong answer everywhere behind a session. An IP bucket is both too
 * coarse and too fine at once: a whole office behind one NAT shares one
 * allowance, while one account can multiply its own by rotating source
 * addresses. What the expensive authenticated endpoints need to bound is the
 * *account*, so that is what these key on.
 */

import type { FastifyRequest } from 'fastify';

/**
 * `user:<id>` for an authenticated request, `ip:<address>` otherwise.
 *
 * The prefixes matter: without them an account whose id happened to look like
 * an address would share a bucket with that address, and — more practically —
 * a log line naming a bucket says which kind of thing it named.
 *
 * **Hook ordering.** `request.currentUser` is set by the `onRequest` hook the
 * auth plugin adds to the *root* instance, and Fastify runs a parent
 * instance's hooks before a child's; a route-level limiter registered inside an
 * `/api/...` scope therefore always sees a resolved session. If a limiter is
 * ever moved somewhere that ordering does not hold, it will silently degrade to
 * IP keying for every request rather than fail — so any new call site needs the
 * same two-users-two-buckets test the publishing routes have.
 *
 * The anonymous fallback is not merely defensive: a scope may mix guarded and
 * unguarded routes, and a limiter that returned a constant key for anonymous
 * traffic would put every unauthenticated caller in one shared bucket, which is
 * a denial-of-service primitive rather than a defence.
 */
export function userOrIpKey(request: FastifyRequest): string {
  const user = request.currentUser;
  return user ? `user:${user.id}` : `ip:${request.ip}`;
}
