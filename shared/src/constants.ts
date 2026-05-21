export const SESSION_COOKIE_NAME = 'nexus_sid';
export const CSRF_HEADER = 'x-nexus-csrf';
export const CSRF_COOKIE = 'nexus_csrf';
export const FERRUM_NAMESPACE_HEADER = 'X-Ferrum-Namespace';

export const USER_ROLES = ['client', 'provider', 'admin', 'super_admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_STATUSES = ['pending', 'active', 'disabled'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const API_LIFECYCLE_STATUSES = ['draft', 'published', 'deprecated', 'retired'] as const;
export type ApiLifecycleStatus = (typeof API_LIFECYCLE_STATUSES)[number];

export const API_VISIBILITIES = ['private', 'internal', 'public'] as const;
export type ApiVisibility = (typeof API_VISIBILITIES)[number];

export const ACCESS_REQUEST_STATUSES = ['pending', 'approved', 'denied', 'cancelled'] as const;
export type AccessRequestStatus = (typeof ACCESS_REQUEST_STATUSES)[number];

export const GRANT_STATUSES = ['active', 'revoked'] as const;
export type GrantStatus = (typeof GRANT_STATUSES)[number];

export const CREDENTIAL_TYPES = ['keyauth', 'basicauth', 'jwt', 'hmac_auth', 'mtls_auth'] as const;
export type CredentialType = (typeof CREDENTIAL_TYPES)[number];

export const CONVERSATION_TYPES = [
  'access_request',
  'api_support',
  'admin_direct',
  'announcement',
] as const;
export type ConversationType = (typeof CONVERSATION_TYPES)[number];

export const NOTIFICATION_TYPES = [
  'registration_confirmed',
  'access_request_created',
  'access_request_approved',
  'access_request_denied',
  'access_revoked',
  'message_received',
  'credential_created',
  'credential_rotation_due',
  'credential_rotation_completed',
  'api_spec_updated',
  'api_lifecycle_changed',
  'admin_broadcast',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** Construct the ACL group name used for a Nexus API on Ferrum Edge. */
export function aclGroupForApi(apiAssetId: string): string {
  return `nexus:api:${apiAssetId}:approved`;
}
