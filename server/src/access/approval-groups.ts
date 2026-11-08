import { aclGroupForApi, mcpGroupsForGrant, type Uuid } from '@ferrum-nexus/shared';

import type { NexusStore } from '../db/store.js';

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
 * - A grant whose API row is missing, or whose API is recorded under another
 *   namespace than `namespace`, contributes nothing: only this namespace's
 *   proxy for that API id consumes its group, so there is nothing here for it
 *   to open.
 * - The REST group is derived from the API id, not read from the stored
 *   `grant.acl_group`.
 * - For an agent API the approved tool subset is authoritative, never the
 *   request or today's operation names. Expired exposure ids stay inert;
 *   `null` keeps every tool and `[]` keeps REST alone.
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
    const api = apis.get(grant.api_id);
    if (!api || api.namespace !== namespace) continue;
    groups.add(aclGroupForApi(grant.api_id));
    if (api.agents) {
      for (const group of mcpGroupsForGrant(grant.api_id, grant.approved_tools)) groups.add(group);
    }
  }
  return [...groups];
}
