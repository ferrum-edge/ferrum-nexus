/**
 * The Nexus-identity → Ferrum-consumer mapping, and the only place it is
 * created.
 *
 * Two services need a user's Edge consumer: **credentials** (to hang API keys
 * off it) and **access** (to add and remove the `nexus:api:<id>:approved` ACL
 * group). Both would otherwise race to create the same consumer the first time
 * a brand-new user is approved *and* issues a key, so the provisioning logic
 * lives here once and both take it as a dependency.
 *
 * ## Naming and identity
 *
 * - `username` is `nexus-user-<user_id>` ({@link consumerUsernameForUser}) for
 *   an account's own identity, and `nexus-app-<application_id>`
 *   ({@link consumerUsernameForApplication}) for one of its applications.
 *   `access_control` matches usernames byte-for-byte, so neither is ever
 *   derived from anything user-editable.
 * - `custom_id` is the raw Nexus id the username names, giving operators a
 *   reverse lookup from the gateway back into the portal.
 *
 * ## Why an application is a *separate consumer*
 *
 * It is what makes two applications of one owner genuinely separate rather
 * than separate-looking. ACL groups live on the consumer, so an account with
 * one consumer has one permission set however many credentials it holds —
 * every key inherits every group. Giving each application its own identity
 * puts the boundary where Edge enforces it (issue #289). `user_id` on the row
 * is still the owner, so every teardown, repair and audit that walks an
 * account's consumers finds its applications' too.
 * - Nexus derives the consumer `id` and caches it in the `consumers` table so
 *   the hot paths never scan `GET /consumers`.
 *
 * ## Serialisation
 *
 * `PUT /consumers/{id}` is a whole-resource replace with no concurrency token
 * (Edge `docs/admin_api.md`, "Replace semantics for `PUT`"), so **every**
 * consumer mutation goes through `edge.serializePerKey(consumerId, …)`. Two
 * approvals for the same user landing at once would otherwise lose one ACL
 * group. {@link mutateAclGroups} is the read-modify-write helper both services
 * use.
 *
 * The **Ferrum consumer id** is the canonical lock key for a consumer, used by
 * every path that touches one — this helper, and issue/rotate/revoke/teardown
 * in `credentials/service.ts`. That matters because the serializer now takes an
 * `edge_leases` row for the key as well as queueing in process, so a second
 * Nexus instance is ordered against this one only if it locks the same string.
 *
 * Before an identity has an id, its key is the **provisioning name key**
 * ({@link canonicalConsumerLockKey}): {@link ConsumerProvisioner.ensureConsumer}
 * holds it while it creates the consumer and records the mapping, and an
 * application delete holds it for the whole of the deletion, so the two are
 * ordered and neither can leave the other an identity to orphan. The lock
 * order is always name key, then consumer id key — never the reverse.
 */

import {
  MAX_PAGE_SIZE,
  consumerUsernameForApplication,
  consumerUsernameForUser,
  type Uuid,
} from '@ferrum-nexus/shared';

import type { NexusConfig } from '../config/index.js';
import type { ConsumerRecord, NexusStore, UserRecord } from '../db/store.js';
import type { FerrumAdminClient } from '../ferrum-admin/index.js';
import type { EdgeConsumer } from '../ferrum-admin/types.js';
import { conflict, edgeError, notFound, userDisabled } from '../lib/errors.js';

/** Provisioning and ACL-group maintenance for Edge consumers. */
export interface ConsumerProvisioner {
  /**
   * The identity's Edge consumer, creating it (and its cached row) when this
   * is the first time Nexus has needed it.
   *
   * `applicationId` selects the identity: `null` or omitted is the account's
   * own canonical consumer, an id is that application's. The application must
   * exist, be owned by `user` and be `active`; that is re-checked **inside**
   * the provisioning name key — the key an application delete holds — so a
   * delete or disable that lands after the caller loaded it is refused
   * (`NOT_FOUND` / `CONFLICT`) rather than provisioned (issue #341).
   */
  ensureConsumer(
    user: Pick<UserRecord, 'id'>,
    applicationId?: Uuid | null,
  ): Promise<ConsumerRecord>;
  /**
   * The cached mapping for one identity, or `null` when it has no consumer
   * yet. Same `applicationId` convention as {@link ensureConsumer}.
   */
  findConsumer(userId: Uuid, applicationId?: Uuid | null): Promise<ConsumerRecord | null>;
  /** Every consumer this account owns, its own and its applications'. */
  listConsumers(userId: Uuid): Promise<ConsumerRecord[]>;
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
    options?: MutateAclGroupsOptions,
  ): Promise<EdgeConsumer>;
}

/** Extra conditions {@link ConsumerProvisioner.mutateAclGroups} checks. */
export interface MutateAclGroupsOptions {
  /**
   * Refuse the write unless this account is still `active`, checked **inside**
   * the critical section.
   *
   * An approval that passed authorisation before its grantee was disabled is
   * still a valid request when it reaches the front of the consumer queue, and
   * adding a group there re-authorises an account the teardown has already
   * stripped. Pass the grantee's id on every path that *adds* a group;
   * removals are always safe and never need it.
   */
  requireActiveUser?: Uuid;
}

/** Dependencies of {@link createConsumerProvisioner}. */
export interface ConsumerProvisionerDeps {
  config: NexusConfig;
  store: NexusStore;
  edge: FerrumAdminClient;
}

/** Stable provisioning key, disjoint from gateway-assigned consumer ids. */
export function canonicalConsumerLockKey(namespace: string, username: string): string {
  return `consumer-name:${JSON.stringify([namespace, username])}`;
}

/** Build the consumer provisioner. */
export function createConsumerProvisioner(deps: ConsumerProvisionerDeps): ConsumerProvisioner {
  const { config, store, edge } = deps;
  const namespace = config.edge.namespace;

  /**
   * Refuse to provision an application identity that is gone, not `owner`'s,
   * or disabled. Fails closed: every one of those is `NOT_FOUND` or
   * `CONFLICT`, never a consumer.
   */
  async function assertApplicationUsable(owner: Uuid, applicationId: Uuid): Promise<void> {
    const application = await store.applications.findById(applicationId);
    if (!application || application.owner_user_id !== owner) {
      throw notFound('Application', applicationId);
    }
    if (application.status !== 'active') {
      throw conflict('This application is disabled', { application_id: applicationId });
    }
  }

  return {
    async findConsumer(userId, applicationId = null): Promise<ConsumerRecord | null> {
      return store.consumers.findByUserAndNamespace(userId, namespace, applicationId);
    },

    async listConsumers(userId): Promise<ConsumerRecord[]> {
      const rows: ConsumerRecord[] = [];
      let offset = 0;
      for (;;) {
        const page = await store.consumers.list(
          { user_id: userId, namespace },
          { limit: MAX_PAGE_SIZE, offset },
        );
        rows.push(...page.items);
        offset += page.items.length;
        if (page.items.length === 0 || offset >= page.total) return rows;
      }
    },

    async ensureConsumer(user, applicationId = null): Promise<ConsumerRecord> {
      // The id does not exist yet. Use a namespace/name key until the remote
      // identity and local mapping are both durable, then release it before
      // callers take the canonical consumer-id mutation key.
      //
      // The username is derived from the *identity*, not from the account: an
      // application's consumer is `nexus-app-<application_id>`, and
      // `custom_id` names the same id, so an operator reading the gateway can
      // tell an application identity from an account one without the portal.
      const username =
        applicationId === null
          ? consumerUsernameForUser(user.id)
          : consumerUsernameForApplication(applicationId);
      const customId = applicationId ?? user.id;
      return edge.serializePerKey(canonicalConsumerLockKey(namespace, username), async () => {
        // The application is re-read *inside* the name key, because that key
        // is what `ApplicationsService.remove` holds for the whole of a
        // deletion. The caller's copy was loaded before this section was
        // entered, and acting on it is how a delete landing in between left
        // an Edge consumer nothing in the portal tracks: created here, then
        // refused a mapping by the SQL foreign key — or, on MongoDB, which
        // has none, given a mapping for an application that no longer exists.
        // Checked before the cached mapping too, so a stale caller cannot be
        // handed an identity whose application is gone or disabled.
        if (applicationId !== null) await assertApplicationUsable(user.id, applicationId);

        const cached = await store.consumers.findByUserAndNamespace(
          user.id,
          namespace,
          applicationId,
        );
        if (cached) return cached;

        // A mapping insert that fails after this leaves an empty consumer at
        // the *derived* id, which the next call adopts without a scan and
        // which an application delete finds the same way when there is no
        // mapping to read it from.
        const { consumer } = await edge.consumers.ensure(
          { username, custom_id: customId, acl_groups: [] },
          user.id,
        );

        return store.consumers.create({
          user_id: user.id,
          application_id: applicationId,
          namespace,
          ferrum_consumer_id: consumer.id,
          ferrum_username: consumer.username,
        });
      });
    },

    async mutateAclGroups(ferrumConsumerId, change, subject, options): Promise<EdgeConsumer> {
      return edge.serializePerKey(ferrumConsumerId, async () => {
        const requiredActive = options?.requireActiveUser;
        if (requiredActive !== undefined) {
          const owner = await store.users.findById(requiredActive);
          if (!owner || owner.status !== 'active') {
            throw userDisabled(
              'This account has been disabled; its gateway access cannot be extended',
            );
          }
        }
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
