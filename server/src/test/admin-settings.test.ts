import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type {
  AdminSettingsResponse,
  ApiErrorBody,
  BrandingResponse,
  GetEmailTemplateResponse,
  ListAuditLogsResponse,
  SmtpTestResponse,
  UpdateEmailTemplateResponse,
} from '@ferrum-nexus/shared';

import { SMTP_PASSWORD_SETTINGS_KEY } from '../admin/settings-service.js';
import { CAPTCHA_SECRET_SETTINGS_KEY } from '../auth/captcha.js';
import { buildTestApp, type TestApp, type TestSession } from './helpers.js';

const SMTP_PASSWORD = 'hunter2-but-longer';
const CAPTCHA_SECRET = 'turnstile-secret-value';

function errorCode(body: string): string {
  return (JSON.parse(body) as ApiErrorBody).error.code;
}

describe('admin settings', () => {
  let harness: TestApp;
  let founder: TestSession;
  let client: TestSession;

  before(async () => {
    harness = await buildTestApp();
    founder = await harness.registerUser({ email: 'founder@example.test' });
    client = await harness.registerUser({ email: 'client@example.test' });
  });

  after(async () => {
    await harness.close();
  });

  it('serves public branding without a session', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/api/branding' });
    assert.equal(response.statusCode, 200);
    const body = response.json<BrandingResponse>();
    assert.equal(body.portal_name, 'Ferrum Nexus');
    assert.equal(body.default_theme, 'dark');
    assert.equal(body.captcha.enabled, false);
    assert.equal(body.captcha.site_key, null);
  });

  it('keeps the settings API behind the admin role', async () => {
    const response = await harness.authed(client, { method: 'GET', url: '/api/admin/settings' });
    assert.equal(response.statusCode, 403);
    assert.equal(errorCode(response.body), 'FORBIDDEN');
  });

  describe('mail and CAPTCHA are super_admin-only', () => {
    let admin: TestSession;

    before(async () => {
      const account = await harness.registerUser({ email: 'plain-admin@example.test' });
      const promoted = await harness.authed(founder, {
        method: 'PATCH',
        url: `/api/users/${account.user.id}`,
        payload: { role: 'admin' },
      });
      assert.equal(promoted.statusCode, 200, promoted.body);
      admin = await harness.loginUser('plain-admin@example.test');
      assert.equal(admin.user.role, 'admin');
    });

    it('refuses an ordinary admin repointing SMTP', async () => {
      const response = await harness.authed(admin, {
        method: 'PUT',
        url: '/api/admin/settings',
        payload: { smtp: { host: 'smtp.attacker.test', username: 'me' } },
      });
      assert.equal(response.statusCode, 403);
      assert.equal(errorCode(response.body), 'FORBIDDEN');

      const settings = await harness.authed(founder, {
        method: 'GET',
        url: '/api/admin/settings',
      });
      assert.notEqual(
        settings.json<AdminSettingsResponse>().smtp.host,
        'smtp.attacker.test',
        'nothing was written',
      );
    });

    it('refuses an ordinary admin touching the CAPTCHA section', async () => {
      const response = await harness.authed(admin, {
        method: 'PUT',
        url: '/api/admin/settings',
        payload: { captcha: { enabled: false } },
      });
      assert.equal(response.statusCode, 403);
      assert.equal(errorCode(response.body), 'FORBIDDEN');
    });

    it('still lets an ordinary admin change registration policy and branding', async () => {
      const response = await harness.authed(admin, {
        method: 'PUT',
        url: '/api/admin/settings',
        payload: {
          registration: { open_registration: true },
          branding: { tagline: 'Set by an ordinary admin' },
        },
      });
      assert.equal(response.statusCode, 200, response.body);
      const settings = response.json<AdminSettingsResponse>();
      assert.equal(settings.registration.open_registration, true);
      assert.equal(settings.branding.tagline, 'Set by an ordinary admin');
    });

    it('lets an ordinary admin publish the gateway address', async () => {
      // Deliberately not privileged: a proxy-listener origin is published
      // information, not an escalation path like SMTP or CAPTCHA.
      const response = await harness.authed(admin, {
        method: 'PUT',
        url: '/api/admin/settings',
        payload: { gateway: { public_url: 'https://gw.example.com' } },
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(
        response.json<AdminSettingsResponse>().gateway.public_url,
        'https://gw.example.com',
      );
    });

    it('lets a super_admin change the same SMTP section', async () => {
      const response = await harness.authed(founder, {
        method: 'PUT',
        url: '/api/admin/settings',
        payload: { smtp: { host: 'smtp.trusted.test' } },
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json<AdminSettingsResponse>().smtp.host, 'smtp.trusted.test');
    });
  });

  describe('the gateway address', () => {
    async function put(publicUrl: string | null): Promise<ReturnType<typeof harness.authed>> {
      return harness.authed(founder, {
        method: 'PUT',
        url: '/api/admin/settings',
        payload: { gateway: { public_url: publicUrl } },
      });
    }

    it('reads back null when nothing is stored and no env default is set', async () => {
      // This harness runs without `FERRUM_GATEWAY_PUBLIC_URL`, so an empty
      // override means the catalog has no origin at all to offer.
      await put(null);
      const response = await harness.authed(founder, {
        method: 'GET',
        url: '/api/admin/settings',
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json<AdminSettingsResponse>().gateway.public_url, null);
    });

    it('round-trips an origin and strips a trailing slash', async () => {
      const saved = await put('https://api.example.com/');
      assert.equal(saved.statusCode, 200, saved.body);
      assert.equal(
        saved.json<AdminSettingsResponse>().gateway.public_url,
        'https://api.example.com',
      );

      const reread = await harness.authed(founder, {
        method: 'GET',
        url: '/api/admin/settings',
      });
      assert.equal(
        reread.json<AdminSettingsResponse>().gateway.public_url,
        'https://api.example.com',
      );
    });

    it('keeps a non-default port', async () => {
      const saved = await put('http://127.0.0.1:8000');
      assert.equal(saved.statusCode, 200, saved.body);
      assert.equal(saved.json<AdminSettingsResponse>().gateway.public_url, 'http://127.0.0.1:8000');
    });

    it('records the key name, not the value, in the audit row', async () => {
      const rows = await harness.auditRows('admin.settings_update');
      const named = rows.filter((row) =>
        JSON.stringify(row.details).includes('gateway.public_url'),
      );
      assert.ok(named.length > 0, 'the changed key is named');
      assert.ok(
        named.every((row) => !JSON.stringify(row.details).includes('127.0.0.1:8000')),
        'the value itself never lands in the log',
      );
    });

    for (const [label, value] of [
      ['a path', 'https://api.example.com/v1'],
      ['a query string', 'https://api.example.com?x=1'],
      ['embedded credentials', 'https://user:pass@api.example.com'],
      ['a non-http scheme', 'ftp://api.example.com'],
      ['a bare hostname', 'api.example.com'],
    ] as const) {
      it(`refuses ${label}`, async () => {
        const response = await put(value);
        assert.equal(response.statusCode, 400, response.body);
        assert.equal(errorCode(response.body), 'VALIDATION_FAILED');
      });
    }

    it('clears the override with null', async () => {
      const cleared = await put(null);
      assert.equal(cleared.statusCode, 200, cleared.body);
      assert.equal(cleared.json<AdminSettingsResponse>().gateway.public_url, null);
    });
  });

  it('stores the SMTP password encrypted and never returns it', async () => {
    const response = await harness.authed(founder, {
      method: 'PUT',
      url: '/api/admin/settings',
      payload: {
        smtp: {
          host: 'smtp.example.test',
          port: 2525,
          secure: true,
          username: 'mailer',
          password: SMTP_PASSWORD,
          from_address: 'Portal <no-reply@example.test>',
        },
      },
    });
    assert.equal(response.statusCode, 200);
    const settings = response.json<AdminSettingsResponse>();
    assert.equal(settings.smtp.host, 'smtp.example.test');
    assert.equal(settings.smtp.port, 2525);
    assert.equal(settings.smtp.password_set, true);
    assert.ok(!JSON.stringify(settings).includes(SMTP_PASSWORD), 'no secret in the response');

    const row = await harness.store.settings.get(SMTP_PASSWORD_SETTINGS_KEY);
    assert.equal(row?.encrypted, true);
    const raw = String(row?.value);
    assert.ok(raw.startsWith('v1:'), 'the stored value is an AES-GCM blob');
    assert.ok(!raw.includes(SMTP_PASSWORD), 'the plaintext never reaches the row');

    // The email service decrypts it back for the transport.
    const resolved = await harness.services.email.resolveSettings();
    assert.equal(resolved.password, SMTP_PASSWORD);
    assert.equal(resolved.from, 'Portal <no-reply@example.test>');
    assert.equal(await harness.services.email.isConfigured(), true);
  });

  it('encrypts the CAPTCHA secret and exposes only the site key publicly', async () => {
    const response = await harness.authed(founder, {
      method: 'PUT',
      url: '/api/admin/settings',
      payload: {
        captcha: {
          enabled: true,
          provider: 'turnstile',
          site_key: 'site-key-123',
          secret_key: CAPTCHA_SECRET,
        },
      },
    });
    assert.equal(response.statusCode, 200);
    const settings = response.json<AdminSettingsResponse>();
    assert.equal(settings.captcha.secret_set, true);
    assert.ok(!JSON.stringify(settings).includes(CAPTCHA_SECRET));

    const row = await harness.store.settings.get(CAPTCHA_SECRET_SETTINGS_KEY);
    assert.equal(row?.encrypted, true);
    assert.ok(!String(row?.value).includes(CAPTCHA_SECRET));

    const branding = await harness.app.inject({ method: 'GET', url: '/api/branding' });
    const publicConfig = branding.json<BrandingResponse>().captcha;
    assert.equal(publicConfig.enabled, true);
    assert.equal(publicConfig.provider, 'turnstile');
    assert.equal(publicConfig.site_key, 'site-key-123');
    assert.ok(!branding.body.includes(CAPTCHA_SECRET));
  });

  it('applies branding updates to the public endpoint', async () => {
    const response = await harness.authed(founder, {
      method: 'PUT',
      url: '/api/admin/settings',
      payload: {
        branding: { portal_name: 'Acme Gateway', accent_color: '#ff8800', tagline: 'Ship APIs' },
      },
    });
    assert.equal(response.statusCode, 200);

    const branding = await harness.app.inject({ method: 'GET', url: '/api/branding' });
    const body = branding.json<BrandingResponse>();
    assert.equal(body.portal_name, 'Acme Gateway');
    assert.equal(body.accent_color, '#ff8800');
    assert.equal(body.tagline, 'Ship APIs');
    assert.equal(body.primary_color, '#4f46e5', 'untouched fields keep their default');
  });

  it('rejects a malformed logo or colour', async () => {
    const response = await harness.authed(founder, {
      method: 'PUT',
      url: '/api/admin/settings',
      payload: { branding: { logo_data_url: 'https://example.test/logo.png' } },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(errorCode(response.body), 'VALIDATION_FAILED');
  });

  it('audits changed keys and never their values', async () => {
    const page = await harness.store.auditLogs.list({ action: 'admin.settings_update' });
    assert.ok(page.total >= 3);
    const serialised = JSON.stringify(page.items);
    assert.ok(!serialised.includes(SMTP_PASSWORD));
    assert.ok(!serialised.includes(CAPTCHA_SECRET));
    const keys = page.items.flatMap(
      (entry) => (entry.details as { changed_keys?: string[] }).changed_keys ?? [],
    );
    assert.ok(keys.includes('smtp.password'));
    assert.ok(keys.includes('captcha.secret_key'));
  });

  it('reports an SMTP test result and audits it', async () => {
    const response = await harness.authed(founder, {
      method: 'POST',
      url: '/api/admin/settings/smtp-test',
      payload: {},
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json<SmtpTestResponse>(), { ok: true, error: null });
    assert.equal(harness.mailbox.sent.at(-1)?.to, 'founder@example.test');

    const audit = await harness.store.auditLogs.list({ action: 'admin.smtp_test' });
    assert.equal(audit.total, 1);
    assert.equal((audit.items[0]?.details as { ok?: boolean }).ok, true);
  });

  it('reads and overrides an email template', async () => {
    const initial = await harness.authed(founder, {
      method: 'GET',
      url: '/api/admin/email-templates/verification',
    });
    assert.equal(initial.statusCode, 200);
    const body = initial.json<GetEmailTemplateResponse>();
    assert.ok(body.available_variables.includes('verification_url'));

    const saved = await harness.authed(founder, {
      method: 'PUT',
      url: '/api/admin/email-templates/verification',
      payload: {
        subject: 'Confirm your address',
        body_html: '<p>{{verification_url}}</p>',
        body_text: '{{verification_url}}',
      },
    });
    assert.equal(saved.statusCode, 200);
    assert.equal(
      saved.json<UpdateEmailTemplateResponse>().template.subject,
      'Confirm your address',
    );

    const rendered = await harness.services.email.render('verification', {
      verification_url: 'https://portal.test/v?token=t',
    });
    assert.equal(rendered.subject, 'Confirm your address');

    const unknown = await harness.authed(founder, {
      method: 'GET',
      url: '/api/admin/email-templates/not-a-key',
    });
    assert.equal(unknown.statusCode, 400);

    const audit = await harness.store.auditLogs.list({ action: 'admin.template_update' });
    assert.equal(audit.total, 1);
  });

  it('lists audit logs with filters', async () => {
    const all = await harness.authed(founder, { method: 'GET', url: '/api/admin/audit-logs' });
    assert.equal(all.statusCode, 200);
    assert.ok(all.json<ListAuditLogsResponse>().total > 0);

    const filtered = await harness.authed(founder, {
      method: 'GET',
      url: '/api/admin/audit-logs?action=admin.settings_update&limit=2',
    });
    const page = filtered.json<ListAuditLogsResponse>();
    assert.ok(page.items.every((entry) => entry.action === 'admin.settings_update'));
    assert.ok(page.items.length <= 2);
    assert.ok(page.total >= page.items.length);

    const byActor = await harness.authed(founder, {
      method: 'GET',
      url: `/api/admin/audit-logs?actor_user_id=${founder.user.id}&target_type=settings`,
    });
    assert.ok(byActor.json<ListAuditLogsResponse>().total >= 3);

    const future = await harness.authed(founder, {
      method: 'GET',
      url: `/api/admin/audit-logs?from=${new Date(Date.now() + 60_000).toISOString()}`,
    });
    assert.equal(future.json<ListAuditLogsResponse>().total, 0);
  });
});
