/**
 * Cross-adapter behavioural suite.
 *
 * {@link runSmokeSuite} is written once against the {@link NexusStore} contract
 * and run against every adapter, so "the four adapters behave identically" is a
 * thing the test run proves rather than a thing the docs assert.
 *
 * - **sqlite** always runs, against `:memory:`.
 * - **postgres / mysql / mongodb** run when `NEXUS_TEST_POSTGRES_URL`,
 *   `NEXUS_TEST_MYSQL_URL` or `NEXUS_TEST_MONGO_URL` is set, and are reported as
 *   skipped otherwise. Each one provisions a **throwaway database** with a
 *   random name and drops it afterwards, so pointing the variables at a real
 *   server never touches an existing database.
 *
 * The MongoDB URL must address a replica set (single-node is fine): the
 * rollback and nested-transaction cases exercise real multi-document
 * transactions, which a standalone `mongod` cannot provide.
 * `NEXUS_TEST_MONGO_STANDALONE_URL` opts into the separate check that a
 * standalone deployment is *rejected* at `init()`.
 *
 * ```bash
 * NEXUS_TEST_POSTGRES_URL=postgres://postgres:pw@127.0.0.1:5432/postgres \
 * NEXUS_TEST_MYSQL_URL=mysql://root:pw@127.0.0.1:3306/mysql \
 * NEXUS_TEST_MONGO_URL=mongodb://127.0.0.1:27017/?replicaSet=rs0 \
 *   npx tsx --test src/test/smoke.test.ts
 * ```
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import { MongoClient } from 'mongodb';
import mysql from 'mysql2/promise';
import pg from 'pg';

import type { DbDriver } from '@ferrum-nexus/shared';

import { loadConfig } from '../config/index.js';
import { createStore } from '../db/index.js';
import type { NexusStore, UserRecord } from '../db/store.js';
import { isNexusError } from '../lib/errors.js';
import { isoInSeconds, newId, nowIso } from '../lib/ids.js';

const SECRET = 'cross-adapter-smoke-secret-0123456789ab';

/** A store plus whatever needs tearing down after the suite. */
interface SmokeTarget {
  store: NexusStore;
  teardown: () => Promise<void>;
}

function testConfig(driver: DbDriver, url = ''): ReturnType<typeof loadConfig> {
  return loadConfig({
    NEXUS_SECRET_KEY: SECRET,
    FERRUM_ADMIN_JWT_SECRET: SECRET,
    NEXUS_ENV: 'test',
    NEXUS_DB_DRIVER: driver,
    NEXUS_DB_URL: url,
    NEXUS_SQLITE_PATH: ':memory:',
  });
}

/** A fresh, syntactically safe database name for a throwaway database. */
function throwawayDbName(): string {
  return `nexus_smoke_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

/** Replace the database component of a connection URL. */
function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/* ── Targets ────────────────────────────────────────────────────────────── */

async function sqliteTarget(): Promise<SmokeTarget> {
  const store = createStore(testConfig('sqlite'));
  await store.init();
  await store.migrate();
  return { store, teardown: () => store.close() };
}

async function postgresTarget(adminUrl: string): Promise<SmokeTarget> {
  const database = throwawayDbName();
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${database}"`);
  await admin.end();

  const store = createStore(testConfig('postgres', withDatabase(adminUrl, database)));
  await store.init();
  await store.migrate();

  return {
    store,
    teardown: async (): Promise<void> => {
      await store.close();
      const cleaner = new pg.Client({ connectionString: adminUrl });
      await cleaner.connect();
      await cleaner.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      await cleaner.end();
    },
  };
}

async function mysqlTarget(adminUrl: string): Promise<SmokeTarget> {
  const database = throwawayDbName();
  const admin = await mysql.createConnection(adminUrl);
  await admin.query(`CREATE DATABASE \`${database}\``);
  await admin.end();

  const store = createStore(testConfig('mysql', withDatabase(adminUrl, database)));
  await store.init();
  await store.migrate();

  return {
    store,
    teardown: async (): Promise<void> => {
      await store.close();
      const cleaner = await mysql.createConnection(adminUrl);
      await cleaner.query(`DROP DATABASE IF EXISTS \`${database}\``);
      await cleaner.end();
    },
  };
}

async function mongoTarget(baseUrl: string): Promise<SmokeTarget> {
  const database = throwawayDbName();
  const store = createStore(testConfig('mongodb', withDatabase(baseUrl, database)));
  await store.init();
  await store.migrate();

  return {
    store,
    teardown: async (): Promise<void> => {
      await store.close();
      const cleaner = new MongoClient(withDatabase(baseUrl, database));
      try {
        await cleaner.connect();
        await cleaner.db(database).dropDatabase();
      } finally {
        await cleaner.close();
      }
    },
  };
}

/* ── The suite ──────────────────────────────────────────────────────────── */

/**
 * Every behaviour the {@link NexusStore} contract promises, exercised against
 * whatever `makeStore` returns.
 */
function runSmokeSuite(label: string, makeStore: () => Promise<SmokeTarget>): void {
  describe(`store contract — ${label}`, () => {
    let target: SmokeTarget;
    let store: NexusStore;

    before(async () => {
      target = await makeStore();
      store = target.store;
    });

    after(async () => {
      await target.teardown();
    });

    /* ── helpers ──────────────────────────────────────────────────────── */

    async function makeUser(overrides: Partial<UserRecord> = {}): Promise<UserRecord> {
      return store.users.create({
        email: overrides.email ?? `${newId()}@example.test`,
        password_hash: 'scrypt:16384:8:1:c2FsdA==:aGFzaA==',
        display_name: overrides.display_name ?? 'Test User',
        role: overrides.role ?? 'client',
        status: overrides.status ?? 'active',
        email_verified: overrides.email_verified ?? false,
        ...(overrides.org_id !== undefined ? { org_id: overrides.org_id } : {}),
        ...(overrides.created_at !== undefined ? { created_at: overrides.created_at } : {}),
      });
    }

    async function makeApi(
      ownerId: string,
      overrides: { requestable?: boolean; slug?: string } = {},
    ): Promise<{ id: string; slug: string }> {
      const slug = overrides.slug ?? `api-${newId().slice(0, 8)}`;
      const api = await store.apis.create({
        name: 'Smoke API',
        slug,
        owner_user_id: ownerId,
        namespace: 'nexus',
        version: '1.0.0',
        spec_format: 'openapi',
        requestable: overrides.requestable ?? true,
        auth_plugin: 'key_auth',
        status: 'published',
        visibility: 'public',
      });
      return { id: api.id, slug: api.slug };
    }

    /* ── migrations ───────────────────────────────────────────────────── */

    it('migrations are idempotent', async () => {
      await store.migrate();
      await store.migrate();
      const user = await makeUser();
      assert.ok(user.id, 'the schema is still usable after re-running migrations');
    });

    it('reports healthy', async () => {
      const health = await store.healthCheck();
      assert.equal(health.ok, true);
      assert.equal(health.error, null);
      assert.ok(health.latencyMs >= 0);
      assert.ok(['sqlite', 'postgres', 'mysql', 'mongodb'].includes(store.driver));
    });

    /* ── users ────────────────────────────────────────────────────────── */

    it('users: creates, lowercases the email, finds and updates', async () => {
      const created = await makeUser({
        email: `Mixed.Case-${newId().slice(0, 8)}@Example.Test`,
        display_name: 'Alice',
      });
      assert.equal(created.email, created.email.toLowerCase(), 'email is lowercased on write');
      assert.equal(created.email_verified, false, 'booleans cross the boundary as booleans');

      assert.deepEqual(await store.users.findById(created.id), created);
      assert.deepEqual(await store.users.findByEmail(created.email.toUpperCase()), created);
      assert.equal(await store.users.findByEmail('nobody@example.test'), null);
      assert.equal(await store.users.findById(newId()), null);

      const updated = await store.users.update(created.id, {
        display_name: 'Alice B',
        email_verified: true,
      });
      assert.equal(updated?.display_name, 'Alice B');
      assert.equal(updated?.email_verified, true, 'booleans survive the round trip');
      assert.equal(await store.users.update(newId(), { display_name: 'ghost' }), null);

      const many = await store.users.findManyByIds([created.id, newId()]);
      assert.equal(many.length, 1);
      assert.deepEqual(await store.users.findManyByIds([]), []);
    });

    it('users: rejects a duplicate email with CONFLICT, case-insensitively', async () => {
      const email = `dupe-${newId().slice(0, 8)}@example.test`;
      await makeUser({ email });
      await assert.rejects(
        () => makeUser({ email: email.toUpperCase() }),
        (error: unknown) => isNexusError(error) && error.code === 'CONFLICT',
      );
    });

    it('users: counts active super admins, honouring the exclusion', async () => {
      const baseline = await store.users.countActiveSuperAdmins();
      const boss = await makeUser({ role: 'super_admin' });
      assert.equal(await store.users.countActiveSuperAdmins(), baseline + 1);
      assert.equal(await store.users.countActiveSuperAdmins(boss.id), baseline);

      await store.users.update(boss.id, { status: 'disabled' });
      assert.equal(await store.users.countActiveSuperAdmins(), baseline);
    });

    it('users: updateIfMatches applies only while the row still matches', async () => {
      const user = await makeUser({ role: 'super_admin' });

      assert.equal(
        await store.users.updateIfMatches(user.id, { role: 'admin' }, { role: 'client' }),
        null,
        'a stale expectation loses',
      );
      assert.equal(
        (await store.users.findById(user.id))?.role,
        'super_admin',
        'and writes nothing at all',
      );
      assert.equal(
        await store.users.updateIfMatches(newId(), {}, { role: 'client' }),
        null,
        'a missing row is a loss, not a throw',
      );

      const won = await store.users.updateIfMatches(
        user.id,
        { role: 'super_admin', status: 'active' },
        { role: 'client', display_name: 'Demoted' },
      );
      assert.equal(won?.role, 'client');
      assert.equal(won?.display_name, 'Demoted');
      assert.deepEqual(await store.users.findById(user.id), won, 'the winner gets the stored row');
    });

    it('users: the last-super-admin rule survives two demotions at once', async () => {
      // The invariant here is "never fewer active super admins than the suite
      // started with, plus one", which keeps the test independent of whatever
      // else the suite has created.
      const baseline = await store.users.countActiveSuperAdmins();

      /**
       * The shape `users.updateUser` and god mode's `disable-user` both use:
       * count and conditional write inside one transaction body. Counting
       * outside one is what let two administrators demote each other and leave
       * the portal with none.
       */
      async function demote(target: UserRecord): Promise<'demoted' | 'refused'> {
        return store.transaction(async (tx) => {
          if ((await tx.users.countActiveSuperAdmins(target.id)) <= baseline) return 'refused';
          const updated = await tx.users.updateIfMatches(
            target.id,
            { role: target.role, status: target.status },
            { role: 'client' },
          );
          return updated ? 'demoted' : 'refused';
        });
      }

      const first = await makeUser({ role: 'super_admin' });
      const second = await makeUser({ role: 'super_admin' });
      assert.deepEqual(
        (await Promise.all([demote(first), demote(second)])).sort(),
        ['demoted', 'refused'],
        'serialised transaction bodies let exactly one demotion through',
      );
      assert.equal(
        await store.users.countActiveSuperAdmins(),
        baseline + 1,
        'and the survivor is still there',
      );

      // Leave the count as this test found it.
      await store.users.update(first.id, { role: 'client' });
      await store.users.update(second.id, { role: 'client' });
      assert.equal(await store.users.countActiveSuperAdmins(), baseline);
    });

    it('users: filters, paginates and reports the unpaginated total', async () => {
      const marker = `filter-${newId().slice(0, 8)}`;
      for (let i = 0; i < 5; i += 1) {
        await makeUser({ display_name: `${marker} ${i}`, role: 'provider' });
      }
      const first = await store.users.list(
        { q: marker, role: 'provider' },
        { limit: 2, offset: 0 },
      );
      assert.equal(first.items.length, 2);
      assert.equal(first.total, 5, 'total ignores pagination');

      const last = await store.users.list({ q: marker }, { limit: 2, offset: 4 });
      assert.equal(last.items.length, 1);

      assert.equal(await store.users.count({ q: marker }), 5);
      assert.equal((await store.users.listRecipients({ q: marker })).length, 5);
      assert.equal(
        (await store.users.listRecipients({ q: marker, roles: ['client'] })).length,
        0,
        'the roles filter is an IN list',
      );
      assert.equal(
        (await store.users.listRecipients({ q: marker, ids: [] })).length,
        0,
        'an empty id list matches nothing',
      );
      assert.equal((await store.users.list({ q: marker, email_verified: true })).total, 0);
    });

    it('users: touches last_login_at without rewriting the row', async () => {
      const user = await makeUser();
      const at = nowIso();
      await store.users.touchLastLogin(user.id, at);
      const reloaded = await store.users.findById(user.id);
      assert.equal(reloaded?.last_login_at, at);
      assert.equal(reloaded?.display_name, user.display_name);
    });

    /* ── organizations ────────────────────────────────────────────────── */

    it('organizations: unique case-insensitive names, lookup, update and delete', async () => {
      const name = `Acme-${newId().slice(0, 8)}`;
      const org = await store.organizations.create({ name, description: 'first' });
      assert.deepEqual(await store.organizations.findByName(name.toUpperCase()), org);

      await assert.rejects(
        () => store.organizations.create({ name: name.toLowerCase() }),
        (error: unknown) => isNexusError(error) && error.code === 'CONFLICT',
      );

      const renamed = await store.organizations.create({ name: `Other-${newId().slice(0, 8)}` });
      const updated = await store.organizations.update(renamed.id, { description: 'second' });
      assert.equal(updated?.description, 'second');

      const member = await makeUser({ org_id: org.id });
      assert.equal((await store.users.list({ org_id: org.id })).total, 1);
      assert.equal(
        (await store.users.list({ org_id: null })).total >= 1,
        true,
        'a null org filter matches unaffiliated users',
      );
      assert.equal(member.org_id, org.id);

      assert.ok((await store.organizations.list({ limit: 100 })).total >= 2);
      assert.equal(await store.organizations.delete(renamed.id), true);
      assert.equal(await store.organizations.delete(renamed.id), false);
    });

    /* ── sessions ─────────────────────────────────────────────────────── */

    it('sessions: create, hash lookup, sliding expiry and deletion', async () => {
      const user = await makeUser();
      const session = await store.sessions.create({
        token_hash: `hash-${newId()}`,
        user_id: user.id,
        csrf_token: 'csrf',
        expires_at: isoInSeconds(60),
        ip: '127.0.0.1',
        user_agent: 'smoke',
      });
      assert.deepEqual(await store.sessions.findByTokenHash(session.token_hash), session);

      const later = isoInSeconds(600);
      await store.sessions.touch(session.id, later);
      assert.equal((await store.sessions.findById(session.id))?.expires_at, later);

      await assert.rejects(
        () =>
          store.sessions.create({
            token_hash: session.token_hash,
            user_id: user.id,
            csrf_token: 'csrf',
            expires_at: isoInSeconds(60),
          }),
        (error: unknown) => isNexusError(error) && error.code === 'CONFLICT',
      );

      assert.equal(await store.sessions.deleteByTokenHash(session.token_hash), true);
      assert.equal(await store.sessions.delete(session.id), false);
    });

    it('sessions: bulk deletion by user and by expiry', async () => {
      const user = await makeUser();
      for (let i = 0; i < 3; i += 1) {
        await store.sessions.create({
          token_hash: `expired-${newId()}`,
          user_id: user.id,
          csrf_token: 'csrf',
          expires_at: isoInSeconds(-10),
        });
      }
      assert.equal(await store.sessions.deleteExpired(nowIso()), 3);

      await store.sessions.create({
        token_hash: `live-${newId()}`,
        user_id: user.id,
        csrf_token: 'csrf',
        expires_at: isoInSeconds(600),
      });
      assert.equal(await store.sessions.deleteForUser(user.id), 1);
    });

    /* ── apis and specs ───────────────────────────────────────────────── */

    it('apis: structured rate limits, slug uniqueness and filters', async () => {
      const owner = await makeUser({ role: 'provider' });
      const slug = `billing-${newId().slice(0, 8)}`;
      const api = await store.apis.create({
        name: 'Billing',
        slug,
        description: 'Invoices and payments',
        owner_user_id: owner.id,
        ferrum_proxy_id: `proxy-${newId().slice(0, 8)}`,
        namespace: 'nexus',
        version: '1.0.0',
        spec_format: 'openapi',
        requestable: true,
        auth_plugin: 'key_auth',
        rate_limit: { limit: 60, window_seconds: 60 },
        status: 'published',
        visibility: 'public',
      });
      assert.deepEqual(
        api.rate_limit,
        { limit: 60, window_seconds: 60 },
        'structured columns cross the boundary parsed',
      );
      assert.equal(api.requestable, true);

      assert.deepEqual(await store.apis.findBySlug(slug.toUpperCase()), api);
      assert.deepEqual(await store.apis.findByProxyId(api.ferrum_proxy_id ?? ''), api);

      await assert.rejects(
        () => makeApi(owner.id, { slug: slug.toUpperCase() }),
        (error: unknown) => isNexusError(error) && error.code === 'CONFLICT',
      );

      const cleared = await store.apis.update(api.id, { rate_limit: null });
      assert.equal(cleared?.rate_limit, null);

      // Two APIs with no proxy id must coexist — the uniqueness rule is partial.
      const bare1 = await makeApi(owner.id);
      const bare2 = await makeApi(owner.id);
      assert.notEqual(bare1.id, bare2.id);

      assert.deepEqual(await store.apis.listIdsByOwner(owner.id).then((ids) => ids.length), 3);
      assert.equal((await store.apis.list({ q: 'invoices' })).total, 1);
      assert.equal(await store.apis.count({ owner_user_id: owner.id, requestable: true }), 3);
      assert.equal((await store.apis.list({ ids: [api.id] })).total, 1);
      assert.equal((await store.apis.findManyByIds([api.id, bare1.id])).length, 2);

      assert.equal(await store.apis.delete(bare2.id), true);
      assert.equal(await store.apis.delete(bare2.id), false);
    });

    it('apiSpecs: keeps exactly one current revision per API', async () => {
      const owner = await makeUser({ role: 'provider' });
      const api = await makeApi(owner.id);

      const v1 = await store.apiSpecs.create({
        api_id: api.id,
        version: '1',
        raw_spec: 'openapi: 3.0.0',
        parsed_title: 'V1',
        is_current: true,
      });
      const v2 = await store.apiSpecs.create({
        api_id: api.id,
        version: '2',
        raw_spec: 'openapi: 3.1.0',
        is_current: true,
      });
      assert.equal(
        (await store.apiSpecs.findCurrentByApi(api.id))?.id,
        v2.id,
        'creating a current revision demotes the previous one',
      );

      await store.apiSpecs.setCurrent(api.id, v1.id);
      assert.equal((await store.apiSpecs.findCurrentByApi(api.id))?.id, v1.id);
      assert.equal((await store.apiSpecs.list({ api_id: api.id })).total, 2);
      assert.equal((await store.apiSpecs.list({ api_id: api.id, is_current: true })).total, 1);
      assert.equal((await store.apiSpecs.findById(v1.id))?.parsed_title, 'V1');

      assert.equal(await store.apiSpecs.delete(v2.id), true);
      assert.equal(await store.apiSpecs.deleteByApi(api.id), 1);
    });

    it('apiSpecs: a revision that fails to insert leaves the previous one current', async () => {
      const owner = await makeUser({ role: 'provider' });
      const api = await makeApi(owner.id);

      const current = await store.apiSpecs.create({
        api_id: api.id,
        version: '1',
        raw_spec: 'openapi: 3.0.0',
        is_current: true,
      });

      // Demoting the old revision and inserting the new one is one swap, so it
      // has to be one transaction. Pinning an id that already exists makes the
      // insert half fail; without a transaction the demotion has already
      // landed and the API is left with no current spec at all.
      await assert.rejects(
        () =>
          store.apiSpecs.create({
            id: current.id,
            api_id: api.id,
            version: '2',
            raw_spec: 'openapi: 3.1.0',
            is_current: true,
          }),
        (error: unknown) => isNexusError(error) && error.code === 'CONFLICT',
      );

      const still = await store.apiSpecs.findCurrentByApi(api.id);
      assert.equal(still?.id, current.id, 'the failed swap rolled back in full');
      assert.equal((await store.apiSpecs.list({ api_id: api.id })).total, 1);
    });

    /* ── access requests ──────────────────────────────────────────────── */

    it('accessRequests: one pending request per api/user pair', async () => {
      const owner = await makeUser({ role: 'provider' });
      const client = await makeUser();
      const api = await makeApi(owner.id);

      const request = await store.accessRequests.create({
        api_id: api.id,
        user_id: client.id,
        justification: 'please',
        status: 'pending',
        created_at: isoInSeconds(-120),
      });
      assert.deepEqual(
        await store.accessRequests.findPendingByApiAndUser(api.id, client.id),
        request,
      );

      await assert.rejects(
        () =>
          store.accessRequests.create({
            api_id: api.id,
            user_id: client.id,
            justification: 'again',
            status: 'pending',
          }),
        (error: unknown) => isNexusError(error) && error.code === 'CONFLICT',
      );

      // Deciding the request frees the slot for a fresh one.
      await store.accessRequests.update(request.id, {
        status: 'denied',
        decided_by: owner.id,
        decided_at: nowIso(),
        decision_note: 'not yet',
      });
      assert.equal(await store.accessRequests.findPendingByApiAndUser(api.id, client.id), null);

      const reopened = await store.accessRequests.create({
        api_id: api.id,
        user_id: client.id,
        justification: 'trying again',
        status: 'pending',
        created_at: isoInSeconds(-10),
      });

      const latest = await store.accessRequests.findLatestByApiAndUser(api.id, client.id);
      assert.equal(latest?.id, reopened.id, 'latest is the newest regardless of status');

      const perApi = await store.accessRequests.listLatestForUser(client.id, [api.id]);
      assert.equal(perApi.length, 1, 'one row per API even with several requests');
      assert.equal(perApi[0]?.id, reopened.id);
      assert.deepEqual(await store.accessRequests.listLatestForUser(client.id, []), []);

      assert.equal(await store.accessRequests.updateIfStatus(reopened.id, 'approved', {}), null);
      assert.equal(await store.accessRequests.count({ api_id: api.id }), 2);
      assert.equal(await store.accessRequests.count({ api_ids: [api.id], status: 'denied' }), 1);
      assert.equal((await store.accessRequests.list({ user_id: client.id })).total, 2);
      assert.equal(await store.accessRequests.deleteByApi(api.id), 2);
    });

    it('accessRequests: exactly one concurrent decision wins the pending status', async () => {
      const owner = await makeUser({ role: 'provider' });
      const client = await makeUser();
      const api = await makeApi(owner.id);
      const request = await store.accessRequests.create({
        api_id: api.id,
        user_id: client.id,
        justification: 'please',
        status: 'pending',
      });

      // Approve and cancel arrive together, each holding the same `pending`
      // read. Nothing serialises them — the predicate on the update is the only
      // arbiter, exactly as it has to be when the two decisions come from two
      // different sessions.
      const outcomes = await Promise.all([
        store.accessRequests.updateIfStatus(request.id, 'pending', {
          status: 'approved',
          decided_by: owner.id,
          decided_at: nowIso(),
        }),
        store.accessRequests.updateIfStatus(request.id, 'pending', {
          status: 'cancelled',
          decided_by: client.id,
          decided_at: nowIso(),
        }),
      ]);
      const winners = outcomes.filter((outcome) => outcome !== null);
      assert.equal(winners.length, 1, 'exactly one decision may move a pending request');

      const stored = await store.accessRequests.findById(request.id);
      assert.equal(stored?.status, winners[0]?.status, 'and the winner is what was stored');
      assert.notEqual(stored?.status, 'pending');

      // A later attempt against the status it no longer has changes nothing.
      assert.equal(
        await store.accessRequests.updateIfStatus(request.id, 'pending', { status: 'denied' }),
        null,
      );
      assert.deepEqual(await store.accessRequests.findById(request.id), stored);
      assert.equal(
        await store.accessRequests.updateIfStatus(newId(), 'pending', { status: 'denied' }),
        null,
        'a missing row is a loss, not a throw',
      );
    });

    /* ── grants ───────────────────────────────────────────────────────── */

    it('grants: one active grant per api/user pair, freed by revocation', async () => {
      const owner = await makeUser({ role: 'provider' });
      const client = await makeUser();
      const api = await makeApi(owner.id);

      const grant = await store.grants.create({
        api_id: api.id,
        user_id: client.id,
        acl_group: `nexus:api:${api.id}:approved`,
        status: 'active',
        granted_by: owner.id,
      });
      assert.deepEqual(await store.grants.findActiveByApiAndUser(api.id, client.id), grant);

      await assert.rejects(
        () =>
          store.grants.create({
            api_id: api.id,
            user_id: client.id,
            acl_group: `nexus:api:${api.id}:approved`,
            status: 'active',
            granted_by: owner.id,
          }),
        (error: unknown) => isNexusError(error) && error.code === 'CONFLICT',
      );

      await store.grants.update(grant.id, {
        status: 'revoked',
        revoked_by: owner.id,
        revoked_at: nowIso(),
      });
      assert.equal(await store.grants.findActiveByApiAndUser(api.id, client.id), null);

      const regrant = await store.grants.create({
        api_id: api.id,
        user_id: client.id,
        acl_group: `nexus:api:${api.id}:approved`,
        status: 'active',
        granted_by: owner.id,
      });
      assert.equal(regrant.status, 'active');
      assert.equal((await store.grants.listActiveByApi(api.id)).length, 1);
      assert.equal((await store.grants.listActiveByUser(client.id)).length, 1);
      assert.equal(await store.grants.count({ user_id: client.id }), 2);
      assert.equal(await store.grants.count({ api_ids: [api.id], status: 'revoked' }), 1);
      assert.equal((await store.grants.list({ api_id: api.id })).total, 2);
      assert.equal(await store.grants.deleteByApi(api.id), 2);
    });

    /* ── consumers and credentials ────────────────────────────────────── */

    it('consumers: one mapping per user per namespace', async () => {
      const user = await makeUser();
      const consumer = await store.consumers.create({
        user_id: user.id,
        namespace: 'nexus',
        ferrum_consumer_id: user.id,
        ferrum_username: `nexus-user-${user.id}`,
      });
      assert.deepEqual(await store.consumers.findByUserAndNamespace(user.id, 'nexus'), consumer);
      assert.deepEqual(await store.consumers.findByFerrumId(user.id), consumer);
      assert.deepEqual(
        await store.consumers.findByUsername('nexus', consumer.ferrum_username),
        consumer,
      );

      await assert.rejects(
        () =>
          store.consumers.create({
            user_id: user.id,
            namespace: 'nexus',
            ferrum_consumer_id: `${user.id}-other`,
            ferrum_username: `nexus-user-${user.id}-other`,
          }),
        (error: unknown) => isNexusError(error) && error.code === 'CONFLICT',
      );

      // A second namespace is a different mapping and is allowed.
      const other = await store.consumers.create({
        user_id: user.id,
        namespace: 'staging',
        ferrum_consumer_id: `${user.id}-staging`,
        ferrum_username: `nexus-user-${user.id}`,
      });
      assert.equal((await store.consumers.list({ user_id: user.id })).total, 2);
      assert.equal((await store.consumers.list({ namespace: 'staging' })).total, 1);
      assert.equal(await store.consumers.delete(other.id), true);
    });

    it('credentials: unique fingerprints, consumer ordering and rotation links', async () => {
      const user = await makeUser();
      const first = await store.credentials.create({
        user_id: user.id,
        ferrum_consumer_id: user.id,
        credential_type: 'keyauth',
        ferrum_credential_id: 'keyauth:0',
        fingerprint: `fp-${newId()}`,
        last4: 'abcd',
        label: 'primary',
        status: 'active',
        created_at: isoInSeconds(-60),
      });
      assert.deepEqual(await store.credentials.findByFingerprint(first.fingerprint), first);

      await assert.rejects(
        () =>
          store.credentials.create({
            user_id: user.id,
            ferrum_consumer_id: user.id,
            credential_type: 'keyauth',
            ferrum_credential_id: 'keyauth:1',
            fingerprint: first.fingerprint,
            last4: 'abcd',
            status: 'active',
          }),
        (error: unknown) => isNexusError(error) && error.code === 'CONFLICT',
      );

      const second = await store.credentials.create({
        user_id: user.id,
        ferrum_consumer_id: user.id,
        credential_type: 'keyauth',
        ferrum_credential_id: 'keyauth:1',
        fingerprint: `fp-${newId()}`,
        last4: 'wxyz',
        status: 'active',
        rotated_from_id: first.id,
        created_at: isoInSeconds(-10),
      });

      const byConsumer = await store.credentials.listByConsumer(user.id, 'keyauth');
      assert.deepEqual(
        byConsumer.map((entry) => entry.id),
        [first.id, second.id],
        'oldest first, mirroring the Edge array order',
      );
      assert.equal((await store.credentials.listByConsumer(user.id)).length, 2);

      const retired = await store.credentials.update(first.id, { status: 'retiring' });
      assert.equal(retired?.status, 'retiring');
      assert.equal(await store.credentials.count({ user_id: user.id, status: 'active' }), 1);
      assert.equal(
        (await store.credentials.list({ ferrum_consumer_id: user.id, credential_type: 'keyauth' }))
          .total,
        2,
      );
      assert.equal(await store.credentials.delete(second.id), true);
      assert.equal(await store.credentials.delete(second.id), false);
    });

    /* ── threads and messages ─────────────────────────────────────────── */

    it('threads and messages: reuse, previews and cascade helper', async () => {
      const client = await makeUser();
      const provider = await makeUser({ role: 'provider' });
      const api = await makeApi(provider.id);

      const thread = await store.threads.create({
        subject: `Rate limits ${newId().slice(0, 6)}`,
        api_id: api.id,
        created_by: client.id,
        participant_a: client.id,
        participant_b: provider.id,
      });
      assert.deepEqual(await store.threads.findExisting(client.id, provider.id, api.id), thread);
      assert.deepEqual(
        await store.threads.findExisting(provider.id, client.id, api.id),
        thread,
        'participants are symmetric',
      );
      assert.equal(await store.threads.findExisting(client.id, provider.id, null), null);

      // A platform thread: no counterparty and no API, both stored as NULL.
      const platform = await store.threads.create({
        subject: 'Hello platform',
        created_by: client.id,
        participant_a: client.id,
      });
      assert.deepEqual(
        await store.threads.findExisting(client.id, null, null),
        platform,
        'null-safe equality finds a thread with no counterparty and no API',
      );

      const first = await store.messages.create({
        thread_id: thread.id,
        sender_user_id: client.id,
        body: 'First',
        created_at: isoInSeconds(-60),
      });
      const last = await store.messages.create({
        thread_id: thread.id,
        sender_user_id: provider.id,
        body: 'Last',
        created_at: isoInSeconds(-10),
      });
      await store.threads.touchLastMessage(thread.id, last.created_at);

      const listed = await store.messages.listByThread(thread.id);
      assert.deepEqual(
        listed.items.map((message) => message.id),
        [first.id, last.id],
        'oldest first',
      );
      assert.equal(listed.total, 2);
      assert.equal((await store.messages.findLatestByThread(thread.id))?.id, last.id);
      assert.equal(await store.messages.countByThread(thread.id), 2);

      const mine = await store.threads.list({ participant_user_id: client.id });
      assert.equal(mine.total, 2);
      assert.deepEqual(
        mine.items.map((entry) => entry.id),
        [platform.id, thread.id],
        // The platform thread has no messages, so it sorts on its own
        // created_at (just now), which beats the other thread's last message
        // (ten seconds ago) — this is the coalesce fallback working.
        'threads sort by last activity, falling back to created_at when there is none',
      );
      assert.equal((await store.threads.list({ q: thread.subject })).total, 1);
      assert.equal((await store.threads.list({ api_id: api.id })).total, 1);

      const renamed = await store.threads.update(thread.id, { subject: 'Renamed' });
      assert.equal(renamed?.subject, 'Renamed');

      assert.equal(await store.messages.deleteByThread(thread.id), 2);
      assert.equal(await store.threads.delete(thread.id), true);
    });

    it('threads: participant_user_id matches the seats, never the creator', async () => {
      const admin = await makeUser({ role: 'super_admin' });
      const recipient = await makeUser();

      // The shape a god-mode broadcast produces: the recipient holds the only
      // seat and the sender is recorded only as `created_by`.
      const broadcast = await store.threads.create({
        subject: `Broadcast ${newId().slice(0, 6)}`,
        created_by: admin.id,
        participant_a: recipient.id,
      });

      const seated = await store.threads.list({ participant_user_id: recipient.id });
      assert.equal(seated.total, 1);
      assert.equal(seated.items[0]?.id, broadcast.id);

      assert.equal(
        (await store.threads.list({ participant_user_id: admin.id })).total,
        0,
        'creating a thread is not a seat in it — access has to come from the current role',
      );
    });

    /* ── notifications ────────────────────────────────────────────────── */

    it('notifications: bulk create, unread counts and marking read', async () => {
      const user = await makeUser();
      const created = await store.notifications.createMany([
        {
          user_id: user.id,
          type: 'system',
          title: 'One',
          body: 'a',
          created_at: isoInSeconds(-60),
        },
        {
          user_id: user.id,
          type: 'message_received',
          title: 'Two',
          body: 'b',
          link: '/messages',
          created_at: isoInSeconds(-10),
        },
      ]);
      assert.equal(created.length, 2);
      assert.deepEqual(await store.notifications.createMany([]), []);
      assert.equal(await store.notifications.countUnread(user.id), 2);

      const unread = await store.notifications.list({ user_id: user.id, unread: true });
      assert.equal(unread.total, 2);
      assert.equal(unread.items[0]?.title, 'Two', 'newest first');

      const target = unread.items[0]?.id ?? '';
      assert.equal(await store.notifications.markRead(user.id, [target], nowIso()), 1);
      assert.equal(
        await store.notifications.markRead(user.id, [target], nowIso()),
        0,
        'already-read notifications are not counted again',
      );
      assert.equal(await store.notifications.markRead(user.id, [], nowIso()), 0);
      assert.equal((await store.notifications.list({ user_id: user.id, unread: false })).total, 1);
      assert.equal(
        (await store.notifications.list({ user_id: user.id, type: 'message_received' })).total,
        1,
      );

      assert.equal(await store.notifications.markAllRead(user.id, nowIso()), 1);
      assert.equal(await store.notifications.countUnread(user.id), 0);
      assert.ok(await store.notifications.findById(target));
    });

    /* ── email outbox ─────────────────────────────────────────────────── */

    it('emailOutbox: idempotency keys suppress duplicate sends', async () => {
      const key = `verify-${newId()}`;
      const first = await store.emailOutbox.enqueue({
        to_email: 'a@example.test',
        subject: 'Verify',
        body_html: '<p>hi</p>',
        body_text: 'hi',
        idempotency_key: key,
      });
      assert.equal(first.created, true);
      assert.equal(first.entry.status, 'pending');
      assert.equal(first.entry.attempts, 0);

      const second = await store.emailOutbox.enqueue({
        to_email: 'a@example.test',
        subject: 'Verify again',
        body_html: '<p>hi</p>',
        body_text: 'hi',
        idempotency_key: key,
      });
      assert.equal(second.created, false);
      assert.equal(second.entry.id, first.entry.id);
      assert.equal(second.entry.subject, 'Verify', 'the original row wins');
      assert.deepEqual(await store.emailOutbox.findByIdempotencyKey(key), first.entry);

      // Unkeyed sends are never deduplicated — the partial unique index exempts
      // rows with no key.
      for (let i = 0; i < 2; i += 1) {
        const entry = await store.emailOutbox.enqueue({
          to_email: 'b@example.test',
          subject: 'Plain',
          body_html: '<p>x</p>',
          body_text: 'x',
        });
        assert.equal(entry.created, true);
      }
    });

    it('emailOutbox: claims due rows once, then retries and fails', async () => {
      const marker = `claim-${newId()}@example.test`;
      await store.emailOutbox.enqueue({
        to_email: marker,
        subject: 'Due',
        body_html: '<p>x</p>',
        body_text: 'x',
      });

      const claimed = await store.emailOutbox.claimDue(nowIso(), 50);
      const mine = claimed.filter((entry) => entry.to_email === marker);
      assert.equal(mine.length, 1);
      assert.equal(mine[0]?.status, 'sending');
      assert.equal(mine[0]?.attempts, 1, 'claiming increments the attempt counter');

      const again = await store.emailOutbox.claimDue(nowIso(), 50);
      assert.equal(
        again.filter((entry) => entry.to_email === marker).length,
        0,
        'a claimed row is not handed out twice',
      );

      const id = mine[0]?.id ?? '';
      await store.emailOutbox.reschedule(id, isoInSeconds(-1), 'smtp timeout');
      const rescheduled = await store.emailOutbox.findById(id);
      assert.equal(rescheduled?.status, 'pending');
      assert.equal(rescheduled?.last_error, 'smtp timeout');
      assert.ok(
        (rescheduled?.next_attempt_at ?? '') < nowIso(),
        'the backoff stamp is in the past, so the row is due again',
      );

      const reclaimed = await store.emailOutbox.claimDue(nowIso(), 50);
      const retried = reclaimed.find((entry) => entry.id === id);
      assert.equal(retried?.attempts, 2, 'the backoff reschedule makes the row claimable again');

      assert.ok((await store.emailOutbox.releaseStale(isoInSeconds(60))) >= 0);

      await store.emailOutbox.markFailed(id, 'gave up');
      const failed = await store.emailOutbox.findById(id);
      assert.equal(failed?.status, 'failed');
      assert.equal(failed?.next_attempt_at, null);
      assert.equal(failed?.last_error, 'gave up');

      assert.equal((await store.emailOutbox.list({ to_email: marker.toUpperCase() })).total, 1);
      assert.ok((await store.emailOutbox.list({ status: 'failed' })).total >= 1);
    });

    it('emailOutbox: marking sent clears the schedule and the last error', async () => {
      const entry = await store.emailOutbox.enqueue({
        to_email: `sent-${newId()}@example.test`,
        subject: 'Sent',
        body_html: '<p>x</p>',
        body_text: 'x',
      });
      const at = nowIso();
      await store.emailOutbox.markSent(entry.entry.id, at);
      const sent = await store.emailOutbox.findById(entry.entry.id);
      assert.equal(sent?.status, 'sent');
      assert.equal(sent?.next_attempt_at, null);
      assert.equal(sent?.last_error, null);
      assert.equal(sent?.updated_at, at);
    });

    it('emailOutbox: releaseStale returns stuck rows to pending', async () => {
      const marker = `stale-${newId()}@example.test`;
      await store.emailOutbox.enqueue({
        to_email: marker,
        subject: 'Stuck',
        body_html: '<p>x</p>',
        body_text: 'x',
      });
      const claimed = await store.emailOutbox.claimDue(nowIso(), 50);
      const mine = claimed.find((entry) => entry.to_email === marker);
      assert.equal(mine?.status, 'sending');

      const released = await store.emailOutbox.releaseStale(isoInSeconds(60));
      assert.ok(released >= 1);
      assert.equal((await store.emailOutbox.findById(mine?.id ?? ''))?.status, 'pending');
    });

    /* ── audit logs ───────────────────────────────────────────────────── */

    it('auditLogs: appends structured details and filters every way', async () => {
      const actor = await makeUser({ role: 'admin' });
      const from = nowIso();
      const login = await store.auditLogs.create({
        actor_user_id: actor.id,
        actor_role: 'admin',
        action: 'auth.login',
        target_type: 'user',
        target_id: actor.id,
        details: { email: 'x@example.test', nested: { ok: true } },
        ip: '10.0.0.1',
      });
      assert.deepEqual(login.details, { email: 'x@example.test', nested: { ok: true } });

      await store.auditLogs.create({
        actor_user_id: actor.id,
        actor_role: 'admin',
        action: 'admin.settings_update',
        target_type: 'settings',
        details: {},
      });

      assert.equal((await store.auditLogs.list({ actor_user_id: actor.id })).total, 2);
      assert.equal(
        (await store.auditLogs.list({ actor_user_id: actor.id, action: 'auth.login' })).total,
        1,
      );
      assert.equal(
        await store.auditLogs.count({
          actor_user_id: actor.id,
          actions: ['auth.login', 'admin.settings_update'],
        }),
        2,
      );
      assert.equal(
        (await store.auditLogs.list({ target_type: 'user', target_id: actor.id })).total,
        1,
      );
      assert.equal(
        (await store.auditLogs.list({ actor_user_id: actor.id, from, to: isoInSeconds(60) })).total,
        2,
      );
      assert.equal(
        (await store.auditLogs.list({ actor_user_id: actor.id, to: from })).total,
        0,
        'the upper bound is exclusive',
      );
    });

    /* ── settings ─────────────────────────────────────────────────────── */

    it('settings: upserts, preserves the encrypted flag and round-trips values', async () => {
      const plainKey = `branding-${newId().slice(0, 8)}`;
      const secretKey = `smtp.password-${newId().slice(0, 8)}`;

      await store.settings.set(plainKey, { portal_name: 'Nexus', tags: ['a', 'b'] });
      const plain = await store.settings.get(plainKey);
      assert.deepEqual(plain?.value, { portal_name: 'Nexus', tags: ['a', 'b'] });
      assert.equal(plain?.encrypted, false);

      await store.settings.set(secretKey, 'v1:aa:bb:cc', true);
      const secret = await store.settings.get(secretKey);
      assert.equal(secret?.encrypted, true, 'the encrypted flag survives the round trip');
      assert.equal(secret?.value, 'v1:aa:bb:cc');

      // Upserting overwrites in place and keeps created_at.
      await store.settings.set(plainKey, { portal_name: 'Renamed' });
      const renamed = await store.settings.get(plainKey);
      assert.deepEqual(renamed?.value, { portal_name: 'Renamed' });
      assert.equal(renamed?.created_at, plain?.created_at);

      await store.settings.setMany([
        { key: plainKey, value: { portal_name: 'Batched' } },
        { key: `registration-${newId().slice(0, 8)}`, value: { open_registration: false } },
      ]);
      assert.deepEqual((await store.settings.get(plainKey))?.value, { portal_name: 'Batched' });
      assert.equal((await store.settings.getMany([plainKey, secretKey])).length, 2);
      assert.deepEqual(await store.settings.getMany([]), []);
      assert.ok((await store.settings.all()).length >= 3);

      assert.equal(await store.settings.delete(plainKey), true);
      assert.equal(await store.settings.delete(plainKey), false);
      assert.equal(await store.settings.get(plainKey), null);
    });

    it('settings: exactly one concurrent insertIfAbsent wins the key', async () => {
      const key = `bootstrap-claim-${newId().slice(0, 8)}`;

      // Six callers race for the same key with nothing serialising them. The
      // unique constraint on `app_settings.key` is the only arbiter, which is
      // the property the super_admin election depends on — a transaction is
      // not enough, because two of them can both observe "absent".
      const results = await Promise.all(
        Array.from({ length: 6 }, (_unused, index) =>
          store.settings.insertIfAbsent(key, { winner: index }),
        ),
      );
      assert.equal(
        results.filter(Boolean).length,
        1,
        `expected exactly one winner, got ${results.filter(Boolean).join(', ')}`,
      );

      const stored = await store.settings.get(key);
      const winner = results.indexOf(true);
      assert.deepEqual(stored?.value, { winner }, 'the winner’s value is the one stored');
      assert.equal(stored?.encrypted, false);

      // A later call never overwrites, and never throws.
      assert.equal(await store.settings.insertIfAbsent(key, { winner: 99 }), false);
      assert.deepEqual((await store.settings.get(key))?.value, { winner });

      // The encrypted flag is honoured on the insert that wins.
      const secretKey = `claim-secret-${newId().slice(0, 8)}`;
      assert.equal(await store.settings.insertIfAbsent(secretKey, 'v1:aa:bb:cc', true), true);
      assert.equal((await store.settings.get(secretKey))?.encrypted, true);

      // …and a key `set` created first is respected, too.
      const takenKey = `claim-taken-${newId().slice(0, 8)}`;
      await store.settings.set(takenKey, { from: 'set' });
      assert.equal(await store.settings.insertIfAbsent(takenKey, { from: 'claim' }), false);
      assert.deepEqual((await store.settings.get(takenKey))?.value, { from: 'set' });
    });

    /* ── email templates ──────────────────────────────────────────────── */

    it('emailTemplates: upsert by key replaces the body and keeps the row', async () => {
      const created = await store.emailTemplates.upsert('verification', {
        subject: 'Verify',
        body_html: '<p>a</p>',
        body_text: 'a',
      });
      const replaced = await store.emailTemplates.upsert('verification', {
        subject: 'Verify now',
        body_html: '<p>b</p>',
        body_text: 'b',
      });
      assert.equal(replaced.id, created.id, 'upsert updates rather than inserting a second row');
      assert.equal(replaced.subject, 'Verify now');
      assert.equal((await store.emailTemplates.get('verification'))?.body_text, 'b');

      await store.emailTemplates.upsert('mass', {
        subject: 'Announcement',
        body_html: '<p>c</p>',
        body_text: 'c',
      });
      const all = await store.emailTemplates.list();
      assert.equal(all.length, 2);
      assert.deepEqual(
        all.map((template) => template.key),
        ['mass', 'verification'],
        'templates list by key',
      );

      assert.equal(await store.emailTemplates.delete('mass'), true);
      assert.equal(await store.emailTemplates.delete('mass'), false);
      assert.equal(await store.emailTemplates.get('mass'), null);
    });

    /* ── verification tokens ──────────────────────────────────────────── */

    it('verificationTokens: single use, then invalidation and expiry sweeps', async () => {
      const user = await makeUser();
      const tokenHash = `token-${newId()}`;
      const token = await store.verificationTokens.create({
        user_id: user.id,
        token_hash: tokenHash,
        expires_at: isoInSeconds(600),
      });
      assert.equal(token.used_at, null);
      assert.deepEqual(await store.verificationTokens.findByTokenHash(tokenHash), token);

      await assert.rejects(
        () =>
          store.verificationTokens.create({
            user_id: user.id,
            token_hash: tokenHash,
            expires_at: isoInSeconds(600),
          }),
        (error: unknown) => isNexusError(error) && error.code === 'CONFLICT',
      );

      assert.equal(await store.verificationTokens.markUsed(token.id, nowIso()), true);
      assert.equal(
        await store.verificationTokens.markUsed(token.id, nowIso()),
        false,
        'a token can only be burned once',
      );
      assert.ok((await store.verificationTokens.findByTokenHash(tokenHash))?.used_at);

      await store.verificationTokens.create({
        user_id: user.id,
        token_hash: `expired-${newId()}`,
        expires_at: isoInSeconds(-10),
      });
      assert.equal(await store.verificationTokens.deleteExpired(nowIso()), 1);
      assert.equal(await store.verificationTokens.deleteForUser(user.id), 1);
    });

    /* ── transactions ─────────────────────────────────────────────────── */

    it('transactions: commit when the body resolves', async () => {
      const email = `tx-commit-${newId()}@example.test`;
      await store.transaction(async (tx) => {
        await tx.users.create({
          email,
          password_hash: 'scrypt:16384:8:1:c2FsdA==:aGFzaA==',
          display_name: 'Committed',
          role: 'client',
          status: 'active',
          email_verified: false,
        });
      });
      assert.ok(await store.users.findByEmail(email));
    });

    it('transactions: roll back every statement when the body throws', async () => {
      const email = `tx-rollback-${newId()}@example.test`;
      await assert.rejects(
        () =>
          store.transaction(async (tx) => {
            await tx.users.create({
              email,
              password_hash: 'scrypt:16384:8:1:c2FsdA==:aGFzaA==',
              display_name: 'Rolled back',
              role: 'client',
              status: 'active',
              email_verified: false,
            });
            assert.ok(await tx.users.findByEmail(email), 'visible inside the transaction');
            throw new Error('boom');
          }),
        /boom/,
      );
      assert.equal(await store.users.findByEmail(email), null);
    });

    it('transactions: a nested call joins the outer one instead of nesting', async () => {
      const email = `tx-nested-${newId()}@example.test`;
      await store.transaction(async (tx) => {
        await tx.transaction(async (inner) => {
          await inner.users.create({
            email,
            password_hash: 'scrypt:16384:8:1:c2FsdA==:aGFzaA==',
            display_name: 'Nested',
            role: 'client',
            status: 'active',
            email_verified: false,
          });
        });
      });
      assert.ok(await store.users.findByEmail(email));
    });

    it('transactions: a nested rollback discards the whole outer body', async () => {
      const email = `tx-nested-rollback-${newId()}@example.test`;
      await assert.rejects(
        () =>
          store.transaction(async (tx) =>
            tx.transaction(async (inner) => {
              await inner.users.create({
                email,
                password_hash: 'scrypt:16384:8:1:c2FsdA==:aGFzaA==',
                display_name: 'Nested rollback',
                role: 'client',
                status: 'active',
                email_verified: false,
              });
              throw new Error('inner boom');
            }),
          ),
        /inner boom/,
      );
      assert.equal(await store.users.findByEmail(email), null);
    });

    it('transactions: bodies are serialised', async () => {
      const order: string[] = [];
      await Promise.all([
        store.transaction(async () => {
          order.push('a:start');
          await new Promise((resolve) => setImmediate(resolve));
          order.push('a:end');
        }),
        store.transaction(async () => {
          order.push('b:start');
          order.push('b:end');
        }),
      ]);
      assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'b:end']);
    });

    it('lifecycle: closing twice is safe', async () => {
      // The suite's own store must stay open, so exercise a second one.
      const extra = await makeStore();
      await extra.store.close();
      await extra.store.close();
      await extra.teardown();
    });
  });
}

/* ── Registration ───────────────────────────────────────────────────────── */

/** Register a suite, or a single skipped test explaining how to enable it. */
function register(
  label: string,
  url: string | undefined,
  variable: string,
  makeStore: (url: string) => Promise<SmokeTarget>,
): void {
  if (url === undefined || url.trim() === '') {
    describe(`store contract — ${label}`, () => {
      it(`skipped — set ${variable} to run against a real ${label} server`, {
        skip: `${variable} is not set`,
      });
    });
    return;
  }
  runSmokeSuite(label, () => makeStore(url));
}

runSmokeSuite('sqlite', sqliteTarget);
register(
  'postgres',
  process.env.NEXUS_TEST_POSTGRES_URL,
  'NEXUS_TEST_POSTGRES_URL',
  postgresTarget,
);
register('mysql', process.env.NEXUS_TEST_MYSQL_URL, 'NEXUS_TEST_MYSQL_URL', mysqlTarget);
register('mongodb', process.env.NEXUS_TEST_MONGO_URL, 'NEXUS_TEST_MONGO_URL', mongoTarget);

/* ── The MongoDB replica-set rule ───────────────────────────────────────── */

const standaloneUrl = process.env.NEXUS_TEST_MONGO_STANDALONE_URL;

describe('mongodb standalone rule', () => {
  if (standaloneUrl === undefined || standaloneUrl.trim() === '') {
    it('skipped — set NEXUS_TEST_MONGO_STANDALONE_URL to run', {
      skip: 'NEXUS_TEST_MONGO_STANDALONE_URL is not set',
    });
    return;
  }

  it('refuses to start against a standalone deployment', async () => {
    const store = createStore(
      testConfig('mongodb', withDatabase(standaloneUrl, throwawayDbName())),
    );
    try {
      await assert.rejects(
        () => store.init(),
        (error: unknown) =>
          isNexusError(error) &&
          error.code === 'INTERNAL' &&
          /standalone/i.test(error.message) &&
          /NEXUS_DB_ALLOW_STANDALONE/.test(error.message),
      );
    } finally {
      await store.close();
    }
  });

  it('starts with degraded transactions when standalone is explicitly allowed', async () => {
    const database = throwawayDbName();
    const config = loadConfig({
      NEXUS_SECRET_KEY: SECRET,
      FERRUM_ADMIN_JWT_SECRET: SECRET,
      NEXUS_ENV: 'test',
      NEXUS_DB_DRIVER: 'mongodb',
      NEXUS_DB_URL: withDatabase(standaloneUrl, database),
      NEXUS_DB_ALLOW_STANDALONE: 'true',
    });
    const store = createStore(config);
    try {
      await store.init();
      await store.migrate();

      // The body still runs and still commits its writes; what it loses is
      // atomicity, which is the documented trade of the opt-in.
      const email = `standalone-${newId()}@example.test`;
      await store.transaction(async (tx) => {
        await tx.users.create({
          email,
          password_hash: 'scrypt:16384:8:1:c2FsdA==:aGFzaA==',
          display_name: 'Degraded',
          role: 'client',
          status: 'active',
          email_verified: false,
        });
      });
      const owner = await store.users.findByEmail(email);
      assert.ok(owner);

      // `apiSpecs.create` and `setCurrent` open a transaction of their own to
      // make the current-revision swap atomic. On a standalone deployment that
      // has to degrade to plain sequential writes, not fail with "Transaction
      // numbers are only allowed on a replica set member or mongos".
      const api = await store.apis.create({
        name: 'Standalone API',
        slug: `standalone-${newId().slice(0, 8)}`,
        owner_user_id: owner.id,
        namespace: 'nexus',
        version: '1.0.0',
        spec_format: 'openapi',
        requestable: true,
        auth_plugin: 'key_auth',
        status: 'published',
        visibility: 'public',
      });
      const v1 = await store.apiSpecs.create({
        api_id: api.id,
        version: '1',
        raw_spec: 'openapi: 3.0.0',
        is_current: true,
      });
      const v2 = await store.apiSpecs.create({
        api_id: api.id,
        version: '2',
        raw_spec: 'openapi: 3.1.0',
        is_current: true,
      });
      assert.equal((await store.apiSpecs.findCurrentByApi(api.id))?.id, v2.id);
      await store.apiSpecs.setCurrent(api.id, v1.id);
      assert.equal((await store.apiSpecs.findCurrentByApi(api.id))?.id, v1.id);
    } finally {
      const cleaner = new MongoClient(withDatabase(standaloneUrl, database));
      try {
        await cleaner.connect();
        await cleaner.db(database).dropDatabase();
      } finally {
        await cleaner.close();
        await store.close();
      }
    }
  });
});
