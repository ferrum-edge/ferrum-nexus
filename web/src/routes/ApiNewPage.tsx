import { useNavigate } from '@tanstack/react-router';
import { useMemo, useState, type FormEvent, type ReactElement } from 'react';
import {
  AUTH_PLUGIN_LABELS,
  AUTH_PLUGIN_TYPES,
  HTTP_METHODS,
  MAX_CORS_ORIGINS,
  MAX_RATE_LIMIT_REQUESTS,
  type ApiVisibility,
  type AuthPluginType,
  type CorsConfig,
  type HttpMethod,
  type RateLimitConfig,
  type SpecEnforcementLevel,
} from '@ferrum-nexus/shared';
import { parseCorsOrigins, slugify } from '../lib/format';
import { usePublishApi } from '../hooks/useApis';
import { useToast } from '../stores/toast';
import { RoleGuard } from '../components/layout/RoleGuard';
import { declaredMethods } from '../components/openapi/parse';
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
  const [methods, setMethods] = useState<HttpMethod[]>([]);
  const [timeouts, setTimeouts] = useState<TimeoutDraft>(EMPTY_TIMEOUT_DRAFT);
  const [circuitBreaker, setCircuitBreaker] = useState(false);
  const [specEnforcement, setSpecEnforcement] = useState<SpecEnforcementLevel>('docs_only');
  const [spec, setSpec] = useState('');
  const [error, setError] = useState<string | null>(null);

  const effectiveSlug = slugTouched ? slug : slugify(name);
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
      origins.length > 0 ? { allowed_origins: origins, allow_credentials: corsCredentials } : null;

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
        upstream_url: upstreamUrl.trim(),
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
    <form className="flex flex-col gap-6" onSubmit={submit}>
      <Card>
        <CardHeader
          title="Identity"
          description="How the API appears in the catalog and on the gateway."
        />
        <CardBody className="grid gap-4 md:grid-cols-2">
          <LabeledInput
            label="Name"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <LabeledInput
            label="Slug"
            required
            value={effectiveSlug}
            onChange={(event) => {
              setSlugTouched(true);
              setSlug(slugify(event.target.value));
            }}
            hint="Used for the gateway listen path."
          />
          <LabeledInput
            label="Version"
            required
            value={version}
            onChange={(event) => setVersion(event.target.value)}
          />
          <LabeledInput
            label="Upstream URL"
            type="url"
            required
            placeholder="https://api.internal.example.com"
            value={upstreamUrl}
            onChange={(event) => setUpstreamUrl(event.target.value)}
            hint="Where the gateway forwards matching requests."
          />
          <LabeledTextarea
            className="md:col-span-2"
            label="Description"
            rows={3}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Runtime policy"
          description="Applied as Ferrum Edge plugins on the proxy created for this API."
        />
        <CardBody className="grid gap-4 md:grid-cols-2">
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
              { value: 'public', label: 'Public', description: 'Visible to every portal user.' },
              {
                value: 'internal',
                label: 'Internal',
                description: 'Visible to providers and admins only.',
              },
            ]}
          />
          <div className="md:col-span-2">
            <Checkbox
              label="Require an approved access request"
              description="Attaches the access_control plugin, allowing only the API's approved ACL group."
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
                options={WINDOW_OPTIONS.map((option) => ({ ...option }))}
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
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Advanced"
          description="Settings written onto the gateway proxy itself rather than as a plugin."
        />
        <CardBody>
          <AdvancedProxySettings
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

      <Card>
        <CardHeader
          title="Specification"
          description="Parsed locally before upload; the server validates it again."
        />
        <CardBody className="flex flex-col gap-4">
          <SpecEnforcementSelect value={specEnforcement} onValueChange={setSpecEnforcement} />
          <SpecEditor value={spec} onChange={setSpec} />
        </CardBody>
      </Card>

      {error ? (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <Button
          type="submit"
          variant="primary"
          size="lg"
          loading={publish.isPending}
          disabled={!name.trim() || !effectiveSlug || !upstreamUrl.trim() || !spec.trim()}
        >
          Publish API
        </Button>
        <Button variant="ghost" onClick={() => void navigate({ to: '/apis' })}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** Provider flow that creates an API and its Edge proxy. */
export function ApiNewPage(): ReactElement {
  return (
    <RoleGuard minRole="provider">
      <PageHeader
        title="Publish an API"
        description="Creates a gateway proxy from your OpenAPI document and attaches the auth, access-control and rate-limit plugins."
      />
      <PublishForm />
    </RoleGuard>
  );
}
