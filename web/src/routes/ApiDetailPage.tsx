import { Link, useNavigate, useParams } from '@tanstack/react-router';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  AUTH_PLUGIN_LABELS,
  AUTH_PLUGIN_TYPES,
  HTTP_METHODS,
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
  type HttpMethod,
  type RateLimitConfig,
  type ShowOnceSecret,
  type SpecDiff,
  type SpecEnforcementLevel,
} from '@ferrum-nexus/shared';
import { formatDateTime, parseCorsOrigins } from '../lib/format';
import {
  useApi,
  useApiSpec,
  useApiUsage,
  useCreateTestConsumer,
  useDeleteApi,
  useDiffApiSpec,
  useRestoreApiGateway,
  useUpdateApi,
  useUpdateApiSpec,
} from '../hooks/useApis';
import {
  useAccessRequests,
  useApproveAccessRequest,
  useDenyAccessRequest,
} from '../hooks/useAccessRequests';
import { useGrants, useRevokeGrant } from '../hooks/useGrants';
import { useToast } from '../stores/toast';
import { RoleGuard } from '../components/layout/RoleGuard';
import { ShowOnceSecretDialog } from '../components/credentials/ShowOnceSecretDialog';
import { declaredMethods } from '../components/openapi/parse';
import {
  AdvancedProxySettings,
  parseTimeoutDraft,
  timeoutDraftFrom,
  type TimeoutDraft,
} from '../components/publishing/AdvancedProxySettings';
import { StartThreadDialog } from '../components/messaging/StartThreadDialog';
import { PluginsTab } from '../components/plugins/PluginsTab';
import { ApiViewersTab } from '../components/publishing/ApiViewersTab';
import { SpecDiffView } from '../components/publishing/SpecDiffView';
import { SpecEditor, specProblem } from '../components/publishing/SpecEditor';
import { SpecHistory } from '../components/publishing/SpecHistory';
import { FormNotice } from '../components/auth/AuthShell';
import { Badge, type BadgeTone } from '../components/ui/Badge';
import { Button, buttonClassName } from '../components/ui/Button';
import { Card, CardBody, CardHeader, DetailRow, PageHeader } from '../components/ui/Card';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { EmptyState } from '../components/ui/EmptyState';
import { Icon, type IconName } from '../components/ui/Icon';
import { Checkbox, LabeledInput, LabeledTextarea } from '../components/ui/Input';
import { LabeledSelect } from '../components/ui/Select';
import { SpecEnforcementSelect } from '../components/publishing/SpecEnforcementSelect';
import { LoadingPanel } from '../components/ui/Spinner';
import { StatusPill } from '../components/ui/StatusPill';
import { Tabs } from '../components/ui/Tabs';

const WINDOW_OPTIONS = [
  { value: '1', label: 'per second' },
  { value: '60', label: 'per minute' },
  { value: '3600', label: 'per hour' },
];

/**
 * What a provider is told before they change the authentication method of a
 * **live** API.
 *
 * Edge runs one flavour of authentication per proxy, so the swap stops every
 * credential of the outgoing flavour at this API the moment it lands — from the
 * client's side, a `401` on a key this portal still lists as active (issue
 * #234). Nobody's credential is taken away, because it still serves their other
 * APIs; what they lose is this one, until they issue a matching credential. The
 * server refuses the change outright unless the request acknowledges that, so
 * the checkbox below is not decoration: without it the save comes back as a
 * `409` naming how many accounts are cut off.
 */
const AUTH_SWAP_WARNING =
  'Everyone holding access with a credential of the old method loses access to this API until they issue one of the new method. Their credentials are not revoked — they keep working on other APIs — and saving notifies everyone affected. Any test-consumer credential of this API is revoked, since it can no longer authenticate anything.';

/** Hint under the CORS origins box; the empty case is the one worth spelling out. */
const CORS_ORIGINS_HINT =
  `One origin per line, up to ${MAX_CORS_ORIGINS}, e.g. https://app.example.com. ` +
  'Leave it empty and the gateway adds no CORS headers at all, so a browser can ' +
  'only call this API from its own origin.';

/* ── Small presentational helpers ───────────────────────────────────────── */

/**
 * One tile of the "at a glance" strip above the tabs.
 *
 * `copyable` adds a clipboard button, for the values a provider pastes into a
 * terminal. The clipboard is unavailable in an insecure context, so a failed
 * write simply leaves the value selectable.
 */
function GlanceTile({
  icon,
  label,
  value,
  mono = false,
  copyable = false,
}: {
  icon: IconName;
  label: string;
  value: string;
  mono?: boolean;
  copyable?: boolean;
}): ReactElement {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <div className="fx-card flex items-start gap-3 px-4 py-3">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
        <Icon name={icon} className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[0.7rem] font-semibold tracking-[0.08em] text-fg-subtle uppercase">
          {label}
        </p>
        <p
          className={`mt-0.5 truncate text-sm text-fg ${mono ? 'font-mono text-xs' : 'tabular-nums'}`}
          title={value}
        >
          {value}
        </p>
      </div>
      {copyable ? (
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={copied ? `${label} copied` : `Copy ${label}`}
          onClick={() => {
            void navigator.clipboard
              ?.writeText(value)
              .then(() => setCopied(true))
              .catch(() => setCopied(false));
          }}
        >
          <Icon name={copied ? 'check' : 'copy'} className={copied ? 'text-success' : undefined} />
        </Button>
      ) : null}
    </div>
  );
}

/** Initials for the avatar disc on an access-request or grant row. */
function initialsOf(label: string): string {
  const words = label
    .trim()
    .split(/[\s@._-]+/)
    .filter(Boolean);
  const letters = words.slice(0, 2).map((word) => word[0] ?? '');
  return (letters.join('') || '?').toUpperCase();
}

/** Circular avatar standing in for the requester or grantee. */
function Avatar({ label }: { label: string }): ReactElement {
  return (
    <span
      aria-hidden="true"
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent"
    >
      {initialsOf(label)}
    </span>
  );
}

/** Section heading inside a long settings form. */
function FormSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}): ReactElement {
  return (
    <section className="flex flex-col gap-4 border-t border-border pt-5 first:border-t-0 first:pt-0">
      <div>
        <h3 className="text-sm font-semibold text-fg">{title}</h3>
        {description ? <p className="mt-0.5 text-xs text-fg-subtle">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

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
  const [corsWebsocketOrigins, setCorsWebsocketOrigins] = useState(
    api.cors?.enforce_websocket_origins ?? true,
  );
  const [corsHeaders, setCorsHeaders] = useState(api.cors?.allowed_headers?.join('\n') ?? '');
  const [methods, setMethods] = useState<HttpMethod[]>(api.allowed_methods ?? []);
  const [timeouts, setTimeouts] = useState<TimeoutDraft>(timeoutDraftFrom(api.timeouts));
  const [circuitBreaker, setCircuitBreaker] = useState(api.circuit_breaker);
  const [methodsChanged, setMethodsChanged] = useState(false);
  const [timeoutsChanged, setTimeoutsChanged] = useState(false);
  const [circuitBreakerChanged, setCircuitBreakerChanged] = useState(false);
  const methodsGeneration = useRef(0);
  const timeoutsGeneration = useRef(0);
  const circuitBreakerGeneration = useRef(0);
  const [specEnforcement, setSpecEnforcement] = useState<SpecEnforcementLevel>(
    api.spec_enforcement,
  );
  const [confirmDisruption, setConfirmDisruption] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  /** Whether this form is about to cut existing callers off from this API. */
  const authSwapped = authPlugin !== api.auth_plugin;

  // The current document is not on this page, so it is fetched to offer the
  // same "use the methods declared in the spec" shortcut the publish form has.
  // An API with no stored revision simply does not get the shortcut.
  const specQuery = useApiSpec(api.id);
  const specMethods = useMemo<HttpMethod[]>(() => {
    const raw = specQuery.data?.raw_spec;
    if (!raw) return [];
    const declared = declaredMethods(raw);
    return HTTP_METHODS.filter((method) => declared.includes(method));
  }, [specQuery.data?.raw_spec]);

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
      origins.length > 0
        ? {
            allowed_origins: origins,
            allow_credentials: corsCredentials,
            allowed_headers: parseCorsOrigins(corsHeaders),
            enforce_websocket_origins: corsWebsocketOrigins,
          }
        : null;

    const parsedTimeouts = timeoutsChanged ? parseTimeoutDraft(timeouts) : undefined;
    if (typeof parsedTimeouts === 'string') {
      toast.error('Timeout out of range', parsedTimeouts);
      return;
    }

    const submittedMethodsGeneration = methodsGeneration.current;
    const submittedTimeoutsGeneration = timeoutsGeneration.current;
    const submittedCircuitBreakerGeneration = circuitBreakerGeneration.current;

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
          // Omit untouched proxy controls so operator-managed live settings survive
          // unrelated edits. Once changed, empty values intentionally reset them.
          ...(methodsChanged ? { allowed_methods: methods.length > 0 ? methods : null } : {}),
          ...(timeoutsChanged ? { timeouts: parsedTimeouts } : {}),
          ...(circuitBreakerChanged ? { circuit_breaker: circuitBreaker } : {}),
          // Only ever sent alongside a real swap, and only once the provider
          // has ticked the box: the flag is an acknowledgement of a specific
          // consequence, not a standing preference.
          ...(authSwapped && confirmDisruption ? { confirm_access_disruption: true } : {}),
          spec_enforcement: specEnforcement,
          ...(upstreamUrl.trim() ? { upstream_url: upstreamUrl.trim() } : {}),
        },
      },
      {
        onSuccess: () => {
          // Keep edits made while this request was in flight dirty for the next save.
          if (methodsGeneration.current === submittedMethodsGeneration) setMethodsChanged(false);
          if (timeoutsGeneration.current === submittedTimeoutsGeneration) setTimeoutsChanged(false);
          if (circuitBreakerGeneration.current === submittedCircuitBreakerGeneration) {
            setCircuitBreakerChanged(false);
          }
          toast.success('API settings saved');
        },
      },
    );
  };

  return (
    <div className="flex flex-col gap-6">
      <form onSubmit={submit}>
        <Card>
          <CardHeader
            icon="settings"
            title="Settings"
            description="Safe runtime settings; the spec has its own tab."
          />
          <CardBody className="flex flex-col gap-6">
            <FormSection
              title="Identity"
              description="How the API appears in the catalog and on the gateway."
            >
              <div className="grid gap-4 md:grid-cols-2">
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
                        Currently <code className="font-mono">{api.upstream_url}</code>. Leave blank
                        to keep it.
                      </>
                    ) : (
                      'Not recorded for this API. Leave blank to keep the current upstream.'
                    )
                  }
                />
              </div>
            </FormSection>

            <FormSection title="Access" description="Who may call this API, and how they prove it.">
              <div className="grid gap-4 md:grid-cols-2">
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
                    { value: 'internal', label: 'Internal (unlisted)' },
                    { value: 'private', label: 'Private (authorized viewers)' },
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
                <div className="flex items-end pb-2">
                  <Checkbox
                    label="Require an approved access request"
                    checked={requestable}
                    onChange={(event) => setRequestable(event.target.checked)}
                  />
                </div>
                {authSwapped ? (
                  <div className="flex flex-col gap-3 md:col-span-2">
                    <FormNotice tone="warning">{AUTH_SWAP_WARNING}</FormNotice>
                    <Checkbox
                      label="Invalidate portal-issued old-method credentials here and notify their holders"
                      checked={confirmDisruption}
                      onChange={(event) => setConfirmDisruption(event.target.checked)}
                    />
                  </div>
                ) : null}
              </div>
            </FormSection>

            <FormSection
              title="Runtime policy"
              description="Applied as Ferrum Edge plugins on the proxy created for this API."
            >
              <div className="grid gap-4 md:grid-cols-2">
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
                <SpecEnforcementSelect
                  className="md:col-span-2"
                  value={specEnforcement}
                  onValueChange={setSpecEnforcement}
                  publishedLevel={api.spec_enforcement}
                />
                <LabeledTextarea
                  className="md:col-span-2"
                  label="CORS allowed origins"
                  rows={3}
                  placeholder={'https://app.example.com\nhttps://admin.example.com'}
                  value={corsOrigins}
                  onChange={(event) => setCorsOrigins(event.target.value)}
                  hint={CORS_ORIGINS_HINT}
                />
                <div className="flex flex-col gap-3 md:col-span-2">
                  <Checkbox
                    label="Allow credentials"
                    description="Lets browsers send cookies and Authorization headers cross-origin. Ignored when no origins are listed."
                    checked={corsCredentials}
                    onChange={(event) => setCorsCredentials(event.target.checked)}
                  />
                  <Checkbox
                    label="Enforce WebSocket origins"
                    description="Requires a listed Origin on every upgrade. Rejects clients without Origin. Disable only for non-browser clients that omit it."
                    checked={corsWebsocketOrigins}
                    onChange={(event) => setCorsWebsocketOrigins(event.target.checked)}
                  />
                  <LabeledTextarea
                    label="Additional CORS request headers"
                    rows={2}
                    value={corsHeaders}
                    onChange={(event) => setCorsHeaders(event.target.value)}
                    hint="One header name per line. Authentication headers are included automatically."
                  />
                </div>
              </div>
            </FormSection>

            <FormSection
              title="Proxy"
              description="Settings written onto the gateway proxy itself rather than as a plugin."
            >
              <AdvancedProxySettings
                collapsible
                methods={methods}
                onMethodsChange={(next) => {
                  methodsGeneration.current += 1;
                  setMethods(next);
                  setMethodsChanged(true);
                }}
                timeouts={timeouts}
                onTimeoutsChange={(next) => {
                  timeoutsGeneration.current += 1;
                  setTimeouts(next);
                  setTimeoutsChanged(true);
                }}
                circuitBreaker={circuitBreaker}
                onCircuitBreakerChange={(next) => {
                  circuitBreakerGeneration.current += 1;
                  setCircuitBreaker(next);
                  setCircuitBreakerChanged(true);
                }}
                specMethods={specMethods}
              />
            </FormSection>
          </CardBody>
          <div className="flex flex-wrap items-center gap-3 border-t border-border bg-inset/40 px-5 py-3.5">
            <Button type="submit" variant="primary" loading={update.isPending}>
              Save settings
            </Button>
            <p className="text-xs text-fg-subtle">
              Saved settings are reconciled onto the gateway proxy immediately.
            </p>
          </div>
        </Card>
      </form>

      <Card className="border-danger/40">
        <CardBody className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-danger-soft text-danger">
              <Icon name="trash" className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-fg">Danger zone</h3>
              <p className="mt-1 max-w-xl text-sm leading-relaxed text-fg-muted">
                Deleting removes the API from the catalog and destroys its gateway proxy and
                plugins. Retire it from the Status field above if you only want it out of the
                catalog.
              </p>
            </div>
          </div>
          <Button variant="danger" onClick={() => setDeleteOpen(true)}>
            Delete API
          </Button>
        </CardBody>
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
  const specQuery = useApiSpec(api.id);
  const updateSpec = useUpdateApiSpec();
  const reviewDiff = useDiffApiSpec();
  const toast = useToast();
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The diff travels with the exact document it was computed from. The editor
  // stays live while the comparison is in flight, so publishing whatever the
  // editor holds at confirm time could ship a document nobody reviewed
  // (issue #330): the confirmation publishes `review.spec` and nothing else.
  const [review, setReview] = useState<{ diff: SpecDiff; spec: string } | null>(null);

  const value = draft ?? specQuery.data?.raw_spec ?? '';

  /**
   * Publish the reviewed document. The draft is cleared only when it still
   * matches what was published — edits made after the review stay in the
   * editor as unsaved changes rather than being silently dropped.
   */
  const publish = (spec: string): void => {
    updateSpec.mutate(
      { id: api.id, body: { spec } },
      {
        onSuccess: () => {
          setDraft((current) => (current === spec ? null : current));
          setReview(null);
          toast.success('Specification updated');
        },
        // A refused revision closes the review and leaves the draft in the
        // editor: the provider's document is the thing worth keeping, and a
        // modal sitting over a failure they cannot act on is not.
        onError: (mutationError: Error) => {
          setReview(null);
          toast.error('Specification not published', mutationError.message);
        },
      },
    );
  };

  if (specQuery.isLoading) {
    return (
      <Card>
        <LoadingPanel label="Loading specification" />
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          icon="spec"
          title="Specification"
          description="Publishing a revision re-parses the document and updates the catalog entry."
          actions={
            draft !== null ? (
              <Badge tone="warning" dot>
                Unsaved changes
              </Badge>
            ) : undefined
          }
        />
        <CardBody className="flex flex-col gap-4">
          <SpecEditor value={value} onChange={setDraft} id="api-spec" />
          {error ? <FormNotice tone="danger">{error}</FormNotice> : null}
        </CardBody>
        <div className="flex flex-wrap items-center gap-2 border-t border-border bg-inset/40 px-5 py-3.5">
          {/* Review first. A revision can take operations away from live
            callers, and under `routes` enforcement the gateway starts
            rejecting them the moment it lands — so the diff is a step in the
            flow rather than something to go looking for (issue #290). */}
          <Button
            variant="primary"
            loading={reviewDiff.isPending}
            disabled={draft === null || draft.trim().length === 0}
            onClick={() => {
              setError(null);
              const spec = value;
              const problem = specProblem(spec);
              if (problem) {
                setError(problem);
                return;
              }
              reviewDiff.mutate(
                { id: api.id, body: { spec } },
                {
                  onSuccess: (response) => setReview({ diff: response.diff, spec }),
                  onError: (mutationError: Error) => setError(mutationError.message),
                },
              );
            }}
          >
            Review changes
          </Button>
          {draft !== null ? (
            <Button variant="ghost" onClick={() => setDraft(null)}>
              Discard changes
            </Button>
          ) : null}
        </div>
      </Card>

      <SpecHistory api={api} />

      <ConfirmDialog
        open={review !== null}
        onOpenChange={(next) => {
          if (!next) setReview(null);
        }}
        title="Publish this revision"
        description="The new document replaces the current one and is recorded as a new revision. The previous revisions stay in history."
        confirmLabel="Publish revision"
        danger={(review?.diff.potentially_breaking.length ?? 0) > 0}
        loading={updateSpec.isPending}
        onConfirm={() => {
          if (review) publish(review.spec);
        }}
      >
        {review ? (
          <>
            {review.spec !== value ? (
              <FormNotice tone="warning">
                The editor changed after this comparison was made. Publishing sends the reviewed
                document shown here; your newer edits stay in the editor as unsaved changes.
              </FormNotice>
            ) : null}
            <SpecDiffView diff={review.diff} />
          </>
        ) : (
          <></>
        )}
      </ConfirmDialog>
    </div>
  );
}

const ACCESS_PAGE_SIZE = 50;

function AccessPagination({
  page,
  total,
  fetching,
  onPageChange,
}: {
  page: number;
  total: number | undefined;
  fetching: boolean;
  onPageChange: (page: number) => void;
}): ReactElement {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-inset/40 px-5 py-2.5">
      <p role="status" className="text-xs text-fg-muted tabular-nums">
        {total === undefined
          ? 'Loading count…'
          : `${total} total · Page ${page + 1} of ${Math.max(1, Math.ceil(total / ACCESS_PAGE_SIZE))}`}
      </p>
      <div className="flex gap-1.5">
        <Button
          size="sm"
          variant="ghost"
          disabled={fetching || page === 0}
          onClick={() => onPageChange(page - 1)}
        >
          <Icon name="chevron-left" />
          Previous
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={fetching || total === undefined || (page + 1) * ACCESS_PAGE_SIZE >= total}
          onClick={() => onPageChange(page + 1)}
        >
          Next
          <Icon name="chevron-right" />
        </Button>
      </div>
    </div>
  );
}

export function RequestsTab({ apiId }: { apiId: string }): ReactElement {
  const [page, setPage] = useState(0);
  const [status, setStatus] = useState<'pending' | 'approved' | 'denied' | 'all'>('pending');
  const query = useAccessRequests({
    api_id: apiId,
    limit: ACCESS_PAGE_SIZE,
    offset: page * ACCESS_PAGE_SIZE,
    ...(status === 'all' ? {} : { status }),
  });
  useEffect(() => {
    if (query.isSuccess && !query.isFetching && query.data.items.length === 0 && page > 0) {
      setPage((current) => current - 1);
    }
  }, [query.isSuccess, query.isFetching, query.data, page]);
  const approve = useApproveAccessRequest();
  const deny = useDenyAccessRequest();
  const toast = useToast();
  const [decision, setDecision] = useState<{
    request: AccessRequest;
    kind: 'approve' | 'deny';
  } | null>(null);
  const [note, setNote] = useState('');
  // The provider guide's first use of Messages is clarifying a thin
  // justification *before* deciding, so the entry point sits on the row.
  const [messageTarget, setMessageTarget] = useState<AccessRequest | null>(null);

  const requests = query.data?.items ?? [];

  return (
    <>
      <Card className="overflow-hidden">
        <CardHeader
          icon="grant"
          title="Access requests"
          description="Approve to add the API's ACL group to the requester's consumer."
          actions={
            <LabeledSelect
              className="w-40"
              label="Request status"
              value={status}
              onValueChange={(value) => {
                setStatus(value);
                setPage(0);
              }}
              options={[
                { value: 'pending', label: 'Pending' },
                { value: 'approved', label: 'Approved' },
                { value: 'denied', label: 'Denied' },
                { value: 'all', label: 'All' },
              ]}
            />
          }
        />
        {query.isLoading ? (
          <LoadingPanel />
        ) : requests.length === 0 ? (
          <EmptyState
            icon="grant"
            title="No matching access requests"
            description="Requests appear here as soon as a portal user asks for access to this API."
          />
        ) : (
          <ul>
            {requests.map((request) => (
              <li
                key={request.id}
                className="border-b border-border px-5 py-4 transition-colors last:border-b-0 hover:bg-surface-hover"
              >
                <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
                  <div className="flex min-w-0 flex-1 items-start gap-3">
                    <Avatar label={request.requester?.display_name ?? request.user_id} />
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 truncate text-sm font-medium text-fg">
                        <span className="truncate">
                          {request.requester?.display_name ?? request.user_id}
                        </span>
                        {request.requester ? (
                          <span className="text-xs font-normal text-fg-subtle">
                            {request.requester.email}
                          </span>
                        ) : null}
                        {/* Which *integration* is asking, not just which
                            account — approving adds the API to that identity
                            alone (issue #289). */}
                        {request.application ? (
                          <Badge tone="accent">{request.application.name}</Badge>
                        ) : null}
                      </p>
                      <p className="mt-1 text-xs text-fg-subtle">
                        Submitted {formatDateTime(request.created_at)}
                        {request.decided_at
                          ? ` · decided ${formatDateTime(request.decided_at)}`
                          : ''}
                      </p>
                      <blockquote className="mt-2 border-l-2 border-border pl-3 text-sm leading-relaxed whitespace-pre-line text-fg-muted">
                        {request.justification}
                      </blockquote>
                      {request.decision_note ? (
                        <p className="mt-2 text-xs text-fg-subtle">
                          <span className="font-medium text-fg-muted">Note:</span>{' '}
                          {request.decision_note}
                        </p>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <StatusPill status={request.status} />
                    {request.requester ? (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        title="Send a message"
                        aria-label={`Message ${request.requester.display_name}`}
                        onClick={() => setMessageTarget(request)}
                      >
                        <Icon name="message" />
                      </Button>
                    ) : null}
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
                          <Icon name="check" />
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
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
        <AccessPagination
          page={page}
          total={query.data?.total}
          fetching={query.isFetching}
          onPageChange={setPage}
        />
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

      {messageTarget?.requester ? (
        <StartThreadDialog
          key={messageTarget.id}
          open
          onOpenChange={(next) => {
            if (!next) setMessageTarget(null);
          }}
          recipientUserId={messageTarget.requester.id}
          apiId={apiId}
          defaultSubject="About your access request"
          recipientLabel={messageTarget.requester.display_name}
        />
      ) : null}
    </>
  );
}

export function GrantsTab({ apiId }: { apiId: string }): ReactElement {
  const [page, setPage] = useState(0);
  const [status, setStatus] = useState<'active' | 'revoked' | 'all'>('active');
  const query = useGrants({
    api_id: apiId,
    limit: ACCESS_PAGE_SIZE,
    offset: page * ACCESS_PAGE_SIZE,
    ...(status === 'all' ? {} : { status }),
  });
  useEffect(() => {
    if (query.isSuccess && !query.isFetching && query.data.items.length === 0 && page > 0) {
      setPage((current) => current - 1);
    }
  }, [query.isSuccess, query.isFetching, query.data, page]);
  const revoke = useRevokeGrant();
  const toast = useToast();
  const [revoking, setRevoking] = useState<Grant | null>(null);
  const [reason, setReason] = useState('');
  // The other two uses the guide names — warning grantees of a breaking change,
  // and explaining a decline — both start from a grantee.
  const [messageTarget, setMessageTarget] = useState<Grant | null>(null);

  const grants = query.data?.items ?? [];

  return (
    <>
      <Card className="overflow-hidden">
        <CardHeader
          icon="key"
          title="Grants"
          description="Active and revoked access to this API."
          actions={
            <LabeledSelect
              className="w-40"
              label="Grant status"
              value={status}
              onValueChange={(value) => {
                setStatus(value);
                setPage(0);
              }}
              options={[
                { value: 'active', label: 'Active' },
                { value: 'revoked', label: 'Revoked' },
                { value: 'all', label: 'All' },
              ]}
            />
          }
        />
        {query.isLoading ? (
          <LoadingPanel />
        ) : grants.length === 0 ? (
          <EmptyState
            icon="grant"
            title="No matching grants"
            description="Approving an access request issues a grant and adds this API's ACL group to the requester's consumer."
          />
        ) : (
          <ul>
            {grants.map((grant) => (
              <li
                key={grant.id}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border px-5 py-3 transition-colors last:border-b-0 hover:bg-surface-hover"
              >
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <Avatar label={grant.user?.display_name ?? grant.user_id} />
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 truncate text-sm font-medium text-fg">
                      <span className="truncate">{grant.user?.display_name ?? grant.user_id}</span>
                      {grant.application ? (
                        <Badge tone="accent">{grant.application.name}</Badge>
                      ) : null}
                    </p>
                    <p className="truncate text-xs text-fg-subtle">
                      Granted {formatDateTime(grant.created_at)}
                      {grant.revoked_at ? ` · revoked ${formatDateTime(grant.revoked_at)}` : ''}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <StatusPill status={grant.status} />
                  {grant.user ? (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      title="Send a message"
                      aria-label={`Message ${grant.user.display_name}`}
                      onClick={() => setMessageTarget(grant)}
                    >
                      <Icon name="message" />
                    </Button>
                  ) : null}
                  {grant.status === 'active' ? (
                    <Button
                      size="sm"
                      variant="ghost"
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
        <AccessPagination
          page={page}
          total={query.data?.total}
          fetching={query.isFetching}
          onPageChange={setPage}
        />
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

      {messageTarget?.user ? (
        <StartThreadDialog
          key={messageTarget.id}
          open
          onOpenChange={(next) => {
            if (!next) setMessageTarget(null);
          }}
          recipientUserId={messageTarget.user.id}
          apiId={apiId}
          defaultSubject="About your access to this API"
          recipientLabel={messageTarget.user.display_name}
        />
      ) : null}
    </>
  );
}

function TestConsumerTab({ api }: { api: Api }): ReactElement {
  const create = useCreateTestConsumer();
  const [label, setLabel] = useState('');
  const [secret, setSecret] = useState<{ secret: ShowOnceSecret; username: string } | null>(null);

  return (
    <>
      <Card className="max-w-2xl">
        <CardHeader
          icon="key"
          title="Test consumer"
          description="Creates a sandbox consumer that already carries this API's ACL group, with a credential of the API's auth type."
        />
        <CardBody className="flex flex-col gap-4">
          <div className="rounded-md border border-border bg-inset px-4 py-3">
            <p className="text-[0.7rem] font-semibold tracking-[0.08em] text-fg-subtle uppercase">
              Consumer username
            </p>
            <code className="mt-1 block font-mono text-xs break-all text-fg">
              {testConsumerUsername(api.id)}
            </code>
          </div>
          <LabeledInput
            label="Label"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            hint="Optional, stored with the credential metadata."
          />
        </CardBody>
        <div className="flex flex-wrap items-center gap-3 border-t border-border bg-inset/40 px-5 py-3.5">
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
          <p className="text-xs text-fg-subtle">The secret is shown once and never stored.</p>
        </div>
      </Card>

      {secret ? (
        <ShowOnceSecretDialog
          open
          secret={secret.secret}
          consumerUsername={secret.username}
          title="Save your test credential"
          onAcknowledge={() => {
            setSecret(null);
            // Drop the plaintext from the mutation result too (issue #336).
            create.reset();
          }}
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
export function UsageDetails({ usage }: { usage: ApiUsageResponse }): ReactElement {
  const { requests, latency_ms: latency, backend } = usage;
  const classes = requests.by_status_class;

  if (!usage.available) {
    return (
      <CardBody>
        <p className="mb-4 text-sm text-fg-muted">
          Gateway metrics are unavailable, so there are no counts to show.{' '}
          {usage.unavailable_reason}
        </p>
        <dl>
          <DetailRow label="Backend">
            <Badge tone={BACKEND_TONES[backend.status]}>{BACKEND_LABELS[backend.status]}</Badge>{' '}
            {backend.detail}
            {backend.since ? (
              <span className="mt-1 block text-xs text-fg-subtle">
                Since {formatDateTime(backend.since)}
              </span>
            ) : null}
          </DetailRow>
        </dl>
      </CardBody>
    );
  }

  return (
    <CardBody>
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
        icon="activity"
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

/**
 * The API's gateway deployment is gone, and only a restore brings it back.
 *
 * Deliberately a page-level banner rather than a tab: every other thing a
 * provider could do here — edit settings, publish a revision, look at grants —
 * is being done to an API that is currently serving nothing, and that is the
 * first thing they need to know. The wording separates the two halves that
 * confused this case before (issue #284): the catalog entry, its history and
 * its approved clients are all intact, and it is only the gateway objects that
 * have to be rebuilt.
 */
function GatewayRepairBanner({ api }: { api: Api }): ReactElement {
  const restore = useRestoreApiGateway();
  const toast = useToast();

  return (
    <Card className="mb-6 border-danger/40">
      <CardBody className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-danger-soft text-danger">
            <Icon name="alert" className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-fg">Gateway deployment missing</h3>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-fg-muted">
              The gateway no longer serves{' '}
              <code className="font-mono text-xs">{api.listen_path}</code>, so requests to this API
              fail. Its catalog entry, specification history and approved clients are untouched —
              restoring rebuilds the proxy, its authentication and its access control from what the
              portal already holds. Clients keep the credentials they were issued.
            </p>
          </div>
        </div>
        <Button
          variant="primary"
          loading={restore.isPending}
          onClick={() =>
            restore.mutate(api.id, {
              onSuccess: () => toast.success('Gateway deployment restored'),
              onError: (error: Error) => toast.error('Restore failed', error.message),
            })
          }
        >
          <Icon name="refresh" />
          Restore gateway deployment
        </Button>
      </CardBody>
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
          tone="danger"
          title="API not found"
          description="It may have been deleted, or you may not own it."
          action={
            <Link to="/apis" className={buttonClassName({ variant: 'secondary' })}>
              <Icon name="arrow-left" />
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
        breadcrumbs={[{ label: 'My APIs', to: '/apis' }, { label: api.name }]}
        title={api.name}
        description={api.description ?? undefined}
        meta={
          <>
            <Badge mono>v{api.version}</Badge>
            <Badge tone="info">{AUTH_PLUGIN_LABELS[api.auth_plugin]}</Badge>
            <StatusPill status={api.status} />
            <Badge
              tone={
                api.visibility === 'public'
                  ? 'neutral'
                  : api.visibility === 'internal'
                    ? 'warning'
                    : 'danger'
              }
            >
              {api.visibility === 'public'
                ? 'Public'
                : api.visibility === 'internal'
                  ? 'Unlisted'
                  : 'Private'}
            </Badge>
            {api.requestable ? <Badge tone="accent">Requestable</Badge> : <Badge>Open</Badge>}
            {api.gateway_state === 'repair_required' ? (
              <Badge tone="danger" dot>
                Not deployed
              </Badge>
            ) : null}
          </>
        }
        actions={
          <Link
            to="/catalog/$slug"
            params={{ slug: api.slug }}
            className={buttonClassName({ variant: 'secondary' })}
          >
            View in catalog
            <Icon name="external" />
          </Link>
        }
      />

      {api.gateway_state === 'repair_required' ? <GatewayRepairBanner api={api} /> : null}

      {/* At a glance: the four values a provider checks without opening a tab. */}
      <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <GlanceTile icon="link" label="Listen path" value={api.listen_path} mono copyable />
        <GlanceTile icon="globe" label="Upstream" value={api.upstream_url ?? 'Not recorded'} mono />
        <GlanceTile
          icon="zap"
          label="Rate limit"
          value={
            api.rate_limit
              ? `${api.rate_limit.limit} / ${api.rate_limit.window_seconds}s`
              : 'Not enforced'
          }
        />
        <GlanceTile icon="inbox" label="Pending requests" value={String(stats.pending_requests)} />
      </div>

      <Tabs
        value={tab}
        onValueChange={setTab}
        tabs={[
          {
            value: 'overview',
            label: 'Overview',
            content: (
              <div className="grid gap-4 xl:grid-cols-2">
                <Card>
                  <CardHeader
                    icon="info"
                    title="Overview"
                    description="What the gateway and the catalog hold for this API."
                  />
                  <CardBody>
                    <dl>
                      <DetailRow label="Invoke URL">
                        {api.invoke_url ? (
                          <code className="font-mono text-xs break-all">{api.invoke_url}</code>
                        ) : (
                          <span className="text-fg-muted">
                            No gateway address configured — an admin sets it in Settings → Gateway.
                          </span>
                        )}
                      </DetailRow>
                      <DetailRow label="Edge proxy id">
                        <code className="font-mono text-xs break-all">
                          {api.ferrum_proxy_id ?? '—'}
                        </code>
                      </DetailRow>
                      <DetailRow label="ACL group">
                        <code className="font-mono text-xs break-all">
                          {aclGroupForApi(api.id)}
                        </code>
                      </DetailRow>
                      <DetailRow label="Active grants">
                        <span className="tabular-nums">{stats.active_grants}</span>
                      </DetailRow>
                      {/* Access requests, not calls — the Usage card below counts the traffic. */}
                      <DetailRow label="Access requests (all time)">
                        <span className="tabular-nums">{stats.total_requests}</span>
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
          { value: 'plugins', label: 'Plugins', content: <PluginsTab api={api} /> },
          { value: 'spec', label: 'Specification', content: <SpecTab api={api} /> },
          {
            value: 'requests',
            label: 'Requests',
            badge:
              stats.pending_requests > 0 ? (
                <Badge tone="warning">{stats.pending_requests}</Badge>
              ) : undefined,
            content: <RequestsTab key={api.id} apiId={api.id} />,
          },
          { value: 'grants', label: 'Grants', content: <GrantsTab key={api.id} apiId={api.id} /> },
          {
            value: 'viewers',
            // Named for what it controls rather than for the visibility mode:
            // the list is kept whatever the API's visibility, and a provider
            // switching to Private should find their earlier invitations here.
            label: 'Viewers',
            badge: api.visibility === 'private' ? <Badge tone="danger">Private</Badge> : undefined,
            content: <ApiViewersTab key={api.id} api={api} />,
          },
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
