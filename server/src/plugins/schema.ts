/**
 * Turn a palette descriptor into the validator for its `config` body.
 *
 * There is deliberately **no hand-written schema per plugin**. Ferrum Edge
 * validates every plugin config against a closed key set, so the one thing that
 * must never drift is "which keys does this plugin take, and within what
 * bounds" — and that already lives in `PROVIDER_PLUGINS`
 * (`shared/src/plugins.ts`), where the SPA reads it to render the form. This
 * module compiles the same descriptor into zod so the server rejects exactly
 * what the gateway would, before any gateway write happens.
 *
 * Three rules make the compiled schema faithful to Edge:
 *
 * - **`.strict()`** — an unknown key is a `VALIDATION_FAILED` here rather than
 *   a `400 EDGE_ERROR` half-way through attaching the plugin.
 * - **Absent means absent.** An optional field the provider left alone is
 *   omitted from the body entirely, so Edge applies its own default rather than
 *   having a Nexus-chosen value frozen into the config.
 * - **An empty optional string is an omission**, not an empty header value:
 *   clearing the Content-Security-Policy box must send no CSP at all, not
 *   `Content-Security-Policy: `.
 *
 * Per-plugin invariants Edge enforces beyond the key set — `ip_restriction`
 * needing a non-empty list, `bot_detection` refusing a no-op config,
 * `correlation_id` refusing a reserved header name — are applied on top as
 * refinements, for the same reason: a clear field-level message beats a gateway
 * rejection.
 */

import { z } from 'zod';

import {
  CORRELATION_ID_RESERVED_HEADERS,
  MAX_PLUGIN_TRIGGER_PATH_LENGTH,
  type ApiPluginTrigger,
  type PluginFieldSpec,
  type ProviderPluginDescriptor,
} from '@ferrum-nexus/shared';

import { validationFailed } from '../lib/errors.js';

/** Anchor a descriptor's pattern the way Edge anchors its own: `^(?:…)$`. */
function anchored(pattern: string): RegExp {
  return new RegExp(`^(?:${pattern})$`);
}

/** Sentinel an optional string field collapses to when the provider clears it. */
const OMITTED = Symbol('omitted');

/** The zod type for one field, before optionality is applied. */
function baseSchema(field: PluginFieldSpec): z.ZodTypeAny {
  switch (field.kind) {
    case 'boolean':
      return z.boolean();

    case 'integer':
      return z
        .number()
        .int(`${field.key} must be a whole number`)
        .min(field.min, `${field.key} must be at least ${field.min}`)
        .max(field.max, `${field.key} must be at most ${field.max}`);

    case 'string': {
      let schema = z.string().max(field.max_length);
      if (field.pattern !== undefined) {
        schema = schema.regex(anchored(field.pattern), `${field.key} has an unaccepted value`);
      }
      return schema;
    }

    case 'enum': {
      const values = field.options.map((option) => option.value);
      return z.string().refine((value) => values.includes(value), {
        message: `${field.key} must be one of: ${values.join(', ')}`,
      });
    }

    case 'string_list': {
      let item = z.string().max(field.item_max_length ?? 1_024);
      if (field.options !== undefined) {
        const values = field.options.map((option) => option.value);
        return z
          .array(
            z.string().refine((value) => values.includes(value), {
              message: `${field.key} entries must be one of: ${values.join(', ')}`,
            }),
          )
          .min(field.min_entries ?? 0)
          .max(field.max_entries);
      }
      if (field.item_pattern !== undefined) {
        item = item.regex(anchored(field.item_pattern), `${field.key} has an unaccepted entry`);
      }
      return z
        .array(item)
        .min(field.min_entries ?? 0)
        .max(field.max_entries);
    }

    case 'integer_list': {
      const item = z
        .number()
        .int(`${field.key} entries must be whole numbers`)
        .min(field.item_min)
        .max(field.item_max);
      const values = field.options?.map((option) => option.value);
      const bounded =
        values === undefined
          ? item
          : item.refine((value) => values.includes(value), {
              message: `${field.key} entries must be one of: ${values.join(', ')}`,
            });
      return z
        .array(bounded)
        .min(field.min_entries ?? 0)
        .max(field.max_entries);
    }
  }
}

/**
 * Build the `config` validator for one palette plugin.
 *
 * The parsed output carries only the keys the caller actually sent — the ones
 * the descriptor declares — with empty optional strings dropped. That object is
 * what reaches Edge verbatim.
 */
export function buildPluginConfigSchema(
  descriptor: ProviderPluginDescriptor,
): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of descriptor.fields) {
    const base = baseSchema(field);
    if (field.required === true) {
      shape[field.key] = base;
      continue;
    }
    // An optional string the provider cleared is an omission, not an empty
    // value: `content_security_policy: ''` would make Edge emit an empty CSP
    // header rather than none at all.
    shape[field.key] =
      field.kind === 'string'
        ? base
            .optional()
            .transform((value) => (value === '' ? (OMITTED as unknown as string) : value))
        : base.optional();
  }

  const object = z
    .object(shape)
    .strict()
    .transform((parsed) =>
      Object.fromEntries(
        Object.entries(parsed).filter(
          ([, value]) => value !== undefined && (value as unknown) !== OMITTED,
        ),
      ),
    );

  const invariant = PLUGIN_INVARIANTS[descriptor.name];
  if (!invariant) return object as unknown as z.ZodType<Record<string, unknown>>;
  return object.superRefine((config, ctx) => {
    const problem = invariant(config);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
  }) as unknown as z.ZodType<Record<string, unknown>>;
}

/**
 * Admission rules Edge applies **beyond** its key set, for the plugins in the
 * palette that have one. Each returns a message, or `null` when the config is
 * acceptable.
 *
 * Everything here mirrors a documented gateway rejection; nothing here is a
 * portal-invented policy.
 */
const PLUGIN_INVARIANTS: Readonly<
  Record<string, (config: Record<string, unknown>) => string | null>
> = {
  /**
   * `IpRestrictionConfig` requires at least one of `allow`/`deny` to be
   * non-empty (`anyOf` in the schema): a config that lists neither restricts
   * nobody and Edge refuses it rather than installing a no-op.
   */
  ip_restriction: (config) => {
    const allow = asArray(config.allow);
    const deny = asArray(config.deny);
    if (allow.length === 0 && deny.length === 0) {
      return 'List at least one allowed or denied address — an IP restriction with both lists empty would restrict nobody';
    }
    return null;
  },

  /**
   * `BotDetectionConfig` refuses a no-op: an empty `blocked_patterns` is only
   * valid when `allow_missing_user_agent: false` creates a reject path. An
   * allow list on its own enforces nothing.
   */
  bot_detection: (config) => {
    const blocked = asArray(config.blocked_patterns);
    const explicitlyEmpty = Array.isArray(config.blocked_patterns) && blocked.length === 0;
    if (explicitlyEmpty && config.allow_missing_user_agent !== false) {
      return 'With no blocked User-Agent patterns, requests with no User-Agent must be rejected — otherwise the filter blocks nothing';
    }
    return null;
  },

  /**
   * `CorrelationIdConfig.header_name` may not be a protocol, forwarding,
   * tracing or credential header: Edge owns those, and letting a provider
   * overwrite `authorization` or `x-forwarded-for` would be a security hole
   * rather than a naming choice.
   */
  correlation_id: (config) => {
    const header = typeof config.header_name === 'string' ? config.header_name.trim() : '';
    if (header !== '' && CORRELATION_ID_RESERVED_HEADERS.includes(header.toLowerCase())) {
      return `The gateway owns '${header}' and rejects it as a correlation header; choose a name of your own, such as x-request-id`;
    }
    return null;
  },
};

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/* ── Triggers ───────────────────────────────────────────────────────────── */

/**
 * A path prefix Edge can actually match.
 *
 * The predicate compares the **canonical policy path**, which is produced by
 * rejecting every percent escape, backslash and dot segment at the frontend
 * boundary. A prefix containing any of those can therefore never match a
 * request, so it is refused here rather than silently never firing.
 */
const pathPrefixSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_PLUGIN_TRIGGER_PATH_LENGTH)
  .refine((value) => value.startsWith('/'), { message: 'A path prefix must start with /' })
  .refine((value) => !/[\s%\\]/.test(value), {
    message:
      'A path prefix cannot contain whitespace, a percent escape or a backslash — the gateway ' +
      'compares the canonical request path, which never contains them',
  })
  .refine((value) => !value.split('/').some((segment) => segment === '.' || segment === '..'), {
    message: 'A path prefix cannot contain a . or .. segment',
  });

/**
 * The portal's trigger shape: "only these methods" and/or "only under this
 * path". At least one has to be present — an empty trigger has no meaning
 * beyond "always", which is what leaving it off already says.
 */
export const pluginTriggerSchema: z.ZodType<ApiPluginTrigger> = z
  .object({
    methods: z
      .array(
        z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT']),
      )
      .min(1)
      .max(9)
      .optional(),
    path_prefix: pathPrefixSchema.optional(),
  })
  .strict()
  .refine((trigger) => trigger.methods !== undefined || trigger.path_prefix !== undefined, {
    message: 'A trigger needs at least a method list or a path prefix',
  })
  .transform((trigger) => ({
    ...(trigger.methods === undefined ? {} : { methods: [...new Set(trigger.methods)] }),
    ...(trigger.path_prefix === undefined ? {} : { path_prefix: trigger.path_prefix }),
  }));

/**
 * Validate a `config` body against a descriptor, raising the portal's own
 * `VALIDATION_FAILED` rather than a raw `ZodError`.
 *
 * Kept here rather than in the route so the service can be called directly (in
 * tests, or from a future import path) without losing the check.
 */
export function parsePluginConfig(
  descriptor: ProviderPluginDescriptor,
  config: unknown,
): Record<string, unknown> {
  const result = buildPluginConfigSchema(descriptor).safeParse(config ?? {});
  if (result.success) return result.data;
  throw validationFailed(
    `The ${descriptor.label} configuration is not valid`,
    result.error.issues.map((issue) => ({
      path: [descriptor.name, ...issue.path.map(String)].join('.'),
      code: issue.code,
      message: issue.message,
    })),
  );
}
