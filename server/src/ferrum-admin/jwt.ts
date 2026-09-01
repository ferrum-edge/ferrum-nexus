/**
 * Admin JWT minting for the Ferrum Edge Admin API.
 *
 * Edge verifies HS256 tokens and **rejects a token missing any required
 * claim**: `iss`, `sub`, `iat`, `nbf`, `exp`, `jti` and a string `role`. It
 * also rejects a token that carries an `aud` claim when the gateway has no
 * `FERRUM_ADMIN_JWT_AUDIENCE` configured, so `aud` is stamped **only** when
 * Nexus is explicitly configured with one.
 *
 * Tokens are cached in a small LRU keyed by every signing input (the secret is
 * hashed into the key, never stored in it) and re-minted once the remaining
 * lifetime drops below `min(60, ttl / 4)` seconds, so the token handed to
 * undici always has meaningful life left. This is the ferrum-foundry pattern.
 */

import { createHash, randomUUID } from 'node:crypto';

import { SignJWT } from 'jose';

import type { EdgeConfig } from '../config/index.js';
import { internal } from '../lib/errors.js';

/** Gateway roles an admin JWT may claim. Nexus always needs `admin`. */
export type EdgeRole = 'viewer' | 'operator' | 'admin';

/** Default `sub` claim; it becomes the actor of every Edge audit event. */
export const DEFAULT_ADMIN_SUBJECT = 'ferrum-nexus';

/** Minimum length of `FERRUM_ADMIN_JWT_SECRET`, enforced by the gateway too. */
export const MIN_SECRET_LENGTH = 32;

/** Hard cap Edge applies to `exp - iat` (`FERRUM_ADMIN_JWT_MAX_TTL`). */
export const MAX_TTL_SECONDS = 3_600;

const MAX_CACHE_ENTRIES = 256;

/** Everything needed to sign one admin token. */
export interface SignAdminJwtOptions {
  secret: string;
  issuer: string;
  subject: string;
  role: EdgeRole;
  /** Only set when the gateway configures an audience. */
  audience?: string | undefined;
  ttlSeconds: number;
  /** Unix seconds; injectable for tests. */
  now?: number;
  /** Token id; a fresh UUID by default. */
  jti?: string;
}

/**
 * Sign one HS256 admin token with the exact claim set Edge requires.
 *
 * `nbf` equals `iat`. No `aud` is emitted unless `audience` is supplied.
 */
export async function signAdminJwt(options: SignAdminJwtOptions): Promise<string> {
  const { secret, issuer, subject, role } = options;
  if (secret.length < MIN_SECRET_LENGTH) {
    throw internal(`Ferrum admin JWT secret must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  if (issuer.trim() === '') throw internal('Ferrum admin JWT issuer must not be empty');
  if (subject.trim() === '') throw internal('Ferrum admin JWT subject must not be empty');
  const ttl = options.ttlSeconds;
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > MAX_TTL_SECONDS) {
    throw internal(`Ferrum admin JWT TTL must be an integer between 1 and ${MAX_TTL_SECONDS}`);
  }

  const now = options.now ?? Math.floor(Date.now() / 1000);
  let signer = new SignJWT({ role })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(issuer)
    .setSubject(subject)
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + ttl)
    .setJti(options.jti ?? randomUUID());

  const audience = options.audience?.trim();
  if (audience) signer = signer.setAudience(audience);

  return signer.sign(new TextEncoder().encode(secret));
}

/* ── Cached minter ──────────────────────────────────────────────────────── */

interface CachedToken {
  token: string;
  /** Unix seconds at which the token stops being valid. */
  expiresAt: number;
}

/** Mints and caches admin tokens for one {@link EdgeConfig}. */
export interface AdminTokenMinter {
  /**
   * A valid admin token for `subject` (default {@link DEFAULT_ADMIN_SUBJECT}).
   * Returns the cached token while it still has more than
   * `min(60, ttl / 4)` seconds of life.
   */
  getToken(subject?: string, role?: EdgeRole): Promise<string>;
  /** Drop every cached token (tests, and config changes). */
  clearCache(): void;
  /** Number of cached tokens; exposed for tests. */
  size(): number;
}

function fingerprintFor(config: EdgeConfig, subject: string, role: EdgeRole): string {
  return createHash('sha256')
    .update(config.jwtSecret)
    .update('\0')
    .update(
      JSON.stringify({
        adminUrl: config.adminUrl,
        issuer: config.jwtIssuer,
        audience: config.jwtAudience ?? null,
        ttl: config.jwtTtlSeconds,
        subject,
        role,
      }),
    )
    .digest('hex');
}

/** Build a token minter bound to one Edge configuration. */
export function createAdminTokenMinter(config: EdgeConfig): AdminTokenMinter {
  const cache = new Map<string, CachedToken>();
  const refreshBuffer = Math.min(60, Math.max(1, Math.floor(config.jwtTtlSeconds / 4)));

  function prune(now: number): void {
    for (const [key, entry] of cache) {
      if (entry.expiresAt <= now) cache.delete(key);
    }
    while (cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
  }

  return {
    async getToken(subject = DEFAULT_ADMIN_SUBJECT, role: EdgeRole = 'admin'): Promise<string> {
      const now = Math.floor(Date.now() / 1000);
      const key = fingerprintFor(config, subject, role);
      const cached = cache.get(key);
      if (cached && now < cached.expiresAt - refreshBuffer) {
        // Refresh insertion order so hot subjects survive eviction.
        cache.delete(key);
        cache.set(key, cached);
        return cached.token;
      }

      prune(now);
      const token = await signAdminJwt({
        secret: config.jwtSecret,
        issuer: config.jwtIssuer,
        subject,
        role,
        audience: config.jwtAudience,
        ttlSeconds: config.jwtTtlSeconds,
        now,
      });
      cache.set(key, { token, expiresAt: now + config.jwtTtlSeconds });
      return token;
    },

    clearCache(): void {
      cache.clear();
    },

    size(): number {
      return cache.size;
    },
  };
}
