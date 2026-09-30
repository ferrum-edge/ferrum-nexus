/**
 * Single sign-on through a **real OpenID Connect provider** (issue #445).
 *
 * The server's own tests drive the SSO flow against a mock provider they
 * control. This suite signs in through Dex, a standards-compliant provider
 * nobody here wrote, and the packaged portal: the portal's
 * `/api/auth/sso/dex/start` redirect, Dex's real login form, Dex's redirect
 * back, and the portal's callback, followed hop by hop with an HTTP client
 * that carries cookies the way a browser does. Nothing is stubbed.
 *
 * What a green run proves:
 *
 * - **PKCE.** The authorization request carries an `S256` challenge, and Dex
 *   redeems a code issued against a challenge only with the matching
 *   verifier, so a completed sign-in means the portal sent the right one.
 * - **Nonce.** The request's `nonce` round-trips through Dex into the ID
 *   token the portal accepts. That the portal refuses a token whose nonce does
 *   not match is covered by `server/src/sso/oidc.test.ts`, not here: a real
 *   provider always echoes the nonce it was sent.
 * - **State.** A callback whose `state` is not the one sealed in the
 *   attempt's `nexus_sso` cookie is refused before its code is redeemed, and
 *   the attempt is spent either way.
 * - **Claims.** Dex's `groups` claim maps to the `provider` role; a user in no
 *   mapped group gets the provider's default role, `client`.
 *
 * How the stack is configured, and why (e2e/docker-compose.yml):
 *
 * - The issuer is `http://127.0.0.1:<DEX_PORT>/dex`: plain HTTP on a literal
 *   loopback host, the "provider on the same machine" setup that
 *   `NEXUS_OIDC_ALLOW_HTTP_LOOPBACK=true` exists for. Without that flag the
 *   portal refuses any issuer that is not HTTPS. A self-signed HTTPS Dex would
 *   need a CA injected into both the portal image and this runner, and would
 *   test certificate plumbing rather than the protocol.
 * - The portal runs in Dex's network namespace, so `127.0.0.1` is Dex for the
 *   portal's back-channel calls (discovery, key set, token endpoint) exactly
 *   as it is for this runner's front-channel ones.
 * - `NEXUS_OIDC_ALLOW_PRIVATE_ADDRESSES` stays `false`. The loopback flag
 *   already exempts the literal loopback hosts from the public-address check,
 *   so a pass here also shows a local provider needs nothing broader.
 *
 * Run it with `./e2e/run.sh sso` (or as part of `./e2e/run.sh`).
 */

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import { PORTAL_URL, waitFor, waitForStack } from './harness.js';

/** The provider as `NEXUS_OIDC_PROVIDERS` declares it in the compose file. */
const PROVIDER_ID = 'dex';
const CLIENT_ID = 'ferrum-nexus-e2e';
const DEX_ISSUER = process.env.E2E_DEX_ISSUER ?? 'http://127.0.0.1:5556/dex';
const CALLBACK_URL = `${PORTAL_URL}/api/auth/sso/${PROVIDER_ID}/callback`;

/** Where the portal sends a browser whose callback did not match its attempt. */
const INVALID_STATE_URL = `${PORTAL_URL}/login?sso_error=invalid_state`;

/** The static Dex users (e2e/dex/config.yaml). */
interface DexUser {
  email: string;
  password: string;
}
const PROVIDER_USER: DexUser = { email: 'sso-provider@example.test', password: 'password' };
const CLIENT_USER: DexUser = { email: 'sso-client@example.test', password: 'password' };

/** Cookie names the portal uses (shared/src/constants.ts, shared/src/sso.ts). */
const SESSION_COOKIE = 'nexus_session';
const CSRF_COOKIE = 'nexus_csrf';
const SSO_COOKIE = 'nexus_sso';

/** Deadline of each HTTP request, and the most redirects one leg may take. */
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 10;

/** Deadline of each case: a handful of requests against local services. */
const CASE_TIMEOUT_MS = 90_000;

/* ── A browser without the browser ─────────────────────────────────────── */

interface StoredCookie {
  value: string;
  path: string;
}

/**
 * An HTTP client that keeps cookies and never follows a redirect by itself.
 *
 * Cookies are kept per host, not per port — as a browser keeps them — and
 * sent on a request whose path is within the cookie's `Path`. A cookie the
 * server expires is dropped. Redirects are the caller's to follow, so every
 * hop can be looked at on the way through.
 */
class Browser {
  private readonly jar = new Map<string, Map<string, StoredCookie>>();

  async request(
    url: URL,
    options: { method?: 'GET' | 'POST'; form?: Record<string, string> } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { accept: 'text/html,application/json' };
    const cookie = this.cookieHeader(url);
    if (cookie !== '') headers.cookie = cookie;
    let body: string | undefined;
    if (options.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(options.form).toString();
    }
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    this.remember(url, response);
    return response;
  }

  /** The value of cookie `name` as it would be sent to `url`, if any. */
  cookie(url: URL, name: string): string | undefined {
    const stored = this.jar.get(url.hostname)?.get(name);
    return stored && pathMatches(url.pathname, stored.path) ? stored.value : undefined;
  }

  private cookieHeader(url: URL): string {
    const cookies = this.jar.get(url.hostname) ?? new Map<string, StoredCookie>();
    return [...cookies]
      .filter(([, stored]) => pathMatches(url.pathname, stored.path))
      .map(([name, stored]) => `${name}=${stored.value}`)
      .join('; ');
  }

  private remember(url: URL, response: Response): void {
    let cookies = this.jar.get(url.hostname);
    if (!cookies) {
      cookies = new Map();
      this.jar.set(url.hostname, cookies);
    }
    for (const line of response.headers.getSetCookie()) {
      const [pair = '', ...attributes] = line.split(';').map((part) => part.trim());
      const index = pair.indexOf('=');
      if (index <= 0) continue;
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      let path = defaultPath(url.pathname);
      let expired = value === '';
      for (const attribute of attributes) {
        const [key = '', ...rest] = attribute.split('=');
        const setting = rest.join('=');
        switch (key.toLowerCase()) {
          case 'path':
            if (setting.startsWith('/')) path = setting;
            break;
          case 'max-age':
            if (Number(setting) <= 0) expired = true;
            break;
          case 'expires':
            if (Date.parse(setting) <= Date.now()) expired = true;
            break;
        }
      }
      if (expired) cookies.delete(name);
      else cookies.set(name, { value, path });
    }
  }
}

/** RFC 6265 §5.1.4: the directory of the request path. */
function defaultPath(requestPath: string): string {
  const slash = requestPath.lastIndexOf('/');
  return slash <= 0 ? '/' : requestPath.slice(0, slash);
}

/** RFC 6265 §5.1.4 path-match. */
function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath.charAt(cookiePath.length) === '/';
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** Where a redirect points, resolved against the URL that answered it. */
function redirectTarget(response: Response, from: URL): URL {
  const location = response.headers.get('location');
  if (location === null) {
    throw new Error(`${from.href} answered ${response.status} with no Location`);
  }
  return new URL(location, from);
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** The character references Go's `html/template` puts in an attribute. */
function decodeHtmlAttribute(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith('#x')) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    if (lower.startsWith('#')) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
    return NAMED_ENTITIES[lower] ?? '';
  });
}

/** The discovery fields this suite reads. */
interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  code_challenge_methods_supported?: string[];
}

/** Dex's discovery document, straight from Dex. */
async function dexDiscovery(): Promise<Discovery> {
  const response = await fetch(`${DEX_ISSUER}/.well-known/openid-configuration`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Dex discovery answered ${response.status}`);
  return (await response.json()) as Discovery;
}

/* ── The flow ──────────────────────────────────────────────────────────── */

/** One sign-in, up to the moment Dex sends the browser back to the portal. */
interface Authorized {
  /** The authorization request the portal redirected to. */
  authorization: URL;
  /** Where Dex redirected afterwards: the portal's callback, not yet visited. */
  callback: URL;
}

/**
 * Start a sign-in at the portal and complete it at Dex, as a browser would:
 * follow the portal's redirect to Dex, follow Dex's redirects to its login
 * form, submit the form, and follow Dex until it points back at the portal.
 * Stops there, so a caller can inspect — or tamper with — the callback.
 */
async function authorizeAtDex(browser: Browser, user: DexUser): Promise<Authorized> {
  const start = new URL(`${PORTAL_URL}/api/auth/sso/${PROVIDER_ID}/start?return_to=/catalog`);
  const started = await browser.request(start);
  assert.equal(started.status, 302, `${start.href} answered ${started.status}`);
  const authorization = redirectTarget(started, start);
  assert.equal(
    authorization.searchParams.get('sso_error'),
    null,
    `the portal refused to start: ${authorization.href}`,
  );
  assert.ok(
    browser.cookie(new URL(CALLBACK_URL), SSO_COOKIE),
    'the portal sealed the attempt in the nexus_sso cookie, scoped to the callback',
  );

  // Dex's authorization endpoint picks the only connector, which starts an
  // auth request and redirects to its password form.
  let url = authorization;
  let response = await browser.request(url);
  for (let hop = 0; isRedirect(response.status); hop += 1) {
    if (hop >= MAX_REDIRECTS) throw new Error(`Dex redirected more than ${MAX_REDIRECTS} times`);
    url = redirectTarget(response, url);
    assert.equal(url.origin, authorization.origin, `Dex redirected off-site to ${url.href}`);
    response = await browser.request(url);
  }
  assert.equal(response.status, 200, `Dex answered ${response.status} at ${url.href}`);
  const html = await response.text();

  // The form as Dex rendered it: its action, and the two fields it posts.
  const action = /<form\b[^>]*\baction="([^"]*)"/i.exec(html)?.[1];
  assert.ok(action !== undefined, `Dex served no login form at ${url.href}`);
  for (const field of ['login', 'password']) {
    assert.match(html, new RegExp(`<input\\b[^>]*\\bname="${field}"`), `no ${field} field`);
  }
  url = new URL(decodeHtmlAttribute(action), url);
  response = await browser.request(url, {
    method: 'POST',
    form: { login: user.email, password: user.password },
  });

  // With the approval screen skipped, Dex answers the login with the code
  // response; allow for intermediate hops all the same.
  for (let hop = 0; hop < MAX_REDIRECTS; hop += 1) {
    if (!isRedirect(response.status)) {
      throw new Error(`Dex answered the login for ${user.email} with ${response.status}`);
    }
    const next = redirectTarget(response, url);
    if (next.origin === new URL(PORTAL_URL).origin) return { authorization, callback: next };
    assert.equal(next.origin, authorization.origin, `Dex redirected off-site to ${next.href}`);
    url = next;
    response = await browser.request(url);
  }
  throw new Error(`Dex redirected more than ${MAX_REDIRECTS} times after the login`);
}

/** What `GET /api/auth/me` answers. */
interface Me {
  user: { id: string; email: string; role: string; status: string; email_verified: boolean };
  csrf_token: string;
}

/** What `GET /api/users/me/identities` answers. */
interface Identities {
  items: { provider_id: string; issuer: string; subject: string; email: string | null }[];
}

/** Read `path` from the portal as `browser`'s session. */
async function portalAs<T>(browser: Browser, path: string): Promise<T> {
  const url = new URL(`${PORTAL_URL}${path}`);
  const response = await browser.request(url);
  const text = await response.text();
  assert.equal(response.status, 200, `GET ${path} answered ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

/**
 * Sign `user` in through Dex from a fresh browser, and check the callback
 * opened a portal session.
 */
async function signInThroughDex(user: DexUser): Promise<{ browser: Browser; me: Me }> {
  const browser = new Browser();
  const { callback } = await authorizeAtDex(browser, user);
  const finished = await browser.request(callback);
  assert.equal(finished.status, 302, `the callback answered ${finished.status}`);
  const landing = redirectTarget(finished, callback);
  assert.equal(landing.href, `${PORTAL_URL}/catalog`, `the callback sent us to ${landing.href}`);

  const portal = new URL(PORTAL_URL);
  assert.ok(browser.cookie(portal, SESSION_COOKIE), 'the callback set a session cookie');
  const csrf = browser.cookie(portal, CSRF_COOKIE);
  assert.ok(csrf, 'the callback set a CSRF cookie');
  assert.equal(browser.cookie(callback, SSO_COOKIE), undefined, 'the attempt was spent');

  const me = await portalAs<Me>(browser, '/api/auth/me');
  assert.equal(me.csrf_token, csrf, 'the session is the one the cookies name');
  return { browser, me };
}

describe('single sign-on through a real Dex', { concurrency: false }, () => {
  before(async () => {
    await waitForStack();
    // The portal caches a failed discovery for 30 s, so do not let the first
    // sign-in be the thing that finds out Dex is still starting.
    await waitFor(`Dex to publish discovery for ${DEX_ISSUER}`, async () => {
      return (await dexDiscovery()).issuer === DEX_ISSUER;
    });
    await waitFor('the portal to offer Dex on its sign-in page', async () => {
      const response = await fetch(`${PORTAL_URL}/api/auth/sso`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) return false;
      const body = (await response.json()) as { providers?: { id: string }[] };
      return (body.providers ?? []).some((provider) => provider.id === PROVIDER_ID);
    });
  });

  it(
    'sends the browser to Dex with PKCE (S256), state and nonce',
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const discovery = await dexDiscovery();
      assert.ok(discovery.code_challenge_methods_supported?.includes('S256'));

      const { authorization, callback } = await authorizeAtDex(new Browser(), PROVIDER_USER);
      const endpoint = new URL(discovery.authorization_endpoint);
      assert.equal(`${authorization.origin}${authorization.pathname}`, endpoint.href);
      const query = authorization.searchParams;
      assert.equal(query.get('response_type'), 'code');
      assert.equal(query.get('client_id'), CLIENT_ID);
      assert.equal(query.get('redirect_uri'), CALLBACK_URL);
      const scopes = query.get('scope')?.split(' ').sort();
      assert.deepEqual(scopes, ['email', 'groups', 'openid', 'profile']);
      assert.equal(query.get('code_challenge_method'), 'S256');
      // 32 random bytes each, base64url: nothing guessable.
      assert.match(query.get('code_challenge') ?? '', /^[A-Za-z0-9_-]{43}$/);
      assert.match(query.get('state') ?? '', /^[A-Za-z0-9_-]{43,}$/);
      assert.match(query.get('nonce') ?? '', /^[A-Za-z0-9_-]{43,}$/);
      assert.notEqual(query.get('state'), query.get('nonce'));

      // Dex came back to the registered callback with a code and the state.
      assert.equal(`${callback.origin}${callback.pathname}`, CALLBACK_URL);
      assert.ok(callback.searchParams.get('code'), 'Dex returned an authorization code');
      assert.equal(callback.searchParams.get('state'), query.get('state'));
    },
  );

  it(
    'signs a Dex user in with the role its groups map to, and keeps them on one account',
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const first = await signInThroughDex(PROVIDER_USER);
      assert.equal(first.me.user.email, PROVIDER_USER.email);
      assert.equal(first.me.user.role, 'provider', 'groups: [nexus-providers] maps to provider');
      assert.equal(first.me.user.status, 'active');
      assert.equal(first.me.user.email_verified, true);

      const identities = await portalAs<Identities>(first.browser, '/api/users/me/identities');
      const links = identities.items.filter((identity) => identity.provider_id === PROVIDER_ID);
      assert.equal(links.length, 1, 'the account is linked to exactly one Dex subject');
      assert.equal(links[0]?.issuer, DEX_ISSUER);
      assert.equal(links[0]?.email, PROVIDER_USER.email);

      // A second sign-in, from another browser, is matched by the linked
      // subject and opens the same account.
      const second = await signInThroughDex(PROVIDER_USER);
      assert.equal(second.me.user.id, first.me.user.id);
      assert.equal(second.me.user.role, 'provider');
    },
  );

  it(
    'gives a Dex user in no mapped group the default role',
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const { me } = await signInThroughDex(CLIENT_USER);
      assert.equal(me.user.email, CLIENT_USER.email);
      assert.equal(me.user.role, 'client');
    },
  );

  it(
    'refuses a callback whose state was tampered with, and spends the attempt',
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const browser = new Browser();
      const { callback } = await authorizeAtDex(browser, PROVIDER_USER);
      const state = callback.searchParams.get('state') ?? '';
      assert.ok(state.length > 0);

      // Same length and alphabet, one character different: a mismatch, not a
      // malformed request.
      const tampered = new URL(callback);
      const last = state.charAt(state.length - 1);
      tampered.searchParams.set('state', `${state.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`);
      const refused = await browser.request(tampered);
      assert.equal(refused.status, 302);
      assert.equal(redirectTarget(refused, tampered).href, INVALID_STATE_URL);
      assert.equal(browser.cookie(new URL(PORTAL_URL), SESSION_COOKIE), undefined);
      assert.equal(browser.cookie(callback, SSO_COOKIE), undefined, 'the attempt was spent');

      // The genuine callback cannot be replayed afterwards: the attempt it
      // belonged to is gone, and its code was never redeemed.
      const replayed = await browser.request(callback);
      assert.equal(replayed.status, 302);
      assert.equal(redirectTarget(replayed, callback).href, INVALID_STATE_URL);
      assert.equal(browser.cookie(new URL(PORTAL_URL), SESSION_COOKIE), undefined);

      const me = await browser.request(new URL(`${PORTAL_URL}/api/auth/me`));
      assert.equal(me.status, 401, 'no portal session was opened');
    },
  );
});
