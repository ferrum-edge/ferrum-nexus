/**
 * The provider plugin palette for one API: every plugin Nexus offers, grouped
 * by category, each a card the provider can switch on and configure.
 *
 * The palette is a **static catalog** (`PROVIDER_PLUGINS`) the SPA already has,
 * so nothing about the schema is fetched — only the state (`GET
 * /api/apis/:id/plugins`), which says what this API currently has on. Every
 * form is rendered generically from the descriptor by
 * [PluginForm](./PluginForm.tsx); there is no per-plugin component, because
 * Edge's config key sets are closed and a hand-written form would be a second
 * copy of that contract, free to drift.
 */

import { useMemo, useState, type ReactElement } from 'react';
import {
  PLUGIN_CATEGORIES,
  PLUGIN_CATEGORY_LABELS,
  PROVIDER_PLUGINS,
  type Api,
  type ApiPlugin,
  type ApiPluginTrigger,
  type HttpMethod,
  type PluginCategory,
  type ProviderPluginDescriptor,
} from '@ferrum-nexus/shared';
import { useApiPlugins, useRemoveApiPlugin, useSetApiPlugin } from '../../hooks/useApis';
import { useToast } from '../../stores/toast';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card, CardBody, CardHeader } from '../ui/Card';
import { Icon, type IconName } from '../ui/Icon';
import { Checkbox, Field, Input } from '../ui/Input';
import { LoadingPanel } from '../ui/Spinner';
import {
  FORM_ERROR_KEY,
  PluginForm,
  draftFor,
  draftToConfig,
  validateDraft,
  type PluginDraft,
  type PluginFieldDraft,
} from './PluginForm';

/** Methods the trigger editor offers. Matches Edge's `PluginTriggerMatch`. */
const TRIGGER_METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

/**
 * Glyph per palette plugin, so a card is recognisable before its name is read.
 * A plugin with no entry falls back to its category's icon.
 */
const PLUGIN_ICONS: Readonly<Record<string, IconName>> = {
  security_headers: 'shield',
  request_size_limiting: 'download',
  response_size_limiting: 'upload',
  ip_restriction: 'globe',
  bot_detection: 'eye',
  correlation_id: 'link',
  compression: 'zap',
  request_deduplication: 'copy',
  request_termination: 'x',
  response_caching: 'stack',
};

const CATEGORY_ICONS: Readonly<Record<PluginCategory, IconName>> = {
  protection: 'shield',
  traffic: 'activity',
  contract: 'spec',
  experience: 'sparkles',
  transform: 'refresh',
};

function pluginIcon(descriptor: ProviderPluginDescriptor): IconName {
  return PLUGIN_ICONS[descriptor.name] ?? CATEGORY_ICONS[descriptor.category];
}

/**
 * The two conditions the portal exposes from Edge's predicate tree.
 *
 * Edge accepts a full boolean expression over method, path, host, SNI, headers,
 * query, cookies, protocol, source CIDR and identity. A provider reaches for
 * "only these methods" and "only under this path"; anything beyond that is an
 * operator's job in Foundry, and putting a predicate builder in the portal
 * would be exactly the "paste plugin JSON" box the issue rules out.
 */
interface TriggerDraft {
  enabled: boolean;
  methods: HttpMethod[];
  pathPrefix: string;
}

function triggerDraftFrom(trigger: ApiPluginTrigger | null): TriggerDraft {
  return {
    enabled: trigger !== null,
    methods: trigger?.methods ?? [],
    pathPrefix: trigger?.path_prefix ?? '',
  };
}

function triggerFrom(draft: TriggerDraft): ApiPluginTrigger | null {
  if (!draft.enabled) return null;
  const prefix = draft.pathPrefix.trim();
  if (draft.methods.length === 0 && prefix === '') return null;
  return {
    ...(draft.methods.length > 0 ? { methods: draft.methods } : {}),
    ...(prefix === '' ? {} : { path_prefix: prefix }),
  };
}

/** Local mirror of the server's path-prefix rule, so the message is immediate. */
function pathPrefixError(prefix: string): string | null {
  const value = prefix.trim();
  if (value === '') return null;
  if (!value.startsWith('/')) return 'A path prefix must start with /';
  if (/[\s%\\]/.test(value)) {
    return 'No whitespace, percent escapes or backslashes — the gateway compares the canonical path, which never contains them';
  }
  if (value.split('/').some((segment) => segment === '.' || segment === '..')) {
    return 'A path prefix cannot contain a . or .. segment';
  }
  return null;
}

/** One palette plugin: its switch, its form, its trigger and its actions. */
function PluginCard({ api, descriptor, saved }: PluginCardProps): ReactElement {
  const setPlugin = useSetApiPlugin();
  const removePlugin = useRemoveApiPlugin();
  const toast = useToast();

  // Keyed on the saved row in the parent, so a refetch that changes this
  // plugin remounts the card and reloads the draft rather than fighting it.
  const [draft, setDraft] = useState<PluginDraft>(() =>
    draftFor(descriptor, saved?.config ?? null),
  );
  const [enabled, setEnabled] = useState(saved?.enabled ?? true);
  const [trigger, setTrigger] = useState<TriggerDraft>(() =>
    triggerDraftFrom(saved?.trigger ?? null),
  );
  const [open, setOpen] = useState(saved !== null);

  const errors = useMemo(() => validateDraft(descriptor, draft), [descriptor, draft]);
  const triggerError = trigger.enabled ? pathPrefixError(trigger.pathPrefix) : null;
  const emptyTrigger = trigger.enabled && triggerFrom(trigger) === null;
  const invalid = Object.keys(errors).length > 0 || triggerError !== null || emptyTrigger;

  const change = (key: string, value: PluginFieldDraft): void => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const save = (): void => {
    if (invalid) return;
    setPlugin.mutate(
      {
        id: api.id,
        name: descriptor.name,
        body: {
          enabled,
          config: draftToConfig(descriptor, draft),
          trigger: triggerFrom(trigger),
        },
      },
      {
        onSuccess: () => toast.success(`${descriptor.label} saved`),
        onError: (error) => toast.error(`${descriptor.label} was not saved`, error.message),
      },
    );
  };

  const remove = (): void => {
    removePlugin.mutate(
      { id: api.id, name: descriptor.name },
      {
        onSuccess: () => {
          toast.success(`${descriptor.label} removed`);
          setOpen(false);
        },
        onError: (error) => toast.error(`${descriptor.label} was not removed`, error.message),
      },
    );
  };

  const busy = setPlugin.isPending || removePlugin.isPending;

  return (
    <Card className={saved ? 'border-accent/30' : undefined}>
      <div className="flex items-start justify-between gap-4 px-5 py-4">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span
            className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${
              saved ? 'bg-accent-soft text-accent' : 'bg-neutral-soft text-fg-subtle'
            }`}
          >
            <Icon name={pluginIcon(descriptor)} className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="text-sm font-semibold text-fg">{descriptor.label}</h4>
              {saved ? (
                <Badge tone={saved.enabled ? 'success' : 'neutral'} dot>
                  {saved.enabled ? 'On' : 'Paused'}
                </Badge>
              ) : null}
            </div>
            <p className="mt-1 max-w-3xl text-sm leading-relaxed text-fg-muted">
              {descriptor.summary}
            </p>
          </div>
        </div>
        <Button
          size="sm"
          variant={open ? 'ghost' : saved ? 'secondary' : 'outline'}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? 'Close' : saved ? 'Edit' : 'Configure'}
        </Button>
      </div>
      {open ? (
        <CardBody className="flex flex-col gap-4 border-t border-border">
          {descriptor.consumer_recipe ? (
            <p className="flex items-start gap-2 rounded-md border border-border bg-inset px-3 py-2.5 text-xs leading-relaxed text-fg-muted">
              <Icon name="info" className="mt-px h-3.5 w-3.5 shrink-0 text-info" />
              <span>
                <span className="font-medium text-fg">What consumers see: </span>
                {descriptor.consumer_recipe}
              </span>
            </p>
          ) : null}

          <PluginForm
            descriptor={descriptor}
            draft={draft}
            errors={errors}
            onChange={change}
            disabled={busy}
          />

          {descriptor.supports_trigger ? (
            <div className="flex flex-col gap-3 border-t border-border pt-4">
              <Checkbox
                label="Only run on some requests"
                description="Without this, the plugin applies to every call on this API."
                checked={trigger.enabled}
                disabled={busy}
                onChange={(event) =>
                  setTrigger((current) => ({ ...current, enabled: event.target.checked }))
                }
              />
              {trigger.enabled ? (
                <div className="flex flex-col gap-3 pl-6">
                  <Field
                    label="Methods"
                    htmlFor={`${descriptor.name}-methods`}
                    hint="Any, if none are ticked."
                  >
                    <div
                      id={`${descriptor.name}-methods`}
                      className="flex flex-wrap gap-x-5 gap-y-2"
                    >
                      {TRIGGER_METHODS.map((method) => (
                        <Checkbox
                          key={method}
                          label={method}
                          checked={trigger.methods.includes(method)}
                          disabled={busy}
                          onChange={(event) =>
                            setTrigger((current) => ({
                              ...current,
                              methods: event.target.checked
                                ? TRIGGER_METHODS.filter(
                                    (entry) => entry === method || current.methods.includes(entry),
                                  )
                                : current.methods.filter((entry) => entry !== method),
                            }))
                          }
                        />
                      ))}
                    </div>
                  </Field>
                  <Field
                    label="Path prefix"
                    htmlFor={`${descriptor.name}-prefix`}
                    hint={`Matched against the full request path, which starts with ${api.listen_path}.`}
                    {...(triggerError === null ? {} : { error: triggerError })}
                  >
                    <Input
                      id={`${descriptor.name}-prefix`}
                      value={trigger.pathPrefix}
                      placeholder={`${api.listen_path}/invoices`}
                      disabled={busy}
                      invalid={triggerError !== null}
                      onChange={(event) =>
                        setTrigger((current) => ({ ...current, pathPrefix: event.target.value }))
                      }
                    />
                  </Field>
                  {emptyTrigger ? (
                    <p className="text-xs text-danger" role="alert">
                      Choose at least a method or a path prefix, or switch this off.
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="-mx-5 -mb-4 flex flex-wrap items-center gap-x-4 gap-y-3 border-t border-border bg-inset/40 px-5 py-3.5">
            <Button
              variant="primary"
              size="sm"
              onClick={save}
              disabled={invalid}
              loading={setPlugin.isPending}
            >
              {saved ? 'Save' : 'Turn on'}
            </Button>
            {saved ? (
              <>
                <Checkbox
                  label="Active"
                  description="Uncheck to pause the plugin without losing these settings."
                  checked={enabled}
                  disabled={busy}
                  onChange={(event) => setEnabled(event.target.checked)}
                />
                <Button
                  variant="danger"
                  size="sm"
                  className="ml-auto"
                  onClick={remove}
                  loading={removePlugin.isPending}
                >
                  <Icon name="trash" />
                  Remove
                </Button>
              </>
            ) : null}
          </div>
        </CardBody>
      ) : null}
    </Card>
  );
}

interface PluginCardProps {
  api: Api;
  descriptor: ProviderPluginDescriptor;
  saved: ApiPlugin | null;
}

/** Existing caches remain removable after retirement from the offered palette. */
function RetiredCache({ api }: { api: Api }): ReactElement {
  const remove = useRemoveApiPlugin();
  const toast = useToast();
  return (
    <Card className="border-warning/40">
      <CardHeader
        icon="alert"
        title="Response caching (retired)"
        description="Authenticated responses require explicit backend cache permission. This plugin can no longer be enabled from the portal."
      />
      <CardBody>
        <Button
          variant="danger"
          size="sm"
          disabled={remove.isPending}
          onClick={() =>
            remove.mutate(
              { id: api.id, name: 'response_caching' },
              {
                onSuccess: () => toast.success('Response caching removed'),
                onError: (error) => toast.error('Response caching was not removed', error.message),
              },
            )
          }
        >
          Remove response caching
        </Button>
      </CardBody>
    </Card>
  );
}

/** The palette, grouped by category, for one API. */
export function PluginsTab({ api }: { api: Api }): ReactElement {
  const query = useApiPlugins(api.id);

  const configured = useMemo(() => {
    const map = new Map<string, ApiPlugin>();
    for (const plugin of query.data?.plugins ?? []) map.set(plugin.plugin_name, plugin);
    return map;
  }, [query.data]);

  if (query.isLoading) return <LoadingPanel label="Loading plugins…" />;

  const categories = PLUGIN_CATEGORIES.filter((category) =>
    PROVIDER_PLUGINS.some((plugin) => plugin.category === category),
  );

  return (
    <div className="flex flex-col gap-7">
      <p className="flex max-w-3xl items-start gap-2.5 rounded-md border border-border bg-inset/60 px-4 py-3 text-sm leading-relaxed text-fg-muted">
        <Icon name="info" className="mt-0.5 h-4 w-4 shrink-0 text-info" />
        <span>
          Gateway behaviour you can add to this API without leaving the portal. Authentication, the
          access gate, quotas, CORS and OpenAPI enforcement are on the{' '}
          <span className="font-medium text-fg">Settings</span> tab — they are part of what the API
          is, so they have their own controls there.
        </span>
      </p>

      {configured.has('response_caching') ? <RetiredCache api={api} /> : null}

      {categories.map((category) => (
        <section key={category} className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <h3 className="text-[0.7rem] font-semibold tracking-[0.12em] text-fg-subtle uppercase">
              {PLUGIN_CATEGORY_LABELS[category]}
            </h3>
            <span className="h-px flex-1 bg-border" aria-hidden="true" />
          </div>
          {PROVIDER_PLUGINS.filter((plugin) => plugin.category === category).map((descriptor) => {
            const saved = configured.get(descriptor.name) ?? null;
            return (
              <PluginCard
                // Remount when the saved row changes so the draft reloads from
                // the server rather than diverging from it.
                key={`${descriptor.name}:${saved?.updated_at ?? 'none'}`}
                api={api}
                descriptor={descriptor}
                saved={saved}
              />
            );
          })}
        </section>
      ))}
    </div>
  );
}
