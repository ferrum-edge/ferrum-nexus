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
 *   metadata read by another route.
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
