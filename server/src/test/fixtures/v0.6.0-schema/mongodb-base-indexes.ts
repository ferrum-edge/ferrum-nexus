/**
 * FROZEN FIXTURE — NEVER EDIT.
 *
 * The MongoDB base schema exactly as Ferrum Nexus v0.6.0 shipped it: the
 * `BASE_INDEXES` array literal copied verbatim from
 * `git show v0.6.0:server/src/db/adapters/mongodb/index.ts` (only the constant
 * is renamed). The upgrade tests build a v0.6.0 database from it, and
 * `frozen-baseline.test.ts` checks it against the live baseline and its own
 * committed checksum. It records history: if the live schema changes, add a
 * migration; never change this file.
 */
import type { IndexDefinition } from '../../../db/adapters/mongodb/index.js';

export const V0_6_0_BASE_INDEXES: readonly IndexDefinition[] = [
  // organizations — `name_lower` is the derived companion of `lower(name)`.
  {
    collection: 'organizations',
    name: 'ux_organizations_name',
    key: { name_lower: 1 },
    unique: true,
  },

  // users — the adapter lowercases `email` on write, so a plain unique works.
  { collection: 'users', name: 'ux_users_email', key: { email: 1 }, unique: true },
  { collection: 'users', name: 'ix_users_role_status', key: { role: 1, status: 1 } },
  { collection: 'users', name: 'ix_users_org', key: { org_id: 1 } },
  { collection: 'users', name: 'ix_users_created_at', key: { created_at: 1 } },

  { collection: 'sessions', name: 'ux_sessions_token_hash', key: { token_hash: 1 }, unique: true },
  { collection: 'sessions', name: 'ix_sessions_user', key: { user_id: 1 } },
  { collection: 'sessions', name: 'ix_sessions_expires_at', key: { expires_at: 1 } },

  { collection: 'apis', name: 'ux_apis_slug', key: { slug_lower: 1 }, unique: true },
  {
    collection: 'apis',
    name: 'ux_apis_proxy_id',
    key: { ferrum_proxy_id: 1 },
    unique: true,
    partialFilterExpression: { ferrum_proxy_id: { $type: 'string' } },
  },
  {
    collection: 'applications',
    name: 'ux_applications_owner_name',
    key: { owner_user_id: 1, name_lower: 1 },
    unique: true,
  },
  {
    collection: 'applications',
    name: 'ix_applications_owner',
    key: { owner_user_id: 1, created_at: 1 },
  },

  { collection: 'apis', name: 'ix_apis_owner', key: { owner_user_id: 1 } },
  { collection: 'apis', name: 'ix_apis_status_visibility', key: { status: 1, visibility: 1 } },
  { collection: 'apis', name: 'ix_apis_created_at', key: { created_at: 1 } },
  {
    collection: 'apis',
    name: 'ix_apis_gateway_state',
    key: { namespace: 1, gateway_state: 1 },
  },

  {
    collection: 'api_specs',
    name: 'ux_api_specs_current',
    key: { api_id: 1 },
    unique: true,
    partialFilterExpression: { is_current: true },
  },
  // Publication order, and the index every `api_id` lookup uses; see the SQLite
  // schema for why the timestamp is not it.
  {
    collection: 'api_specs',
    name: 'ux_api_specs_seq',
    key: { api_id: 1, revision_seq: 1 },
    unique: true,
  },

  {
    collection: 'api_plugins',
    name: 'ux_api_plugins_api_name',
    key: { api_id: 1, plugin_name: 1 },
    unique: true,
  },
  { collection: 'api_plugins', name: 'ix_api_plugins_api', key: { api_id: 1, created_at: 1 } },

  {
    collection: 'api_viewers',
    name: 'ux_api_viewers_api_user',
    key: { api_id: 1, user_id: 1 },
    unique: true,
  },
  { collection: 'api_viewers', name: 'ix_api_viewers_user', key: { user_id: 1 } },
  { collection: 'api_viewers', name: 'ix_api_viewers_api', key: { api_id: 1, created_at: 1 } },

  {
    collection: 'access_requests',
    name: 'ux_access_requests_pending',
    // A missing field indexes as `null` in MongoDB, so this behaves exactly
    // like the SQL `COALESCE(application_id, '')` key: one open request per API
    // and identity, with the account-scoped rows sharing one slot.
    key: { api_id: 1, user_id: 1, application_id: 1 },
    unique: true,
    partialFilterExpression: { status: 'pending' },
  },
  {
    collection: 'access_requests',
    name: 'ix_access_requests_api_status',
    key: { api_id: 1, status: 1 },
  },
  {
    collection: 'access_requests',
    name: 'ix_access_requests_user',
    key: { user_id: 1, created_at: 1 },
  },
  {
    collection: 'access_requests',
    name: 'ix_access_requests_application',
    key: { application_id: 1, status: 1 },
  },

  {
    collection: 'grants',
    name: 'ux_grants_active',
    key: { api_id: 1, user_id: 1, application_id: 1 },
    unique: true,
    partialFilterExpression: { status: 'active' },
  },
  { collection: 'grants', name: 'ix_grants_user_status', key: { user_id: 1, status: 1 } },
  { collection: 'grants', name: 'ix_grants_api_status', key: { api_id: 1, status: 1 } },
  {
    collection: 'grants',
    name: 'ix_grants_application',
    key: { application_id: 1, status: 1 },
  },

  {
    collection: 'consumers',
    name: 'ux_consumers_user_namespace',
    key: { user_id: 1, namespace: 1, application_id: 1 },
    unique: true,
  },
  { collection: 'consumers', name: 'ix_consumers_application', key: { application_id: 1 } },
  {
    collection: 'consumers',
    name: 'ux_consumers_ferrum_id',
    key: { namespace: 1, ferrum_consumer_id: 1 },
    unique: true,
  },
  {
    collection: 'consumers',
    name: 'ux_consumers_username',
    key: { namespace: 1, ferrum_username: 1 },
    unique: true,
  },

  {
    collection: 'credential_metadata',
    name: 'ux_credentials_fingerprint',
    key: { fingerprint: 1 },
    unique: true,
  },
  {
    collection: 'credential_metadata',
    name: 'ix_credentials_user_status',
    key: { user_id: 1, status: 1 },
  },
  {
    collection: 'credential_metadata',
    name: 'ix_credentials_application',
    key: { application_id: 1, status: 1 },
  },
  {
    collection: 'credential_metadata',
    name: 'ix_credentials_consumer',
    key: { ferrum_consumer_id: 1, credential_type: 1, created_at: 1 },
  },

  {
    collection: 'message_threads',
    name: 'ix_threads_participant_a',
    key: { participant_a: 1, last_message_at: 1 },
  },
  {
    collection: 'message_threads',
    name: 'ix_threads_participant_b',
    key: { participant_b: 1, last_message_at: 1 },
  },
  { collection: 'message_threads', name: 'ix_threads_api', key: { api_id: 1 } },

  // The newest message of a thread is the first in NEWEST_FIRST order,
  // `(created_at desc, _id desc)`; carrying `_id` makes that lookup one index
  // seek per thread, and an oldest-first read walks the same index backwards.
  {
    collection: 'messages',
    name: 'ix_messages_thread_latest',
    key: { thread_id: 1, created_at: -1, _id: -1 },
  },

  {
    collection: 'notifications',
    name: 'ix_notifications_user',
    key: { user_id: 1, created_at: 1 },
  },
  { collection: 'notifications', name: 'ix_notifications_unread', key: { user_id: 1, read_at: 1 } },

  {
    collection: 'email_outbox',
    name: 'ux_email_outbox_idempotency',
    key: { idempotency_key: 1 },
    unique: true,
    partialFilterExpression: { idempotency_key: { $type: 'string' } },
  },
  {
    collection: 'email_outbox',
    name: 'ix_email_outbox_due',
    key: { status: 1, next_attempt_at: 1 },
  },

  { collection: 'audit_logs', name: 'ix_audit_created_at', key: { created_at: 1 } },
  { collection: 'audit_logs', name: 'ix_audit_actor', key: { actor_user_id: 1, created_at: 1 } },
  { collection: 'audit_logs', name: 'ix_audit_action', key: { action: 1, created_at: 1 } },
  { collection: 'audit_logs', name: 'ix_audit_target', key: { target_type: 1, target_id: 1 } },

  // app_settings needs no index: the setting key *is* `_id`.

  { collection: 'email_templates', name: 'ux_email_templates_key', key: { key: 1 }, unique: true },

  {
    collection: 'email_verification_tokens',
    name: 'ux_verification_tokens_hash',
    key: { token_hash: 1 },
    unique: true,
  },
  {
    collection: 'email_verification_tokens',
    name: 'ix_verification_tokens_user',
    key: { user_id: 1 },
  },
  {
    collection: 'email_verification_tokens',
    name: 'ix_verification_tokens_expires',
    key: { expires_at: 1 },
  },

  {
    collection: 'messages',
    name: 'ix_messages_sender',
    key: { sender_user_id: 1, created_at: 1 },
  },

  {
    collection: 'email_verification_tokens',
    name: 'ix_verification_tokens_user_purpose',
    key: { user_id: 1, purpose: 1 },
  },

  {
    collection: 'gateway_teardown_jobs',
    name: 'ux_gateway_teardown_jobs_user',
    key: { user_id: 1 },
    unique: true,
  },
  {
    collection: 'gateway_teardown_jobs',
    name: 'ix_gateway_teardown_jobs_due',
    key: { status: 1, next_attempt_at: 1 },
  },

  // `_id` already carries the key, so this is the redundant-but-explicit
  // counterpart of the SQL primary key; the expiry index backs the
  // housekeeping sweep.
  { collection: 'edge_leases', name: 'ux_edge_leases_key', key: { key: 1 }, unique: true },
  { collection: 'edge_leases', name: 'ix_edge_leases_expires', key: { expires_at: 1 } },

  // One registration per identity name: `claim` upserts on this key, which is
  // what moves a recreated test consumer to its new owner instead of
  // recording two.
  {
    collection: 'gateway_identities',
    name: 'ux_gateway_identities_username',
    key: { namespace: 1, ferrum_username: 1 },
    unique: true,
  },
  {
    collection: 'gateway_identities',
    name: 'ix_gateway_identities_user',
    key: { user_id: 1, namespace: 1 },
  },

  // Partial, so documents with an unknown ordinal can coexist
  // — the SQL dialects get that from NULLs being distinct in a unique index.
  // Two *assigned* ordinals can never collide within a consumer and type.
  {
    collection: 'credential_metadata',
    name: 'ux_credentials_ordinal',
    key: { ferrum_consumer_id: 1, credential_type: 1, edge_ordinal: 1 },
    unique: true,
    partialFilterExpression: { edge_ordinal: { $type: 'number' } },
  },

  // Claim order; `ix_email_outbox_due` stays for due-time filtering.
  {
    collection: 'email_outbox',
    name: 'ix_email_outbox_priority',
    key: { status: 1, priority: -1, next_attempt_at: 1, created_at: 1, _id: 1 },
  },

  // The `(api_id, role)` key of the first-class plugin ownership record,
  // which the SQL dialects declare as a primary key.
  {
    collection: 'api_gateway_plugins',
    name: 'ux_api_gateway_plugins_api_role',
    key: { api_id: 1, role: 1 },
    unique: true,
  },

  // One change summary per revision, and an API's summaries in publication
  // order, as the SQL dialects' two unique indexes.
  {
    collection: 'api_spec_changes',
    name: 'ux_api_spec_changes_spec',
    key: { spec_id: 1 },
    unique: true,
  },
  {
    collection: 'api_spec_changes',
    name: 'ux_api_spec_changes_seq',
    key: { api_id: 1, revision_seq: 1 },
    unique: true,
  },

  // The two keys of an identity-provider link. `(provider_id, issuer,
  // subject)` decides whose account a returning sign-in opens; `(user_id,
  // provider_id)` keeps an account to one identity per provider and serves the
  // per-account listing. `user_notification_preferences`,
  // `user_email_proofs` and `user_password_locks` are keyed by `_id` (the
  // account id) and need no index.
  {
    collection: 'user_identities',
    name: 'ux_user_identities_subject',
    key: { provider_id: 1, issuer: 1, subject: 1 },
    unique: true,
  },
  {
    collection: 'user_identities',
    name: 'ux_user_identities_user_provider',
    key: { user_id: 1, provider_id: 1 },
    unique: true,
  },

  // Account-recovery revocations: the SQL table's unique user key and due scan.
  {
    collection: 'account_recovery_jobs',
    name: 'ux_account_recovery_jobs_user',
    key: { user_id: 1 },
    unique: true,
  },
  {
    collection: 'account_recovery_jobs',
    name: 'ix_account_recovery_jobs_due',
    key: { status: 1, next_attempt_at: 1 },
  },

  // Access gateway jobs: the SQL table's unique subject key and due scan.
  {
    collection: 'access_gateway_jobs',
    name: 'ux_access_gateway_jobs_subject',
    key: { subject_id: 1 },
    unique: true,
  },
  {
    collection: 'access_gateway_jobs',
    name: 'ix_access_gateway_jobs_due',
    key: { status: 1, next_attempt_at: 1 },
  },
];
