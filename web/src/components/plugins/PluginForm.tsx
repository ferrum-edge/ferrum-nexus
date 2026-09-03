/**
 * One palette plugin's settings, rendered generically from its descriptor.
 *
 * There is no per-plugin form component and there should never be one. Ferrum
 * Edge validates each plugin `config` against a closed key set, so the schema
 * has to live in exactly one place — `PROVIDER_PLUGINS` in
 * `@ferrum-nexus/shared` — which the server compiles into zod and this
 * component turns into inputs. A hand-written form per plugin would be a third
 * copy of the same contract, free to drift from both.
 *
 * The component is deliberately **pure and controlled**: it owns no state, does
 * no fetching, and reports a draft plus its validation errors upwards. That is
 * what makes it testable without a router, a query client or a server.
 *
 * ## Drafts are strings, values are typed
 *
 * Every control edits a {@link PluginDraft} — `string | boolean | string[]` per
 * field — because a half-typed number is not a number and a cleared text box is
 * not an empty header value. {@link draftToConfig} is the one place that turns
 * a draft into the JSON body, and {@link validateDraft} the one place that
 * decides whether it may be sent; both mirror the server's rules so the
 * provider sees a field-level message rather than a round trip.
 */

import { useId, type ReactElement } from 'react';
import type { PluginFieldSpec, ProviderPluginDescriptor } from '@ferrum-nexus/shared';
import { Checkbox, Field, Input, Textarea } from '../ui/Input';
import { Select } from '../ui/Select';

/** What one field's control is currently holding. */
export type PluginFieldDraft = string | boolean | string[];

/** The whole form's state, keyed by the descriptor's Edge config keys. */
export type PluginDraft = Record<string, PluginFieldDraft>;

/** Per-field validation messages, keyed the same way, plus a form-level `_`. */
export type PluginDraftErrors = Record<string, string>;

/** Key under which a whole-plugin invariant message is reported. */
export const FORM_ERROR_KEY = '_';

/* ── Draft <-> config ───────────────────────────────────────────────────── */

/** A list field's draft: one entry per line, blanks dropped. */
function linesOf(value: PluginFieldDraft): string[] {
  if (Array.isArray(value)) return value;
  return String(value)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** The draft a saved plugin (or an unconfigured one) starts from. */
export function draftFor(
  descriptor: ProviderPluginDescriptor,
  config: Record<string, unknown> | null,
): PluginDraft {
  const draft: PluginDraft = {};
  for (const field of descriptor.fields) {
    const saved = config?.[field.key];
    switch (field.kind) {
      case 'boolean':
        draft[field.key] = typeof saved === 'boolean' ? saved : (field.default ?? false);
        break;
      case 'integer':
        draft[field.key] =
          typeof saved === 'number'
            ? String(saved)
            : field.default === undefined
              ? ''
              : String(field.default);
        break;
      case 'string':
      case 'enum':
        draft[field.key] = typeof saved === 'string' ? saved : (field.default ?? '');
        break;
      case 'string_list': {
        const values = Array.isArray(saved)
          ? saved.map(String)
          : [...(field.default ?? [])].map(String);
        draft[field.key] = field.options ? values : values.join('\n');
        break;
      }
      case 'integer_list': {
        const values = Array.isArray(saved)
          ? saved.map(String)
          : [...(field.default ?? [])].map(String);
        draft[field.key] = field.options ? values : values.join('\n');
        break;
      }
    }
  }
  return draft;
}

/**
 * Turn a draft into the JSON body.
 *
 * An optional field the provider left empty is **omitted**, never sent as `''`
 * or `[]`: Edge applies its own default for an absent key, while an empty
 * string is a real (empty) header value and an empty list is a real (empty)
 * policy.
 */
export function draftToConfig(
  descriptor: ProviderPluginDescriptor,
  draft: PluginDraft,
): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const field of descriptor.fields) {
    const value = draft[field.key];
    if (value === undefined) continue;
    switch (field.kind) {
      case 'boolean':
        config[field.key] = Boolean(value);
        break;
      case 'integer': {
        const text = String(value).trim();
        if (text === '') break;
        const parsed = Number(text);
        // A non-numeric draft is passed through as the raw string so the
        // server's message names the field rather than silently becoming NaN.
        config[field.key] = Number.isFinite(parsed) ? parsed : text;
        break;
      }
      case 'string':
      case 'enum': {
        const text = String(value).trim();
        if (text === '' && field.required !== true) break;
        config[field.key] = text;
        break;
      }
      case 'string_list': {
        const entries = linesOf(value);
        if (entries.length === 0 && field.required !== true && field.min_entries === undefined) {
          break;
        }
        config[field.key] = entries;
        break;
      }
      case 'integer_list': {
        const entries = linesOf(value);
        if (entries.length === 0 && field.required !== true && field.min_entries === undefined) {
          break;
        }
        config[field.key] = entries.map((entry) => {
          const parsed = Number(entry);
          return Number.isFinite(parsed) ? parsed : entry;
        });
        break;
      }
    }
  }
  return config;
}

/* ── Validation ─────────────────────────────────────────────────────────── */

/** Anchor a descriptor pattern the way the gateway does: `^(?:…)$`. */
function matches(pattern: string, value: string): boolean {
  return new RegExp(`^(?:${pattern})$`).test(value);
}

/** One field's message, or `null` when it is acceptable. */
function fieldError(field: PluginFieldSpec, draft: PluginDraft): string | null {
  const value = draft[field.key];

  if (field.kind === 'integer') {
    const text = String(value ?? '').trim();
    if (text === '') return field.required === true ? 'Required' : null;
    const parsed = Number(text);
    if (!Number.isInteger(parsed)) return 'Enter a whole number';
    if (parsed < field.min || parsed > field.max) {
      return `Must be between ${field.min.toLocaleString()} and ${field.max.toLocaleString()}`;
    }
    return null;
  }

  if (field.kind === 'string') {
    const text = String(value ?? '').trim();
    if (text === '') return field.required === true ? 'Required' : null;
    if (text.length > field.max_length) return `At most ${field.max_length} characters`;
    if (field.pattern !== undefined && !matches(field.pattern, text)) {
      return 'This value contains characters the gateway does not accept';
    }
    return null;
  }

  if (field.kind === 'string_list' || field.kind === 'integer_list') {
    const entries = linesOf(value ?? '');
    if (entries.length === 0) {
      return field.required === true || (field.min_entries ?? 0) > 0 ? 'Add at least one' : null;
    }
    if (entries.length > field.max_entries) return `At most ${field.max_entries} entries`;
    if ((field.min_entries ?? 0) > entries.length) {
      return `Add at least ${String(field.min_entries)}`;
    }
    if (field.kind === 'integer_list') {
      for (const entry of entries) {
        const parsed = Number(entry);
        if (!Number.isInteger(parsed) || parsed < field.item_min || parsed > field.item_max) {
          return `Every entry must be a whole number between ${String(field.item_min)} and ${String(field.item_max)}`;
        }
      }
      return null;
    }
    if (field.options === undefined && field.item_pattern !== undefined) {
      const bad = entries.find((entry) => !matches(field.item_pattern ?? '', entry));
      if (bad !== undefined) return `“${bad}” is not in a form the gateway accepts`;
    }
    return null;
  }

  return null;
}

/**
 * Every message for a draft: one per field, plus the whole-plugin invariants
 * under {@link FORM_ERROR_KEY}.
 *
 * The two invariants mirrored here are the two Edge itself enforces beyond its
 * key sets, so the provider is told before the save rather than after it.
 */
export function validateDraft(
  descriptor: ProviderPluginDescriptor,
  draft: PluginDraft,
): PluginDraftErrors {
  const errors: PluginDraftErrors = {};
  for (const field of descriptor.fields) {
    const message = fieldError(field, draft);
    if (message !== null) errors[field.key] = message;
  }

  if (descriptor.name === 'ip_restriction') {
    const allow = linesOf(draft.allow ?? '');
    const deny = linesOf(draft.deny ?? '');
    if (allow.length === 0 && deny.length === 0) {
      errors[FORM_ERROR_KEY] =
        'List at least one allowed or denied address — a restriction with both lists empty would restrict nobody.';
    }
  }
  if (descriptor.name === 'bot_detection') {
    const blocked = linesOf(draft.blocked_patterns ?? '');
    if (blocked.length === 0 && draft.allow_missing_user_agent !== false) {
      errors[FORM_ERROR_KEY] =
        'With no blocked patterns, requests with no User-Agent must be rejected — otherwise this filter blocks nothing.';
    }
  }
  return errors;
}

/* ── The form ───────────────────────────────────────────────────────────── */

export interface PluginFormProps {
  descriptor: ProviderPluginDescriptor;
  draft: PluginDraft;
  errors: PluginDraftErrors;
  onChange: (key: string, value: PluginFieldDraft) => void;
  disabled?: boolean;
}

/** A multi-select rendered as checkboxes, for a list field with a closed set. */
function OptionList({
  field,
  selected,
  onChange,
  disabled,
}: {
  field: Extract<PluginFieldSpec, { kind: 'string_list' | 'integer_list' }>;
  selected: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}): ReactElement {
  const options = (field.options ?? []).map((option) => ({
    value: String(option.value),
    label: option.label,
  }));
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-2">
      {options.map((option) => (
        <Checkbox
          key={option.value}
          label={option.label}
          checked={selected.includes(option.value)}
          disabled={disabled}
          onChange={(event) =>
            onChange(
              event.target.checked
                ? // Keep the descriptor's order rather than click order: it is
                  // the server preference order for `compression.algorithms`.
                  options
                    .map((entry) => entry.value)
                    .filter((value) => value === option.value || selected.includes(value))
                : selected.filter((value) => value !== option.value),
            )
          }
        />
      ))}
    </div>
  );
}

/** One descriptor field as a labelled control. */
function PluginField({
  field,
  draft,
  error,
  onChange,
  disabled,
}: {
  field: PluginFieldSpec;
  draft: PluginDraft;
  error: string | undefined;
  onChange: (key: string, value: PluginFieldDraft) => void;
  disabled?: boolean;
}): ReactElement {
  const id = useId();
  const value = draft[field.key];

  if (field.kind === 'boolean') {
    return (
      <Checkbox
        id={id}
        label={field.label}
        {...(field.help === undefined ? {} : { description: field.help })}
        checked={value === true}
        disabled={disabled}
        onChange={(event) => onChange(field.key, event.target.checked)}
      />
    );
  }

  if (field.kind === 'enum') {
    return (
      <Field
        label={field.label}
        htmlFor={id}
        {...(field.help === undefined ? {} : { hint: field.help })}
        {...(error === undefined ? {} : { error })}
      >
        <Select
          id={id}
          aria-label={field.label}
          value={String(value ?? '')}
          disabled={disabled}
          options={field.options.map((option) => ({ value: option.value, label: option.label }))}
          onValueChange={(next) => onChange(field.key, next)}
        />
      </Field>
    );
  }

  if ((field.kind === 'string_list' || field.kind === 'integer_list') && field.options) {
    return (
      <Field
        label={field.label}
        htmlFor={id}
        {...(field.help === undefined ? {} : { hint: field.help })}
        {...(error === undefined ? {} : { error })}
      >
        <OptionList
          field={field}
          selected={Array.isArray(value) ? value : []}
          {...(disabled === undefined ? {} : { disabled })}
          onChange={(next) => onChange(field.key, next)}
        />
      </Field>
    );
  }

  if (field.kind === 'string_list' || field.kind === 'integer_list') {
    return (
      <Field
        label={field.label}
        htmlFor={id}
        {...(field.help === undefined ? {} : { hint: field.help })}
        {...(error === undefined ? {} : { error })}
      >
        <Textarea
          id={id}
          rows={3}
          mono
          disabled={disabled}
          invalid={error !== undefined}
          value={Array.isArray(value) ? value.join('\n') : String(value ?? '')}
          onChange={(event) => onChange(field.key, event.target.value)}
        />
      </Field>
    );
  }

  const hint =
    field.kind === 'integer' && field.unit !== undefined
      ? `${field.help === undefined ? '' : `${field.help} `}In ${field.unit}.`
      : field.help;
  return (
    <Field
      label={field.label}
      htmlFor={id}
      {...(hint === undefined ? {} : { hint })}
      {...(error === undefined ? {} : { error })}
      required={field.required === true}
    >
      <Input
        id={id}
        type={field.kind === 'integer' ? 'number' : 'text'}
        inputMode={field.kind === 'integer' ? 'numeric' : undefined}
        {...(field.kind === 'integer' ? { min: field.min, max: field.max } : {})}
        {...(field.kind === 'string' && field.placeholder !== undefined
          ? { placeholder: field.placeholder }
          : {})}
        disabled={disabled}
        invalid={error !== undefined}
        value={String(value ?? '')}
        onChange={(event) => onChange(field.key, event.target.value)}
      />
    </Field>
  );
}

/** Every field of one palette plugin, plus its whole-plugin message. */
export function PluginForm({
  descriptor,
  draft,
  errors,
  onChange,
  disabled,
}: PluginFormProps): ReactElement {
  return (
    <div className="flex flex-col gap-4">
      {errors[FORM_ERROR_KEY] ? (
        <p className="text-xs text-danger" role="alert">
          {errors[FORM_ERROR_KEY]}
        </p>
      ) : null}
      {descriptor.fields.map((field) => (
        <PluginField
          key={field.key}
          field={field}
          draft={draft}
          error={errors[field.key]}
          onChange={onChange}
          {...(disabled === undefined ? {} : { disabled })}
        />
      ))}
    </div>
  );
}
