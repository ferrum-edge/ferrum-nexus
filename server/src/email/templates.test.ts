import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { EMAIL_TEMPLATE_KEYS } from '@ferrum-nexus/shared';

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
    harness = await buildTestApp();
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
      body_html: '<p>{{verification_url}}</p>',
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
    await harness.store.settings.set('branding', { portal_name: 'Acme Gateway' }, false);
    const rendered = await harness.services.email.render('access_approved', {
      api_name: 'Billing',
    });
    assert.ok(rendered.html.includes('Acme Gateway'));
  });
});
