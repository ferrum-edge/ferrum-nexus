import { Link, useParams } from '@tanstack/react-router';
import { useState, type ReactElement, type ReactNode } from 'react';
import {
  AUTH_PLUGIN_LABELS,
  MAX_JUSTIFICATION_LENGTH,
  MAX_PAGE_SIZE,
  type CatalogDetailResponse,
} from '@ferrum-nexus/shared';
import { formatDateTime } from '../lib/format';
import { useCatalogApi, useCatalogSpec } from '../hooks/useCatalog';
import { useCancelAccessRequest, useCreateAccessRequest } from '../hooks/useAccessRequests';
import { useApplications } from '../hooks/useApplications';
import { useAuth } from '../stores/auth';
import { useToast } from '../stores/toast';
import { CallApiPanel } from '../components/catalog/CallApiPanel';
import { OpenApiView } from '../components/openapi/OpenApiView';
import { StartThreadDialog } from '../components/messaging/StartThreadDialog';
import { FormNotice } from '../components/auth/AuthShell';
import { Badge } from '../components/ui/Badge';
import { Button, buttonClassName } from '../components/ui/Button';
import { Card, CardBody, CardHeader, DetailRow, PageHeader } from '../components/ui/Card';
import { CopyField } from '../components/ui/CopyField';
import { EmptyState } from '../components/ui/EmptyState';
import { Icon, type IconName } from '../components/ui/Icon';
import { LabeledTextarea } from '../components/ui/Input';
import { LabeledSelect } from '../components/ui/Select';
import { LoadingPanel } from '../components/ui/Spinner';
import { StatusPill } from '../components/ui/StatusPill';
import { Tabs } from '../components/ui/Tabs';

/** The "my account" option value; a select has no `null`. */
const ACCOUNT_IDENTITY = 'account';

/** One tile in the strip of runtime facts under the page header. */
function GlanceTile({
  icon,
  label,
  value,
  hint,
}: {
  icon: IconName;
  label: string;
  value: ReactNode;
  hint?: string;
}): ReactElement {
  return (
    <div className="fx-card flex items-start gap-3 p-3">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-neutral-soft text-fg-muted">
        <Icon name={icon} className="h-4 w-4" />
      </span>
      <span className="min-w-0">
        <span className="block text-[0.7rem] font-medium tracking-[0.08em] text-fg-subtle uppercase">
          {label}
        </span>
        <span className="block truncate text-sm font-medium text-fg">{value}</span>
        {hint ? <span className="block truncate text-xs text-fg-subtle">{hint}</span> : null}
      </span>
    </div>
  );
}

/** Runtime facts a caller needs before reading anything else. */
function AtAGlance({ detail }: { detail: CatalogDetailResponse }): ReactElement {
  const { api, spec } = detail;
  return (
    <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <GlanceTile
        icon="lock"
        label="Authentication"
        value={AUTH_PLUGIN_LABELS[api.auth_plugin]}
        hint="Required on every request"
      />
      <GlanceTile
        icon="zap"
        label="Rate limit"
        value={
          api.rate_limit
            ? `${api.rate_limit.limit} requests / ${api.rate_limit.window_seconds}s`
            : 'Unlimited'
        }
        hint={api.rate_limit ? 'Per consumer, per window' : 'No throttling configured'}
      />
      <GlanceTile
        icon="shield"
        label="Access"
        value={api.requestable ? 'Approval required' : 'Open access'}
        hint={api.requestable ? 'Ask the provider for a grant' : 'Any portal account may call it'}
      />
      <GlanceTile
        icon="spec"
        label="Version"
        value={`v${api.version}`}
        hint={spec ? 'OpenAPI document' : 'No document'}
      />
    </div>
  );
}

function Overview({ detail }: { detail: CatalogDetailResponse }): ReactElement {
  const { api, spec } = detail;
  return (
    <Card>
      <CardHeader title="API details" icon="layout" />
      <CardBody className="flex flex-col gap-5">
        <div className="grid gap-4 md:grid-cols-2">
          {api.invoke_url ? (
            <CopyField label="Invoke URL" value={api.invoke_url} />
          ) : (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium tracking-wide text-fg-subtle uppercase">
                Invoke URL
              </span>
              <p className="rounded-md border border-border border-dashed bg-inset px-3 py-2 text-sm text-fg-muted">
                Not published — ask your administrator for the gateway address.
              </p>
            </div>
          )}
          <CopyField label="Gateway path" value={api.listen_path} />
        </div>
        {/* Version, authentication, rate limit and access already sit in the
            at-a-glance strip above, so the record below holds the rest. */}
        <dl>
          <DetailRow label="Visibility">{api.visibility}</DetailRow>
          <DetailRow label="Owner">{api.owner?.display_name ?? '—'}</DetailRow>
          <DetailRow label="Specification">
            {spec
              ? `${spec.parsed_title ?? api.name} (${spec.parsed_version ?? spec.version})`
              : 'None published'}
          </DetailRow>
          <DetailRow label="Last updated">{formatDateTime(api.updated_at)}</DetailRow>
        </dl>
      </CardBody>
    </Card>
  );
}

function Documentation({ slug, hasSpec }: { slug: string; hasSpec: boolean }): ReactElement {
  const specQuery = useCatalogSpec(slug, hasSpec);

  if (!hasSpec) {
    return (
      <Card>
        <EmptyState
          icon="spec"
          title="No specification published"
          description="The provider has not uploaded an OpenAPI document for this API yet."
        />
      </Card>
    );
  }
  if (specQuery.isLoading) {
    return (
      <Card>
        <LoadingPanel label="Loading specification" />
      </Card>
    );
  }
  if (specQuery.isError || !specQuery.data) {
    return (
      <Card>
        <EmptyState
          icon="alert"
          title="Specification unavailable"
          description="The document could not be loaded. Try again in a moment."
        />
      </Card>
    );
  }
  return <OpenApiView text={specQuery.data.raw_spec} />;
}

function AccessPanel({ detail }: { detail: CatalogDetailResponse }): ReactElement {
  const { api, my_request: myRequest, my_grant: myGrant } = detail;
  const [justification, setJustification] = useState('');
  // Which identity the access is for. `ACCOUNT_IDENTITY` is the account
  // itself, the default and what every request made before applications
  // existed is (issue #289).
  const [identity, setIdentity] = useState<string>(ACCOUNT_IDENTITY);
  const applications = useApplications({ status: 'active', limit: MAX_PAGE_SIZE });
  const createRequest = useCreateAccessRequest();
  const cancelRequest = useCancelAccessRequest();
  const toast = useToast();

  // Only shown once the caller could actually make the call: an approved grant,
  // or an API that needs no approval at all.
  const canCall = (myGrant !== null && myGrant.status === 'active') || !api.requestable;

  if (api.access_state === 'owner') {
    return (
      <Card>
        <EmptyState
          icon="stack"
          title="You publish this API"
          description="Manage its access requests, grants and settings from the publishing area."
          action={
            <Link
              to="/apis/$apiId"
              params={{ apiId: api.id }}
              className={buttonClassName({ variant: 'primary' })}
            >
              Manage API
            </Link>
          }
        />
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title="Your access"
          icon="grant"
          actions={<StatusPill status={api.access_state} />}
          description={
            api.requestable
              ? 'This API is protected by an access-control policy. Approved requests add your consumer to its ACL group.'
              : 'This API does not require an access request — issue a credential and start calling it.'
          }
        />
        <CardBody>
          {myGrant && myGrant.status === 'active' ? (
            <div className="flex flex-col gap-4">
              <FormNotice tone="success">
                Access granted {formatDateTime(myGrant.created_at)}. Your gateway consumer carries{' '}
                <code className="font-mono text-xs break-all">{myGrant.acl_group}</code>.
              </FormNotice>
              <p className="flex flex-wrap items-center gap-1.5 text-sm text-fg-muted">
                Call it with a credential of type
                <Badge tone="info">{AUTH_PLUGIN_LABELS[api.auth_plugin]}</Badge>— the address and
                the header are below.
              </p>
              <div>
                <Link
                  to="/credentials"
                  className={buttonClassName({ variant: 'secondary', size: 'sm' })}
                >
                  <Icon name="key" />
                  Manage your credentials
                </Link>
              </div>
            </div>
          ) : myRequest && myRequest.status === 'pending' ? (
            <div className="flex flex-col gap-4">
              <FormNotice tone="info">
                Your request is awaiting review (submitted {formatDateTime(myRequest.created_at)}).
              </FormNotice>
              <div>
                <Button
                  variant="secondary"
                  loading={cancelRequest.isPending}
                  onClick={() =>
                    cancelRequest.mutate(myRequest.id, {
                      onSuccess: () => toast.success('Request withdrawn'),
                    })
                  }
                >
                  Withdraw request
                </Button>
              </div>
            </div>
          ) : !api.requestable ? (
            <p className="text-sm text-fg-muted">
              No approval needed. Issue a credential from the credentials page to start calling this
              API.
            </p>
          ) : (
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                createRequest.mutate(
                  {
                    api_id: api.id,
                    justification: justification.trim(),
                    application_id: identity === ACCOUNT_IDENTITY ? null : identity,
                  },
                  {
                    onSuccess: () => {
                      setJustification('');
                      setIdentity(ACCOUNT_IDENTITY);
                      toast.success('Access request submitted');
                    },
                  },
                );
              }}
            >
              {(applications.data?.items.length ?? 0) > 0 ? (
                <LabeledSelect<string>
                  label="Requesting for"
                  value={identity}
                  onValueChange={setIdentity}
                  hint={
                    identity === ACCOUNT_IDENTITY
                      ? 'Approval adds this API to your account, so every credential issued to your account can call it.'
                      : 'Approval adds this API to that application only. Its credentials can call it; your account’s cannot.'
                  }
                  options={[
                    { value: ACCOUNT_IDENTITY, label: 'My account' },
                    ...(applications.data?.items ?? []).map((application) => ({
                      value: application.id,
                      label: application.name,
                    })),
                  ]}
                />
              ) : null}
              <LabeledTextarea
                label="Why do you need access?"
                required
                rows={5}
                maxLength={MAX_JUSTIFICATION_LENGTH}
                value={justification}
                onChange={(event) => setJustification(event.target.value)}
                placeholder="Which product or workflow needs this data, and what will you do with it?"
                hint={
                  <span className="flex flex-wrap items-center justify-between gap-2">
                    <span>The provider reviews this note.</span>
                    <span className="tabular-nums">
                      {justification.length}/{MAX_JUSTIFICATION_LENGTH} characters
                    </span>
                  </span>
                }
              />
              <div>
                <Button
                  type="submit"
                  variant="primary"
                  loading={createRequest.isPending}
                  disabled={justification.trim().length === 0}
                >
                  Request access
                </Button>
              </div>
            </form>
          )}

          {myRequest && myRequest.status !== 'pending' ? (
            <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-border pt-4 text-sm text-fg-muted">
              <span>Last decision:</span>
              <StatusPill status={myRequest.status} />
              {myRequest.decision_note ? (
                <span className="min-w-0 italic">“{myRequest.decision_note}”</span>
              ) : null}
            </div>
          ) : null}
        </CardBody>
      </Card>

      {canCall ? (
        <CallApiPanel
          invokeUrl={api.invoke_url}
          listenPath={api.listen_path}
          authPlugin={api.auth_plugin}
        />
      ) : null}
    </div>
  );
}

/** Catalog entry detail: overview, rendered documentation and access request. */

export function CatalogDetailPage(): ReactElement {
  const params = useParams({ strict: false });
  const slug = params.slug ?? '';
  const [tab, setTab] = useState('overview');
  const [messageOpen, setMessageOpen] = useState(false);
  const { canAdmin } = useAuth();
  const query = useCatalogApi(slug);

  if (query.isLoading) return <LoadingPanel label="Loading API" />;
  if (query.isError || !query.data) {
    return (
      <Card>
        <EmptyState
          icon="alert"
          title="API not found"
          description="It may have been retired, or you may not have permission to view it."
          action={
            <Link to="/catalog" className={buttonClassName({ variant: 'secondary' })}>
              Back to catalog
            </Link>
          }
        />
      </Card>
    );
  }

  const detail = query.data;
  const { api } = detail;
  // An admin may approve, deny and revoke on any API through the ordinary
  // routes — the guide's non-god-mode remedy — but the only link into the
  // workspace was owner-gated, so the remedy had no click path. The owner keeps
  // reaching it from the Access tab, which is why this covers the other case.
  const canManage = canAdmin && api.access_state !== 'owner';

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'API catalog', to: '/catalog' }, { label: api.name }]}
        title={api.name}
        description={api.description ?? undefined}
        meta={
          <>
            <Badge mono tone="accent">
              v{api.version}
            </Badge>
            <Badge tone="info">{AUTH_PLUGIN_LABELS[api.auth_plugin]}</Badge>
            <StatusPill status={api.status} />
            <StatusPill status={api.access_state} />
          </>
        }
        actions={
          <>
            {canManage ? (
              <Link
                to="/apis/$apiId"
                params={{ apiId: api.id }}
                className={buttonClassName({ variant: 'primary' })}
              >
                Manage API
              </Link>
            ) : null}
            {api.owner && api.access_state !== 'owner' ? (
              <Button variant="secondary" onClick={() => setMessageOpen(true)}>
                <Icon name="message" />
                Message provider
              </Button>
            ) : null}
          </>
        }
      />

      <AtAGlance detail={detail} />

      <Tabs
        value={tab}
        onValueChange={setTab}
        tabs={[
          { value: 'overview', label: 'Overview', content: <Overview detail={detail} /> },
          {
            value: 'docs',
            label: 'Documentation',
            content: <Documentation slug={slug} hasSpec={detail.spec !== null} />,
          },
          { value: 'access', label: 'Access', content: <AccessPanel detail={detail} /> },
        ]}
      />

      {api.owner ? (
        <StartThreadDialog
          open={messageOpen}
          onOpenChange={setMessageOpen}
          recipientUserId={api.owner.id}
          apiId={api.id}
          defaultSubject={`Question about ${api.name}`}
          recipientLabel={api.owner.display_name}
        />
      ) : null}
    </>
  );
}
