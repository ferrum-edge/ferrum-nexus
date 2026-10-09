/**
 * Whether the gateway's data plane actually routes the namespace Nexus
 * publishes into.
 *
 * The Ferrum Edge **Admin API is multi-namespace**: it accepts a create under
 * any `X-Ferrum-Namespace` and stores it. A single gateway process's **data
 * plane is not** — it projects every configuration snapshot down to its own
 * `FERRUM_NAMESPACE` before building the router, plugin, consumer and
 * load-balancer caches. Write a proxy into any other namespace and the Admin
 * API answers `201`, `GET /proxies` lists it, and the listener answers `404`
 * forever. That is ferrum-nexus#230: a green portal in front of a dead
 * `invoke_url`.
 *
 * Edge publishes two signals for it, and this module folds both into one
 * verdict:
 *
 * 1. A `namespace` block on the **authenticated** `GET /health` — `active`,
 *    `serving_scope` and `data_plane_single_namespace`. Read on every probe,
 *    so `/api/health` refreshes the verdict and a startup probe seeds it.
 * 2. `X-Ferrum-Namespace-Unserved: true` on a **2xx** response to a mutating
 *    request the data plane will not serve. Belt and braces: it catches a
 *    gateway restarted into another namespace between two health probes, and
 *    it is the only signal a deployment without an admin-readable `/health`
 *    ever sees.
 *
 * **Feature detection is the whole contract.** A gateway older than the
 * `namespace` block simply has no opinion, so an absent block never degrades
 * the portal. Nor does it keep vouching for an earlier "served" reading: that
 * becomes unknown, while an earlier "unserved" one stands until the gateway
 * says otherwise. The header's only value is the literal string `true`; its
 * absence is never a positive assertion that the namespace *is* served.
 *
 * **Health tiers.** Edge v0.9.15 gives the portal's admin token its detailed
 * `/health` tier, block included. Edge v0.9.16 bounds a token with an `ns`
 * claim to a tenant tier that keeps the block but withholds `active` (sends
 * `null`, naming no other namespace) when the claim does not cover the
 * gateway's active namespace. A block that says the data plane is
 * single-namespace but withholds its name is therefore read as serving a
 * namespace this portal's claim does not cover. A tier with no block at all
 * (the minimal tier) is unknown, as above.
 */

import {
  FERRUM_NAMESPACE_UNSERVED_HEADER,
  type EdgeHealthReason,
  type EdgeNamespaceRouting,
} from '@ferrum-nexus/shared';

import { NexusError } from '../lib/errors.js';

/** Response header Edge stamps on an accepted write it will not route. */
export const NAMESPACE_UNSERVED_HEADER = FERRUM_NAMESPACE_UNSERVED_HEADER.toLowerCase();

/** The only value {@link NAMESPACE_UNSERVED_HEADER} ever carries. */
export const NAMESPACE_UNSERVED_HEADER_VALUE = 'true';

/** Reason code `GET /api/health` reports for an unrouted namespace. */
export const NAMESPACE_UNSERVED_REASON: EdgeHealthReason = 'namespace_unserved';

/** The `namespace` block of Edge's authenticated health payload, normalized. */
export interface EdgeNamespaceServing {
  /** The one namespace this process's data plane routes; `null` for a control plane. */
  active: string | null;
  /** `single-namespace-data-plane`, `control-plane` or `no-data-plane`. */
  servingScope: string | null;
  /** True when everything outside `active` is unrouted by this process. */
  dataPlaneSingleNamespace: boolean;
}

/**
 * Read Edge's `namespace` health block, or `null` when the gateway does not
 * publish one.
 *
 * Deliberately forgiving about *shape* and strict about *meaning*: an object
 * whose `data_plane_single_namespace` is not a boolean is treated as `false`,
 * because a gateway that cannot state the branch condition must not be turned
 * into a degradation. Anything that is not an object at all is `null`.
 *
 * The converse is deliberate too. Once the gateway *does* state
 * `data_plane_single_namespace: true`, an `active` that is missing, `null`,
 * empty or not a string reads as `null` — a name withheld from this portal's
 * token — and {@link namespaceUnserved} then degrades the portal and blocks
 * publishing. A gateway that says its data plane serves one namespace but not
 * which has not shown that it serves this one.
 */
export function parseNamespaceServing(raw: unknown): EdgeNamespaceServing | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const block = raw as Record<string, unknown>;
  return {
    active: typeof block.active === 'string' && block.active !== '' ? block.active : null,
    servingScope: typeof block.serving_scope === 'string' ? block.serving_scope : null,
    dataPlaneSingleNamespace: block.data_plane_single_namespace === true,
  };
}

/**
 * Whether `configured` is *provably* not routed by the gateway that reported
 * `serving`.
 *
 * Every clause has to hold: the gateway must publish the block, must say its
 * data plane is single-namespace, and the namespace it serves must differ. A
 * control plane (`active: null`, `data_plane_single_namespace: false`) serves
 * no traffic at all and is not a misconfiguration — it is the topology where
 * multi-namespace writes are the point.
 *
 * A single-namespace data plane always names its namespace in the detailed
 * tier. One that does not has withheld the name from this portal's
 * namespace-scoped token, which Edge does only when the token's claim — the
 * configured namespace — does not cover it.
 */
export function namespaceUnserved(
  configured: string,
  serving: EdgeNamespaceServing | null,
): boolean {
  if (serving === null) return false;
  if (!serving.dataPlaneSingleNamespace) return false;
  if (serving.active === null) return true;
  return serving.active !== configured;
}

/** Folds both of Edge's signals into one verdict, without doing any I/O. */
export interface NamespaceMonitor {
  /** The namespace Nexus writes into (`FERRUM_NAMESPACE`). */
  readonly configured: string;
  /** The current verdict. Never probes — callers are free to read it per request. */
  routing(): EdgeNamespaceRouting;
  /**
   * Fold in the `namespace` block of a health payload. `null` means the
   * gateway published none: that clears no "unserved" verdict and asserts
   * nothing, and an earlier "served" reading becomes unknown rather than
   * standing without fresh evidence.
   *
   * @param at epoch milliseconds the payload was read; defaults to now
   */
  observeHealth(serving: EdgeNamespaceServing | null, at?: number): EdgeNamespaceRouting;
  /**
   * Fold in an `X-Ferrum-Namespace-Unserved: true` seen on an accepted write.
   *
   * @returns `true` the first time it is seen, so the caller logs once per
   *   transition rather than once per write
   */
  observeUnservedMutation(at?: number): boolean;
}

/** Build the per-client namespace verdict holder. */
export function createNamespaceMonitor(configured: string): NamespaceMonitor {
  let serving: EdgeNamespaceServing | null = null;
  let mutationObserved = false;
  let checkedAt: number | null = null;

  function routing(): EdgeNamespaceRouting {
    return {
      configured,
      active: serving?.active ?? null,
      serving_scope: serving?.servingScope ?? null,
      data_plane_single_namespace: serving === null ? null : serving.dataPlaneSingleNamespace,
      unserved: namespaceUnserved(configured, serving) || mutationObserved,
      unserved_mutation_observed: mutationObserved,
      checked_at: checkedAt === null ? null : new Date(checkedAt).toISOString(),
    };
  }

  return {
    configured,

    routing,

    observeHealth(next, at = Date.now()): EdgeNamespaceRouting {
      if (next !== null) {
        serving = next;
        checkedAt = at;
        // The authenticated block is the authority. A gateway that now says it
        // serves this namespace supersedes a header seen before it was fixed;
        // without this the portal would stay degraded until it restarted.
        if (!namespaceUnserved(configured, next)) mutationObserved = false;
      } else if (serving !== null && !namespaceUnserved(configured, serving)) {
        // A gateway that stopped publishing the block (a token now held to the
        // minimal tier, say) no longer vouches for routing. Forget the served
        // reading; a degradation stays until positive evidence clears it.
        serving = null;
      }
      return routing();
    },

    observeUnservedMutation(at = Date.now()): boolean {
      checkedAt = at;
      if (mutationObserved) return false;
      mutationObserved = true;
      return true;
    },
  };
}

/**
 * The operator-facing sentence for an unrouted namespace.
 *
 * Names both namespaces and both ways out, because only an operator can fix
 * this and they need to choose which side moves. When the verdict came from
 * the response header alone, or the gateway withheld the name from this
 * portal's token, the gateway's own namespace is unknown, so the message points
 * at the call that reveals it — with a credential that can see it — instead of
 * inventing a name.
 */
export function namespaceUnservedMessage(routing: EdgeNamespaceRouting): string {
  const head =
    `Ferrum Nexus publishes into the Ferrum Edge namespace '${routing.configured}', which ` +
    'this gateway accepts but never routes: the Admin API is multi-namespace and a ' +
    'gateway process serves exactly one namespace, so the API would be created and its ' +
    'invoke_url would answer 404.';
  if (routing.active !== null) {
    return (
      `${head} The gateway's data plane serves '${routing.active}'. Set ` +
      `FERRUM_NAMESPACE=${routing.active} on the portal, or restart the gateway with ` +
      `FERRUM_NAMESPACE=${routing.configured}, then retry.`
    );
  }
  return (
    `${head} The gateway does not name its namespace to this portal's namespace-scoped ` +
    'token. Read it from GET /health (field `namespace.active`) with a fleet admin token, ' +
    'one without an `ns` claim, and set FERRUM_NAMESPACE to it on the portal, or restart ' +
    `the gateway with FERRUM_NAMESPACE=${routing.configured}, then retry.`
  );
}

/**
 * Refuse an operation that would create or move a proxy the data plane will
 * not serve.
 *
 * `409`, not `502`: the gateway is healthy and did nothing wrong — the two
 * deployments disagree about which namespace is live, and the request cannot
 * succeed in any useful sense until that is settled.
 *
 * @throws NexusError `EDGE_NAMESPACE_UNSERVED` (409)
 */
export function assertNamespaceServed(routing: EdgeNamespaceRouting): void {
  if (!routing.unserved) return;
  throw new NexusError('EDGE_NAMESPACE_UNSERVED', namespaceUnservedMessage(routing), {
    configured_namespace: routing.configured,
    active_namespace: routing.active,
    serving_scope: routing.serving_scope,
    setting: 'FERRUM_NAMESPACE',
  });
}
