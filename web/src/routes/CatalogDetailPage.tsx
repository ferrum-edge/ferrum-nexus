import { Link, useParams } from '@tanstack/react-router';
import { useState, type ReactElement } from 'react';
import {
  AUTH_PLUGIN_LABELS,
  MAX_JUSTIFICATION_LENGTH,
  listenPathFor,
  type CatalogDetailResponse,
} from '@ferrum-nexus/shared';
import { formatDateTime } from '../lib/format';
import { useCatalogApi, useCatalogSpec } from '../hooks/useCatalog';
import { useCancelAccessRequest, useCreateAccessRequest } from '../hooks/useAccessRequests';
import { useToast } from '../stores/toast';
import { OpenApiView } from '../components/openapi/OpenApiView';
import { StartThreadDialog } from '../components/messaging/StartThreadDialog';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, CardBody, CardHeader, DetailRow, PageHeader } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { LabeledTextarea } from '../components/ui/Input';
import { LoadingPanel } from '../components/ui/Spinner';
import { StatusPill } from '../components/ui/StatusPill';
import { Tabs } from '../components/ui/Tabs';

function Overview({ detail }: { detail: CatalogDetailResponse }): ReactElement {
  const { api, spec } = detail;
  return (
    <Card>
      <CardHeader title="API details" />
      <CardBody>
        <dl>
          <DetailRow label="Description">{api.description ?? '—'}</DetailRow>
          <DetailRow label="Gateway path">
            <code className="font-mono text-xs">{listenPathFor(api.namespace, api.slug)}</code>
          </DetailRow>
          <DetailRow label="Version">{api.version}</DetailRow>
          <DetailRow label="Authentication">{AUTH_PLUGIN_LABELS[api.auth_plugin]}</DetailRow>
          <DetailRow label="Rate limit">
            {api.rate_limit
              ? `${api.rate_limit.limit} requests / ${api.rate_limit.window_seconds}s`
              : 'Not enforced'}
          </DetailRow>
          <DetailRow label="Visibility">{api.visibility}</DetailRow>
          <DetailRow label="Access">
            {api.requestable ? 'Requires an approved access request' : 'Open to all portal users'}
          </DetailRow>
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
  const createRequest = useCreateAccessRequest();
  const cancelRequest = useCancelAccessRequest();
  const toast = useToast();

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
              className="inline-flex h-9 items-center rounded-md bg-accent px-3.5 text-sm font-medium text-accent-fg hover:bg-accent-hover"
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
          actions={<StatusPill status={api.access_state} />}
          description={
            api.requestable
              ? 'This API is protected by an access-control policy. Approved requests add your consumer to its ACL group.'
              : 'This API does not require an access request — issue a credential and start calling it.'
          }
        />
        <CardBody>
          {myGrant && myGrant.status === 'active' ? (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-fg">
                Access granted {formatDateTime(myGrant.created_at)}. Your gateway consumer carries{' '}
                <code className="font-mono text-xs">{myGrant.acl_group}</code>.
              </p>
              <p className="text-sm text-fg-muted">
                Call{' '}
                <code className="font-mono text-xs">{listenPathFor(api.namespace, api.slug)}</code>{' '}
                with a credential of type{' '}
                <Badge tone="info">{AUTH_PLUGIN_LABELS[api.auth_plugin]}</Badge>.
              </p>
              <Link to="/credentials" className="text-sm text-accent hover:underline">
                Manage your credentials →
              </Link>
            </div>
          ) : myRequest && myRequest.status === 'pending' ? (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-fg">
                Your request is awaiting review (submitted {formatDateTime(myRequest.created_at)}).
              </p>
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
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                createRequest.mutate(
                  { api_id: api.id, justification: justification.trim() },
                  {
                    onSuccess: () => {
                      setJustification('');
                      toast.success('Access request submitted');
                    },
                  },
                );
              }}
            >
              <LabeledTextarea
                label="Why do you need access?"
                required
                rows={5}
                maxLength={MAX_JUSTIFICATION_LENGTH}
                value={justification}
                onChange={(event) => setJustification(event.target.value)}
                hint={`The provider reviews this note. ${justification.length}/${MAX_JUSTIFICATION_LENGTH} characters.`}
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
            <p className="mt-4 text-sm text-fg-muted">
              Last decision: <StatusPill status={myRequest.status} />{' '}
              {myRequest.decision_note ? `— “${myRequest.decision_note}”` : null}
            </p>
          ) : null}
        </CardBody>
      </Card>
    </div>
  );
}

/** Catalog entry detail: overview, rendered documentation and access request. */
export function CatalogDetailPage(): ReactElement {
  const params = useParams({ strict: false });
  const slug = params.slug ?? '';
  const [tab, setTab] = useState('overview');
  const [messageOpen, setMessageOpen] = useState(false);
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
            <Link to="/catalog" className="text-sm text-accent hover:underline">
              Back to catalog
            </Link>
          }
        />
      </Card>
    );
  }

  const detail = query.data;
  const { api } = detail;

  return (
    <>
      <PageHeader
        title={api.name}
        description={api.description ?? undefined}
        actions={
          api.owner && api.access_state !== 'owner' ? (
            <Button variant="secondary" onClick={() => setMessageOpen(true)}>
              Message provider
            </Button>
          ) : null
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        <Badge tone="accent">v{api.version}</Badge>
        <Badge tone="info">{AUTH_PLUGIN_LABELS[api.auth_plugin]}</Badge>
        <StatusPill status={api.status} />
        <StatusPill status={api.access_state} />
      </div>

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
