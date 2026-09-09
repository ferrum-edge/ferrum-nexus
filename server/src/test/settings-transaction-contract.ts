import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type { ApiErrorBody, UpdateSettingsRequest } from '@ferrum-nexus/shared';

import type { NexusStore } from '../db/store.js';
import { faultInjectingStore, type FaultInjectingStore } from './fault-injection.js';
import { buildTestApp, type TestApp, type TestSession } from './helpers.js';

/** The real settings endpoint must roll back configuration and audit on every adapter. */
export function runSettingsTransactionContract(
  label: string,
  makeStore: () => Promise<{ store: NexusStore; teardown: () => Promise<void> }>,
): void {
  describe(`settings transaction contract — ${label}`, () => {
    let target: Awaited<ReturnType<typeof makeStore>>;
    let faults: FaultInjectingStore;
    let harness: TestApp;
    let founder: TestSession;

    before(async () => {
      target = await makeStore();
      faults = faultInjectingStore(target.store);
      harness = await buildTestApp({
        store: faults.store,
        env: {
          NEXUS_SMTP_HOST: 'environment.example.test',
          NEXUS_SMTP_PORT: '587',
          NEXUS_SMTP_SECURE: 'false',
          NEXUS_SMTP_USER: 'environment-user',
          NEXUS_SMTP_PASSWORD: 'environment-password',
        },
      });
      founder = await harness.registerUser();
      const seeded = await harness.authed(founder, {
        method: 'PUT',
        url: '/api/admin/settings',
        payload: {
          branding: { portal_name: 'Before' },
          gateway: { public_url: 'https://before.example.test' },
          captcha: { enabled: false, secret_key: 'previous-captcha' },
          smtp: { host: 'previous.example.test', password: 'previous-smtp' },
          registration: { open_registration: true },
        },
      });
      assert.equal(seeded.statusCode, 200, seeded.body);
    });

    after(async () => {
      await harness?.close();
      await target?.teardown();
    });

    const cases: {
      name: string;
      patch: UpdateSettingsRequest;
      repo: keyof NexusStore;
      method: string;
      successfulCalls: number;
    }[] = [
      {
        name: 'branding and registration',
        patch: {
          branding: { portal_name: 'Changed' },
          registration: { open_registration: false },
        },
        repo: 'settings',
        method: 'set',
        successfulCalls: 1,
      },
      {
        name: 'CAPTCHA configuration and encrypted secret',
        patch: {
          captcha: {
            enabled: true,
            provider: 'turnstile',
            site_key: 'public-site',
            secret_key: 'private-captcha',
          },
        },
        repo: 'settings',
        method: 'set',
        successfulCalls: 1,
      },
      {
        name: 'SMTP configuration and encrypted password',
        patch: { smtp: { host: 'mail.example.test', password: 'private-smtp' } },
        repo: 'settings',
        method: 'set',
        successfulCalls: 1,
      },
      {
        name: 'configuration and secret deletion',
        patch: { captcha: { enabled: false, secret_key: null } },
        repo: 'settings',
        method: 'delete',
        successfulCalls: 0,
      },
      {
        name: 'all sections and trailing audit',
        patch: {
          branding: { portal_name: 'Changed' },
          gateway: { public_url: 'https://changed.example.test' },
          captcha: {
            enabled: true,
            provider: 'turnstile',
            site_key: 'public-site',
            secret_key: 'private-captcha',
          },
          smtp: { host: 'mail.example.test', password: 'private-smtp' },
          registration: { open_registration: false },
        },
        repo: 'auditLogs',
        method: 'create',
        successfulCalls: 0,
      },
    ];

    for (const entry of cases) {
      it(`rolls back ${entry.name} after a later store failure`, async () => {
        const beforeRows = await target.store.settings.all();
        const beforeAudit = await harness.auditRows('admin.settings_update');
        const beforeUrl = await harness.services.settings.getGatewayPublicUrl();
        faults.failAfter(entry.repo, entry.method, entry.successfulCalls);
        const response = await harness.authed(founder, {
          method: 'PUT',
          url: '/api/admin/settings',
          payload: entry.patch,
        });
        assert.equal(response.statusCode, 500);
        assert.deepEqual(faults.pending(), [], 'the intended failure was reached');
        assert.deepEqual(await target.store.settings.all(), beforeRows);
        assert.deepEqual(await harness.auditRows('admin.settings_update'), beforeAudit);
        assert.equal(await harness.services.settings.getGatewayPublicUrl(), beforeUrl);
      });
    }

    it('commits the complete patch and one audit row without exposing secret values', async () => {
      const beforeAudit = await harness.auditRows('admin.settings_update');
      const response = await harness.authed(founder, {
        method: 'PUT',
        url: '/api/admin/settings',
        payload: cases[4]!.patch,
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().branding.portal_name, 'Changed');
      assert.equal(response.json().registration.open_registration, false);
      assert.equal(response.json().gateway.public_url, 'https://changed.example.test');
      for (const key of ['captcha.secret_key', 'smtp.password']) {
        const row = await target.store.settings.get(key);
        assert.equal(row?.encrypted, true);
      }
      const audit = await harness.auditRows('admin.settings_update');
      assert.equal(audit.length, beforeAudit.length + 1);
      assert.match(JSON.stringify(audit), /captcha.secret_key/);
      assert.match(JSON.stringify(audit), /smtp.password/);
      assert.doesNotMatch(response.body + JSON.stringify(audit), /private-captcha|private-smtp/);
    });

    const environmentConnection = {
      host: 'environment.example.test',
      port: 587,
      secure: false,
      username: 'environment-user',
    };

    for (const connection of [
      { host: 'administrator.example.test' },
      { port: 2525 },
      { secure: true },
      { username: 'administrator-user' },
    ]) {
      for (const password of [null, '']) {
        const field = Object.keys(connection)[0];
        it(`rejects clearing ${JSON.stringify(password)} after overriding ${field}`, async () => {
          const saved = await harness.authed(founder, {
            method: 'PUT',
            url: '/api/admin/settings',
            payload: {
              smtp: {
                ...environmentConnection,
                ...connection,
                password: 'administrator-password',
              },
            },
          });
          assert.equal(saved.statusCode, 200, saved.body);
          const beforeRows = await target.store.settings.all();
          const beforeAudit = await harness.auditRows('admin.settings_update');
          const beforeResolved = await harness.services.email.resolveSettings();
          assert.equal(beforeResolved.password, 'administrator-password');

          const rejected = await harness.authed(founder, {
            method: 'PUT',
            url: '/api/admin/settings',
            payload: { smtp: { password } },
          });
          assert.equal(rejected.statusCode, 400, rejected.body);
          assert.equal(rejected.json<ApiErrorBody>().error.code, 'VALIDATION_FAILED');
          assert.deepEqual(await target.store.settings.all(), beforeRows);
          assert.deepEqual(await harness.auditRows('admin.settings_update'), beforeAudit);
          assert.deepEqual(await harness.services.email.resolveSettings(), beforeResolved);
        });
      }
    }

    for (const password of [null, '']) {
      it(`clears ${JSON.stringify(password)} on the environment relay with an audit`, async () => {
        const saved = await harness.authed(founder, {
          method: 'PUT',
          url: '/api/admin/settings',
          payload: { smtp: { ...environmentConnection, password: 'administrator-password' } },
        });
        assert.equal(saved.statusCode, 200, saved.body);
        const beforeAudit = await harness.auditRows('admin.settings_update');
        const cleared = await harness.authed(founder, {
          method: 'PUT',
          url: '/api/admin/settings',
          payload: { smtp: { password } },
        });
        assert.equal(cleared.statusCode, 200, cleared.body);
        const resolved = await harness.services.email.resolveSettings();
        assert.equal(resolved.host, environmentConnection.host);
        assert.equal(resolved.password, 'environment-password');
        assert.equal(await target.store.settings.get('smtp.password'), null);
        const audit = await harness.auditRows('admin.settings_update');
        const added = audit.filter((row) => !beforeAudit.some((prior) => prior.id === row.id));
        assert.equal(added.length, 1);
        assert.deepEqual(added[0]?.details, {
          changed_keys: ['smtp.password'],
          smtp_password_source_change: { from: 'override', to: 'environment' },
        });

        const replaced = await harness.authed(founder, {
          method: 'PUT',
          url: '/api/admin/settings',
          payload: { smtp: { password: 'administrator-password' } },
        });
        assert.equal(replaced.statusCode, 200, replaced.body);
        const replacementAudit = (await harness.auditRows('admin.settings_update')).filter(
          (row) => !audit.some((prior) => prior.id === row.id),
        );
        assert.equal(replacementAudit.length, 1);
        assert.deepEqual(replacementAudit[0]?.details, {
          changed_keys: ['smtp.password'],
          smtp_password_source_change: { from: 'environment', to: 'override' },
        });
        assert.doesNotMatch(
          JSON.stringify([...added, ...replacementAudit]),
          /administrator-password|environment-password|environment\.example\.test/,
        );
      });
    }

    it('compares effective connection values when clearing redundant overrides', async () => {
      const response = await harness.authed(founder, {
        method: 'PUT',
        url: '/api/admin/settings',
        payload: { smtp: { host: null, username: '', password: null } },
      });
      assert.equal(response.statusCode, 200, response.body);
      const resolved = await harness.services.email.resolveSettings();
      assert.equal(resolved.host, environmentConnection.host);
      assert.equal(resolved.user, environmentConnection.username);
      assert.equal(resolved.password, 'environment-password');
    });
  });
}
