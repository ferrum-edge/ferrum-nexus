import { useNavigate } from '@tanstack/react-router';
import { useId, useMemo, useState, type FormEvent, type ReactElement, type ReactNode } from 'react';
import {
  AUTH_PLUGIN_LABELS,
  AUTH_PLUGIN_TYPES,
  HTTP_METHODS,
  MAX_API_SLUG_LENGTH,
  MAX_CORS_ORIGINS,
  MAX_RATE_LIMIT_REQUESTS,
  MAX_UPSTREAM_URL_LENGTH,
  firstUsableSpecServerUrl,
  isValidApiSlug,
  parseAbsoluteHttpUrl,
  slugify,
  type ApiVisibility,
  type AuthPluginType,
  type CorsConfig,
  type HttpMethod,
  type RateLimitConfig,
  type SpecEnforcementLevel,
} from '@ferrum-nexus/shared';
import { parseCorsOrigins } from '../lib/format';
import { usePublishApi } from '../hooks/useApis';
import { useToast } from '../stores/toast';
import { RoleGuard } from '../components/layout/RoleGuard';
import { FormNotice } from '../components/auth/AuthShell';
import { declaredMethods, parseSpecText } from '../components/openapi/parse';
import {
  AdvancedProxySettings,
  EMPTY_TIMEOUT_DRAFT,
  parseTimeoutDraft,
  type TimeoutDraft,
} from '../components/publishing/AdvancedProxySettings';
import { SpecEditor, isSpecValid } from '../components/publishing/SpecEditor';
import { SpecEnforcementSelect } from '../components/publishing/SpecEnforcementSelect';
import { Button } from '../components/ui/Button';
import { Card, CardBody, CardHeader, PageHeader } from '../components/ui/Card';
import { Icon } from '../components/ui/Icon';
import { Checkbox, LabeledInput, LabeledTextarea } from '../components/ui/Input';
import { LabeledSelect } from '../components/ui/Select';

/** Rate-limit window presets, mapped onto the shared `window_seconds` field. */
const WINDOW_OPTIONS = [
  { value: '1', label: 'per second' },
  { value: '60', label: 'per minute' },
  { value: '3600', label: 'per hour' },
] as const;

/** Hint under the CORS origins box; the empty case is the one worth spelling out. */
const CORS_ORIGINS_HINT =
  `One origin per line, up to ${MAX_CORS_ORIGINS}, e.g. https://app.example.com. ` +
  'Leave it empty and the gateway adds no CORS headers at all, so a browser can ' +
  'only call this API from its own origin.';

/**
 * A folded group of fields inside a settings card.
 *
 * The children stay mounted while closed — this sits inside a form, so folding
 * a section away must not discard what is typed in it.
 */
function Disclosure({
  title,
  summary,
  defaultOpen = false,
  children,
}: {
  title: string;
  summary: string;
  defaultOpen?: boolean;
  children: ReactNode;
}): ReactElement {
  const panelId = useId();
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-md border border-border bg-inset/40">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-3 rounded-md px-4 py-3 text-left transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent-ring focus-visible:outline-none"
      >
        <Icon
          name="chevron-right"
          className={`text-fg-subtle transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-fg">{title}</span>
          <span className="block truncate text-xs text-fg-subtle">{summary}</span>
        </span>
      </button>
      <div id={panelId} className={open ? 'border-t border-border px-4 py-4' : 'hidden'}>
        {children}
      </div>
    </div>
  );
}

function PublishForm(): ReactElement {
  const navigate = useNavigate();
  const publish = usePublishApi();
  const toast = useToast();

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [version, setVersion] = useState('1.0.0');
  const [upstreamUrl, setUpstreamUrl] = useState('');
  const [authPlugin, setAuthPlugin] = useState<AuthPluginType>('key_auth');
  const [visibility, setVisibility] = useState<ApiVisibility>('public');
  const [requestable, setRequestable] = useState(true);
  const [rateLimitEnabled, setRateLimitEnabled] = useState(false);
  const [rateLimitValue, setRateLimitValue] = useState('100');
  const [rateLimitWindow, setRateLimitWindow] = useState<string>('60');
  const [corsOrigins, setCorsOrigins] = useState('');
  const [corsCredentials, setCorsCredentials] = useState(false);
  const [corsWebsocketOrigins, setCorsWebsocketOrigins] = useState(true);
  const [corsHeaders, setCorsHeaders] = useState('');
  const [methods, setMethods] = useState<HttpMethod[]>([]);
  const [timeouts, setTimeouts] = useState<TimeoutDraft>(EMPTY_TIMEOUT_DRAFT);
  const [circuitBreaker, setCircuitBreaker] = useState(false);
  const [specEnforcement, setSpecEnforcement] = useState<SpecEnforcementLevel>('docs_only');
  const [spec, setSpec] = useState('');
  const [error, setError] = useState<string | null>(null);

  const effectiveSlug = slugTouched ? slug : slugify(name);
  const slugError =
    effectiveSlug === ''
      ? name.trim() || slugTouched
        ? 'Enter a slug using lowercase letters and numbers.'
        : null
      : !isValidApiSlug(effectiveSlug)
        ? `Use at most ${MAX_API_SLUG_LENGTH} lowercase letters, numbers and single hyphens.`
        : null;
  const specServer = useMemo(() => {
    const parsed = parseSpecText(spec);
    return parsed.ok
      ? firstUsableSpecServerUrl(parsed.spec.doc.servers)
      : { url: null, oversizedField: null };
  }, [spec]);
  const explicitUpstream = upstreamUrl.trim();
  const upstreamError = specServer.oversizedField
    ? `${specServer.oversizedField} exceeds the ${MAX_UPSTREAM_URL_LENGTH}-character limit.`
    : explicitUpstream &&
        (explicitUpstream.length > MAX_UPSTREAM_URL_LENGTH ||
          !parseAbsoluteHttpUrl(explicitUpstream))
      ? `Enter an absolute http:// or https:// URL of at most ${MAX_UPSTREAM_URL_LENGTH} characters.`
      : spec.trim() && !explicitUpstream && !specServer.url
        ? 'Enter an upstream URL; this document has no usable absolute server URL.'
        : null;
  // The document is right here, so the method list it declares is the obvious
  // starting point for the allow-list — issue #36's "default with an override".
  const specMethods = useMemo<HttpMethod[]>(() => {
    const declared = declaredMethods(spec);
    return HTTP_METHODS.filter((method) => declared.includes(method));
  }, [spec]);

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setError(null);
    if (!isSpecValid(spec)) {
      setError('The OpenAPI document could not be parsed. Fix it before publishing.');
      return;
    }
    if (slugError || upstreamError || !isValidApiSlug(effectiveSlug)) return;
    const parsedLimit = Number.parseInt(rateLimitValue, 10);
    if (
      rateLimitEnabled &&
      (!Number.isFinite(parsedLimit) || parsedLimit < 1 || parsedLimit > MAX_RATE_LIMIT_REQUESTS)
    ) {
      setError(
        `The request limit must be a whole number between 1 and ${MAX_RATE_LIMIT_REQUESTS.toLocaleString()} — the gateway rejects anything higher.`,
      );
      return;
    }
    const rateLimit: RateLimitConfig | null = rateLimitEnabled
      ? { limit: parsedLimit, window_seconds: Number.parseInt(rateLimitWindow, 10) }
      : null;

    const origins = parseCorsOrigins(corsOrigins);
    if (origins.length > MAX_CORS_ORIGINS) {
      setError(`A CORS policy may list at most ${MAX_CORS_ORIGINS} origins.`);
      return;
    }
    // No origins means no `cors` plugin at all, which is not the same as an
    // empty allow-list: the gateway simply adds no CORS headers.
    const cors: CorsConfig | null =
      origins.length > 0
        ? {
            allowed_origins: origins,
            allow_credentials: corsCredentials,
            allowed_headers: parseCorsOrigins(corsHeaders),
            enforce_websocket_origins: corsWebsocketOrigins,
          }
        : null;

    const parsedTimeouts = parseTimeoutDraft(timeouts);
    if (typeof parsedTimeouts === 'string') {
      setError(parsedTimeouts);
      return;
    }

    publish.mutate(
      {
        name: name.trim(),
        slug: effectiveSlug,
        description: description.trim() || null,
        version: version.trim(),
        ...(explicitUpstream ? { upstream_url: explicitUpstream } : {}),
        spec,
        auth_plugin: authPlugin,
        requestable,
        visibility,
        rate_limit: rateLimit,
        cors,
        // No selection means "every method", which is the absence of a list.
        allowed_methods: methods.length > 0 ? methods : null,
        timeouts: parsedTimeouts,
        circuit_breaker: circuitBreaker,
        spec_enforcement: specEnforcement,
      },
      {
        onSuccess: (response) => {
          toast.success('API published', `${response.api.name} is now on the gateway.`);
          void navigate({ to: '/apis/$apiId', params: { apiId: response.api.id } });
        },
      },
    );
  };

  return (
    <form
      className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_23rem] xl:grid-cols-[minmax(0,1fr)_26rem]"
      onSubmit={submit}
    >
      {/* The document is what the provider came here with: it leads. */}
      <div className="flex min-w-0 flex-col gap-6">
        <Card>
          <CardHeader
            icon="spec"
            title="OpenAPI document"
            description="Parsed locally before upload; the server validates it again."
          />
          <CardBody className="flex flex-col gap-5">
            <SpecEditor value={spec} onChange={setSpec} />
            <div className="border-t border-border pt-5">
              <SpecEnforcementSelect
                className="max-w-xl"
                value={specEnforcement}
                onValueChange={setSpecEnforcement}
              />
            </div>
          </CardBody>
        </Card>
      </div>

      {/* The settings rail: it scrolls on its own beside the document, with the
          publish action pinned to the bottom of the rail so it is never
          hidden behind the rail's own scroll. */}
      {/* The rail flows with the page: a sticky column that scrolls inside
          itself hides half the form at ordinary viewport heights. */}
      <aside className="flex min-w-0 flex-col gap-5">
        <div className="flex min-h-0 flex-col gap-5">
          <Card>
            <CardHeader
              icon="catalog"
              title="Identity"
              description="How the API appears in the catalog and on the gateway."
            />
            <CardBody className="flex flex-col gap-4">
              <LabeledInput
                label="Name"
                required
                placeholder="Billing API"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <LabeledInput
                  label="Slug"
                  required
                  maxLength={MAX_API_SLUG_LENGTH}
                  value={effectiveSlug}
                  onChange={(event) => {
                    setSlugTouched(true);
                    setSlug(event.target.value);
                  }}
                  hint="Used in the listen path."
                  error={slugError}
                />
                <LabeledInput
                  label="Version"
                  required
                  value={version}
                  onChange={(event) => setVersion(event.target.value)}
                />
              </div>
              <LabeledTextarea
                label="Description"
                rows={3}
                placeholder="One or two lines for the catalog card."
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              icon="shield"
              title="Access"
              description="Who may call this API, and how they prove it."
            />
            <CardBody className="flex flex-col gap-4">
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
                  {
                    value: 'public',
                    label: 'Public',
                    description: 'Listed in the catalog and readable by every signed-in user.',
                  },
                  {
                    value: 'internal',
                    label: 'Internal (unlisted)',
                    // The old wording here said "providers and admins only",
                    // which is not what `internal` does and never was: it is
                    // unlisted, and anyone with the link can read the docs.
                    // Saying otherwise is how somebody picks it for a
                    // confidential API (issue #288).
                    description:
                      'Hidden from the catalog listing, but any signed-in user with the link ' +
                      'can still read it. Not a secret — choose Private for that.',
                  },
                  {
                    value: 'private',
                    label: 'Private',
                    description:
                      'Only you, administrators, approved clients and people you authorize can ' +
                      'find or read it. Authorizing someone lets them read the documentation; ' +
                      'it does not let them call the API.',
                  },
                ]}
              />
              <Checkbox
                label="Require an approved access request"
                description="Attaches the access_control plugin, allowing only the API's approved ACL group."
                checked={requestable}
                onChange={(event) => setRequestable(event.target.checked)}
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              icon="zap"
              title="Runtime"
              description="Applied as Ferrum Edge plugins and proxy settings."
            />
            <CardBody className="flex flex-col gap-4">
              <LabeledInput
                label="Upstream URL"
                type="url"
                maxLength={MAX_UPSTREAM_URL_LENGTH}
                placeholder="https://api.internal.example.com"
                value={upstreamUrl}
                onChange={(event) => setUpstreamUrl(event.target.value)}
                hint={
                  specServer.url
                    ? `OpenAPI server URL: ${specServer.url}. Leave this field empty to use it.`
                    : 'No usable absolute server URL in the document; enter one here.'
                }
                error={upstreamError}
              />
              <Checkbox
                label="Enforce a rate limit"
                checked={rateLimitEnabled}
                onChange={(event) => setRateLimitEnabled(event.target.checked)}
              />
              {rateLimitEnabled ? (
                <div className="grid gap-4 sm:grid-cols-2">
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
                    options={WINDOW_OPTIONS.map((option) => ({ ...option }))}
                  />
                </div>
              ) : null}

              <Disclosure
                title="Browser access (CORS)"
                summary={
                  parseCorsOrigins(corsOrigins).length === 0
                    ? 'No CORS headers — same-origin callers only'
                    : `${parseCorsOrigins(corsOrigins).length} allowed origin(s)`
                }
              >
                <div className="flex flex-col gap-4">
                  <LabeledTextarea
                    label="CORS allowed origins"
                    rows={3}
                    placeholder={'https://app.example.com\nhttps://admin.example.com'}
                    value={corsOrigins}
                    onChange={(event) => setCorsOrigins(event.target.value)}
                    hint={CORS_ORIGINS_HINT}
                  />
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
              </Disclosure>

              <AdvancedProxySettings
                collapsible
                methods={methods}
                onMethodsChange={setMethods}
                timeouts={timeouts}
                onTimeoutsChange={setTimeouts}
                circuitBreaker={circuitBreaker}
                onCircuitBreakerChange={setCircuitBreaker}
                specMethods={specMethods}
              />
            </CardBody>
          </Card>
        </div>

        <Card className="shrink-0">
          <CardBody className="flex flex-col gap-4">
            {error ? <FormNotice tone="danger">{error}</FormNotice> : null}
            <p className="text-xs leading-relaxed text-fg-subtle">
              Publishing creates the gateway proxy, attaches the authentication and access-control
              plugins, and lists the API in the catalog. Every setting here can be changed
              afterwards.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="submit"
                variant="primary"
                loading={publish.isPending}
                disabled={!name.trim() || !!slugError || !!upstreamError || !spec.trim()}
              >
                Publish API
              </Button>
              <Button variant="ghost" onClick={() => void navigate({ to: '/apis' })}>
                Cancel
              </Button>
            </div>
          </CardBody>
        </Card>
      </aside>
    </form>
  );
}

/** Provider flow that creates an API and its Edge proxy. */
export function ApiNewPage(): ReactElement {
  return (
    <RoleGuard minRole="provider">
      <PageHeader
        breadcrumbs={[{ label: 'My APIs', to: '/apis' }, { label: 'Publish an API' }]}
        title="Publish an API"
        description="Creates a gateway proxy from your OpenAPI document and attaches the auth, access-control and rate-limit plugins."
      />
      <PublishForm />
    </RoleGuard>
  );
}
