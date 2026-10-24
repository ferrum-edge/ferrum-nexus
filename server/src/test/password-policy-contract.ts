/**
 * The password flows decide eligibility at commit, not only up front.
 *
 * A password sign-in checks the login policy, the local-password block and the
 * verification rule, then spends ~100 ms on scrypt and waits for the
 * password-change lease before its session transaction. A reset redemption
 * checks the local-password block, then hashes the new password and waits for
 * its leases. A policy tightened in either window must refuse the operation,
 * and leave nothing behind: no session for a sign-in, and for a reset the old
 * password, proof, link and sessions untouched.
 *
 * Each case commits the tightening from inside the stubbed `verifyPassword`
 * or `hashPassword`, i.e. after the up-front checks passed and before the
 * committing transaction opened.
 *
 * Cross-adapter because the re-reads go through each adapter's transaction
 * (a MySQL REPEATABLE READ or MongoDB snapshot must start after the policy
 * lease is taken) and the ordering is the shared lease table's.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';

import type { ApiErrorBody } from '@ferrum-nexus/shared';

import { AuditAction } from '../audit/service.js';
import { REGISTRATION_SETTINGS_KEY } from '../auth/service.js';
import { isNexusError } from '../lib/errors.js';
import { isoInSeconds, newId, nowIso } from '../lib/ids.js';
import { createKeyedSerializer, REGISTRATION_POLICY_LOCK_KEY } from '../lib/keyed-serializer.js';
import { SSO_SETTINGS_KEY } from '../sso/settings.js';
import type { NexusStore } from '../db/store.js';
import { buildTestApp, TEST_PASSWORD, type TestApp, type TestSession } from './helpers.js';

const NEW_PASSWORD = 'a-password-set-mid-tightening';
const CONTEXT = { ip: null, userAgent: null };
const STRICT_PROVIDER_ID = 'strict';
const STRICT_ISSUER = 'https://strict.example.test';

/** A stored provider whose only interesting field is `disable_local_password_for_linked`. */
function strictProvider(strict: boolean): Record<string, unknown> {
  return {
    id: STRICT_PROVIDER_ID,
    display_name: 'Strict',
    issuer: STRICT_ISSUER,
    client_id: 'nexus-strict',
    scopes: ['openid', 'email'],
    enabled: true,
    jit_provisioning: false,
    link_existing_accounts: false,
    require_verified_email: true,
    allowed_email_domains: [],
    disable_local_password_for_linked: strict,
    sync_roles: false,
    default_role: null,
    role_mappings: [],
    org_mappings: [],
  };
}

/**
 * Run `during` once, the first time `method` of the app's crypto is called
 * with `password` — after the up-front checks, before the commit.
 */
function interleave(
  t: TestContext,
  harness: TestApp,
  method: 'verifyPassword' | 'hashPassword',
  password: string,
  during: () => Promise<void>,
): void {
  const crypto = harness.app.nexus.crypto;
  let pending = true;
  if (method === 'verifyPassword') {
    const verify = crypto.verifyPassword.bind(crypto);
    t.mock.method(crypto, 'verifyPassword', async (presented: string, hash: string) => {
      const ok = await verify(presented, hash);
      if (ok && pending && presented === password) {
        pending = false;
        await during();
      }
      return ok;
    });
  } else {
    const hashPassword = crypto.hashPassword.bind(crypto);
    t.mock.method(crypto, 'hashPassword', async (presented: string) => {
      const hash = await hashPassword(presented);
      if (pending && presented === password) {
        pending = false;
        await during();
      }
      return hash;
    });
  }
}

async function signIn(harness: TestApp, email: string): Promise<{ status: number; code?: string }> {
  const response = await harness.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: TEST_PASSWORD },
  });
  return response.statusCode === 200
    ? { status: 200 }
    : { status: response.statusCode, code: response.json<ApiErrorBody>().error.code };
}

/** Set the stored login policy, keeping the rest of the `sso` row. */
async function setLoginPolicy(harness: TestApp, policy: string): Promise<void> {
  const current = (await harness.store.settings.get(SSO_SETTINGS_KEY))?.value ?? {};
  await harness.store.settings.set(SSO_SETTINGS_KEY, { ...(current as object), policy }, false);
}

async function loginAudits(harness: TestApp, userId: string): Promise<number> {
  return (await harness.auditRows(AuditAction.AUTH_LOGIN)).filter((row) => row.target_id === userId)
    .length;
}

/** Exercise the password flows' commit-time eligibility against each smoke-suite adapter. */
export function runPasswordPolicyContract(
  label: string,
  makeStore: () => Promise<{ store: NexusStore; teardown: () => Promise<void> }>,
): void {
  describe(`password policy contract — ${label}`, () => {
    let target: Awaited<ReturnType<typeof makeStore>>;
    let harness: TestApp;
    let founder: TestSession;

    before(async () => {
      target = await makeStore();
      harness = await buildTestApp({ store: target.store, env: { NEXUS_OIDC_PROVIDERS: '[]' } });
      founder = await harness.registerUser();
    });

    after(async () => {
      await harness?.close();
      await target?.teardown();
    });

    /** Save the strict provider through the real settings writer. */
    async function saveStrictProvider(strict: boolean): Promise<void> {
      const response = await harness.authed(founder, {
        method: 'PUT',
        url: '/api/admin/sso',
        payload: { providers: [strictProvider(strict)] },
      });
      assert.equal(response.statusCode, 200, response.body);
    }

    /** A fresh client account with no session, linked at the strict provider when asked. */
    async function freshAccount(linked = false): Promise<TestSession> {
      const session = await harness.registerUser();
      await harness.store.sessions.deleteForUser(session.user.id);
      if (linked) {
        await harness.store.userIdentities.create({
          user_id: session.user.id,
          provider_id: STRICT_PROVIDER_ID,
          issuer: STRICT_ISSUER,
          subject: newId(),
          email: session.user.email,
          provisioned: false,
        });
      }
      return session;
    }

    it('refuses a sign-in when sso_only commits between verification and issuance', async (t) => {
      const session = await freshAccount();
      interleave(t, harness, 'verifyPassword', TEST_PASSWORD, () =>
        setLoginPolicy(harness, 'sso_only'),
      );
      try {
        assert.deepEqual(await signIn(harness, session.user.email), {
          status: 403,
          code: 'FORBIDDEN',
        });
      } finally {
        await setLoginPolicy(harness, 'local_and_sso');
      }
      assert.equal(await harness.store.sessions.deleteForUser(session.user.id), 0);
      assert.equal(await loginAudits(harness, session.user.id), 0);
    });

    it('refuses a sign-in when its provider turns strict in the same gap', async (t) => {
      await saveStrictProvider(false);
      const session = await freshAccount(true);
      // The policy-only settings writer, through its own route and keys.
      interleave(t, harness, 'verifyPassword', TEST_PASSWORD, () => saveStrictProvider(true));
      try {
        assert.deepEqual(await signIn(harness, session.user.email), {
          status: 401,
          code: 'UNAUTHORIZED',
        });
      } finally {
        await saveStrictProvider(false);
      }
      assert.equal(await harness.store.sessions.deleteForUser(session.user.id), 0);
      assert.equal(await loginAudits(harness, session.user.id), 0);
    });

    it('refuses a sign-in when the account is password-locked in the same gap', async (t) => {
      const session = await freshAccount();
      interleave(t, harness, 'verifyPassword', TEST_PASSWORD, () =>
        harness.store.passwordLocks.create(session.user.id, STRICT_PROVIDER_ID, nowIso()),
      );
      assert.deepEqual(await signIn(harness, session.user.email), {
        status: 401,
        code: 'UNAUTHORIZED',
      });
      assert.equal(await harness.store.sessions.deleteForUser(session.user.id), 0);
    });

    it('refuses an unverified sign-in when verification becomes mandatory in the gap', async (t) => {
      const session = await freshAccount();
      await harness.store.users.update(session.user.id, { email_verified: false });
      const prior = await harness.store.settings.get(REGISTRATION_SETTINGS_KEY);
      interleave(t, harness, 'verifyPassword', TEST_PASSWORD, async () => {
        await harness.store.settings.set(REGISTRATION_SETTINGS_KEY, {
          open_registration: true,
          require_email_verification: true,
          allowed_roles: ['client', 'provider'],
        });
      });
      try {
        assert.deepEqual(await signIn(harness, session.user.email), {
          status: 403,
          code: 'EMAIL_NOT_VERIFIED',
        });
      } finally {
        if (prior) await harness.store.settings.set(REGISTRATION_SETTINGS_KEY, prior.value);
        else await harness.store.settings.delete(REGISTRATION_SETTINGS_KEY);
      }
      assert.equal(await harness.store.sessions.deleteForUser(session.user.id), 0);
    });

    it('holds the session commit until a policy writer holding the key has finished', async (t) => {
      const session = await freshAccount();
      let verified!: () => void;
      const verifiedSignal = new Promise<void>((resolve) => {
        verified = resolve;
      });
      interleave(t, harness, 'verifyPassword', TEST_PASSWORD, async () => verified());
      const holder = createKeyedSerializer({ leases: harness.store.leases });
      let settled = false;
      let attempt: Promise<{ status: number; code?: string }> | undefined;
      try {
        await holder(REGISTRATION_POLICY_LOCK_KEY, async () => {
          attempt = signIn(harness, session.user.email).then((result) => {
            settled = true;
            return result;
          });
          await verifiedSignal;
          await new Promise((resume) => setTimeout(resume, 300));
          assert.equal(settled, false, 'the sign-in waits for the policy key');
          // The writer tightens before it lets go; the sign-in must see it.
          await setLoginPolicy(harness, 'sso_only');
        });
        assert.deepEqual(await attempt, { status: 403, code: 'FORBIDDEN' });
      } finally {
        await setLoginPolicy(harness, 'local_and_sso');
      }
      assert.equal(await harness.store.sessions.deleteForUser(session.user.id), 0);
    });

    it('refuses a reset whose account loses local-password eligibility mid-reset', async (t) => {
      await saveStrictProvider(false);
      // Keeps its registration session: a refused reset must not end it.
      const session = await harness.registerUser();
      await harness.store.userIdentities.create({
        user_id: session.user.id,
        provider_id: STRICT_PROVIDER_ID,
        issuer: STRICT_ISSUER,
        subject: newId(),
        email: session.user.email,
        provisioned: false,
      });
      const crypto = harness.app.nexus.crypto;
      const token = crypto.newSessionToken();
      await harness.store.verificationTokens.create({
        user_id: session.user.id,
        token_hash: crypto.hashToken(token),
        purpose: 'password_reset',
        expires_at: isoInSeconds(3600),
      });
      const userBefore = await harness.store.users.findById(session.user.id);
      assert.ok(userBefore);
      const proofBefore = await harness.store.emailProofs.findByUser(session.user.id);

      interleave(t, harness, 'hashPassword', NEW_PASSWORD, () => saveStrictProvider(true));
      try {
        await assert.rejects(
          harness.services.auth.resetPassword(token, NEW_PASSWORD, CONTEXT),
          (error: unknown) => {
            assert.ok(isNexusError(error));
            assert.equal(error.code, 'VALIDATION_FAILED');
            return true;
          },
        );
      } finally {
        await saveStrictProvider(false);
      }

      const userAfter = await harness.store.users.findById(session.user.id);
      assert.equal(userAfter?.password_hash, userBefore.password_hash, 'the password is unchanged');
      assert.equal(userAfter?.email_verified, userBefore.email_verified);
      assert.deepEqual(await harness.store.emailProofs.findByUser(session.user.id), proofBefore);
      const link = await harness.store.verificationTokens.findByTokenHash(
        crypto.hashToken(token),
        'password_reset',
      );
      assert.equal(link?.used_at, null, 'the link is not spent');
      assert.equal(
        (await harness.auditRows(AuditAction.AUTH_PASSWORD_RESET)).filter(
          (row) => row.target_id === session.user.id,
        ).length,
        0,
      );
      assert.equal(
        await harness.store.sessions.deleteForUser(session.user.id),
        1,
        'the registration session survives the refused reset',
      );
      // Eligible again, the same link still works.
      await harness.services.auth.resetPassword(token, NEW_PASSWORD, CONTEXT);
      await harness.loginUser(session.user.email, NEW_PASSWORD);
    });
  });

  describe(`password policy contract, break-glass — ${label}`, () => {
    let target: Awaited<ReturnType<typeof makeStore>>;
    let harness: TestApp;
    let founder: TestSession;

    before(async () => {
      target = await makeStore();
      harness = await buildTestApp({
        store: target.store,
        env: { NEXUS_OIDC_PROVIDERS: '[]', NEXUS_SSO_BREAK_GLASS_LOCAL_LOGIN: 'true' },
      });
      founder = await harness.registerUser();
    });

    after(async () => {
      await harness?.close();
      await target?.teardown();
    });

    it('refuses anyone but a super admin when sso_only commits in the gap', async (t) => {
      const client = await harness.registerUser();
      await harness.store.sessions.deleteForUser(client.user.id);
      interleave(t, harness, 'verifyPassword', TEST_PASSWORD, () =>
        setLoginPolicy(harness, 'sso_only'),
      );
      try {
        assert.deepEqual(await signIn(harness, client.user.email), {
          status: 401,
          code: 'UNAUTHORIZED',
        });
      } finally {
        await setLoginPolicy(harness, 'local_and_sso');
      }
      assert.equal(await harness.store.sessions.deleteForUser(client.user.id), 0);
      assert.equal(await loginAudits(harness, client.user.id), 0);
    });

    it('admits a super admin, audited as break-glass, when sso_only commits in the gap', async (t) => {
      // A password lock in the same gap does not bind a super admin either.
      interleave(t, harness, 'verifyPassword', TEST_PASSWORD, async () => {
        await setLoginPolicy(harness, 'sso_only');
        await harness.store.passwordLocks.create(founder.user.id, 'any-provider', nowIso());
      });
      try {
        assert.deepEqual(await signIn(harness, founder.user.email), { status: 200 });
      } finally {
        await setLoginPolicy(harness, 'local_and_sso');
      }
      const row = (await harness.auditRows(AuditAction.AUTH_LOGIN)).find(
        (entry) => entry.target_id === founder.user.id,
      );
      // Decided at the commit's re-read: the pre-check still saw local_and_sso.
      assert.equal(row?.details.break_glass, true);
    });
  });
}
