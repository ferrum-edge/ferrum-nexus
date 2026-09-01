import { Link } from '@tanstack/react-router';
import type { ReactElement, ReactNode } from 'react';
import { ROLE_LABELS, type Role } from '@ferrum-nexus/shared';
import { useAuth } from '../../stores/auth';
import { EmptyState } from '../ui/EmptyState';
import { Card } from '../ui/Card';

export interface RoleGuardProps {
  /** Minimum role required to render `children`. */
  minRole: Role;
  children: ReactNode;
}

/**
 * Route-level role gate. The sidebar already hides these destinations, so this
 * only ever fires on a typed URL or a stale link — it renders an explanation
 * rather than redirecting, to avoid a bounce loop.
 */
export function RoleGuard({ minRole, children }: RoleGuardProps): ReactElement {
  const { hasRole } = useAuth();
  if (hasRole(minRole)) return <>{children}</>;
  return (
    <Card>
      <EmptyState
        icon="shield"
        title="You do not have access to this area"
        description={`This section requires the ${ROLE_LABELS[minRole]} role or higher. If you believe this is a mistake, contact a portal administrator.`}
        action={
          <Link
            to="/"
            className="inline-flex h-9 items-center rounded-md border border-border bg-elevated px-3.5 text-sm font-medium text-fg hover:border-border-strong"
          >
            Back to dashboard
          </Link>
        }
      />
    </Card>
  );
}
