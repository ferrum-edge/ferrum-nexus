/**
 * "May this account read this API?" — answered once, for every surface.
 *
 * The rule itself is documented in the catalog module's header. What lives
 * here is the *evaluation* of it, because three services need the same answer
 * and each of them used to compute its own:
 *
 * - the catalog, to decide whether to open a detail page or serve a spec;
 * - access requests, which must not let an account ask for a private API it
 *   cannot see — a request that got through would confirm the API exists;
 * - messaging, which must not let an account attach a thread to one — the
 *   thread listing embeds the API's name and slug, so a successful attach is a
 *   metadata read by another route;
 * - every listing that embeds an API summary in a row the account can still
 *   see after losing read access — its access requests, grants and threads —
 *   which asks again on every read ({@link filterReadableApis}), and the
 *   notices and emails that name the API to such an account
 *   ({@link canReadApiSummary}).
 *
 * Three copies drifted. The catalog *list* counted a grant held by any of the
 * account's identities while its *detail* check counted only the account's own,
 * so an application-only grantee saw a private API listed and got `404` opening
 * it; access requests counted only an explicit authorization, refusing an
 * existing grantee; and messaging checked nothing at all. One evaluation is
 * how they stay the same.
 *
 * **A grant is a grant whichever of the account's identities holds it.** An
 * application is one of the account's integrations, not a separate person, and
 * somebody allowed to call an API is certainly allowed to read its
 * documentation.
 */

import { roleAtLeast } from '@ferrum-nexus/shared';

import type { ApiRecord, GrantRecord, NexusStore, UserRecord } from '../db/store.js';

/** One account's standing on one API, as the read rule needs it. */
export interface ApiReadAccess {
  /**
   * The active grant that admits the account, if any: its own, preferred, or
   * else one held by one of its applications. `null` when it holds none.
   */
  grant: GrantRecord | null;
  /** The provider authorized this account to read the documentation. */
  isAuthorizedViewer: boolean;
}

/**
 * Resolve an account's standing on an API from the store.
 *
 * The account's own grant is preferred when it has several, because it is the
 * one the catalog's access badge and `my_grant` have always described. Only
 * when there is none does an application's grant stand in — which is exactly
 * the case that used to be missed.
 */
export async function resolveReadAccess(
  store: NexusStore,
  viewer: Pick<UserRecord, 'id'>,
  api: Pick<ApiRecord, 'id'>,
): Promise<ApiReadAccess> {
  const [own, authorization] = await Promise.all([
    store.grants.findActiveByApiAndUser(api.id, viewer.id),
    store.apiViewers.find(api.id, viewer.id),
  ]);
  const grant =
    own ??
    (
      await store.grants.list(
        { api_id: api.id, user_id: viewer.id, status: 'active' },
        { limit: 1, offset: 0 },
      )
    ).items[0] ??
    null;
  return { grant, isAuthorizedViewer: authorization !== null };
}

/** Owner, admin, grantee and authorized viewer see everything about an API. */
function isInsider(viewer: UserRecord, api: ApiRecord, access: ApiReadAccess): boolean {
  return (
    api.owner_user_id === viewer.id ||
    roleAtLeast(viewer.role, 'admin') ||
    access.grant !== null ||
    access.isAuthorizedViewer
  );
}

/** Whether `api` appears in `viewer`'s browse list. */
export function canListApi(viewer: UserRecord, api: ApiRecord, access: ApiReadAccess): boolean {
  if (isInsider(viewer, api, access)) return true;
  return api.status === 'published' && api.visibility === 'public';
}

/** Whether `viewer` may open `api`'s detail page and read its specification. */
export function canViewApi(viewer: UserRecord, api: ApiRecord, access: ApiReadAccess): boolean {
  if (isInsider(viewer, api, access)) return true;
  // For `public` and `internal`, visibility governs listing rather than
  // opening: an unlisted API is readable by anyone holding its link, which is
  // what makes "hand somebody the link and let them request access" work.
  // `private` is the exception the mode exists for — there, not being on one
  // of the insider lists is the end of it.
  return api.status === 'published' && api.visibility !== 'private';
}

/** No grant and no authorization: what {@link canViewApi} grants on role and ownership alone. */
const NO_STANDING: ApiReadAccess = { grant: null, isAuthorizedViewer: false };

/**
 * The APIs, of `apis`, whose summary `viewer` may be shown right now.
 *
 * An access request, a grant and a message thread each embed a summary of
 * their API — name, slug, version, listen path, invoke URL, agent tools — read
 * from the API's *current* row every time the row is listed. The private rule
 * was checked when the row was written, but read access can end after that: a
 * viewer authorization withdrawn, a grant revoked or given up, an API switched
 * to `private`. The row stays the account's to see; the summary is a metadata
 * read like any other and answers to {@link canViewApi} at read time, or it
 * keeps reporting every later rename to an account the catalog answers `404`.
 *
 * Only `private` is gated, as at write time: `internal` is unlisted rather
 * than secret, and a retired API is history the account took part in.
 *
 * The account's standing is read once for the whole page — its active grants
 * through every identity and its viewer authorizations, the two bounded reads
 * the catalog list makes — and only when a private API on the page is neither
 * the viewer's own nor readable by role.
 */
export async function filterReadableApis(
  store: NexusStore,
  viewer: UserRecord,
  apis: readonly ApiRecord[],
): Promise<ApiRecord[]> {
  const gated = apis.filter(
    (api) => api.visibility === 'private' && !canViewApi(viewer, api, NO_STANDING),
  );
  if (gated.length === 0) return [...apis];
  const [grants, authorized] = await Promise.all([
    store.grants.listActiveByUser(viewer.id),
    store.apiViewers.listApiIdsByUser(viewer.id),
  ]);
  const authorizedIds = new Set(authorized);
  const standing = (api: ApiRecord): ApiReadAccess => ({
    grant: grants.find((grant) => grant.api_id === api.id) ?? null,
    isAuthorizedViewer: authorizedIds.has(api.id),
  });
  return apis.filter((api) => !gated.includes(api) || canViewApi(viewer, api, standing(api)));
}

/**
 * {@link filterReadableApis} for one API: whether `viewer` may be shown its
 * live metadata now. What a notice or an email sent to `viewer` checks before
 * naming the API.
 */
export async function canReadApiSummary(
  store: NexusStore,
  viewer: UserRecord,
  api: ApiRecord,
): Promise<boolean> {
  return (await filterReadableApis(store, viewer, [api])).length > 0;
}
