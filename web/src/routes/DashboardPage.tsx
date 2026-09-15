import { auditActorLabel } from '../lib/audit';
import { Link } from '@tanstack/react-router';
import type { ReactElement, ReactNode } from 'react';
import { formatRelative, humanize } from '../lib/format';
import { useAccessRequests } from '../hooks/useAccessRequests';
import { useAuditLogs } from '../hooks/useAuditLogs';
import { useApis, useMyApis } from '../hooks/useApis';
import { useCredentials } from '../hooks/useCredentials';
import { useGrants } from '../hooks/useGrants';
import { useUsers } from '../hooks/useUsers';
import { useAuth } from '../stores/auth';
import { buttonClassName } from '../components/ui/Button';
import { Card, CardHeader, PageHeader, StatCard } from '../components/ui/Card';
import { Icon, type IconName } from '../components/ui/Icon';
import { StatusPill } from '../components/ui/StatusPill';
import { EmptyState } from '../components/ui/EmptyState';

/** Destinations reachable from a dashboard panel header. */
type PanelLink = '/catalog' | '/credentials' | '/apis' | '/admin/audit';

/**
 * Initials for an avatar tile: first letters of up to two words.
 *
 * Kept local rather than imported from the navigation rail so this page owns
 * its own presentation helpers.
 */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] ?? ''}${parts[parts.length - 1]![0] ?? ''}`.toUpperCase();
}

/** Monogram tile standing in for a person's picture in a list row. */
function Avatar({ name }: { name: string }): ReactElement {
  return (
    <span
      aria-hidden="true"
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neutral-soft text-[0.7rem] font-semibold text-fg-muted ring-1 ring-border ring-inset"
    >
      {initials(name)}
    </span>
  );
}

/** Panel card with an icon, a title and a link to the full list. */
function Section({
  title,
  icon,
  to,
  children,
}: {
  title: string;
  icon: IconName;
  to: PanelLink;
  children: ReactNode;
}): ReactElement {
  return (
    <Card>
      <CardHeader
        title={title}
        icon={icon}
        actions={
          <Link to={to} className={buttonClassName({ variant: 'ghost', size: 'sm' })}>
            View all
            <Icon name="arrow-right" className="h-3.5 w-3.5" />
          </Link>
        }
      />
      {children}
    </Card>
  );
}

/** One row of a dashboard list. */
function Row({ children }: { children: ReactNode }): ReactElement {
  return (
    <li className="flex items-center justify-between gap-3 border-b border-border px-5 py-3 last:border-b-0">
      {children}
    </li>
  );
}

type AuditTone = 'danger' | 'success' | 'neutral';

const AUDIT_DOTS: Readonly<Record<AuditTone, string>> = {
  danger: 'bg-danger',
  success: 'bg-success',
  neutral: 'bg-fg-subtle',
};

/**
 * Colour an audit row by what the action did.
 *
 * Derived from the action string on purpose: the catalog lives on the server
 * and grows, so matching verbs keeps new actions coloured sensibly instead of
 * falling off a hard-coded list.
 */
function auditTone(action: string): AuditTone {
  if (/(delete|revoke|deny|disable|remove|teardown|purge|reject|fail)/.test(action))
    return 'danger';
  if (/(approve|create|grant|publish|issue|register|enable|add)/.test(action)) return 'success';
  return 'neutral';
}

/** Role-aware landing page assembled from the existing list endpoints. */
export function DashboardPage(): ReactElement {
  const { user, canProvider, canAdmin } = useAuth();

  const myRequests = useAccessRequests({ mine: true, limit: 5 });
  const myGrants = useGrants({ mine: true, status: 'active', limit: 5 });
  const myCredentials = useCredentials({ status: 'active', limit: 5 });

  const providerRequests = useAccessRequests({ status: 'pending', limit: 5 }, canProvider);
  const providerApis = useMyApis({ limit: 5 }, canProvider);

  const allUsers = useUsers({ limit: 1 }, canAdmin);
  const allApis = useApis({ mine: false, limit: 1 }, canAdmin);
  const recentAudit = useAuditLogs({ limit: 6 }, canAdmin);

  return (
    <>
      <PageHeader
        title={user?.display_name ? `Welcome back, ${user.display_name}` : 'Welcome back'}
        description="Everything you have access to on this portal, at a glance."
        actions={
          <>
            <Link to="/catalog" className={buttonClassName({ variant: 'primary' })}>
              <Icon name="catalog" />
              Browse catalog
            </Link>
            <Link to="/credentials" className={buttonClassName({ variant: 'secondary' })}>
              <Icon name="key" />
              Issue credential
            </Link>
            {canProvider ? (
              <Link to="/apis/new" className={buttonClassName({ variant: 'secondary' })}>
                <Icon name="plus" />
                Publish API
              </Link>
            ) : null}
            {canAdmin ? (
              <Link to="/admin/users" className={buttonClassName({ variant: 'secondary' })}>
                <Icon name="users" />
                Review users
              </Link>
            ) : null}
          </>
        }
      />

      {/* Three across keeps every label readable and never strands a fifth
          tile alone on a row: five cards wrap as three plus two. */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          icon="grant"
          tone="success"
          label="Active grants"
          hint="Approved access to APIs"
          value={myGrants.data?.total ?? 0}
          loading={myGrants.isLoading}
          to="/catalog"
        />
        <StatCard
          icon="key"
          label="Active credentials"
          hint="Keys you can rotate or revoke"
          value={myCredentials.data?.total ?? 0}
          loading={myCredentials.isLoading}
          to="/credentials"
        />
        {canProvider ? null : (
          <StatCard
            icon="inbox"
            tone="info"
            label="Access requests"
            hint="Submitted from your account"
            value={myRequests.data?.total ?? 0}
            loading={myRequests.isLoading}
            to="/catalog"
          />
        )}
        {canProvider ? (
          <StatCard
            icon="stack"
            label="APIs you publish"
            hint="Live in the catalog"
            value={providerApis.data?.total ?? 0}
            loading={providerApis.isLoading}
            to="/apis"
          />
        ) : null}
        {canAdmin ? (
          <StatCard
            icon="users"
            tone="info"
            label="Portal accounts"
            hint="Clients, providers and admins"
            value={allUsers.data?.total ?? 0}
            loading={allUsers.isLoading}
            to="/admin/users"
          />
        ) : null}
        {canAdmin ? (
          <StatCard
            icon="spec"
            tone="success"
            label="Published APIs"
            hint="Across the whole portal"
            value={allApis.data?.total ?? 0}
            loading={allApis.isLoading}
            to="/admin/apis"
          />
        ) : null}
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Section title="My access requests" icon="inbox" to="/catalog">
          {myRequests.data && myRequests.data.items.length > 0 ? (
            <ul>
              {myRequests.data.items.map((request) => (
                <Row key={request.id}>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-fg">
                      {request.api?.name ?? request.api_id}
                    </span>
                    <span className="block truncate font-mono text-xs text-fg-subtle">
                      /{request.api?.slug ?? request.api_id}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-3">
                    <StatusPill status={request.status} />
                    <span className="hidden text-xs text-fg-subtle tabular-nums sm:inline">
                      {formatRelative(request.created_at)}
                    </span>
                  </span>
                </Row>
              ))}
            </ul>
          ) : (
            <EmptyState
              icon="catalog"
              title="No access requests yet"
              description="Browse the catalog and request access to an API to get started."
              action={
                <Link to="/catalog" className={buttonClassName({ variant: 'primary', size: 'sm' })}>
                  Browse the catalog
                </Link>
              }
            />
          )}
        </Section>

        {canProvider ? (
          <Section title="Pending requests for your APIs" icon="grant" to="/apis">
            {providerRequests.data && providerRequests.data.items.length > 0 ? (
              <ul>
                {providerRequests.data.items.map((request) => (
                  <Row key={request.id}>
                    <span className="flex min-w-0 items-center gap-3">
                      <Avatar name={request.requester?.display_name ?? '?'} />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-fg">
                          {request.requester?.display_name ?? request.user_id}
                        </span>
                        <span className="block truncate text-xs text-fg-subtle">
                          {request.api?.name ?? request.api_id}
                        </span>
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-3">
                      <span className="hidden text-xs text-fg-subtle tabular-nums sm:inline">
                        {formatRelative(request.created_at)}
                      </span>
                      {request.api ? (
                        <Link
                          to="/apis/$apiId"
                          params={{ apiId: request.api.id }}
                          className={buttonClassName({ variant: 'secondary', size: 'sm' })}
                        >
                          Review
                        </Link>
                      ) : null}
                    </span>
                  </Row>
                ))}
              </ul>
            ) : (
              <EmptyState
                icon="grant"
                title="Nothing waiting on you"
                description="Access requests for the APIs you publish will show up here."
                action={
                  <Link
                    to="/apis"
                    className={buttonClassName({ variant: 'secondary', size: 'sm' })}
                  >
                    Manage your APIs
                  </Link>
                }
              />
            )}
          </Section>
        ) : (
          <Section title="Your credentials" icon="key" to="/credentials">
            {myCredentials.data && myCredentials.data.items.length > 0 ? (
              <ul>
                {myCredentials.data.items.map((credential) => (
                  <Row key={credential.id}>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-fg">
                        {credential.label ?? credential.credential_type}
                      </span>
                      <span className="block font-mono text-xs text-fg-subtle">
                        ••••{credential.last4}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-3">
                      <StatusPill status={credential.status} />
                      <span className="hidden text-xs text-fg-subtle tabular-nums sm:inline">
                        {formatRelative(credential.created_at)}
                      </span>
                    </span>
                  </Row>
                ))}
              </ul>
            ) : (
              <EmptyState
                icon="key"
                title="No gateway credentials"
                description="Issue a credential to start calling the APIs you have access to."
                action={
                  <Link
                    to="/credentials"
                    className={buttonClassName({ variant: 'primary', size: 'sm' })}
                  >
                    Issue a credential
                  </Link>
                }
              />
            )}
          </Section>
        )}
      </div>

      {canAdmin ? (
        <div className="mt-6">
          <Section title="Recent audit activity" icon="audit" to="/admin/audit">
            {recentAudit.data && recentAudit.data.items.length > 0 ? (
              <ul>
                {recentAudit.data.items.map((entry) => (
                  <Row key={entry.id}>
                    <span className="flex min-w-0 items-center gap-3">
                      <span
                        aria-hidden="true"
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${AUDIT_DOTS[auditTone(entry.action)]}`}
                      />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-fg">
                          {humanize(entry.action)}
                        </span>
                        <span className="block truncate text-xs text-fg-subtle">
                          {auditActorLabel(entry)} · {entry.target_type}
                        </span>
                      </span>
                    </span>
                    <span className="shrink-0 text-xs text-fg-subtle tabular-nums">
                      {formatRelative(entry.created_at)}
                    </span>
                  </Row>
                ))}
              </ul>
            ) : (
              <EmptyState icon="audit" title="No audit entries yet" compact />
            )}
          </Section>
        </div>
      ) : null}
    </>
  );
}
