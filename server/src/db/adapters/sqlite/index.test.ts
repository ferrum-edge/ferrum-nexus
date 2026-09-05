import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { loadConfig } from '../../../config/index.js';
import { isNexusError } from '../../../lib/errors.js';
import { isoInSeconds, newId, nowIso } from '../../../lib/ids.js';
import { runMigrations, splitSqlStatements, type MigrationFile } from '../../migrate.js';
import type { NexusStore, UserRecord } from '../../store.js';
import { createSqliteStore } from './index.js';

const SECRET = 'sqlite-adapter-test-secret-0123456789ab';

function testConfig() {
  return loadConfig({
    NEXUS_SECRET_KEY: SECRET,
    FERRUM_ADMIN_JWT_SECRET: SECRET,
    NEXUS_SQLITE_PATH: ':memory:',
    NEXUS_ENV: 'test',
  });
}

let store: NexusStore;

async function makeUser(overrides: Partial<UserRecord> = {}): Promise<UserRecord> {
  return store.users.create({
    email: overrides.email ?? `${newId()}@example.test`,
    password_hash: 'scrypt:16384:8:1:c2FsdA==:aGFzaA==',
    display_name: overrides.display_name ?? 'Test User',
    role: overrides.role ?? 'client',
    status: overrides.status ?? 'active',
    email_verified: overrides.email_verified ?? false,
    ...(overrides.org_id !== undefined ? { org_id: overrides.org_id } : {}),
  });
}

describe('sqlite store', () => {
  before(async () => {
    store = createSqliteStore(testConfig());
    await store.init();
    await store.migrate();
  });

  after(async () => {
    await store.close();
  });

  describe('migrations', () => {
    it('is idempotent — migrating twice changes nothing', async () => {
      await store.migrate();
      await store.migrate();
      const user = await makeUser();
      assert.ok(user.id);
    });

    it('applies each migration once and skips it thereafter', async () => {
      const applied: string[] = [];
      const driver = {
        ensureMigrationsTable: async (): Promise<void> => undefined,
        listApplied: async (): Promise<string[]> => [...applied],
        applyMigration: async (migration: MigrationFile): Promise<void> => {
          applied.push(migration.id);
        },
      };
      const migrations: MigrationFile[] = [
        { id: '002_second', filename: '002_second.sql', sql: '' },
        { id: '001_first', filename: '001_first.sql', sql: '' },
      ];

      const first = await runMigrations(driver, migrations);
      assert.deepEqual(first.applied, ['001_first', '002_second']);
      assert.deepEqual(first.skipped, []);

      const second = await runMigrations(driver, migrations);
      assert.deepEqual(second.applied, []);
      assert.deepEqual(second.skipped, ['001_first', '002_second']);
    });

    it('splits SQL into statements, ignoring comments and quoted semicolons', () => {
      const statements = splitSqlStatements(
        "-- a comment;\nCREATE TABLE t (a TEXT);\nINSERT INTO t VALUES ('x;y'); -- trailing\n",
      );
      assert.equal(statements.length, 2);
      assert.match(statements[0] ?? '', /^CREATE TABLE t/);
      assert.match(statements[1] ?? '', /'x;y'/);
    });
  });

  describe('users', () => {
    it('creates, finds and updates', async () => {
      const created = await makeUser({ email: 'Alice@Example.Test', display_name: 'Alice' });
      assert.equal(created.email, 'alice@example.test', 'email is lowercased on write');

      assert.deepEqual(await store.users.findById(created.id), created);
      assert.deepEqual(await store.users.findByEmail('ALICE@EXAMPLE.TEST'), created);
      assert.equal(await store.users.findByEmail('nobody@example.test'), null);

      const updated = await store.users.update(created.id, {
        display_name: 'Alice B',
        email_verified: true,
      });
      assert.equal(updated?.display_name, 'Alice B');
      assert.equal(updated?.email_verified, true, 'booleans survive the 0/1 round trip');
      assert.notEqual(updated?.updated_at, undefined);

      assert.equal(await store.users.update(newId(), { display_name: 'ghost' }), null);
    });

    it('rejects a duplicate email with CONFLICT, case-insensitively', async () => {
      await makeUser({ email: 'dupe@example.test' });
      await assert.rejects(
        () => makeUser({ email: 'DUPE@example.test' }),
        (error: unknown) => isNexusError(error) && error.code === 'CONFLICT',
      );
    });

    it('counts active super admins, honouring the exclusion', async () => {
      const before = await store.users.countActiveSuperAdmins();
      const boss = await makeUser({ role: 'super_admin' });
      assert.equal(await store.users.countActiveSuperAdmins(), before + 1);
      assert.equal(await store.users.countActiveSuperAdmins(boss.id), before);

      await store.users.update(boss.id, { status: 'disabled' });
      assert.equal(await store.users.countActiveSuperAdmins(), before);
    });

    it('filters, paginates and reports the unpaginated total', async () => {
      const marker = `filter-${newId().slice(0, 8)}`;
      for (let i = 0; i < 5; i += 1) {
        await makeUser({ display_name: `${marker} ${i}`, role: 'provider' });
      }
      const page = await store.users.list({ q: marker, role: 'provider' }, { limit: 2, offset: 0 });
      assert.equal(page.items.length, 2);
      assert.equal(page.total, 5);

      const second = await store.users.list({ q: marker }, { limit: 2, offset: 4 });
      assert.equal(second.items.length, 1);

      const recipients = await store.users.listRecipients({ q: marker });
      assert.equal(recipients.length, 5, 'listRecipients is unpaginated');
    });

    it('touches last_login_at without rewriting the row', async () => {
      const user = await makeUser();
      const at = nowIso();
      await store.users.touchLastLogin(user.id, at);
      const reloaded = await store.users.findById(user.id);
      assert.equal(reloaded?.last_login_at, at);
      assert.equal(reloaded?.display_name, user.display_name);
    });
  });

  describe('sessions', () => {
    it('creates, looks up by hash, slides and deletes', async () => {
      const user = await makeUser();
      const session = await store.sessions.create({
        token_hash: `hash-${newId()}`,
        user_id: user.id,
        csrf_token: 'csrf',
        expires_at: isoInSeconds(60),
        ip: '127.0.0.1',
        user_agent: 'test',
      });

      assert.deepEqual(await store.sessions.findByTokenHash(session.token_hash), session);

      const later = isoInSeconds(600);
      await store.sessions.touch(session.id, later);
      assert.equal((await store.sessions.findById(session.id))?.expires_at, later);

      assert.equal(await store.sessions.delete(session.id), true);
      assert.equal(await store.sessions.delete(session.id), false);
    });

    it('deletes every session of a user, and expired sessions', async () => {
      const user = await makeUser();
      for (let i = 0; i < 3; i += 1) {
        await store.sessions.create({
          token_hash: `bulk-${newId()}`,
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

    it('rejects a duplicate token hash', async () => {
      const user = await makeUser();
      const tokenHash = `unique-${newId()}`;
      await store.sessions.create({
        token_hash: tokenHash,
        user_id: user.id,
        csrf_token: 'csrf',
        expires_at: isoInSeconds(60),
      });
      await assert.rejects(
        () =>
          store.sessions.create({
            token_hash: tokenHash,
            user_id: user.id,
            csrf_token: 'csrf',
            expires_at: isoInSeconds(60),
          }),
        (error: unknown) => isNexusError(error) && error.code === 'CONFLICT',
      );
    });
  });

  describe('apis, specs, requests and grants', () => {
    it('stores rate limits as structured JSON and enforces slug uniqueness', async () => {
      const owner = await makeUser({ role: 'provider' });
      const slug = `billing-${newId().slice(0, 8)}`;
      const api = await store.apis.create({
        name: 'Billing',
        slug,
        owner_user_id: owner.id,
        namespace: 'nexus',
        version: '1.0.0',
        spec_format: 'openapi',
        requestable: true,
        auth_plugin: 'key_auth',
        rate_limit: { limit: 60, window_seconds: 60 },
        status: 'published',
        visibility: 'public',
      });
      assert.deepEqual(api.rate_limit, { limit: 60, window_seconds: 60 });
      assert.equal(api.requestable, true);

      assert.deepEqual(await store.apis.findBySlug(slug.toUpperCase()), api);
      await assert.rejects(
        () =>
          store.apis.create({
            name: 'Other',
            slug: slug.toUpperCase(),
            owner_user_id: owner.id,
            namespace: 'nexus',
            version: '1',
            spec_format: 'openapi',
            requestable: false,
            auth_plugin: 'key_auth',
            status: 'published',
            visibility: 'public',
          }),
        (error: unknown) => isNexusError(error) && error.code === 'CONFLICT',
      );

      const cleared = await store.apis.update(api.id, { rate_limit: null });
      assert.equal(cleared?.rate_limit, null);
    });

    it('stores the recorded upstream and the CORS policy, and clears both', async () => {
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
      assert.deepEqual(api.cors, cors);
      assert.deepEqual(await store.apis.findById(api.id), api);

      const moved = await store.apis.update(api.id, {
        upstream_url: 'http://other.example.com:8080/base',
        cors: { allowed_origins: ['https://a.example.com'], allow_credentials: false },
      });
      assert.equal(moved?.upstream_url, 'http://other.example.com:8080/base');
      assert.deepEqual(moved?.cors, {
        allowed_origins: ['https://a.example.com'],
        allow_credentials: false,
      });

      const cleared = await store.apis.update(api.id, { upstream_url: null, cors: null });
      assert.equal(cleared?.upstream_url, null);
      assert.equal(cleared?.cors, null);

      // Omitting both on create leaves them NULL rather than defaulting.
      const bare = await store.apis.create({
        name: 'Bare',
        slug: `bare-${newId().slice(0, 8)}`,
        owner_user_id: owner.id,
        namespace: 'nexus',
        version: '1.0.0',
        spec_format: 'openapi',
        requestable: false,
        auth_plugin: 'key_auth',
        status: 'published',
        visibility: 'public',
      });
      assert.equal(bare.upstream_url, null);
      assert.equal(bare.cors, null);
    });

    it('stores the proxy runtime settings and their cleared state', async () => {
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
        allowed_methods: ['GET', 'POST'],
        timeouts: { connect_ms: 1_000, read_ms: 2_000, write_ms: 3_000 },
        circuit_breaker: true,
        status: 'published',
        visibility: 'public',
      });
      assert.deepEqual(api.allowed_methods, ['GET', 'POST']);
      assert.deepEqual(api.timeouts, { connect_ms: 1_000, read_ms: 2_000, write_ms: 3_000 });
      assert.equal(api.circuit_breaker, true, 'the 0/1 column crosses the boundary as a boolean');
      assert.deepEqual(await store.apis.findById(api.id), api);

      const cleared = await store.apis.update(api.id, {
        allowed_methods: null,
        timeouts: null,
        circuit_breaker: false,
      });
      assert.equal(cleared?.allowed_methods, null);
      assert.equal(cleared?.timeouts, null);
      assert.equal(cleared?.circuit_breaker, false);

      // Omitting them on create leaves NULL / the column default, which is what
      // every row published before migration 004 reads back as.
      const bare = await store.apis.create({
        name: 'Untuned',
        slug: `untuned-${newId().slice(0, 8)}`,
        owner_user_id: owner.id,
        namespace: 'nexus',
        version: '1.0.0',
        spec_format: 'openapi',
        requestable: false,
        auth_plugin: 'key_auth',
        status: 'published',
        visibility: 'public',
      });
      assert.equal(bare.allowed_methods, null);
      assert.equal(bare.timeouts, null);
      assert.equal(bare.circuit_breaker, false);
    });

    it('stores the OpenAPI enforcement level and defaults it to docs_only', async () => {
      const owner = await makeUser({ role: 'provider' });
      const enforcing = await store.apis.create({
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
      assert.equal(enforcing.spec_enforcement, 'routes');
      assert.deepEqual(await store.apis.findById(enforcing.id), enforcing);

      const relaxed = await store.apis.update(enforcing.id, { spec_enforcement: 'docs_only' });
      assert.equal(relaxed?.spec_enforcement, 'docs_only');

      // Omitting it on create takes the column default, which is what every row
      // published before migration 005 reads back as.
      const bare = await store.apis.create({
        name: 'Unenforced',
        slug: `unenforced-${newId().slice(0, 8)}`,
        owner_user_id: owner.id,
        namespace: 'nexus',
        version: '1.0.0',
        spec_format: 'openapi',
        requestable: false,
        auth_plugin: 'key_auth',
        status: 'published',
        visibility: 'public',
      });
      assert.equal(bare.spec_enforcement, 'docs_only');
    });

    it('keeps exactly one current spec revision per API', async () => {
      const owner = await makeUser({ role: 'provider' });
      const api = await store.apis.create({
        name: 'Specs',
        slug: `specs-${newId().slice(0, 8)}`,
        owner_user_id: owner.id,
        namespace: 'nexus',
        version: '1',
        spec_format: 'openapi',
        requestable: false,
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

      const all = await store.apiSpecs.list({ api_id: api.id });
      assert.equal(all.total, 2);
    });

    it('upserts one palette plugin row per (api, plugin) and cascades on delete', async () => {
      const owner = await makeUser({ role: 'provider' });
      const api = await store.apis.create({
        name: 'Palette',
        slug: `palette-${newId().slice(0, 8)}`,
        owner_user_id: owner.id,
        namespace: 'nexus',
        version: '1.0.0',
        spec_format: 'openapi',
        requestable: false,
        auth_plugin: 'key_auth',
        status: 'published',
        visibility: 'public',
      });

      const created = await store.apiPlugins.upsert({
        api_id: api.id,
        plugin_name: 'response_caching',
        enabled: true,
        config: { ttl_seconds: 300, cacheable_status_codes: [200, 404] },
        trigger: null,
      });
      // The `*_json` columns are decoded at the adapter boundary: services see
      // real objects and real booleans, never JSON text or 0/1.
      assert.deepEqual(created.config, { ttl_seconds: 300, cacheable_status_codes: [200, 404] });
      assert.equal(created.enabled, true);
      assert.equal(created.trigger, null);
      assert.deepEqual(await store.apiPlugins.find(api.id, 'response_caching'), created);

      const replaced = await store.apiPlugins.upsert({
        api_id: api.id,
        plugin_name: 'response_caching',
        enabled: false,
        config: { ttl_seconds: 60 },
        trigger: { methods: ['GET'], path_prefix: '/nexus/palette/reports' },
      });
      assert.equal(replaced.id, created.id, 'ON CONFLICT updates rather than inserting a second');
      assert.equal(replaced.created_at, created.created_at);
      assert.equal(replaced.enabled, false);
      assert.deepEqual(replaced.trigger, {
        methods: ['GET'],
        path_prefix: '/nexus/palette/reports',
      });

      await store.apiPlugins.upsert({
        api_id: api.id,
        plugin_name: 'correlation_id',
        enabled: true,
        config: {},
        trigger: null,
      });
      assert.equal((await store.apiPlugins.listByApi(api.id)).length, 2);

      assert.equal(await store.apiPlugins.delete(api.id, 'correlation_id'), true);
      assert.equal(await store.apiPlugins.delete(api.id, 'correlation_id'), false);

      // The FK cascade is what keeps a deleted API from leaving orphan rows,
      // and it is exercised here rather than only through the service.
      assert.equal(await store.apis.delete(api.id), true);
      assert.deepEqual(await store.apiPlugins.listByApi(api.id), []);
    });

    it('allows only one active grant per api/user pair', async () => {
      const owner = await makeUser({ role: 'provider' });
      const client = await makeUser();
      const api = await store.apis.create({
        name: 'Grants',
        slug: `grants-${newId().slice(0, 8)}`,
        owner_user_id: owner.id,
        namespace: 'nexus',
        version: '1',
        spec_format: 'openapi',
        requestable: true,
        auth_plugin: 'key_auth',
        status: 'published',
        visibility: 'public',
      });

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

      // Revoking frees the slot for a later re-approval.
      await store.grants.update(grant.id, { status: 'revoked', revoked_at: nowIso() });
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
    });

    it('allows only one pending access request per api/user pair', async () => {
      const owner = await makeUser({ role: 'provider' });
      const client = await makeUser();
      const api = await store.apis.create({
        name: 'Requests',
        slug: `requests-${newId().slice(0, 8)}`,
        owner_user_id: owner.id,
        namespace: 'nexus',
        version: '1',
        spec_format: 'openapi',
        requestable: true,
        auth_plugin: 'key_auth',
        status: 'published',
        visibility: 'public',
      });

      const request = await store.accessRequests.create({
        api_id: api.id,
        user_id: client.id,
        justification: 'please',
        status: 'pending',
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

      await store.accessRequests.update(request.id, {
        status: 'approved',
        decided_by: owner.id,
        decided_at: nowIso(),
      });
      const latest = await store.accessRequests.findLatestByApiAndUser(api.id, client.id);
      assert.equal(latest?.status, 'approved');
      assert.equal((await store.accessRequests.listLatestForUser(client.id, [api.id])).length, 1);
    });
  });

  describe('consumers and credentials', () => {
    it('maps one consumer per user per namespace and rejects duplicates', async () => {
      const user = await makeUser();
      const consumer = await store.consumers.create({
        user_id: user.id,
        namespace: 'nexus',
        ferrum_consumer_id: user.id,
        ferrum_username: `nexus-user-${user.id}`,
      });
      assert.deepEqual(await store.consumers.findByUserAndNamespace(user.id, 'nexus'), consumer);
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
    });

    it('stores credential metadata with a unique fingerprint', async () => {
      const user = await makeUser();
      const credential = await store.credentials.create({
        user_id: user.id,
        ferrum_consumer_id: user.id,
        credential_type: 'keyauth',
        ferrum_credential_id: 'keyauth:0',
        fingerprint: `fp-${newId()}`,
        last4: 'abcd',
        status: 'active',
      });
      assert.equal(credential.status, 'active');
      assert.deepEqual(
        await store.credentials.findByFingerprint(credential.fingerprint),
        credential,
      );
      await assert.rejects(
        () =>
          store.credentials.create({
            user_id: user.id,
            ferrum_consumer_id: user.id,
            credential_type: 'keyauth',
            ferrum_credential_id: 'keyauth:1',
            fingerprint: credential.fingerprint,
            last4: 'abcd',
            status: 'active',
          }),
        (error: unknown) => isNexusError(error) && error.code === 'CONFLICT',
      );

      const listed = await store.credentials.listByConsumer(user.id, 'keyauth');
      assert.equal(listed.length, 1);
    });
  });

  describe('email outbox', () => {
    it('suppresses duplicate sends by idempotency key', async () => {
      const key = `verify-${newId()}`;
      const first = await store.emailOutbox.enqueue({
        to_email: 'a@example.test',
        subject: 'Verify',
        body_html: '<p>hi</p>',
        body_text: 'hi',
        idempotency_key: key,
      });
      assert.equal(first.created, true);

      const second = await store.emailOutbox.enqueue({
        to_email: 'a@example.test',
        subject: 'Verify again',
        body_html: '<p>hi</p>',
        body_text: 'hi',
        idempotency_key: key,
      });
      assert.equal(second.created, false);
      assert.equal(second.entry.id, first.entry.id);
      assert.equal(second.entry.subject, 'Verify');
    });

    it('claims due rows exactly once and tracks retries', async () => {
      const marker = `claim-${newId()}@example.test`;
      await store.emailOutbox.enqueue({
        to_email: marker,
        subject: 'Due',
        body_html: '<p>x</p>',
        body_text: 'x',
      });

      const claimed = await store.emailOutbox.claimDue(nowIso(), 10);
      const mine = claimed.filter((entry) => entry.to_email === marker);
      assert.equal(mine.length, 1);
      assert.equal(mine[0]?.status, 'sending');
      assert.equal(mine[0]?.attempts, 1);

      // Already claimed rows are not handed out again.
      const again = await store.emailOutbox.claimDue(nowIso(), 10);
      assert.equal(again.filter((entry) => entry.to_email === marker).length, 0);

      const id = mine[0]?.id ?? '';
      await store.emailOutbox.reschedule(id, isoInSeconds(-1), 'smtp timeout');
      const rescheduled = await store.emailOutbox.findById(id);
      assert.equal(rescheduled?.status, 'pending');
      assert.equal(rescheduled?.last_error, 'smtp timeout');

      await store.emailOutbox.markFailed(id, 'gave up');
      assert.equal((await store.emailOutbox.findById(id))?.status, 'failed');
    });
  });

  describe('settings, templates and audit', () => {
    it('upserts settings and preserves the encrypted flag', async () => {
      await store.settings.set('branding', { portal_name: 'Nexus' });
      const row = await store.settings.get('branding');
      assert.deepEqual(row?.value, { portal_name: 'Nexus' });
      assert.equal(row?.encrypted, false);

      await store.settings.set('smtp.password', 'v1:aa:bb:cc', true);
      const secret = await store.settings.get('smtp.password');
      assert.equal(secret?.encrypted, true);
      assert.equal(secret?.value, 'v1:aa:bb:cc');

      await store.settings.setMany([
        { key: 'branding', value: { portal_name: 'Renamed' } },
        { key: 'registration', value: { open_registration: false } },
      ]);
      assert.deepEqual((await store.settings.get('branding'))?.value, { portal_name: 'Renamed' });
      assert.equal((await store.settings.getMany(['branding', 'registration'])).length, 2);
      assert.equal(await store.settings.delete('branding'), true);
    });

    it('upserts email templates by key', async () => {
      await store.emailTemplates.upsert('verification', {
        subject: 'Verify',
        body_html: '<p>a</p>',
        body_text: 'a',
      });
      await store.emailTemplates.upsert('verification', {
        subject: 'Verify now',
        body_html: '<p>b</p>',
        body_text: 'b',
      });
      const template = await store.emailTemplates.get('verification');
      assert.equal(template?.subject, 'Verify now');
      assert.equal((await store.emailTemplates.list()).length, 1);
    });

    it('filters audit rows by actor, action and time', async () => {
      const actor = await makeUser({ role: 'admin' });
      const from = nowIso();
      await store.auditLogs.create({
        actor_user_id: actor.id,
        actor_role: 'admin',
        action: 'auth.login',
        target_type: 'user',
        target_id: actor.id,
        details: { email: 'x@example.test' },
      });
      await store.auditLogs.create({
        actor_user_id: actor.id,
        actor_role: 'admin',
        action: 'admin.settings_update',
        target_type: 'settings',
        details: {},
      });

      const byAction = await store.auditLogs.list({
        actor_user_id: actor.id,
        action: 'auth.login',
      });
      assert.equal(byAction.total, 1);
      assert.deepEqual(byAction.items[0]?.details, { email: 'x@example.test' });

      const byActor = await store.auditLogs.list({ actor_user_id: actor.id });
      assert.equal(byActor.total, 2);

      const window = await store.auditLogs.list({
        actor_user_id: actor.id,
        from,
        to: isoInSeconds(60),
      });
      assert.equal(window.total, 2);
      const empty = await store.auditLogs.list({ actor_user_id: actor.id, to: from });
      assert.equal(empty.total, 0);
    });
  });

  describe('notifications', () => {
    it('creates in bulk and marks read', async () => {
      const user = await makeUser();
      await store.notifications.createMany([
        { user_id: user.id, type: 'system', title: 'One', body: 'a' },
        { user_id: user.id, type: 'system', title: 'Two', body: 'b' },
      ]);
      assert.equal(await store.notifications.countUnread(user.id), 2);

      const unread = await store.notifications.list({ user_id: user.id, unread: true });
      const firstId = unread.items[0]?.id ?? '';
      assert.equal(await store.notifications.markRead(user.id, [firstId], nowIso()), 1);
      assert.equal(await store.notifications.markRead(user.id, [firstId], nowIso()), 0);
      assert.equal(await store.notifications.markAllRead(user.id, nowIso()), 1);
      assert.equal(await store.notifications.countUnread(user.id), 0);
    });
  });

  describe('transactions', () => {
    it('commits when the body resolves', async () => {
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

    it('rolls back every statement when the body throws', async () => {
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
            throw new Error('boom');
          }),
        /boom/,
      );
      assert.equal(await store.users.findByEmail(email), null);
    });

    it('serialises concurrent transaction bodies', async () => {
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

    it('joins an outer transaction rather than nesting', async () => {
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

    it('joins a nested call issued after the outer body has awaited', async () => {
      const email = `tx-nested-async-${newId()}@example.test`;
      await store.transaction(async (tx) => {
        await new Promise((resolve) => setImmediate(resolve));
        await tx.transaction(async (inner) => {
          await inner.users.create({
            email,
            password_hash: 'scrypt:16384:8:1:c2FsdA==:aGFzaA==',
            display_name: 'Nested after await',
            role: 'client',
            status: 'active',
            email_verified: false,
          });
        });
      });
      assert.ok(await store.users.findByEmail(email));
    });

    it('queues an unrelated caller that arrives while a body is awaiting', async () => {
      const rolledBack = `tx-unrelated-a-${newId()}@example.test`;
      const survives = `tx-unrelated-b-${newId()}@example.test`;
      let release = (): void => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let aBodyStarted = (): void => {};
      const started = new Promise<void>((resolve) => {
        aBodyStarted = resolve;
      });

      const a = store.transaction(async (tx) => {
        await tx.users.create({
          email: rolledBack,
          password_hash: 'scrypt:16384:8:1:c2FsdA==:aGFzaA==',
          display_name: 'Rolled back',
          role: 'client',
          status: 'active',
          email_verified: false,
        });
        aBodyStarted();
        await gate;
        throw new Error('a rolls back');
      });
      // A is now suspended mid-body with `BEGIN` held. B is a completely
      // independent caller, not a nested one.
      await started;

      let bSettled = false;
      const b = store
        .transaction(async (tx) => {
          await tx.users.create({
            email: survives,
            password_hash: 'scrypt:16384:8:1:c2FsdA==:aGFzaA==',
            display_name: 'Independent',
            role: 'client',
            status: 'active',
            email_verified: false,
          });
        })
        .then(() => {
          bSettled = true;
        });
      await new Promise((resolve) => setImmediate(resolve));
      // B must wait for A rather than joining it and sharing its fate.
      assert.equal(bSettled, false);

      release();
      await assert.rejects(() => a, /a rolls back/);
      await b;

      assert.equal(await store.users.findByEmail(rolledBack), null);
      assert.ok(await store.users.findByEmail(survives), 'B committed and must survive');
    });

    it('keeps draining the queue after a body throws', async () => {
      const email = `tx-after-failure-${newId()}@example.test`;
      const failing = store.transaction(async () => {
        await new Promise((resolve) => setImmediate(resolve));
        throw new Error('queue head failed');
      });
      const following = store.transaction(async (tx) => {
        await tx.users.create({
          email,
          password_hash: 'scrypt:16384:8:1:c2FsdA==:aGFzaA==',
          display_name: 'After a failure',
          role: 'client',
          status: 'active',
          email_verified: false,
        });
      });
      await assert.rejects(() => failing, /queue head failed/);
      await following;
      assert.ok(await store.users.findByEmail(email));
    });

    it('treats a root-store call made from inside the body as part of it', async () => {
      // One connection, a synchronous driver: a bare `store.*` call issued from
      // the body's own async context carries the transaction's token, so it is
      // nested work and shares the transaction's fate exactly as `tx.*` does.
      // Asserted so the behaviour is a decision rather than a surprise; the
      // tests below cover the calls that do *not* come from the body.
      const email = `tx-root-write-${newId()}@example.test`;
      await assert.rejects(
        () =>
          store.transaction(async () => {
            await store.users.create({
              email,
              password_hash: 'scrypt:16384:8:1:c2FsdA==:aGFzaA==',
              display_name: 'Root write',
              role: 'client',
              status: 'active',
              email_verified: false,
            });
            throw new Error('outer rolls back');
          }),
        /outer rolls back/,
      );
      assert.equal(await store.users.findByEmail(email), null);
    });

    it('parks outside reads and writes until the open transaction has ended', async () => {
      const dirty = `tx-dirty-${newId()}@example.test`;
      const outside = `tx-outside-${newId()}@example.test`;
      let release = (): void => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let aBodyStarted = (): void => {};
      const started = new Promise<void>((resolve) => {
        aBodyStarted = resolve;
      });

      const a = store.transaction(async (tx) => {
        await tx.users.create({
          email: dirty,
          password_hash: 'scrypt:16384:8:1:c2FsdA==:aGFzaA==',
          display_name: 'Uncommitted',
          role: 'client',
          status: 'active',
          email_verified: false,
        });
        aBodyStarted();
        await gate;
        throw new Error('a rolls back');
      });
      await started;

      // Neither call carries A's token: both are independent callers that, on
      // one synchronous connection, would otherwise execute inside A.
      let readSettled = false;
      const read = store.users.findByEmail(dirty).then((row) => {
        readSettled = true;
        return row;
      });
      let writeSettled = false;
      const write = store.users
        .create({
          email: outside,
          password_hash: 'scrypt:16384:8:1:c2FsdA==:aGFzaA==',
          display_name: 'Outside write',
          role: 'client',
          status: 'active',
          email_verified: false,
        })
        .then((row) => {
          writeSettled = true;
          return row;
        });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(readSettled, false, 'an outside read must wait for the open transaction');
      assert.equal(writeSettled, false, 'an outside write must wait for the open transaction');

      release();
      await assert.rejects(() => a, /a rolls back/);
      assert.equal(await read, null, 'the read ran after the rollback and saw no dirty row');
      assert.ok(await write, 'the write ran after the rollback');
      assert.ok(await store.users.findByEmail(outside), 'and survived it');
      assert.equal(await store.users.findByEmail(dirty), null);
    });

    it('lets a parked read see what the transaction committed', async () => {
      const email = `tx-committed-${newId()}@example.test`;
      let release = (): void => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let aBodyStarted = (): void => {};
      const started = new Promise<void>((resolve) => {
        aBodyStarted = resolve;
      });

      const a = store.transaction(async (tx) => {
        await tx.users.create({
          email,
          password_hash: 'scrypt:16384:8:1:c2FsdA==:aGFzaA==',
          display_name: 'Committed later',
          role: 'client',
          status: 'active',
          email_verified: false,
        });
        aBodyStarted();
        await gate;
      });
      await started;

      let readSettled = false;
      const read = store.users.findByEmail(email).then((row) => {
        readSettled = true;
        return row;
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(readSettled, false);

      release();
      await a;
      assert.ok(await read, 'the read ran after the commit and saw the row');
    });

    it('keeps nested work flowing while outside callers are parked', async () => {
      // A body that re-enters the store through `store.*`, `tx.*` and a nested
      // `transaction()` after an outside caller has queued must not deadlock on
      // that caller: the body owns the connection until it ends.
      const inside = `tx-inside-${newId()}@example.test`;
      const nested = `tx-nested-inside-${newId()}@example.test`;
      const outside = `tx-outside-parked-${newId()}@example.test`;
      let aBodyStarted = (): void => {};
      const started = new Promise<void>((resolve) => {
        aBodyStarted = resolve;
      });
      let outsideIssued = (): void => {};
      const issued = new Promise<void>((resolve) => {
        outsideIssued = resolve;
      });

      const a = store.transaction(async (tx) => {
        aBodyStarted();
        await issued;
        await store.users.create({
          email: inside,
          password_hash: 'scrypt:16384:8:1:c2FsdA==:aGFzaA==',
          display_name: 'Inside',
          role: 'client',
          status: 'active',
          email_verified: false,
        });
        await tx.transaction(async (inner) => {
          await inner.users.create({
            email: nested,
            password_hash: 'scrypt:16384:8:1:c2FsdA==:aGFzaA==',
            display_name: 'Nested inside',
            role: 'client',
            status: 'active',
            email_verified: false,
          });
        });
        assert.ok(await tx.users.findByEmail(inside), 'the body reads its own writes');
        assert.equal(await tx.users.findByEmail(outside), null, 'and not the parked one');
      });
      await started;

      const parked = store.users.create({
        email: outside,
        password_hash: 'scrypt:16384:8:1:c2FsdA==:aGFzaA==',
        display_name: 'Parked',
        role: 'client',
        status: 'active',
        email_verified: false,
      });
      outsideIssued();

      await a;
      await parked;
      assert.ok(await store.users.findByEmail(inside));
      assert.ok(await store.users.findByEmail(nested));
      assert.ok(await store.users.findByEmail(outside));
    });

    it('treats a continuation of a finished transaction as an outside caller', async () => {
      const fromA = `tx-late-a-${newId()}@example.test`;
      const fromB = `tx-late-b-${newId()}@example.test`;
      const afterwards = `tx-late-after-${newId()}@example.test`;
      let resolveIssued: (issued: { call: Promise<UserRecord> }) => void = () => {};
      const issued = new Promise<{ call: Promise<UserRecord> }>((resolve) => {
        resolveIssued = resolve;
      });

      await store.transaction(async () => {
        // Work A arms and never awaits. The callback inherits A's async context
        // — and with it A's token — but fires only after A has settled.
        setTimeout(() => {
          resolveIssued({
            call: store.users.create({
              email: fromA,
              password_hash: 'scrypt:16384:8:1:c2FsdA==:aGFzaA==',
              display_name: 'Late from A',
              role: 'client',
              status: 'active',
              email_verified: false,
            }),
          });
        }, 0);
      });

      // A has committed and its token is dead. Hold B open before the timer
      // fires, so the late call arrives while another transaction owns the
      // connection.
      let release = (): void => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let bBodyStarted = (): void => {};
      const started = new Promise<void>((resolve) => {
        bBodyStarted = resolve;
      });
      const b = store.transaction(async (tx) => {
        await tx.users.create({
          email: fromB,
          password_hash: 'scrypt:16384:8:1:c2FsdA==:aGFzaA==',
          display_name: 'B rolls back',
          role: 'client',
          status: 'active',
          email_verified: false,
        });
        bBodyStarted();
        await gate;
        throw new Error('b rolls back');
      });
      await started;

      const { call } = await issued;
      let lateSettled = false;
      const late = call.then((row) => {
        lateSettled = true;
        return row;
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(lateSettled, false, "A's dead token grants no access to B's transaction");

      release();
      await assert.rejects(() => b, /b rolls back/);
      assert.ok(await late, 'the late write ran after B');
      assert.ok(await store.users.findByEmail(fromA), 'and survived its rollback');
      assert.equal(await store.users.findByEmail(fromB), null);

      // The queue is intact afterwards.
      await store.transaction(async (tx) => {
        await tx.users.create({
          email: afterwards,
          password_hash: 'scrypt:16384:8:1:c2FsdA==:aGFzaA==',
          display_name: 'Afterwards',
          role: 'client',
          status: 'active',
          email_verified: false,
        });
      });
      assert.ok(await store.users.findByEmail(afterwards));
    });
  });

  describe('health', () => {
    it('reports ok for a live database', async () => {
      const health = await store.healthCheck();
      assert.equal(health.ok, true);
      assert.equal(health.error, null);
      assert.ok(health.latencyMs >= 0);
    });
  });
});

describe('sqlite store lifecycle', () => {
  let scratch: NexusStore;

  beforeEach(async () => {
    scratch = createSqliteStore(testConfig());
    await scratch.init();
    await scratch.migrate();
  });

  it('is safe to close twice', async () => {
    await scratch.close();
    await scratch.close();
  });
});
