/**
 * Application identities — one integration of an account, with its own
 * approved APIs and its own credentials (issue #289).
 *
 * ## What an application is, and what it is not
 *
 * It is a **separate gateway identity** owned by a portal account. It gets its
 * own Ferrum consumer (`nexus-app-<application_id>`), its own access requests
 * and grants, and its own credentials. Because ACL groups live on the
 * consumer, that is what makes two applications of one owner genuinely unable
 * to call each other's APIs — the boundary is enforced by Edge's matching, not
 * by the portal choosing what to show.
 *
 * It is **not** a tenant, a team, or an organization. It has exactly one
 * owner, it cannot be shared, and nothing about it is hierarchical. That is
 * deliberate: the thing being solved is least privilege between one
 * developer's own integrations.
 *
 * ## Compatibility is the default
 *
 * Account-scoped access is unchanged. Every scoped row carries a nullable
 * `application_id`, `null` means "the account itself", and that is what every
 * row written before applications existed is. Nothing migrates on its own, and
 * a deployed integration using an account credential goes on working exactly
 * as it did. An operator who wants an existing integration moved does it by
 * creating an application, requesting access for it and issuing it a
 * credential — a deliberate act with a new secret, never a silent re-pointing
 * of the one already deployed.
 *
 * ## Disable and delete
 *
 * `disabled` is the reversible option: the rows and the gateway identity stay,
 * and new requests, approvals and credentials are refused. **It does not
 * revoke anything** — an application whose credentials must stop working is
 * deleted, or has its grants revoked, and the audit row says so rather than
 * leaving an operator to assume otherwise.
 *
 * `delete` is destructive and takes the gateway identity with it: the consumer
 * is deleted on Edge first, then the row, whose cascade removes the grants,
 * requests, credentials and consumer mapping. Gateway first, because a row
 * deleted before its consumer leaves a live identity nothing in the portal can
 * find — the same ordering every teardown in this codebase uses. The whole
 * delete holds the identity's provisioning name key, the one a first approval
 * or credential provisions the consumer under, so the two can never interleave
 * into a consumer that outlives its application (issue #341).
 */

import {
  MAX_PAGE_SIZE,
  clampPageSize,
  consumerUsernameForApplication,
  roleAtLeast,
  type Application,
  type ApplicationStatus,
  type ApplicationSummary,
  type Paginated,
  type Uuid,
} from '@ferrum-nexus/shared';

import { AuditAction, type AuditService } from '../audit/service.js';
import type { NexusConfig } from '../config/index.js';
import { canonicalConsumerLockKey, type ConsumerProvisioner } from '../credentials/consumers.js';
import type { ApplicationRecord, ListOptions, NexusStore, UserRecord } from '../db/store.js';
import type { FerrumAdminClient } from '../ferrum-admin/index.js';
import { conflict, forbidden, notFound, quotaExceeded, validationFailed } from '../lib/errors.js';

/** Creating an application. */
export interface CreateApplicationInput {
  name: string;
  description?: string | null;
}

/** Changing one. */
export interface UpdateApplicationInput {
  name?: string;
  description?: string | null;
  status?: ApplicationStatus;
}

/** Filters accepted by {@link ApplicationsService.list}. */
export interface ApplicationListFilter {
  /** Admin-only: somebody else's applications. Clients always see their own. */
  owner_user_id?: Uuid;
  /**
   * Only the actor's own, even for an admin. An identity picker wants exactly
   * this: {@link ApplicationsService.resolveForActor} refuses anybody else's.
   */
  mine?: boolean;
  status?: ApplicationStatus;
  q?: string;
}

/** Managing application identities. */
export interface ApplicationsService {
  list(
    actor: UserRecord,
    filter?: ApplicationListFilter,
    options?: ListOptions,
  ): Promise<Paginated<Application>>;
  get(actor: UserRecord, applicationId: Uuid): Promise<Application>;
  create(
    actor: UserRecord,
    input: CreateApplicationInput,
    ip?: string | null,
  ): Promise<Application>;
  update(
    actor: UserRecord,
    applicationId: Uuid,
    patch: UpdateApplicationInput,
    ip?: string | null,
  ): Promise<Application>;
  /** Delete the application and its gateway identity. Destructive. */
  remove(
    actor: UserRecord,
    applicationId: Uuid,
    ip?: string | null,
  ): Promise<{ revoked_grants: number; revoked_credentials: number }>;
  /**
   * Resolve an application the actor may act as, for the access and credential
   * paths.
   *
   * `null` passes through as `null` — the account's own identity, which every
   * account always has. Anything else must exist, be owned by the actor (an
   * administrator acting on somebody else's behalf is deliberately *not*
   * allowed here: issuing a credential as somebody's application would hand an
   * admin a secret that authenticates as them), and be `active`.
   */
  resolveForActor(actor: UserRecord, applicationId: Uuid | null): Promise<ApplicationRecord | null>;
  /** The compact form embedded in requests, grants and credentials. */
  summarize(record: ApplicationRecord): ApplicationSummary;
}

/** Dependencies of {@link createApplicationsService}. */
export interface ApplicationsServiceDeps {
  config: NexusConfig;
  store: NexusStore;
  edge: FerrumAdminClient;
  audit: AuditService;
  provisioner: ConsumerProvisioner;
  log?: (obj: Record<string, unknown>, message: string) => void;
}

/** Build the applications service. */
export function createApplicationsService(deps: ApplicationsServiceDeps): ApplicationsService {
  const { config, store, edge, audit, provisioner } = deps;

  function summarize(record: ApplicationRecord): ApplicationSummary {
    return {
      id: record.id,
      name: record.name,
      owner_user_id: record.owner_user_id,
      status: record.status,
    };
  }

  /** The row, plus the owner-or-admin check every read and write shares. */
  async function load(actor: UserRecord, applicationId: Uuid): Promise<ApplicationRecord> {
    const application = await store.applications.findById(applicationId);
    if (!application) throw notFound('Application', applicationId);
    if (application.owner_user_id !== actor.id && !roleAtLeast(actor.role, 'admin')) {
      // `NOT_FOUND`, not `FORBIDDEN`: an application id is not a secret, but
      // confirming that somebody else's exists is not this endpoint's to do.
      throw notFound('Application', applicationId);
    }
    return application;
  }

  /** Counts the list and detail reads attach, so the UI needs no second call. */
  async function counts(
    applicationId: Uuid,
  ): Promise<{ active_grants: number; active_credentials: number }> {
    const [grants, credentials] = await Promise.all([
      store.grants.count({ application_id: applicationId, status: 'active' }),
      store.credentials
        .list({ application_id: applicationId, status: 'active' }, { limit: 1, offset: 0 })
        .then((page) => page.total),
    ]);
    return { active_grants: grants, active_credentials: credentials };
  }

  async function present(record: ApplicationRecord): Promise<Application> {
    return { ...record, ...(await counts(record.id)) };
  }

  function normalizeName(raw: string): string {
    const name = raw.trim();
    if (name === '') throw validationFailed('An application name is required');
    if (name.length > 120) throw validationFailed('An application name may be 120 characters');
    return name;
  }

  return {
    summarize,

    async list(actor, filter = {}, options): Promise<Paginated<Application>> {
      // A client only ever sees their own; `owner_user_id` is the admin's
      // opt-in, exactly as it is on the API listing.
      const isAdmin = roleAtLeast(actor.role, 'admin');
      const owner = isAdmin && filter.mine !== true ? filter.owner_user_id : actor.id;
      const page = await store.applications.list(
        {
          ...(owner !== undefined ? { owner_user_id: owner } : {}),
          ...(filter.status !== undefined ? { status: filter.status } : {}),
          ...(filter.q !== undefined ? { q: filter.q } : {}),
        },
        { limit: clampPageSize(options?.limit), offset: Math.max(0, options?.offset ?? 0) },
      );
      return { items: await Promise.all(page.items.map(present)), total: page.total };
    },

    async get(actor, applicationId): Promise<Application> {
      return present(await load(actor, applicationId));
    },

    async create(actor, input, ip = null): Promise<Application> {
      const name = normalizeName(input.name);
      // Bounded for the same reason APIs are: each application is a gateway
      // consumer, and an unbounded number of them is an unbounded number of
      // Edge resources one account can create.
      const limit = config.maxApplicationsPerOwner;
      const created = await edge.serializePerKey(`application-owner:${actor.id}`, async () => {
        if (limit > 0) {
          const current = await store.applications.count({ owner_user_id: actor.id });
          if (current >= limit) {
            throw quotaExceeded('You have reached the maximum number of applications', {
              limit,
              current,
              setting: 'NEXUS_MAX_APPLICATIONS_PER_OWNER',
            });
          }
        }

        return store.applications.create({
          owner_user_id: actor.id,
          name,
          description: input.description?.trim() || null,
          status: 'active',
        });
      });

      // The gateway identity is *not* created here. An application with no
      // approved APIs and no credentials has nothing for a consumer to carry,
      // and creating one eagerly would put an empty identity on the gateway
      // for every application anybody ever tried out. It is provisioned by the
      // first approval or the first credential, exactly as an account's is.
      await audit.record(
        { id: actor.id, role: actor.role },
        AuditAction.APPLICATION_CREATE,
        { type: 'application', id: created.id },
        { name: created.name },
        ip,
      );
      return present(created);
    },

    async update(actor, applicationId, patch, ip = null): Promise<Application> {
      const application = await load(actor, applicationId);
      const changes: Partial<ApplicationRecord> = {};
      if (patch.name !== undefined) changes.name = normalizeName(patch.name);
      if (patch.description !== undefined) {
        changes.description = patch.description?.trim() || null;
      }
      if (patch.status !== undefined) changes.status = patch.status;
      if (Object.keys(changes).length === 0) return present(application);

      const updated = (await store.applications.update(application.id, changes)) ?? application;
      await audit.record(
        { id: actor.id, role: actor.role },
        AuditAction.APPLICATION_UPDATE,
        { type: 'application', id: application.id },
        {
          name: updated.name,
          ...(changes.status !== undefined ? { status: changes.status } : {}),
          // Disabling stops the application acquiring *new* access and new
          // credentials. It deliberately revokes nothing: an integration that
          // must stop working is deleted, or has its grants revoked, and an
          // operator reading this row should not have to guess which happened.
          ...(changes.status === 'disabled' ? { revoked_existing_access: false } : {}),
        },
        ip,
      );
      return present(updated);
    },

    async remove(
      actor,
      applicationId,
      ip = null,
    ): Promise<{ revoked_grants: number; revoked_credentials: number }> {
      await load(actor, applicationId);
      const username = consumerUsernameForApplication(applicationId);

      // The whole delete runs under the identity's provisioning name key —
      // the key `ensureConsumer` holds while it creates the consumer and
      // records the mapping (issue #341). Without it, a delete that read "no
      // mapping yet" while a first credential or approval was provisioning
      // one deleted the rows by cascade and left a live consumer, with a
      // working key on it, that nothing in the portal tracks and no account
      // disable would ever find. `ensureConsumer` re-reads the application
      // under the same key, so whichever of the two goes second sees the
      // other's work: a provisioning that follows this is refused, and this
      // delete, following a provisioning, finds the mapping it wrote.
      const outcome = await edge.serializePerKey(
        canonicalConsumerLockKey(config.edge.namespace, username),
        async () => {
          // Re-read under the key: a concurrent delete may have finished.
          const application = await load(actor, applicationId);
          const mapped = await provisioner.findConsumer(application.owner_user_id, application.id);

          // No mapping is not proof of no consumer. A provisioning whose
          // mapping insert failed left one at the id Nexus derives from the
          // username, and it is ours by construction — so look there before
          // concluding there is nothing on the gateway to take down. Only a
          // consumer that still carries this identity's username is touched.
          let consumerId = mapped?.ferrum_consumer_id ?? null;
          let unmapped = false;
          if (consumerId === null) {
            const derivedId = edge.consumers.derivedId(username);
            const live = await edge.consumers.get(derivedId);
            if (live && live.username === username) {
              consumerId = derivedId;
              unmapped = true;
            }
          }

          const drop = async (): Promise<{ grants: number; credentials: number }> => {
            const grants = await store.grants.count({
              application_id: application.id,
              status: 'active',
            });
            const credentials = await store.credentials
              .list({ application_id: application.id, status: 'active' }, { limit: 1, offset: 0 })
              .then((page) => page.total);
            // The row's cascade takes the grants, requests, credential rows
            // and the consumer mapping with it.
            await store.applications.delete(application.id);
            return { grants, credentials };
          };

          // Gateway first. A row deleted before its consumer leaves a live
          // identity — with its ACL groups and its credential material — that
          // nothing in the portal can find any more, which is strictly worse
          // than a row whose consumer is already gone. The row goes inside
          // the consumer's own key as well, so an issue queued on it either
          // appended before the consumer went (and went with it) or finds
          // the consumer, or the application, gone.
          const target = consumerId;
          if (target === null) return { application, consumerId, unmapped, ...(await drop()) };
          const tally = await edge.serializePerKey(target, async () => {
            const live = await edge.consumers.get(target);
            if (live) await edge.consumers.delete(target, actor.id);
            return drop();
          });
          return { application, consumerId: target, unmapped, ...tally };
        },
      );

      const { application, consumerId, unmapped, grants, credentials } = outcome;
      await audit.record(
        { id: actor.id, role: actor.role },
        AuditAction.APPLICATION_DELETE,
        { type: 'application', id: application.id },
        {
          name: application.name,
          consumer_id: consumerId,
          revoked_grants: grants,
          revoked_credentials: credentials,
          ...(unmapped ? { unmapped_consumer: true } : {}),
        },
        ip,
      );
      return { revoked_grants: grants, revoked_credentials: credentials };
    },

    async resolveForActor(actor, applicationId): Promise<ApplicationRecord | null> {
      if (applicationId === null) return null;
      const application = await store.applications.findById(applicationId);
      if (!application) throw notFound('Application', applicationId);
      if (application.owner_user_id !== actor.id) {
        // Not even an administrator. Acting *as* somebody's application means
        // acquiring access or a secret that authenticates as them, which is a
        // different thing from administering their account.
        throw forbidden('Only the application owner can act as it');
      }
      if (application.status !== 'active') {
        throw conflict('This application is disabled', { application_id: application.id });
      }
      return application;
    },
  };
}

/** Every application id an account owns, for the teardown and repair walks. */
export async function listApplicationIds(store: NexusStore, ownerUserId: Uuid): Promise<Uuid[]> {
  const ids: Uuid[] = [];
  let offset = 0;
  for (;;) {
    const page = await store.applications.list(
      { owner_user_id: ownerUserId },
      { limit: MAX_PAGE_SIZE, offset },
    );
    ids.push(...page.items.map((row) => row.id));
    offset += page.items.length;
    if (page.items.length === 0 || offset >= page.total) return ids;
  }
}
