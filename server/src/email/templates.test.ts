import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { EMAIL_TEMPLATE_KEYS } from '@ferrum-nexus/shared';

import { BRANDING_SETTINGS_KEY } from '../admin/settings-service.js';
import { buildTestApp, type TestApp } from '../test/helpers.js';
import {
  DEFAULT_EMAIL_TEMPLATES,
  escapeHtml,
  interpolate,
  renderTemplate,
  TEMPLATE_VARIABLES,
} from './templates.js';

describe('email templates', () => {
  it('ships a default for every template key', () => {
    for (const key of EMAIL_TEMPLATE_KEYS) {
      const content = DEFAULT_EMAIL_TEMPLATES[key];
      assert.ok(content.subject.length > 0, `${key} has a subject`);
      assert.ok(content.body_html.length > 0, `${key} has an html body`);
      assert.ok(content.body_text.length > 0, `${key} has a text body`);
      assert.ok(TEMPLATE_VARIABLES[key].includes('portal_name'));
    }
  });

  it('substitutes placeholders and drops unknown ones', () => {
    const out = interpolate('Hi {{name}}{{missing}}!', { name: 'Ada' }, false);
    assert.equal(out, 'Hi Ada!');
  });

  for (const key of ['password_reset', 'verification'] as const) {
    it(`renders only the supported URL for ${key}, even if raw tokens are supplied`, () => {
      const urlVar = key === 'password_reset' ? 'reset_url' : 'verification_url';
      const url = 'https://portal.test/action?token=single-use-secret';
      const retired = '{{reset_token}}|{{ \nverification_token\t }}';
      const rendered = renderTemplate(
        {
          subject: retired,
          body_html: `<a href="{{${urlVar}}}">Continue</a>|${retired}`,
          body_text: `{{${urlVar}}}|${retired}`,
        },
        {
          [urlVar]: url,
          reset_token: 'single-use-secret',
          verification_token: 'single-use-secret',
        },
        { rawHtmlVars: ['reset_token', 'verification_token'] },
      );
      assert.deepEqual(rendered, {
        subject: '|',
        html: `<a href="${url}">Continue</a>||`,
        text: `${url}||`,
      });
    });
  }

  it('escapes values in the html body but not in the subject or text', () => {
    const rendered = renderTemplate(
      {
        subject: 'Hello {{name}}',
        body_html: '<p>Hello {{name}}</p>',
        body_text: 'Hello {{name}}',
      },
      { name: '<script>alert("x")</script>' },
    );

    assert.equal(rendered.subject, 'Hello <script>alert("x")</script>');
    assert.equal(rendered.text, 'Hello <script>alert("x")</script>');
    assert.ok(!rendered.html.includes('<script>'), 'the html body must not carry raw markup');
    assert.ok(rendered.html.includes('&lt;script&gt;'));
    assert.ok(rendered.html.includes('&quot;x&quot;'));
  });

  it('leaves variables named in rawHtmlVars unescaped', () => {
    const rendered = renderTemplate(
      { subject: 's', body_html: '<div>{{body_html}}{{other}}</div>', body_text: 't' },
      { body_html: '<b>bold</b>', other: '<i>italic</i>' },
      { rawHtmlVars: ['body_html'] },
    );
    assert.ok(rendered.html.includes('<b>bold</b>'));
    assert.ok(rendered.html.includes('&lt;i&gt;italic&lt;/i&gt;'));
  });

  it('escapes every dangerous character', () => {
    assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
  });
});

describe('template resolution', () => {
  let harness: TestApp;

  before(async () => {
    harness = await buildTestApp({ env: { NEXUS_PUBLIC_URL: 'https://portal.test' } });
  });

  after(async () => {
    await harness.close();
  });

  it('uses the built-in default until an admin overrides the key', async () => {
    const builtIn = await harness.services.email.render('verification', {
      recipient_name: 'Ada',
      verification_url: 'https://portal.test/verify-email?token=abc',
    });
    assert.equal(builtIn.subject, 'Verify your Ferrum Nexus email address');
    assert.ok(builtIn.text.includes('https://portal.test/verify-email?token=abc'));

    await harness.store.emailTemplates.upsert('verification', {
      subject: 'Confirm {{recipient_name}} at {{portal_name}}',
      body_html: '<a href="{{verification_url}}">Verify</a>',
      body_text: 'Go to {{verification_url}}',
    });

    const overridden = await harness.services.email.render('verification', {
      recipient_name: 'Ada',
      verification_url: 'https://portal.test/verify-email?token=abc',
    });
    assert.equal(overridden.subject, 'Confirm Ada at Ferrum Nexus');
    assert.equal(overridden.text, 'Go to https://portal.test/verify-email?token=abc');
  });

  it('picks up branding changes in the common variables', async () => {
    // Through the settings service, the writer: its committed save is what
    // invalidates the memoised portal name (a raw row write models another
    // instance, which catches up within `NEXUS_BRANDING_CACHE_MS`).
    const founder = await harness.registerUser({ email: 'templates-founder@example.test' });
    const saved = await harness.authed(founder, {
      method: 'PUT',
      url: '/api/admin/settings',
      payload: { branding: { portal_name: 'Acme Gateway' } },
    });
    assert.equal(saved.statusCode, 200, saved.body);
    const rendered = await harness.services.email.render('access_approved', {
      api_name: 'Billing',
    });
    assert.ok(rendered.html.includes('Acme Gateway'));
  });
});

describe('portal name in the common variables', () => {
  const brandingReads = (calls: readonly { arguments: readonly unknown[] }[]): number =>
    calls.filter((call) => call.arguments[0] === BRANDING_SETTINGS_KEY).length;

  it('is read once per NEXUS_BRANDING_CACHE_MS window, and again after a save', async (t) => {
    const harness = await buildTestApp({ env: { NEXUS_BRANDING_CACHE_MS: '60000' } });
    t.after(() => harness.close());
    const founder = await harness.registerUser({ email: 'memo-founder@example.test' });
    const render = (): Promise<{ html: string }> =>
      harness.services.email.render('access_approved', { api_name: 'Billing' });

    await render();
    const get = t.mock.method(harness.store.settings, 'get');
    for (let n = 0; n < 3; n += 1) assert.ok((await render()).html.includes('Ferrum Nexus'));
    assert.equal(brandingReads(get.mock.calls), 0, 'within the window no render reads the row');

    const saved = await harness.authed(founder, {
      method: 'PUT',
      url: '/api/admin/settings',
      payload: { branding: { portal_name: 'Renamed Portal' } },
    });
    assert.equal(saved.statusCode, 200, saved.body);
    get.mock.resetCalls();
    assert.ok((await render()).html.includes('Renamed Portal'), 'a save shows at once');
    assert.ok((await render()).html.includes('Renamed Portal'));
    assert.equal(brandingReads(get.mock.calls), 1, 'one read refills the memo');
  });

  it('is read on every render when NEXUS_BRANDING_CACHE_MS=0', async (t) => {
    const harness = await buildTestApp({ env: { NEXUS_BRANDING_CACHE_MS: '0' } });
    t.after(() => harness.close());
    const render = (): Promise<{ html: string }> =>
      harness.services.email.render('access_approved', { api_name: 'Billing' });

    const get = t.mock.method(harness.store.settings, 'get');
    await render();
    await render();
    assert.equal(brandingReads(get.mock.calls), 2);

    await harness.store.settings.set(BRANDING_SETTINGS_KEY, { portal_name: 'Raw Write' }, false);
    assert.ok((await render()).html.includes('Raw Write'), 'no memo: even a raw write shows');
  });
});
