/**
 * A small but faithful OpenID Connect provider for the single sign-on tests.
 *
 * It listens on a real loopback port, so the portal reaches it exactly the way
 * it reaches a production provider — discovery, the key set and the token
 * endpoint over HTTP — and it enforces what a real provider enforces: a
 * registered client and redirect URI, single-use codes bound to the redirect
 * URI, client authentication, and PKCE `S256` (a missing or wrong verifier is
 * `invalid_grant`). The browser half of the flow is {@link MockOidcProvider.authorize}:
 * the test hands it the authorization URL the portal redirected to, as a user
 * signing in would, and gets back the code and `state` to deliver to the
 * callback.
 *
 * Every ID token it signs can be tampered with first ({@link
 * MockOidcProvider.nextIdToken}) so the tests can drive the validation
 * failures — wrong issuer, audience, nonce, algorithm, an expired token —
 * through the real endpoint.
 */

import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type GenerateKeyPairResult,
  type JWK,
  type JWTPayload,
} from 'jose';

/** Options of {@link createMockOidcProvider}. */
export interface MockOidcProviderOptions {
  clientId: string;
  /** `null` registers a public client that authenticates with PKCE alone. */
  clientSecret: string | null;
  /** Signature algorithm of the provider's key. Defaults to `RS256`. */
  alg?: 'RS256' | 'ES256';
}

/** What the "browser" learns from one authorization. */
export interface MockAuthorization {
  code: string;
  state: string;
  redirectUri: string;
  /** The parsed authorization request, for tests that inspect it. */
  params: URLSearchParams;
}

/** How the next ID token is signed. */
export type MockSigning = 'provider' | 'foreign-key' | 'hs256' | 'none';

/** One token request the provider received. */
export interface MockTokenRequest {
  form: URLSearchParams;
  authorization: string | undefined;
}

/** A running mock provider. */
export interface MockOidcProvider {
  /** `http://127.0.0.1:<port>`, once started. */
  readonly issuer: string;
  start(): Promise<string>;
  stop(): Promise<void>;
  /**
   * Act as the user at the provider: validate the authorization request the
   * portal built, remember its nonce, PKCE challenge and redirect URI, and
   * mint a single-use code whose ID token will carry `claims`.
   */
  authorize(authorizationUrl: string, claims: Record<string, unknown>): MockAuthorization;
  /** Rewrite the payload of the next ID token the token endpoint signs. */
  nextIdToken: ((payload: JWTPayload) => JWTPayload) | null;
  /** How the next ID token is signed; resets to `provider` after use. */
  nextSigning: MockSigning;
  /** Merged over the discovery document. */
  discoveryOverrides: Record<string, unknown>;
  /** Sign an arbitrary payload with the provider's key (unit tests). */
  sign(payload: JWTPayload, signing?: MockSigning): Promise<string>;
  /** Replace the signing key, as a rotation at the provider would. */
  rotateKey(): Promise<void>;
  /** Token requests received, oldest first. */
  readonly tokenRequests: MockTokenRequest[];
  /** Discovery and key-set fetches received. */
  readonly metadataRequests: string[];
}

interface PendingCode {
  redirectUri: string;
  codeChallenge: string;
  nonce: string;
  claims: Record<string, unknown>;
}

interface SigningKey {
  kid: string;
  privateKey: GenerateKeyPairResult['privateKey'];
  publicJwk: JWK;
}

async function newKey(alg: 'RS256' | 'ES256'): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true });
  const kid = randomBytes(8).toString('hex');
  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg, use: 'sig' };
  return { kid, privateKey, publicJwk };
}

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

/** Build a mock provider; call `start()` before use and `stop()` after. */
export function createMockOidcProvider(options: MockOidcProviderOptions): MockOidcProvider {
  const alg = options.alg ?? 'RS256';
  const codes = new Map<string, PendingCode>();
  let key: SigningKey | null = null;
  let foreignKey: SigningKey | null = null;
  let server: Server | null = null;
  let issuer = '';

  async function sign(payload: JWTPayload, signing: MockSigning = 'provider'): Promise<string> {
    if (signing === 'none') {
      return `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url(payload)}.`;
    }
    if (signing === 'hs256') {
      // The classic confusion attack: an HMAC keyed with something public.
      return new SignJWT(payload)
        .setProtectedHeader({ alg: 'HS256', kid: key?.kid ?? 'k' })
        .sign(new TextEncoder().encode(JSON.stringify(key?.publicJwk ?? {})));
    }
    const signer = signing === 'foreign-key' ? foreignKey : key;
    if (!signer) throw new Error('mock provider is not started');
    return new SignJWT(payload)
      .setProtectedHeader({ alg, kid: signing === 'foreign-key' ? (key?.kid ?? '') : signer.kid })
      .sign(signer.privateKey);
  }

  const provider: MockOidcProvider = {
    get issuer() {
      return issuer;
    },
    nextIdToken: null,
    nextSigning: 'provider',
    discoveryOverrides: {},
    tokenRequests: [],
    metadataRequests: [],
    sign,

    async rotateKey(): Promise<void> {
      key = await newKey(alg);
    },

    async start(): Promise<string> {
      key = await newKey(alg);
      foreignKey = await newKey(alg);
      const running = createServer((request, response) => {
        void handle(request, response).catch((error: unknown) => {
          sendJson(response, 500, { error: 'server_error', detail: String(error) });
        });
      });
      server = running;
      await new Promise<void>((resolve) => running.listen(0, '127.0.0.1', () => resolve()));
      const address = running.address() as AddressInfo;
      issuer = `http://127.0.0.1:${address.port}`;
      return issuer;
    },

    async stop(): Promise<void> {
      const running = server;
      server = null;
      if (running) await new Promise<void>((resolve) => running.close(() => resolve()));
    },

    authorize(authorizationUrl, claims): MockAuthorization {
      const url = new URL(authorizationUrl);
      if (`${url.origin}${url.pathname}` !== `${issuer}/authorize`) {
        throw new Error(`not this provider's authorization endpoint: ${url.origin}${url.pathname}`);
      }
      const params = url.searchParams;
      if (params.get('response_type') !== 'code') throw new Error('response_type must be code');
      if (params.get('client_id') !== options.clientId) throw new Error('unknown client_id');
      if (params.get('code_challenge_method') !== 'S256') throw new Error('PKCE S256 required');
      const redirectUri = params.get('redirect_uri');
      const codeChallenge = params.get('code_challenge');
      const state = params.get('state');
      const nonce = params.get('nonce');
      const scope = params.get('scope') ?? '';
      if (!redirectUri || !codeChallenge || !state || !nonce) {
        throw new Error('redirect_uri, code_challenge, state and nonce are all required');
      }
      if (!scope.split(' ').includes('openid')) throw new Error('scope must include openid');
      const code = randomBytes(24).toString('base64url');
      codes.set(code, { redirectUri, codeChallenge, nonce, claims });
      return { code, state, redirectUri, params };
    },
  };

  function authenticateClient(form: URLSearchParams, authorization: string | undefined): boolean {
    if (authorization?.startsWith('Basic ')) {
      const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      const id = decodeURIComponent(decoded.slice(0, separator));
      const secret = decodeURIComponent(decoded.slice(separator + 1));
      return id === options.clientId && secret === options.clientSecret;
    }
    if (form.get('client_id') !== options.clientId) return false;
    if (options.clientSecret === null) return true;
    return form.get('client_secret') === options.clientSecret;
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', issuer);
    if (request.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
      provider.metadataRequests.push(url.pathname);
      sendJson(response, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: [alg],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
        ...provider.discoveryOverrides,
      });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/jwks') {
      provider.metadataRequests.push(url.pathname);
      sendJson(response, 200, { keys: key ? [key.publicJwk] : [] });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/token') {
      const form = new URLSearchParams(await readBody(request));
      const authorization = request.headers.authorization;
      provider.tokenRequests.push({ form, authorization });
      if (!authenticateClient(form, authorization)) {
        sendJson(response, 401, { error: 'invalid_client' });
        return;
      }
      if (form.get('grant_type') !== 'authorization_code') {
        sendJson(response, 400, { error: 'unsupported_grant_type' });
        return;
      }
      const code = form.get('code') ?? '';
      const pending = codes.get(code);
      codes.delete(code);
      const verifier = form.get('code_verifier');
      if (!pending || form.get('redirect_uri') !== pending.redirectUri) {
        sendJson(response, 400, { error: 'invalid_grant' });
        return;
      }
      // PKCE: without the verifier, or with the wrong one, the code is useless.
      const challenge =
        verifier === null ? null : createHash('sha256').update(verifier).digest('base64url');
      if (challenge !== pending.codeChallenge) {
        sendJson(response, 400, { error: 'invalid_grant', error_description: 'PKCE failed' });
        return;
      }
      const accessToken = randomBytes(24).toString('base64url');
      const now = Math.floor(Date.now() / 1000);
      let payload: JWTPayload = {
        iss: issuer,
        aud: options.clientId,
        iat: now,
        exp: now + 300,
        nonce: pending.nonce,
        at_hash: createHash('sha256')
          .update(accessToken)
          .digest()
          .subarray(0, 16)
          .toString('base64url'),
        ...pending.claims,
      };
      if (provider.nextIdToken) {
        payload = provider.nextIdToken(payload);
        provider.nextIdToken = null;
      }
      const signing = provider.nextSigning;
      provider.nextSigning = 'provider';
      sendJson(response, 200, {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 300,
        id_token: await sign(payload, signing),
      });
      return;
    }
    sendJson(response, 404, { error: 'not_found' });
  }

  return provider;
}
