/**
 * `GET /api/branding` — the one unauthenticated read in the API.
 *
 * The SPA calls this before it has a session so the login page can render with
 * the right name, logo, colours and theme, and so it knows whether to mount a
 * CAPTCHA widget. Everything returned here is public by construction: the
 * CAPTCHA block carries the site key only, never the vendor secret, and
 * `bootstrap_required` says that the portal is empty without saying anything
 * about the token that guards it. The registration policy is here for the same
 * reason: the sign-up form has to know which roles it may offer before it has
 * a session, and both facts it carries are already observable by attempting a
 * registration.
 *
 * The payload is cached for `NEXUS_BRANDING_CACHE_MS` and served with a short
 * public `Cache-Control` and an `ETag`, so repeat traffic can be absorbed in
 * front of the server. The route-scoped limiter in `server/src/index.ts` is
 * the ceiling on top of that cache.
 */

import { createHash } from 'node:crypto';

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

import { REGISTRABLE_ROLES, type BrandingResponse } from '@ferrum-nexus/shared';

import type { SettingsService } from '../admin/settings-service.js';
import type { CaptchaService } from '../auth/captcha.js';
import type { AuthService } from '../auth/service.js';
import type { NexusConfig } from '../config/index.js';

/**
 * How long a *taken* founder seat is trusted without re-reading the database.
 * Only the `false` answer is ever held; see {@link memoizeBootstrapRequired}.
 */
const BOOTSTRAP_REQUIRED_CACHE_MS = 1_000;

/** Services this route plugin needs. */
export interface BrandingRoutesOptions {
  config: NexusConfig;
  settings: SettingsService;
  captcha: CaptchaService;
  auth: AuthService;
}

/**
 * Everything in the branding payload that may be memoised. `bootstrap_required`
 * is deliberately absent: the founder seat is a cross-instance state
 * transition, and a process that cached an open seat must not keep
 * advertising it for the rest of the TTL after another instance filled it.
 */
type CachedBrandingPayload = Omit<BrandingResponse, 'bootstrap_required'>;

/** A payload and the moment it was assembled. */
interface CachedBranding {
  value: CachedBrandingPayload;
  /** Epoch milliseconds at which the underlying reads started. */
  checkedAt: number;
}

/**
 * Memoise `run` for `ttlMs`, coalescing concurrent callers onto one call.
 *
 * Same shape as the health-route cache: a TTL bounds sustained traffic and a
 * shared in-flight promise bounds simultaneous bursts. `ttlMs <= 0` removes the
 * memo entirely rather than shrinking it to nothing. Committed service writes
 * change the revision immediately, including for callers awaiting an assembly.
 */
function memoizeBranding(
  ttlMs: number,
  getRevision: () => number,
  run: () => Promise<CachedBrandingPayload>,
): () => Promise<CachedBranding> {
  if (ttlMs <= 0) {
    return async () => {
      const checkedAt = Date.now();
      return { value: await run(), checkedAt };
    };
  }

  let cached: (CachedBranding & { expiresAt: number; revision: number }) | null = null;
  let pending: { revision: number; promise: Promise<CachedBranding> } | null = null;

  return async function loadBranding(): Promise<CachedBranding> {
    const revision = getRevision();
    if (cached && cached.revision === revision && cached.expiresAt > Date.now()) {
      return { value: cached.value, checkedAt: cached.checkedAt };
    }
    if (!pending || pending.revision !== revision) {
      const promise: Promise<CachedBranding> = (async () => {
        const checkedAt = Date.now();
        const value = await run();
        // A write during assembly must not repopulate the cache with old data.
        if (getRevision() === revision) {
          cached = { value, checkedAt, expiresAt: Date.now() + ttlMs, revision };
        }
        return { value, checkedAt };
      })().finally(() => {
        if (pending?.promise === promise) pending = null;
      });
      pending = { revision, promise };
    }
    const result = await pending.promise;
    return getRevision() === revision ? result : loadBranding();
  };
}

/**
 * Coalesce database-backed founder-seat checks, and briefly hold a *taken* seat.
 *
 * An open seat is **never** cached. `bootstrap_required: true` is a
 * cross-instance state transition waiting to happen — any instance over the
 * same database may claim the seat at any moment, and this one has to stop
 * advertising it as open on the very next request. So once a `true` query
 * settles nothing is retained, and every request arriving afterwards reads the
 * database again. What bounds anonymous amplification while the seat is open
 * is coalescing alone: however many `/api/branding` requests arrive while one
 * count query is in flight, they all wait on that single query, so an instance
 * never holds more than one seat check against the pool at a time.
 *
 * A settled `false` is the opposite: the seat is taken, and the last active
 * super admin can be neither demoted, disabled nor removed, so it cannot
 * reopen. That answer is held for {@link BOOTSTRAP_REQUIRED_CACHE_MS}, which
 * is what keeps sustained unauthenticated traffic against this public endpoint
 * from mapping one-for-one onto database count queries in the steady state a
 * bootstrapped portal spends its life in.
 *
 * A same-instance seat claim bumps the revision, which both drops the held
 * answer and makes callers that were waiting on a pre-claim query re-read
 * rather than trust its answer.
 */
function memoizeBootstrapRequired(
  getRevision: () => number,
  run: () => Promise<boolean>,
): () => Promise<boolean> {
  let seatTaken: { expiresAt: number; revision: number } | null = null;
  let pending: { revision: number; promise: Promise<boolean> } | null = null;

  return async function loadBootstrapRequired(): Promise<boolean> {
    const revision = getRevision();
    if (seatTaken && seatTaken.revision === revision && seatTaken.expiresAt > Date.now()) {
      return false;
    }
    if (!pending || pending.revision !== revision) {
      const promise = run()
        .then((value) => {
          if (!value && getRevision() === revision) {
            seatTaken = { expiresAt: Date.now() + BOOTSTRAP_REQUIRED_CACHE_MS, revision };
          }
          return value;
        })
        .finally(() => {
          if (pending?.promise === promise) pending = null;
        });
      pending = { revision, promise };
    }
    const value = await pending.promise;
    return getRevision() === revision ? value : loadBootstrapRequired();
  };
}

/** Weak ETag for a branding payload — stable for the cached object identity. */
export function brandingEtag(payload: BrandingResponse): string {
  return `"${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}"`;
}

/** `/api/branding` route plugin (public). */
export const brandingRoutes: FastifyPluginAsync<BrandingRoutesOptions> = async (app, options) => {
  const { config, settings, captcha, auth } = options;

  const assembleBranding = async (): Promise<CachedBrandingPayload> => {
    const branding = await settings.getBranding();
    const policy = await auth.getRegistrationPolicy();
    return {
      ...branding,
      captcha: await captcha.getPublicConfig(),
      // Narrowed to the self-selectable roles: the register route only accepts
      // those, so an elevated role left in the stored policy is not something
      // the sign-up form could ever offer.
      registration: {
        open_registration: policy.open_registration,
        allowed_roles: REGISTRABLE_ROLES.filter((role) => policy.allowed_roles.includes(role)),
      },
    };
  };
  const loadBranding = memoizeBranding(
    config.brandingCacheMs,
    settings.getBrandingRevision,
    assembleBranding,
  );
  const loadBootstrapRequired = memoizeBootstrapRequired(
    auth.getBrandingRevision,
    auth.bootstrapRequired,
  );

  app.get('/', async (request: FastifyRequest, reply: FastifyReply): Promise<BrandingResponse> => {
    const [cached, bootstrap_required] = await Promise.all([
      loadBranding(),
      loadBootstrapRequired(),
    ]);
    const payload: BrandingResponse = { ...cached.value, bootstrap_required };
    const maxAgeSec =
      config.brandingCacheMs > 0 ? Math.max(1, Math.ceil(config.brandingCacheMs / 1000)) : 0;

    if (maxAgeSec > 0) {
      const etag = brandingEtag(payload);
      reply.header('cache-control', `public, max-age=${maxAgeSec}`);
      reply.header('etag', etag);
      if (request.headers['if-none-match'] === etag) {
        return reply.status(304).send();
      }
    }

    return payload;
  });
};
