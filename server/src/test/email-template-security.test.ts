import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import {
  EMAIL_TEMPLATE_KEYS,
  type ApiErrorBody,
  type GetEmailTemplateResponse,
} from '@ferrum-nexus/shared';

import { REGISTRATION_SETTINGS_KEY } from '../auth/service.js';
import { buildTestApp, TEST_PASSWORD, type TestApp, type TestSession } from './helpers.js';

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
      body_html: '<p>{{verification_url}}</p>{{ verification_token }}{{reset_token}}',
      body_text: '{{verification_url}}|{{verification_token}}|{{ reset_token }}',
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
        html: `<p>${url}</p>`,
        text: `${url}||`,
      });
    }
  });
});
