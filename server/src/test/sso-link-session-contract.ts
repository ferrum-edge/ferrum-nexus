/** An explicit link cannot revive a session revoked during token exchange. */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { SESSION_COOKIE, SSO_TRANSACTION_COOKIE } from '@ferrum-nexus/shared';

import { AuditAction } from '../audit/service.js';
import type { NexusStore } from '../db/store.js';
import { isoInSeconds, newId, nowIso } from '../lib/ids.js';
import { buildTestApp, cookieValue, type TestApp, type TestSession } from './helpers.js';
import { createMockOidcProvider, type MockOidcProvider } from './mock-oidc-provider.js';

interface LinkTarget {
  store: NexusStore;
  teardown: () => Promise<void>;
  peer?: () => Promise<NexusStore>;
}

function barrier(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function runSsoLinkSessionContract(
  label: string,
  makeStore: () => Promise<LinkTarget>,
): void {
  describe(`explicit SSO link session lifecycle — ${label}`, { timeout: 20_000 }, () => {
    let target: LinkTarget;
    let peer: NexusStore;
    let h: TestApp;
    let other: TestApp;
    let founder: TestSession;
    let idp: MockOidcProvider;

    before(async () => {
      target = await makeStore();
      peer = target.peer ? await target.peer() : target.store;
      idp = createMockOidcProvider({ clientId: 'session-contract', clientSecret: null });
      await idp.start();
      const env = {
        NEXUS_OIDC_ALLOW_HTTP_LOOPBACK: 'true',
        NEXUS_OIDC_PROVIDERS: JSON.stringify([
          {
            id: 'session-contract',
            display_name: 'Session contract',
            issuer: idp.issuer,
            client_id: 'session-contract',
            default_role: 'admin',
          },
        ]),
      };
      h = await buildTestApp({ store: target.store, env });
      other = await buildTestApp({ store: peer, edge: h.edge, env });
      founder = await h.registerUser({ email: 'link-founder@example.test' });
    });

    after(async () => {
      await other?.close();
      await h?.close();
      await idp?.stop();
      if (peer && peer !== target.store) await peer.close();
      await target?.teardown();
    });

    async function provenAccount(): Promise<TestSession> {
      const subject = await h.registerUser({ email: `${newId()}@example.test` });
      await h.store.emailProofs.upsert(
        subject.user.id,
        subject.user.email,
        'password_reset',
        nowIso(),
      );
      return subject;
    }

    async function callback(subject: TestSession, sub: string) {
      const start = await h.authed(subject, {
        method: 'POST',
        url: '/api/auth/sso/session-contract/link',
      });
      assert.equal(start.statusCode, 200, start.body);
      const transaction = cookieValue(start, SSO_TRANSACTION_COOKIE);
      assert.ok(transaction);
      const authorization = idp.authorize(start.json<{ location: string }>().location, {
        sub,
        email: subject.user.email,
        email_verified: true,
      });
      return h.app
        .inject({
          method: 'GET',
          url:
            '/api/auth/sso/session-contract/callback?' +
            new URLSearchParams({ code: authorization.code, state: authorization.state }),
          cookies: {
            [SSO_TRANSACTION_COOKIE]: transaction,
            [SESSION_COOKIE]: subject.sessionToken,
          },
        })
        .then((response) => response);
    }

    for (const role of ['provider', 'admin', 'super_admin'] as const) {
      for (const alreadyLinked of [false, true]) {
        it(`rejects ${role} link after revocation, linked=${alreadyLinked}`, async () => {
          const subject = await provenAccount();
          const sub = newId();
          if (alreadyLinked) {
            await h.store.userIdentities.create({
              user_id: subject.user.id,
              provider_id: 'session-contract',
              issuer: idp.issuer,
              subject: sub,
              email: subject.user.email,
              provisioned: false,
            });
          }
          const exchanging = barrier();
          const resume = barrier();
          idp.beforeNextTokenResponse = async () => {
            exchanging.resolve();
            await resume.promise;
          };
          // Start before promotion: middleware caches the initiating session.
          const pending = callback(subject, sub);
          try {
            await Promise.race([
              exchanging.promise,
              pending.then(() => {
                throw new Error('token exchange barrier missed');
              }),
            ]);
            const promoted = await other.authed(founder, {
              method: 'PATCH',
              url: `/api/users/${subject.user.id}`,
              payload: { role },
            });
            assert.equal(promoted.statusCode, 200, promoted.body);
            assert.equal(
              await peer.sessions.findByTokenHash(
                h.app.nexus.crypto.hashToken(subject.sessionToken),
              ),
              null,
            );
            resume.resolve();
            const response = await pending;
            assert.equal(response.statusCode, 302, response.body);
            assert.equal(
              new URL(String(response.headers.location)).searchParams.get('sso_error'),
              'link_session_mismatch',
            );
            assert.ok(!cookieValue(response, SESSION_COOKIE), 'no replacement session was issued');
            const identities = await peer.userIdentities.listByUser(subject.user.id);
            assert.equal(identities.length, alreadyLinked ? 1 : 0);
            assert.equal((await peer.users.findById(subject.user.id))?.role, role);
            const signedIn = (await h.auditRows(AuditAction.AUTH_SSO_LOGIN)).filter(
              (row) => row.actor_user_id === subject.user.id,
            );
            assert.equal(signedIn.length, 0, 'the refused callback committed no sign-in');
          } finally {
            resume.resolve();
            await pending;
          }
        });
      }
    }

    it('refuses a session that expires during token exchange', async () => {
      const subject = await provenAccount();
      const session = await h.store.sessions.findByTokenHash(
        h.app.nexus.crypto.hashToken(subject.sessionToken),
      );
      assert.ok(session);
      const exchanging = barrier();
      const resume = barrier();
      idp.beforeNextTokenResponse = async () => {
        exchanging.resolve();
        await resume.promise;
      };
      const pending = callback(subject, newId());
      try {
        await Promise.race([
          exchanging.promise,
          pending.then(() => {
            throw new Error('token exchange barrier missed');
          }),
        ]);
        await peer.sessions.touch(session.id, isoInSeconds(-1));
        resume.resolve();
        const response = await pending;
        assert.equal(
          new URL(String(response.headers.location)).searchParams.get('sso_error'),
          'link_session_mismatch',
        );
        assert.deepEqual(await peer.userIdentities.listByUser(subject.user.id), []);
      } finally {
        resume.resolve();
        await pending;
      }
    });

    it('still links and promotes from a live initiating session', async () => {
      const subject = await provenAccount();
      const response = await callback(subject, newId());
      assert.equal(new URL(String(response.headers.location)).searchParams.get('sso_error'), null);
      assert.ok(cookieValue(response, SESSION_COOKIE));
      assert.equal((await peer.users.findById(subject.user.id))?.role, 'admin');
      assert.equal((await peer.userIdentities.listByUser(subject.user.id)).length, 1);
    });
  });
}
