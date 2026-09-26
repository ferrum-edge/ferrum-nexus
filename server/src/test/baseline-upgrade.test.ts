/**
 * Upgrading a database the released baseline created (issue #286).
 *
 * Each backend builds a database exactly as a release left it: only the
 * migrations in `RELEASED_MIGRATIONS` are applied, through the adapter's own
 * migration primitives, and the fixture below is written **as raw rows in the
 * baseline's physical shape** — not through the current store, whose write
 * path is the thing that changes between releases. The current store then
 * opens that database, migrates it, and must read every seeded value back
 * unchanged: accounts and roles, API ids and slugs, provider ownership,
 * specification history, grant and request state, credential metadata,
 * gateway mappings and settings, including one encrypted under
 * `NEXUS_SECRET_KEY`. Migrating again — in the same process and after a
 * restart — must change nothing, ledger included.
 *
 * The released prefix is read from the manifest and the current schema is
 * whatever `store.migrate()` builds, so every forward migration — the first is
 * `002_api_gateway_plugins` — is applied here on top of a populated baseline
 * with no change to the harness.
 *
 * - **sqlite** always runs, against a temporary file.
 * - **postgres / mysql / mongodb** run when `NEXUS_TEST_POSTGRES_URL`,
 *   `NEXUS_TEST_MYSQL_URL` or `NEXUS_TEST_MONGO_URL` is set (the CI
 *   `store-contracts` job sets all three), each in a throwaway database that
 *   is dropped afterwards. MongoDB needs a replica set, as the store does.
 */

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { MongoClient } from 'mongodb';
import mysql from 'mysql2/promise';
import pg from 'pg';

import type { DbDriver, EmailTemplateKey } from '@ferrum-nexus/shared';

import { SMTP_PASSWORD_SETTINGS_KEY } from '../admin/settings-service.js';
import { SUPER_ADMIN_CLAIM_KEY } from '../auth/service.js';
import { loadConfig } from '../config/index.js';
import { MONGO_MIGRATIONS, runMongoMigrations } from '../db/adapters/mongodb/index.js';
import { runMysqlMigrations } from '../db/adapters/mysql/migrations.js';
import { createPostgresMigrationDriver } from '../db/adapters/postgres/index.js';
import { createSqliteMigrationDriver, openSqliteDatabase } from '../db/adapters/sqlite/index.js';
import { createStore } from '../db/index.js';
import {
  loadMigrations,
  runMigrations,
  type MigrationDialect,
  type MigrationFile,
} from '../db/migrate.js';
import { RELEASED_MIGRATIONS } from '../db/released-migrations.js';
import type { NexusStore } from '../db/store.js';
import { createCrypto, hashPassword, verifyPassword } from '../lib/crypto.js';

const SECRET = 'baseline-upgrade-secret-0123456789abcdef';

/** The password every fixture account was created with. */
const FIXTURE_PASSWORD = 'correct-horse-battery-staple';

/** The plaintext behind the encrypted `smtp.password` row. */
const SMTP_PASSWORD = 'fixture-smtp-password';

const RELEASED_IDS = RELEASED_MIGRATIONS.map((entry) => entry.id);

/* ── The fixture ────────────────────────────────────────────────────────── */

/** A column value in the SQL baselines' physical shape: text, integer or NULL. */
type SqlValue = string | number | null;

/** One row to insert, in foreign-key order. */
interface FixtureRow {
  table: string;
  row: Record<string, SqlValue>;
}

/** Columns every baseline dialect stores as 0/1 and every record reads as a boolean. */
const BOOLEAN_COLUMNS = new Set([
  'email_verified',
  'circuit_breaker',
  'requestable',
  'is_current',
  'broadcast',
  'encrypted',
  'enabled',
]);

/** Stable ids, so a failure names the same row on every run. */
const ID = {
  org: '00000000-0000-4000-8000-000000000001',
  admin: '00000000-0000-4000-8000-000000000101',
  provider: '00000000-0000-4000-8000-000000000102',
  client: '00000000-0000-4000-8000-000000000103',
  former: '00000000-0000-4000-8000-000000000104',
  app: '00000000-0000-4000-8000-000000000201',
  invoices: '00000000-0000-4000-8000-000000000301',
  ledger: '00000000-0000-4000-8000-000000000302',
  specV1: '00000000-0000-4000-8000-000000000401',
  specV2: '00000000-0000-4000-8000-000000000402',
  ledgerSpec: '00000000-0000-4000-8000-000000000403',
  plugin: '00000000-0000-4000-8000-000000000501',
  viewer: '00000000-0000-4000-8000-000000000601',
  requestAccount: '00000000-0000-4000-8000-000000000701',
  requestApp: '00000000-0000-4000-8000-000000000702',
  requestFormer: '00000000-0000-4000-8000-000000000703',
  requestPending: '00000000-0000-4000-8000-000000000704',
  grantAccount: '00000000-0000-4000-8000-000000000801',
  grantApp: '00000000-0000-4000-8000-000000000802',
  grantRevoked: '00000000-0000-4000-8000-000000000803',
  consumerClient: '00000000-0000-4000-8000-000000000901',
  consumerApp: '00000000-0000-4000-8000-000000000902',
  consumerFormer: '00000000-0000-4000-8000-000000000903',
  credentialRetired: '00000000-0000-4000-8000-000000001001',
  credentialActive: '00000000-0000-4000-8000-000000001002',
  credentialApp: '00000000-0000-4000-8000-000000001003',
  credentialFormer: '00000000-0000-4000-8000-000000001004',
  gatewayIdentity: '00000000-0000-4000-8000-000000001101',
  audit: '00000000-0000-4000-8000-000000001201',
  template: '00000000-0000-4000-8000-000000001301',
} as const;

const T0 = '2026-09-01T09:00:00.000Z';
const T1 = '2026-09-02T09:00:00.000Z';
const T2 = '2026-09-03T09:00:00.000Z';

const fingerprint = (material: string): string =>
  createHash('sha256').update(material).digest('hex');

/** Edge's ACL group for an approved API; derived from the API id, so the id must survive. */
const approvedGroup = (apiId: string): string => `nexus:api:${apiId}:approved`;

/** The released-baseline database the upgrade starts from. */
async function buildFixture(): Promise<FixtureRow[]> {
  const passwordHash = await hashPassword(FIXTURE_PASSWORD);
  const encryptedSmtpPassword = createCrypto(SECRET).encryptJson(SMTP_PASSWORD);
  const stamps = { created_at: T0, updated_at: T1 };
  const user = (id: string, email: string, role: string, org: string | null): FixtureRow => ({
    table: 'users',
    row: {
      id,
      email,
      password_hash: passwordHash,
      display_name: email.split('@')[0] ?? email,
      role,
      org_id: org,
      company: org === null ? null : 'Acme Payments',
      phone: role === 'client' ? '+1 555 0100' : null,
      status: 'active',
      email_verified: 1,
      last_login_at: T1,
      ...stamps,
    },
  });
  const decided = { decided_by: ID.provider, decided_at: T1, decision_note: 'Approved' };

  return [
    {
      table: 'organizations',
      row: { id: ID.org, name: 'Acme Payments', description: 'Fixture organization', ...stamps },
    },
    user(ID.admin, 'founder@example.test', 'super_admin', null),
    user(ID.provider, 'provider@example.test', 'provider', ID.org),
    user(ID.client, 'client@example.test', 'client', null),
    user(ID.former, 'former@example.test', 'client', null),
    {
      table: 'applications',
      row: {
        id: ID.app,
        owner_user_id: ID.client,
        name: 'Billing sync',
        description: 'Nightly reconciliation',
        status: 'active',
        ...stamps,
      },
    },
    {
      table: 'apis',
      row: {
        id: ID.invoices,
        upstream_url: 'https://invoices.internal.example.test',
        cors_json: JSON.stringify({
          allowed_origins: ['https://app.example.test'],
          allow_credentials: false,
        }),
        allowed_methods_json: JSON.stringify(['GET', 'POST']),
        timeouts_json: JSON.stringify({ connect_ms: 2000, read_ms: 15000, write_ms: 15000 }),
        circuit_breaker: 1,
        spec_enforcement: 'routes',
        name: 'Invoices',
        slug: 'invoices',
        description: 'Issue and settle invoices',
        owner_user_id: ID.provider,
        ferrum_proxy_id: 'edge-proxy-invoices',
        namespace: 'nexus',
        version: '2.0.0',
        spec_format: 'openapi',
        requestable: 1,
        auth_plugin: 'key_auth',
        rate_limit_json: JSON.stringify({ limit: 120, window_seconds: 60 }),
        status: 'published',
        visibility: 'public',
        gateway_state: 'deployed',
        ...stamps,
      },
    },
    {
      // Private, not requestable, and awaiting a gateway restore: every
      // non-default flag an operator would be upset to find reset.
      table: 'apis',
      row: {
        id: ID.ledger,
        upstream_url: null,
        cors_json: null,
        allowed_methods_json: null,
        timeouts_json: null,
        circuit_breaker: 0,
        spec_enforcement: 'docs_only',
        name: 'Ledger',
        slug: 'ledger',
        description: null,
        owner_user_id: ID.provider,
        ferrum_proxy_id: null,
        namespace: 'nexus',
        version: '1.0.0',
        spec_format: 'openapi',
        requestable: 0,
        auth_plugin: 'jwt_auth',
        rate_limit_json: null,
        status: 'published',
        visibility: 'private',
        gateway_state: 'repair_required',
        ...stamps,
      },
    },
    {
      table: 'api_specs',
      row: {
        id: ID.specV1,
        api_id: ID.invoices,
        version: '1',
        raw_spec: 'openapi: 3.0.3\ninfo: { title: Invoices, version: 1.0.0 }\npaths: {}\n',
        parsed_title: 'Invoices',
        parsed_version: '1.0.0',
        is_current: 0,
        revision_seq: 1,
        created_by: ID.provider,
        rolled_back_from_id: null,
        created_at: T0,
        updated_at: T0,
      },
    },
    {
      table: 'api_specs',
      row: {
        id: ID.specV2,
        api_id: ID.invoices,
        version: '2',
        raw_spec: 'openapi: 3.1.0\ninfo: { title: Invoices, version: 2.0.0 }\npaths: {}\n',
        parsed_title: 'Invoices',
        parsed_version: '2.0.0',
        is_current: 1,
        revision_seq: 2,
        created_by: ID.provider,
        rolled_back_from_id: null,
        created_at: T1,
        updated_at: T1,
      },
    },
    {
      table: 'api_specs',
      row: {
        id: ID.ledgerSpec,
        api_id: ID.ledger,
        version: '1',
        raw_spec: '{"openapi":"3.1.0","info":{"title":"Ledger","version":"1.0.0"},"paths":{}}',
        parsed_title: 'Ledger',
        parsed_version: '1.0.0',
        is_current: 1,
        revision_seq: 1,
        created_by: null,
        rolled_back_from_id: null,
        ...stamps,
      },
    },
    {
      table: 'api_plugins',
      row: {
        id: ID.plugin,
        ferrum_plugin_config_id: 'edge-plugin-config-1',
        api_id: ID.invoices,
        plugin_name: 'request_size_limiting',
        enabled: 1,
        config_json: JSON.stringify({ max_bytes: 1048576 }),
        trigger_json: null,
        ...stamps,
      },
    },
    {
      table: 'api_viewers',
      row: {
        id: ID.viewer,
        api_id: ID.ledger,
        user_id: ID.client,
        granted_by: ID.provider,
        note: 'Design partner',
        ...stamps,
      },
    },
    {
      table: 'access_requests',
      row: {
        id: ID.requestAccount,
        api_id: ID.invoices,
        user_id: ID.client,
        application_id: null,
        justification: 'Production billing',
        status: 'approved',
        ...decided,
        ...stamps,
      },
    },
    {
      table: 'access_requests',
      row: {
        id: ID.requestApp,
        api_id: ID.invoices,
        user_id: ID.client,
        application_id: ID.app,
        justification: 'Reconciliation job',
        status: 'approved',
        ...decided,
        ...stamps,
      },
    },
    {
      table: 'access_requests',
      row: {
        id: ID.requestFormer,
        api_id: ID.invoices,
        user_id: ID.former,
        application_id: null,
        justification: 'Pilot',
        status: 'revoked',
        ...decided,
        ...stamps,
      },
    },
    {
      table: 'access_requests',
      row: {
        id: ID.requestPending,
        api_id: ID.ledger,
        user_id: ID.former,
        application_id: null,
        justification: 'Awaiting review',
        status: 'pending',
        decided_by: null,
        decided_at: null,
        decision_note: null,
        ...stamps,
      },
    },
    {
      table: 'grants',
      row: {
        id: ID.grantAccount,
        api_id: ID.invoices,
        user_id: ID.client,
        application_id: null,
        access_request_id: ID.requestAccount,
        acl_group: approvedGroup(ID.invoices),
        status: 'active',
        granted_by: ID.provider,
        revoked_by: null,
        revoked_at: null,
        ...stamps,
      },
    },
    {
      table: 'grants',
      row: {
        id: ID.grantApp,
        api_id: ID.invoices,
        user_id: ID.client,
        application_id: ID.app,
        access_request_id: ID.requestApp,
        acl_group: approvedGroup(ID.invoices),
        status: 'active',
        granted_by: ID.provider,
        revoked_by: null,
        revoked_at: null,
        ...stamps,
      },
    },
    {
      table: 'grants',
      row: {
        id: ID.grantRevoked,
        api_id: ID.invoices,
        user_id: ID.former,
        application_id: null,
        access_request_id: ID.requestFormer,
        acl_group: approvedGroup(ID.invoices),
        status: 'revoked',
        granted_by: ID.provider,
        revoked_by: ID.provider,
        revoked_at: T2,
        created_at: T0,
        updated_at: T2,
      },
    },
    {
      table: 'consumers',
      row: {
        id: ID.consumerClient,
        user_id: ID.client,
        application_id: null,
        namespace: 'nexus',
        ferrum_consumer_id: 'edge-consumer-client',
        ferrum_username: `nexus-user-${ID.client}`,
        ...stamps,
      },
    },
    {
      table: 'consumers',
      row: {
        id: ID.consumerApp,
        user_id: ID.client,
        application_id: ID.app,
        namespace: 'nexus',
        ferrum_consumer_id: 'edge-consumer-app',
        ferrum_username: `nexus-app-${ID.app}`,
        ...stamps,
      },
    },
    {
      table: 'consumers',
      row: {
        id: ID.consumerFormer,
        user_id: ID.former,
        application_id: null,
        namespace: 'nexus',
        ferrum_consumer_id: 'edge-consumer-former',
        ferrum_username: `nexus-user-${ID.former}`,
        ...stamps,
      },
    },
    {
      // Rotated away: revoked, but still the provenance of its replacement.
      table: 'credential_metadata',
      row: {
        id: ID.credentialRetired,
        edge_ordinal: 1,
        user_id: ID.client,
        application_id: null,
        ferrum_consumer_id: 'edge-consumer-client',
        credential_type: 'keyauth',
        ferrum_credential_id: 'keyauth:0',
        fingerprint: fingerprint('fixture-key-1'),
        last4: 'e-1a',
        label: 'production',
        status: 'revoked',
        rotated_from_id: null,
        ...stamps,
      },
    },
    {
      table: 'credential_metadata',
      row: {
        id: ID.credentialActive,
        edge_ordinal: 2,
        user_id: ID.client,
        application_id: null,
        ferrum_consumer_id: 'edge-consumer-client',
        credential_type: 'keyauth',
        ferrum_credential_id: 'keyauth:0',
        fingerprint: fingerprint('fixture-key-2'),
        last4: 'e-2b',
        label: 'production',
        status: 'active',
        rotated_from_id: ID.credentialRetired,
        ...stamps,
      },
    },
    {
      table: 'credential_metadata',
      row: {
        id: ID.credentialApp,
        edge_ordinal: 1,
        user_id: ID.client,
        application_id: ID.app,
        ferrum_consumer_id: 'edge-consumer-app',
        credential_type: 'basicauth',
        ferrum_credential_id: 'basicauth:0',
        fingerprint: fingerprint('fixture-basic-1'),
        last4: 'c-3c',
        label: null,
        status: 'active',
        rotated_from_id: null,
        ...stamps,
      },
    },
    {
      // Still authenticates at Edge; its grant is what was revoked.
      table: 'credential_metadata',
      row: {
        id: ID.credentialFormer,
        edge_ordinal: null,
        user_id: ID.former,
        application_id: null,
        ferrum_consumer_id: 'edge-consumer-former',
        credential_type: 'keyauth',
        ferrum_credential_id: 'keyauth:0',
        fingerprint: fingerprint('fixture-key-3'),
        last4: 'e-4d',
        label: null,
        status: 'active',
        rotated_from_id: null,
        ...stamps,
      },
    },
    {
      table: 'gateway_identities',
      row: {
        id: ID.gatewayIdentity,
        user_id: ID.provider,
        namespace: 'nexus',
        ferrum_username: `nexus-test-${ID.invoices}`,
        ferrum_consumer_id: 'edge-consumer-test',
        ...stamps,
      },
    },
    {
      table: 'app_settings',
      row: {
        key: SUPER_ADMIN_CLAIM_KEY,
        value_json: JSON.stringify({ user_id: ID.admin }),
        encrypted: 0,
        ...stamps,
      },
    },
    {
      table: 'app_settings',
      row: {
        key: 'branding',
        value_json: JSON.stringify({ portal_name: 'Acme Developer Portal', logo_data_url: null }),
        encrypted: 0,
        ...stamps,
      },
    },
    {
      table: 'app_settings',
      row: {
        key: SMTP_PASSWORD_SETTINGS_KEY,
        value_json: JSON.stringify(encryptedSmtpPassword),
        encrypted: 1,
        ...stamps,
      },
    },
    {
      table: 'audit_logs',
      row: {
        id: ID.audit,
        actor_user_id: ID.provider,
        actor_role: 'provider',
        action: 'grant.revoke',
        target_type: 'grant',
        target_id: ID.grantRevoked,
        details_json: JSON.stringify({ api_id: ID.invoices, reason: 'Pilot ended' }),
        ip: '203.0.113.7',
        created_at: T2,
      },
    },
    {
      table: 'email_templates',
      row: {
        id: ID.template,
        key: 'access_approved',
        subject: 'Access to {{api_name}} approved',
        body_html: '<p>You can now call {{api_name}}.</p>',
        body_text: 'You can now call {{api_name}}.',
        ...stamps,
      },
    },
  ];
}

/** The record field a baseline column surfaces as, with its expected decoded value. */
function expectedField(column: string, value: SqlValue): [string, unknown] {
  if (column.endsWith('_json')) {
    return [column.slice(0, -'_json'.length), value === null ? null : JSON.parse(String(value))];
  }
  if (BOOLEAN_COLUMNS.has(column)) return [column, value === 1];
  return [column, value];
}

/** Read one fixture row back through the current store's public contract. */
async function readBack(store: NexusStore, { table, row }: FixtureRow): Promise<unknown> {
  const id = String(row.id);
  switch (table) {
    case 'organizations':
      return store.organizations.findById(id);
    case 'users':
      return store.users.findById(id);
    case 'applications':
      return store.applications.findById(id);
    case 'apis':
      return store.apis.findById(id);
    case 'api_specs':
      return store.apiSpecs.findById(id);
    case 'api_plugins':
      return store.apiPlugins.find(String(row.api_id), String(row.plugin_name));
    case 'api_viewers':
      return store.apiViewers.find(String(row.api_id), String(row.user_id));
    case 'access_requests':
      return store.accessRequests.findById(id);
    case 'grants':
      return store.grants.findById(id);
    case 'consumers':
      return store.consumers.findById(id);
    case 'credential_metadata':
      return store.credentials.findById(id);
    case 'gateway_identities':
      return store.gatewayIdentities.findById(id);
    case 'app_settings':
      return store.settings.get(String(row.key));
    case 'audit_logs': {
      const page = await store.auditLogs.list({
        target_type: String(row.target_type),
        target_id: String(row.target_id),
      });
      return page.items.find((item) => item.id === id) ?? null;
    }
    case 'email_templates':
      return store.emailTemplates.get(String(row.key) as EmailTemplateKey);
    default:
      throw new Error(`No reader for fixture table ${table}`);
  }
}

/** Assert every seeded value survived; return what was read for later comparison. */
async function assertFixturePreserved(
  store: NexusStore,
  fixture: FixtureRow[],
): Promise<unknown[]> {
  const records: unknown[] = [];
  for (const entry of fixture) {
    const record = await readBack(store, entry);
    const label = `${entry.table} ${String(entry.row.id ?? entry.row.key)}`;
    assert.ok(record !== null && typeof record === 'object', `${label} is missing`);
    const fields = record as Record<string, unknown>;
    for (const [column, value] of Object.entries(entry.row)) {
      const [field, expected] = expectedField(column, value);
      assert.deepEqual(fields[field], expected, `${label}: ${field}`);
    }
    records.push(record);
  }
  return records;
}

/** What the portal needs from that data to keep working, beyond row equality. */
async function assertPortalInvariants(store: NexusStore): Promise<void> {
  // Sign-in: the stored hash still verifies, and the lookup is case-insensitive.
  const client = await store.users.findByEmail('Client@Example.test');
  assert.ok(client, 'the client is found by a case-insensitive email');
  assert.equal(client.id, ID.client);
  assert.ok(await verifyPassword(FIXTURE_PASSWORD, client.password_hash));
  assert.equal(await store.users.countActiveSuperAdmins(), 1);

  // Public API identity: slug and gateway proxy still resolve to the same id.
  assert.equal((await store.apis.findBySlug('INVOICES'))?.id, ID.invoices);
  assert.equal((await store.apis.findByProxyId('edge-proxy-invoices'))?.id, ID.invoices);
  assert.deepEqual(
    [...(await store.apis.listIdsByOwner(ID.provider))].sort(),
    [ID.invoices, ID.ledger].sort(),
  );
  assert.equal((await store.apiSpecs.findCurrentByApi(ID.invoices))?.id, ID.specV2);
  // An API the baseline published has no first-class plugin ownership record:
  // `002_api_gateway_plugins` starts it empty, which is what has the publishing
  // service recognise that API's gateway configs once instead of trusting a
  // plugin name.
  assert.deepEqual(await store.apiGatewayPlugins.listByApi(ID.invoices), []);

  // Access: the active grants are the ones Edge's ACL groups are replayed from;
  // the revoked one must not come back.
  assert.deepEqual(
    (await store.grants.listActiveByApi(ID.invoices)).map((grant) => grant.id).sort(),
    [ID.grantAccount, ID.grantApp].sort(),
  );

  // Gateway mapping and show-once metadata.
  assert.equal(
    (await store.consumers.findByUsername('nexus', `nexus-user-${ID.client}`))?.id,
    ID.consumerClient,
  );
  assert.equal(
    (await store.credentials.findByFingerprint(fingerprint('fixture-key-2')))?.id,
    ID.credentialActive,
  );

  // An encrypted setting decrypts only under the same NEXUS_SECRET_KEY.
  const smtp = await store.settings.get(SMTP_PASSWORD_SETTINGS_KEY);
  assert.ok(smtp, 'the encrypted SMTP password is still stored');
  assert.equal(smtp.encrypted, true);
  assert.equal(createCrypto(SECRET).decryptJson(String(smtp.value)), SMTP_PASSWORD);
}

/* ── Backends ───────────────────────────────────────────────────────────── */

/** One `schema_migrations` row, read straight from the database. */
interface LedgerRow {
  id: string;
  applied_at: string;
}

/** A throwaway database on one backend. */
interface UpgradeTarget {
  /** Every migration id the current code applies, in order. */
  currentIds: string[];
  /** Build the database as the released baseline left it, holding `fixture`. */
  seedBaseline(fixture: FixtureRow[]): Promise<void>;
  /** The migration ledger, read without the store. */
  ledger(): Promise<LedgerRow[]>;
  /** A current-version store over the same database, initialized but not migrated. */
  openStore(): Promise<NexusStore>;
  teardown(): Promise<void>;
}

function configFor(
  driver: DbDriver,
  url: string,
  sqlitePath = ':memory:',
): ReturnType<typeof loadConfig> {
  return loadConfig({
    NEXUS_SECRET_KEY: SECRET,
    FERRUM_ADMIN_JWT_SECRET: SECRET,
    NEXUS_ENV: 'test',
    NEXUS_DB_DRIVER: driver,
    NEXUS_DB_URL: url,
    NEXUS_SQLITE_PATH: sqlitePath,
  });
}

async function openStore(config: ReturnType<typeof loadConfig>): Promise<NexusStore> {
  const store = createStore(config);
  try {
    await store.init();
  } catch (error) {
    await store.close().catch(() => undefined);
    throw error;
  }
  return store;
}

/** The released prefix of a SQL dialect's migrations. */
function releasedSql(dialect: MigrationDialect): MigrationFile[] {
  return loadMigrations(dialect).filter((migration) => RELEASED_IDS.includes(migration.id));
}

/** `INSERT` for one fixture row, with `quote` for identifiers and `mark(i)` for parameters. */
function insertSql(
  { table, row }: FixtureRow,
  quote: (identifier: string) => string,
  mark: (index: number) => string,
): { sql: string; values: SqlValue[] } {
  const columns = Object.keys(row);
  const names = columns.map(quote).join(', ');
  const placeholders = columns.map((_, index) => mark(index)).join(', ');
  return {
    sql: `INSERT INTO ${quote(table)} (${names}) VALUES (${placeholders})`,
    values: columns.map((column) => row[column] ?? null),
  };
}

const doubleQuoted = (identifier: string): string => `"${identifier}"`;
const backQuoted = (identifier: string): string => `\`${identifier}\``;

function asLedger(rows: unknown[]): LedgerRow[] {
  return rows.map((row) => {
    const { id, applied_at: appliedAt } = row as { id: unknown; applied_at: unknown };
    return { id: String(id), applied_at: String(appliedAt) };
  });
}

function throwawayDbName(): string {
  return `nexus_upgrade_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

async function sqliteTarget(): Promise<UpgradeTarget> {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-upgrade-'));
  const path = join(dir, 'nexus.sqlite');
  return {
    currentIds: loadMigrations('sqlite').map((migration) => migration.id),
    async seedBaseline(fixture) {
      const db = openSqliteDatabase(path);
      try {
        await runMigrations(createSqliteMigrationDriver(db), releasedSql('sqlite'));
        db.transaction(() => {
          for (const entry of fixture) {
            const { sql, values } = insertSql(entry, doubleQuoted, () => '?');
            db.prepare(sql).run(...values);
          }
        })();
      } finally {
        db.close();
      }
    },
    async ledger() {
      const db = openSqliteDatabase(path);
      try {
        const rows = db.prepare('SELECT id, applied_at FROM schema_migrations ORDER BY id').all();
        return asLedger(rows);
      } finally {
        db.close();
      }
    },
    openStore: () => openStore(configFor('sqlite', '', path)),
    async teardown() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function postgresTarget(adminUrl: string): Promise<UpgradeTarget> {
  const database = throwawayDbName();
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${database}"`);
  await admin.end();
  const url = withDatabase(adminUrl, database);
  const pool = new pg.Pool({ connectionString: url });
  return {
    currentIds: loadMigrations('pg').map((migration) => migration.id),
    async seedBaseline(fixture) {
      await runMigrations(createPostgresMigrationDriver(pool), releasedSql('pg'));
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const entry of fixture) {
          const { sql, values } = insertSql(entry, doubleQuoted, (index) => `$${index + 1}`);
          await client.query(sql, values);
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async ledger() {
      const result = await pool.query('SELECT id, applied_at FROM schema_migrations ORDER BY id');
      return asLedger(result.rows);
    },
    openStore: () => openStore(configFor('postgres', url)),
    async teardown() {
      await pool.end();
      const cleaner = new pg.Client({ connectionString: adminUrl });
      await cleaner.connect();
      await cleaner.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      await cleaner.end();
    },
  };
}

async function mysqlTarget(adminUrl: string): Promise<UpgradeTarget> {
  const database = throwawayDbName();
  const admin = await mysql.createConnection(adminUrl);
  await admin.query(`CREATE DATABASE \`${database}\``);
  await admin.end();
  const url = withDatabase(adminUrl, database);
  const pool = mysql.createPool(url);
  return {
    currentIds: loadMigrations('mysql').map((migration) => migration.id),
    async seedBaseline(fixture) {
      await runMysqlMigrations(pool, releasedSql('mysql'));
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        for (const entry of fixture) {
          const { sql, values } = insertSql(entry, backQuoted, () => '?');
          await connection.execute(sql, values);
        }
        await connection.commit();
      } catch (error) {
        await connection.rollback().catch(() => undefined);
        throw error;
      } finally {
        connection.release();
      }
    },
    async ledger() {
      const [rows] = await pool.query<mysql.RowDataPacket[]>(
        'SELECT id, applied_at FROM schema_migrations ORDER BY id',
      );
      return asLedger(rows);
    },
    openStore: () => openStore(configFor('mysql', url)),
    async teardown() {
      await pool.end();
      const cleaner = await mysql.createConnection(adminUrl);
      await cleaner.query(`DROP DATABASE IF EXISTS \`${database}\``);
      await cleaner.end();
    },
  };
}

/**
 * The MongoDB document for a fixture row, in the adapter's physical shape:
 * `_id` for the id (the key, for settings), native booleans and subdocuments
 * where SQL keeps 0/1 and JSON text, and the derived lowercase companions its
 * case-insensitive unique indexes are built on.
 */
function mongoDocument({ table, row }: FixtureRow): Record<string, unknown> {
  const doc: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(row)) {
    if (column === 'id' || (table === 'app_settings' && column === 'key')) {
      doc._id = value;
      continue;
    }
    const [field, decoded] = expectedField(column, value);
    doc[field] = decoded;
  }
  const lower = (value: SqlValue | undefined): string => String(value).trim().toLowerCase();
  if (table === 'organizations' || table === 'applications') doc.name_lower = lower(row.name);
  if (table === 'apis') doc.slug_lower = lower(row.slug);
  return doc;
}

async function mongoTarget(baseUrl: string): Promise<UpgradeTarget> {
  const database = throwawayDbName();
  const url = withDatabase(baseUrl, database);
  const client = new MongoClient(url);
  await client.connect();
  const db = client.db(database);
  return {
    currentIds: MONGO_MIGRATIONS.map((step) => step.id).sort((a, b) => a.localeCompare(b)),
    async seedBaseline(fixture) {
      const released = MONGO_MIGRATIONS.filter((step) => RELEASED_IDS.includes(step.id));
      await runMongoMigrations(db, released);
      for (const entry of fixture) {
        await db.collection(entry.table).insertOne(mongoDocument(entry));
      }
    },
    async ledger() {
      const docs = await db.collection('schema_migrations').find({}).sort({ _id: 1 }).toArray();
      return docs.map((doc) => ({ id: String(doc._id), applied_at: String(doc.applied_at) }));
    },
    openStore: () => openStore(configFor('mongodb', url)),
    async teardown() {
      try {
        await db.dropDatabase();
      } finally {
        await client.close();
      }
    },
  };
}

/* ── The suite ──────────────────────────────────────────────────────────── */

function runUpgradeSuite(label: string, makeTarget: () => Promise<UpgradeTarget>): void {
  describe(`released baseline upgrade — ${label}`, { timeout: 120_000 }, () => {
    it('upgrades a baseline database without losing data, and re-runs as a no-op', async () => {
      const target = await makeTarget();
      try {
        const fixture = await buildFixture();
        await target.seedBaseline(fixture);
        const baseline = await target.ledger();
        assert.deepEqual(
          baseline.map((row) => row.id),
          RELEASED_IDS,
          'the fixture starts from exactly the released migrations',
        );

        let upgraded: LedgerRow[] = [];
        let preserved: unknown[] = [];
        const store = await target.openStore();
        try {
          await store.migrate();
          upgraded = await target.ledger();
          assert.deepEqual(
            upgraded.map((row) => row.id),
            target.currentIds,
          );
          // The released rows are the ones the baseline wrote: nothing was
          // re-applied or re-recorded on the way up.
          assert.deepEqual(
            upgraded.filter((row) => RELEASED_IDS.includes(row.id)),
            baseline,
          );
          preserved = await assertFixturePreserved(store, fixture);
          await assertPortalInvariants(store);

          // The forward migration's table is usable on the upgraded database.
          await store.apiGatewayPlugins.replace(ID.ledger, { auth: 'edge-auth-ledger' });
          assert.deepEqual(
            (await store.apiGatewayPlugins.listByApi(ID.ledger)).map((row) => row.role),
            ['auth'],
          );
          assert.equal(await store.apiGatewayPlugins.deleteByApi(ID.ledger), 1);

          // Re-running in the same process changes nothing.
          await store.migrate();
          assert.deepEqual(await target.ledger(), upgraded);
          assert.deepEqual(await assertFixturePreserved(store, fixture), preserved);
        } finally {
          await store.close();
        }

        // Nor does the next boot, which is what every restart does.
        const restarted = await target.openStore();
        try {
          await restarted.migrate();
          assert.deepEqual(await target.ledger(), upgraded);
          assert.deepEqual(await assertFixturePreserved(restarted, fixture), preserved);
          await assertPortalInvariants(restarted);
        } finally {
          await restarted.close();
        }
      } finally {
        await target.teardown();
      }
    });
  });
}

/** Register a backend's suite, or one skipped test naming the variable that enables it. */
function register(
  label: string,
  url: string | undefined,
  variable: string,
  makeTarget: (url: string) => Promise<UpgradeTarget>,
): void {
  if (url === undefined || url.trim() === '') {
    describe(`released baseline upgrade — ${label}`, () => {
      it(`skipped — set ${variable} to run against a real ${label} server`, {
        skip: `${variable} is not set`,
      });
    });
    return;
  }
  runUpgradeSuite(label, () => makeTarget(url));
}

runUpgradeSuite('sqlite', sqliteTarget);
register(
  'postgres',
  process.env.NEXUS_TEST_POSTGRES_URL,
  'NEXUS_TEST_POSTGRES_URL',
  postgresTarget,
);
register('mysql', process.env.NEXUS_TEST_MYSQL_URL, 'NEXUS_TEST_MYSQL_URL', mysqlTarget);
register('mongodb', process.env.NEXUS_TEST_MONGO_URL, 'NEXUS_TEST_MONGO_URL', mongoTarget);
