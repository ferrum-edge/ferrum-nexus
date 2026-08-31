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
import { Card, CardBody, CardHeader, PageHeader } from '../components/ui/Card';
import { Icon, type IconName } from '../components/ui/Icon';
import { StatusPill } from '../components/ui/StatusPill';
import { EmptyState } from '../components/ui/EmptyState';

function StatCard({
  icon,
  label,
  value,
  to,
}: {
  icon: IconName;
  label: string;
  value: number | string;
  to: '/catalog' | '/credentials' | '/apis' | '/admin/users' | '/admin/apis' | '/admin/audit';
}): ReactElement {
  return (
    <Link to={to} className="fx-card flex items-center gap-4 p-4 transition-colors hover:bg-inset">
      <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent-soft text-accent">
        <Icon name={icon} className="h-5 w-5" />
      </span>
      <span className="min-w-0">
        <span className="block text-2xl font-semibold text-fg">{value}</span>
        <span className="block truncate text-sm text-fg-muted">{label}</span>
      </span>
    </Link>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }): ReactElement {
  return (
    <Card>
      <CardHeader title={title} />
      {children}
    </Card>
  );
}

/** Role-aware landing page assembled from the existing list endpoints. */
export function DashboardPage(): ReactElement {
  const { user, canProvider, canAdmin } = useAuth();

  const myRequests = useAccessRequests({ mine: true, limit: 5 });
  const myGrants = useGrants({ mine: true, status: 'active', limit: 5 });
  const myCredentials = useCredentials({ status: 'active', limit: 5 });

  const providerRequests = useAccessRequests({ status: 'pending', limit: 5 }, canProvider);
  const providerApis = useMyApis({ limit: 5 });

  const allUsers = useUsers({ limit: 1 }, canAdmin);
  const allApis = useApis({ mine: false, limit: 1 });
  const recentAudit = useAuditLogs({ limit: 6 }, canAdmin);

  return (
    <>
      <PageHeader
        title={`Welcome back, ${user?.display_name ?? ''}`}
        description="Everything you have access to on this portal, at a glance."
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          icon="grant"
          label="Active grants"
          value={myGrants.data?.total ?? 0}
          to="/catalog"
        />
        <StatCard
          icon="key"
          label="Active credentials"
          value={myCredentials.data?.total ?? 0}
          to="/credentials"
        />
        {canProvider ? (
          <StatCard
            icon="stack"
            label="APIs you publish"
            value={providerApis.data?.total ?? 0}
            to="/apis"
          />
        ) : null}
        {canAdmin ? (
          <StatCard
            icon="users"
            label="Portal accounts"
            value={allUsers.data?.total ?? 0}
            to="/admin/users"
          />
        ) : null}
        {canAdmin ? (
          <StatCard
            icon="spec"
            label="Published APIs"
            value={allApis.data?.total ?? 0}
            to="/admin/apis"
          />
        ) : null}
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Section title="My access requests">
          {myRequests.data && myRequests.data.items.length > 0 ? (
            <ul>
              {myRequests.data.items.map((request) => (
                <li
                  key={request.id}
                  className="flex items-center justify-between gap-3 border-b border-border px-5 py-3 last:border-b-0"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-fg">
                      {request.api?.name ?? request.api_id}
                    </span>
                    <span className="block text-xs text-fg-subtle">
                      {formatRelative(request.created_at)}
                    </span>
                  </span>
                  <StatusPill status={request.status} />
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              icon="catalog"
              title="No access requests yet"
              description="Browse the catalog and request access to an API to get started."
            />
          )}
        </Section>

        {canProvider ? (
          <Section title="Pending requests for your APIs">
            {providerRequests.data && providerRequests.data.items.length > 0 ? (
              <ul>
                {providerRequests.data.items.map((request) => (
                  <li
                    key={request.id}
                    className="flex items-center justify-between gap-3 border-b border-border px-5 py-3 last:border-b-0"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm text-fg">
                        {request.requester?.display_name ?? request.user_id}
                      </span>
                      <span className="block truncate text-xs text-fg-subtle">
                        {request.api?.name ?? request.api_id}
                      </span>
                    </span>
                    {request.api ? (
                      <Link
                        to="/apis/$apiId"
                        params={{ apiId: request.api.id }}
                        className="text-sm text-accent hover:underline"
                      >
                        Review
                      </Link>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState
                icon="grant"
                title="Nothing waiting on you"
                description="Access requests for the APIs you publish will show up here."
              />
            )}
          </Section>
        ) : (
          <Section title="Your credentials">
            {myCredentials.data && myCredentials.data.items.length > 0 ? (
              <ul>
                {myCredentials.data.items.map((credential) => (
                  <li
                    key={credential.id}
                    className="flex items-center justify-between gap-3 border-b border-border px-5 py-3 last:border-b-0"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm text-fg">
                        {credential.label ?? credential.credential_type}
                      </span>
                      <span className="block font-mono text-xs text-fg-subtle">
                        ••••{credential.last4}
                      </span>
                    </span>
                    <StatusPill status={credential.status} />
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState
                icon="key"
                title="No gateway credentials"
                description="Issue a credential to start calling the APIs you have access to."
              />
            )}
          </Section>
        )}
      </div>

      {canAdmin ? (
        <div className="mt-6">
          <Section title="Recent audit activity">
            {recentAudit.data && recentAudit.data.items.length > 0 ? (
              <CardBody className="px-0 py-0">
                <ul>
                  {recentAudit.data.items.map((entry) => (
                    <li
                      key={entry.id}
                      className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-3 last:border-b-0"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm text-fg">
                          {humanize(entry.action)}
                        </span>
                        <span className="block truncate text-xs text-fg-subtle">
                          {entry.actor?.display_name ?? 'system'} · {entry.target_type}
                        </span>
                      </span>
                      <span className="text-xs text-fg-subtle">
                        {formatRelative(entry.created_at)}
                      </span>
                    </li>
                  ))}
                </ul>
              </CardBody>
            ) : (
              <EmptyState icon="audit" title="No audit entries yet" />
            )}
          </Section>
        </div>
      ) : null}
    </>
  );
}
