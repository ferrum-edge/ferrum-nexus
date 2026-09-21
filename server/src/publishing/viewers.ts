/**
 * Who a provider has authorized to read a **private** API's documentation.
 *
 * ## The distinction this module exists to keep
 *
 * Reading the documentation and calling the API are two different permissions.
 * Nexus already had the second one — an access request, an approval, an ACL
 * group on the caller's Ferrum consumer — and `internal` visibility papered
 * over the first by making unlisted APIs readable to anyone holding a link.
 * That is a coherent answer for "unlisted", and a wrong one for a confidential
 * API shared with two named partners (issue #288).
 *
 * So `private` visibility has a list of authorized viewers, and an entry on it
 * confers exactly one thing: the right to open the catalog entry and read the
 * specification. It writes no grant, creates no consumer, attaches no plugin
 * and makes no call to Ferrum Edge. An authorized viewer who wants to *call*
 * the API requests access through the ordinary flow and waits for the same
 * approval as everybody else.
 *
 * That separation is the whole point, and it is why this lives in its own
 * module with its own audit actions rather than as a flag on the grant
 * service: the next person to add a feature here should have to notice that
 * they are not touching authorization.
 *
 * ## Authorizing somebody who is not there
 *
 * A provider invites by email address, which is how they know their partners —
 * but the row is keyed by user id, because an email address is not an
 * identity and re-pointing one later would silently move an authorization. An
 * address with no account is therefore refused, with a message that says so,
 * rather than being stored as a pending invitation: a promise to authorize
 * whoever eventually registers that address is a promise this portal cannot
 * keep safely.
 */

import {
  clampPageSize,
  roleAtLeast,
  type ApiViewer,
  type Paginated,
  type UserSummary,
  type Uuid,
} from '@ferrum-nexus/shared';

import { AuditAction, type AuditService } from '../audit/service.js';
import type {
  ApiRecord,
  ApiViewerRecord,
  ListOptions,
  NexusStore,
  UserRecord,
} from '../db/store.js';
import { conflict, notFound, validationFailed } from '../lib/errors.js';
import type { NotificationsService } from '../notifications/service.js';

/** How a provider names the account they are authorizing. */
export interface AuthorizeViewerInput {
  /** The account's email address. Exactly one of this or `user_id`. */
  email?: string | null;
  /** The account's id, for a UI that already resolved it. */
  user_id?: Uuid | null;
  /** Free-text note, e.g. which partner this is. */
  note?: string | null;
}

/** Managing the read-access list of a private API. */
export interface ApiViewersService {
  /** One page of the API's authorized viewers, newest first. */
  list(actor: UserRecord, apiId: Uuid, options?: ListOptions): Promise<Paginated<ApiViewer>>;
  /** Authorize one account to read this API's documentation. */
  authorize(
    actor: UserRecord,
    apiId: Uuid,
    input: AuthorizeViewerInput,
    ip?: string | null,
  ): Promise<ApiViewer>;
  /** Withdraw an authorization. Idempotent-ish: absent reads as `404`. */
  revoke(actor: UserRecord, apiId: Uuid, userId: Uuid, ip?: string | null): Promise<void>;
}

/** Dependencies of {@link createApiViewersService}. */
export interface ApiViewersServiceDeps {
  store: NexusStore;
  audit: AuditService;
  notifications: NotificationsService;
  /** Ownership check shared with the publishing service. */
  assertCanAdminister(actor: UserRecord, api: ApiRecord): void;
}

/** Build the API viewers service. */
export function createApiViewersService(deps: ApiViewersServiceDeps): ApiViewersService {
  const { store, audit, notifications } = deps;

  async function loadApi(actor: UserRecord, apiId: Uuid): Promise<ApiRecord> {
    const api = await store.apis.findById(apiId);
    if (!api) throw notFound('API', apiId);
    deps.assertCanAdminister(actor, api);
    return api;
  }

  function summary(user: UserRecord | undefined): UserSummary | null {
    return user
      ? { id: user.id, email: user.email, display_name: user.display_name, role: user.role }
      : null;
  }

  function present(record: ApiViewerRecord, user: UserRecord | undefined): ApiViewer {
    return {
      id: record.id,
      api_id: record.api_id,
      user_id: record.user_id,
      user: summary(user),
      granted_by: record.granted_by,
      note: record.note,
      created_at: record.created_at,
      updated_at: record.updated_at,
    };
  }

  /**
   * The account a provider named, or a refusal that says which half was wrong.
   *
   * Refusing an unknown address is deliberate — see the module docstring — and
   * the message is the same whether the address has no account or has one that
   * cannot be authorized, so the endpoint is not a membership oracle for the
   * portal's user list.
   */
  async function resolveTarget(input: AuthorizeViewerInput): Promise<UserRecord> {
    if (input.user_id) {
      const byId = await store.users.findById(input.user_id);
      if (!byId) throw validationFailed('No portal account matches that user');
      return byId;
    }
    const email = (input.email ?? '').trim();
    if (email === '') throw validationFailed('An email address or a user id is required');
    const byEmail = await store.users.findByEmail(email.toLowerCase());
    if (!byEmail) {
      throw validationFailed(
        'No portal account uses that email address. Ask them to register first, then authorize ' +
          'them — an authorization is attached to an account, not to an address.',
      );
    }
    return byEmail;
  }

  return {
    async list(actor, apiId, options): Promise<Paginated<ApiViewer>> {
      const api = await loadApi(actor, apiId);
      const limit = clampPageSize(options?.limit);
      const offset = Math.max(0, options?.offset ?? 0);
      const page = await store.apiViewers.list({ api_id: api.id }, { limit, offset });
      const users = new Map(
        (await store.users.findManyByIds([...new Set(page.items.map((row) => row.user_id))])).map(
          (user) => [user.id, user],
        ),
      );
      return {
        items: page.items.map((row) => present(row, users.get(row.user_id))),
        total: page.total,
      };
    },

    async authorize(actor, apiId, input, ip = null): Promise<ApiViewer> {
      const api = await loadApi(actor, apiId);
      const target = await resolveTarget(input);
      if (target.id === api.owner_user_id) {
        throw conflict('The API owner can already read this API');
      }
      if (roleAtLeast(target.role, 'admin')) {
        throw conflict('Administrators can already read every API');
      }

      const note = (input.note ?? '').trim();
      const saved = await store.apiViewers.upsert({
        api_id: api.id,
        user_id: target.id,
        granted_by: actor.id,
        note: note === '' ? null : note,
      });

      await audit.record(
        { id: actor.id, role: actor.role },
        AuditAction.API_VIEWER_AUTHORIZE,
        { type: 'api', id: api.id },
        {
          slug: api.slug,
          visibility: api.visibility,
          viewer_user_id: target.id,
          ...(note === '' ? {} : { note }),
          // Spelled out on every row, because "we let somebody in" is exactly
          // the kind of entry a later reader will want to be sure about.
          grants_invocation: false,
        },
        ip,
      );

      // Best-effort: the authorization is the thing that happened, and a
      // failed notification must not undo it.
      await notifications
        .notify(
          target.id,
          'system',
          'You can now view a private API',
          `${actor.display_name} gave you access to the documentation for “${api.name}”. ` +
            'This lets you read its specification in the catalog; it does not let you call it — ' +
            'request access from its catalog page if you need to.',
          `/catalog/${api.slug}`,
        )
        .catch(() => undefined);

      return present(saved, target);
    },

    async revoke(actor, apiId, userId, ip = null): Promise<void> {
      const api = await loadApi(actor, apiId);
      const existing = await store.apiViewers.find(api.id, userId);
      if (!existing) throw notFound('API viewer', userId);
      await store.apiViewers.delete(api.id, userId);
      await audit.record(
        { id: actor.id, role: actor.role },
        AuditAction.API_VIEWER_REVOKE,
        { type: 'api', id: api.id },
        {
          slug: api.slug,
          visibility: api.visibility,
          viewer_user_id: userId,
          // A read authorization and a grant are separate; withdrawing one has
          // never touched the other, and this row says so rather than leaving
          // an operator to infer it.
          revoked_grant: false,
        },
        ip,
      );
    },
  };
}
