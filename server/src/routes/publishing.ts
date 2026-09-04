/**
 * `/api/apis` — the provider's own view of what they publish.
 *
 * The whole plugin requires at least `provider`; ownership is checked one level
 * down, in the publishing service, because "owner **or** admin" is a rule about
 * a specific row rather than about the route.
 *
 * Spec uploads arrive as a JSON string field rather than a multipart file: the
 * SPA reads the file client-side and the documents are small, so a single JSON
 * body keeps the CSRF story and the error shape identical to every other route.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import {
  AUTH_PLUGIN_TYPES,
  DEFAULT_SPEC_ENFORCEMENT,
  HTTP_METHODS,
  MAX_BACKEND_TIMEOUT_MS,
  MAX_CORS_ORIGINS,
  MAX_RATE_LIMIT_REQUESTS,
  MAX_RATE_LIMIT_WINDOW_SECONDS,
  MAX_SPEC_BYTES,
  SPEC_ENFORCEMENT_LEVELS,
  type ApiUsageResponse,
  MIN_BACKEND_TIMEOUT_MS,
  type CorsConfig,
  type CreateTestConsumerResponse,
  type DeleteApiPluginResponse,
  type DeleteApiResponse,
  type GetApiResponse,
  type ListApiPluginsResponse,
  type ListApisResponse,
  type PublishApiResponse,
  type SetApiPluginResponse,
  type UpdateApiResponse,
  type UpdateApiSpecResponse,
} from '@ferrum-nexus/shared';

import { clientIp, requireAuth, requireRole } from '../middleware/auth-plugin.js';
import { userOrIpKey } from '../middleware/rate-limit-keys.js';
import { parseOrThrow } from '../middleware/error-handler.js';
import { parsePluginConfig, pluginTriggerSchema } from '../plugins/schema.js';
import type { ApiPluginsService } from '../plugins/service.js';
import type { PublishingService } from '../publishing/service.js';
import type { UsageService } from '../usage/service.js';
import {
  booleanQuerySchema,
  idParamSchema,
  listOptions,
  listQuerySchema,
  toBoolean,
} from './common.js';

/** Services this route plugin needs. */
export interface PublishingRoutesOptions {
  publishing: PublishingService;
  usage: UsageService;
  apiPlugins: ApiPluginsService;
}

/** Character ceiling on an uploaded document; the byte check lives in `oas.ts`. */
const specField = z.string().min(1).max(MAX_SPEC_BYTES);

/**
 * The route config every **mutating** route here shares.
 *
 * Each of them costs several Ferrum Edge round trips, and a publish or a spec
 * replace also stores a document of up to `MAX_SPEC_BYTES`. None of it was
 * bounded before (GHSA-g32g-g9q4-q5wr): a self-registered provider could hold
 * the publishing endpoints open in a loop until the gateway or the database ran
 * out. 30 a minute is an order of magnitude above what the SPA produces — one
 * request per form save — and an order of magnitude below what a script needs
 * to matter.
 *
 * Keyed **per account** ({@link userOrIpKey}), not per IP. Behind a session the
 * account is the thing worth bounding: an IP bucket punishes a whole office
 * behind one NAT and lets a single account multiply its allowance by rotating
 * source addresses. The generator falls back to the IP for a request with no
 * session, which on this scope only happens if the role guard is ever relaxed.
 *
 * The limiter is only installed when `config.rateLimitEnabled` — the composition
 * root registers `@fastify/rate-limit` on this scope with `global: false`, so
 * without it these configs are inert and the reads stay unlimited either way.
 * The quota in `publishing/service.ts` is the other half: this bounds the
 * *rate*, the quota bounds the *total*.
 */
const MUTATION_RATE_LIMIT = {
  rateLimit: { max: 30, timeWindow: '1 minute', keyGenerator: userOrIpKey },
} as const;

const rateLimitSchema = z
  .object({
    limit: z.number().int().min(1).max(MAX_RATE_LIMIT_REQUESTS),
    window_seconds: z.number().int().min(1).max(MAX_RATE_LIMIT_WINDOW_SECONDS),
  })
  .nullable();

/**
 * Browser CORS policy.
 *
 * An origin is a single token — `https://app.example.com`, or `*` — so any
 * internal whitespace means the provider pasted a comma- or newline-separated
 * list into one entry, which Edge would happily store and then never match.
 * Rejecting it here is a clearer failure than a silently dead policy.
 *
 * An *empty* origin list is rejected rather than accepted as "no CORS": that is
 * what `null` means, and the two are different plugin states on the gateway.
 */
const corsSchema = z.object({
  allowed_origins: z
    .array(z.string().trim().min(1).max(255).regex(/^\S+$/, 'An origin cannot contain whitespace'))
    .min(1)
    .max(MAX_CORS_ORIGINS),
  allow_credentials: z.boolean().optional(),
});

/**
 * Apply the `allow_credentials` default and collapse "absent" onto `null`.
 *
 * The default lives here rather than as `z.boolean().default(false)` because a
 * zod default makes a schema's input and output types differ, which
 * {@link parseOrThrow}'s single-type signature cannot express.
 */
function corsOrNull(value: z.infer<typeof corsSchema> | null | undefined): CorsConfig | null {
  if (value === undefined || value === null) return null;
  return {
    allowed_origins: value.allowed_origins,
    allow_credentials: value.allow_credentials ?? false,
  };
}

/**
 * Methods the gateway will accept, as the provider chose them.
 *
 * Deduplicated because Edge stores the list verbatim and a repeated entry is
 * noise the portal would then show back; the order the provider sent is kept
 * so the round trip is stable. An *empty* list is rejected rather than read as
 * "all methods" — that is what `null` means, and a proxy whose
 * `allowed_methods` is `[]` accepts nothing at all.
 */
const allowedMethodsSchema = z
  .array(z.enum(HTTP_METHODS))
  .min(1)
  .max(HTTP_METHODS.length)
  .transform((methods) => [...new Set(methods)]);

/**
 * Backend timeouts, in milliseconds.
 *
 * All three are required together: `PUT /proxies/{id}` is a whole-resource
 * replace, so a half-supplied set would silently reset the omitted ones to
 * Edge's defaults rather than leave them alone. `null` is the way to ask for
 * the defaults explicitly.
 */
const timeoutMs = z.number().int().min(MIN_BACKEND_TIMEOUT_MS).max(MAX_BACKEND_TIMEOUT_MS);
const timeoutsSchema = z.object({
  connect_ms: timeoutMs,
  read_ms: timeoutMs,
  write_ms: timeoutMs,
});

const listApisQuery = listQuerySchema.extend({
  mine: booleanQuerySchema,
  owner_user_id: z.string().trim().min(1).max(64).optional(),
  status: z.enum(['published', 'retired']).optional(),
  q: z.string().trim().max(200).optional(),
});

const publishBody = z.object({
  name: z.string().trim().min(1).max(200),
  slug: z.string().trim().max(60).optional(),
  description: z.string().trim().max(4_000).nullish(),
  version: z.string().trim().max(60).optional(),
  // Optional here even though the shared DTO marks it required: a document with
  // an absolute `servers[0].url` already names its upstream, and demanding the
  // provider retype it is friction with no safety benefit.
  upstream_url: z.string().trim().max(2_000).optional(),
  spec: specField,
  auth_plugin: z.enum(AUTH_PLUGIN_TYPES),
  requestable: z.boolean(),
  visibility: z.enum(['public', 'internal']),
  rate_limit: rateLimitSchema.optional(),
  cors: corsSchema.nullish(),
  allowed_methods: allowedMethodsSchema.nullish(),
  timeouts: timeoutsSchema.nullish(),
  circuit_breaker: z.boolean().optional(),
  spec_enforcement: z.enum(SPEC_ENFORCEMENT_LEVELS).optional(),
});

const updateBody = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(4_000).nullish(),
  version: z.string().trim().max(60).optional(),
  upstream_url: z.string().trim().max(2_000).optional(),
  auth_plugin: z.enum(AUTH_PLUGIN_TYPES).optional(),
  requestable: z.boolean().optional(),
  visibility: z.enum(['public', 'internal']).optional(),
  rate_limit: rateLimitSchema.optional(),
  cors: corsSchema.nullish(),
  allowed_methods: allowedMethodsSchema.nullish(),
  timeouts: timeoutsSchema.nullish(),
  circuit_breaker: z.boolean().optional(),
  // `undefined` leaves the level — and therefore the validator plugin — alone.
  spec_enforcement: z.enum(SPEC_ENFORCEMENT_LEVELS).optional(),
  status: z.enum(['published', 'retired']).optional(),
});

const specBody = z.object({
  spec: specField,
  version: z.string().trim().max(60).optional(),
});

const testConsumerBody = z.object({ label: z.string().trim().max(120).nullish() });

/**
 * The palette route's params.
 *
 * `name` is only shape-checked here — whether it is a plugin at all, and which
 * one, is the service's `descriptorFor`, so an unknown name is a `404` and a
 * name Nexus manages from a first-class field is a `400` that says which field.
 */
const pluginParamsSchema = z.object({
  id: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(64),
});

/**
 * The outer envelope of a palette save. `config` is deliberately `unknown`
 * here: its schema is built from the plugin's descriptor once the name has
 * resolved, so the closed key set is checked against the right plugin rather
 * than against a union of all of them.
 */
const pluginBody = z.object({
  enabled: z.boolean().optional(),
  config: z.unknown(),
  trigger: pluginTriggerSchema.nullish(),
});

/** `/api/apis` route plugin. */
export const publishingRoutes: FastifyPluginAsync<PublishingRoutesOptions> = async (
  app,
  options,
) => {
  const { publishing, usage, apiPlugins } = options;
  app.addHook('onRequest', requireRole('provider'));

  app.get('/', async (request): Promise<ListApisResponse> => {
    const { user } = requireAuth(request);
    const query = parseOrThrow(listApisQuery, request.query);
    const mine = toBoolean(query.mine);
    return publishing.list(
      user,
      {
        ...(mine !== undefined ? { mine } : {}),
        ...(query.owner_user_id !== undefined ? { owner_user_id: query.owner_user_id } : {}),
        ...(query.status !== undefined ? { status: query.status } : {}),
        ...(query.q !== undefined ? { q: query.q } : {}),
      },
      listOptions(query),
    );
  });

  app.post(
    '/',
    { config: MUTATION_RATE_LIMIT },
    async (request, reply): Promise<PublishApiResponse> => {
      const { user } = requireAuth(request);
      const input = parseOrThrow(publishBody, request.body);
      const result = await publishing.publish(
        user,
        {
          ...input,
          slug: input.slug ?? '',
          version: input.version ?? '',
          upstream_url: input.upstream_url ?? '',
          description: input.description ?? null,
          rate_limit: input.rate_limit ?? null,
          cors: corsOrNull(input.cors),
          allowed_methods: input.allowed_methods ?? null,
          timeouts: input.timeouts ?? null,
          circuit_breaker: input.circuit_breaker ?? false,
          spec_enforcement: input.spec_enforcement ?? DEFAULT_SPEC_ENFORCEMENT,
        },
        clientIp(request),
      );
      reply.status(201);
      return result;
    },
  );

  app.get('/:id', async (request): Promise<GetApiResponse> => {
    const { user } = requireAuth(request);
    const { id } = parseOrThrow(idParamSchema, request.params);
    return publishing.get(user, id);
  });

  /**
   * Read-only gateway telemetry for one API. Owner or admin, like every other
   * provider-side read of the row.
   *
   * This answers `200` even when the gateway is unreachable — the body then
   * carries `available: false`. A provider's overview page must not break
   * because Edge is restarting.
   */
  app.get(
    '/:id/usage',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request): Promise<ApiUsageResponse> => {
      const { user } = requireAuth(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      return usage.forApi(user, id);
    },
  );

  app.patch(
    '/:id',
    { config: MUTATION_RATE_LIMIT },
    async (request): Promise<UpdateApiResponse> => {
      const { user } = requireAuth(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const patch = parseOrThrow(updateBody, request.body);
      // `undefined` means "leave the setting alone"; `null` means "remove it" —
      // for the proxy fields, "back to the gateway default".
      const body = {
        ...patch,
        cors: patch.cors === undefined ? undefined : corsOrNull(patch.cors),
      };
      return { api: await publishing.update(user, id, body, clientIp(request)) };
    },
  );

  app.delete(
    '/:id',
    { config: MUTATION_RATE_LIMIT },
    async (request): Promise<DeleteApiResponse> => {
      const { user } = requireAuth(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      await publishing.remove(user, id, clientIp(request));
      return { ok: true };
    },
  );

  app.put(
    '/:id/spec',
    { config: MUTATION_RATE_LIMIT },
    async (request): Promise<UpdateApiSpecResponse> => {
      const { user } = requireAuth(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const body = parseOrThrow(specBody, request.body);
      return publishing.updateSpec(user, id, body.spec, body.version, clientIp(request));
    },
  );

  /* ── Plugin palette ───────────────────────────────────────────────────
   *
   * The palette itself (which plugins exist, and what each one accepts) is the
   * static `PROVIDER_PLUGINS` catalog in `@ferrum-nexus/shared`, which the SPA
   * already has — so these routes carry only *state*: what this API currently
   * has switched on.
   */

  app.get('/:id/plugins', async (request): Promise<ListApiPluginsResponse> => {
    const { user } = requireAuth(request);
    const { id } = parseOrThrow(idParamSchema, request.params);
    return { plugins: await apiPlugins.list(user, id) };
  });

  app.put(
    '/:id/plugins/:name',
    { config: MUTATION_RATE_LIMIT },
    async (request): Promise<SetApiPluginResponse> => {
      const { user } = requireAuth(request);
      const { id, name } = parseOrThrow(pluginParamsSchema, request.params);
      const body = parseOrThrow(pluginBody, request.body ?? {});
      // Resolve the plugin first: an unknown name must not be reported as a
      // config problem, and the descriptor is what the config is validated
      // against.
      const descriptor = apiPlugins.descriptorFor(name);
      const plugin = await apiPlugins.set(
        user,
        id,
        descriptor.name,
        {
          enabled: body.enabled ?? true,
          config: parsePluginConfig(descriptor, body.config),
          trigger: body.trigger ?? null,
        },
        clientIp(request),
      );
      return { plugin };
    },
  );

  app.delete(
    '/:id/plugins/:name',
    { config: MUTATION_RATE_LIMIT },
    async (request): Promise<DeleteApiPluginResponse> => {
      const { user } = requireAuth(request);
      const { id, name } = parseOrThrow(pluginParamsSchema, request.params);
      await apiPlugins.remove(user, id, name, clientIp(request));
      return { ok: true };
    },
  );

  app.post(
    '/:id/test-consumer',
    { config: MUTATION_RATE_LIMIT },
    async (request, reply): Promise<CreateTestConsumerResponse> => {
      const { user } = requireAuth(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const body = parseOrThrow(testConsumerBody, request.body ?? {});
      const result = await publishing.createTestConsumer(
        user,
        id,
        body.label ?? null,
        clientIp(request),
      );
      reply.status(201);
      return result;
    },
  );
};
