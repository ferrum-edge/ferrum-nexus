/**
 * The one-time repair of gateway work stranded before migration `015`
 * (issue #651).
 *
 * `access_gateway_jobs` records the gateway half of every decision made from
 * now on, but a database upgraded from an earlier release may already hold
 * the two states the jobs exist to prevent:
 *
 * - **a revoked grant whose ACL group is still on the consumer** — the process
 *   stopped between the revocation's claim and its Edge removal, or the
 *   removal and its rollback both failed;
 * - **an approved access request with no grant** — the process stopped
 *   between the approval's claim and its grant, possibly after the group
 *   landed.
 *
 * Nothing in the database says which revoked grants left a group behind, and
 * reading every consumer at startup would be unbounded Edge traffic. So the
 * repair queues one ordinary job per affected identity and API and lets the
 * access gateway worker decide under its usual keys: a revocation job takes the
 * groups off only while no active grant holds them — so a regrant is never
 * touched — and is a cheap no-op where the group is already gone; an approval
 * job compensates exactly as for a crash after the claim.
 *
 * Queued:
 *
 * - for every identity and API with a revoked grant and **no active grant**,
 *   one `revoke` job, on the first such grant met, when the identity has a
 *   consumer at all;
 * - for every `approved` request for access (`grant_id` null) that **no grant,
 *   active or not, was ever made from**, one `approve` job.
 *
 * Not queued: an approved request for more tools on a grant. A successful one
 * stays `approved` for good, and a later prune or revocation of its grant
 * makes a finished one indistinguishable from an interrupted one, so
 * compensating it automatically could put an old request back in a provider's
 * inbox. `docs/operations.md` ("Access gateway jobs") gives the supported
 * manual repair.
 *
 * Idempotent and bounded: rows are read a page at a time, a job is inserted
 * only where its subject has none, and the run is recorded once with an
 * `access.stranded_repair_queued` audit row, under a lease, so later starts —
 * on any instance — queue nothing.
 */

import { MAX_PAGE_SIZE } from '@ferrum-nexus/shared';

import { AuditAction, SYSTEM_ACTOR, type AuditService } from '../audit/service.js';
import type { AccessRequestRecord, GrantRecord, NexusStore } from '../db/store.js';
import { nowIso } from '../lib/ids.js';
import type { KeyedSerializer } from '../lib/keyed-serializer.js';

/** Lease key every instance's repair runs under. */
export const STRANDED_REPAIR_LOCK_KEY = 'access:stranded-repair:v1';

/** What {@link queueStrandedAccessRepairs} did. */
export interface StrandedRepairResult {
  /** `true` when an earlier start already recorded the repair; nothing was queued. */
  alreadyRecorded: boolean;
  /** `revoke` jobs this run inserted. */
  revocations: number;
  /** `approve` jobs this run inserted. */
  approvals: number;
}

/** Dependencies of {@link queueStrandedAccessRepairs}. */
export interface StrandedRepairDeps {
  store: NexusStore;
  audit: AuditService;
  /** The store-level serializer; the repair holds {@link STRANDED_REPAIR_LOCK_KEY}. */
  locks: KeyedSerializer;
  /** The Edge namespace consumers are looked up in. */
  namespace: string;
}

async function repairRecorded(store: NexusStore): Promise<boolean> {
  const recorded = await store.auditLogs.list(
    { action: AuditAction.ACCESS_STRANDED_REPAIR_QUEUED },
    { limit: 1 },
  );
  return recorded.items.length > 0;
}

/** Every row a paged list returns, a page at a time. */
async function* pages<T>(
  read: (offset: number) => Promise<{ items: T[]; total: number }>,
): AsyncGenerator<T> {
  let offset = 0;
  for (;;) {
    const page = await read(offset);
    for (const item of page.items) yield item;
    offset += page.items.length;
    if (page.items.length === 0 || offset >= page.total) return;
  }
}

function identityKey(row: Pick<GrantRecord, 'api_id' | 'user_id' | 'application_id'>): string {
  return JSON.stringify([row.api_id, row.user_id, row.application_id]);
}

/** Queue the gateway work stranded before migration `015`, once. */
export async function queueStrandedAccessRepairs(
  deps: StrandedRepairDeps,
): Promise<StrandedRepairResult> {
  const { store, audit, locks, namespace } = deps;
  return locks(STRANDED_REPAIR_LOCK_KEY, async () => {
    if (await repairRecorded(store)) {
      return { alreadyRecorded: true, revocations: 0, approvals: 0 };
    }
    const result: StrandedRepairResult = { alreadyRecorded: false, revocations: 0, approvals: 0 };

    // Revoked grants: one job per identity and API with no active grant.
    const seen = new Set<string>();
    for await (const grant of pages((offset) =>
      store.grants.list({ status: 'revoked' }, { limit: MAX_PAGE_SIZE, offset }),
    )) {
      const key = identityKey(grant);
      if (seen.has(key)) continue;
      seen.add(key);
      // An active grant owns the group; nothing is stranded.
      if (
        await store.grants.findActiveByApiAndUser(grant.api_id, grant.user_id, grant.application_id)
      ) {
        continue;
      }
      // No consumer, no group to strand; an account that is gone took its own.
      const consumer = await store.consumers.findByUserAndNamespace(
        grant.user_id,
        namespace,
        grant.application_id,
      );
      if (!consumer || !(await store.users.findById(grant.user_id))) continue;
      const queued = await store.accessGatewayJobs.enqueueIfAbsent(
        {
          kind: 'revoke',
          subject_id: grant.id,
          api_id: grant.api_id,
          user_id: grant.user_id,
          application_id: grant.application_id,
          requested_by: null,
        },
        nowIso(),
      );
      if (queued) result.revocations += 1;
    }

    // Approved requests for access that no grant was ever made from.
    for await (const request of pages<AccessRequestRecord>((offset) =>
      store.accessRequests.list({ status: 'approved' }, { limit: MAX_PAGE_SIZE, offset }),
    )) {
      if (request.grant_id != null) continue;
      if (await grantMadeFrom(store, request)) continue;
      if (!(await store.users.findById(request.user_id))) continue;
      const queued = await store.accessGatewayJobs.enqueueIfAbsent(
        {
          kind: 'approve',
          subject_id: request.id,
          api_id: request.api_id,
          user_id: request.user_id,
          application_id: request.application_id,
          requested_by: request.decided_by,
        },
        nowIso(),
      );
      if (queued) result.approvals += 1;
    }

    // Recorded last, under the lease and fenced by it, so a run that stopped
    // part-way is simply run again by the next start: every insert above is
    // idempotent.
    return store.transaction(async (tx) => {
      if (await repairRecorded(tx)) return { ...result, alreadyRecorded: true };
      await audit
        .forStore(tx)
        .record(
          SYSTEM_ACTOR,
          AuditAction.ACCESS_STRANDED_REPAIR_QUEUED,
          { type: 'access_gateway_jobs', id: null },
          { revocations: result.revocations, approvals: result.approvals },
        );
      return result;
    });
  });
}

/** Whether any grant, in any status, records `request` as its origin. */
async function grantMadeFrom(store: NexusStore, request: AccessRequestRecord): Promise<boolean> {
  for await (const grant of pages((offset) =>
    store.grants.list(
      {
        api_id: request.api_id,
        user_id: request.user_id,
        application_id: request.application_id,
      },
      { limit: MAX_PAGE_SIZE, offset },
    ),
  )) {
    if (grant.access_request_id === request.id) return true;
  }
  return false;
}
