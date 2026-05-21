import type {
  AccessRequestStatus,
  ApiLifecycleStatus,
  ApiVisibility,
  ConversationType,
  CredentialType,
  GrantStatus,
  NotificationType,
  UserRole,
  UserStatus,
} from './constants.js';

export interface PortalUser {
  id: string;
  email: string;
  name: string | null;
  phone: string | null;
  status: UserStatus;
  emailVerifiedAt: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  roles: UserRole[];
  organizationId: string | null;
}

export interface Organization {
  id: string;
  name: string;
  domain: string | null;
  status: UserStatus;
  createdAt: string;
}

export interface FerrumConsumer {
  id: string;
  userId: string | null;
  organizationId: string | null;
  namespace: string;
  ferrumConsumerId: string;
  username: string;
  status: 'active' | 'denied' | 'archived';
  aclGroups: string[];
  createdAt: string;
}

export interface CredentialMetadata {
  id: string;
  consumerId: string;
  type: CredentialType;
  label: string;
  fingerprint: string;
  last4: string | null;
  ferrumCredentialIndex: number;
  status: 'active' | 'pending_removal' | 'expired';
  createdAt: string;
  rotatedAt: string | null;
  expiresAt: string | null;
}

export interface ApiAsset {
  id: string;
  apiSpecId: string;
  proxyId: string;
  namespace: string;
  providerId: string;
  title: string;
  description: string | null;
  slug: string;
  version: string;
  visibility: ApiVisibility;
  requestable: boolean;
  lifecycle: ApiLifecycleStatus;
  tags: string[];
  contactEmail: string | null;
  supportNotes: string | null;
  operationCount: number;
  contentHash: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApiAssetWithProvider extends ApiAsset {
  providerName: string;
  providerEmail: string;
}

export interface AccessRequest {
  id: string;
  apiAssetId: string;
  clientUserId: string;
  clientConsumerId: string | null;
  justification: string;
  status: AccessRequestStatus;
  providerReason: string | null;
  reviewedBy: string | null;
  createdAt: string;
  reviewedAt: string | null;
}

export interface AccessGrant {
  id: string;
  apiAssetId: string;
  clientConsumerId: string;
  clientUserId: string;
  aclGroup: string;
  status: GrantStatus;
  approvedAt: string;
  revokedAt: string | null;
  revokedReason: string | null;
}

export interface Conversation {
  id: string;
  apiAssetId: string | null;
  requestId: string | null;
  grantId: string | null;
  type: ConversationType;
  subject: string;
  createdAt: string;
  participantIds: string[];
}

export interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  body: string;
  createdAt: string;
  readBy: string[];
}

export interface NotificationItem {
  id: string;
  recipientId: string;
  type: NotificationType;
  payload: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

export interface BrandingSettings {
  productName: string;
  logoUrl: string | null;
  primaryColor: string;
  defaultTheme: 'system' | 'light' | 'dark';
  supportEmail: string | null;
  footerNotice: string | null;
}

export interface CaptchaSettings {
  enabled: boolean;
  provider: 'turnstile' | 'recaptcha' | 'hcaptcha' | null;
  siteKey: string | null;
}

export interface AppPublicSettings {
  branding: BrandingSettings;
  captcha: CaptchaSettings;
  registrationEnabled: boolean;
  emailVerificationRequired: boolean;
}

export interface AuditLogEntry {
  id: string;
  actorId: string | null;
  actorEmail: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  reason: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}
