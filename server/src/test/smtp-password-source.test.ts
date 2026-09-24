/**
 * Which SMTP password is presented to which relay (issue #342).
 *
 * `NEXUS_SMTP_PASSWORD` is a credential for the environment's own relay. The
 * stored `smtp.password` override is a credential for whatever relay an
 * administrator stored. The email service used to resolve the password as
 * "the override, else the environment's", and the override reader answered
 * `null` both for "there is no override" and for "there is one and it no
 * longer decrypts" — so after a `NEXUS_SECRET_KEY` rotation without
 * `rotate-key`, relay A's environment password was sent to stored relay B
 * under relay B's username.
 *
 * These tests hold the resolution to one rule: the environment's password
 * reaches the environment's connection and nothing else, and an override the
 * server cannot read fails closed.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  SMTP_PASSWORD_SETTINGS_KEY,
  SMTP_SETTINGS_KEY,
  type StoredSmtpSettings,
} from '../admin/settings-service.js';
import { createEmailService, type EmailService } from '../email/service.js';
import { createCrypto } from '../lib/crypto.js';
import { buildTestApp, type TestApp } from './helpers.js';

const ENVIRONMENT_PASSWORD = 'relay-a-environment-password';
const STORED_PASSWORD = 'relay-b-stored-password';
/** A different `NEXUS_SECRET_KEY`, standing in for the one before a rotation. */
const PREVIOUS_SECRET_KEY = 'previous-secret-key-that-is-long-enough-to-be-real-0123456789';

const ENVIRONMENT = {
  host: 'relay-a.example.test',
  port: 587,
  secure: false,
  username: 'relay-a-user',
};

interface LogLine {
  obj: Record<string, unknown>;
  message: string;
}

describe('SMTP password source', () => {
  let harness: TestApp;
  let email: EmailService;
  const logged: LogLine[] = [];

  before(async () => {
    harness = await buildTestApp({
      env: {
        NEXUS_SMTP_HOST: ENVIRONMENT.host,
        NEXUS_SMTP_PORT: String(ENVIRONMENT.port),
        NEXUS_SMTP_SECURE: String(ENVIRONMENT.secure),
        NEXUS_SMTP_USER: ENVIRONMENT.username,
        NEXUS_SMTP_PASSWORD: ENVIRONMENT_PASSWORD,
      },
    });
  });

  after(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await harness.store.settings.delete(SMTP_SETTINGS_KEY);
    await harness.store.settings.delete(SMTP_PASSWORD_SETTINGS_KEY);
    logged.length = 0;
    // A service of its own per test, so the log lines — and the once-per-
    // condition memory behind them — belong to the test that caused them.
    email = createEmailService({
      config: harness.config,
      store: harness.store,
      crypto: createCrypto(harness.config.secretKey),
      log: (obj, message) => logged.push({ obj, message }),
    });
  });

  async function storeConnection(connection: Partial<StoredSmtpSettings>): Promise<void> {
    await harness.store.settings.set(
      SMTP_SETTINGS_KEY,
      {
        host: null,
        port: null,
        secure: null,
        username: null,
        from_address: null,
        ...connection,
      },
      false,
    );
  }

  async function storePassword(secretKey: string): Promise<void> {
    await harness.store.settings.set(
      SMTP_PASSWORD_SETTINGS_KEY,
      createCrypto(secretKey).encryptJson(STORED_PASSWORD),
      true,
    );
  }

  /** No log line may carry a password, whichever one was in play. */
  function assertNoSecretLogged(): void {
    const serialised = JSON.stringify(logged);
    assert.doesNotMatch(serialised, new RegExp(ENVIRONMENT_PASSWORD));
    assert.doesNotMatch(serialised, new RegExp(STORED_PASSWORD));
  }

  it('presents the environment password to the environment relay', async () => {
    const resolved = await email.resolveSettings();
    assert.equal(resolved.host, ENVIRONMENT.host);
    assert.equal(resolved.user, ENVIRONMENT.username);
    assert.equal(resolved.password, ENVIRONMENT_PASSWORD);

    // An override that leaves the connection alone keeps it the environment's.
    await storeConnection({ from_address: 'Portal <no-reply@example.test>' });
    assert.equal((await email.resolveSettings()).password, ENVIRONMENT_PASSWORD);
    assert.equal((await harness.services.settings.getAdminSettings()).smtp.password_set, true);
    assert.deepEqual(logged, []);
  });

  for (const connection of [
    { host: 'relay-b.example.test' },
    { port: 2525 },
    { secure: true },
    { username: 'relay-b-user' },
  ]) {
    const field = Object.keys(connection)[0];
    it(`never presents the environment password once the stored ${field} differs`, async () => {
      await storeConnection(connection);
      const resolved = await email.resolveSettings();
      assert.equal(resolved.password, null, 'no password rather than relay A’s');
      assert.equal(
        (await harness.services.settings.getAdminSettings()).smtp.password_set,
        false,
        'the settings page says there is no usable password',
      );
      assert.equal(logged.length, 1);
      assert.equal(logged[0]?.obj.condition, 'environment-mismatch');
      assertNoSecretLogged();
    });
  }

  it('uses a stored password that decrypts, whatever the environment holds', async () => {
    await storeConnection({ host: 'relay-b.example.test', username: 'relay-b-user' });
    await storePassword(harness.config.secretKey);
    const resolved = await email.resolveSettings();
    assert.equal(resolved.host, 'relay-b.example.test');
    assert.equal(resolved.user, 'relay-b-user');
    assert.equal(resolved.password, STORED_PASSWORD);
    assert.equal((await harness.services.settings.getAdminSettings()).smtp.password_set, true);
    assert.deepEqual(logged, []);
  });

  it('fails closed on a stored password the current key cannot decrypt', async () => {
    // The reported shape: relay B stored with its own password, then
    // `NEXUS_SECRET_KEY` rotated without `rotate-key`.
    await storeConnection({ host: 'relay-b.example.test', username: 'relay-b-user' });
    await storePassword(PREVIOUS_SECRET_KEY);

    const resolved = await email.resolveSettings();
    assert.equal(resolved.host, 'relay-b.example.test');
    assert.equal(resolved.user, 'relay-b-user');
    assert.equal(resolved.password, null, 'relay A’s password never reaches relay B');
    assert.equal(
      (await harness.services.settings.getAdminSettings()).smtp.password_set,
      false,
      'an unreadable override is not a usable password',
    );

    assert.equal(logged.length, 1);
    assert.equal(logged[0]?.obj.condition, 'unreadable');
    assertNoSecretLogged();

    // Logged once per condition, not once per outbox poll.
    await email.resolveSettings();
    assert.equal(logged.length, 1);
  });

  it('fails closed on an unreadable override even on the environment relay', async () => {
    // An override exists, so the administrator chose a credential for this
    // relay; the server cannot read it, and that is not the same as "absent".
    await storePassword(PREVIOUS_SECRET_KEY);
    const resolved = await email.resolveSettings();
    assert.equal(resolved.host, ENVIRONMENT.host);
    assert.equal(resolved.password, null);
    assert.equal(logged[0]?.obj.condition, 'unreadable');
    assertNoSecretLogged();
  });

  it('presents the stored password again once an administrator re-enters it', async () => {
    await storeConnection({ host: 'relay-b.example.test', username: 'relay-b-user' });
    await storePassword(PREVIOUS_SECRET_KEY);
    assert.equal((await email.resolveSettings()).password, null);

    await storePassword(harness.config.secretKey);
    assert.equal((await email.resolveSettings()).password, STORED_PASSWORD);
  });
});
