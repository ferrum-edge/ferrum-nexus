/**
 * Gateway credentials — issue, rotate, revoke. Show-once, by construction.
 *
 * ## Show-once is enforced twice
 *
 * Nexus generates the secret, returns it in exactly one HTTP response, and
 * stores only a SHA-256 fingerprint and the last four characters. Even if that
 * discipline slipped, Edge would still hold the line: every ordinary Admin API
 * response redacts `keyauth.key` and `jwt.secret` to the literal `[REDACTED]`
 * and omits `basicauth` entirely (`ref-edge-admin.md` §4.5). There is no read
 * path back to the plaintext on either side.
 *
 * ## Credential shapes, and why they are not what a portal would guess
 *
 * | Nexus type  | Edge entry            | What the client actually sends |
 * |-------------|-----------------------|--------------------------------|
 * | `keyauth`   | `{ key }`             | `X-API-Key: <key>`             |
 * | `basicauth` | `{ password }`        | Basic `<consumer username>:<password>` |
 * | `jwt`       | `{ secret }`          | HS256 JWT with `sub` = consumer username |
 *
 * Two consequences fall out of Edge's schemas and are worth stating plainly:
 *
 * - **`basicauth` has no username field.** The entry accepts exactly one of
 *   `password` / `password_hash` and nothing else; the lookup key is the
 *   *consumer's* `username` (§5.2). So the username Nexus shows the user is
 *   `nexus-user-<id>`, not a per-credential name — inventing one would produce
 *   a credential that cannot authenticate.
 * - **`jwt` has no key/kid field.** The entry is exactly `{ secret }`, 32–4096
 *   chars, and `additionalProperties: false` rejects `algorithm`, `kid`, and
 *   friends. The consumer is located from the `jwt_auth` plugin's
 *   `consumer_claim_field` (default `sub`), matched against the consumer's
 *   `username`/`id`/`custom_id`. `ShowOnceSecret.jwt_key` therefore carries the
 *   consumer username — the value the client must put in `sub`.
 *
 * ## Locating an entry to delete: Nexus row order *is* the array index
 *
 * Edge gives credential entries **no id**, and reads redact the material, so
 * there is nothing on the wire to match a specific entry against. What is
 * stable is the ordering: `POST` appends, `DELETE /{type}/{index}` removes by
 * 0-based index, and Nexus writes one `credential_metadata` row per append. The
 * non-revoked rows for a `(consumer, type)` pair, oldest first, are therefore a
 * mirror of the Edge array, and a row's position in that list is its index.
 *
 * {@link resolveCredentialIndex} computes that position and cross-checks it
 * against the live array length before any destructive call; a mismatch (an
 * operator edited the consumer by hand) degrades to deleting the whole
 * credential type when only one row is live, and otherwise refuses rather than
 * deleting somebody else's key. **That degradation is valid for `revoke`
 * only** — deleting everything is what a revoke asked for. `rotate` refuses
 * the drift instead, because "delete the whole type" would take the entry it
 * had just appended with it. A target that is no longer live at all resolves
 * to `not-live` and never to `whole-type`.
 *
 * ## The target is loaded twice, and the second read is the one that counts
 *
 * `rotate` and `revoke` resolve the credential once outside the per-consumer
 * queue — that read is only for the ownership check and to learn which consumer
 * to serialise on — and then **re-read it inside the queue**. The first read
 * happens before the operation is ordered against everything else touching that
 * consumer, so by the time the block runs another rotate may already have
 * retired the row. Acting on the first copy is what let two raced rotations
 * both delete an entry and both hand out a show-once secret. Only a row that is
 * still live on the second read may be moved out of `active`; anything else is
 * a `CONFLICT` (rotate) or an already-done no-op (revoke).
 *
 * **Across instances:** every block below locks the **Ferrum consumer id** —
 * the canonical key for that gateway resource, shared with
 * `consumers.ts`'s `mutateAclGroups` — and `serializePerKey` backs that key
 * with an `edge_leases` row, so a second Nexus process waits rather than
 * interleaving its own GET-edit-PUT. What is still process-local is the
 * *credential row* check-and-set: two instances rotating the same credential
 * are ordered by the consumer lease they both need, not by the row itself.
 */

import {
  CREDENTIAL_TYPE_FOR_PLUGIN,
  MAX_PAGE_SIZE,
  consumerUsernameForUser,
  roleAtLeast,
  type CredentialMetadata,
  type CredentialType,
  type GatewayTeardownOutcome,
  type IssueCredentialResponse,
  type Paginated,
  type RotateCredentialResponse,
  type ShowOnceSecret,
  type Uuid,
} from '@ferrum-nexus/shared';

import { AuditAction, type AuditService } from '../audit/service.js';
import type { NexusConfig } from '../config/index.js';
import type {
  CredentialFilter,
  CredentialRecord,
  ListOptions,
  NexusStore,
  UserRecord,
} from '../db/store.js';
import type { EmailService } from '../email/service.js';
import type { FerrumAdminClient } from '../ferrum-admin/index.js';
import type { EdgeCredentialEntry, EdgeCredentialMap } from '../ferrum-admin/types.js';
import type { NexusCrypto } from '../lib/crypto.js';
import { last4, randomSecret, randomToken } from '../lib/crypto.js';
import { conflict, edgeError, forbidden, notFound, validationFailed } from '../lib/errors.js';
import { nowIso } from '../lib/ids.js';
import type { NotificationsService } from '../notifications/service.js';
import type { ConsumerProvisioner } from './consumers.js';

/** Every credential type a Nexus user may hold, in UI order. */
export const CREDENTIAL_TYPES = [
  'keyauth',
  'basicauth',
  'jwt',
] as const satisfies readonly CredentialType[];

/** Statuses that still occupy a slot in the Edge credentials array. */
const LIVE_STATUSES = new Set(['active', 'retiring']);

/** Raised whenever the Nexus mirror and the live Edge array disagree. */
const RECONCILE_MESSAGE =
  'The gateway credential list does not match the portal; ask an administrator to reconcile this consumer before rotating or revoking';

/** Generated plaintext plus the Edge entry that carries it. */
interface GeneratedCredential {
  /** The value fingerprinted and reduced to `last4`. */
  material: string;
  entry: EdgeCredentialEntry;
  secret: ShowOnceSecret;
}

/** What {@link CredentialsService.disableGatewayAccess} tore down. */
export interface GatewayTeardown {
  /** The Edge consumer that was stripped, or `null` when the user had none. */
  consumer_id: string | null;
  /** `credential_metadata` rows moved to `revoked`, across every identity. */
  revoked_credentials: number;
  /** ACL groups the canonical consumer held before the teardown. */
  removed_groups: string[];
  /**
   * Edge consumers deleted outright because they were not the account's
   * canonical identity — a provider's `nexus-test-<apiId>` consumers.
   */
  deleted_consumers: string[];
}

/** Input for {@link CredentialsService.issueForConsumer}. */
export interface IssueForConsumerInput {
  /** The account the credential row is attributed to. */
  user: UserRecord;
  /** Edge consumer the entry is appended to. */
  consumerId: string;
  /** That consumer's username — what a `basicauth` or `jwt` client must send. */
  consumerUsername: string;
  credentialType: CredentialType;
  label?: string | null;
  /** Skip the per-type cap (test consumers start from an empty consumer). */
  skipCap?: boolean;
}

/** Credential operations. */
export interface CredentialsService {
  /** Consumer provisioning, shared with the access service. */
  readonly provisioner: ConsumerProvisioner;
  /** The caller's credentials, or another user's when an admin asks. */
  list(
    actor: UserRecord,
    targetUserId?: Uuid,
    filter?: { status?: CredentialMetadata['status'] },
    options?: ListOptions,
  ): Promise<Paginated<CredentialRecord>>;
  /** Mint a credential on the caller's own consumer. Show-once. */
  issue(
    user: UserRecord,
    input: { credential_type: CredentialType; label?: string | null },
    ip?: string | null,
  ): Promise<IssueCredentialResponse>;
  /** Append-then-delete rotation of one credential. Show-once. */
  rotate(
    user: UserRecord,
    credentialId: Uuid,
    label?: string | null,
    ip?: string | null,
  ): Promise<RotateCredentialResponse>;
  /** Delete the entry from Edge and mark the row revoked. */
  revoke(user: UserRecord, credentialId: Uuid, ip?: string | null): Promise<void>;
  /**
   * Take a user's gateway identity away entirely: every ACL group off the
   * canonical consumer, every credential of every type deleted, every mirrored
   * row `revoked` — and the same for every *other* Edge consumer the account
   * still holds credential material on, which in practice means its provider
   * test consumers (`nexus-test-<apiId>`), deleted outright.
   *
   * Called when an account is disabled. Killing the portal session is not
   * enough on its own — an issued API key keeps working without one, and an
   * API published with `requestable: false` carries no `access_control`
   * plugin, so an empty group list does not stop it either. Nor is stripping
   * the canonical consumer enough: a test consumer is a separate identity with
   * its own key and its own approval group.
   *
   * Every identity has to come down for this to have succeeded, so a failure on
   * any one of them throws and the durable job stays `pending`. A retry
   * enumerates from live credential rows, so identities an earlier attempt
   * already finished are not touched again.
   */
  disableGatewayAccess(userId: Uuid, subject: string): Promise<GatewayTeardown>;
  /** Append a credential to an arbitrary consumer — the test-consumer path. */
  issueForConsumer(
    input: IssueForConsumerInput,
  ): Promise<{ credential: CredentialRecord; secret: ShowOnceSecret }>;
}

/** Dependencies of {@link createCredentialsService}. */
export interface CredentialsServiceDeps {
  config: NexusConfig;
  store: NexusStore;
  edge: FerrumAdminClient;
  crypto: NexusCrypto;
  audit: AuditService;
  notifications: NotificationsService;
  email: EmailService;
  provisioner: ConsumerProvisioner;
}

/* ── Material generation ────────────────────────────────────────────────── */

/**
 * Generate the plaintext for one credential type.
 *
 * All three secrets are 32 bytes of `crypto.randomBytes` rendered base64url,
 * which clears Edge's 32-character minimum for `jwt` secrets with room to
 * spare and stays far below the 4096-character ceiling.
 */
export function generateCredential(
  type: CredentialType,
  consumerUsername: string,
): GeneratedCredential {
  switch (type) {
    case 'keyauth': {
      const key = randomSecret('nxs', 32);
      return { material: key, entry: { key }, secret: { type, key } };
    }
    case 'basicauth': {
      // The consumer's username *is* the basic-auth username (§5.2); the entry
      // itself accepts nothing but the password.
      const password = randomToken(32);
      return {
        material: password,
        entry: { password },
        secret: { type, username: consumerUsername, password },
      };
    }
    case 'jwt': {
      const secret = randomToken(32);
      return {
        material: secret,
        entry: { secret },
        // `jwt_key` is the value the client puts in the token's `sub` claim.
        secret: { type, jwt_secret: secret, jwt_key: consumerUsername },
      };
    }
    default: {
      // Exhaustive: `CredentialType` has exactly three members.
      throw validationFailed(`Unsupported credential type '${String(type)}'`);
    }
  }
}

/** One attempt at stripping a disabled account's gateway identity. */
export interface GatewayTeardownAttempt {
  /** What the caller reports to the client. Never a terminal failure. */
  outcome: GatewayTeardownOutcome;
  /** `details` for the audit row the caller is already writing. */
  details: Record<string, unknown>;
  /** What was torn down, or `null` when the attempt failed. */
  result: GatewayTeardown | null;
  /** Failure message when `outcome` is `pending`. */
  error: string | null;
}

/** Input for {@link runGatewayTeardown}. */
export interface RunGatewayTeardownInput {
  credentials: Pick<CredentialsService, 'disableGatewayAccess'>;
  store: NexusStore;
  userId: Uuid;
  /** Actor id recorded as the Edge write's subject. */
  subject: string;
  /**
   * The durable job this attempt is closing. Looked up by user when omitted —
   * pass it when the caller already holds the row (the worker does).
   */
  jobId?: Uuid | null;
  log?: (obj: Record<string, unknown>, message: string) => void;
}

/**
 * Run one gateway teardown and settle the durable job behind it.
 *
 * Disabling an account must not depend on the gateway being reachable: a
 * portal account left enabled because Edge timed out is strictly worse than a
 * disabled account whose consumer still needs cleaning up. But a swallowed
 * failure is worse than both — the account's API key keeps authenticating
 * against Edge with no session and nothing retrying, which is
 * `GHSA-8vxw-j3wc-w6vm`.
 *
 * So the disable still commits, and the teardown it owes is a
 * `gateway_teardown_jobs` row written in the same transaction. This function
 * runs one attempt against it:
 *
 * - success (including "the account never had a consumer") closes the job and
 *   reports `ok` / `no_consumer`;
 * - failure leaves the job `pending`, logs at `warn`, and reports `pending` —
 *   which the teardown worker turns into a retry, not an outcome.
 */
export async function runGatewayTeardown(
  input: RunGatewayTeardownInput,
): Promise<GatewayTeardownAttempt> {
  const { credentials, store, userId, subject, log } = input;
  try {
    const result = await credentials.disableGatewayAccess(userId, subject);
    const jobId = input.jobId ?? (await store.gatewayTeardownJobs.findByUser(userId))?.id ?? null;
    if (jobId !== null) await store.gatewayTeardownJobs.markDone(jobId, nowIso());
    // `no_consumer` means "this account never had a gateway identity at all",
    // so a provider whose only identity was a test consumer reports `ok` — the
    // work was real and it landed.
    if (result.consumer_id === null && result.deleted_consumers.length === 0) {
      return {
        outcome: 'no_consumer',
        details: { gateway_teardown: 'no_consumer' },
        result,
        error: null,
      };
    }
    return {
      outcome: 'ok',
      details: {
        gateway_teardown: 'ok',
        gateway_consumer_id: result.consumer_id,
        revoked_credentials: result.revoked_credentials,
        removed_acl_groups: result.removed_groups,
        ...(result.deleted_consumers.length > 0
          ? { deleted_consumers: result.deleted_consumers }
          : {}),
      },
      result,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // `warn`, not `error`: the portal did the right thing and the work is
    // queued. This is the line an operator alerts on — see `docs/operations.md`.
    log?.(
      { user_id: userId, error: message },
      'Gateway revocation for a disabled account failed; it stays queued for retry',
    );
    return {
      outcome: 'pending',
      details: { gateway_teardown: 'pending', gateway_error: message },
      result: null,
      error: message,
    };
  }
}

/* ── Service ────────────────────────────────────────────────────────────── */

/** Build the credentials service. */
export function createCredentialsService(deps: CredentialsServiceDeps): CredentialsService {
  const { config, store, edge, crypto, audit, notifications, email, provisioner } = deps;
  const cap = config.edge.maxCredentialsPerType;

  /** Rows still occupying an Edge array slot, oldest first. */
  async function liveRows(consumerId: string, type: CredentialType): Promise<CredentialRecord[]> {
    const rows = await store.credentials.listByConsumer(consumerId, type);
    return rows
      .filter((row) => LIVE_STATUSES.has(row.status))
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  }

  /**
   * 0-based index of `target` inside the Edge credentials array.
   *
   * `edgeLength` is the array length read from a *fresh* `GET /consumers/{id}`
   * inside the same serialised block, so the two views cannot drift between the
   * check and the delete.
   */
  function resolveCredentialIndex(
    rows: CredentialRecord[],
    target: CredentialRecord,
    edgeLength: number,
  ): number | 'whole-type' | 'not-live' {
    const index = rows.findIndex((row) => row.id === target.id);
    // The target no longer occupies a slot — a concurrent rotate or revoke of
    // the same row won the queue. That is *never* permission to delete the
    // whole credential type: everything still live belongs to someone else's
    // successful operation.
    if (index === -1) return 'not-live';
    if (rows.length === edgeLength) return index;
    // The mirror drifted (a hand-edited consumer). Removing the entire type is
    // safe only when this is the last credential Nexus knows about.
    if (rows.length === 1) return 'whole-type';
    throw edgeError(RECONCILE_MESSAGE, { expected: rows.length, actual: edgeLength });
  }

  /** Length of the Edge credentials array for one type (basicauth is never emitted). */
  function edgeArrayLength(
    credentials: EdgeCredentialMap | undefined,
    type: CredentialType,
    fallback: number,
  ): number {
    const entries = credentials?.[type];
    // `basicauth` is omitted from every read projection, so its length is
    // unknowable from a GET — trust the Nexus mirror for it.
    if (type === 'basicauth') return fallback;
    return Array.isArray(entries) ? entries.length : 0;
  }

  async function loadOwned(user: UserRecord, credentialId: Uuid): Promise<CredentialRecord> {
    const credential = await store.credentials.findById(credentialId);
    if (!credential) throw notFound('Credential', credentialId);
    if (credential.user_id !== user.id && !roleAtLeast(user.role, 'admin')) {
      // Not a 404: the caller is authenticated and the id is theirs to guess or
      // not, and a 403 is what the SPA needs to render a useful message.
      throw forbidden('This credential belongs to another account');
    }
    return credential;
  }

  async function appendCredential(input: {
    user: UserRecord;
    consumerId: string;
    consumerUsername: string;
    type: CredentialType;
    label: string | null;
    rotatedFromId?: Uuid | null;
  }): Promise<{ credential: CredentialRecord; secret: ShowOnceSecret }> {
    const generated = generateCredential(input.type, input.consumerUsername);
    await edge.consumers.addCredential(
      input.consumerId,
      input.type,
      generated.entry,
      input.user.id,
    );
    const credential = await store.credentials.create({
      user_id: input.user.id,
      ferrum_consumer_id: input.consumerId,
      credential_type: input.type,
      // Edge assigns credential entries no id of their own; the addressable
      // resource is the per-type collection, and position is tracked by row
      // order (see the module docblock).
      ferrum_credential_id: `${input.consumerId}/credentials/${input.type}`,
      fingerprint: crypto.fingerprint(generated.material),
      last4: last4(generated.material),
      label: input.label,
      status: 'active',
      rotated_from_id: input.rotatedFromId ?? null,
    });
    return { credential, secret: generated.secret };
  }

  async function issueForConsumer(
    input: IssueForConsumerInput,
  ): Promise<{ credential: CredentialRecord; secret: ShowOnceSecret }> {
    if (!(CREDENTIAL_TYPES as readonly string[]).includes(input.credentialType)) {
      throw validationFailed(`Unsupported credential type '${input.credentialType}'`);
    }
    return edge.serializePerKey(input.consumerId, async () => {
      if (input.skipCap !== true) {
        const rows = await liveRows(input.consumerId, input.credentialType);
        if (rows.length >= cap) {
          throw conflict(
            `You already hold ${rows.length} live ${input.credentialType} credentials (the gateway allows ${cap}); revoke or rotate one first`,
            { credential_type: input.credentialType, limit: cap },
          );
        }
      }
      return appendCredential({
        user: input.user,
        consumerId: input.consumerId,
        consumerUsername: input.consumerUsername,
        type: input.credentialType,
        label: input.label ?? null,
      });
    });
  }

  return {
    provisioner,
    issueForConsumer,

    async disableGatewayAccess(userId, subject): Promise<GatewayTeardown> {
      const consumer = await provisioner.findConsumer(userId);
      const consumerId = consumer?.ferrum_consumer_id ?? null;

      // Everything else the account can still authenticate as. A provider's
      // `nexus-test-<apiId>` consumer is a *separate* Edge identity carrying a
      // credential attributed to whoever created it, and it holds the API's
      // approval group, so leaving it up defeats the whole offboarding.
      //
      // The enumeration reads live credential rows, which is also what makes a
      // retry skip the identities an earlier attempt already finished: their
      // rows are `revoked`, so they never come back into this list.
      const foreign = await foreignConsumerIds(userId, consumerId);
      let revoked = 0;
      const deleted: string[] = [];

      if (consumerId === null && foreign.length === 0) {
        return {
          consumer_id: null,
          revoked_credentials: 0,
          removed_groups: [],
          deleted_consumers: [],
        };
      }

      // Each identity gets its own critical section, keyed on its own consumer
      // id — the same key its issue path locks, so a teardown and an in-flight
      // append can never interleave. Sequential, not concurrent: a failure must
      // leave the identities behind it untouched for the retry to pick up.
      for (const foreignId of foreign) {
        revoked += await edge.serializePerKey(foreignId, async () => {
          const live = await edge.consumers.get(foreignId);
          // A test consumer is disposable by definition — the next provider or
          // admin who wants one recreates it — so it goes away entirely rather
          // than being stripped and left as an empty identity.
          if (live) await edge.consumers.delete(foreignId, subject);
          const count = await revokeRowsFor(foreignId);
          const cached = await store.consumers.findByFerrumId(foreignId);
          // Only ever a mapping that belongs to *this* account: the tracking row
          // of somebody else's consumer is not this teardown's to delete.
          if (cached && cached.user_id === userId) await store.consumers.delete(cached.id);
          return count;
        });
        deleted.push(foreignId);
      }

      if (consumerId === null) {
        return {
          consumer_id: null,
          revoked_credentials: revoked,
          removed_groups: [],
          deleted_consumers: deleted,
        };
      }

      // One serialised block, like every other consumer mutation — and *only*
      // one, because `serializePerKey` is a queue rather than a re-entrant
      // lock: calling `provisioner.mutateAclGroups` from in here would wait on
      // the block it is already inside.
      return edge.serializePerKey(consumerId, async () => {
        const live = await edge.consumers.get(consumerId);
        const removedGroups = [...(live?.acl_groups ?? [])];

        if (live) {
          // Groups first, rebuilt from the GET so redacted credential
          // placeholders round-trip (§4.4) and nothing is dropped early…
          await edge.consumers.replace(
            consumerId,
            {
              id: live.id,
              username: live.username,
              custom_id: live.custom_id ?? null,
              credentials: live.credentials,
              acl_groups: [],
            },
            subject,
          );
          // …then every credential type, whether or not the read projection
          // could show it — `basicauth` never appears in a GET. The whole-type
          // delete is idempotent, so an absent type costs one 204.
          for (const type of CREDENTIAL_TYPES) {
            await edge.consumers.deleteCredentialType(consumerId, type, subject);
          }
        }

        // The mirror follows the gateway, including when the consumer was
        // already gone: those rows describe credentials that cannot work.
        revoked += await revokeRowsFor(consumerId);

        return {
          consumer_id: consumerId,
          revoked_credentials: revoked,
          removed_groups: removedGroups,
          deleted_consumers: deleted,
        };
      });
    },

    async list(actor, targetUserId, filter = {}, options): Promise<Paginated<CredentialRecord>> {
      const userId = targetUserId ?? actor.id;
      if (userId !== actor.id && !roleAtLeast(actor.role, 'admin')) {
        throw forbidden('Only an administrator can list another account’s credentials');
      }
      const storeFilter: CredentialFilter = {
        user_id: userId,
        ...(filter.status !== undefined ? { status: filter.status } : {}),
      };
      return store.credentials.list(storeFilter, options);
    },

    async issue(user, input, ip = null): Promise<IssueCredentialResponse> {
      if (!(CREDENTIAL_TYPES as readonly string[]).includes(input.credential_type)) {
        throw validationFailed(`Unsupported credential type '${input.credential_type}'`);
      }
      const consumer = await provisioner.ensureConsumer(user);

      const { credential, secret } = await issueForConsumer({
        user,
        consumerId: consumer.ferrum_consumer_id,
        consumerUsername: consumer.ferrum_username,
        credentialType: input.credential_type,
        label: input.label ?? null,
      });

      await audit.record(
        { id: user.id, role: user.role },
        AuditAction.CREDENTIAL_ISSUE,
        { type: 'credential', id: credential.id },
        {
          credential_type: credential.credential_type,
          consumer_id: consumer.ferrum_consumer_id,
          last4: credential.last4,
        },
        ip,
      );

      return { credential, consumer_username: consumer.ferrum_username, secret };
    },

    async rotate(user, credentialId, label, ip = null): Promise<RotateCredentialResponse> {
      const target = await loadOwned(user, credentialId);
      if (target.status === 'revoked') {
        throw conflict('This credential has already been revoked');
      }
      const type = target.credential_type;
      const consumerId = target.ferrum_consumer_id;

      const result = await edge.serializePerKey(consumerId, async () => {
        // Re-read the row *inside* the queue. The copy loaded for the ownership
        // check was taken before this operation was serialised, and an earlier
        // queued rotate or revoke of the same credential may have retired it
        // since; acting on that stale copy is how two racing rotations both
        // deleted an entry and both handed out a live-looking secret.
        const current = await store.credentials.findById(target.id);
        if (!current) throw notFound('Credential', credentialId);
        if (!LIVE_STATUSES.has(current.status)) {
          throw conflict('This credential has already been revoked');
        }

        const consumer = await edge.consumers.get(consumerId);
        if (!consumer) throw edgeError('The gateway consumer for this credential no longer exists');
        const rows = await liveRows(consumerId, type);
        const length = edgeArrayLength(consumer.credentials, type, rows.length);
        const position = resolveCredentialIndex(rows, current, length);
        if (position === 'not-live') {
          throw conflict('This credential has already been revoked');
        }
        if (position === 'whole-type') {
          // Degrading to `DELETE /credentials/{type}` is only ever right for a
          // revoke, where removing everything is the point. In a rotation it
          // would delete the entry appended moments earlier and hand the user
          // a show-once secret that authenticates nothing.
          throw edgeError(RECONCILE_MESSAGE, { expected: rows.length, actual: length });
        }

        // Append-then-delete keeps both secrets live across the hand-off. When
        // the array is already at the gateway cap there is no room to append,
        // so the old entry has to go first — briefly leaving the account with
        // no working credential of this type, which is unavoidable at the cap.
        const appendFirst = length < cap;

        if (!appendFirst) {
          await removeAt(consumerId, type, position, user.id);
        }
        const created = await appendCredential({
          user,
          consumerId,
          consumerUsername: consumer.username,
          type,
          label: label ?? current.label,
          rotatedFromId: current.id,
        });
        if (appendFirst) {
          // `POST` appends, so the old entry's index is unchanged by the append.
          await removeAt(consumerId, type, position, user.id);
        }

        const previous =
          (await store.credentials.update(current.id, { status: 'revoked' })) ?? current;
        return { created, previous };
      });

      await audit.record(
        { id: user.id, role: user.role },
        AuditAction.CREDENTIAL_ROTATE,
        { type: 'credential', id: result.created.credential.id },
        {
          credential_type: type,
          consumer_id: consumerId,
          rotated_from: target.id,
          previous_last4: target.last4,
        },
        ip,
      );

      const owner = target.user_id === user.id ? user : await store.users.findById(target.user_id);
      if (owner) {
        await notifications
          .notify(
            owner.id,
            'credential_rotated',
            'A gateway credential was rotated',
            `Your ${type} credential ending …${target.last4} was replaced.`,
            '/credentials',
          )
          .catch(() => undefined);
        await email
          .enqueue({
            to: owner.email,
            templateKey: 'credential_rotated',
            vars: {
              recipient_name: owner.display_name,
              recipient_email: owner.email,
              credential_label: result.created.credential.label ?? type,
              credential_last4: result.created.credential.last4,
              credentials_url: `${config.publicUrl}/credentials`,
            },
          })
          .catch(() => undefined);
      }

      return {
        credential: result.created.credential,
        previous: result.previous,
        consumer_username: consumerUsernameForUser(target.user_id),
        secret: result.created.secret,
      };
    },

    async revoke(user, credentialId, ip = null): Promise<void> {
      const target = await loadOwned(user, credentialId);
      if (target.status === 'revoked') return;
      const type = target.credential_type;
      const consumerId = target.ferrum_consumer_id;

      const removed = await edge.serializePerKey(consumerId, async () => {
        // Re-read inside the queue: an earlier queued operation on the same row
        // may already have retired it, and deleting by the index that copy
        // carried would take somebody else's live credential with it.
        const current = await store.credentials.findById(target.id);
        if (!current || !LIVE_STATUSES.has(current.status)) return false;

        const consumer = await edge.consumers.get(consumerId);
        // A consumer deleted out from under us means the entry is already gone;
        // the row still has to be marked so the UI stops offering it.
        if (consumer) {
          const rows = await liveRows(consumerId, type);
          const length = edgeArrayLength(consumer.credentials, type, rows.length);
          const position = resolveCredentialIndex(rows, current, length);
          // `not-live` cannot follow the status check above, but treat it as a
          // completed revoke rather than a whole-type delete if it ever does.
          if (position !== 'not-live') {
            await removeAt(consumerId, type, position, user.id);
          }
        }
        await store.credentials.update(current.id, { status: 'revoked' });
        return true;
      });

      // A no-op revoke of an already-retired credential stays silent: it wrote
      // nothing, so there is nothing to audit.
      if (!removed) return;

      await audit.record(
        { id: user.id, role: user.role },
        AuditAction.CREDENTIAL_REVOKE,
        { type: 'credential', id: target.id },
        { credential_type: type, consumer_id: consumerId, last4: target.last4 },
        ip,
      );
    },
  };

  /**
   * Every Edge consumer other than `canonicalId` that this account still holds
   * live credential material on, in a stable order.
   *
   * In practice that is the account's provider test consumers: `issue` only
   * ever writes rows against the caller's own consumer, while
   * `createTestConsumer` writes one against `nexus-test-<apiId>` attributed to
   * the provider or admin who asked for it.
   */
  async function foreignConsumerIds(userId: Uuid, canonicalId: string | null): Promise<string[]> {
    const seen = new Set<string>();
    for (const status of LIVE_STATUSES) {
      let offset = 0;
      for (;;) {
        const page = await store.credentials.list(
          { user_id: userId, status: status as CredentialMetadata['status'] },
          { limit: MAX_PAGE_SIZE, offset },
        );
        for (const row of page.items) {
          if (row.ferrum_consumer_id !== canonicalId) seen.add(row.ferrum_consumer_id);
        }
        offset += page.items.length;
        if (page.items.length === 0 || offset >= page.total) break;
      }
    }
    return [...seen].sort();
  }

  /** Move every live row of one consumer to `revoked`; returns how many moved. */
  async function revokeRowsFor(consumerId: string): Promise<number> {
    let revoked = 0;
    for (const row of await store.credentials.listByConsumer(consumerId)) {
      if (row.status === 'revoked') continue;
      await store.credentials.update(row.id, { status: 'revoked' });
      revoked += 1;
    }
    return revoked;
  }

  /** Delete one entry by index, or the whole type when the index is unusable. */
  async function removeAt(
    consumerId: string,
    type: CredentialType,
    position: number | 'whole-type',
    subject: string,
  ): Promise<void> {
    if (position === 'whole-type') {
      await edge.consumers.deleteCredentialType(consumerId, type, subject);
      return;
    }
    await edge.consumers.deleteCredentialAt(consumerId, type, position, subject);
  }
}
