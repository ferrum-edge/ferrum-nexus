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
 * An orphaned proxy is not recreated at all. Rebuilding one needs the
 * provider's current spec revision, upstream, plugin palette and enforcement
 * mode replayed in order, which is exactly what publishing already does — so
 * the repair clears the dead `ferrum_proxy_id` and leaves the API in the state
 * the rest of the portal already models as "has no gateway proxy"
 * (`plugins/service.ts` refuses to attach to one; `publishing/service.ts`
 * skips every proxy write for one). The provider republishes through the
 * ordinary flow, and the incident is recorded as an
 * {@link AuditAction.API_GATEWAY_REPAIR_REQUIRED} row with
 * `phase: 'orphaned_proxy'` — the same action the publishing lifecycle already
 * writes for an API whose gateway objects need rebuilding, rather than a second
 * state machine saying the same thing.
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

  async function runScan(): Promise<GatewayReconciliationReport> {
    const checkedAt = new Date().toISOString();
    const orphanedConsumers: OrphanedConsumerRef[] = [];
    const orphanedProxies: OrphanedProxyRef[] = [];
    try {
      const consumers = await scanConsumers(orphanedConsumers);
      const proxies = await scanProxies(orphanedProxies);
      const orphaned = consumers.orphaned + proxies.orphaned;
      const report: GatewayReconciliationReport = {
        status: orphaned > 0 ? 'orphaned' : 'ok',
        checked_at: checkedAt,
        namespace,
        consumers,
        proxies,
        orphaned_consumers: orphanedConsumers,
        orphaned_proxies: orphanedProxies,
        error: null,
      };
      if (orphaned > 0) {
        // The line to alert on: the portal is pointing at a gateway that does
        // not hold what it stored, and nothing repairs that by itself.
        log(
          {
            namespace,
            orphaned_consumers: consumers.orphaned,
            orphaned_proxies: proxies.orphaned,
            checked_consumers: consumers.checked,
            checked_proxies: proxies.checked,
          },
          'The gateway no longer holds references the portal stored; run the gateway repair',
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
        status: 'unknown',
        checked_at: checkedAt,
        namespace,
        consumers: { checked: 0, orphaned: 0, complete: false },
        proxies: { checked: 0, orphaned: 0, complete: false },
        orphaned_consumers: [],
        orphaned_proxies: [],
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
   * The ACL groups this account should carry, from the portal's own grants.
   *
   * Rebuilt from `grants` rather than remembered, because the portal's grant
   * rows are the record of who was approved for what — the gateway's copy is
   * the thing that was lost.
   */
  async function approvedGroups(userId: Uuid): Promise<string[]> {
    const groups: string[] = [];
    for (let offset = 0; ; offset += MAX_PAGE_SIZE) {
      const page = await store.grants.list(
        { user_id: userId, status: 'active' },
        { limit: MAX_PAGE_SIZE, offset },
      );
      for (const grant of page.items) groups.push(aclGroupForApi(grant.api_id));
      if (page.items.length === 0 || offset + page.items.length >= page.total) return groups;
    }
  }

  /**
   * Recreate one account's gateway consumer and re-link the portal row.
   *
   * Takes the provisioning key `ensureConsumer` uses before the stored
   * consumer-id key used by every ordinary mutation. Keeping that lock order
   * makes recreation race-free with both provisioning and credential/ACL
   * changes while the portal still exposes the stale id.
   */
  async function repairConsumer(
    actor: UserRecord,
    orphan: OrphanedConsumerRef,
    reason: string | null,
    ip: string | null,
  ): Promise<RepairedGatewayConsumer> {
    const base: RepairedGatewayConsumer = {
      user_id: orphan.user_id,
      previous_ferrum_consumer_id: orphan.ferrum_consumer_id,
      ferrum_consumer_id: null,
      credentials_requiring_reissue: 0,
      restored_groups: 0,
      error: null,
    };
    try {
      const groups = await approvedGroups(orphan.user_id);
      const outcome = await edge.serializePerKey(
        canonicalConsumerLockKey(namespace, orphan.ferrum_username),
        async () => {
          // Re-read inside the critical section: another repair, or an ordinary
          // provisioning call, may have rebuilt this consumer already.
          const row = await store.consumers.findByUserAndNamespace(orphan.user_id, namespace);
          if (!row) return { kind: 'gone' } as const;
          const staleId = row.ferrum_consumer_id;
          return edge.serializePerKey(staleId, async () => {
            if ((await edge.consumers.get(staleId)) !== null) {
              return { kind: 'present', consumerId: staleId } as const;
            }

            const { consumer } = await edge.consumers.ensure(
              {
                username: row.ferrum_username,
                custom_id: orphan.user_id,
                acl_groups: groups,
              },
              actor.id,
            );

            // Gateway first, then the portal — and both store writes together, so
            // a relink can never commit without the revocations that make the
            // credential mirror agree with the empty consumer it now points at.
            const revoked = await store.transaction(async (tx) => {
              if (consumer.id !== staleId) {
                await tx.consumers.update(row.id, { ferrum_consumer_id: consumer.id });
              }
              const ids: Uuid[] = [];
              for (let offset = 0; ; offset += MAX_PAGE_SIZE) {
                const page = await tx.credentials.list(
                  { ferrum_consumer_id: staleId },
                  { limit: MAX_PAGE_SIZE, offset },
                );
                for (const credential of page.items) {
                  if (!LIVE_CREDENTIAL_STATUSES.has(credential.status)) continue;
                  await tx.credentials.update(credential.id, { status: 'revoked' });
                  ids.push(credential.id);
                }
                if (page.items.length === 0 || offset + page.items.length >= page.total) break;
              }
              return ids;
            });

            return { kind: 'repaired', consumerId: consumer.id, revoked } as const;
          });
        },
      );

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
      await audit.record(
        { id: actor.id, role: actor.role },
        AuditAction.GATEWAY_CONSUMER_REPAIR,
        { type: 'user', id: orphan.user_id },
        {
          namespace,
          previous_consumer_id: orphan.ferrum_consumer_id,
          consumer_id: outcome.consumerId,
          ferrum_username: orphan.ferrum_username,
          restored_groups: groups.length,
          revoked_credentials: outcome.revoked.length,
          revoked_credential_ids: outcome.revoked,
          ...(reason ? { reason } : {}),
        },
        ip,
      );
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
    try {
      const api = await store.apis.findById(orphan.api_id);
      if (!api) return { ...base, error: 'The portal no longer holds a row for this API' };
      if (api.ferrum_proxy_id !== orphan.ferrum_proxy_id) {
        return { ...base, error: 'The API’s gateway proxy changed while the repair was running' };
      }
      await store.apis.update(api.id, { ferrum_proxy_id: null });
      await audit.record(
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
      log(
        { api_id: api.id, slug: api.slug, proxy_id: orphan.ferrum_proxy_id },
        'Cleared a gateway proxy id the gateway no longer holds; the API must be republished',
      );
      await notifications
        .notify(
          api.owner_user_id,
          'system',
          'Republish required',
          `The API gateway no longer serves “${api.name}”: its proxy went away when the ` +
            'gateway was rebuilt. Publish it again to restore traffic.',
          '/apis',
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

      const consumerOrphans = new Map<Uuid, OrphanedConsumerRef>(
        report.orphaned_consumers.map((orphan) => [orphan.user_id, orphan]),
      );
      const proxyOrphans = new Map<Uuid, OrphanedProxyRef>(
        report.orphaned_proxies.map((orphan) => [orphan.api_id, orphan]),
      );

      const consumers: RepairedGatewayConsumer[] = [];
      for (const userId of all ? [...consumerOrphans.keys()] : userIds) {
        const orphan = consumerOrphans.get(userId);
        if (!orphan) {
          consumers.push({
            user_id: userId,
            previous_ferrum_consumer_id: '',
            ferrum_consumer_id: null,
            credentials_requiring_reissue: 0,
            restored_groups: 0,
            error: 'This account has no orphaned gateway consumer',
          });
          continue;
        }
        consumers.push(await repairConsumer(actor, orphan, reason, ip));
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
