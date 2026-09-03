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
  type ProviderPluginDescriptor,
} from '@ferrum-nexus/shared';
import { useApiPlugins, useRemoveApiPlugin, useSetApiPlugin } from '../../hooks/useApis';
import { useToast } from '../../stores/toast';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card, CardBody, CardHeader } from '../ui/Card';
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
    <Card>
      <CardHeader
        title={descriptor.label}
        description={descriptor.summary}
        actions={
          <div className="flex items-center gap-2">
            {saved ? (
              <Badge tone={saved.enabled ? 'success' : 'neutral'}>
                {saved.enabled ? 'On' : 'Paused'}
              </Badge>
            ) : null}
            <Button size="sm" variant="ghost" onClick={() => setOpen((value) => !value)}>
              {open ? 'Close' : saved ? 'Edit' : 'Configure'}
            </Button>
          </div>
        }
      />
      {open ? (
        <CardBody className="flex flex-col gap-4">
          {descriptor.consumer_recipe ? (
            <p className="rounded-md border border-border bg-inset px-3 py-2 text-xs text-fg-muted">
              <span className="font-medium text-fg">What consumers see: </span>
              {descriptor.consumer_recipe}
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

          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
            <Button
              variant="primary"
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
                  className="ml-auto"
                  onClick={remove}
                  loading={removePlugin.isPending}
                >
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
    <div className="flex flex-col gap-6">
      <p className="text-sm text-fg-muted">
        Gateway behaviour you can add to this API without leaving the portal. Authentication, the
        access gate, quotas, CORS and OpenAPI enforcement are on the{' '}
        <span className="font-medium text-fg">Settings</span> tab — they are part of what the API
        is, so they have their own controls there.
      </p>

      {categories.map((category) => (
        <section key={category} className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold tracking-wide text-fg-muted uppercase">
            {PLUGIN_CATEGORY_LABELS[category]}
          </h3>
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
