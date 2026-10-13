/**
 * The portal's Content-Security-Policy.
 *
 * Every response gets the strict base policy, which admits no third-party
 * origin at all. Only the SPA shell (`index.html`, the one document the browser
 * runs the app in) is widened, and only by the CAPTCHA vendor hosts that
 * document can actually need (issue #585):
 *
 * - the hosts of the provider that is **enabled** right now, for the sign-in
 *   and registration widgets; and
 * - every provider's hosts when the settings page (`/admin/settings`) is
 *   loaded by a signed-in, active `super_admin`, because the CAPTCHA
 *   activation self-test there renders a provider before it is enabled, and
 *   only a super admin can run it. Only that path pays for the session read:
 *   every other shell load stays free of auth lookups (#343).
 *
 * With CAPTCHA off, the shell an anonymous visitor gets lists no vendor host,
 * so an injection sink could not pull script or frames from one. That matters
 * for `https://www.google.com` in particular, whose script-src allowance is a
 * well-known CSP bypass gadget.
 *
 * `style-src 'unsafe-inline'` stays. The UI's Radix primitives inject `<style>`
 * elements at runtime: the scroll lock behind every Dialog, Select and
 * DropdownMenu writes one with computed widths, and Select's viewport renders
 * another. Neither can carry a hash, so dropping it needs per-response nonces
 * threaded into the shell and those libraries. Branding does **not** need it:
 * it sets custom properties through the CSSOM, which CSP does not govern.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  SESSION_COOKIE,
  type CaptchaProvider,
  type CaptchaPublicConfig,
} from '@ferrum-nexus/shared';

import type { NexusConfig } from '../config/index.js';
import type { NexusStore } from '../db/store.js';
import type { NexusCrypto } from '../lib/crypto.js';
import { sessionIsLive } from '../auth/session-lifetime.js';

/** A provider that has vendor hosts. */
export type CaptchaVendor = Exclude<CaptchaProvider, 'none'>;

/** The hosts one CAPTCHA vendor's widget loads script, frames and requests from. */
interface VendorSources {
  script: readonly string[];
  frame: readonly string[];
  connect: readonly string[];
}

/** Per-vendor CSP sources: what each widget needs, and nothing else. */
export const CAPTCHA_CSP_SOURCES: Readonly<Record<CaptchaVendor, VendorSources>> = {
  turnstile: {
    script: ['https://challenges.cloudflare.com'],
    frame: ['https://challenges.cloudflare.com'],
    connect: [],
  },
  hcaptcha: {
    script: ['https://hcaptcha.com', 'https://*.hcaptcha.com'],
    frame: ['https://hcaptcha.com', 'https://*.hcaptcha.com'],
    connect: ['https://hcaptcha.com', 'https://*.hcaptcha.com'],
  },
  recaptcha: {
    script: ['https://www.google.com', 'https://www.gstatic.com'],
    frame: ['https://www.google.com'],
    connect: [],
  },
};

/** Every vendor, in the order their hosts are emitted. */
export const CAPTCHA_VENDORS: readonly CaptchaVendor[] = ['turnstile', 'hcaptcha', 'recaptcha'];

function isCaptchaVendor(value: unknown): value is CaptchaVendor {
  return CAPTCHA_VENDORS.some((vendor) => vendor === value);
}

/**
 * The policy admitting `vendors`' hosts (none for the base policy).
 *
 * Vendors are emitted in a fixed order whatever the input order, so equal
 * sets always produce the same header.
 */
export function contentSecurityPolicy(vendors: Iterable<CaptchaVendor> = []): string {
  const wanted = new Set(vendors);
  const pick = (kind: keyof VendorSources): string[] => {
    const sources: string[] = [];
    for (const vendor of CAPTCHA_VENDORS) {
      if (wanted.has(vendor)) sources.push(...CAPTCHA_CSP_SOURCES[vendor][kind]);
    }
    return sources;
  };
  const directives: Array<[string, string[]]> = [
    ['default-src', ["'self'"]],
    ['base-uri', ["'self'"]],
    ['script-src', ["'self'", ...pick('script')]],
    ['script-src-attr', ["'none'"]],
    ['frame-src', ["'self'", ...pick('frame')]],
    ['connect-src', ["'self'", ...pick('connect')]],
    ['style-src', ["'self'", "'unsafe-inline'"]],
    ['img-src', ["'self'", 'data:']],
    ['font-src', ["'self'", 'data:']],
    ['object-src', ["'none'"]],
    ['form-action', ["'self'"]],
    ['frame-ancestors', ["'none'"]],
  ];
  return directives.map(([name, values]) => `${name} ${values.join(' ')}`).join(';');
}

/** The policy every response carries unless it is the SPA shell. */
export const BASE_CONTENT_SECURITY_POLICY = contentSecurityPolicy();

/** What {@link registerContentSecurityPolicy} needs. */
export interface ContentSecurityPolicyOptions {
  config: NexusConfig;
  store: NexusStore;
  crypto: NexusCrypto;
  /** `CaptchaService.getPublicConfig`: whether CAPTCHA is on, and which provider. */
  captchaPublicConfig: () => Promise<CaptchaPublicConfig>;
}

/**
 * Whether the request carries the cookie of a live session whose account is
 * an active `super_admin`.
 *
 * Read-only on purpose: the shell is not under `/api`, so the auth plugin has
 * not resolved the session, and this check must neither slide nor delete it.
 */
async function requestIsSuperAdmin(
  request: FastifyRequest,
  options: ContentSecurityPolicyOptions,
): Promise<boolean> {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) return false;
  const session = await options.store.sessions.findByTokenHash(options.crypto.hashToken(token));
  if (!session || !sessionIsLive(session, options.config, Date.now())) return false;
  const user = await options.store.users.findById(session.user_id);
  return user !== null && user.status === 'active' && user.role === 'super_admin';
}

/** The SPA path that renders the CAPTCHA activation self-test. */
export const CAPTCHA_SELF_TEST_PATH = '/admin/settings';

/**
 * Whether this shell request is for the settings page, the only page whose
 * policy may depend on who is signed in.
 */
function isSettingsShell(request: FastifyRequest): boolean {
  const path = request.url.split('?')[0] ?? '';
  return path === CAPTCHA_SELF_TEST_PATH || path.startsWith(`${CAPTCHA_SELF_TEST_PATH}/`);
}

/** Requests the SPA fallback answered with the shell; see {@link markSpaShell}. */
const spaShellRequests = new WeakSet<object>();

/**
 * Mark `request` as answered with the SPA shell. The fallback calls this, so
 * the shell is recognised by what serves it rather than by its `Content-Type`,
 * which a `304` revalidation does not carry (and whose headers a browser
 * merges into the cached document).
 */
export function markSpaShell(request: FastifyRequest): void {
  spaShellRequests.add(request.raw);
}

/** Whether this response is the SPA shell, a `304` revalidation of it included. */
function isShellResponse(request: FastifyRequest, reply: FastifyReply): boolean {
  if (spaShellRequests.has(request.raw)) return true;
  // `/index.html` is also a static file `@fastify/static` serves directly. Match
  // the route Fastify selected, so every spelling that reaches it counts.
  if (request.routeOptions.url === '/index.html') return true;
  const type = reply.getHeader('content-type');
  return typeof type === 'string' && type.toLowerCase().startsWith('text/html');
}

/** Add `Cookie` to the response's `Vary`, keeping whatever is already there. */
function varyOnCookie(reply: FastifyReply): void {
  const existing = reply.getHeader('vary');
  const current = Array.isArray(existing) ? existing.join(', ') : String(existing ?? '');
  const names: string[] = [];
  for (const part of current.split(',')) {
    const name = part.trim();
    if (name === '*' || name.toLowerCase() === 'cookie') return;
    if (name !== '') names.push(name);
  }
  reply.header('vary', [...names, 'Cookie'].join(', '));
}

/**
 * Set the base policy on every response, and widen it on the SPA shell.
 *
 * Register after `@fastify/cookie` (the shell check reads the session cookie)
 * and with helmet's own `contentSecurityPolicy` turned off.
 */
export function registerContentSecurityPolicy(
  app: FastifyInstance,
  options: ContentSecurityPolicyOptions,
): void {
  // Read on every shell response, never cached: a shell served with a policy
  // older than the CAPTCHA settings would block the very widget the sign-in
  // form is about to require, and nothing on the page could repair it. It is
  // the same two point reads `GET /api/auth/captcha` makes, which the shell
  // triggers on every sign-in page anyway.
  async function enabledVendor(): Promise<CaptchaVendor | null> {
    const captcha = await options.captchaPublicConfig();
    const provider = captcha.enabled ? captcha.provider : null;
    return isCaptchaVendor(provider) ? provider : null;
  }

  // Before any handler runs, on the raw response, the way helmet sets its
  // headers: every reply carries it, errors and hijacked replies included.
  app.addHook('onRequest', async (_request, reply) => {
    reply.raw.setHeader('content-security-policy', BASE_CONTENT_SECURITY_POLICY);
  });

  app.addHook('onSend', async (request, reply, payload) => {
    if (!isShellResponse(request, reply)) return payload;
    const vendors = new Set<CaptchaVendor>();
    let superAdmin = false;
    try {
      const enabled = await enabledVendor();
      if (enabled !== null) vendors.add(enabled);
      if (isSettingsShell(request)) superAdmin = await requestIsSuperAdmin(request, options);
    } catch (error) {
      // Fail closed: the base policy already on the reply stands, which costs
      // at most a CAPTCHA widget that does not load until the next page load.
      request.log.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'Could not resolve the CAPTCHA hosts for the Content-Security-Policy',
      );
      return payload;
    }
    if (superAdmin) {
      for (const vendor of CAPTCHA_VENDORS) vendors.add(vendor);
      // This shell's policy depends on who asked for it; a shared cache must
      // not hand the wider one to anybody else.
      varyOnCookie(reply);
      reply.header('cache-control', 'private, no-cache');
    }
    if (vendors.size > 0) reply.header('content-security-policy', contentSecurityPolicy(vendors));
    return payload;
  });
}
