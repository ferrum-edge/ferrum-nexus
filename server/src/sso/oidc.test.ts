/**
 * The OpenID Connect primitives in isolation: discovery pinning, PKCE, and
 * every way an ID token can fail validation — a bad algorithm, audience or
 * issuer, an expired or not-yet-valid token, a nonce or `at_hash` mismatch.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import type { JWTPayload } from 'jose';

import { createMockOidcProvider, type MockOidcProvider } from '../test/mock-oidc-provider.js';
import { isLoopbackHostname, issuerProblem, oidcUrlProblem } from './config.js';
import {
  accessTokenHash,
  authorizationUrl,
  createOidcClient,
  OidcError,
  pkceChallenge,
  randomUrlToken,
  tokensEqual,
  type DiscoveryDocument,
  type OidcClient,
} from './oidc.js';

const CLIENT_ID = 'nexus-portal';
const NONCE = 'nonce-for-this-attempt';

async function rejectsWith(promise: Promise<unknown>, reason: string, detail?: RegExp) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof OidcError, `expected an OidcError, got ${String(error)}`);
    assert.equal(error.reason, reason);
    if (detail) assert.match(error.message, detail);
    return true;
  });
}

describe('PKCE, state and URLs', () => {
  it('derives the RFC 7636 S256 challenge', () => {
    // RFC 7636, appendix B.
    assert.equal(
      pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('mints distinct high-entropy tokens and compares them in constant time', () => {
    const a = randomUrlToken();
    const b = randomUrlToken();
    assert.notEqual(a, b);
    assert.match(a, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(tokensEqual(a, a), true);
    assert.equal(tokensEqual(a, b), false);
    assert.equal(tokensEqual(a, `${a}x`), false);
  });

  it('builds an authorization-code request with PKCE S256, state and nonce', () => {
    const discovery: DiscoveryDocument = {
      issuer: 'https://idp.example.com',
      authorization_endpoint: 'https://idp.example.com/authorize?tenant=a',
      token_endpoint: 'https://idp.example.com/token',
      jwks_uri: 'https://idp.example.com/jwks',
      code_challenge_methods_supported: ['S256'],
      id_token_signing_alg_values_supported: ['RS256'],
      token_endpoint_auth_methods_supported: null,
    };
    const url = new URL(
      authorizationUrl({
        discovery,
        clientId: CLIENT_ID,
        redirectUri: 'https://portal.example.com/api/auth/sso/corp/callback',
        scopes: ['openid', 'email'],
        state: 'the-state',
        nonce: 'the-nonce',
        codeChallenge: 'the-challenge',
      }),
    );
    assert.equal(url.searchParams.get('tenant'), 'a', 'existing query parameters survive');
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('client_id'), CLIENT_ID);
    assert.equal(url.searchParams.get('scope'), 'openid email');
    assert.equal(url.searchParams.get('state'), 'the-state');
    assert.equal(url.searchParams.get('nonce'), 'the-nonce');
    assert.equal(url.searchParams.get('code_challenge'), 'the-challenge');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  });

  it('accepts HTTPS issuers, and plain HTTP only on loopback when allowed', () => {
    assert.equal(issuerProblem('https://idp.example.com/realms/corp', false), null);
    assert.match(issuerProblem('http://idp.example.com', false) ?? '', /https/);
    assert.match(issuerProblem('http://idp.example.com', true) ?? '', /loopback/);
    assert.match(issuerProblem('http://127.0.0.1:8080', false) ?? '', /https/);
    assert.equal(issuerProblem('http://127.0.0.1:8080', true), null);
    assert.equal(issuerProblem('http://localhost:5556/dex', true), null);
    assert.match(issuerProblem('https://idp.example.com?x=1', false) ?? '', /query/);
    assert.match(issuerProblem('https://user:pw@idp.example.com', false) ?? '', /credentials/);
    assert.match(issuerProblem('ftp://idp.example.com', true) ?? '', /https/);
    assert.match(oidcUrlProblem('not a url', false) ?? '', /absolute/);
    assert.equal(isLoopbackHostname('[::1]'), true);
    assert.equal(isLoopbackHostname('localhost'), true);
    // Only the literals: no name a resolver could point elsewhere.
    assert.equal(isLoopbackHostname('app.localhost'), false);
    assert.equal(isLoopbackHostname('127.0.0.2'), false);
    assert.equal(isLoopbackHostname('10.0.0.1'), false);
    assert.match(issuerProblem('http://idp.localhost:5556', true) ?? '', /loopback/);
  });

  it('hashes an access token the way at_hash is defined for RS256 and ES256', () => {
    // The left half of SHA-256, base64url: 16 bytes, 22 characters.
    assert.match(accessTokenHash('access-token'), /^[A-Za-z0-9_-]{22}$/);
    assert.notEqual(accessTokenHash('access-token'), accessTokenHash('other-token'));
  });
});

for (const alg of ['RS256', 'ES256'] as const) {
  describe(`ID token validation (${alg})`, () => {
    let idp: MockOidcProvider;
    let client: OidcClient;
    let discovery: DiscoveryDocument;

    before(async () => {
      idp = createMockOidcProvider({ clientId: CLIENT_ID, clientSecret: 'secret', alg });
      await idp.start();
    });

    after(async () => {
      await idp.stop();
    });

    beforeEach(async () => {
      idp.discoveryOverrides = {};
      client = createOidcClient({ allowHttpLoopback: true });
      discovery = await client.discover(idp.issuer);
    });

    function claims(overrides: JWTPayload = {}): JWTPayload {
      const now = Math.floor(Date.now() / 1000);
      return {
        iss: idp.issuer,
        aud: CLIENT_ID,
        sub: 'subject-1',
        iat: now,
        exp: now + 300,
        nonce: NONCE,
        ...overrides,
      };
    }

    async function validate(token: string, accessToken: string | null = null) {
      return client.validateIdToken({
        idToken: token,
        discovery,
        clientId: CLIENT_ID,
        nonce: NONCE,
        accessToken,
      });
    }

    it('accepts a well-formed token and returns its claims', async () => {
      const verified = await validate(await idp.sign(claims({ email: 'a@example.test' })));
      assert.equal(verified.sub, 'subject-1');
      assert.equal(verified.email, 'a@example.test');
    });

    it('refuses alg none and HMAC algorithms, whatever the key set holds', async () => {
      await rejectsWith(validate(await idp.sign(claims(), 'none')), 'token_invalid');
      await rejectsWith(validate(await idp.sign(claims(), 'hs256')), 'token_invalid');
    });

    it('refuses a signature the provider key set cannot verify', async () => {
      await rejectsWith(validate(await idp.sign(claims(), 'foreign-key')), 'token_invalid');
    });

    it('refuses the wrong audience', async () => {
      const token = await idp.sign(claims({ aud: 'another-client' }));
      await rejectsWith(validate(token), 'token_invalid');
    });

    it('refuses several audiences unless azp names this client', async () => {
      const shared = claims({ aud: [CLIENT_ID, 'another-client'] });
      await rejectsWith(validate(await idp.sign(shared)), 'token_invalid', /azp/);
      const named = await validate(await idp.sign({ ...shared, azp: CLIENT_ID }));
      assert.equal(named.sub, 'subject-1');
      await rejectsWith(
        validate(await idp.sign(claims({ azp: 'another-client' }))),
        'token_invalid',
        /azp/,
      );
    });

    it('refuses the wrong issuer', async () => {
      await rejectsWith(
        validate(await idp.sign(claims({ iss: 'https://evil.example.com' }))),
        'token_invalid',
      );
    });

    it('refuses an expired token, allowing a minute of clock skew', async () => {
      const now = Math.floor(Date.now() / 1000);
      await rejectsWith(
        validate(await idp.sign(claims({ iat: now - 300, exp: now - 120 }))),
        'token_invalid',
      );
      const skewed = await validate(await idp.sign(claims({ iat: now - 300, exp: now - 30 })));
      assert.equal(skewed.sub, 'subject-1', 'thirty seconds past expiry is within the leeway');
    });

    it('refuses a token issued in the future, or longer ago than a sign-in lasts', async () => {
      const now = Math.floor(Date.now() / 1000);
      await rejectsWith(
        validate(await idp.sign(claims({ iat: now + 600, exp: now + 900 }))),
        'token_invalid',
      );
      await rejectsWith(
        validate(await idp.sign(claims({ iat: now - 3600, exp: now + 300 }))),
        'token_invalid',
      );
      const recent = await validate(await idp.sign(claims({ iat: now + 30 })));
      assert.equal(recent.sub, 'subject-1', 'thirty seconds ahead is within the leeway');
    });

    it('refuses a token that is not valid yet', async () => {
      const now = Math.floor(Date.now() / 1000);
      await rejectsWith(validate(await idp.sign(claims({ nbf: now + 600 }))), 'token_invalid');
    });

    it('refuses a nonce that is not this attempt’s, or none at all', async () => {
      await rejectsWith(
        validate(await idp.sign(claims({ nonce: 'someone-elses-nonce' }))),
        'token_invalid',
        /nonce/,
      );
      const { nonce: _nonce, ...withoutNonce } = claims();
      await rejectsWith(validate(await idp.sign(withoutNonce)), 'token_invalid', /nonce/);
    });

    it('requires a subject', async () => {
      const { sub: _sub, ...withoutSubject } = claims();
      await rejectsWith(validate(await idp.sign(withoutSubject)), 'token_invalid');
    });

    it('checks at_hash against the access token when both are present', async () => {
      const token = await idp.sign(claims({ at_hash: accessTokenHash('the-access-token') }));
      assert.equal((await validate(token, 'the-access-token')).sub, 'subject-1');
      await rejectsWith(validate(token, 'a-different-token'), 'token_invalid', /at_hash/);
    });

    it('picks up a rotated provider key, refetching at most once per cooldown', async () => {
      let clock = Date.now();
      const rotating = createOidcClient({ allowHttpLoopback: true, now: () => clock });
      const document = await rotating.discover(idp.issuer);
      const check = (token: string): ReturnType<OidcClient['validateIdToken']> =>
        rotating.validateIdToken({
          idToken: token,
          discovery: document,
          clientId: CLIENT_ID,
          nonce: NONCE,
          accessToken: null,
        });
      await check(await idp.sign(claims()));
      await idp.rotateKey();
      // Straight after a fetch, an unknown key id does not fetch again: a
      // stream of forged tokens must not become a stream of JWKS requests.
      await rejectsWith(check(await idp.sign(claims())), 'token_invalid');
      clock += 31_000;
      assert.equal((await check(await idp.sign(claims()))).sub, 'subject-1');
    });
  });
}

describe('discovery', () => {
  let idp: MockOidcProvider;

  before(async () => {
    idp = createMockOidcProvider({ clientId: CLIENT_ID, clientSecret: null });
    await idp.start();
  });

  after(async () => {
    await idp.stop();
  });

  beforeEach(() => {
    idp.discoveryOverrides = {};
    idp.discoveryFault = null;
  });

  it('refuses a plain-HTTP issuer unless loopback HTTP is explicitly allowed', async () => {
    await rejectsWith(
      createOidcClient({ allowHttpLoopback: false }).discover(idp.issuer),
      'provider_unavailable',
      /https/,
    );
  });

  it('pins the document to the configured issuer', async () => {
    idp.discoveryOverrides = { issuer: 'https://someone-else.example.com' };
    await rejectsWith(
      createOidcClient({ allowHttpLoopback: true }).discover(idp.issuer),
      'provider_unavailable',
      /issuer/,
    );
  });

  it('refuses a provider that advertises PKCE without S256', async () => {
    idp.discoveryOverrides = { code_challenge_methods_supported: ['plain'] };
    await rejectsWith(
      createOidcClient({ allowHttpLoopback: true }).discover(idp.issuer),
      'provider_unavailable',
      /S256/,
    );
  });

  it('refuses a provider that signs with none of the accepted algorithms', async () => {
    idp.discoveryOverrides = { id_token_signing_alg_values_supported: ['HS256', 'none'] };
    await rejectsWith(
      createOidcClient({ allowHttpLoopback: true }).discover(idp.issuer),
      'provider_unavailable',
      /RS256/,
    );
  });

  it('refuses an endpoint that downgrades to plain HTTP off loopback', async () => {
    idp.discoveryOverrides = { token_endpoint: 'http://idp.example.com/token' };
    await rejectsWith(
      createOidcClient({ allowHttpLoopback: true }).discover(idp.issuer),
      'provider_unavailable',
      /token_endpoint/,
    );
  });

  it('caches the document for its TTL', async () => {
    let clock = Date.now();
    const client = createOidcClient({ allowHttpLoopback: true, now: () => clock });
    const before = idp.metadataRequests.length;
    await client.discover(idp.issuer);
    await client.discover(idp.issuer);
    assert.equal(idp.metadataRequests.length, before + 1, 'the second read is cached');
    clock += 2 * 60 * 60 * 1000;
    await client.discover(idp.issuer);
    assert.equal(idp.metadataRequests.length, before + 2, 'an expired entry is fetched again');
  });

  it('refuses a redirect instead of following it', async () => {
    idp.discoveryFault = 'redirect';
    try {
      await rejectsWith(
        createOidcClient({ allowHttpLoopback: true }).discover(idp.issuer),
        'provider_unavailable',
        /request failed/,
      );
    } finally {
      idp.discoveryFault = null;
    }
  });

  it('refuses a response larger than 512 KiB', async () => {
    idp.discoveryFault = 'oversize';
    try {
      await rejectsWith(
        createOidcClient({ allowHttpLoopback: true }).discover(idp.issuer),
        'provider_unavailable',
        /too large/,
      );
    } finally {
      idp.discoveryFault = null;
    }
  });

  it('gives up on a provider that does not answer within the deadline', async () => {
    idp.discoveryFault = 'hang';
    try {
      const started = Date.now();
      await rejectsWith(
        createOidcClient({ allowHttpLoopback: true, timeoutMs: 200 }).discover(idp.issuer),
        'provider_unavailable',
        /timed out/,
      );
      assert.ok(Date.now() - started < 5_000, 'the deadline, not the socket, ended it');
    } finally {
      idp.discoveryFault = null;
    }
  });

  it('remembers a failure briefly, and shares one fetch between concurrent callers', async () => {
    let clock = Date.now();
    const client = createOidcClient({ allowHttpLoopback: true, now: () => clock });
    idp.discoveryFault = 'oversize';
    const before = idp.metadataRequests.length;
    try {
      await rejectsWith(client.discover(idp.issuer), 'provider_unavailable');
      await rejectsWith(client.discover(idp.issuer), 'provider_unavailable');
      assert.equal(idp.metadataRequests.length, before + 1, 'the second failure is cached');
    } finally {
      idp.discoveryFault = null;
    }
    clock += 31_000;
    const [a, b] = await Promise.all([client.discover(idp.issuer), client.discover(idp.issuer)]);
    assert.equal(a, b);
    assert.equal(idp.metadataRequests.length, before + 2, 'one request for both callers');
  });

  it('refuses a provider host that resolves to a private address', async () => {
    const client = createOidcClient({
      allowHttpLoopback: false,
      resolve: async () => [{ address: '10.0.0.7', family: 4 }],
    });
    await rejectsWith(
      client.discover('https://idp.corp.example'),
      'provider_unavailable',
      /non-public/,
    );
    const literal = createOidcClient({ allowHttpLoopback: false });
    await rejectsWith(
      literal.discover('https://192.168.1.10/realms/corp'),
      'provider_unavailable',
      /not a public address/,
    );
    // With private addresses allowed the request is made (and here fails on
    // the network instead).
    const allowed = createOidcClient({
      allowHttpLoopback: false,
      allowPrivateAddresses: true,
      timeoutMs: 200,
      fetch: async () => {
        throw new Error('network unreachable');
      },
    });
    await rejectsWith(
      allowed.discover('https://idp.corp.example'),
      'provider_unavailable',
      /request failed/,
    );
  });

  it('exchanges a code only with the PKCE verifier the challenge was made from', async () => {
    const client = createOidcClient({ allowHttpLoopback: true });
    const discovery = await client.discover(idp.issuer);
    const verifier = randomUrlToken();
    const request = (challenge: string): string =>
      authorizationUrl({
        discovery,
        clientId: CLIENT_ID,
        redirectUri: 'http://127.0.0.1/callback',
        scopes: ['openid'],
        state: 's',
        nonce: NONCE,
        codeChallenge: challenge,
      });

    const wrong = idp.authorize(request(pkceChallenge(verifier)), { sub: 'subject-1' });
    await rejectsWith(
      client.exchangeCode({
        discovery,
        clientId: CLIENT_ID,
        clientSecret: null,
        code: wrong.code,
        redirectUri: wrong.redirectUri,
        codeVerifier: randomUrlToken(),
      }),
      'provider_unavailable',
      /invalid_grant/,
    );

    const right = idp.authorize(request(pkceChallenge(verifier)), { sub: 'subject-1' });
    const tokens = await client.exchangeCode({
      discovery,
      clientId: CLIENT_ID,
      clientSecret: null,
      code: right.code,
      redirectUri: right.redirectUri,
      codeVerifier: verifier,
    });
    const verified = await client.validateIdToken({
      idToken: tokens.idToken,
      discovery,
      clientId: CLIENT_ID,
      nonce: NONCE,
      accessToken: tokens.accessToken,
    });
    assert.equal(verified.sub, 'subject-1');
    const sent = idp.tokenRequests.at(-1);
    assert.equal(sent?.form.get('code_verifier'), verifier);
    assert.equal(sent?.form.get('client_id'), CLIENT_ID, 'a public client names itself');

    // A code is single-use.
    await rejectsWith(
      client.exchangeCode({
        discovery,
        clientId: CLIENT_ID,
        clientSecret: null,
        code: right.code,
        redirectUri: right.redirectUri,
        codeVerifier: verifier,
      }),
      'provider_unavailable',
      /invalid_grant/,
    );
  });
});
