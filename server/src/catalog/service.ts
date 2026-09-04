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
 * | API state              | client | grantee | owner | admin |
 * |------------------------|--------|---------|-------|-------|
 * | `published` `public`   | yes    | yes     | yes   | yes   |
 * | `published` `internal` | **no** | yes     | yes   | yes   |
 * | `retired`              | **no** | yes     | yes   | yes   |
 *
 * **Open** (`GET /api/catalog/:slug` and `…/spec`) — {@link CatalogService.canView}
 *
 * | API state              | client  | grantee | owner | admin |
 * |------------------------|---------|---------|-------|-------|
 * | `published` `public`   | yes     | yes     | yes   | yes   |
 * | `published` `internal` | **yes** | yes     | yes   | yes   |
 * | `retired`              | **no**  | yes     | yes   | yes   |
 *
 * The reasoning behind each deliberate cell:
 *
 * - **`internal` means unlisted, not secret.** It keeps an API out of the
 *   general browse view so the catalog stays a curated shop window, while still
 *   letting a provider hand somebody a link and have them read the docs and
 *   raise an access request. Making it unopenable instead would be
 *   self-defeating: `requestable` + `internal` would be a combination nobody
 *   could ever act on, because there is no provider-initiated grant flow. What
 *   actually protects the data is the ACL group on the gateway, not whether the
 *   OpenAPI document is readable.
 * - **`retired` stops circulating.** Retirement is the provider saying "stop
 *   onboarding onto this". It leaves the proxy and every existing grant alone —
 *   integrations already in production must not break — but the documentation
 *   stops being served to people who are not already using it.
 *
 * The raw spec follows the detail page exactly: there is no separate
 * "documentation" permission, because a catalog entry whose documentation you
 * cannot read is not a catalog entry, it is a teaser.
 */

import {
  clampPageSize,
  roleAtLeast,
  type AccessRequest,
  type ApiSpecSummary,
  type ApiVisibility,
  type CatalogAccessState,
  type CatalogApi,
  type CatalogDetailResponse,
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
import { notFound } from '../lib/errors.js';
import { presentApi, type GatewayUrlSource } from '../publishing/present.js';

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
  /** The raw current spec document, when the caller may see the API. */
  spec(viewer: UserRecord, slug: string): Promise<CatalogSpecResponse>;
  /** Whether `api` appears in `viewer`'s browse list. */
  canList(viewer: UserRecord, api: ApiRecord, hasGrant: boolean): boolean;
  /** Whether `viewer` may open `api`'s detail page and read its spec. */
  canView(viewer: UserRecord, api: ApiRecord, hasGrant: boolean): boolean;
}

/** Dependencies of {@link createCatalogService}. */
export interface CatalogServiceDeps {
  store: NexusStore;
  /** Resolves the gateway origin each row's `invoke_url` is built from. */
  settings: GatewayUrlSource;
}

/** Content type matching a stored raw document. */
export function contentTypeOf(rawSpec: string): string {
  const head = rawSpec.trimStart();
  return head.startsWith('{') || head.startsWith('[') ? 'application/json' : 'application/yaml';
}

/** Build the catalog service. */
export function createCatalogService(deps: CatalogServiceDeps): CatalogService {
  const { store, settings } = deps;

  /** Owner, admin and grantee always see everything about an API. */
  function isInsider(viewer: UserRecord, api: ApiRecord, hasGrant: boolean): boolean {
    return api.owner_user_id === viewer.id || roleAtLeast(viewer.role, 'admin') || hasGrant;
  }

  function canList(viewer: UserRecord, api: ApiRecord, hasGrant: boolean): boolean {
    if (isInsider(viewer, api, hasGrant)) return true;
    return api.status === 'published' && api.visibility === 'public';
  }

  function canView(viewer: UserRecord, api: ApiRecord, hasGrant: boolean): boolean {
    if (isInsider(viewer, api, hasGrant)) return true;
    // Visibility governs listing, not opening: an `internal` API is unlisted
    // but readable by anyone holding its link.
    return api.status === 'published';
  }

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
      const visibleTo: ApiViewerFilter | undefined = roleAtLeast(viewer.role, 'admin')
        ? undefined
        : {
            owner_user_id: viewer.id,
            granted_api_ids: [...grants.keys()],
            open_status: 'published',
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

      const grant = await store.grants.findActiveByApiAndUser(api.id, viewer.id);
      if (!canView(viewer, api, grant !== null)) throw notFound('API', slug);

      const [specRecord, owner, request] = await Promise.all([
        store.apiSpecs.findCurrentByApi(api.id),
        store.users.findById(api.owner_user_id),
        store.accessRequests.findLatestByApiAndUser(api.id, viewer.id),
      ]);

      const spec: ApiSpecSummary | null = specRecord
        ? (({ raw_spec: _raw, ...rest }) => rest)(specRecord)
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

    async spec(viewer, slug): Promise<CatalogSpecResponse> {
      const api = await store.apis.findBySlug(slug);
      if (!api) throw notFound('API', slug);
      const grant = await store.grants.findActiveByApiAndUser(api.id, viewer.id);
      if (!canView(viewer, api, grant !== null)) throw notFound('API', slug);

      const record = await store.apiSpecs.findCurrentByApi(api.id);
      if (!record) throw notFound('Specification for API', slug);

      return {
        api_id: api.id,
        version: record.version,
        raw_spec: record.raw_spec,
        content_type: contentTypeOf(record.raw_spec),
        parsed_title: record.parsed_title,
        parsed_version: record.parsed_version,
      };
    },
  };
}
