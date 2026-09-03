import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useState, type FormEvent, type ReactElement } from 'react';
import {
  AUTH_PLUGIN_LABELS,
  AUTH_PLUGIN_TYPES,
  MAX_CORS_ORIGINS,
  MAX_RATE_LIMIT_REQUESTS,
  aclGroupForApi,
  testConsumerUsername,
  type AccessRequest,
  type Api,
  type ApiStatus,
  type ApiUsageBackendStatus,
  type ApiUsageResponse,
  type ApiVisibility,
  type AuthPluginType,
  type CorsConfig,
  type Grant,
  type RateLimitConfig,
  type ShowOnceSecret,
} from '@ferrum-nexus/shared';
import { formatDateTime, parseCorsOrigins } from '../lib/format';
import {
  useApi,
  useApiUsage,
  useCreateTestConsumer,
  useDeleteApi,
  useUpdateApi,
  useUpdateApiSpec,
} from '../hooks/useApis';
import {
  useAccessRequests,
  useApproveAccessRequest,
  useDenyAccessRequest,
} from '../hooks/useAccessRequests';
import { useCatalogSpec } from '../hooks/useCatalog';
import { useGrants, useRevokeGrant } from '../hooks/useGrants';
import { useToast } from '../stores/toast';
import { RoleGuard } from '../components/layout/RoleGuard';
import { ShowOnceSecretDialog } from '../components/credentials/ShowOnceSecretDialog';
import { SpecEditor, isSpecValid } from '../components/publishing/SpecEditor';
import { Badge, type BadgeTone } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, CardBody, CardHeader, DetailRow, PageHeader } from '../components/ui/Card';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { EmptyState } from '../components/ui/EmptyState';
import { Checkbox, LabeledInput, LabeledTextarea } from '../components/ui/Input';
import { LabeledSelect } from '../components/ui/Select';
import { LoadingPanel } from '../components/ui/Spinner';
import { StatusPill } from '../components/ui/StatusPill';
import { Tabs } from '../components/ui/Tabs';

const WINDOW_OPTIONS = [
  { value: '1', label: 'per second' },
  { value: '60', label: 'per minute' },
  { value: '3600', label: 'per hour' },
];

/** Hint under the CORS origins box; the empty case is the one worth spelling out. */
const CORS_ORIGINS_HINT =
  `One origin per line, up to ${MAX_CORS_ORIGINS}, e.g. https://app.example.com. ` +
  'Leave it empty and the gateway adds no CORS headers at all, so a browser can ' +
  'only call this API from its own origin.';

function SettingsTab({ api }: { api: Api }): ReactElement {
  const update = useUpdateApi();
  const remove = useDeleteApi();
  const toast = useToast();
  const navigate = useNavigate();

  const [name, setName] = useState(api.name);
  const [description, setDescription] = useState(api.description ?? '');
  const [version, setVersion] = useState(api.version);
  const [upstreamUrl, setUpstreamUrl] = useState('');
  const [authPlugin, setAuthPlugin] = useState<AuthPluginType>(api.auth_plugin);
  const [visibility, setVisibility] = useState<ApiVisibility>(api.visibility);
  const [status, setStatus] = useState<ApiStatus>(api.status);
  const [requestable, setRequestable] = useState(api.requestable);
  const [rateLimitEnabled, setRateLimitEnabled] = useState(api.rate_limit !== null);
  const [rateLimitValue, setRateLimitValue] = useState(String(api.rate_limit?.limit ?? 100));
  const [rateLimitWindow, setRateLimitWindow] = useState(
    String(api.rate_limit?.window_seconds ?? 60),
  );
  const [corsOrigins, setCorsOrigins] = useState(api.cors?.allowed_origins.join('\n') ?? '');
  const [corsCredentials, setCorsCredentials] = useState(api.cors?.allow_credentials ?? false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const parsedLimit = Number.parseInt(rateLimitValue, 10);
    if (
      rateLimitEnabled &&
      (!Number.isFinite(parsedLimit) || parsedLimit < 1 || parsedLimit > MAX_RATE_LIMIT_REQUESTS)
    ) {
      toast.error(
        'Rate limit out of range',
        `The request limit must be a whole number between 1 and ${MAX_RATE_LIMIT_REQUESTS.toLocaleString()} — the gateway rejects anything higher.`,
      );
      return;
    }
    const rateLimit: RateLimitConfig | null = rateLimitEnabled
      ? { limit: parsedLimit, window_seconds: Number.parseInt(rateLimitWindow, 10) }
      : null;

    const origins = parseCorsOrigins(corsOrigins);
    if (origins.length > MAX_CORS_ORIGINS) {
      toast.error(
        'Too many CORS origins',
        `A CORS policy may list at most ${MAX_CORS_ORIGINS} origins.`,
      );
      return;
    }
    // Clearing the box sends `null`, which removes the plugin from the proxy.
    const cors: CorsConfig | null =
      origins.length > 0 ? { allowed_origins: origins, allow_credentials: corsCredentials } : null;

    update.mutate(
      {
        id: api.id,
        body: {
          name: name.trim(),
          description: description.trim() || null,
          version: version.trim(),
          auth_plugin: authPlugin,
          visibility,
          status,
          requestable,
          rate_limit: rateLimit,
          cors,
          ...(upstreamUrl.trim() ? { upstream_url: upstreamUrl.trim() } : {}),
        },
      },
      { onSuccess: () => toast.success('API settings saved') },
    );
  };

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader
          title="Settings"
          description="Safe runtime settings; the spec has its own tab."
        />
        <CardBody>
          <form className="grid gap-4 md:grid-cols-2" onSubmit={submit}>
            <LabeledInput
              label="Name"
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <LabeledInput
              label="Version"
              required
              value={version}
              onChange={(event) => setVersion(event.target.value)}
            />
            <LabeledTextarea
              className="md:col-span-2"
              label="Description"
              rows={3}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
            <LabeledInput
              className="md:col-span-2"
              label="Upstream URL"
              type="url"
              value={upstreamUrl}
              onChange={(event) => setUpstreamUrl(event.target.value)}
              hint={
                api.upstream_url ? (
                  <>
                    Currently <code className="font-mono">{api.upstream_url}</code>. Leave blank to
                    keep it.
                  </>
                ) : (
                  'Not recorded for this API. Leave blank to keep the current upstream.'
                )
              }
            />
            <LabeledSelect<AuthPluginType>
              label="Authentication"
              value={authPlugin}
              onValueChange={setAuthPlugin}
              options={AUTH_PLUGIN_TYPES.map((value) => ({
                value,
                label: AUTH_PLUGIN_LABELS[value],
              }))}
            />
            <LabeledSelect<ApiVisibility>
              label="Visibility"
              value={visibility}
              onValueChange={setVisibility}
              options={[
                { value: 'public', label: 'Public' },
                { value: 'internal', label: 'Internal' },
              ]}
            />
            <LabeledSelect<ApiStatus>
              label="Status"
              value={status}
              onValueChange={setStatus}
              options={[
                { value: 'published', label: 'Published' },
                { value: 'retired', label: 'Retired' },
              ]}
            />
            <div className="flex items-end">
              <Checkbox
                label="Require an approved access request"
                checked={requestable}
                onChange={(event) => setRequestable(event.target.checked)}
              />
            </div>
            <div className="md:col-span-2">
              <Checkbox
                label="Enforce a rate limit"
                checked={rateLimitEnabled}
                onChange={(event) => setRateLimitEnabled(event.target.checked)}
              />
            </div>
            {rateLimitEnabled ? (
              <>
                <LabeledInput
                  label="Requests"
                  type="number"
                  min={1}
                  max={MAX_RATE_LIMIT_REQUESTS}
                  value={rateLimitValue}
                  onChange={(event) => setRateLimitValue(event.target.value)}
                  hint={`1 – ${MAX_RATE_LIMIT_REQUESTS.toLocaleString()} per window.`}
                />
                <LabeledSelect
                  label="Window"
                  value={rateLimitWindow}
                  onValueChange={setRateLimitWindow}
                  options={WINDOW_OPTIONS}
                />
              </>
            ) : null}
            <LabeledTextarea
              className="md:col-span-2"
              label="CORS allowed origins"
              rows={3}
              placeholder={'https://app.example.com\nhttps://admin.example.com'}
              value={corsOrigins}
              onChange={(event) => setCorsOrigins(event.target.value)}
              hint={CORS_ORIGINS_HINT}
            />
            <div className="md:col-span-2">
              <Checkbox
                label="Allow credentials"
                description="Lets browsers send cookies and Authorization headers cross-origin. Ignored when no origins are listed."
                checked={corsCredentials}
                onChange={(event) => setCorsCredentials(event.target.checked)}
              />
            </div>
            <div className="md:col-span-2">
              <Button type="submit" variant="primary" loading={update.isPending}>
                Save settings
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>

      <Card className="border-danger/40">
        <CardHeader
          title="Danger zone"
          description="Deleting removes the API from the catalog and destroys its gateway proxy and plugins."
          actions={
            <Button variant="danger" onClick={() => setDeleteOpen(true)}>
              Delete API
            </Button>
          }
        />
      </Card>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete this API"
        description="This cannot be undone. Active grants stop working immediately."
        confirmLabel="Delete API"
        danger
        confirmPhrase={api.slug}
        loading={remove.isPending}
        onConfirm={() =>
          remove.mutate(api.id, {
            onSuccess: () => {
              toast.success('API deleted');
              void navigate({ to: '/apis' });
            },
          })
        }
      />
    </div>
  );
}

function SpecTab({ api }: { api: Api }): ReactElement {
  const specQuery = useCatalogSpec(api.slug);
  const updateSpec = useUpdateApiSpec();
  const toast = useToast();
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const value = draft ?? specQuery.data?.raw_spec ?? '';

  if (specQuery.isLoading) {
    return (
      <Card>
        <LoadingPanel label="Loading specification" />
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title="Specification"
        description="Publishing a revision re-parses the document and updates the catalog entry."
      />
      <CardBody className="flex flex-col gap-4">
        <SpecEditor value={value} onChange={setDraft} id="api-spec" />
        {error ? (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}
        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            loading={updateSpec.isPending}
            disabled={draft === null || draft.trim().length === 0}
            onClick={() => {
              setError(null);
              if (!isSpecValid(value)) {
                setError('The OpenAPI document could not be parsed.');
                return;
              }
              updateSpec.mutate(
                { id: api.id, body: { spec: value } },
                {
                  onSuccess: () => {
                    setDraft(null);
                    toast.success('Specification updated');
                  },
                },
              );
            }}
          >
            Publish revision
          </Button>
          {draft !== null ? (
            <Button variant="ghost" onClick={() => setDraft(null)}>
              Discard changes
            </Button>
          ) : null}
        </div>
      </CardBody>
    </Card>
  );
}

function RequestsTab({ apiId }: { apiId: string }): ReactElement {
  const query = useAccessRequests({ api_id: apiId, limit: 50 });
  const approve = useApproveAccessRequest();
  const deny = useDenyAccessRequest();
  const toast = useToast();
  const [decision, setDecision] = useState<{
    request: AccessRequest;
    kind: 'approve' | 'deny';
  } | null>(null);
  const [note, setNote] = useState('');

  const requests = query.data?.items ?? [];

  return (
    <>
      <Card className="overflow-hidden">
        <CardHeader
          title="Access requests"
          description="Approve to add the API's ACL group to the requester's consumer."
        />
        {query.isLoading ? (
          <LoadingPanel />
        ) : requests.length === 0 ? (
          <EmptyState icon="grant" title="No access requests" />
        ) : (
          <ul>
            {requests.map((request) => (
              <li key={request.id} className="border-b border-border px-5 py-4 last:border-b-0">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-fg">
                      {request.requester?.display_name ?? request.user_id}
                      {request.requester ? (
                        <span className="ml-2 text-xs text-fg-subtle">
                          {request.requester.email}
                        </span>
                      ) : null}
                    </p>
                    <p className="mt-1 text-sm whitespace-pre-line text-fg-muted">
                      {request.justification}
                    </p>
                    <p className="mt-1 text-xs text-fg-subtle">
                      Submitted {formatDateTime(request.created_at)}
                      {request.decided_at ? ` · decided ${formatDateTime(request.decided_at)}` : ''}
                    </p>
                    {request.decision_note ? (
                      <p className="mt-1 text-xs text-fg-subtle">Note: {request.decision_note}</p>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusPill status={request.status} />
                    {request.status === 'pending' ? (
                      <>
                        <Button
                          size="sm"
                          variant="primary"
                          onClick={() => {
                            setNote('');
                            setDecision({ request, kind: 'approve' });
                          }}
                        >
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => {
                            setNote('');
                            setDecision({ request, kind: 'deny' });
                          }}
                        >
                          Deny
                        </Button>
                      </>
                    ) : null}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <ConfirmDialog
        open={decision !== null}
        onOpenChange={(open) => {
          if (!open) setDecision(null);
        }}
        title={decision?.kind === 'deny' ? 'Deny access request' : 'Approve access request'}
        description={
          decision?.kind === 'deny'
            ? 'The requester is notified and no ACL group is added.'
            : "The requester's gateway consumer gains this API's approved ACL group."
        }
        confirmLabel={decision?.kind === 'deny' ? 'Deny' : 'Approve'}
        danger={decision?.kind === 'deny'}
        loading={approve.isPending || deny.isPending}
        onConfirm={() => {
          if (!decision) return;
          const body = { decision_note: note.trim() || null };
          const options = {
            onSuccess: () => {
              setDecision(null);
              toast.success(decision.kind === 'deny' ? 'Request denied' : 'Access granted');
            },
          };
          if (decision.kind === 'deny') deny.mutate({ id: decision.request.id, body }, options);
          else approve.mutate({ id: decision.request.id, body }, options);
        }}
      >
        <LabeledTextarea
          label="Decision note"
          rows={3}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          hint="Shared with the requester by email and in-app notification."
        />
      </ConfirmDialog>
    </>
  );
}

function GrantsTab({ apiId }: { apiId: string }): ReactElement {
  const query = useGrants({ api_id: apiId, limit: 50 });
  const revoke = useRevokeGrant();
  const toast = useToast();
  const [revoking, setRevoking] = useState<Grant | null>(null);
  const [reason, setReason] = useState('');

  const grants = query.data?.items ?? [];

  return (
    <>
      <Card className="overflow-hidden">
        <CardHeader
          title="Grants"
          description="Every consumer currently carrying this API's ACL group."
        />
        {query.isLoading ? (
          <LoadingPanel />
        ) : grants.length === 0 ? (
          <EmptyState icon="grant" title="No grants issued" />
        ) : (
          <ul>
            {grants.map((grant) => (
              <li
                key={grant.id}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3.5 last:border-b-0"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm text-fg">
                    {grant.user?.display_name ?? grant.user_id}
                  </p>
                  <p className="truncate text-xs text-fg-subtle">
                    Granted {formatDateTime(grant.created_at)}
                    {grant.revoked_at ? ` · revoked ${formatDateTime(grant.revoked_at)}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusPill status={grant.status} />
                  {grant.status === 'active' ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setReason('');
                        setRevoking(grant);
                      }}
                    >
                      Revoke
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title="Revoke this grant"
        description="The ACL group is removed from the consumer immediately; calls start failing at the gateway."
        confirmLabel="Revoke"
        danger
        loading={revoke.isPending}
        onConfirm={() => {
          if (!revoking) return;
          revoke.mutate(
            { id: revoking.id, body: { reason: reason.trim() || null } },
            {
              onSuccess: () => {
                setRevoking(null);
                toast.success('Grant revoked');
              },
            },
          );
        }}
      >
        <LabeledTextarea
          label="Reason"
          rows={3}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </ConfirmDialog>
    </>
  );
}

function TestConsumerTab({ api }: { api: Api }): ReactElement {
  const create = useCreateTestConsumer();
  const [label, setLabel] = useState('');
  const [secret, setSecret] = useState<{ secret: ShowOnceSecret; username: string } | null>(null);

  return (
    <>
      <Card>
        <CardHeader
          title="Test consumer"
          description="Creates a sandbox consumer that already carries this API's ACL group, with a credential of the API's auth type."
        />
        <CardBody className="flex flex-col gap-4">
          <p className="text-sm text-fg-muted">
            Consumer username:{' '}
            <code className="font-mono text-xs text-fg">{testConsumerUsername(api.id)}</code>
          </p>
          <LabeledInput
            label="Label"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            hint="Optional, stored with the credential metadata."
          />
          <div>
            <Button
              variant="primary"
              loading={create.isPending}
              onClick={() =>
                create.mutate(
                  { id: api.id, body: { label: label.trim() || null } },
                  {
                    onSuccess: (response) =>
                      setSecret({
                        secret: response.secret,
                        username: response.consumer_username,
                      }),
                  },
                )
              }
            >
              Create test credential
            </Button>
          </div>
        </CardBody>
      </Card>

      {secret ? (
        <ShowOnceSecretDialog
          open
          secret={secret.secret}
          consumerUsername={secret.username}
          title="Save your test credential"
          onAcknowledge={() => setSecret(null)}
        />
      ) : null}
    </>
  );
}

/* ── Usage ──────────────────────────────────────────────────────────────── */

/**
 * Colours for the backend verdict.
 *
 * `unknown` is deliberately neutral rather than a warning: the gateway lists a
 * circuit breaker only for a proxy that has one configured *and* has been
 * called, so "nothing reported" is the ordinary state for a quiet API, not a
 * problem to draw attention to.
 */
const BACKEND_TONES: Readonly<Record<ApiUsageBackendStatus, BadgeTone>> = {
  healthy: 'success',
  failing: 'danger',
  recovering: 'warning',
  unknown: 'neutral',
};

const BACKEND_LABELS: Readonly<Record<ApiUsageBackendStatus, string>> = {
  healthy: 'Healthy',
  failing: 'Failing',
  recovering: 'Recovering',
  unknown: 'Unknown',
};

function count(value: number): string {
  return value.toLocaleString();
}

/** The counters themselves, once a response has arrived. */
function UsageDetails({ usage }: { usage: ApiUsageResponse }): ReactElement {
  const { requests, latency_ms: latency, backend } = usage;
  const classes = requests.by_status_class;

  return (
    <CardBody>
      {usage.available ? null : (
        <p className="mb-4 text-sm text-fg-muted">
          Gateway metrics are unavailable, so there are no counts to show. {backend.detail}
        </p>
      )}

      <dl>
        <DetailRow label="Backend">
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={BACKEND_TONES[backend.status]}>{BACKEND_LABELS[backend.status]}</Badge>
            {backend.detail && usage.available ? (
              <span className="text-sm text-fg-muted">{backend.detail}</span>
            ) : null}
          </span>
          {backend.since ? (
            <span className="mt-1 block text-xs text-fg-subtle">
              Since {formatDateTime(backend.since)}
            </span>
          ) : null}
        </DetailRow>

        <DetailRow label="Requests">{count(requests.total)}</DetailRow>

        <DetailRow label="By status">
          <span className="flex flex-wrap items-center gap-1.5">
            <Badge tone="success">2xx {count(classes['2xx'])}</Badge>
            <Badge>3xx {count(classes['3xx'])}</Badge>
            <Badge tone={classes['4xx'] > 0 ? 'warning' : 'neutral'}>
              4xx {count(classes['4xx'])}
            </Badge>
            <Badge tone={classes['5xx'] > 0 ? 'danger' : 'neutral'}>
              5xx {count(classes['5xx'])}
            </Badge>
          </span>
        </DetailRow>

        <DetailRow label="Turned away">
          <span className="flex flex-wrap items-center gap-1.5">
            <Badge tone={requests.rate_limited > 0 ? 'warning' : 'neutral'}>
              429 rate limited {count(requests.rate_limited)}
            </Badge>
            <Badge tone={requests.unauthorized > 0 ? 'warning' : 'neutral'}>
              401 unauthorized {count(requests.unauthorized)}
            </Badge>
            <Badge tone={requests.forbidden > 0 ? 'warning' : 'neutral'}>
              403 forbidden {count(requests.forbidden)}
            </Badge>
          </span>
        </DetailRow>

        <DetailRow label="Latency (p95)">
          {latency ? (
            <span className="flex flex-wrap items-baseline gap-2">
              <span>{latency.p95} ms</span>
              <span className="text-xs text-fg-subtle">
                p50 {latency.p50} ms · p99 {latency.p99} ms
              </span>
            </span>
          ) : (
            'No timed requests yet'
          )}
        </DetailRow>
      </dl>

      <p className="mt-3 text-xs text-fg-subtle">
        Cumulative since the gateway process started; sampled {formatDateTime(usage.sampled_at)}.
      </p>
    </CardBody>
  );
}

/**
 * What the gateway currently reports for this API's proxy.
 *
 * Refetched every 30 seconds. There is no per-consumer breakdown and no time
 * window here because Ferrum Edge exposes neither for a proxy — see the
 * provider guide.
 */
function UsageCard({ apiId }: { apiId: string }): ReactElement {
  const query = useApiUsage(apiId);

  return (
    <Card>
      <CardHeader
        title="Usage"
        description="Read straight from the gateway each time. Nexus stores no metrics of its own."
      />
      {query.isLoading ? (
        <LoadingPanel label="Loading usage" />
      ) : query.isError || !query.data ? (
        <CardBody>
          <p className="text-sm text-fg-muted">Usage could not be loaded for this API.</p>
        </CardBody>
      ) : (
        <UsageDetails usage={query.data} />
      )}
    </Card>
  );
}

function ApiDetail({ apiId }: { apiId: string }): ReactElement {
  const query = useApi(apiId);
  const [tab, setTab] = useState('overview');

  if (query.isLoading) return <LoadingPanel label="Loading API" />;
  if (query.isError || !query.data) {
    return (
      <Card>
        <EmptyState
          icon="alert"
          title="API not found"
          description="It may have been deleted, or you may not own it."
          action={
            <Link to="/apis" className="text-sm text-accent hover:underline">
              Back to my APIs
            </Link>
          }
        />
      </Card>
    );
  }

  const { api, spec, stats } = query.data;

  return (
    <>
      <PageHeader
        title={api.name}
        description={api.description ?? undefined}
        actions={
          <Link
            to="/catalog/$slug"
            params={{ slug: api.slug }}
            className="text-sm text-accent hover:underline"
          >
            View in catalog
          </Link>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        <Badge tone="accent">v{api.version}</Badge>
        <Badge tone="info">{AUTH_PLUGIN_LABELS[api.auth_plugin]}</Badge>
        <StatusPill status={api.status} />
        {api.requestable ? <Badge tone="accent">Requestable</Badge> : <Badge>Open</Badge>}
      </div>

      <Tabs
        value={tab}
        onValueChange={setTab}
        tabs={[
          {
            value: 'overview',
            label: 'Overview',
            content: (
              <div className="flex flex-col gap-4">
                <Card>
                  <CardHeader title="Overview" />
                  <CardBody>
                    <dl>
                      <DetailRow label="Invoke URL">
                        {api.invoke_url ? (
                          <code className="font-mono text-xs">{api.invoke_url}</code>
                        ) : (
                          <span className="text-fg-muted">
                            No gateway address configured — an admin sets it in Settings → Gateway.
                          </span>
                        )}
                      </DetailRow>
                      <DetailRow label="Gateway path">
                        <code className="font-mono text-xs">{api.listen_path}</code>
                      </DetailRow>
                      <DetailRow label="Edge proxy id">
                        <code className="font-mono text-xs">{api.ferrum_proxy_id ?? '—'}</code>
                      </DetailRow>
                      <DetailRow label="ACL group">
                        <code className="font-mono text-xs">{aclGroupForApi(api.id)}</code>
                      </DetailRow>
                      <DetailRow label="Rate limit">
                        {api.rate_limit
                          ? `${api.rate_limit.limit} requests / ${api.rate_limit.window_seconds}s`
                          : 'Not enforced'}
                      </DetailRow>
                      <DetailRow label="Pending access requests">
                        {stats.pending_requests}
                      </DetailRow>
                      <DetailRow label="Active grants">{stats.active_grants}</DetailRow>
                      {/* Access requests, not calls — the Usage card below counts the traffic. */}
                      <DetailRow label="Access requests (all time)">
                        {stats.total_requests}
                      </DetailRow>
                      <DetailRow label="Current spec">
                        {spec
                          ? `${spec.parsed_title ?? api.name} (${spec.parsed_version ?? spec.version})`
                          : 'None published'}
                      </DetailRow>
                      <DetailRow label="Updated">{formatDateTime(api.updated_at)}</DetailRow>
                    </dl>
                  </CardBody>
                </Card>
                <UsageCard apiId={api.id} />
              </div>
            ),
          },
          { value: 'settings', label: 'Settings', content: <SettingsTab api={api} /> },
          { value: 'spec', label: 'Specification', content: <SpecTab api={api} /> },
          {
            value: 'requests',
            label: 'Requests',
            badge:
              stats.pending_requests > 0 ? (
                <Badge tone="warning">{stats.pending_requests}</Badge>
              ) : undefined,
            content: <RequestsTab apiId={api.id} />,
          },
          { value: 'grants', label: 'Grants', content: <GrantsTab apiId={api.id} /> },
          { value: 'test', label: 'Test consumer', content: <TestConsumerTab api={api} /> },
        ]}
      />
    </>
  );
}

/** Provider workspace for one API. */
export function ApiDetailPage(): ReactElement {
  const params = useParams({ strict: false });
  const apiId = params.apiId ?? '';
  return (
    <RoleGuard minRole="provider">
      <ApiDetail apiId={apiId} />
    </RoleGuard>
  );
}
