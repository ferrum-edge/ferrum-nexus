import { SignJWT } from 'jose';
import type { ResolvedConfig } from '../config/index.js';

let cached: { token: string; expiresAt: number } | null = null;

/**
 * Generate (or reuse) a short-lived HS256 JWT for the Ferrum Edge Admin API.
 *
 * We mint a new token a few seconds before the previous one expires to avoid
 * a clock-skew dependency on the gateway side.
 */
export async function getAdminToken(config: ResolvedConfig['ferrum']): Promise<string> {
  if (cached && cached.expiresAt > Date.now() + 5000) return cached.token;
  const issuedAt = Math.floor(Date.now() / 1000);
  const exp = issuedAt + config.jwtTtl;
  const token = await new SignJWT({ role: config.jwtRole })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(config.jwtIssuer)
    .setSubject(config.jwtSubject)
    .setIssuedAt(issuedAt)
    .setExpirationTime(exp)
    .sign(new TextEncoder().encode(config.jwtSecret));
  cached = { token, expiresAt: exp * 1000 };
  return token;
}

export function invalidateAdminToken(): void {
  cached = null;
}
