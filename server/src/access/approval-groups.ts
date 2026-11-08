import { aclGroupForApi, mcpGroupsForGrant, type Uuid } from '@ferrum-nexus/shared';

import type { ApiRecord, GrantRecord, NexusStore } from '../db/store.js';

/**
 * Whether `api` is served by this namespace's proxy: present, and recorded
 * under `namespace`. The eligibility half of {@link grantApprovalGroups}, for a
 * writer that adds one particular group (publishing's MCP-all enrollment)
 * rather than a grant's whole set.
 */
export function apiInNamespace(
  api: Pick<ApiRecord, 'namespace'> | null | undefined,
  namespace: string,
): boolean {
  return api != null && api.namespace === namespace;
}

/**
 * The groups **one** active grant on `api` puts on its identity's consumer in
 * `namespace`: the REST group, plus the approved MCP groups for an agent API.
 *
 * The per-API rule every writer of approval groups shares, whether it rebuilds
 * an identity's whole set ({@link approvalGroupsForIdentity}) or sets one API's
 * groups (approval, and approval recovery's `reconcileGroups`). An API that is
 * missing, or recorded under another namespace than `namespace`, contributes
 * nothing: only this namespace's proxy for that API id consumes the group, so
 * on this namespace's consumer it opens nothing (issue #659).
 *
 * The REST group is derived from the API id, never read from the stored
 * `grant.acl_group`. The approved tool subset is authoritative, never the
 * request or today's operation names: expired exposure ids stay inert, `null`
 * keeps every tool and `[]` keeps REST alone.
 */
export function grantApprovalGroups(
  api: ApiRecord | null | undefined,
  grant: Pick<GrantRecord, 'api_id' | 'approved_tools'>,
  namespace: string,
): string[] {
  if (!api || api.id !== grant.api_id || !apiInNamespace(api, namespace)) return [];
  return [
    aclGroupForApi(grant.api_id),
    ...(api.agents ? mcpGroupsForGrant(grant.api_id, grant.approved_tools) : []),
  ];
}

/**
 * The `nexus:api:<id>:…` ACL groups **one gateway identity** should carry,
 * rebuilt from the portal's own active grants.
 *
 * The one definition shared by account re-enable
 * (`CredentialsService.restoreGatewayAccess`) and consumer repair (gateway
 * reconciliation), so the same identity never comes back from one of them with
 * a group the other would not write (issue #659).
 *
 * - Scoped by `applicationId`, and that scope is load-bearing: replaying an
 *   account's whole grant list onto an application's consumer would hand that
 *   application every API its owner can reach (issue #289). `null` is the
 *   account's own consumer.
 * - Each grant contributes {@link grantApprovalGroups}: nothing for a missing
 *   API or one outside `namespace`, else its REST and approved MCP groups.
 *
 * Owner and application state are the callers' to check, because they react
 * differently: restore refuses an inactive owner, repair writes no groups.
 * Run it against the store or transaction the caller's fencing requires.
 */
export async function approvalGroupsForIdentity(
  db: NexusStore,
  userId: Uuid,
  applicationId: Uuid | null,
  namespace: string,
): Promise<string[]> {
  const grants = await db.grants.listActiveByUser(userId, applicationId);
  if (grants.length === 0) return [];
  const apis = new Map(
    (await db.apis.findManyByIds([...new Set(grants.map((grant) => grant.api_id))])).map((api) => [
      api.id,
      api,
    ]),
  );
  const groups = new Set<string>();
  for (const grant of grants) {
    for (const group of grantApprovalGroups(apis.get(grant.api_id), grant, namespace)) {
      groups.add(group);
    }
  }
  return [...groups];
}
