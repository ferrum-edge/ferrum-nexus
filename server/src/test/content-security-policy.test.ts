/**
 * Issue #585: the Content-Security-Policy admits a CAPTCHA vendor's hosts only
 * on the SPA shell, and only for the provider that is enabled — or for every
 * provider on a shell a signed-in super admin loads, for the activation
 * self-test. Every other response carries the strict base policy.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { CAPTCHA_SECRET_SETTINGS_KEY, CAPTCHA_SETTINGS_KEY } from '../auth/captcha.js';
import {
  BASE_CONTENT_SECURITY_POLICY,
  CAPTCHA_CSP_SOURCES,
  CAPTCHA_VENDORS,
  contentSecurityPolicy,
  type CaptchaVendor,
} from '../middleware/content-security-policy.js';
import { buildTestApp, type TestApp, type TestSession } from './helpers.js';

const SPA = '<!doctype html><title>Nexus CSP shell</title>';

function hostsOf(vendor: CaptchaVendor): string[] {
  const sources = CAPTCHA_CSP_SOURCES[vendor];
  return [...sources.script, ...sources.frame, ...sources.connect];
}

/** Every host any vendor contributes. */
const ALL_VENDOR_HOSTS = [...new Set(CAPTCHA_VENDORS.flatMap(hostsOf))];

/** The directive `name` of `policy`, as its list of sources. */
function directive(policy: string, name: string): string[] {
  for (const part of policy.split(';')) {
    const [key, ...values] = part.trim().split(/\s+/);
    if (key === name) return values;
  }
  assert.fail(`${name} is missing from ${policy}`);
}

function assertAdmitsOnly(policy: string, vendors: readonly CaptchaVendor[]): void {
  const admitted = new Set(vendors.flatMap(hostsOf));
  const listed = [
    ...directive(policy, 'script-src'),
    ...directive(policy, 'frame-src'),
    ...directive(policy, 'connect-src'),
  ];
  for (const host of ALL_VENDOR_HOSTS) {
    assert.equal(listed.includes(host), admitted.has(host), `${host} in ${policy}`);
  }
}

describe('contentSecurityPolicy', () => {
  it('lists no vendor host in the base policy', () => {
    assertAdmitsOnly(BASE_CONTENT_SECURITY_POLICY, []);
    assert.deepEqual(directive(BASE_CONTENT_SECURITY_POLICY, 'script-src'), ["'self'"]);
    assert.deepEqual(directive(BASE_CONTENT_SECURITY_POLICY, 'frame-ancestors'), ["'none'"]);
    assert.deepEqual(directive(BASE_CONTENT_SECURITY_POLICY, 'object-src'), ["'none'"]);
    assert.deepEqual(directive(BASE_CONTENT_SECURITY_POLICY, 'script-src-attr'), ["'none'"]);
  });

  for (const vendor of CAPTCHA_VENDORS) {
    it(`adds only ${vendor}'s own hosts`, () => {
      assertAdmitsOnly(contentSecurityPolicy([vendor]), [vendor]);
    });
  }

  it('emits the same header whatever the input order', () => {
    assert.equal(
      contentSecurityPolicy(['recaptcha', 'turnstile']),
      contentSecurityPolicy(['turnstile', 'recaptcha']),
    );
  });
});

describe('Content-Security-Policy on responses', () => {
  let webDist: string;

  before(async () => {
    webDist = await mkdtemp(join(tmpdir(), 'nexus-csp-'));
    await writeFile(join(webDist, 'index.html'), SPA);
  });

  after(async () => {
    if (webDist) await rm(webDist, { recursive: true, force: true });
  });

  async function portal(): Promise<TestApp> {
    return buildTestApp({ env: { NEXUS_WEB_DIST: webDist }, deps: { serveStatic: true } });
  }

  async function shellPolicy(
    harness: TestApp,
    session?: TestSession,
    url = '/catalog',
  ): Promise<string> {
    const response = await harness.app.inject({
      method: 'GET',
      url,
      headers: session ? { cookie: session.cookieHeader } : {},
    });
    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers['content-type']), /^text\/html/);
    const policy = response.headers['content-security-policy'];
    assert.equal(typeof policy, 'string');
    return policy as string;
  }

  async function enableCaptcha(harness: TestApp, provider: CaptchaVendor): Promise<void> {
    await harness.store.settings.set(CAPTCHA_SETTINGS_KEY, {
      enabled: true,
      provider,
      site_key: 'test-site-key',
    });
    await harness.store.settings.set(CAPTCHA_SECRET_SETTINGS_KEY, 'test-secret-key');
  }

  it('gives an anonymous shell no vendor host while CAPTCHA is off', async (t) => {
    const harness = await portal();
    t.after(() => harness.close());
    assert.equal(await shellPolicy(harness), BASE_CONTENT_SECURITY_POLICY);

    const api = await harness.app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(api.headers['content-security-policy'], BASE_CONTENT_SECURITY_POLICY);
    const missing = await harness.app.inject({ method: 'GET', url: '/api/nope' });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.headers['content-security-policy'], BASE_CONTENT_SECURITY_POLICY);
  });

  it("admits only the enabled provider, and all on a super admin's settings page", async (t) => {
    const harness = await portal();
    t.after(() => harness.close());
    // Accounts first: once CAPTCHA is on, registration needs a solved challenge.
    const superAdmin = await harness.registerUser();
    assert.equal(superAdmin.user.role, 'super_admin');
    const admin = await harness.registerUser();
    await harness.store.users.update(admin.user.id, { role: 'admin' });
    const client = await harness.registerUser();
    await enableCaptcha(harness, 'hcaptcha');

    const anonymous = await shellPolicy(harness);
    assertAdmitsOnly(anonymous, ['hcaptcha']);
    assertAdmitsOnly(await shellPolicy(harness, client), ['hcaptcha']);
    assertAdmitsOnly(await shellPolicy(harness, admin), ['hcaptcha']);
    assertAdmitsOnly(await shellPolicy(harness, admin, '/admin/settings'), ['hcaptcha']);
    // Only the settings page, where the self-test lives, is widened (#343 keeps
    // every other shell load free of session reads).
    assertAdmitsOnly(await shellPolicy(harness, superAdmin), ['hcaptcha']);

    const elevated = await harness.app.inject({
      method: 'GET',
      url: '/admin/settings?tab=captcha',
      headers: { cookie: superAdmin.cookieHeader },
    });
    assert.equal(elevated.statusCode, 200);
    assertAdmitsOnly(String(elevated.headers['content-security-policy']), [...CAPTCHA_VENDORS]);
    assert.match(String(elevated.headers.vary), /cookie/i);
    assert.match(String(elevated.headers['cache-control']), /private/);

    // The API is never widened, whoever asks.
    const api = await harness.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: superAdmin.cookieHeader },
    });
    assert.equal(api.headers['content-security-policy'], BASE_CONTENT_SECURITY_POLICY);
  });

  it('follows a CAPTCHA settings change on the very next shell', async (t) => {
    const harness = await portal();
    t.after(() => harness.close());
    // Warm whatever the shell reads, with CAPTCHA off.
    assert.equal(await shellPolicy(harness), BASE_CONTENT_SECURITY_POLICY);
    await enableCaptcha(harness, 'hcaptcha');
    assertAdmitsOnly(await shellPolicy(harness), ['hcaptcha']);
    // A provider switch is just as immediate.
    await enableCaptcha(harness, 'turnstile');
    assertAdmitsOnly(await shellPolicy(harness), ['turnstile']);
  });

  it('keeps the vendor sources on a 304 revalidation of the shell', async (t) => {
    const harness = await portal();
    t.after(() => harness.close());
    await enableCaptcha(harness, 'recaptcha');
    for (const url of ['/index.html', '/catalog']) {
      const first = await harness.app.inject({ method: 'GET', url });
      assert.equal(first.statusCode, 200, url);
      const etag = first.headers.etag;
      assert.ok(typeof etag === 'string', `${url} carries an ETag`);
      const revalidated = await harness.app.inject({
        method: 'GET',
        url,
        headers: { 'if-none-match': etag },
      });
      assert.equal(revalidated.statusCode, 304, url);
      assertAdmitsOnly(String(revalidated.headers['content-security-policy']), ['recaptcha']);
    }
  });

  it('does not widen the shell for a disabled super admin', async (t) => {
    const harness = await portal();
    t.after(() => harness.close());
    const superAdmin = await harness.registerUser();
    await harness.store.users.update(superAdmin.user.id, { status: 'disabled' });
    assert.equal(
      await shellPolicy(harness, superAdmin, '/admin/settings'),
      BASE_CONTENT_SECURITY_POLICY,
    );
  });
});
