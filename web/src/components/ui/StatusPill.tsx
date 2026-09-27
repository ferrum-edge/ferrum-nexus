import type { ReactElement } from 'react';
import {
  ROLE_LABELS,
  type AccessRequestStatus,
  type ApiStatus,
  type ApiVisibility,
  type CatalogAccessState,
  type CredentialStatus,
  type EmailOutboxStatus,
  type GrantStatus,
  type HealthStatus,
  type Role,
  type UserStatus,
} from '@ferrum-nexus/shared';
import { Badge, type BadgeTone } from './Badge';

/** Every status union rendered through {@link StatusPill}. */
export type StatusValue =
  | AccessRequestStatus
  | ApiStatus
  | CatalogAccessState
  | CredentialStatus
  | EmailOutboxStatus
  | GrantStatus
  | HealthStatus
  | UserStatus;

interface StatusDescriptor {
  label: string;
  tone: BadgeTone;
}

const STATUSES: Readonly<Record<StatusValue, StatusDescriptor>> = {
  /* Access requests */
  pending: { label: 'Pending', tone: 'warning' },
  approved: { label: 'Approved', tone: 'success' },
  denied: { label: 'Denied', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  /* Grants & credentials */
  active: { label: 'Active', tone: 'success' },
  revoked: { label: 'Revoked', tone: 'danger' },
  retiring: { label: 'Retiring', tone: 'warning' },
  /* APIs */
  published: { label: 'Published', tone: 'success' },
  retired: { label: 'Retired', tone: 'neutral' },
  /* Users */
  disabled: { label: 'Disabled', tone: 'danger' },
  /* Email outbox */
  sending: { label: 'Sending', tone: 'info' },
  sent: { label: 'Sent', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  /* Health */
  ok: { label: 'OK', tone: 'success' },
  degraded: { label: 'Degraded', tone: 'warning' },
  down: { label: 'Down', tone: 'danger' },
  /* Catalog access state */
  none: { label: 'No access', tone: 'neutral' },
  open: { label: 'Open access', tone: 'success' },
  granted: { label: 'Granted', tone: 'success' },
  owner: { label: 'You own this', tone: 'accent' },
};

export interface StatusPillProps {
  status: StatusValue;
  className?: string;
}

/** Consistent colour/label mapping for every status union in the API. */
export function StatusPill({ status, className }: StatusPillProps): ReactElement {
  const descriptor = STATUSES[status];
  return (
    <Badge tone={descriptor.tone} className={className}>
      {descriptor.label}
    </Badge>
  );
}

/** Human label for a status value, for use outside a badge. */
export function statusLabel(status: StatusValue): string {
  return STATUSES[status].label;
}

const ROLE_TONES: Readonly<Record<Role, BadgeTone>> = {
  client: 'neutral',
  provider: 'info',
  admin: 'accent',
  super_admin: 'danger',
};

/** Role badge using the shared `ROLE_LABELS` copy. */
export function RoleBadge({ role, className }: { role: Role; className?: string }): ReactElement {
  return (
    <Badge tone={ROLE_TONES[role]} className={className}>
      {ROLE_LABELS[role]}
    </Badge>
  );
}

const VISIBILITIES: Readonly<Record<ApiVisibility, StatusDescriptor>> = {
  public: { label: 'Public', tone: 'neutral' },
  // `internal` is unlisted, not secret; calling it "Internal" is what made
  // providers pick it for a confidential API (issue #288).
  internal: { label: 'Unlisted', tone: 'warning' },
  private: { label: 'Private', tone: 'danger' },
};

/** Human label for an API's visibility, for use outside a badge. */
export function visibilityLabel(visibility: ApiVisibility): string {
  return VISIBILITIES[visibility].label;
}

/** An API's catalog visibility, labelled and coloured the same everywhere. */
export function VisibilityBadge({
  visibility,
  className,
}: {
  visibility: ApiVisibility;
  className?: string;
}): ReactElement {
  const descriptor = VISIBILITIES[visibility];
  return (
    <Badge tone={descriptor.tone} className={className}>
      {descriptor.label}
    </Badge>
  );
}

/**
 * Whether callers need an approved access request: "Requestable", or "Open"
 * in the neutral tone, so an access column reads as one set of badges.
 */
export function AccessModeBadge({
  requestable,
  className,
}: {
  requestable: boolean;
  className?: string;
}): ReactElement {
  return requestable ? (
    <Badge tone="accent" className={className}>
      Requestable
    </Badge>
  ) : (
    <Badge className={className}>Open</Badge>
  );
}
