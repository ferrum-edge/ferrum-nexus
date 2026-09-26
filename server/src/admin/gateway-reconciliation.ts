/**
 * Gateway reference reconciliation — does Edge still hold the ids Nexus stored?
 *
 * ## The failure this exists for
 *
 * Nexus keeps two foreign keys into Ferrum Edge: `consumers.ferrum_consumer_id`
 * (one canonical consumer per account per namespace) and `apis.ferrum_proxy_id`
 * (one proxy per published API). Neither is a value Nexus can re-derive from
 * the gateway on demand — they are the mapping.
 *
 * Point `FERRUM_ADMIN_URL` at a *different* gateway, or rebuild the one it
 * already points at, and every one of those ids becomes a reference to nothing.
 * Nothing in the portal noticed: `/api/health` stayed green because the Admin
 * API was perfectly reachable, new accounts and new publishes worked end to
 * end, and only the legacy half of the portal broke — an approval or a
 * credential issue on an older account answering `502 EDGE_ERROR` ("The gateway
 * consumer for this account no longer exists"), an older API keeping a proxy id
 * that `404`s with no symptom at all until somebody tries to change it
 * (issue #235).
 *
 * ## Detect, surface, repair — in that order, and never on startup
 *
 * This module only ever *reads* until an administrator asks for a repair.
 * That is deliberate. "Recreate whatever is missing" run automatically at boot
 * is indistinguishable, from inside the process, from "the operator pointed a
 * staging portal at production for ten minutes" — and it would recreate a
 * production account's gateway identity from a staging database. So:
 *
 * 1. **Detect.** {@link GatewayReconciliationService.scan} walks a bounded
 *    sample of both reference kinds and asks Edge about each one. A `404` is
 *    an orphan; anything else that fails is *not* — see below.
 * 2. **Surface.** The pass result is cached with its timestamp and read by
 *    `/api/health`, which never scans itself. Orphans degrade the portal.
 * 3. **Repair.** {@link GatewayReconciliationService.repair} is `super_admin`
 *    only, audited per account and per API, and explicit about what it cannot
 *    give back.
 *
 * ## A gateway that is down is not a gateway full of orphans
 *
 * `edge.consumers.get` answers `null` for a `404` and *throws* for everything
 * else, which is the whole distinction this pass rests on. A connection
 * refused, a `500`, an expired admin JWT — none of them say the reference is
 * gone, and treating them as orphans would let one flaky minute talk an
 * administrator into recreating the entire portal's gateway identities. The
 * first throw therefore abandons the pass: the result is `status: 'unknown'`
 * carrying the error, orphan lists are dropped, and health reports nothing new.
 *
 * ## What a repair can and cannot restore
 *
 * A recreated consumer is the *same identity*: the canonical
 * `nexus-user-<user_id>` username, `custom_id` back to the Nexus user id, and
 * the derived id `edge.consumers.ensure` assigns — which on a fresh gateway is
 * the same string the portal already held. The `nexus:api:<id>:approved` ACL
 * groups are replayed from the portal's own `active` grants, so approvals that
 * were granted before the retarget work again.
 *
 * Credential *material* is gone for good. It is show-once by design: Nexus
 * stores a SHA-256 fingerprint and the last four characters, never the secret,
 * and Edge never discloses an entry on read. Minting replacements here would
 * hand new secrets to nobody — they can only be delivered to the person who
 * asked for one — so the repair moves those rows to `revoked` instead and
 * reports the count as credentials requiring re-issue. Leaving them `active`
 * would be worse than useless: the credential mirror's positions
 * (`edge_ordinal`) would then describe an array that no longer exists, and the
 * next rotate or revoke on the account would refuse as drift.
 *
 * An orphaned proxy is not recreated *here*. Rebuilding one needs the
 * provider's current spec revision, upstream, plugin palette and enforcement
 * mode replayed in order — which is exactly what publishing already does, and
 * is therefore where it lives: `publishing.restoreGateway` rebuilds the
 * deployment of an existing API in place, keeping its id, slug, owner,
 * specification history, gateway URL and every access grant. This repair
 * clears the dead `ferrum_proxy_id`, which is what makes the rest of the portal
 * stop addressing a proxy that is not there (`plugins/service.ts` refuses to
 * attach to one; `publishing/service.ts` skips every proxy write for one), and
 * records the incident as an
 * {@link AuditAction.API_GATEWAY_REPAIR_REQUIRED} row with
 * `phase: 'orphaned_proxy'`.
 *
 * Clearing the reference is deliberately **not** the whole story. On its own it
 * made the API indistinguishable from one that simply has no deployment yet:
 * the next pass skipped it (no proxy id to check), reported a clean portal, and
 * the API went on serving nothing (issue #284). So the same write sets
 * `apis.gateway_state = 'repair_required'`, every pass counts those rows into
 * {@link GatewayReconciliationReport.awaiting_restore}, and the verdict stays
 * `orphaned` — and the portal `degraded` — until a restore succeeds. That count
 * comes from the portal's own rows, so it survives a pass that could not reach
 * the gateway at all.
 *
 * The flag is written under the same per-API key the restore holds
 * ({@link apiRestoreLockKey}), after asking the gateway again, and together
 * with its audit row in one transaction. A repair acting on a pass that a
 * restore — or an operator — has since overtaken therefore leaves the rebuilt
 * deployment alone instead of clearing the reference to it (issue #342).
 */

import {
  aclGroupForApi,
  MAX_PAGE_SIZE,
  roleAtLeast,
  type GatewayReconciliationReport,
  type GatewayReferenceScan,
  type OrphanedConsumerRef,
  type OrphanedProxyRef,
  type FlaggedGatewayApi,
  type RepairedGatewayConsumer,
  type RepairGatewayReferencesResponse,
  type Uuid,
} from '@ferrum-nexus/shared';

import { AuditAction, type AuditService } from '../audit/service.js';
import type { NexusConfig } from '../config/index.js';
import { canonicalConsumerLockKey } from '../credentials/consumers.js';
import type { NexusStore, UserRecord } from '../db/store.js';
import type { FerrumAdminClient } from '../ferrum-admin/index.js';
import { edgeUnavailable, forbidden, validationFailed } from '../lib/errors.js';
import { apiRestoreLockKey } from '../lib/keyed-serializer.js';
import { isLeaseLost } from '../lib/lease-fence.js';
import type { NotificationsService } from '../notifications/service.js';

/** Credential rows whose gateway entry is supposed to still exist. */
const LIVE_CREDENTIAL_STATUSES = new Set(['active', 'retiring']);

/** What {@link GatewayReconciliationService.repair} was asked to fix. */
export interface RepairGatewayReferencesInput {
  /** Accounts to repair; ignored when `all` is set. */
  userIds?: Uuid[];
  /** APIs to flag; ignored when `all` is set. */
  apiIds?: Uuid[];
  /** Repair every orphan the pass finds. */
  all?: boolean;
  /** Recorded on every audit row this repair writes. */
  reason?: string | null;
}

/** Detection, caching and repair of the portal's Ferrum Edge references. */
export interface GatewayReconciliationService {
  /**
   * Run one pass now and cache it. Used by the admin endpoint and by the
   * periodic poller; never by the health route.
   */
  scan(): Promise<GatewayReconciliationReport>;
  /**
   * The last completed pass, or `null` when none has run in this process.
   *
   * Read synchronously and never triggers a pass — `/api/health` is
   * unauthenticated, and a probe that could reach the gateway would make the
   * endpoint an amplifier again.
   */
  snapshot(): GatewayReconciliationReport | null;
  /** Re-link orphaned references. `super_admin` only, audited per target. */
  repair(
    actor: UserRecord,
    input: RepairGatewayReferencesInput,
    ip?: string | null,
  ): Promise<RepairGatewayReferencesResponse>;
  /** Begin the periodic pass. Idempotent, and a no-op when the interval is `0`. */
  start(): void;
  /** Stop the poller and wait for a pass in flight. Idempotent. */
  stop(): Promise<void>;
  /** Whether the poll timer is currently installed. */
  isRunning(): boolean;
}

/** Dependencies of {@link createGatewayReconciliationService}. */
export interface GatewayReconciliationServiceDeps {
  config: NexusConfig;
  store: NexusStore;
  edge: FerrumAdminClient;
  audit: AuditService;
  notifications: NotificationsService;
  log?: (obj: Record<string, unknown>, message: string) => void;
}

/**
 * A consumer a repair recreated and then kept, because the lease fence refused
 * the relink that would have recorded it: another instance held the keys by
 * then, and may already have been issuing onto it.
 */
interface KeptConsumer {
  kind: 'kept';
  consumerId: string;
  /**
   * The credential rows that were live before the consumer was recreated.
   * They name entries of the consumer that was lost, so they are stale
   * whatever happened after the recreation — unlike a row another instance
   * wrote for an entry it appended to the recreated consumer since.
   */
  staleCredentialIds: Uuid[];
  /** The fence's refusal. */
  error: unknown;
}

/** What one pass of the consumer repair's critical section found or did. */
type ConsumerRepairOutcome =
  | { kind: 'gone' }
  | { kind: 'present'; consumerId: string }
  | { kind: 'repaired'; consumerId: string; revoked: Uuid[] }
  | KeptConsumer;

/** A repair outcome with nothing left to finish. */
type SettledRepairOutcome = Exclude<ConsumerRepairOutcome, KeptConsumer>;

/** A thrown value as a string, for a log line or an audit detail. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** An empty scan of one reference kind, before anything has been checked. */
function emptyScan(): GatewayReferenceScan {
  return { checked: 0, orphaned: 0, complete: true };
}

/** Build the gateway reconciliation service. The caller owns `start()`/`stop()`. */
export function createGatewayReconciliationService(
  deps: GatewayReconciliationServiceDeps,
): GatewayReconciliationService {
  const { config, store, edge, audit, notifications } = deps;
  const log = deps.log ?? ((): void => {});
  const namespace = config.edge.namespace;
  const sample = config.gatewayReconcileSample;
  const intervalMs = config.gatewayReconcileIntervalMs;

  let cached: GatewayReconciliationReport | null = null;
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<GatewayReconciliationReport> | null = null;

  /** Thrown by a pass that could not reach the gateway; never leaves this module. */
  class GatewayUnreachable extends Error {}

  /**
   * Ask Edge whether `check` still exists, translating a transport failure into
   * {@link GatewayUnreachable}.
   *
   * The whole pass turns on the difference between "Edge said 404" and "Edge
   * did not say anything", so the translation happens once, here, rather than
   * being re-derived at each call site.
   */
  async function exists(check: () => Promise<unknown>): Promise<boolean> {
    try {
      return (await check()) !== null;
    } catch (error) {
      throw new GatewayUnreachable(errorMessage(error));
    }
  }

  /** Walk the stored consumer rows of this namespace, oldest page first. */
  async function scanConsumers(orphans: OrphanedConsumerRef[]): Promise<GatewayReferenceScan> {
    const result = emptyScan();
    let offset = 0;
    for (;;) {
      const page = await store.consumers.list({ namespace }, { limit: MAX_PAGE_SIZE, offset });
      for (const row of page.items) {
        if (result.checked >= sample) {
          // Stopped at the bound rather than at the end of the table, which is
          // exactly what `complete: false` has to say.
          result.complete = false;
          return result;
        }
        result.checked += 1;
        if (await exists(() => edge.consumers.get(row.ferrum_consumer_id))) continue;
        result.orphaned += 1;
        orphans.push({
          user_id: row.user_id,
          application_id: row.application_id,
          ferrum_consumer_id: row.ferrum_consumer_id,
          ferrum_username: row.ferrum_username,
        });
      }
      offset += page.items.length;
      if (page.items.length === 0 || offset >= page.total) return result;
    }
  }

  /**
   * Walk the stored proxy references, oldest page first.
   *
   * `apis.list` has no "has a proxy" filter and no namespace filter, so both
   * are applied here. Rows skipped that way are not counted as *checked* —
   * an API with no proxy id has no reference to be orphaned — but they do
   * count against the page walk, so a portal whose catalog is mostly retired
   * rows still finishes.
   */
  async function scanProxies(orphans: OrphanedProxyRef[]): Promise<GatewayReferenceScan> {
    const result = emptyScan();
    let offset = 0;
    for (;;) {
      const page = await store.apis.list({}, { limit: MAX_PAGE_SIZE, offset });
      for (const api of page.items) {
        const proxyId = api.ferrum_proxy_id;
        if (!proxyId || api.namespace !== namespace) continue;
        if (result.checked >= sample) {
          result.complete = false;
          return result;
        }
        result.checked += 1;
        if (await exists(() => edge.proxies.get(proxyId))) continue;
        result.orphaned += 1;
        orphans.push({ api_id: api.id, slug: api.slug, ferrum_proxy_id: proxyId });
      }
      offset += page.items.length;
      if (page.items.length === 0 || offset >= page.total) return result;
    }
  }

  /**
   * APIs this namespace has already established are not deployed.
   *
   * A portal read, not a gateway one, and therefore the one finding a pass
   * keeps when Edge stops answering: `repair_required` was written because a
   * gateway *did* answer `404` for the proxy, and an unreachable gateway is no
   * reason to stop reporting it. `0` on a store failure — the count is a
   * signal, and losing the whole pass over it would hide the orphans too.
   */
  async function countAwaitingRestore(): Promise<number> {
    try {
      return await store.apis.count({ namespace, gateway_state: 'repair_required' });
    } catch (error) {
      log(
        { namespace, error: errorMessage(error) },
        'Could not count the APIs awaiting a gateway restore',
      );
      return 0;
    }
  }

  async function runScan(): Promise<GatewayReconciliationReport> {
    const checkedAt = new Date().toISOString();
    const orphanedConsumers: OrphanedConsumerRef[] = [];
    const orphanedProxies: OrphanedProxyRef[] = [];
    const awaitingRestore = await countAwaitingRestore();
    try {
      const consumers = await scanConsumers(orphanedConsumers);
      const proxies = await scanProxies(orphanedProxies);
      const orphaned = consumers.orphaned + proxies.orphaned;
      const report: GatewayReconciliationReport = {
        // An API waiting to be restored is an unresolved gateway condition
        // exactly as a live orphan is — it is the *same* incident one repair
        // step later — so it keeps the verdict, and the portal, degraded until
        // the restore lands.
        status: orphaned > 0 || awaitingRestore > 0 ? 'orphaned' : 'ok',
        checked_at: checkedAt,
        namespace,
        consumers,
        proxies,
        orphaned_consumers: orphanedConsumers,
        orphaned_proxies: orphanedProxies,
        awaiting_restore: awaitingRestore,
        error: null,
      };
      if (orphaned > 0 || awaitingRestore > 0) {
        // The line to alert on: the portal is pointing at a gateway that does
        // not hold what it stored, and nothing repairs that by itself.
        log(
          {
            namespace,
            orphaned_consumers: consumers.orphaned,
            orphaned_proxies: proxies.orphaned,
            checked_consumers: consumers.checked,
            checked_proxies: proxies.checked,
            awaiting_restore: awaitingRestore,
          },
          'The gateway no longer holds references the portal stored; run the gateway repair ' +
            'and restore the affected API deployments',
        );
      }
      cached = report;
      return report;
    } catch (error) {
      if (!(error instanceof GatewayUnreachable)) throw error;
      // Partial findings are discarded rather than reported: whatever was
      // checked before the gateway stopped answering is no longer evidence
      // about the gateway as a whole.
      const report: GatewayReconciliationReport = {
        // The gateway findings are discarded, but the flagged APIs are not
        // gateway findings: they are what the portal already knows, and they
        // outrank `unknown` for the same reason they outrank `ok`.
        status: awaitingRestore > 0 ? 'orphaned' : 'unknown',
        checked_at: checkedAt,
        namespace,
        consumers: { checked: 0, orphaned: 0, complete: false },
        proxies: { checked: 0, orphaned: 0, complete: false },
        orphaned_consumers: [],
        orphaned_proxies: [],
        awaiting_restore: awaitingRestore,
        error: error.message,
      };
      log(
        { namespace, error: error.message },
        'Could not reconcile the portal’s Ferrum Edge references; retrying on the next pass',
      );
      cached = report;
      return report;
    }
  }

  /**
   * One pass, deduplicated.
   *
   * Never overlap passes: the poller and an admin request can arrive together,
   * and a second walk would only double the Admin API traffic for an answer
   * the first is already computing.
   */
  async function scanOnce(): Promise<GatewayReconciliationReport> {
    if (inFlight) return inFlight;
    inFlight = runScan();
    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  }

  /**
   * One background pass, with nowhere for its failure to go but the log.
   *
   * A pass the gateway refused is already handled — it becomes a `'unknown'`
   * report. This catch is for the other half: a store read that failed, which
   * would otherwise be an unhandled rejection from a timer.
   */
  function poll(): void {
    void scanOnce().catch((error: unknown) => {
      log({ namespace, error: errorMessage(error) }, 'The gateway reconciliation pass failed');
    });
  }

  /* ── Repair ───────────────────────────────────────────────────────────── */

  /**
   * The ACL groups **one identity** should carry, from the portal's own grants.
   *
   * Rebuilt from `grants` rather than remembered, because the portal's grant
   * rows are the record of who was approved for what — the gateway's copy is
   * the thing that was lost.
   *
   * Scoped by `applicationId`, and that scope is load-bearing: replaying an
   * account's whole grant list onto an application's consumer would hand that
   * application every API its owner can reach, which is precisely what
   * application identities exist to prevent (issue #289). `null` is the
   * account's own consumer.
   */
  async function approvedGroups(userId: Uuid, applicationId: Uuid | null): Promise<string[]> {
    const groups: string[] = [];
    for (let offset = 0; ; offset += MAX_PAGE_SIZE) {
      const page = await store.grants.list(
        { user_id: userId, status: 'active', application_id: applicationId },
        { limit: MAX_PAGE_SIZE, offset },
      );
      for (const grant of page.items) groups.push(aclGroupForApi(grant.api_id));
      if (page.items.length === 0 || offset + page.items.length >= page.total) return groups;
    }
  }

  /** Ids of the credential rows whose gateway entry `consumerId` should still hold. */
  async function liveCredentialIds(db: NexusStore, consumerId: string): Promise<Uuid[]> {
    const ids: Uuid[] = [];
    for (let offset = 0; ; offset += MAX_PAGE_SIZE) {
      const page = await db.credentials.list(
        { ferrum_consumer_id: consumerId },
        { limit: MAX_PAGE_SIZE, offset },
      );
      for (const credential of page.items) {
        if (LIVE_CREDENTIAL_STATUSES.has(credential.status)) ids.push(credential.id);
      }
      if (page.items.length === 0 || offset + page.items.length >= page.total) return ids;
    }
  }

  /**
   * Recreate one account's gateway consumer and re-link the portal row.
   *
   * Takes the provisioning key `ensureConsumer` uses before the stored
   * consumer-id key used by every ordinary mutation. Keeping that lock order
   * makes recreation race-free with both provisioning and credential/ACL
   * changes while the portal still exposes the stale id.
   *
   * ## A relink the lease fence refuses
   *
   * A repair that stalls past the lease TTL after recreating the consumer has
   * its relink refused at commit, and the consumer it recreated is kept rather
   * than deleted: another instance holds the keys by then and may already be
   * issuing onto it. Kept under the id the portal already stores, that
   * consumer reads as `present` to every later pass, so no later repair would
   * ever revoke the rows that name entries of the consumer that was lost. So
   * the repair does not stop there: it logs the refusal, takes the keys
   * again, and — finding the consumer it kept — completes the repair,
   * revoking exactly the rows that were live *before* it recreated the
   * consumer and writing the `gateway.consumer_repair` row with
   * `resumed: true`. A row written since, for an entry another instance
   * appended to the recreated consumer, is not among them and stays live.
   * Only a second refusal leaves the rows `active`, and says so in its own
   * log line (`docs/operations.md` §13, "The repair").
   */
  async function repairConsumer(
    actor: UserRecord,
    orphan: OrphanedConsumerRef,
    reason: string | null,
    ip: string | null,
  ): Promise<RepairedGatewayConsumer> {
    const base: RepairedGatewayConsumer = {
      user_id: orphan.user_id,
      application_id: orphan.application_id,
      previous_ferrum_consumer_id: orphan.ferrum_consumer_id,
      ferrum_consumer_id: null,
      credentials_requiring_reissue: 0,
      restored_groups: 0,
      error: null,
    };
    try {
      const groups = await approvedGroups(orphan.user_id, orphan.application_id);

      /** The `gateway.consumer_repair` row's details. */
      const repairDetails = (
        consumerId: string,
        revoked: Uuid[],
        resumed: boolean,
      ): Record<string, unknown> => ({
        namespace,
        previous_consumer_id: orphan.ferrum_consumer_id,
        consumer_id: consumerId,
        ferrum_username: orphan.ferrum_username,
        restored_groups: groups.length,
        revoked_credentials: revoked.length,
        revoked_credential_ids: revoked,
        ...(resumed ? { resumed: true } : {}),
        ...(reason ? { reason } : {}),
      });

      /**
       * One pass of the critical section. `kept` is the consumer an earlier
       * pass of this same repair recreated and had to keep, or `null`.
       */
      const attempt = async (kept: KeptConsumer | null): Promise<ConsumerRepairOutcome> => {
        return edge.serializePerKey(
          canonicalConsumerLockKey(namespace, orphan.ferrum_username),
          async (): Promise<ConsumerRepairOutcome> => {
            // Re-read inside the critical section: another repair, or an ordinary
            // provisioning call, may have rebuilt this consumer already.
            const row = await store.consumers.findByUserAndNamespace(
              orphan.user_id,
              namespace,
              orphan.application_id,
            );
            if (!row) return { kind: 'gone' };
            const staleId = row.ferrum_consumer_id;
            return edge.serializePerKey(staleId, async (): Promise<ConsumerRepairOutcome> => {
              if ((await edge.consumers.get(staleId)) !== null) {
                if (kept === null || kept.consumerId !== staleId) {
                  return { kind: 'present', consumerId: staleId };
                }
                // The consumer this repair recreated, still standing: finish
                // what the refused relink would have recorded. Only the rows
                // that were live before the recreation are revoked — each
                // re-read, so one revoked or moved since is left alone — and
                // the row that records the repair commits with them.
                const staleIds = kept.staleCredentialIds;
                const revoked = await store.transaction(async (tx) => {
                  const ids: Uuid[] = [];
                  for (const id of staleIds) {
                    const credential = await tx.credentials.findById(id);
                    if (
                      !credential ||
                      credential.ferrum_consumer_id !== staleId ||
                      !LIVE_CREDENTIAL_STATUSES.has(credential.status)
                    ) {
                      continue;
                    }
                    await tx.credentials.update(id, { status: 'revoked' });
                    ids.push(id);
                  }
                  await audit
                    .forStore(tx)
                    .record(
                      { id: actor.id, role: actor.role },
                      AuditAction.GATEWAY_CONSUMER_REPAIR,
                      { type: 'user', id: orphan.user_id },
                      repairDetails(staleId, ids, true),
                      ip,
                    );
                  return ids;
                });
                return { kind: 'repaired', consumerId: staleId, revoked };
              }

              // Read before the consumer exists again: these rows can only
              // name entries of the one that was lost. Under both keys, so no
              // row for this id is written between here and the relink.
              const stale = await liveCredentialIds(store, staleId);

              const { consumer, created } = await edge.consumers.ensure(
                {
                  username: row.ferrum_username,
                  // The id the username names: the application for an
                  // application identity, the account for its own consumer.
                  custom_id: orphan.application_id ?? orphan.user_id,
                  acl_groups: groups,
                },
                actor.id,
              );

              // Gateway first, then the portal — and both store writes together,
              // so a relink can never commit without the revocations that make
              // the credential mirror agree with the empty consumer it now
              // points at. The audit row commits with them: recorded
              // afterwards, a failed insert left the relink and the
              // revocations applied and unaudited behind a failed repair, and a
              // repeat found the consumer present and nothing to record.
              let revoked: Uuid[];
              try {
                revoked = await store.transaction(async (tx) => {
                  if (consumer.id !== staleId) {
                    await tx.consumers.update(row.id, { ferrum_consumer_id: consumer.id });
                  }
                  const ids = await liveCredentialIds(tx, staleId);
                  for (const id of ids) await tx.credentials.update(id, { status: 'revoked' });
                  await audit
                    .forStore(tx)
                    .record(
                      { id: actor.id, role: actor.role },
                      AuditAction.GATEWAY_CONSUMER_REPAIR,
                      { type: 'user', id: orphan.user_id },
                      repairDetails(consumer.id, ids, false),
                      ip,
                    );
                  return ids;
                });
              } catch (error) {
                // Refused by the lease fence: another instance holds the keys
                // now, and may already be issuing onto the consumer it found,
                // so the consumer is kept — and handed back for this repair to
                // complete once it holds the keys again.
                if (created && isLeaseLost(error)) {
                  return {
                    kind: 'kept',
                    consumerId: consumer.id,
                    staleCredentialIds: stale,
                    error,
                  };
                }
                // Nothing of the portal half committed, so the consumer this
                // attempt recreated must not outlive it. Recreated under the
                // same derived id, it is exactly what a repeat reads as
                // `present` — nothing to repair — while the credential rows
                // stay `active` against an empty consumer and the repair goes
                // unaudited. Taking it back down leaves the orphan the next
                // pass reports, and a repeat repairs it whole. Only a consumer
                // this attempt created.
                if (created) {
                  try {
                    await edge.consumers.delete(consumer.id, actor.id);
                  } catch (undoError) {
                    log(
                      {
                        user_id: orphan.user_id,
                        namespace,
                        consumer_id: consumer.id,
                        error: errorMessage(undoError),
                      },
                      'A failed consumer repair could not delete the consumer it recreated; ' +
                        'its credential rows still name keys the gateway does not hold',
                    );
                  }
                }
                throw error;
              }
              return { kind: 'repaired', consumerId: consumer.id, revoked };
            });
          },
        );
      };

      /** Take the keys again and finish what `kept` left, or say that it could not be. */
      const complete = async (kept: KeptConsumer): Promise<SettledRepairOutcome> => {
        log(
          {
            user_id: orphan.user_id,
            namespace,
            consumer_id: kept.consumerId,
            stale_credentials: kept.staleCredentialIds.length,
            error: errorMessage(kept.error),
          },
          'A consumer repair lost its lease after recreating the consumer; the consumer is ' +
            'kept, and the repair is completed under fresh keys',
        );
        try {
          const retried = await attempt(kept);
          if (retried.kind === 'kept') throw retried.error;
          return retried;
        } catch (error) {
          log(
            {
              user_id: orphan.user_id,
              namespace,
              consumer_id: kept.consumerId,
              stale_credential_ids: kept.staleCredentialIds,
              error: errorMessage(error),
            },
            'A consumer repair that lost its lease could not be completed: the consumer it ' +
              'recreated is kept, and its stale credential rows are still active and name keys ' +
              'the gateway does not hold; reconcile its credentials',
          );
          throw error;
        }
      };

      const first = await attempt(null);
      const outcome = first.kind === 'kept' ? await complete(first) : first;

      if (outcome.kind === 'gone') {
        return { ...base, error: 'The portal no longer holds a consumer row for this account' };
      }
      if (outcome.kind === 'present') {
        return {
          ...base,
          ferrum_consumer_id: outcome.consumerId,
          error: 'The gateway consumer already exists; nothing to repair',
        };
      }

      const repaired: RepairedGatewayConsumer = {
        ...base,
        ferrum_consumer_id: outcome.consumerId,
        credentials_requiring_reissue: outcome.revoked.length,
        restored_groups: groups.length,
      };
      if (outcome.revoked.length > 0) {
        // A courtesy, like every notification: the account holder has to learn
        // that their keys stopped working, and that new ones are theirs to mint.
        await notifications
          .notify(
            orphan.user_id,
            'system',
            'Gateway credentials must be re-issued',
            'The API gateway was rebuilt, so your existing credentials no longer exist on it. ' +
              'Your approved access has been restored; issue new credentials from the ' +
              'credentials page.',
            '/credentials',
          )
          .catch(() => undefined);
      }
      return repaired;
    } catch (error) {
      log(
        { user_id: orphan.user_id, namespace, error: errorMessage(error) },
        'Could not repair the gateway consumer for an account',
      );
      return { ...base, error: errorMessage(error) };
    }
  }

  /**
   * Clear one API's dead proxy id and record that it needs republishing.
   *
   * No gateway write at all: the proxy is already gone, and rebuilding it is
   * the publishing flow's job, not this endpoint's.
   *
   * The orphan it is handed comes from a pass that may predate what is true
   * now — `repair()` can join a pass already in flight — and a restore or an
   * operator can have put the deployment back since. Clearing the reference
   * then would leave a live proxy holding the listen path with no row pointing
   * at it, and the next restore would `409` against it (issue #342). So the
   * decision is re-made, not trusted:
   *
   * - under {@link apiRestoreLockKey}, the key `publishing.restoreGateway`
   *   holds from its missing-deployment check to its commit, so a restore is
   *   either wholly before this or wholly after it;
   * - with the gateway asked again, inside that key, whether the proxy is
   *   really gone — a `404` flags, a live proxy is left alone, and anything
   *   else is an error rather than an orphan;
   * - and with the row re-read, the reference cleared and the audit row
   *   written in one transaction, so the flag cannot commit without its record
   *   or land on a row whose reference has moved.
   */
  async function flagApi(
    actor: UserRecord,
    orphan: OrphanedProxyRef,
    reason: string | null,
    ip: string | null,
  ): Promise<FlaggedGatewayApi> {
    const base: FlaggedGatewayApi = {
      api_id: orphan.api_id,
      previous_ferrum_proxy_id: orphan.ferrum_proxy_id,
      flagged: false,
      error: null,
    };
    const moved = 'The API’s gateway proxy changed while the repair was running';
    try {
      const outcome = await edge.serializePerKey(apiRestoreLockKey(orphan.api_id), async () => {
        const current = await store.apis.findById(orphan.api_id);
        if (!current) return { kind: 'gone' } as const;
        if (current.ferrum_proxy_id !== orphan.ferrum_proxy_id) return { kind: 'moved' } as const;

        // Asked again, under the key: the pass's `404` may be minutes old. A
        // transport failure throws, and throws out of the repair of this API
        // only — an unreachable gateway is never evidence that a proxy is gone.
        if ((await edge.proxies.get(orphan.ferrum_proxy_id)) !== null) {
          return { kind: 'present' } as const;
        }

        // Both facts in one write, and the audit row with them. Clearing the
        // reference is what makes the rest of the portal stop addressing a
        // proxy that is not there; the state is what keeps "this API is not
        // deployed" true afterwards, so that the next pass does not read a
        // flagged API as a clean one (issue #284).
        const flagged = await store.transaction(async (tx) => {
          const api = await tx.apis.findById(orphan.api_id);
          if (!api || api.ferrum_proxy_id !== orphan.ferrum_proxy_id) return null;
          const updated = await tx.apis.update(api.id, {
            ferrum_proxy_id: null,
            gateway_state: 'repair_required',
          });
          if (!updated) return null;
          await audit.forStore(tx).record(
            { id: actor.id, role: actor.role },
            AuditAction.API_GATEWAY_REPAIR_REQUIRED,
            { type: 'api', id: api.id },
            {
              phase: 'orphaned_proxy',
              namespace,
              proxy_id: orphan.ferrum_proxy_id,
              slug: api.slug,
              spec_enforcement: api.spec_enforcement,
              ...(reason ? { reason } : {}),
            },
            ip,
          );
          return api;
        });
        if (!flagged) return { kind: 'moved' } as const;
        return { kind: 'flagged', api: flagged } as const;
      });

      if (outcome.kind === 'gone') {
        return { ...base, error: 'The portal no longer holds a row for this API' };
      }
      if (outcome.kind === 'moved') return { ...base, error: moved };
      if (outcome.kind === 'present') {
        return { ...base, error: 'The gateway serves this API’s proxy again; nothing to repair' };
      }

      const api = outcome.api;
      log(
        { api_id: api.id, slug: api.slug, proxy_id: orphan.ferrum_proxy_id },
        'Cleared a gateway proxy id the gateway no longer holds; the API needs its ' +
          'deployment restored',
      );
      await notifications
        .notify(
          api.owner_user_id,
          'system',
          'Gateway deployment missing',
          `The API gateway no longer serves “${api.name}”: its proxy went away when the ` +
            'gateway was rebuilt. Restore the gateway deployment to bring it back — the ' +
            'catalog entry, its specification history and every approved client keep working.',
          `/apis/${api.id}`,
        )
        .catch(() => undefined);
      return { ...base, flagged: true };
    } catch (error) {
      log(
        { api_id: orphan.api_id, error: errorMessage(error) },
        'Could not flag an API whose gateway proxy is gone',
      );
      return { ...base, error: errorMessage(error) };
    }
  }

  return {
    snapshot: () => cached,

    isRunning: () => timer !== null,

    scan: scanOnce,

    async repair(actor, input, ip = null): Promise<RepairGatewayReferencesResponse> {
      if (!roleAtLeast(actor.role, 'super_admin')) {
        throw forbidden('Only a super admin can repair the portal’s gateway references');
      }
      const all = input.all === true;
      const userIds = input.userIds ?? [];
      const apiIds = input.apiIds ?? [];
      if (!all && userIds.length === 0 && apiIds.length === 0) {
        throw validationFailed(
          'Name the accounts or APIs to repair, or set `all` to repair every orphan found',
        );
      }
      const reason = input.reason ?? null;

      // A repair always acts on a *fresh* pass. The cache exists so health can
      // be cheap; recreating a consumer on the strength of a fifteen-minute-old
      // reading is not what it is for.
      const report = await scanOnce();
      if (report.status === 'unknown') {
        // Never repair on a pass that could not read the gateway: every
        // reference would look orphaned, and the repair would recreate the
        // whole portal's gateway identities against a gateway that was only
        // briefly unreachable.
        throw edgeUnavailable(
          'The portal’s gateway references could not be checked, so there is nothing to ' +
            'repair yet; retry once the gateway answers',
        );
      }

      // Grouped by account rather than keyed by it: one account can have
      // several orphaned consumers — its own and one per application it owns —
      // and a map keyed on `user_id` silently kept only the last of them, so a
      // repair fixed one identity and left the rest orphaned (issue #289).
      const consumerOrphans = new Map<Uuid, OrphanedConsumerRef[]>();
      for (const orphan of report.orphaned_consumers) {
        const existing = consumerOrphans.get(orphan.user_id);
        if (existing) existing.push(orphan);
        else consumerOrphans.set(orphan.user_id, [orphan]);
      }
      const proxyOrphans = new Map<Uuid, OrphanedProxyRef>(
        report.orphaned_proxies.map((orphan) => [orphan.api_id, orphan]),
      );

      const consumers: RepairedGatewayConsumer[] = [];
      for (const userId of all ? [...consumerOrphans.keys()] : userIds) {
        const orphans = consumerOrphans.get(userId);
        if (!orphans || orphans.length === 0) {
          consumers.push({
            user_id: userId,
            application_id: null,
            previous_ferrum_consumer_id: '',
            ferrum_consumer_id: null,
            credentials_requiring_reissue: 0,
            restored_groups: 0,
            error: 'This account has no orphaned gateway consumer',
          });
          continue;
        }
        // Every identity of the account, each with its own approvals.
        for (const orphan of orphans) {
          consumers.push(await repairConsumer(actor, orphan, reason, ip));
        }
      }

      const apis: FlaggedGatewayApi[] = [];
      for (const apiId of all ? [...proxyOrphans.keys()] : apiIds) {
        const orphan = proxyOrphans.get(apiId);
        if (!orphan) {
          apis.push({
            api_id: apiId,
            previous_ferrum_proxy_id: '',
            flagged: false,
            error: 'This API has no orphaned gateway proxy',
          });
          continue;
        }
        apis.push(await flagApi(actor, orphan, reason, ip));
      }

      return { report, consumers, apis };
    },

    start(): void {
      if (timer !== null || intervalMs <= 0) return;
      timer = setInterval(poll, intervalMs);
      // Do not hold the event loop open just for the poller.
      timer.unref?.();
      // The pass that matters most: the one right after a restart, which is
      // when an operator has just changed `FERRUM_ADMIN_URL`.
      poll();
    },

    async stop(): Promise<void> {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      if (inFlight) {
        try {
          await inFlight;
        } catch {
          // `scanOnce()` already logs; stopping must not throw.
        }
      }
    },
  };
}
