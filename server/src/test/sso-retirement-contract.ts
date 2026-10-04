/** Returning SSO authorization and retirement ordering over one production store. */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type { LightMyRequestResponse } from 'fastify';

import {
  SESSION_COOKIE,
  SSO_TRANSACTION_COOKIE,
  type MeResponse,
  type SsoAdminSettingsResponse,
  type SsoProviderSettings,
  type SsoPublicConfigResponse,
} from '@ferrum-nexus/shared';

import { AuditAction } from '../audit/service.js';
import type { NexusStore, SessionRecord, TransactionOptions } from '../db/store.js';
import { isoInSeconds, newId } from '../lib/ids.js';
import { readStoredSsoSettings, SSO_SETTINGS_KEY } from '../sso/settings.js';
import { buildTestApp, cookieValue, type TestApp, type TestSession } from './helpers.js';
import { createMockOidcProvider, type MockOidcProvider } from './mock-oidc-provider.js';

function barrier(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Timers only bound failures; progress is driven by observed store calls. */
async function bounded<T>(pending: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

interface RetirementWatch {
  userId: string;
  pauseSaveRead: boolean;
  callbackTransactionStarted: boolean;
  settingsReads: number;
  callbackPaused: boolean;
  callbackCommitted: boolean;
  session: SessionRecord | null;
  saveBodyRuns: number;
  saveReadReached: ReturnType<typeof barrier>;
  resumeSaveRead: ReturnType<typeof barrier>;
  saveReadResumed: ReturnType<typeof barrier>;
  saveQueued: ReturnType<typeof barrier>;
  authorized: ReturnType<typeof barrier>;
  resumeCallback: ReturnType<typeof barrier>;
}

function observedSession(watch: RetirementWatch): SessionRecord | null {
  return watch.session;
}

/** Test-only interception follows the pooled adapters into their scoped store. */
function watchRetirement(base: NexusStore, current: () => RetirementWatch | null): NexusStore {
  function callbackStore(tx: NexusStore, watch: RetirementWatch): NexusStore {
    const settings = new Proxy(tx.settings, {
      get(target, property) {
        if (property === 'get') {
          return async (...args: Parameters<typeof target.get>) => {
            const row = await target.get(...args);
            if (args[0] === SSO_SETTINGS_KEY) {
              assert.ok(row, 'currentSettings read the persisted SSO row inside the transaction');
              watch.settingsReads += 1;
            }
            return row;
          };
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const users = new Proxy(tx.users, {
      get(target, property) {
        if (property === 'findById') {
          return async (...args: Parameters<typeof target.findById>) => {
            if (!watch.callbackPaused) {
              // signIn reaches this call only AFTER currentSettings and domain
              // authorization succeed. An outer/pre-token settings read cannot
              // satisfy the barrier, including on SQLite where tx === base.
              assert.equal(watch.settingsReads, 1, 'transactional settings reread was reached');
              assert.equal(args[0], watch.userId, 'this is the returning account transaction');
              watch.callbackPaused = true;
              watch.authorized.release();
              await bounded(watch.resumeCallback.promise, 'returning callback was not released');
            }
            return target.findById(...args);
          };
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const sessions = new Proxy(tx.sessions, {
      get(target, property) {
        if (property === 'create') {
          return async (...args: Parameters<typeof target.create>) => {
            const session = await target.create(...args);
            watch.session = session;
            return session;
          };
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return new Proxy(tx, {
      get(target, property) {
        if (property === 'settings') return settings;
        if (property === 'users') return users;
        if (property === 'sessions') return sessions;
        const value: unknown = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  const settings = new Proxy(base.settings, {
    get(target, property) {
      if (property === 'get') {
        return async (...args: Parameters<typeof target.get>) => {
          const watch = current();
          if (watch?.pauseSaveRead && args[0] === SSO_SETTINGS_KEY) {
            // Let the real settings route pass session/CSRF/RBAC before the
            // callback opens its transaction. SQLite would otherwise block its
            // authentication read before the settings service could be reached.
            watch.pauseSaveRead = false;
            watch.saveReadReached.release();
            await bounded(watch.resumeSaveRead.promise, 'settings read was not released');
            watch.saveReadResumed.release();
          }
          return target.get(...args);
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return new Proxy(base, {
    get(target, property) {
      if (property === 'settings') return settings;
      if (property === 'transaction') {
        return async <T>(
          fn: (tx: NexusStore) => Promise<T>,
          options?: TransactionOptions,
        ): Promise<T> => {
          const watch = current();
          if (!watch) return target.transaction(fn, options);
          const callback = !watch.callbackTransactionStarted;
          watch.callbackTransactionStarted = true;
          if (!callback) watch.saveQueued.release();
          const result = await target.transaction(
            async (tx) => {
              if (callback) return fn(callbackStore(tx, watch));
              watch.saveBodyRuns += 1;
              assert.ok(watch.callbackCommitted, 'callback commit precedes the settings body');
              assert.ok(watch.session, 'the callback issued a real session');
              assert.deepEqual(await tx.sessions.findById(watch.session.id), watch.session);
              assert.equal(
                await tx.auditLogs.count({
                  action: AuditAction.AUTH_SSO_LOGIN,
                  target_id: watch.userId,
                }),
                1,
                'the callback login audit committed before settings were written',
              );
              return fn(tx);
            },
            options,
          );
          if (callback) watch.callbackCommitted = true;
          return result;
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function runSsoRetirementContract(
  label: string,
  makeStore: () => Promise<{ store: NexusStore; teardown: () => Promise<void> }>,
): void {
  describe(`returning SSO retirement on one shared store — ${label}`, { timeout: 60_000 }, () => {
    let target: Awaited<ReturnType<typeof makeStore>>;
    let h: TestApp;
    let founder: TestSession;
    let idp: MockOidcProvider;
    let watch: RetirementWatch | null = null;

    before(async () => {
      target = await makeStore();
      idp = createMockOidcProvider({ clientId: 'retirement-contract', clientSecret: null });
      await idp.start();
      h = await buildTestApp({
        store: target.store,
        env: { NEXUS_OIDC_ALLOW_HTTP_LOOPBACK: 'true', NEXUS_OIDC_PROVIDERS: '[]' },
        wrapStore: (store) => watchRetirement(store, () => watch),
      });
      founder = await h.registerUser();
    });

    after(async () => {
      await h?.close();
      await idp?.stop();
      await target?.teardown();
    });

    for (const change of ['disable', 'remove'] as const) {
      it(`commits an authorized returning callback before a concurrent ${change}`, async () => {
        const provider: SsoProviderSettings = {
          id: 'retirement-contract',
          display_name: 'Retirement contract',
          issuer: idp.issuer,
          client_id: 'retirement-contract',
          scopes: ['openid', 'email'],
          enabled: true,
          jit_provisioning: false,
          link_existing_accounts: false,
          require_verified_email: true,
          allowed_email_domains: [],
          disable_local_password_for_linked: false,
          sync_roles: false,
          default_role: 'client',
          role_mappings: [],
          org_mappings: [],
        };
        const put = (providers: SsoProviderSettings[]): Promise<LightMyRequestResponse> =>
          h.authed(founder, { method: 'PUT', url: '/api/admin/sso', payload: { providers } });
        const configured = await put([provider]);
        assert.equal(configured.statusCode, 200, configured.body);
        const account = await h.registerUser();
        const subject = newId();
        const identity = await h.store.userIdentities.create({
          user_id: account.user.id,
          provider_id: provider.id,
          issuer: provider.issuer,
          subject,
          email: account.user.email,
          provisioned: false,
          last_login_at: isoInSeconds(-3600),
        });
        const start = await h.app.inject({
          method: 'GET',
          url: `/api/auth/sso/${provider.id}/start`,
        });
        assert.equal(start.statusCode, 302, start.body);
        const transaction = cookieValue(start, SSO_TRANSACTION_COOKIE);
        assert.ok(transaction);
        const authorization = idp.authorize(String(start.headers.location), {
          sub: subject,
          email: account.user.email,
          email_verified: true,
        });

        const race: RetirementWatch = {
          userId: account.user.id,
          pauseSaveRead: true,
          callbackTransactionStarted: false,
          settingsReads: 0,
          callbackPaused: false,
          callbackCommitted: false,
          session: null,
          saveBodyRuns: 0,
          saveReadReached: barrier(),
          resumeSaveRead: barrier(),
          saveReadResumed: barrier(),
          saveQueued: barrier(),
          authorized: barrier(),
          resumeCallback: barrier(),
        };
        watch = race;
        let saveCompleted = false;
        let pendingCallback: Promise<LightMyRequestResponse> | undefined;
        const retiredProviders = change === 'remove' ? [] : [{ ...provider, enabled: false }];
        const pendingSave = put(retiredProviders).then((response) => {
          saveCompleted = true;
          return response;
        });
        try {
          await bounded(
            Promise.race([
              race.saveReadReached.promise,
              pendingSave.then(() => {
                throw new Error('settings route missed its initial read barrier');
              }),
            ]),
            'settings route did not reach the service',
          );
          pendingCallback = h.app
            .inject({
              method: 'GET',
              url:
                `/api/auth/sso/${provider.id}/callback?` +
                new URLSearchParams({ code: authorization.code, state: authorization.state }),
              cookies: { [SSO_TRANSACTION_COOKIE]: transaction },
            })
            .then((response) => response);
          await bounded(
            Promise.race([
              race.authorized.promise,
              pendingCallback.then(() => {
                throw new Error('callback missed its transactional authorization barrier');
              }),
            ]),
            'callback did not reach transactional authorization',
          );
          assert.equal(race.settingsReads, 1);
          assert.equal(race.session, null, 'the session has not been inserted yet');
          race.resumeSaveRead.release();
          await bounded(race.saveReadResumed.promise, 'concurrent settings read did not resume');
          // Pooled stores can finish the outer read and enqueue the real save.
          // SQLite gates that read until the open callback transaction commits.
          if (target.store.driver !== 'sqlite') {
            await bounded(
              Promise.race([
                race.saveQueued.promise,
                pendingSave.then(() => {
                  throw new Error('settings save finished without reaching its transaction');
                }),
              ]),
              'settings save did not enqueue its transaction',
            );
          }
          assert.equal(saveCompleted, false, 'settings cannot complete while callback is paused');
          assert.equal(race.saveBodyRuns, 0, 'settings body waits behind the callback transaction');
          assert.equal(race.callbackCommitted, false);
          race.resumeCallback.release();

          const callback = await bounded(pendingCallback, 'callback did not finish');
          assert.equal(callback.statusCode, 302, callback.body);
          assert.equal(
            new URL(String(callback.headers.location)).searchParams.get('sso_error'),
            null,
          );
          const token = cookieValue(callback, SESSION_COOKIE);
          assert.ok(token, 'the authorized callback returned a session cookie');
          const saved = await bounded(pendingSave, 'settings save did not finish after callback');
          assert.equal(saved.statusCode, 200, saved.body);
          assert.equal(race.saveBodyRuns, 1, 'the real settings transaction ran');
          const session = observedSession(race);
          assert.ok(session, 'the callback issued a real session');
          assert.equal(
            (await h.store.sessions.findByTokenHash(h.app.nexus.crypto.hashToken(token)))?.id,
            session.id,
            'the returned cookie opens the committed session after retirement',
          );
          const me = await h.app.inject({
            method: 'GET',
            url: '/api/auth/me',
            cookies: { [SESSION_COOKIE]: token },
          });
          assert.equal(me.statusCode, 200, me.body);
          assert.equal(me.json<MeResponse>().user.id, account.user.id);
          assert.equal(me.json<MeResponse>().user.role, 'client');
          assert.equal(me.json<MeResponse>().user.status, 'active');
          const logins = (await h.auditRows(AuditAction.AUTH_SSO_LOGIN)).filter(
            (row) => row.target_id === account.user.id,
          );
          assert.equal(logins.length, 1);
          assert.equal(logins[0]?.details.identity_id, identity.id, 'used the existing identity');
          assert.equal(logins[0]?.details.provider_id, provider.id);
          assert.equal(logins[0]?.details.subject, subject);
          const stored = await readStoredSsoSettings(h.store);
          assert.deepEqual(stored.providers, retiredProviders);
          const savedProviders = saved.json<SsoAdminSettingsResponse>().providers;
          assert.deepEqual(
            savedProviders.map(({ id, enabled }) => ({ id, enabled })),
            change === 'remove' ? [] : [{ id: provider.id, enabled: false }],
          );
          const publicConfig = await h.app.inject({ method: 'GET', url: '/api/auth/sso' });
          assert.equal(publicConfig.statusCode, 200, publicConfig.body);
          assert.deepEqual(publicConfig.json<SsoPublicConfigResponse>().providers, []);
          const identities = await h.store.userIdentities.listByUser(account.user.id);
          assert.equal(identities.length, change === 'remove' ? 0 : 1);
          if (change === 'disable') {
            assert.equal(identities[0]?.id, identity.id);
            assert.notEqual(identities[0]?.last_login_at, identity.last_login_at);
          }
        } finally {
          race.resumeSaveRead.release();
          race.resumeCallback.release();
          try {
            await bounded(
              Promise.allSettled([pendingSave, ...(pendingCallback ? [pendingCallback] : [])]),
              'SSO retirement requests did not settle during cleanup',
            );
          } finally {
            watch = null;
          }
        }
      });
    }
  });
}
