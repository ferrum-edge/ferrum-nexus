/**
 * Normalisation for the public origin of the gateway's **proxy listener** —
 * the address a client sends data-plane traffic to.
 *
 * Shared by `config/` (the `FERRUM_GATEWAY_PUBLIC_URL` default) and the
 * settings service (the `gateway.public_url` override) so both accept exactly
 * the same shape. An origin is all Nexus wants: the listen path is derived from
 * the namespace and slug, so a stored path, query string or set of credentials
 * could only produce a URL that does not route.
 */

/**
 * Validate an absolute `http(s)` origin and return it without a trailing slash,
 * or `null` when `raw` is not one.
 *
 * Rejects a non-`http(s)` scheme, embedded credentials, and any path, query or
 * fragment. `https://api.example.com/` and `https://api.example.com` both
 * normalise to `https://api.example.com`; a default port is dropped and a
 * non-default one kept.
 */
export function normalizeGatewayPublicUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  if (parsed.search !== '' || parsed.hash !== '') return null;
  if (parsed.pathname !== '' && parsed.pathname !== '/') return null;

  return parsed.origin;
}

/** Human-readable rule quoted by both the config error and the settings 400. */
export const GATEWAY_PUBLIC_URL_RULE =
  'must be an absolute http(s) origin with no path, query string or credentials, ' +
  'e.g. https://api.example.com';
