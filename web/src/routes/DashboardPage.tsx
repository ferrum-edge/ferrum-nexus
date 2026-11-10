import { auditActorLabel, auditTone, type AuditTone } from '../lib/audit';
import { Link } from '@tanstack/react-router';
import type { ReactElement, ReactNode } from 'react';
import { CREDENTIAL_TYPE_LABELS } from '../lib/credential-labels';
import { formatRelative, humanize } from '../lib/format';
import { queryLoadState } from '../lib/query-state';
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
import { QueryErrorState } from '../components/ui/QueryErrorState';

const WHITESPACE = /\s+/;

/** Destinations reachable from a dashboard panel header. */
type PanelLink = '/catalog' | '/credentials' | '/apis' | '/admin/audit';

/**
 * Initials for an avatar tile: first letters of up to two words.
 *
 * Kept local rather than imported from the navigation rail so this page owns
 * its own presentation helpers.
 */
function initials(name: string): string {
  const parts = name.trim().split(WHITESPACE).filter(Boolean);
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
  title: ReactNode;
  icon: IconName;
  to: PanelLink;
  children: ReactNode;
}): ReactElement {
  return (
    // `min-w-0`: a grid item is otherwise as wide as its unbroken title, and
    // the truncating header would push the page sideways on a phone.
    <Card className="min-w-0">
      <CardHeader
        title={title}
        icon={icon}
        inlineActions
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

/** The fields of a list query a dashboard panel reads. */
interface PanelQuery<T> {
  data: { items: T[] } | undefined;
  isLoading: boolean;
  isError: boolean;
  isFetching: boolean;
  refetch: () => unknown;
}

/**
 * A panel's body: placeholder rows while the first fetch runs, an error with a
 * retry when it failed, the empty state only when the list really is empty,
 * and the rows otherwise. Without the first two, a provider whose request list
 * failed to load was told "Nothing waiting on you".
 */
function PanelBody<T>({
  query,
  empty,
  children,
}: {
  query: PanelQuery<T>;
  empty: ReactNode;
  children: (items: T[]) => ReactNode;
}): ReactElement {
  const load = queryLoadState(query);
  if (load.kind === 'loading') {
    return (
      <ul aria-busy="true" aria-label="Loading">
        {[0, 1, 2].map((index) => (
          <Row key={index}>
            <span className="fx-skeleton block h-4 w-2/5" />
            <span className="fx-skeleton block h-4 w-16" />
          </Row>
        ))}
      </ul>
    );
  }
  if (load.kind === 'failed') {
    return <QueryErrorState compact onRetry={() => query.refetch()} retrying={query.isFetching} />;
  }
  return <>{load.data.items.length > 0 ? children(load.data.items) : empty}</>;
}

/**
 * A stat card's number: the total once loaded, and a dash when the query
 * failed, so a failed count does not read as zero.
 */
function statValue(query: { data: { total: number } | undefined }): number | string {
  return query.data?.total ?? '—';
}

const AUDIT_DOTS: Readonly<Record<AuditTone, string>> = {
  warning: 'bg-warning',
  danger: 'bg-danger',
  success: 'bg-success',
  neutral: 'bg-fg-subtle',
};

/** Role-aware landing page assembled from the existing list endpoints. */
export function DashboardPage(): ReactElement {
  const { user, canProvider, canAdmin } = useAuth();

  const myRequests = useAccessRequests({ mine: true, limit: 5 });
  const myGrants = useGrants({ mine: true, status: 'active', limit: 5 });
  const myCredentials = useCredentials({ status: 'active', limit: 5 });

  const providerRequests = useAccessRequests({ status: 'pending', limit: 5 }, canProvider);
  // Retired APIs are out of the catalog, so the "live" counts leave them out.
  const providerApis = useMyApis({ status: 'published', limit: 5 }, canProvider);

  const allUsers = useUsers({ limit: 1 }, canAdmin);
  const allApis = useApis({ mine: false, status: 'published', limit: 1 }, canAdmin);
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

      {/* Two rows by scope: the caller's own three stats, then — for an
          administrator — the portal's two, which span wider rather than
          leaving a sixth slot empty. On a phone the cards pair up two to a
          row in their compact form, and the third personal stat takes the
          whole row instead of stranding a half-width orphan. */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-6">
        <StatCard
          className="xl:col-span-2"
          icon="grant"
          tone="success"
          label="Active grants"
          hint="Approved access to APIs"
          value={statValue(myGrants)}
          loading={myGrants.isLoading}
          to="/catalog"
        />
        <StatCard
          className="xl:col-span-2"
          icon="key"
          label="Active credentials"
          hint="Keys you can rotate or revoke"
          value={statValue(myCredentials)}
          loading={myCredentials.isLoading}
          to="/credentials"
        />
        {canProvider ? (
          <StatCard
            className="col-span-2"
            icon="stack"
            label="APIs you publish"
            hint="Live in the catalog"
            value={statValue(providerApis)}
            loading={providerApis.isLoading}
            to="/apis"
          />
        ) : (
          <StatCard
            className="col-span-2"
            icon="inbox"
            tone="info"
            label="Access requests"
            hint="Submitted from your account"
            value={statValue(myRequests)}
            loading={myRequests.isLoading}
            to="/catalog"
          />
        )}
        {canAdmin ? (
          <>
            <StatCard
              className="xl:col-span-3"
              icon="users"
              tone="info"
              label="Portal accounts"
              hint="Clients, providers and admins"
              value={statValue(allUsers)}
              loading={allUsers.isLoading}
              to="/admin/users"
            />
            <StatCard
              className="xl:col-span-3"
              icon="spec"
              tone="success"
              label="Published APIs"
              hint="Across the whole portal"
              value={statValue(allApis)}
              loading={allApis.isLoading}
              to="/admin/apis"
            />
          </>
        ) : null}
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Section title="My access requests" icon="inbox" to="/catalog">
          <PanelBody
            query={myRequests}
            empty={
              <EmptyState
                icon="catalog"
                title="No access requests yet"
                description="Browse the catalog and request access to an API to get started."
                action={
                  <Link
                    to="/catalog"
                    className={buttonClassName({ variant: 'primary', size: 'sm' })}
                  >
                    Browse the catalog
                  </Link>
                }
              />
            }
          >
            {(items) => (
              <ul>
                {items.map((request) => (
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
            )}
          </PanelBody>
        </Section>

        {canProvider ? (
          <Section
            // A phone has room for "Pending requests" beside "View all"; the
            // rest stays readable to assistive technology.
            title={
              <>
                Pending requests<span className="max-sm:sr-only"> for your APIs</span>
              </>
            }
            icon="grant"
            to="/apis"
          >
            <PanelBody
              query={providerRequests}
              empty={
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
              }
            >
              {(items) => (
                <ul>
                  {items.map((request) => (
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
              )}
            </PanelBody>
          </Section>
        ) : (
          <Section title="Your credentials" icon="key" to="/credentials">
            <PanelBody
              query={myCredentials}
              empty={
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
              }
            >
              {(items) => (
                <ul>
                  {items.map((credential) => (
                    <Row key={credential.id}>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-fg">
                          {credential.label ?? CREDENTIAL_TYPE_LABELS[credential.credential_type]}
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
              )}
            </PanelBody>
          </Section>
        )}
      </div>

      {canAdmin ? (
        <div className="mt-6">
          <Section title="Recent audit activity" icon="audit" to="/admin/audit">
            <PanelBody
              query={recentAudit}
              empty={<EmptyState icon="audit" title="No audit entries yet" compact />}
            >
              {(items) => (
                <ul>
                  {items.map((entry) => (
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
                            {auditActorLabel(entry)} · {humanize(entry.target_type)}
                          </span>
                        </span>
                      </span>
                      <span className="shrink-0 text-xs text-fg-subtle tabular-nums">
                        {formatRelative(entry.created_at)}
                      </span>
                    </Row>
                  ))}
                </ul>
              )}
            </PanelBody>
          </Section>
        </div>
      ) : null}
    </>
  );
}
