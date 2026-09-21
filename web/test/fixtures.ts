import type {
  AccessRequest,
  Api,
  ApiSpecSummary,
  CatalogApi,
  CreateThreadResponse,
  CredentialMetadata,
  Grant,
  MessageThread,
} from '@ferrum-nexus/shared';

export const CREATED_AT = '2026-01-01T00:00:00.000Z';

export const API: Api = {
  id: 'api-1',
  name: 'Billing API',
  slug: 'billing',
  description: 'Invoices for your account',
  owner_user_id: 'provider-1',
  ferrum_proxy_id: 'proxy-1',
  upstream_url: 'https://billing.example.test',
  namespace: 'nexus',
  version: '1.0.0',
  spec_format: 'openapi',
  requestable: true,
  auth_plugin: 'key_auth',
  rate_limit: null,
  cors: null,
  allowed_methods: null,
  timeouts: null,
  circuit_breaker: false,
  spec_enforcement: 'docs_only',
  status: 'published',
  visibility: 'public',
  gateway_state: 'deployed',
  listen_path: '/nexus/billing',
  invoke_url: 'https://gateway.example.test/nexus/billing',
  created_at: CREATED_AT,
  updated_at: CREATED_AT,
};

export const SPEC: ApiSpecSummary = {
  id: 'spec-1',
  api_id: API.id,
  version: '1.0.0',
  parsed_title: 'Billing specification',
  parsed_version: '1.0.0',
  is_current: true,
  created_by: API.owner_user_id,
  rolled_back_from_id: null,
  created_at: CREATED_AT,
  updated_at: CREATED_AT,
};

export const RAW_SPEC = JSON.stringify({
  openapi: '3.0.3',
  info: { title: 'Billing specification', version: '1.0.0' },
  paths: {
    '/invoices': {
      get: { summary: 'List invoices', responses: { '200': { description: 'OK' } } },
      post: { summary: 'Create invoice', responses: { '201': { description: 'Created' } } },
    },
  },
});

export function catalogEntry(overrides: Partial<CatalogApi> = {}): CatalogApi {
  const { upstream_url: _upstream, ...api } = API;
  return {
    ...api,
    owner: {
      id: 'provider-1',
      display_name: 'Billing team',
      email: 'billing@example.test',
      role: 'provider',
    },
    access_state: 'none',
    ...overrides,
  };
}

export const REQUEST: AccessRequest = {
  id: 'request-1',
  api_id: API.id,
  user_id: 'user-1',
  application_id: null,
  justification: 'Reconcile invoices',
  status: 'pending',
  decided_by: null,
  decided_at: null,
  decision_note: null,
  created_at: CREATED_AT,
  updated_at: CREATED_AT,
};

export const GRANT: Grant = {
  id: 'grant-1',
  api_id: API.id,
  user_id: 'user-1',
  application_id: null,
  access_request_id: REQUEST.id,
  acl_group: 'nexus:api:api-1:approved',
  status: 'active',
  granted_by: 'provider-1',
  revoked_by: null,
  revoked_at: null,
  created_at: CREATED_AT,
  updated_at: CREATED_AT,
  api: API,
};

export const CREDENTIAL: CredentialMetadata = {
  id: 'credential-1',
  user_id: 'user-1',
  application_id: null,
  ferrum_consumer_id: 'consumer-1',
  credential_type: 'keyauth',
  ferrum_credential_id: '0',
  fingerprint: '0'.repeat(64),
  last4: '0001',
  label: 'Production worker',
  status: 'active',
  rotated_from_id: null,
  edge_ordinal: 0,
  created_at: CREATED_AT,
  updated_at: CREATED_AT,
};

export const THREAD: MessageThread = {
  id: 'thread-1',
  subject: 'Invoice question',
  api_id: API.id,
  created_by: 'user-1',
  participant_a: 'user-1',
  participant_b: 'provider-1',
  last_message_at: CREATED_AT,
  created_at: CREATED_AT,
  updated_at: CREATED_AT,
  api: API,
  participants: [
    { id: 'user-1', display_name: 'You', email: 'you@example.test', role: 'client' },
    {
      id: 'provider-1',
      display_name: 'Billing team',
      email: 'billing@example.test',
      role: 'provider',
    },
  ],
  last_message_preview: 'Can I export invoices?',
};

export const THREAD_RESPONSE: CreateThreadResponse = {
  thread: THREAD,
  message: {
    id: 'message-1',
    thread_id: THREAD.id,
    sender_user_id: 'user-1',
    body: 'Can I export invoices?',
    broadcast: false,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
  },
};
