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
import { runPasswordChangeContract } from './password-change-contract.js';

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
  try {
    await store.init();
    await store.migrate();
  } catch (error) {
    // A failed setup must release the pool, or the process never exits and the
    // failure detail is lost behind a timeout.
    await store.close().catch(() => undefined);
    throw error;
  }
  return { store, teardown: () => store.close() };
}

async function postgresTarget(adminUrl: string): Promise<SmokeTarget> {
  const database = throwawayDbName();
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${database}"`);
  await admin.end();

  const store = createStore(testConfig('postgres', withDatabase(adminUrl, database)));
  try {
    await store.init();
    await store.migrate();
  } catch (error) {
    // A failed setup must release the pool, or the process never exits and the
    // failure detail is lost behind a timeout.
    await store.close().catch(() => undefined);
    throw error;
  }

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
  try {
    await store.init();
    await store.migrate();
  } catch (error) {
    // A failed setup must release the pool, or the process never exits and the
    // failure detail is lost behind a timeout.
    await store.close().catch(() => undefined);
    throw error;
  }

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
  try {
    await store.init();
    await store.migrate();
  } catch (error) {
    // A failed setup must release the pool, or the process never exits and the
    // failure detail is lost behind a timeout.
    await store.close().catch(() => undefined);
    throw error;
  }

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
  runPasswordChangeContract(label, makeStore);
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

    it('apis: round-trips the recorded upstream and the CORS policy', async () => {
      const owner = await makeUser({ role: 'provider' });
      const cors = { allowed_origins: ['https://app.example.com'], allow_credentials: true };
      const api = await store.apis.create({
        name: 'Fronted',
        slug: `fronted-${newId().slice(0, 8)}`,
        owner_user_id: owner.id,
        upstream_url: 'https://billing.example.com:8443/v2',
        namespace: 'nexus',
        version: '1.0.0',
        spec_format: 'openapi',
        requestable: true,
        auth_plugin: 'key_auth',
        cors,
        status: 'published',
        visibility: 'public',
      });
      assert.equal(api.upstream_url, 'https://billing.example.com:8443/v2');
      assert.deepEqual(api.cors, cors, 'the CORS policy crosses the boundary parsed');
      assert.deepEqual(await store.apis.findById(api.id), api);

      const moved = await store.apis.update(api.id, {
        upstream_url: 'http://other.example.com:8080/base',
        cors: {
          allowed_origins: ['https://a.example.com', 'https://b.example.com'],
          allow_credentials: false,
        },
      });
      assert.equal(moved?.upstream_url, 'http://other.example.com:8080/base');
      assert.deepEqual(moved?.cors, {
        allowed_origins: ['https://a.example.com', 'https://b.example.com'],
        allow_credentials: false,
      });

      const cleared = await store.apis.update(api.id, { upstream_url: null, cors: null });
      assert.equal(cleared?.upstream_url, null);
      assert.equal(cleared?.cors, null);

      // Omitting both on create leaves them NULL rather than defaulting.
      const bare = await store.apis.findById((await makeApi(owner.id)).id);
      assert.equal(bare?.upstream_url, null);
      assert.equal(bare?.cors, null);
    });

    it('apis: round-trips the proxy runtime settings', async () => {
      const owner = await makeUser({ role: 'provider' });
      const api = await store.apis.create({
        name: 'Tuned',
        slug: `tuned-${newId().slice(0, 8)}`,
        owner_user_id: owner.id,
        namespace: 'nexus',
        version: '1.0.0',
        spec_format: 'openapi',
        requestable: true,
        auth_plugin: 'key_auth',
        allowed_methods: ['GET', 'POST', 'OPTIONS'],
        timeouts: { connect_ms: 1_000, read_ms: 2_000, write_ms: 3_000 },
        circuit_breaker: true,
        status: 'published',
        visibility: 'public',
      });
      assert.deepEqual(api.allowed_methods, ['GET', 'POST', 'OPTIONS'], 'order is preserved');
      assert.deepEqual(api.timeouts, { connect_ms: 1_000, read_ms: 2_000, write_ms: 3_000 });
      assert.equal(api.circuit_breaker, true, 'the flag crosses the boundary as a boolean');
      assert.deepEqual(await store.apis.findById(api.id), api);

      const narrowed = await store.apis.update(api.id, {
        allowed_methods: ['GET'],
        timeouts: { connect_ms: 250, read_ms: 500, write_ms: 750 },
      });
      assert.deepEqual(narrowed?.allowed_methods, ['GET']);
      assert.deepEqual(narrowed?.timeouts, { connect_ms: 250, read_ms: 500, write_ms: 750 });
      assert.equal(narrowed?.circuit_breaker, true, 'an untouched column is left alone');

      const cleared = await store.apis.update(api.id, {
        allowed_methods: null,
        timeouts: null,
        circuit_breaker: false,
      });
      assert.equal(cleared?.allowed_methods, null);
      assert.equal(cleared?.timeouts, null);
      assert.equal(cleared?.circuit_breaker, false);

      // A row created without them — every row predating migration 004 — reads
      // back as "no restriction, gateway defaults, no breaker".
      const bare = await store.apis.findById((await makeApi(owner.id)).id);
      assert.equal(bare?.allowed_methods, null);
      assert.equal(bare?.timeouts, null);
      assert.equal(bare?.circuit_breaker, false);
    });

    it('apis: round-trips the OpenAPI enforcement level', async () => {
      const owner = await makeUser({ role: 'provider' });
      const api = await store.apis.create({
        name: 'Enforced',
        slug: `enforced-${newId().slice(0, 8)}`,
        owner_user_id: owner.id,
        namespace: 'nexus',
        version: '1.0.0',
        spec_format: 'openapi',
        requestable: true,
        auth_plugin: 'key_auth',
        spec_enforcement: 'routes',
        status: 'published',
        visibility: 'public',
      });
      assert.equal(api.spec_enforcement, 'routes');
      assert.deepEqual(await store.apis.findById(api.id), api);

      const relaxed = await store.apis.update(api.id, { spec_enforcement: 'docs_only' });
      assert.equal(relaxed?.spec_enforcement, 'docs_only');

      const untouched = await store.apis.update(api.id, { version: '2.0.0' });
      assert.equal(untouched?.spec_enforcement, 'docs_only', 'an untouched column is left alone');

      // A row created without it — every row predating migration 005 — reads
      // back as "the document is catalog metadata only".
      const bare = await store.apis.findById((await makeApi(owner.id)).id);
      assert.equal(bare?.spec_enforcement, 'docs_only');
    });

    it('apis: visible_to paginates and counts the rows one viewer may browse', async () => {
      const owner = await makeUser({ role: 'provider' });
      const stranger = await makeUser();
      const marker = newId().slice(0, 8);

      async function seed(
        ownerId: string,
        overrides: {
          status?: 'published' | 'retired';
          visibility?: 'public' | 'internal';
          name?: string;
        },
      ): Promise<string> {
        const api = await store.apis.create({
          name: overrides.name ?? `Viewer ${marker}`,
          slug: `viewer-${marker}-${newId().slice(0, 8)}`,
          owner_user_id: ownerId,
          namespace: 'nexus',
          version: '1.0.0',
          spec_format: 'openapi',
          requestable: true,
          auth_plugin: 'key_auth',
          status: overrides.status ?? 'published',
          visibility: overrides.visibility ?? 'public',
        });
        return api.id;
      }

      const openApi = await seed(owner.id, {});
      const unlisted = await seed(owner.id, { visibility: 'internal' });
      const retired = await seed(owner.id, { status: 'retired' });
      const granted = await seed(owner.id, { visibility: 'internal' });
      const ownedByStranger = await seed(stranger.id, {
        visibility: 'internal',
        name: `Own ${marker}`,
      });

      const clause = {
        owner_user_id: stranger.id,
        granted_api_ids: [granted],
        open_status: 'published' as const,
        open_visibilities: ['public' as const],
      };
      // Scope every read to this test's own rows: the suite shares one database.
      const mine = { q: marker, visible_to: clause };

      const listed = await store.apis.list(mine, { limit: 50 });
      assert.deepEqual(
        new Set(listed.items.map((api) => api.id)),
        new Set([openApi, granted, ownedByStranger]),
        'owned, granted and published-public rows pass; internal and retired do not',
      );
      assert.equal(listed.total, 3, 'total counts the filtered set, not the table');
      assert.equal(await store.apis.count(mine), 3, 'count applies the same clause');
      for (const hidden of [unlisted, retired]) {
        assert.ok(!listed.items.some((api) => api.id === hidden));
      }

      // The clause narrows a page rather than being applied after it: one row
      // per page, walked to the end, yields each permitted row exactly once.
      const walked: string[] = [];
      for (let offset = 0; offset < 4; offset += 1) {
        const step = await store.apis.list(mine, { limit: 1, offset });
        assert.equal(step.total, 3, 'every page reports the same filtered total');
        walked.push(...step.items.map((api) => api.id));
      }
      assert.equal(walked.length, 3, 'paging past the end returns nothing extra');
      assert.equal(new Set(walked).size, 3, 'no row is served twice');

      // …and it ANDs with the other filters rather than widening them.
      assert.equal(
        (await store.apis.list({ ...mine, visibility: 'internal' })).total,
        2,
        'a visibility filter still cannot reveal a row the viewer may not browse',
      );
      assert.equal(
        (await store.apis.list({ ...mine, q: `Own ${marker}` })).total,
        1,
        'search composes with the viewer clause',
      );
      assert.equal(
        (await store.apis.list({ ...mine, visible_to: { ...clause, granted_api_ids: [] } })).total,
        2,
        'an empty grant list drops its disjunct instead of matching everything',
      );
      assert.equal(
        (await store.apis.list({ ...mine, visible_to: { ...clause, open_visibilities: [] } }))
          .total,
        2,
        'an empty visibility list leaves only owned and granted rows',
      );
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

    it('apiSpecs: pruneHistory drops the oldest revisions and never the current one', async () => {
      const owner = await makeUser({ role: 'provider' });
      const api = await makeApi(owner.id);
      const other = await makeApi(owner.id);

      // Explicit stamps: retention is `created_at DESC, id DESC`, and five rows
      // written in a loop would otherwise share a millisecond.
      for (let n = 1; n <= 5; n += 1) {
        await store.apiSpecs.create({
          api_id: api.id,
          version: `${n}`,
          raw_spec: `openapi: 3.1.0 # ${n}`,
          created_at: `2026-01-0${n}T00:00:00.000Z`,
          is_current: n === 5,
        });
      }
      await store.apiSpecs.create({
        api_id: other.id,
        version: 'other',
        raw_spec: 'openapi: 3.1.0',
        created_at: '2026-01-01T00:00:00.000Z',
        is_current: false,
      });

      const versions = async (apiId: string): Promise<string[]> =>
        (await store.apiSpecs.list({ api_id: apiId })).items.map((spec) => spec.version);

      assert.equal(await store.apiSpecs.pruneHistory(api.id, 2), 2);
      assert.deepEqual(await versions(api.id), ['5', '4', '3']);
      assert.equal((await store.apiSpecs.findCurrentByApi(api.id))?.version, '5');
      assert.equal(
        await store.apiSpecs.pruneHistory(api.id, 2),
        0,
        'a second pass removes nothing',
      );

      // Even asked to keep no history at all, the current revision stays: it is
      // never a candidate, which is what makes the caller's rollback data safe.
      assert.equal(await store.apiSpecs.pruneHistory(api.id, 0), 2);
      assert.deepEqual(await versions(api.id), ['5']);
      assert.equal((await store.apiSpecs.findCurrentByApi(api.id))?.version, '5');

      assert.deepEqual(await versions(other.id), ['other'], "another API's history is untouched");
      assert.equal(await store.apiSpecs.pruneHistory(api.id, 10), 0, 'an empty history is a no-op');
    });

    /* ── api plugins ──────────────────────────────────────────────────── */

    it('apiPlugins: upserts one row per (api, plugin) and keeps created_at', async () => {
      const owner = await makeUser({ role: 'provider' });
      const api = await makeApi(owner.id);

      const first = await store.apiPlugins.upsert({
        api_id: api.id,
        plugin_name: 'ip_restriction',
        enabled: true,
        config: { allow: ['203.0.113.0/24'], mode: 'allow_first' },
        trigger: { methods: ['POST'], path_prefix: '/nexus/orders' },
      });
      assert.equal(first.api_id, api.id);
      assert.equal(first.enabled, true);
      // Structured columns cross the store boundary as parsed objects, never
      // as the JSON text the SQL adapters keep in their `*_json` columns.
      assert.deepEqual(first.config, { allow: ['203.0.113.0/24'], mode: 'allow_first' });
      assert.deepEqual(first.trigger, { methods: ['POST'], path_prefix: '/nexus/orders' });

      // The PUT route saves the same pair again: one row, not a conflict.
      const replaced = await store.apiPlugins.upsert({
        api_id: api.id,
        plugin_name: 'ip_restriction',
        enabled: false,
        config: { deny: ['198.51.100.4'] },
        trigger: null,
      });
      assert.equal(replaced.id, first.id, 'the pair is unique, so a save reuses the row');
      assert.equal(replaced.created_at, first.created_at, 'created_at survives a replace');
      assert.equal(replaced.enabled, false);
      assert.deepEqual(replaced.config, { deny: ['198.51.100.4'] });
      assert.equal(replaced.trigger, null);

      assert.deepEqual(await store.apiPlugins.find(api.id, 'ip_restriction'), replaced);
      assert.equal(await store.apiPlugins.find(api.id, 'compression'), null);
      assert.equal((await store.apiPlugins.listByApi(api.id)).length, 1);
    });

    it('apiPlugins: a second plugin is a separate row, and both cascade', async () => {
      const owner = await makeUser({ role: 'provider' });
      const api = await makeApi(owner.id);
      const other = await makeApi(owner.id);

      await store.apiPlugins.upsert({
        api_id: api.id,
        plugin_name: 'correlation_id',
        enabled: true,
        config: {},
        trigger: null,
      });
      await store.apiPlugins.upsert({
        api_id: api.id,
        plugin_name: 'compression',
        enabled: true,
        config: { algorithms: ['gzip'] },
        trigger: null,
      });
      // The same plugin name on a different API is a different row.
      await store.apiPlugins.upsert({
        api_id: other.id,
        plugin_name: 'compression',
        enabled: true,
        config: {},
        trigger: null,
      });

      const listed = await store.apiPlugins.listByApi(api.id);
      assert.equal(listed.length, 2);
      assert.deepEqual([...listed].map((row) => row.plugin_name).sort(), [
        'compression',
        'correlation_id',
      ]);

      assert.equal(await store.apiPlugins.delete(api.id, 'compression'), true);
      assert.equal(await store.apiPlugins.delete(api.id, 'compression'), false);
      assert.equal((await store.apiPlugins.listByApi(api.id)).length, 1);

      assert.equal(await store.apiPlugins.deleteByApi(api.id), 1);
      assert.equal(await store.apiPlugins.deleteByApi(api.id), 0);
      assert.equal(
        (await store.apiPlugins.listByApi(other.id)).length,
        1,
        'the other API keeps its own row',
      );
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

    it('grants: updateIfStatus lets exactly one revocation withdraw a grant', async () => {
      const owner = await makeUser({ role: 'provider' });
      const admin = await makeUser({ role: 'admin' });
      const client = await makeUser();
      const api = await makeApi(owner.id);

      const grant = await store.grants.create({
        api_id: api.id,
        user_id: client.id,
        acl_group: `nexus:api:${api.id}:approved`,
        status: 'active',
        granted_by: owner.id,
      });

      // The owner and an administrator revoke at the same instant, each holding
      // the same `active` read. Nothing serialises them — the predicate on the
      // update is the only arbiter, and only its winner may strip the ACL group
      // and audit the withdrawal.
      const outcomes = await Promise.all([
        store.grants.updateIfStatus(grant.id, 'active', {
          status: 'revoked',
          revoked_by: owner.id,
          revoked_at: nowIso(),
        }),
        store.grants.updateIfStatus(grant.id, 'active', {
          status: 'revoked',
          revoked_by: admin.id,
          revoked_at: nowIso(),
        }),
      ]);
      const winners = outcomes.filter((outcome) => outcome !== null);
      assert.equal(winners.length, 1, 'exactly one revocation may move an active grant');

      const stored = await store.grants.findById(grant.id);
      assert.equal(stored?.status, 'revoked');
      assert.equal(stored?.revoked_by, winners[0]?.revoked_by, 'the winner is what was stored');
      assert.equal(await store.grants.findActiveByApiAndUser(api.id, client.id), null);

      // A later attempt against the status it no longer has changes nothing.
      assert.equal(
        await store.grants.updateIfStatus(grant.id, 'active', { revoked_by: admin.id }),
        null,
      );
      assert.deepEqual(await store.grants.findById(grant.id), stored);

      // An empty patch is still a predicate test, not an unconditional hit.
      assert.equal(await store.grants.updateIfStatus(grant.id, 'active', {}), null);
      assert.deepEqual(await store.grants.updateIfStatus(grant.id, 'revoked', {}), stored);

      // A patch that writes the values the row already holds is a *win*, not a
      // miss — MySQL reports zero *changed* rows for it, so the adapter has to
      // re-read the predicate rather than trust the affected-row count. The
      // statement still ran, so `updated_at` may have moved; everything the
      // caller decides on must not have.
      const rewritten = await store.grants.updateIfStatus(grant.id, 'revoked', {
        status: 'revoked',
      });
      assert.ok(rewritten, 'a patch of identical values still matches the predicate');
      assert.deepEqual({ ...rewritten, updated_at: '' }, { ...stored, updated_at: '' });

      assert.equal(
        await store.grants.updateIfStatus(newId(), 'active', { status: 'revoked' }),
        null,
        'a missing row is a loss, not a throw',
      );

      // The unique index still applies through the conditional path: putting
      // this grant back would collide with the replacement that took its slot.
      const regrant = await store.grants.create({
        api_id: api.id,
        user_id: client.id,
        acl_group: `nexus:api:${api.id}:approved`,
        status: 'active',
        granted_by: owner.id,
      });
      await assert.rejects(
        () => store.grants.updateIfStatus(grant.id, 'revoked', { status: 'active' }),
        (error: unknown) => isNexusError(error) && error.code === 'CONFLICT',
      );
      assert.equal((await store.grants.listActiveByUser(client.id)).length, 1);
      assert.equal((await store.grants.findActiveByApiAndUser(api.id, client.id))?.id, regrant.id);

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

    it('messages: countBySenderSince bounds the per-account budget', async () => {
      const sender = await makeUser();
      const bystander = await makeUser();
      const thread = await store.threads.create({
        subject: `Budget ${newId().slice(0, 6)}`,
        created_by: sender.id,
        participant_a: sender.id,
        participant_b: bystander.id,
      });

      const boundary = isoInSeconds(-3_600);
      // One row *at* the boundary, one after it, one comfortably before it.
      await store.messages.create({
        thread_id: thread.id,
        sender_user_id: sender.id,
        body: 'On the boundary',
        created_at: boundary,
      });
      await store.messages.create({
        thread_id: thread.id,
        sender_user_id: sender.id,
        body: 'Inside',
        created_at: isoInSeconds(-60),
      });
      await store.messages.create({
        thread_id: thread.id,
        sender_user_id: sender.id,
        body: 'Long ago',
        created_at: isoInSeconds(-7_200),
      });
      // Someone else's message in the same thread must not be charged to us.
      await store.messages.create({
        thread_id: thread.id,
        sender_user_id: bystander.id,
        body: 'Not yours',
        created_at: isoInSeconds(-60),
      });

      assert.equal(
        await store.messages.countBySenderSince(sender.id, boundary),
        2,
        'the boundary is inclusive: created_at == since counts',
      );
      assert.equal(
        await store.messages.countBySenderSince(sender.id, isoInSeconds(-3_599)),
        1,
        'one second later excludes the boundary row',
      );
      assert.equal(
        await store.messages.countBySenderSince(sender.id, isoInSeconds(-86_400)),
        3,
        'a day-wide window sees every row this sender wrote',
      );
      assert.equal(
        await store.messages.countBySenderSince(bystander.id, isoInSeconds(-86_400)),
        1,
        'the count is per sender, across every thread — never per thread',
      );
      assert.equal(
        await store.messages.countBySenderSince(sender.id, isoInSeconds(60)),
        0,
        'a window that has not started yet counts nothing',
      );

      await store.messages.deleteByThread(thread.id);
      await store.threads.delete(thread.id);
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

    it('threads: platform_or_participant_user_id is the admin inbox as a predicate', async () => {
      const admin = await makeUser({ role: 'admin' });
      const asker = await makeUser();
      const bystander = await makeUser();
      const subject = `Inbox ${newId().slice(0, 6)}`;

      // A platform thread (empty second seat), one the admin sits in, and one
      // between two other people — which the admin must not see here.
      const platform = await store.threads.create({
        subject,
        created_by: asker.id,
        participant_a: asker.id,
      });
      const seated = await store.threads.create({
        subject,
        created_by: asker.id,
        participant_a: asker.id,
        participant_b: admin.id,
      });
      const unrelated = await store.threads.create({
        subject,
        created_by: asker.id,
        participant_a: asker.id,
        participant_b: bystander.id,
      });

      const inbox = await store.threads.list({
        q: subject,
        platform_or_participant_user_id: admin.id,
      });
      assert.equal(inbox.total, 2, 'total counts the filtered set, not the table');
      assert.deepEqual(
        new Set(inbox.items.map((thread) => thread.id)),
        new Set([platform.id, seated.id]),
        'the platform inbox plus the admin`s own seats',
      );
      assert.ok(!inbox.items.some((thread) => thread.id === unrelated.id));

      // Paginated over the filtered set rather than a prefix of the table.
      const first = await store.threads.list(
        { q: subject, platform_or_participant_user_id: admin.id },
        { limit: 1, offset: 0 },
      );
      const second = await store.threads.list(
        { q: subject, platform_or_participant_user_id: admin.id },
        { limit: 1, offset: 1 },
      );
      assert.equal(first.total, 2);
      assert.equal(second.total, 2);
      assert.notEqual(first.items[0]?.id, second.items[0]?.id);

      for (const id of [platform.id, seated.id, unrelated.id]) await store.threads.delete(id);
    });

    it('messages: newest_first and the before cursor page a long transcript', async () => {
      const a = await makeUser();
      const b = await makeUser();
      const thread = await store.threads.create({
        subject: `Transcript ${newId().slice(0, 6)}`,
        created_by: a.id,
        participant_a: a.id,
        participant_b: b.id,
      });

      // Six messages across three timestamps — two per instant, so the id half
      // of the cursor is what makes the order total.
      const created: { id: string; created_at: string }[] = [];
      for (let index = 0; index < 6; index += 1) {
        const message = await store.messages.create({
          thread_id: thread.id,
          sender_user_id: index % 2 === 0 ? a.id : b.id,
          body: `message ${index}`,
          created_at: isoInSeconds(-600 + Math.floor(index / 2) * 60),
        });
        created.push({ id: message.id, created_at: message.created_at });
      }
      const chronological = [...created].sort((left, right) =>
        left.created_at === right.created_at
          ? left.id.localeCompare(right.id)
          : left.created_at.localeCompare(right.created_at),
      );

      const oldest = await store.messages.listByThread(thread.id, { limit: 6 });
      assert.deepEqual(
        oldest.items.map((message) => message.id),
        chronological.map((entry) => entry.id),
        'the default order is oldest-first, tie-broken on id',
      );

      const newest = await store.messages.listByThread(thread.id, {
        limit: 2,
        newest_first: true,
      });
      assert.deepEqual(
        newest.items.map((message) => message.id),
        [...chronological]
          .reverse()
          .slice(0, 2)
          .map((entry) => entry.id),
        'newest_first reverses both keys, so the window is the end of the thread',
      );
      assert.equal(newest.total, 6, 'total ignores the window');

      // Walk backwards from the oldest message of that window: every earlier
      // message exactly once, including the one sharing its timestamp.
      const anchor = chronological[4];
      assert.ok(anchor);
      const older = await store.messages.listByThread(thread.id, {
        limit: 10,
        newest_first: true,
        before: { created_at: anchor.created_at, id: anchor.id },
      });
      assert.deepEqual(
        older.items.map((message) => message.id),
        chronological
          .slice(0, 4)
          .reverse()
          .map((entry) => entry.id),
        'strictly before (created_at, id) — never the anchor, never its twin twice',
      );
      assert.equal(older.total, 4, 'total counts what precedes the cursor');

      const start = chronological[0];
      assert.ok(start);
      const none = await store.messages.listByThread(thread.id, {
        before: { created_at: start.created_at, id: start.id },
      });
      assert.equal(none.total, 0, 'nothing precedes the first message');
      assert.equal(none.items.length, 0);

      await store.messages.deleteByThread(thread.id);
      await store.threads.delete(thread.id);
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

    /* ── gateway teardown jobs ────────────────────────────────────────── */

    it('gatewayTeardownJobs: one row per user, reset rather than duplicated', async () => {
      const user = await makeUser();
      const admin = await makeUser({ role: 'admin' });

      const first = await store.gatewayTeardownJobs.upsertPending(user.id, admin.id, nowIso());
      assert.equal(first.user_id, user.id);
      assert.equal(first.status, 'pending');
      assert.equal(first.attempts, 0);
      assert.equal(first.requested_by, admin.id);
      assert.equal(first.last_error, null);
      assert.equal(first.completed_at, null);
      assert.deepEqual(await store.gatewayTeardownJobs.findByUser(user.id), first);

      // Move it out of `pending` and then re-disable: the row must come back to
      // the start rather than a second job appearing for the same account.
      await store.gatewayTeardownJobs.reschedule(first.id, isoInSeconds(600), 'edge unreachable');
      const rescheduled = await store.gatewayTeardownJobs.findByUser(user.id);
      assert.equal(rescheduled?.last_error, 'edge unreachable');

      const second = await store.gatewayTeardownJobs.upsertPending(user.id, null, nowIso());
      assert.equal(second.id, first.id, 'the same row is reused');
      assert.equal(second.status, 'pending');
      assert.equal(second.attempts, 0);
      assert.equal(second.last_error, null);
      assert.equal(second.requested_by, null);

      assert.equal(await store.gatewayTeardownJobs.deleteByUser(user.id), true);
      assert.equal(await store.gatewayTeardownJobs.findByUser(user.id), null);
      assert.equal(await store.gatewayTeardownJobs.deleteByUser(user.id), false);
    });

    it('gatewayTeardownJobs: claims a due job exactly once, then completes it', async () => {
      const user = await makeUser();
      const job = await store.gatewayTeardownJobs.upsertPending(user.id, null, nowIso());

      const claimed = await store.gatewayTeardownJobs.claimDue(nowIso(), 50);
      const mine = claimed.filter((row) => row.user_id === user.id);
      assert.equal(mine.length, 1);
      assert.equal(mine[0]?.status, 'sending');
      assert.equal(mine[0]?.attempts, 1, 'claiming increments the attempt counter');

      const again = await store.gatewayTeardownJobs.claimDue(nowIso(), 50);
      assert.equal(
        again.filter((row) => row.user_id === user.id).length,
        0,
        'a claimed job is never handed out twice',
      );

      // A failure is a retry, not a terminal state: the row goes back to
      // `pending` with the reason and a backoff stamp.
      await store.gatewayTeardownJobs.reschedule(job.id, isoInSeconds(-1), 'edge 500');
      const retryable = await store.gatewayTeardownJobs.findByUser(user.id);
      assert.equal(retryable?.status, 'pending');
      assert.equal(retryable?.last_error, 'edge 500');
      assert.ok((retryable?.next_attempt_at ?? '') < nowIso(), 'the job is due again');

      const reclaimed = await store.gatewayTeardownJobs.claimDue(nowIso(), 50);
      assert.equal(
        reclaimed.find((row) => row.id === job.id)?.attempts,
        2,
        'the backoff reschedule makes the job claimable again',
      );

      const at = nowIso();
      await store.gatewayTeardownJobs.markDone(job.id, at);
      const done = await store.gatewayTeardownJobs.findByUser(user.id);
      assert.equal(done?.status, 'done');
      assert.equal(done?.next_attempt_at, null);
      assert.equal(done?.last_error, null);
      assert.equal(done?.completed_at, at);
      assert.equal(done?.updated_at, at);

      assert.ok((await store.gatewayTeardownJobs.list({ status: 'done' })).total >= 1);
      assert.equal(
        (await store.gatewayTeardownJobs.list({ status: 'done' })).items.some(
          (row) => row.id === job.id,
        ),
        true,
      );
    });

    it('gatewayTeardownJobs: releaseStale returns stuck claims to pending', async () => {
      const user = await makeUser();
      await store.gatewayTeardownJobs.upsertPending(user.id, null, nowIso());
      const claimed = await store.gatewayTeardownJobs.claimDue(nowIso(), 50);
      const mine = claimed.find((row) => row.user_id === user.id);
      assert.equal(mine?.status, 'sending');

      const released = await store.gatewayTeardownJobs.releaseStale(isoInSeconds(60));
      assert.ok(released >= 1);
      assert.equal((await store.gatewayTeardownJobs.findByUser(user.id))?.status, 'pending');

      const pending = await store.gatewayTeardownJobs.list({ status: 'pending' });
      assert.ok(pending.items.some((row) => row.user_id === user.id));
      assert.ok(pending.total >= 1);
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

    it('verificationTokens: atomically claims one issue per throttle window', async () => {
      const user = await makeUser({ email: 'token-claim@example.test' });
      const first = '2026-01-01T00:00:00.000Z';
      const cutoff = '2025-12-31T23:50:00.000Z';

      const claims = await Promise.all(
        Array.from({ length: 8 }, () =>
          store.verificationTokens.claimIssue(user.id, 'password_reset', first, cutoff),
        ),
      );
      assert.equal(claims.filter(Boolean).length, 1);
      assert.equal(
        await store.verificationTokens.claimIssue(
          user.id,
          'password_reset',
          '2026-01-01T00:10:00.001Z',
          first,
        ),
        true,
      );
    });

    it('verificationTokens: single use, then invalidation and expiry sweeps', async () => {
      const user = await makeUser();
      const tokenHash = `token-${newId()}`;
      const token = await store.verificationTokens.create({
        user_id: user.id,
        token_hash: tokenHash,
        purpose: 'email_verification',
        expires_at: isoInSeconds(600),
      });
      assert.equal(token.used_at, null);
      assert.equal(token.purpose, 'email_verification');
      assert.deepEqual(
        await store.verificationTokens.findByTokenHash(tokenHash, 'email_verification'),
        token,
      );

      await assert.rejects(
        () =>
          store.verificationTokens.create({
            user_id: user.id,
            token_hash: tokenHash,
            purpose: 'email_verification',
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
      assert.ok(
        (await store.verificationTokens.findByTokenHash(tokenHash, 'email_verification'))?.used_at,
      );

      await store.verificationTokens.create({
        user_id: user.id,
        token_hash: `expired-${newId()}`,
        purpose: 'email_verification',
        expires_at: isoInSeconds(-10),
      });
      assert.equal(await store.verificationTokens.deleteExpired(nowIso()), 1);
      assert.equal(await store.verificationTokens.deleteForUser(user.id), 1);
    });

    it('verificationTokens: purpose partitions lookups, throttle reads and sweeps', async () => {
      const user = await makeUser();
      const resetHash = `reset-${newId()}`;
      const reset = await store.verificationTokens.create({
        user_id: user.id,
        token_hash: resetHash,
        purpose: 'password_reset',
        expires_at: isoInSeconds(600),
      });

      // A reset token is invisible to the verification flow and vice versa —
      // this is what stops one flow redeeming the other's links.
      assert.equal(
        await store.verificationTokens.findByTokenHash(resetHash, 'email_verification'),
        null,
      );
      assert.deepEqual(
        await store.verificationTokens.findByTokenHash(resetHash, 'password_reset'),
        reset,
      );

      const now = nowIso();
      assert.deepEqual(
        await store.verificationTokens.findLatestLiveForUser(user.id, 'password_reset', now),
        reset,
        'the live reset token is what the resend throttle sees',
      );
      assert.equal(
        await store.verificationTokens.findLatestLiveForUser(user.id, 'email_verification', now),
        null,
      );

      // Burned and expired tokens are not "live": neither should throttle a
      // request for a link the user can no longer use.
      await store.verificationTokens.markUsed(reset.id, nowIso());
      assert.equal(
        await store.verificationTokens.findLatestLiveForUser(user.id, 'password_reset', now),
        null,
        'a burned token no longer throttles',
      );
      await store.verificationTokens.create({
        user_id: user.id,
        token_hash: `stale-${newId()}`,
        purpose: 'password_reset',
        expires_at: isoInSeconds(-10),
      });
      assert.equal(
        await store.verificationTokens.findLatestLiveForUser(user.id, 'password_reset', now),
        null,
        'an expired token no longer throttles',
      );

      await store.verificationTokens.create({
        user_id: user.id,
        token_hash: `verify-${newId()}`,
        purpose: 'email_verification',
        expires_at: isoInSeconds(600),
      });
      assert.equal(
        await store.verificationTokens.deleteForUser(user.id, 'password_reset'),
        2,
        'a purpose-scoped sweep leaves the other flow alone',
      );
      assert.equal(await store.verificationTokens.deleteForUser(user.id), 1);
    });

    /* ── leases ───────────────────────────────────────────────────────── */

    it('leases: one holder at a time, taken over only after expiry', async () => {
      const key = `consumer-${newId()}`;
      const past = '2020-01-01T00:00:00.000Z';
      const future = isoInSeconds(600);
      const now = nowIso();

      assert.equal(await store.leases.acquire(key, 'instance-a', future, now), true);
      assert.equal(
        await store.leases.acquire(key, 'instance-b', future, now),
        false,
        'a live lease is refused, whoever asks',
      );
      assert.equal(
        await store.leases.acquire(key, 'instance-a', future, now),
        false,
        'and refused to the holder too — the lock is not re-entrant',
      );

      // Rewrite the row to one that expired in the past, the way a crashed
      // holder leaves it, and prove the next caller inherits it.
      assert.equal(await store.leases.renew(key, 'instance-a', past), true);
      assert.equal(await store.leases.acquire(key, 'instance-b', future, now), true);
      assert.equal(
        await store.leases.release(key, 'instance-a'),
        false,
        'the previous owner can no longer release what it lost',
      );
      assert.equal(
        await store.leases.acquire(key, 'instance-c', future, now),
        false,
        'the row survived the non-owner release',
      );

      assert.equal(await store.leases.release(key, 'instance-b'), true);
      assert.equal(
        await store.leases.acquire(key, 'instance-c', future, now),
        true,
        'a released lease is free immediately, without waiting for expiry',
      );
      assert.equal(await store.leases.release(key, 'instance-c'), true);
    });

    it('leases: renewal and the expiry sweep', async () => {
      const key = `proxy-${newId()}`;
      const now = nowIso();
      assert.equal(await store.leases.acquire(key, 'holder', isoInSeconds(600), now), true);
      assert.equal(
        await store.leases.renew(key, 'someone-else', isoInSeconds(600)),
        false,
        'only the owner may extend a lease',
      );
      assert.equal(await store.leases.renew(key, 'holder', isoInSeconds(1200)), true);
      assert.equal(await store.leases.deleteExpired(now), 0, 'a live lease is not swept');

      assert.equal(await store.leases.renew(key, 'holder', '2020-01-01T00:00:00.000Z'), true);
      assert.equal(await store.leases.deleteExpired(nowIso()), 1);
      assert.equal(await store.leases.renew(key, 'holder', isoInSeconds(600)), false);
    });

    it('leases: exactly one of ten concurrent acquires wins the key', async () => {
      const key = `race-${newId()}`;
      const now = nowIso();
      const expiresAt = isoInSeconds(600);

      const results = await Promise.all(
        Array.from({ length: 10 }, (_unused, index) =>
          store.leases.acquire(key, `instance-${index}`, expiresAt, now),
        ),
      );
      assert.equal(results.filter(Boolean).length, 1);
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
