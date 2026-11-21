/**
 * Returning SSO authorization and retirement ordering: over one production
 * store, and across two instances that share one database.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type { LightMyRequestResponse } from 'fastify';

import {
  SESSION_COOKIE,
  SSO_TRANSACTION_COOKIE,
  type SsoAdminSettingsResponse,
  type SsoProviderSettings,
  type SsoPublicConfigResponse,
} from '@ferrum-nexus/shared';

import { AuditAction } from '../audit/service.js';
import type { LeaseRepo, NexusStore, SessionRecord, TransactionOptions } from '../db/store.js';
import { isoInSeconds, newId } from '../lib/ids.js';
import { SSO_SETTINGS_LOCK_KEY, ssoProviderLockKey } from '../lib/keyed-serializer.js';
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
  /** The save took `sso:settings`: next it queues for the provider key the callback holds. */
  saveHoldsSettingsKey: ReturnType<typeof barrier>;
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
  const leases = new Proxy(base.leases, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property);
      if (property !== 'acquire') {
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async (...args: Parameters<LeaseRepo['acquire']>): Promise<boolean> => {
        const taken = await target.acquire(...args);
        const watch = current();
        if (taken && watch && args[0] === SSO_SETTINGS_LOCK_KEY)
          watch.saveHoldsSettingsKey.release();
        return taken;
      };
    },
  });
  return new Proxy(base, {
    get(target, property) {
      if (property === 'settings') return settings;
      if (property === 'leases') return leases;
      if (property === 'transaction') {
        return async <T>(
          fn: (tx: NexusStore) => Promise<T>,
          options?: TransactionOptions,
        ): Promise<T> => {
          const watch = current();
          if (!watch) return target.transaction(fn, options);
          const callback = !watch.callbackTransactionStarted;
          watch.callbackTransactionStarted = true;
          const result = await target.transaction(async (tx) => {
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
          }, options);
          if (callback) watch.callbackCommitted = true;
          return result;
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

interface RetirementTarget {
  store: NexusStore;
  teardown: () => Promise<void>;
  /** A second store over the same database: another instance. Absent for SQLite. */
  peer?: () => Promise<NexusStore>;
}

interface PeerRace {
  /** The account whose session insert is held, inside the callback's transaction. */
  userId: string;
  callbackHeld: ReturnType<typeof barrier>;
  resumeCallback: ReturnType<typeof barrier>;
  /** The lease key the peer's save is expected to wait for. */
  waitKey: string;
  saveWaiting: ReturnType<typeof barrier>;
  session: SessionRecord | null;
}

/**
 * Hold the returning callback on the first instance just before it inserts its
 * session: after its transactional settings re-read, with its transaction open
 * and whatever keys it takes held.
 */
function holdSessionInsert(base: NexusStore, current: () => PeerRace | null): NexusStore {
  function scoped(tx: NexusStore, race: PeerRace): NexusStore {
    const sessions = new Proxy(tx.sessions, {
      get(target, property) {
        if (property === 'create') {
          return async (...args: Parameters<typeof target.create>) => {
            if (args[0].user_id === race.userId && race.session === null) {
              race.callbackHeld.release();
              await bounded(race.resumeCallback.promise, 'returning callback was not released');
            }
            const session = await target.create(...args);
            if (args[0].user_id === race.userId) race.session = session;
            return session;
          };
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return new Proxy(tx, {
      get(target, property) {
        if (property === 'sessions') return sessions;
        const value: unknown = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }
  return new Proxy(base, {
    get(target, property) {
      if (property === 'transaction') {
        return <T>(
          fn: (tx: NexusStore) => Promise<T>,
          options?: TransactionOptions,
        ): Promise<T> => {
          const race = current();
          if (!race) return target.transaction(fn, options);
          return target.transaction((tx) => fn(scoped(tx, race)), options);
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** Report the second instance's refused attempts at the key it is expected to wait for. */
function reportLeaseWaits(base: NexusStore, current: () => PeerRace | null): NexusStore {
  const leases = new Proxy(base.leases, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property);
      if (property !== 'acquire') {
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async (...args: Parameters<LeaseRepo['acquire']>): Promise<boolean> => {
        const taken = await target.acquire(...args);
        const race = current();
        if (!taken && race && args[0] === race.waitKey) race.saveWaiting.release();
        return taken;
      };
    },
  });
  return new Proxy(base, {
    get(target, property) {
      if (property === 'leases') return leases;
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function runSsoRetirementContract(
  label: string,
  makeStore: () => Promise<RetirementTarget>,
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
          saveHoldsSettingsKey: barrier(),
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
          // The callback holds the provider's key across its transaction, so
          // on every driver the save waits for that key before it can open
          // its own transaction. A pooled store lets the save finish its
          // outer read and take `sso:settings`, the key it holds while it
          // queues for the provider's; SQLite gates that read until the open
          // callback transaction commits.
          if (target.store.driver !== 'sqlite') {
            await bounded(
              Promise.race([
                race.saveHoldsSettingsKey.promise,
                pendingSave.then(() => {
                  throw new Error('settings save finished while the callback held its key');
                }),
              ]),
              'settings save did not reach its keys',
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
          // #515 orders the callback commit before retirement; it does not
          // keep the issued session valid. Retirement (#591) revokes every
          // session of the affected account, this just-committed one too.
          assert.equal(
            (await h.store.sessions.findByTokenHash(h.app.nexus.crypto.hashToken(token)))?.id,
            undefined,
            'retirement revokes the session the ordered callback committed',
          );
          const me = await h.app.inject({
            method: 'GET',
            url: '/api/auth/me',
            cookies: { [SESSION_COOKIE]: token },
          });
          assert.equal(me.statusCode, 401, me.body);
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

  // Two instances over one database: PostgreSQL, MySQL and MongoDB. SQLite is
  // one in-memory connection and cannot have a second instance.
  describe(`returning SSO retirement across two instances — ${label}`, { timeout: 60_000 }, () => {
    let target: RetirementTarget;
    let peer: NexusStore | null = null;
    let first: TestApp | null = null;
    let second: TestApp | null = null;
    let founder: TestSession;
    let idp: MockOidcProvider | null = null;
    let race: PeerRace | null = null;

    before(async () => {
      target = await makeStore();
      if (!target.peer) return;
      peer = await target.peer();
      idp = createMockOidcProvider({ clientId: 'retirement-peer', clientSecret: null });
      await idp.start();
      const env = { NEXUS_OIDC_ALLOW_HTTP_LOOPBACK: 'true', NEXUS_OIDC_PROVIDERS: '[]' };
      first = await buildTestApp({
        store: target.store,
        env,
        wrapStore: (store) => holdSessionInsert(store, () => race),
      });
      const peerStore = peer;
      second = await buildTestApp({
        store: peerStore,
        edge: first.edge,
        env,
        wrapStore: (store) => reportLeaseWaits(store, () => race),
      });
      founder = await first.registerUser();
    });

    after(async () => {
      // Each resource is released even when an earlier release fails.
      const failures: unknown[] = [];
      for (const release of [
        () => second?.close(),
        () => first?.close(),
        () => idp?.stop(),
        () => peer?.close(),
        () => target?.teardown(),
      ]) {
        try {
          await release();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) throw failures[0];
    });

    for (const change of ['disable', 'remove', 'local_only'] as const) {
      it(`revokes a returning session a peer's ${change} raced with`, async (t) => {
        if (!first || !second || !idp) {
          t.skip('needs a second instance over the same database');
          return;
        }
        const a = first;
        const b = second;
        const providerId = `retirement-peer-${change.replace('_', '-')}`;
        const provider: SsoProviderSettings = {
          id: providerId,
          display_name: 'Retirement peer',
          issuer: idp.issuer,
          client_id: 'retirement-peer',
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
        const configured = await a.authed(founder, {
          method: 'PUT',
          url: '/api/admin/sso',
          payload: { policy: 'local_and_sso', providers: [provider] },
        });
        assert.equal(configured.statusCode, 200, configured.body);
        const account = await a.registerUser();
        const subject = newId();
        await a.store.userIdentities.create({
          user_id: account.user.id,
          provider_id: provider.id,
          issuer: provider.issuer,
          subject,
          email: account.user.email,
          provisioned: false,
          last_login_at: isoInSeconds(-3600),
        });
        const start = await a.app.inject({
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

        const current: PeerRace = {
          userId: account.user.id,
          callbackHeld: barrier(),
          resumeCallback: barrier(),
          waitKey: ssoProviderLockKey(provider.id),
          saveWaiting: barrier(),
          session: null,
        };
        race = current;
        let pendingSave: Promise<LightMyRequestResponse> | undefined;
        let saveCompleted = false;
        const pendingCallback = a.app
          .inject({
            method: 'GET',
            url:
              `/api/auth/sso/${provider.id}/callback?` +
              new URLSearchParams({ code: authorization.code, state: authorization.state }),
            cookies: { [SSO_TRANSACTION_COOKIE]: transaction },
          })
          .then((response) => response);
        try {
          await bounded(
            Promise.race([
              current.callbackHeld.promise,
              pendingCallback.then(() => {
                throw new Error('callback finished without reaching its session insert');
              }),
            ]),
            'callback did not reach its session insert',
          );
          // The callback has passed its settings re-read and holds its
          // transaction open. The peer instance now retires the provider.
          const payload =
            change === 'local_only'
              ? { policy: 'local_only' }
              : { providers: change === 'remove' ? [] : [{ ...provider, enabled: false }] };
          pendingSave = b
            .authed(founder, { method: 'PUT', url: '/api/admin/sso', payload })
            .then((response) => {
              saveCompleted = true;
              return response;
            });
          // Without the provider key around the callback's commit, the peer's
          // save commits here and revokes nothing the callback has not yet
          // written; the callback then commits a live session.
          await bounded(
            Promise.race([
              current.saveWaiting.promise,
              pendingSave.then((response) => {
                throw new Error(
                  `the peer's save finished while the callback held its transaction: ` +
                    `${response.statusCode} ${response.body}`,
                );
              }),
            ]),
            "the peer's save did not wait for the callback's provider key",
          );
          assert.equal(saveCompleted, false);
          assert.equal(current.session, null, 'the session has not been inserted yet');
          current.resumeCallback.release();

          const callback = await bounded(pendingCallback, 'callback did not finish');
          assert.equal(callback.statusCode, 302, callback.body);
          assert.equal(
            new URL(String(callback.headers.location)).searchParams.get('sso_error'),
            null,
          );
          const token = cookieValue(callback, SESSION_COOKIE);
          assert.ok(token, 'the callback committed before the save and issued a session');
          const saved = await bounded(pendingSave, "the peer's save did not finish");
          assert.equal(saved.statusCode, 200, saved.body);

          // The save ran after the callback committed, so it revoked that session.
          const hash = a.app.nexus.crypto.hashToken(token);
          assert.equal(await target.store.sessions.findByTokenHash(hash), null);
          for (const instance of [a, b]) {
            const me: LightMyRequestResponse = await instance.app.inject({
              method: 'GET',
              url: '/api/auth/me',
              cookies: { [SESSION_COOKIE]: token },
            });
            assert.equal(me.statusCode, 401, me.body);
          }
          const update = (await b.auditRows(AuditAction.ADMIN_SETTINGS_UPDATE))
            .filter((row) => row.target_id === SSO_SETTINGS_KEY)
            .find((row) => {
              const cutOff = row.details.providers_cut_off;
              return Array.isArray(cutOff) && cutOff.includes(provider.id);
            });
          assert.ok(update, 'the save audited the provider it cut off');
          assert.ok(Number(update.details.sessions_revoked) >= 1);
        } finally {
          current.resumeCallback.release();
          try {
            await bounded(
              Promise.allSettled([pendingCallback, ...(pendingSave ? [pendingSave] : [])]),
              'cross-instance SSO retirement requests did not settle during cleanup',
            );
          } finally {
            race = null;
          }
        }
      });
    }
  });
}
