/**
 * The OpenID Connect relying-party primitives: discovery, the provider's key
 * set, the authorization-code exchange and ID token validation.
 *
 * Everything the portal trusts about a sign-in is decided here, so the rules
 * are strict and explicit:
 *
 * - **HTTPS only.** Discovery and every endpoint it names must be `https://`
 *   (`sso/config.ts`, {@link oidcUrlProblem}); redirects are never followed and
 *   responses are size-bounded and time-limited.
 * - **Discovery is pinned to the configured issuer.** The document's `issuer`
 *   must equal the configured one exactly, and it is cached for
 *   {@link DISCOVERY_TTL_MS}.
 * - **Authorization code with PKCE (`S256`).** A provider that advertises its
 *   PKCE methods without `S256` is refused.
 * - **The ID token is verified against the provider's JWKS** with an explicit
 *   algorithm allow-list ({@link ID_TOKEN_ALGORITHMS}: `RS256`, `ES256`), so
 *   `none` and the HMAC algorithms — which a JWKS public key would otherwise
 *   let an attacker forge — can never verify. `iss`, `aud` (and `azp`), `exp`,
 *   `nbf` and `iat` are checked with {@link CLOCK_TOLERANCE_SECONDS} of
 *   leeway — `iat` may be neither in the future nor older than
 *   {@link ID_TOKEN_MAX_AGE_SECONDS} — the `nonce` must equal the one this
 *   attempt sent, and `at_hash` must match the access token when both are
 *   present.
 * - **Public destinations only**, unless the operator says otherwise; failed
 *   fetches are remembered for {@link OIDC_FAILURE_CACHE_MS} and concurrent
 *   ones share a single request.
 *
 * Nothing here logs, and no error message it produces contains a token, a
 * code, a secret or a claim value.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

import {
  createLocalJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';

import { SSO_TRANSACTION_TTL_SECONDS, type SsoErrorReason } from '@ferrum-nexus/shared';

import {
  createUpstreamResolver,
  isPublicResolvedAddress,
  isPublicUpstreamHost,
  type UpstreamResolver,
} from '../publishing/oas.js';
import { isLoopbackHostname, oidcUrlProblem } from './config.js';

/** ID token signature algorithms the portal accepts. Nothing else ever verifies. */
export const ID_TOKEN_ALGORITHMS = ['RS256', 'ES256'] as const;

/** Leeway on `exp`, `nbf` and `iat`, for clock skew between the portal and the provider. */
export const CLOCK_TOLERANCE_SECONDS = 60;

/** How long a discovery document is reused. */
export const DISCOVERY_TTL_MS = 60 * 60 * 1000;

/** How long a key set is reused before it is fetched again. */
export const JWKS_TTL_MS = 60 * 60 * 1000;

/**
 * Shortest interval between two key-set fetches for one provider. An ID token
 * naming an unknown `kid` triggers a refetch — the provider may have rotated —
 * but no more often than this, so a stream of forged tokens cannot turn the
 * portal into a request amplifier against the provider.
 */
export const JWKS_REFRESH_COOLDOWN_MS = 30_000;

/** Deadline of every request to a provider. */
export const OIDC_HTTP_TIMEOUT_MS = 5_000;

/** Largest response accepted from a provider. */
export const OIDC_MAX_RESPONSE_BYTES = 512 * 1024;

/**
 * How long a failed discovery or key-set fetch is remembered. Sign-ins meet
 * the cached failure instead of each sending the provider another request.
 */
export const OIDC_FAILURE_CACHE_MS = 30_000;

/**
 * Oldest ID token accepted, by `iat`. A token is minted at the end of the
 * sign-in it belongs to, and a sign-in lasts at most this long.
 */
export const ID_TOKEN_MAX_AGE_SECONDS = SSO_TRANSACTION_TTL_SECONDS;

/** Longest `sub` OpenID Connect allows. */
export const MAX_SUBJECT_LENGTH = 255;

/**
 * A refusal the callback reports as `?sso_error=<reason>`. `message` is for
 * the server log; it never contains token or secret material.
 */
export class OidcError extends Error {
  readonly reason: SsoErrorReason;

  constructor(reason: SsoErrorReason, message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions | undefined);
    this.name = 'OidcError';
    this.reason = reason;
  }
}

/** The discovery fields the portal uses. */
export interface DiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  /** Absent when the provider does not advertise them. */
  code_challenge_methods_supported: string[] | null;
  id_token_signing_alg_values_supported: string[] | null;
  token_endpoint_auth_methods_supported: string[] | null;
}

/** What the token endpoint returned. */
export interface TokenSet {
  idToken: string;
  /** Used only for the `at_hash` check; never stored or logged. */
  accessToken: string | null;
}

/** A validated ID token's claims: at least a non-empty `sub`. */
export type IdTokenClaims = JWTPayload & { sub: string } & Record<string, unknown>;

/** The fetch the client uses; injectable for tests. */
export type OidcFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Options of {@link createOidcClient}. */
export interface OidcClientOptions {
  /** `NEXUS_OIDC_ALLOW_HTTP_LOOPBACK`: the literal loopback hosts may be spoken to. */
  allowHttpLoopback: boolean;
  /** `NEXUS_OIDC_ALLOW_PRIVATE_ADDRESSES`: any address may be spoken to. */
  allowPrivateAddresses?: boolean;
  /** Resolves a provider host before it is contacted. Defaults to real DNS. */
  resolve?: UpstreamResolver;
  /** Defaults to the global `fetch`. */
  fetch?: OidcFetch;
  /** Clock, in milliseconds; defaults to `Date.now`. */
  now?: () => number;
  /** Per-request deadline; defaults to {@link OIDC_HTTP_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** Input of {@link OidcClient.exchangeCode}. */
export interface CodeExchange {
  discovery: DiscoveryDocument;
  clientId: string;
  /** `null` for a public client, which authenticates with PKCE alone. */
  clientSecret: string | null;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}

/** Input of {@link OidcClient.validateIdToken}. */
export interface IdTokenValidation {
  idToken: string;
  discovery: DiscoveryDocument;
  clientId: string;
  /** The nonce this attempt put in the authorization request. */
  nonce: string;
  accessToken: string | null;
}

/** An OpenID Connect relying party bound to one process's caches. */
export interface OidcClient {
  /** The provider's discovery document, fetched or cached. */
  discover(issuer: string): Promise<DiscoveryDocument>;
  /** Redeem an authorization code, with the PKCE verifier. */
  exchangeCode(input: CodeExchange): Promise<TokenSet>;
  /** Verify an ID token and return its claims. */
  validateIdToken(input: IdTokenValidation): Promise<IdTokenClaims>;
  /** Drop every cached document and key set (after an administrator edits providers). */
  clearCache(): void;
}

/* ── PKCE, state and nonce ──────────────────────────────────────────────── */

/** A fresh high-entropy URL-safe value: 32 random bytes, base64url. */
export function randomUrlToken(): string {
  return randomBytes(32).toString('base64url');
}

/** The `S256` code challenge of a PKCE verifier (RFC 7636 §4.2). */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/** Constant-time comparison of two strings that may differ in length. */
export function tokensEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a, 'utf8').digest();
  const right = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(left, right) && a.length === b.length;
}

/** Input of {@link authorizationUrl}. */
export interface AuthorizationRequest {
  discovery: DiscoveryDocument;
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  state: string;
  nonce: string;
  codeChallenge: string;
}

/** The URL the browser is sent to: an authorization-code request with PKCE `S256`. */
export function authorizationUrl(request: AuthorizationRequest): string {
  const url = new URL(request.discovery.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', request.clientId);
  url.searchParams.set('redirect_uri', request.redirectUri);
  url.searchParams.set('scope', request.scopes.join(' '));
  url.searchParams.set('state', request.state);
  url.searchParams.set('nonce', request.nonce);
  url.searchParams.set('code_challenge', request.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

/**
 * The `at_hash` of an access token for an ID token signed with `RS256` or
 * `ES256`: the left half of its SHA-256, base64url (OpenID Connect Core
 * §3.1.3.6).
 */
export function accessTokenHash(accessToken: string): string {
  const digest = createHash('sha256').update(accessToken, 'ascii').digest();
  return digest.subarray(0, 16).toString('base64url');
}

/* ── HTTP ───────────────────────────────────────────────────────────────── */

async function readBounded(response: Response, label: string): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > OIDC_MAX_RESPONSE_BYTES) {
    throw new OidcError('provider_unavailable', `${label} response is too large`);
  }
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > OIDC_MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new OidcError('provider_unavailable', `${label} response is too large`);
    }
    chunks.push(chunk.value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((entry: unknown): entry is string => typeof entry === 'string');
}

function describe(error: unknown): string {
  if (error instanceof OidcError) return error.message;
  if (error instanceof Error && error.name === 'TimeoutError') return 'timed out';
  return error instanceof Error ? error.name : 'failed';
}

/* ── The client ─────────────────────────────────────────────────────────── */

interface CachedDiscovery {
  document: DiscoveryDocument;
  expiresAt: number;
}

interface CachedKeySet {
  resolve: ReturnType<typeof createLocalJWKSet>;
  fetchedAt: number;
}

interface CachedFailure {
  error: OidcError;
  until: number;
}

/** Build a relying party with its own discovery and key-set caches. */
export function createOidcClient(options: OidcClientOptions): OidcClient {
  const fetchImpl: OidcFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? (() => Date.now());
  const resolveHost = options.resolve ?? createUpstreamResolver();
  const timeoutMs = options.timeoutMs ?? OIDC_HTTP_TIMEOUT_MS;
  const discoveries = new Map<string, CachedDiscovery>();
  const keySets = new Map<string, CachedKeySet>();
  // Single flight: concurrent sign-ins share one fetch per issuer or key set.
  const pending = new Map<string, Promise<unknown>>();
  const failures = new Map<string, CachedFailure>();

  /**
   * Refuse a destination that is not public, unless the operator allowed it.
   *
   * The issuer is an administrator's choice, but the endpoints come from the
   * discovery document, so without this a provider — or whoever controls its
   * document — could aim the portal's requests at its own network. A name is
   * resolved and every answer must be public; the literal loopback hosts pass
   * with `NEXUS_OIDC_ALLOW_HTTP_LOOPBACK`, anything with
   * `NEXUS_OIDC_ALLOW_PRIVATE_ADDRESSES`. The check is at request time only:
   * the connection resolves the name again (see `docs/security.md`).
   */
  async function assertPublicDestination(url: string, label: string): Promise<void> {
    if (options.allowPrivateAddresses === true) return;
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (options.allowHttpLoopback && isLoopbackHostname(host)) return;
    if (!isPublicUpstreamHost(host)) {
      throw new OidcError('provider_unavailable', `${label} host is not a public address`);
    }
    if (isIP(host) !== 0) return;
    let answers: Awaited<ReturnType<UpstreamResolver>>;
    try {
      answers = await resolveHost(host);
    } catch {
      throw new OidcError('provider_unavailable', `${label} host could not be resolved`);
    }
    if (answers.length === 0 || !answers.every(isPublicResolvedAddress)) {
      throw new OidcError('provider_unavailable', `${label} host resolves to a non-public address`);
    }
  }

  /** One JSON request to a provider, under every transport rule above. */
  async function requestJson(
    url: string,
    label: string,
    init: RequestInit,
  ): Promise<{ status: number; body: unknown }> {
    const problem = oidcUrlProblem(url, options.allowHttpLoopback);
    if (problem !== null) throw new OidcError('provider_unavailable', `${label} URL ${problem}`);
    await assertPublicDestination(url, label);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new OidcError('provider_unavailable', `${label} request failed: ${describe(error)}`, {
        cause: error,
      });
    }
    let text: string;
    try {
      text = await readBounded(response, label);
    } catch (error) {
      if (error instanceof OidcError) throw error;
      throw new OidcError('provider_unavailable', `${label} response could not be read`);
    }
    try {
      return { status: response.status, body: JSON.parse(text) as unknown };
    } catch {
      throw new OidcError(
        'provider_unavailable',
        `${label} answered ${response.status} without a JSON body`,
      );
    }
  }

  /**
   * Run `fetchOnce` for `key` at most once at a time, and remember a failure
   * for {@link OIDC_FAILURE_CACHE_MS}.
   */
  async function shared<T>(key: string, fetchOnce: () => Promise<T>): Promise<T> {
    const failure = failures.get(key);
    if (failure && failure.until > now()) throw failure.error;
    const inFlight = pending.get(key);
    if (inFlight) return inFlight as Promise<T>;
    const attempt = fetchOnce().then(
      (value) => {
        failures.delete(key);
        return value;
      },
      (error: unknown) => {
        const refused =
          error instanceof OidcError
            ? error
            : new OidcError('provider_unavailable', `${key} could not be fetched`);
        failures.set(key, { error: refused, until: now() + OIDC_FAILURE_CACHE_MS });
        throw refused;
      },
    );
    pending.set(key, attempt);
    try {
      return await attempt;
    } finally {
      pending.delete(key);
    }
  }

  function endpoint(document: Record<string, unknown>, field: string): string {
    const value = document[field];
    if (typeof value !== 'string' || value === '') {
      throw new OidcError('provider_unavailable', `Discovery document has no ${field}`);
    }
    const problem = oidcUrlProblem(value, options.allowHttpLoopback);
    if (problem !== null) {
      throw new OidcError('provider_unavailable', `Discovery ${field} ${problem}`);
    }
    return value;
  }

  async function fetchDiscovery(issuer: string): Promise<DiscoveryDocument> {
    const url = `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
    const { status, body } = await requestJson(url, 'Discovery', {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    if (status !== 200 || body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new OidcError('provider_unavailable', `Discovery answered ${status}`);
    }
    const document = body as Record<string, unknown>;
    // OpenID Connect Discovery §4.3: the document must name the issuer it was
    // fetched for, exactly — this is what pins every later `iss` check.
    if (document.issuer !== issuer) {
      throw new OidcError(
        'provider_unavailable',
        'Discovery issuer does not match the configured issuer',
      );
    }
    const discovery: DiscoveryDocument = {
      issuer,
      authorization_endpoint: endpoint(document, 'authorization_endpoint'),
      token_endpoint: endpoint(document, 'token_endpoint'),
      jwks_uri: endpoint(document, 'jwks_uri'),
      code_challenge_methods_supported: asStringArray(document.code_challenge_methods_supported),
      id_token_signing_alg_values_supported: asStringArray(
        document.id_token_signing_alg_values_supported,
      ),
      token_endpoint_auth_methods_supported: asStringArray(
        document.token_endpoint_auth_methods_supported,
      ),
    };
    const methods = discovery.code_challenge_methods_supported;
    if (methods !== null && !methods.includes('S256')) {
      throw new OidcError('provider_unavailable', 'The provider does not support PKCE with S256');
    }
    const algorithms = discovery.id_token_signing_alg_values_supported;
    if (
      algorithms !== null &&
      !algorithms.some((alg) => (ID_TOKEN_ALGORITHMS as readonly string[]).includes(alg))
    ) {
      throw new OidcError(
        'provider_unavailable',
        `The provider signs ID tokens with none of ${ID_TOKEN_ALGORITHMS.join(', ')}`,
      );
    }
    return discovery;
  }

  async function discover(issuer: string): Promise<DiscoveryDocument> {
    const cached = discoveries.get(issuer);
    if (cached && cached.expiresAt > now()) return cached.document;
    return shared(`discovery ${issuer}`, async () => {
      const document = await fetchDiscovery(issuer);
      discoveries.set(issuer, { document, expiresAt: now() + DISCOVERY_TTL_MS });
      return document;
    });
  }

  async function fetchKeySet(uri: string): Promise<CachedKeySet> {
    const { status, body } = await requestJson(uri, 'JWKS', {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    if (status !== 200 || body === null || typeof body !== 'object') {
      throw new OidcError('provider_unavailable', `JWKS answered ${status}`);
    }
    if (!Array.isArray((body as { keys?: unknown }).keys)) {
      throw new OidcError('provider_unavailable', 'JWKS has no keys array');
    }
    let resolve: ReturnType<typeof createLocalJWKSet>;
    try {
      resolve = createLocalJWKSet(body as JSONWebKeySet);
    } catch {
      throw new OidcError('provider_unavailable', 'JWKS is not a valid key set');
    }
    const entry: CachedKeySet = { resolve, fetchedAt: now() };
    keySets.set(uri, entry);
    return entry;
  }

  /** The cached key set, refetched when stale or — rate-limited — on demand. */
  async function keySet(uri: string, refresh: boolean): Promise<CachedKeySet> {
    const cached = keySets.get(uri);
    if (cached) {
      const age = now() - cached.fetchedAt;
      if (!refresh && age < JWKS_TTL_MS) return cached;
      if (refresh && age < JWKS_REFRESH_COOLDOWN_MS) return cached;
    }
    return shared(`jwks ${uri}`, () => fetchKeySet(uri));
  }

  async function exchangeCode(input: CodeExchange): Promise<TokenSet> {
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    });
    const headers: Record<string, string> = {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    };
    if (input.clientSecret === null) {
      form.set('client_id', input.clientId);
    } else {
      const methods = input.discovery.token_endpoint_auth_methods_supported;
      const usePost =
        methods !== null &&
        !methods.includes('client_secret_basic') &&
        methods.includes('client_secret_post');
      if (usePost) {
        form.set('client_id', input.clientId);
        form.set('client_secret', input.clientSecret);
      } else {
        // RFC 6749 §2.3.1: both halves are form-encoded before the base64.
        const credentials = [input.clientId, input.clientSecret].map(encodeURIComponent);
        const pair = credentials.join(':');
        headers.authorization = `Basic ${Buffer.from(pair, 'utf8').toString('base64')}`;
      }
    }
    const { status, body } = await requestJson(input.discovery.token_endpoint, 'Token endpoint', {
      method: 'POST',
      headers,
      body: form.toString(),
    });
    const record =
      body !== null && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {};
    if (status !== 200) {
      // Only the registered error code, and only when it looks like one: the
      // description is free text a provider may fill with anything.
      const code =
        typeof record.error === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(record.error)
          ? record.error
          : 'unknown';
      throw new OidcError('provider_unavailable', `Token endpoint answered ${status} (${code})`);
    }
    if (typeof record.id_token !== 'string' || record.id_token === '') {
      throw new OidcError('token_invalid', 'Token endpoint returned no ID token');
    }
    return {
      idToken: record.id_token,
      accessToken: typeof record.access_token === 'string' ? record.access_token : null,
    };
  }

  async function validateIdToken(input: IdTokenValidation): Promise<IdTokenClaims> {
    const uri = input.discovery.jwks_uri;
    // Resolve against the cached set; an unknown `kid` refetches once, subject
    // to the cooldown, so a rotation at the provider is picked up.
    const getKey: JWTVerifyGetKey = async (header, token) => {
      const first = await keySet(uri, false);
      try {
        return await first.resolve(header, token);
      } catch (error) {
        if (!(error instanceof joseErrors.JWKSNoMatchingKey)) throw error;
        const refreshed = await keySet(uri, true);
        if (refreshed === first) throw error;
        return refreshed.resolve(header, token);
      }
    };

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(input.idToken, getKey, {
        algorithms: [...ID_TOKEN_ALGORITHMS],
        issuer: input.discovery.issuer,
        audience: input.clientId,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        maxTokenAge: ID_TOKEN_MAX_AGE_SECONDS,
        requiredClaims: ['sub', 'exp', 'iat'],
        currentDate: new Date(now()),
      }));
    } catch (error) {
      if (error instanceof OidcError) throw error;
      const code = error instanceof joseErrors.JOSEError ? error.code : 'ERR_UNKNOWN';
      throw new OidcError('token_invalid', `ID token rejected (${code})`, { cause: error });
    }

    // A token issued in the future was not issued for this sign-in, whatever
    // `maxTokenAge` makes of it.
    if (
      typeof payload.iat !== 'number' ||
      payload.iat > Math.floor(now() / 1000) + CLOCK_TOLERANCE_SECONDS
    ) {
      throw new OidcError('token_invalid', 'ID token iat is in the future');
    }
    const sub = payload.sub;
    if (typeof sub !== 'string' || sub === '' || sub.length > MAX_SUBJECT_LENGTH) {
      throw new OidcError('token_invalid', 'ID token has no usable sub claim');
    }
    // OpenID Connect Core §3.1.3.7: with several audiences, `azp` must name
    // this client; when present at all, it must be this client.
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    const azp = (payload as Record<string, unknown>).azp;
    if ((audiences.length > 1 || azp !== undefined) && azp !== input.clientId) {
      throw new OidcError('token_invalid', 'ID token azp does not name this client');
    }
    const nonce = (payload as Record<string, unknown>).nonce;
    if (typeof nonce !== 'string' || !tokensEqual(nonce, input.nonce)) {
      throw new OidcError('token_invalid', 'ID token nonce does not match this sign-in');
    }
    const atHash = (payload as Record<string, unknown>).at_hash;
    if (atHash !== undefined && input.accessToken !== null) {
      if (typeof atHash !== 'string' || !tokensEqual(atHash, accessTokenHash(input.accessToken))) {
        throw new OidcError('token_invalid', 'ID token at_hash does not match the access token');
      }
    }
    return { ...payload, sub } as IdTokenClaims;
  }

  return {
    discover,
    exchangeCode,
    validateIdToken,
    clearCache(): void {
      discoveries.clear();
      keySets.clear();
      failures.clear();
    },
  };
}
