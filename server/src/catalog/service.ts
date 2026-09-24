/**
 * The catalog — what a signed-in user is allowed to *see*.
 *
 * ## Two different questions, two different answers
 *
 * "Does this appear when I browse?" and "may I open this link?" are not the
 * same question, and conflating them is what makes portal permission models go
 * wrong. Nexus answers them separately:
 *
 * **Browse** (`GET /api/catalog`) — {@link CatalogService.canList}
 *
 * | API state              | signed out | unrelated client | viewer | grantee | owner | admin |
 * |------------------------|------------|------------------|--------|---------|-------|-------|
 * | `published` `public`   | **no**     | yes              | yes    | yes     | yes   | yes   |
 * | `published` `internal` | **no**     | **no**           | yes    | yes     | yes   | yes   |
 * | `published` `private`  | **no**     | **no**           | yes    | yes     | yes   | yes   |
 * | `retired`              | **no**     | **no**           | yes    | yes     | yes   | yes   |
 *
 * **Open** (`GET /api/catalog/:slug` and `…/spec`) — {@link CatalogService.canView}
 *
 * | API state              | signed out | unrelated client | viewer | grantee | owner | admin |
 * |------------------------|------------|------------------|--------|---------|-------|-------|
 * | `published` `public`   | **no**     | yes              | yes    | yes     | yes   | yes   |
 * | `published` `internal` | **no**     | **yes**          | yes    | yes     | yes   | yes   |
 * | `published` `private`  | **no**     | **no**           | yes    | yes     | yes   | yes   |
 * | `retired`              | **no**     | **no**           | yes    | yes     | yes   | yes   |
 *
 * "Signed out" is not a column the checks below implement — every catalog
 * route requires a session — but it belongs in the matrix, because the whole
 * point of `private` is the question "who can read this?" and "nobody who is
 * not signed in" is half the answer.
 *
 * "Viewer" is an `api_viewers` row: somebody the provider explicitly
 * authorized to read this API's documentation. It is **not** a grant. It
 * confers no ACL group, touches no consumer and reaches no gateway — an
 * authorized viewer can read the docs and, if the API is `requestable`, ask
 * for access through the ordinary flow like anyone else.
 *
 * The reasoning behind each deliberate cell:
 *
 * - **`internal` means unlisted, not secret**, and still does. It keeps an API
 *   out of the general browse view so the catalog stays a curated shop window,
 *   while still letting a provider hand somebody a link and have them read the
 *   docs and raise an access request. Adding `private` did not change it: the
 *   two are separate values precisely so that existing `internal` APIs keep
 *   the semantics they were published under (issue #288).
 * - **`private` is the permission-enforced one.** Neither listed nor openable
 *   unless the viewer is on one of the lists above — guessing or being handed
 *   a slug is not enough, and an unauthorized account gets `404`, not `403`,
 *   so the endpoint does not confirm that the slug names anything.
 * - **`retired` stops circulating.** Retirement is the provider saying "stop
 *   onboarding onto this". It leaves the proxy and every existing grant alone —
 *   integrations already in production must not break — but the documentation
 *   stops being served to people who are not already using it.
 *
 * **None of this is data-plane authorization.** What stops an unapproved caller
 * reaching the API is the `access_control` plugin and its ACL group on the
 * gateway. Hiding documentation is not enforcement, and a `private` API with
 * no access control in front of it is still callable by anyone who knows the
 * URL. The two are deliberately separate permissions.
 *
 * The normalized spec follows the detail page's visibility exactly: there is no separate
 * "documentation" permission, because a catalog entry whose documentation you
 * cannot read is not a catalog entry, it is a teaser.
 */

import { stringify as stringifyYaml } from 'yaml';

import {
  clampPageSize,
  roleAtLeast,
  type AccessRequest,
  type ApiSpecSummary,
  type ApiVisibility,
  type ApplicationSummary,
  type CatalogAccessState,
  type CatalogApi,
  type CatalogDetailResponse,
  type CatalogIdentityAccessResponse,
  type CatalogSpecResponse,
  type Grant,
  type Paginated,
  type UserSummary,
  type Uuid,
} from '@ferrum-nexus/shared';

import type {
  ApiFilter,
  ApiRecord,
  ApiViewerFilter,
  ListOptions,
  NexusStore,
  UserRecord,
} from '../db/store.js';
import { notFound, specInvalid } from '../lib/errors.js';
import { LruCache } from '../lib/lru-cache.js';
import { parseOpenApiSpec, type ParsedSpec } from '../publishing/oas.js';
import { canListApi, canViewApi, resolveReadAccess, type ApiReadAccess } from './read-access.js';
import { presentApi, type GatewayUrlSource } from '../publishing/present.js';
import { rewriteSpecServers } from '../publishing/spec-document.js';

/** Filters accepted by {@link CatalogService.list}. */
export interface CatalogFilter {
  q?: string;
  requestable?: boolean;
  visibility?: ApiVisibility;
  owner_user_id?: Uuid;
}

/** Read-only catalog operations. */
export interface CatalogService {
  /** A page of APIs the caller may see, with their access state attached. */
  list(
    viewer: UserRecord,
    filter?: CatalogFilter,
    options?: ListOptions,
  ): Promise<Paginated<CatalogApi>>;
  /** One API by slug, with the caller's open request and active grant. */
  detail(viewer: UserRecord, slug: string): Promise<CatalogDetailResponse>;
  /**
   * One of the caller's identities' standing on an API: its newest request
   * and its active grant. `applicationId` `null` is the account itself;
   * anything else must be one of the caller's **own** applications.
   */
  identityAccess(
    viewer: UserRecord,
    slug: string,
    applicationId: Uuid | null,
  ): Promise<CatalogIdentityAccessResponse>;
  /** The normalized current spec with gateway servers, when the caller may see the API. */
  spec(viewer: UserRecord, slug: string): Promise<CatalogSpecResponse>;
  /** Whether `api` appears in `viewer`'s browse list. */
  canList(viewer: UserRecord, api: ApiRecord, access: ApiReadAccess): boolean;
  /** Whether `viewer` may open `api`'s detail page and read its spec. */
  canView(viewer: UserRecord, api: ApiRecord, access: ApiReadAccess): boolean;
}

/**
 * One normalized catalog document: what `GET /api/catalog/:slug/spec` serves
 * for a revision at one server address. `null` records a stored document the
 * parser refused, so a corrupt revision is not re-parsed on every request
 * either.
 */
export type CatalogSpecRendering = { raw_spec: string; content_type: string } | null;

/** Most normalized documents {@link createCatalogService} keeps by default. */
export const CATALOG_SPEC_CACHE_MAX_ENTRIES = 64;

/** Largest total size, in UTF-8 bytes, of the documents it keeps by default. */
export const CATALOG_SPEC_CACHE_MAX_BYTES = 32 * 1024 * 1024;

/** Dependencies of {@link createCatalogService}. */
export interface CatalogServiceDeps {
  store: NexusStore;
  /** Resolves the gateway origin each row's `invoke_url` is built from. */
  settings: GatewayUrlSource;
  /**
   * Cache of normalized documents, keyed by revision and server address.
   * Defaults to one bounded by {@link CATALOG_SPEC_CACHE_MAX_ENTRIES} and
   * {@link CATALOG_SPEC_CACHE_MAX_BYTES}; tests pass their own to observe it.
   */
  specCache?: LruCache<CatalogSpecRendering>;
}

/** The cache {@link createCatalogService} builds when it is not handed one. */
function defaultSpecCache(): LruCache<CatalogSpecRendering> {
  return new LruCache<CatalogSpecRendering>({
    maxEntries: CATALOG_SPEC_CACHE_MAX_ENTRIES,
    maxBytes: CATALOG_SPEC_CACHE_MAX_BYTES,
  });
}

/** Build the catalog service. */
export function createCatalogService(deps: CatalogServiceDeps): CatalogService {
  const { store, settings } = deps;
  const specCache = deps.specCache ?? defaultSpecCache();

  /**
   * Parse, rewrite and re-serialise one revision for one server address.
   *
   * A spec that passes validation can be ~2 MB, which costs hundreds of
   * milliseconds of synchronous parse and stringify — on the event loop, for
   * every signed-in account that opens the page (issue #343). Revision rows
   * are immutable — a spec replace or a rollback makes a *different* row
   * current — and the parser is a pure function of the stored text, so the
   * output is fully determined by the revision id and the address the
   * servers are rewritten to. The address is itself derived from the gateway
   * origin and the API's listen path (namespace and slug), so all three are
   * in the key by construction: an operator changing the origin, or a slug
   * change, is a miss rather than a stale document.
   *
   * Nothing about the *viewer* is in the key, and nothing needs to be: the
   * document is the same for everyone allowed to read it, and this is only
   * ever reached after {@link CatalogService.canView} has said yes. The cache
   * answers "what does this revision look like", never "may you see it".
   *
   * Check, compute and store happen with no `await` in between, so a burst of
   * requests for one uncached document parses it once: the first one fills
   * the entry before any other resumes.
   */
  function renderSpec(revisionId: Uuid, rawSpec: string, serverUrl: string): CatalogSpecRendering {
    const key = `${revisionId}\n${serverUrl}`;
    const cached = specCache.get(key);
    if (cached !== undefined) return cached;

    let parsed: ParsedSpec;
    try {
      parsed = parseOpenApiSpec(rawSpec);
    } catch {
      specCache.set(key, null, key.length);
      return null;
    }
    const document = rewriteSpecServers(parsed.document, serverUrl, 'catalog');
    const rendering = {
      raw_spec:
        parsed.contentType === 'application/json'
          ? JSON.stringify(document, null, 2)
          : stringifyYaml(document),
      content_type: parsed.contentType,
    };
    specCache.set(key, rendering, key.length + Buffer.byteLength(rendering.raw_spec));
    return rendering;
  }

  // The rule is evaluated in `read-access.ts`, shared with the access and
  // messaging services, so that every surface that can reveal an API answers
  // "may this account read it?" the same way.
  const canList = canListApi;
  const canView = canViewApi;

  /** The caller's relationship to an API, for the catalog badge. */
  function accessState(
    viewer: UserRecord,
    api: ApiRecord,
    grant: Grant | null,
    request: AccessRequest | null,
  ): CatalogAccessState {
    if (api.owner_user_id === viewer.id) return 'owner';
    if (grant && grant.status === 'active') return 'granted';
    if (request) {
      switch (request.status) {
        case 'pending':
          return 'pending';
        case 'denied':
          return 'denied';
        case 'revoked':
          return 'revoked';
        default:
          break;
      }
    }
    // Approval is not required: any portal account may call it. Returning
    // `none` here made both catalog views render "No access".
    if (!api.requestable) return 'open';
    return 'none';
  }

  function summary(owner: UserRecord | undefined): UserSummary | null {
    return owner
      ? {
          id: owner.id,
          email: owner.email,
          display_name: owner.display_name,
          role: owner.role,
        }
      : null;
  }

  /** Strip provider-only operational fields before an API crosses the catalog boundary. */
  function catalogApi(
    viewer: UserRecord,
    api: ApiRecord,
    owner: UserRecord | undefined,
    grant: Grant | null,
    request: AccessRequest | null,
    gatewayUrl: string | null,
  ): CatalogApi {
    // The catalog is what *consumers* see: the invoke URL is theirs to know,
    // the provider's backend address is not.
    const { upstream_url: _upstreamUrl, ...publicApi } = presentApi(api, gatewayUrl);
    return {
      ...publicApi,
      owner: summary(owner),
      access_state: accessState(viewer, api, grant, request),
    };
  }

  return {
    canList,
    canView,

    async list(viewer, filter = {}, options): Promise<Paginated<CatalogApi>> {
      // The caller's grants are needed either way — they decide the access
      // badge on every row — so handing their ids to the query costs nothing.
      const grants = new Map(
        (await store.grants.listActiveByUser(viewer.id)).map((grant) => [grant.api_id, grant]),
      );

      // `canList` as a query predicate, so the caller's offset/limit reach the
      // database instead of slicing an already-truncated scan. Filtering in
      // memory after one bounded read made every row past the first page
      // unreachable and reported the truncated remainder as `total`.
      //
      // An admin sees every row, so no clause is added at all; everyone else
      // gets "mine, or granted to me, or published and public" — the exact
      // three branches `canList` tests, with `retired` excluded for outsiders
      // because the status half of the openly-listed disjunct fails it.
      // APIs whose documentation this account was explicitly authorized to
      // read. Fetched alongside the grants, and for the same reason: both
      // become bounded id lists in the query, because the predicate has to run
      // in the database or pagination describes a truncated scan.
      const authorized = roleAtLeast(viewer.role, 'admin')
        ? []
        : await store.apiViewers.listApiIdsByUser(viewer.id);

      const visibleTo: ApiViewerFilter | undefined = roleAtLeast(viewer.role, 'admin')
        ? undefined
        : {
            owner_user_id: viewer.id,
            granted_api_ids: [...grants.keys()],
            authorized_api_ids: authorized,
            open_status: 'published',
            // `public` only. `internal` is unlisted by design and `private` is
            // not visible to anyone who is not on one of the lists above, so
            // neither belongs in the openly-listed disjunct.
            open_visibilities: ['public'],
          };

      const storeFilter: ApiFilter = {
        ...(filter.q !== undefined ? { q: filter.q } : {}),
        ...(filter.requestable !== undefined ? { requestable: filter.requestable } : {}),
        ...(filter.visibility !== undefined ? { visibility: filter.visibility } : {}),
        ...(filter.owner_user_id !== undefined ? { owner_user_id: filter.owner_user_id } : {}),
        ...(visibleTo ? { visible_to: visibleTo } : {}),
      };

      const limit = clampPageSize(options?.limit);
      const offset = Math.max(0, options?.offset ?? 0);
      const found = await store.apis.list(storeFilter, { limit, offset });
      const page = found.items;

      const owners = new Map(
        (await store.users.findManyByIds([...new Set(page.map((api) => api.owner_user_id))])).map(
          (user) => [user.id, user],
        ),
      );
      const requests = new Map(
        (
          await store.accessRequests.listLatestForUser(
            viewer.id,
            page.map((api) => api.id),
          )
        ).map((request) => [request.api_id, request]),
      );

      // One resolve for the whole page, not one per row.
      const gatewayUrl = await settings.getGatewayPublicUrl();

      return {
        items: page.map((api) =>
          catalogApi(
            viewer,
            api,
            owners.get(api.owner_user_id),
            grants.get(api.id) ?? null,
            requests.get(api.id) ?? null,
            gatewayUrl,
          ),
        ),
        total: found.total,
      };
    },

    async detail(viewer, slug): Promise<CatalogDetailResponse> {
      const api = await store.apis.findBySlug(slug);
      // An API the caller may not see is reported as absent rather than
      // forbidden, so the catalog does not leak the existence of internal APIs.
      if (!api) throw notFound('API', slug);

      const access = await resolveReadAccess(store, viewer, api);
      if (!canView(viewer, api, access)) throw notFound('API', slug);
      // The grant that admits them — the account's own when it has one, else
      // an application's — is the one the detail reports.
      const { grant } = access;

      const [specRecord, owner, request] = await Promise.all([
        store.apiSpecs.findCurrentByApi(api.id),
        store.users.findById(api.owner_user_id),
        store.accessRequests.findLatestByApiAndUser(api.id, viewer.id),
      ]);

      const spec: ApiSpecSummary | null = specRecord
        ? (({ raw_spec: _raw, revision_seq: _seq, ...rest }) => rest)(specRecord)
        : null;

      return {
        api: catalogApi(
          viewer,
          api,
          owner ?? undefined,
          grant,
          request,
          await settings.getGatewayPublicUrl(),
        ),
        spec,
        my_request: request,
        my_grant: grant,
      };
    },

    async identityAccess(viewer, slug, applicationId): Promise<CatalogIdentityAccessResponse> {
      // The same gate as `detail`, in the same order: an API the caller may
      // not open is absent, and nothing about any identity's standing on it
      // is answered — otherwise this would be an existence oracle for private
      // APIs that `detail` refuses to be.
      const api = await store.apis.findBySlug(slug);
      if (!api) throw notFound('API', slug);
      if (!canView(viewer, api, await resolveReadAccess(store, viewer, api))) {
        throw notFound('API', slug);
      }

      // Only the caller's own applications, with no administrator exception:
      // this reads one identity's requests and grants, and an account sees its
      // own and its applications' — never somebody else's. Somebody else's
      // application reads as absent, as it does on `GET /api/applications/:id`
      // for a non-admin. A disabled application is still answered: it keeps
      // whatever access it already holds, and the page has to be able to say so.
      let application: ApplicationSummary | null = null;
      if (applicationId !== null) {
        const record = await store.applications.findById(applicationId);
        if (!record || record.owner_user_id !== viewer.id) {
          throw notFound('Application', applicationId);
        }
        application = {
          id: record.id,
          name: record.name,
          owner_user_id: record.owner_user_id,
          status: record.status,
        };
      }

      // Both reads are scoped to this identity: `null` selects the account's
      // own rows, an id that application's. Grants and pending requests are
      // unique per `(api, user, application)`, which is exactly the key the
      // access-request duplicate checks use.
      const [grant, requests] = await Promise.all([
        store.grants.findActiveByApiAndUser(api.id, viewer.id, applicationId),
        store.accessRequests.list(
          { api_id: api.id, user_id: viewer.id, application_id: applicationId },
          { limit: 1, offset: 0 },
        ),
      ]);
      const request = requests.items[0] ?? null;

      return {
        application,
        request: request ? { ...request, ...(application ? { application } : {}) } : null,
        grant: grant ? { ...grant, ...(application ? { application } : {}) } : null,
      };
    },

    async spec(viewer, slug): Promise<CatalogSpecResponse> {
      const api = await store.apis.findBySlug(slug);
      if (!api) throw notFound('API', slug);
      if (!canView(viewer, api, await resolveReadAccess(store, viewer, api))) {
        throw notFound('API', slug);
      }

      const record = await store.apiSpecs.findCurrentByApi(api.id);
      if (!record) throw notFound('Specification for API', slug);

      const presented = presentApi(api, await settings.getGatewayPublicUrl());
      const rendering = renderSpec(
        record.id,
        record.raw_spec,
        presented.invoke_url ?? presented.listen_path,
      );
      // Stored legacy or corrupt documents must never fall back to raw output
      // or expose parser diagnostics containing provider-authored addresses.
      if (rendering === null) {
        throw specInvalid('The catalog specification could not be normalized');
      }

      return {
        api_id: api.id,
        version: record.version,
        raw_spec: rendering.raw_spec,
        content_type: rendering.content_type,
        parsed_title: record.parsed_title,
        parsed_version: record.parsed_version,
      };
    },
  };
}
