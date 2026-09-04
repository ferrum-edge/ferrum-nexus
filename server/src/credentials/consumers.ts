/**
 * The Nexus-user → Ferrum-consumer mapping, and the only place it is created.
 *
 * Two services need a user's Edge consumer: **credentials** (to hang API keys
 * off it) and **access** (to add and remove the `nexus:api:<id>:approved` ACL
 * group). Both would otherwise race to create the same consumer the first time
 * a brand-new user is approved *and* issues a key, so the provisioning logic
 * lives here once and both take it as a dependency.
 *
 * ## Naming and identity
 *
 * - `username` is `nexus-user-<user_id>` ({@link consumerUsernameForUser}).
 *   `access_control` matches usernames byte-for-byte, so it is never derived
 *   from anything user-editable.
 * - `custom_id` is the raw Nexus user id, giving operators a reverse lookup
 *   from the gateway back into the portal.
 * - Edge assigns the consumer `id`; Nexus caches it in the `consumers` table so
 *   the hot paths never scan `GET /consumers`.
 *
 * ## Serialisation
 *
 * `PUT /consumers/{id}` is a whole-resource replace with no concurrency token
 * (`ref-edge-admin.md` §4.4/§7.2), so **every** consumer mutation goes through
 * `edge.serializePerKey(consumerId, …)`. Two approvals for the same user
 * landing at once would otherwise lose one ACL group. {@link mutateAclGroups}
 * is the read-modify-write helper both services use.
 *
 * The **Ferrum consumer id** is the canonical lock key for a consumer, used by
 * every path that touches one — this helper, and issue/rotate/revoke/teardown
 * in `credentials/service.ts`. That matters because the serializer now takes an
 * `edge_leases` row for the key as well as queueing in process, so a second
 * Nexus instance is ordered against this one only if it locks the same string.
 */

import { consumerUsernameForUser, type Uuid } from '@ferrum-nexus/shared';

import type { NexusConfig } from '../config/index.js';
import type { ConsumerRecord, NexusStore, UserRecord } from '../db/store.js';
import type { FerrumAdminClient } from '../ferrum-admin/index.js';
import type { EdgeConsumer } from '../ferrum-admin/types.js';
import { edgeError } from '../lib/errors.js';

/** Provisioning and ACL-group maintenance for Edge consumers. */
export interface ConsumerProvisioner {
  /**
   * The user's Edge consumer, creating it (and its cached row) when this is the
   * first time Nexus has needed it.
   */
  ensureConsumer(user: Pick<UserRecord, 'id'>): Promise<ConsumerRecord>;
  /** The cached mapping for a user, or `null` when they have no consumer yet. */
  findConsumer(userId: Uuid): Promise<ConsumerRecord | null>;
  /**
   * Read-modify-write the consumer's `acl_groups`, serialised per consumer.
   *
   * The body sent back is built from the `GET` response, so redacted credential
   * placeholders round-trip intact (§4.4) and no API key is ever dropped.
   */
  mutateAclGroups(
    ferrumConsumerId: string,
    change: (groups: string[]) => string[],
    subject?: string,
  ): Promise<EdgeConsumer>;
}

/** Dependencies of {@link createConsumerProvisioner}. */
export interface ConsumerProvisionerDeps {
  config: NexusConfig;
  store: NexusStore;
  edge: FerrumAdminClient;
}

/** Build the consumer provisioner. */
export function createConsumerProvisioner(deps: ConsumerProvisionerDeps): ConsumerProvisioner {
  const { config, store, edge } = deps;
  const namespace = config.edge.namespace;

  return {
    async findConsumer(userId): Promise<ConsumerRecord | null> {
      return store.consumers.findByUserAndNamespace(userId, namespace);
    },

    async ensureConsumer(user): Promise<ConsumerRecord> {
      const cached = await store.consumers.findByUserAndNamespace(user.id, namespace);
      if (cached) return cached;

      const username = consumerUsernameForUser(user.id);
      // Reconciliation path: a consumer can exist on the gateway without a
      // Nexus row after a database restore, and re-creating it would 409.
      const existing = await edge.consumers.getByUsername(username);
      const consumer =
        existing ??
        (await edge.consumers.create({ username, custom_id: user.id, acl_groups: [] }, user.id));

      return store.consumers.create({
        user_id: user.id,
        namespace,
        ferrum_consumer_id: consumer.id,
        ferrum_username: consumer.username,
      });
    },

    async mutateAclGroups(ferrumConsumerId, change, subject): Promise<EdgeConsumer> {
      return edge.serializePerKey(ferrumConsumerId, async () => {
        const current = await edge.consumers.get(ferrumConsumerId);
        if (!current) {
          throw edgeError('The gateway consumer for this account no longer exists', {
            consumer_id: ferrumConsumerId,
          });
        }
        const groups = change([...(current.acl_groups ?? [])]);
        return edge.consumers.replace(
          ferrumConsumerId,
          {
            id: current.id,
            username: current.username,
            custom_id: current.custom_id ?? null,
            credentials: current.credentials,
            acl_groups: groups,
          },
          subject,
        );
      });
    },
  };
}

/** Add `group` to `groups` if absent, preserving order. */
export function withGroup(groups: string[], group: string): string[] {
  return groups.includes(group) ? groups : [...groups, group];
}

/** Remove every occurrence of `group` from `groups`. */
export function withoutGroup(groups: string[], group: string): string[] {
  return groups.filter((entry) => entry !== group);
}
