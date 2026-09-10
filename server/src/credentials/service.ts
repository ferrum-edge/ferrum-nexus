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
 * ## Locating an entry to delete: the append ordinal *is* the array index
 *
 * Edge gives credential entries **no id**, and reads redact the material, so
 * there is nothing on the wire to match a specific entry against. What is
 * stable is the ordering: `POST` appends, `DELETE /{type}/{index}` removes by
 * 0-based index, and Nexus writes one `credential_metadata` row per append.
 * Each row carries `edge_ordinal`, a per-`(consumer, type)` counter the store
 * assigns as `MAX + 1` inside the same per-consumer critical section as the
 * append itself, so ordinal order **is** append order by construction. The
 * non-revoked rows for a pair, ordered by ordinal, mirror the Edge array, and a
 * row's position in that list is its index.
 *
 * The ordering key used to be `created_at` with the row id as tie-break, and
 * that is not append order: two appends inside one millisecond sort by a random
 * UUID, and a clock stepped backwards between two appends puts the later one
 * first. Either way a revoke deleted *another* live key while marking the
 * requested one revoked. Nothing here reads `created_at` for position any more.
 *
 * Rows written before the ordinal existed were backfilled from the old sort
 * where that sort was unambiguous (distinct timestamps). Where it was not, they
 * carry `edge_ordinal = null`: they all precede every row that has an ordinal,
 * but their order among themselves is unknowable. A single such row still has
 * a definite index (0); two or more make the target **ambiguous**, and
 * {@link resolveCredentialIndex} refuses to act on it until an administrator
 * runs {@link CredentialsService.reconcile}, which empties the type on both
 * sides — the only repair that needs no per-entry identity.
 *
 * {@link resolveCredentialIndex} also cross-checks the mirror against the live
 * array length before any destructive call; a mismatch (an operator edited the
 * consumer by hand) degrades to deleting the whole credential type when only
 * one row is live, and otherwise refuses rather than deleting somebody else's
 * key. **That degradation is valid for `revoke` only** — deleting everything is
 * what a revoke asked for. `rotate` refuses the drift instead, because "delete
 * the whole type" would take the entry it had just appended with it. A target
 * that is no longer live at all resolves to `not-live` and never to
 * `whole-type`.
 *
 * ## The mirror is written the instant Edge confirms, never later
 *
 * A rotation touches two systems and there is no transaction spanning them, so
 * the only defence is ordering: **no Nexus row may describe a gateway state
 * that a later step could still fail to reach.**
 *
 * - Below the cap, rotation appends first and both secrets are briefly live;
 *   the old row is revoked only after its entry is actually gone.
 * - **At** the cap there is no room to append, so the old entry is deleted
 *   first — and its row is revoked immediately, before the append is even
 *   attempted. Deferring it to the end (as this used to) left two `active` rows
 *   against one Edge entry whenever the append failed, and every later
 *   operation on the *surviving* credential — including the revoke an incident
 *   response needs — then died on {@link resolveCredentialIndex}'s length
 *   check. The failed rotation now reports plainly that the old credential is
 *   gone and a new one must be issued.
 * - An append Edge accepted whose metadata row cannot be written is deleted
 *   again, because a live secret with no row is one nobody can see or revoke.
 *   The delete that undoes it is positional, so it runs only against an array
 *   that still looks the way the append left it ({@link
 *   withdrawAppendedEntry}); what it declines to remove is audited, never
 *   forgotten.
 * - An append that Edge accepted and whose *paired delete* then failed is
 *   taken back too. Its plaintext is show-once and this call is not returning
 *   it, so leaving it would spend a cap slot on a credential nobody holds and
 *   nothing in the audit trail would explain where it came from.
 * - An append whose `POST` came back an **error** is compensated on the same
 *   terms, because a lost acknowledgement is indistinguishable from a refusal
 *   on the wire and leaves a live entry with no row at all — the one drift
 *   {@link settleLostRetirement} can never repair, since nothing local records
 *   the entry. The array is re-read: unchanged, the append demonstrably did
 *   not apply and nothing is written; grown by exactly this call's entry, it
 *   is withdrawn; anything else is audited as a suspected orphan and left
 *   alone ({@link reclaimUnacknowledgedAppend}).
 *
 * The compensating delete is positional, and **it is never issued for
 * `basicauth`**: no read projection shows that type, so there is no array to
 * check the index against and the only index available is one counted off the
 * mirror — which a Nexus-only restore leaves shorter than the array, pointing
 * at a pre-restore password rather than at the orphan. A `basicauth` append
 * that has to be undone is therefore recorded, not deleted.
 *
 * ## Ordering is not enough on its own: the retirement is recorded first
 *
 * Ordering settles which side may be written when, but it cannot make a
 * destructive remote call and the local write that records it agree when one
 * of the two is simply lost. A `DELETE` Edge applied whose acknowledgement
 * never arrived — or a confirmed delete whose follow-up row update fails —
 * used to leave the mirror one row longer than the array for good.
 * {@link resolveCredentialIndex} then refused every later rotate *and* revoke
 * of that type, the cap blocked issuing a replacement, and the account was
 * left holding a live gateway credential its owner could not kill.
 *
 * So the row is moved to `retiring` **before** the delete, not after it. That
 * status is durable, still counts as a live array slot, and means exactly
 * "the entry behind this row may already be gone". A later call reads it back
 * and, in the one shape that admits a single reading — the mirror exactly one
 * row longer than the array, and exactly one live row carrying the intent —
 * settles it and carries on ({@link settleLostRetirement}). Every other
 * mismatch is still refused: acting on a stale index is how somebody else's
 * live key dies, and no bookkeeping convenience is worth that.
 *
 * Retrying the delete is *not* an alternative. When the acknowledgement was
 * lost the entry is already gone, so the retry addresses a different entry or
 * `404`s, and the operator is back where they started.
 *
 * The converse has to hold too, and is enforced the same way: a row may be
 * left `retiring` only while its entry *might* be gone. Every delete that
 * reports failure re-reads the array inside the lease it still holds, and an
 * array that is still exactly as long as it was before the call proves the
 * delete never applied — the row goes back to `active` ({@link
 * deleteDidNotApply}). A `retiring` row over an entry that is demonstrably
 * live is the one input that could make {@link settleLostRetirement} settle
 * the wrong row, after which a positional delete would take somebody else's
 * live key. Outcomes that cannot be proved either way stay `retiring`, which
 * is the safe reading: the row still holds its slot and is still revocable.
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
  type ReconcileCredentialsResponse,
  type Role,
  type RotateCredentialResponse,
  type ShowOnceSecret,
  type Uuid,
} from '@ferrum-nexus/shared';

import { AuditAction, type AuditService } from '../audit/service.js';
import type { NexusConfig } from '../config/index.js';
import type {
  CredentialFilter,
  CredentialRecord,
  GatewayIdentityRecord,
  GatewayTeardownJobRecord,
  ListOptions,
  NexusStore,
  UserRecord,
} from '../db/store.js';
import type { EmailService } from '../email/service.js';
import type { FerrumAdminClient } from '../ferrum-admin/index.js';
import type { EdgeCredentialEntry, EdgeCredentialMap } from '../ferrum-admin/types.js';
import type { NexusCrypto } from '../lib/crypto.js';
import { last4, randomSecret, randomToken } from '../lib/crypto.js';
import {
  conflict,
  edgeError,
  forbidden,
  notFound,
  userDisabled,
  validationFailed,
} from '../lib/errors.js';
import { nowIso } from '../lib/ids.js';
import { userLifecycleLockKey, type KeyedSerializer } from '../lib/keyed-serializer.js';
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

/** What Edge substitutes for credential material on every ordinary read. */
const REDACTED_MATERIAL = '[REDACTED]';

/**
 * The serializer key for a non-canonical gateway identity, by **name**.
 *
 * A test consumer's Edge id changes every time it is recreated, so the id is
 * not a stable key for "the test consumer of API X"; its username is. Creation
 * (`publishing.createTestConsumer`) and teardown ({@link
 * CredentialsService.disableGatewayAccess}) both take this key first and the
 * consumer's id key second — always in that order, never the reverse — so the
 * pair can never invert. The prefix keeps it disjoint from every consumer-id
 * key.
 */
export function gatewayIdentityLockKey(username: string): string {
  return `test-consumer:${username}`;
}

/**
 * Raised whenever the Nexus mirror and the live Edge array disagree in a way
 * that cannot be read unambiguously.
 *
 * The drift Nexus can produce on its own — a delete Edge applied whose
 * acknowledgement was lost — is recorded as a `retiring` row and settled by
 * {@link settleLostRetirement} before this is ever reached. What is left is
 * either a consumer edited outside Nexus, or drift compounded past the point
 * where a single reading exists. The message names the fix because the
 * operator holding the 502 is the one who has to apply it; the full procedure
 * is `operations.md` §12, "The credential mirror".
 */
const RECONCILE_MESSAGE =
  'The gateway credential list does not match the portal. An administrator must reconcile this consumer — revoke the portal’s remaining credentials for it and issue new ones, or delete the entries added to the gateway by hand — before it can be rotated or revoked';

/**
 * Raised when the target predates the append ordinal and shares that state
 * with another live row of its type, so its gateway position cannot be known.
 *
 * Not an Edge error: both sides are internally consistent, the portal simply
 * cannot say which entry is which. The fix is
 * {@link CredentialsService.reconcile}; see `operations.md` §12.
 */
const AMBIGUOUS_MESSAGE =
  'The gateway position of this credential cannot be determined: it predates the portal’s position tracking and shares that state with another live credential of the same type. An administrator must reconcile this consumer — clearing the credential type on the gateway and revoking its portal rows — after which new credentials can be issued';

/** Outcome of taking back an entry an append had already created on Edge. */
interface AppendWithdrawal {
  /** Whether the appended entry is gone from the gateway. */
  withdrawn: boolean;
  /**
   * Whether the array was still exactly as the append left it: one entry
   * longer than the length the append index was derived from, with this
   * call's entry at the tail. Necessarily `false` for `basicauth`, which no
   * read projection shows, and for any array that moved underneath the call.
   *
   * What it licenses is narrow but useful: everything that was in the array
   * before the append is provably still in it, so a paired delete that
   * reported failure really did fail, and the retirement it was going to
   * apply can be withdrawn along with the append.
   */
  arrayAsAppended: boolean;
  /**
   * Entries the type held when the array was re-read, or `null` when it could
   * not be read at all — `basicauth`, which appears in no read projection, and
   * a consumer that could not be fetched.
   *
   * A length equal to the append index is the signature of a paired delete
   * that landed after all: the array is back to the length the append index
   * was derived from, so the entry the append created is still there and the
   * one it was replacing is gone. That state settles itself on the next call
   * and must never be reported as something an administrator has to repair.
   */
  arrayLength: number | null;
}

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
  /**
   * Caller IP for the audit rows this path may write — a settlement, or an
   * append that had to be taken back. Both are ordinary audited events and
   * belong in the log with the address that caused them, exactly as the
   * `credential.issue` row the caller writes afterwards does.
   */
  ip?: string | null;
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
   * Empty one credential type on a consumer, on both sides: `DELETE
   * /consumers/{id}/credentials/{type}` on Edge, every live portal row for the
   * pair moved to `revoked`. Administrators only.
   *
   * The repair for a consumer whose credential positions can no longer be
   * trusted — the array drifted from the mirror, or live rows predate the
   * append ordinal and share a timestamp. Edge exposes neither an id nor the
   * material of an entry on read, so nothing finer-grained than "clear the type
   * and reissue" can be done without guessing which entry is which.
   */
  reconcile(
    actor: UserRecord,
    input: { consumerId: string; credentialType: CredentialType; reason?: string | null },
    ip?: string | null,
  ): Promise<ReconcileCredentialsResponse>;
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
   * any one of them throws and the durable job stays `pending`.
   *
   * Non-canonical identities are enumerated from two places. First the
   * `gateway_identities` registry — written by {@link claimGatewayIdentity}
   * **before** anything exists for the identity on the gateway, so an identity
   * whose first credential is still being appended is found and waited for
   * rather than missed. Then, for consumers that predate the registry, from
   * live credential rows. Both are consumed as they are finished — the
   * registration is deleted, the rows are `revoked` — so a retry does not
   * touch what an earlier attempt already completed.
   */
  disableGatewayAccess(userId: Uuid, subject: string): Promise<GatewayTeardown>;
  /** Restore retained active-grant groups, without restoring credential material. */
  restoreGatewayAccess(userId: Uuid, subject: string): Promise<void>;
  /** Append a credential to an arbitrary consumer — the test-consumer path. */
  issueForConsumer(
    input: IssueForConsumerInput,
  ): Promise<{ credential: CredentialRecord; secret: ShowOnceSecret }>;
  /**
   * Register a non-canonical gateway identity as `ownerId`'s, durably, before
   * anything is created for it on the gateway.
   *
   * Taken under the owner's lifecycle key — the key both disable paths flip
   * `status` under — and the owner is re-read inside it. So either the account
   * is still active and the registration is committed before any disable can
   * commit, in which case the teardown that follows the disable enumerates it
   * and waits behind the creation for its name key; or the disable committed
   * first, and this refuses with `403 USER_DISABLED` before the gateway is
   * touched. There is no third order. The caller must already hold the
   * identity's name key ({@link gatewayIdentityLockKey}).
   *
   * An upsert: recreating a test consumer, possibly by a different
   * administrator, moves the registration to the new owner.
   */
  claimGatewayIdentity(ownerId: Uuid, username: string): Promise<GatewayIdentityRecord>;
  /** Record the consumer id Edge assigned to a claimed identity. */
  bindGatewayIdentity(identity: GatewayIdentityRecord, consumerId: string): Promise<void>;
  /**
   * Compensate a claim whose issuance did not complete — the owner was
   * disabled between the claim and the append, or the gateway failed.
   *
   * Deletes `consumerId` (when one was created) and then the registration.
   * When the delete itself fails, the registration is **kept**: it is what the
   * teardown enumerates. If the owner is no longer active, the teardown job
   * that must strip the identity is made sure of: a `pending` or `sending` job
   * is already that work and is left alone; a `done` one — closed by another
   * instance that found nothing else — is reopened as `pending`. Never
   * throws; the failure that triggered the compensation is the one worth
   * reporting.
   *
   * A `null` `consumerId` does **not** mean no consumer exists. A rejected
   * `POST /consumers` may be a write Edge applied and failed to acknowledge,
   * and the answer that would have carried the id never arrived (issue #139).
   * That is what `attemptedConsumerId` is for: Nexus names every consumer it
   * asks Edge to create, so the caller knows the id of the create it is
   * compensating for even when nothing came back. One
   * `GET /consumers/{attemptedConsumerId}` settles it — found means the write
   * landed and the consumer comes down, absent means it never did — with no
   * namespace-wide username scan anywhere in the path.
   *
   * A lookup that *fails* is neither: the registration is left standing,
   * because a row kept over a consumer that is gone is reclaimable and an
   * orphan with no row is not.
   *
   * `null` for both ids means no create of this attempt ever reached the
   * gateway, and nothing is deleted. In particular a consumer that was found
   * rather than created — the one a replacement was about to take down — is
   * never touched here: it is the previous owner's until a replacement
   * actually succeeds.
   *
   * `replaced` is the registration this attempt's claim overwrote, as it stood
   * before the claim — the caller reads it to find the incumbent consumer, and
   * the claim resets the row's `ferrum_consumer_id`, so it is the only record
   * of the id left. It matters in exactly one case: nothing was created **and**
   * the incumbent was already this same account's, where the registration is
   * rebound to the incumbent instead of being deleted. See the implementation
   * for why a claim that moved the row from *another* account is abandoned
   * regardless.
   */
  abandonGatewayIdentity(
    identity: GatewayIdentityRecord,
    consumerId: string | null,
    subject: string,
    attemptedConsumerId?: string | null,
    replaced?: GatewayIdentityRecord | null,
  ): Promise<void>;
  /**
   * Take one registered gateway identity down: delete its Edge consumer,
   * revoke every credential row that named it, and consume the registration.
   *
   * The primitive behind both the account teardown ({@link
   * disableGatewayAccess}, which runs it once per registered identity) and the
   * API deletion that must collect its `nexus-test-<api_id>` consumer (issue
   * #136). The caller must **not** already hold the identity's name key: this
   * takes {@link gatewayIdentityLockKey} itself, then the consumer's id key
   * inside it — name-then-id, the order creation takes them in.
   *
   * An identity with no registration, or one whose consumer is already gone,
   * is not an error: the result simply reports nothing was found. A gateway
   * failure throws, and leaves the registration for a later attempt.
   */
  teardownGatewayIdentity(
    username: string,
    subject: string,
    options?: TeardownGatewayIdentityOptions,
  ): Promise<TeardownGatewayIdentityResult>;
}

/** Extra conditions {@link CredentialsService.teardownGatewayIdentity} checks. */
export interface TeardownGatewayIdentityOptions {
  /**
   * Tear the identity down only while it is still this account's, and only
   * while that account is still `disabled` — both re-checked **inside** the
   * critical section, which is what stops a teardown that queued behind a
   * recreation from taking the new owner's live identity with it.
   *
   * Omitted by the API-deletion path: a test consumer belongs to the API it
   * names, so whoever created it last, and whether they are still active, has
   * no bearing on the API going away.
   */
  requireDisabledOwner?: Uuid;
}

/** What one {@link CredentialsService.teardownGatewayIdentity} attempt collected. */
export interface TeardownGatewayIdentityResult {
  /** The Edge consumer that was deleted, or `null` when there was none. */
  consumer_id: string | null;
  /** How many `credential_metadata` rows moved to `revoked`. */
  revoked_credentials: number;
  /** Whether a `gateway_identities` registration was consumed. */
  registration_removed: boolean;
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
  /**
   * Store-level cross-instance lock, built in the composition root from
   * `store.leases` — the same serializer the users and god-mode services take
   * {@link userLifecycleLockKey} on, which is what orders an identity
   * registration against the status flip that disables its owner.
   *
   * Optional so a unit test can construct the service without one; a process
   * that omits it is ordered only within itself.
   */
  locks?: KeyedSerializer;
  /**
   * Structured logger, at `warn`, for a compensation that could not finish.
   *
   * The only thing that reaches it is an abandoned identity whose consumer
   * could not be deleted or could not even be looked up: the request fails for
   * its own reason, so nothing in the response says the gateway may still be
   * carrying a `nexus-test-<api_id>` consumer. The registration is kept for a
   * teardown to collect, and this line is what tells an operator to expect it.
   */
  log?: (obj: Record<string, unknown>, message: string) => void;
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

/**
 * The plaintext an Edge credential entry carries, or `null` when it is hidden.
 *
 * Every ordinary Admin API read replaces `keyauth.key` and `jwt.secret` with
 * the literal `[REDACTED]` and omits `basicauth` altogether (§4.5), so on a
 * real gateway this answers `null` for every entry a `GET` returns. It is
 * still worth asking: where the material *is* visible — a write response, a
 * gateway that does not redact — it is the strongest identity check an entry
 * has, and {@link CredentialsService} uses it to refuse a compensating delete
 * that would otherwise land on the wrong key.
 */
export function credentialMaterial(
  entry: EdgeCredentialEntry,
  type: CredentialType,
): string | null {
  let value: unknown;
  if (type === 'keyauth') {
    value = 'key' in entry ? entry.key : undefined;
  } else if (type === 'jwt') {
    value = 'secret' in entry ? entry.secret : undefined;
  } else {
    value = 'password' in entry ? entry.password : undefined;
  }
  if (typeof value !== 'string' || value === REDACTED_MATERIAL) return null;
  return value;
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
  /** Exact queued generation or worker claim. Never look up a replacement after Edge work. */
  job: GatewayTeardownJobRecord | null;
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
  let claimed: GatewayTeardownJobRecord | null = null;
  try {
    if (!input.job || input.job.user_id !== userId) {
      throw new Error('Gateway teardown has no matching queued generation');
    }
    claimed =
      input.job.status === 'pending'
        ? await store.gatewayTeardownJobs.claimPending(input.job)
        : input.job.status === 'sending'
          ? input.job
          : null;
    if (!claimed) throw new Error('Gateway teardown attempt was superseded');
    const current = await store.gatewayTeardownJobs.findByUser(userId);
    if (
      !current ||
      current.id !== claimed.id ||
      current.generation !== claimed.generation ||
      current.status !== 'sending'
    ) {
      throw new Error('Gateway teardown attempt was superseded');
    }
    const result = await credentials.disableGatewayAccess(userId, subject);
    if (!(await store.gatewayTeardownJobs.markDone(claimed, nowIso()))) {
      throw new Error('Gateway teardown attempt was superseded');
    }
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
    // Inline attempts own claims too. Return only that claim to the queue;
    // the worker applies its own backoff to claims it supplied. A failed store
    // write leaves SENDING for stale recovery, never an unfenced fallback.
    if (claimed && input.job?.status === 'pending') {
      await store.gatewayTeardownJobs.reschedule(claimed, nowIso(), message).catch(() => false);
    }
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
  const namespace = config.edge.namespace;
  // Without a lock the registration is still ordered against a disable on this
  // instance by nothing but timing — the single-instance shape a unit test uses.
  const locks: KeyedSerializer = deps.locks ?? ((_key, fn) => fn());

  /**
   * Rows still occupying an Edge array slot, in array order.
   *
   * The store already returns this order; sorting again here keeps the
   * invariant local to the code that depends on it. Rows without an ordinal
   * precede every row with one — they were all appended before the counter
   * existed — and are otherwise left in the store's tie-break order, which is
   * meaningless for position and never read as such (see
   * {@link resolveCredentialIndex}). `created_at` plays no part.
   */
  async function liveRows(consumerId: string, type: CredentialType): Promise<CredentialRecord[]> {
    const rows = await store.credentials.listByConsumer(consumerId, type);
    const live = rows.filter((row) => LIVE_STATUSES.has(row.status));
    return live
      .map((row, position) => ({ row, position }))
      .sort((a, b) => {
        if (a.row.edge_ordinal === null || b.row.edge_ordinal === null) {
          if (a.row.edge_ordinal === b.row.edge_ordinal) return a.position - b.position;
          return a.row.edge_ordinal === null ? -1 : 1;
        }
        return a.row.edge_ordinal - b.row.edge_ordinal;
      })
      .map((entry) => entry.row);
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
    if (rows.length !== edgeLength) {
      // The mirror drifted (a hand-edited consumer). Removing the entire type
      // is safe only when this is the last credential Nexus knows about.
      if (rows.length === 1) return 'whole-type';
      throw edgeError(RECONCILE_MESSAGE, { expected: rows.length, actual: edgeLength });
    }
    // A target without an ordinal sits in the leading block of legacy rows.
    // Alone there, it is index 0 whatever else is live; with company, its
    // position within that block is unknowable and acting on `index` would be
    // exactly the wrong-key deletion this module exists to prevent.
    if (target.edge_ordinal === null) {
      const unresolved = rows.filter((row) => row.edge_ordinal === null).length;
      if (unresolved > 1) {
        throw conflict(AMBIGUOUS_MESSAGE, {
          consumer_id: target.ferrum_consumer_id,
          credential_type: target.credential_type,
          unresolved_credentials: unresolved,
        });
      }
    }
    return index;
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

  /**
   * Settle a retirement Edge applied but the portal never recorded, and answer
   * with the live rows as they stand afterwards.
   *
   * A rotation and a revocation both move the row they are retiring to
   * `retiring` *before* the gateway delete, so the intent is durable before
   * anything destructive happens. When the delete's acknowledgement is lost —
   * or the write that settles the row to `revoked` fails right after it — the
   * mirror is left one row longer than the array, and every later rotate and
   * revoke of that type used to die on {@link resolveCredentialIndex}'s length
   * check. The account was then holding a live gateway credential its owner
   * could no longer revoke, which is the one operation an incident response
   * needs first.
   *
   * The repair is deliberately narrow. Exactly one row too many, and exactly
   * one live row carrying the pending intent: then that row is the entry Edge
   * no longer has, settling it makes the two views agree, and every remaining
   * row keeps its position (a positional delete shifts everything after it
   * down, which is the same order the mirror is in). Any other shape is
   * genuine drift — a consumer edited by hand — and still refuses, because
   * acting on a stale index is how somebody else's live key dies.
   *
   * `basicauth` never reaches this: Edge omits it from every read, so
   * {@link edgeArrayLength} answers with the mirror's own count and the
   * lengths can never differ. Its positions are the mirror's word alone, as
   * everywhere else in this module.
   */
  async function settleLostRetirement(input: {
    consumerId: string;
    type: CredentialType;
    /** Live rows in gateway order, as {@link liveRows} returned them. */
    rows: CredentialRecord[];
    /** Array length read from the gateway inside the same serialised block. */
    edgeLength: number;
    actor: { id: Uuid; role: Role };
    ip: string | null;
  }): Promise<CredentialRecord[]> {
    if (input.rows.length !== input.edgeLength + 1) return input.rows;
    const pending = input.rows.filter((row) => row.status === 'retiring');
    const retired = pending.length === 1 ? pending[0] : undefined;
    if (!retired) return input.rows;

    // The settlement and the row that records it commit together: a repair
    // with no trail is indistinguishable from the drift it repaired, and a
    // trail describing a repair that did not commit is worse still.
    const settled = await store.transaction(async (tx) => {
      const fresh = await tx.credentials.findById(retired.id);
      if (!fresh || fresh.status !== 'retiring') return false;
      await tx.credentials.update(retired.id, { status: 'revoked' });
      const scoped = audit.forStore(tx);
      await scoped.record(
        { id: input.actor.id, role: input.actor.role },
        AuditAction.CREDENTIAL_SETTLE,
        { type: 'credential', id: retired.id },
        {
          credential_type: input.type,
          consumer_id: input.consumerId,
          last4: retired.last4,
          owner_user_id: retired.user_id,
          mirror_rows: input.rows.length,
          gateway_entries: input.edgeLength,
        },
        input.ip,
      );
      return true;
    });
    if (!settled) return input.rows;
    return input.rows.filter((row) => row.id !== retired.id);
  }

  /**
   * Take back an entry this call appended — or leave the array alone and say
   * so.
   *
   * `appendIndex` is where `POST` put the entry: Edge appends, so it is the
   * array length read from the gateway immediately before the call. The delete
   * that undoes it is destructive and addressed by position, so it is only
   * issued when the array still looks the way the append left it — exactly one
   * entry longer than the length the index came from. Anything else means the
   * array moved underneath the call, and deleting at a stale index is how an
   * older, still-live key dies; "delete nothing" is strictly better, and the
   * caller audits the entry it had to leave behind.
   *
   * **`basicauth` is never deleted here.** It appears in no read projection at
   * all, so there is no array to check it against and the only index available
   * is one counted off the mirror — and a Nexus-only restore is documented to
   * leave the mirror shorter than the array, where that index points at a
   * pre-restore password rather than at the orphan this call created. Deleting
   * on that word is the very defect this function exists to prevent, with one
   * credential type in front of it, so the entry is left standing and the
   * caller records it as an orphan instead.
   *
   * Answers whether the entry is gone, whether the array it was read from was
   * still exactly as the append left it, and how long that array was.
   */
  async function withdrawAppendedEntry(input: {
    consumerId: string;
    type: CredentialType;
    appendIndex: number;
    /** Fingerprint of the material that was appended. */
    fingerprint: string;
    actorId: Uuid;
  }): Promise<AppendWithdrawal> {
    if (input.type === 'basicauth') {
      return { withdrawn: false, arrayAsAppended: false, arrayLength: null };
    }
    const live = await edge.consumers.get(input.consumerId).catch(() => undefined);
    // A consumer that no longer exists took its credentials with it; one that
    // cannot be read is a question mark, and a question mark is not grounds
    // for a positional delete.
    if (live === null) return { withdrawn: true, arrayAsAppended: false, arrayLength: 0 };
    if (live === undefined) return { withdrawn: false, arrayAsAppended: false, arrayLength: null };
    const entries = live.credentials[input.type];
    const arrayLength = Array.isArray(entries) ? entries.length : 0;
    const entry = Array.isArray(entries) ? entries[input.appendIndex] : undefined;
    if (arrayLength !== input.appendIndex + 1 || entry === undefined) {
      return { withdrawn: false, arrayAsAppended: false, arrayLength };
    }
    const material = credentialMaterial(entry, input.type);
    if (material !== null && crypto.fingerprint(material) !== input.fingerprint) {
      return { withdrawn: false, arrayAsAppended: false, arrayLength };
    }
    try {
      await edge.consumers.deleteCredentialAt(
        input.consumerId,
        input.type,
        input.appendIndex,
        input.actorId,
      );
      return { withdrawn: true, arrayAsAppended: true, arrayLength };
    } catch {
      // DELETE has no concurrency token and its acknowledgement can be lost
      // after Edge applies it. Re-read while the consumer lease is still held
      // before deciding which metadata rows survive the rollback.
      const after = await edge.consumers.get(input.consumerId).catch(() => undefined);
      if (after === null) {
        return { withdrawn: true, arrayAsAppended: true, arrayLength: 0 };
      }
      if (after === undefined) {
        return { withdrawn: false, arrayAsAppended: false, arrayLength: null };
      }
      const afterEntries = after.credentials[input.type];
      const afterLength = Array.isArray(afterEntries) ? afterEntries.length : 0;
      if (afterLength === input.appendIndex) {
        return { withdrawn: true, arrayAsAppended: true, arrayLength: afterLength };
      }
      if (afterLength === input.appendIndex + 1) {
        return { withdrawn: false, arrayAsAppended: true, arrayLength: afterLength };
      }
      return { withdrawn: false, arrayAsAppended: false, arrayLength: afterLength };
    }
  }

  /**
   * Whether a delete that reported failure provably never touched the array.
   *
   * `length` is the number of entries the caller read from the gateway inside
   * the lease it still holds, immediately before the delete. Nothing else may
   * be moving that array, so an array that is still exactly that long is one
   * the delete did not apply to — and the `retiring` row written before it can
   * be put back to `active`. That matters beyond tidiness: a `retiring` row
   * over an entry that is demonstrably live is the one input that could later
   * make {@link settleLostRetirement} settle the wrong row, after which a
   * positional delete would take somebody else's live key.
   *
   * Everything that cannot be proved answers `false` and leaves the row
   * `retiring`, which is the safe reading of an unknown outcome: `basicauth`,
   * which no read projection shows, a consumer that could not be read (or no
   * longer exists, taking its entries with it), and any other length.
   */
  async function deleteDidNotApply(
    consumerId: string,
    type: CredentialType,
    length: number,
  ): Promise<boolean> {
    if (type === 'basicauth') return false;
    const live = await edge.consumers.get(consumerId).catch(() => undefined);
    if (!live) return false;
    const entries = live.credentials[type];
    return (Array.isArray(entries) ? entries.length : 0) === length;
  }

  /**
   * Record an append that had to be undone, and whether it actually went.
   *
   * Best effort by construction: it runs on a path that is already failing,
   * and the error the caller is carrying is the one worth reporting.
   */
  async function recordAppendRollback(details: {
    consumerId: string;
    type: CredentialType;
    withdrawn: boolean;
    operation: 'issue' | 'rotate';
    /** The row for the appended entry, when one was written. */
    strandedCredentialId?: Uuid | null;
    /** A row left `retiring` because the write that would settle it failed. */
    retiredCredentialId?: Uuid | null;
    /**
     * Last four characters of the material that was appended, and the index it
     * was appended at — the only two things that identify an entry Edge gives
     * no id and redacts on every read. Never the material itself.
     */
    last4: string;
    appendIndex: number;
    /**
     * Whether the orphan is inferred rather than observed: the append's own
     * `POST` failed, and the array could not be shown to have grown by it.
     */
    suspected?: boolean;
    ownerId: Uuid;
    actor: { id: Uuid; role: Role };
    cause: unknown;
    ip?: string | null;
  }): Promise<void> {
    await audit
      .record(
        { id: details.actor.id, role: details.actor.role },
        AuditAction.CREDENTIAL_APPEND_ROLLBACK,
        { type: 'consumer', id: details.consumerId },
        {
          credential_type: details.type,
          consumer_id: details.consumerId,
          operation: details.operation,
          withdrawn: details.withdrawn,
          last4: details.last4,
          append_index: details.appendIndex,
          owner_user_id: details.ownerId,
          ...(details.withdrawn || !details.strandedCredentialId
            ? {}
            : { stranded_credential_id: details.strandedCredentialId }),
          ...(details.retiredCredentialId
            ? { retired_credential_id: details.retiredCredentialId }
            : {}),
          ...(details.suspected ? { suspected: true } : {}),
          cause: details.cause instanceof Error ? details.cause.message : String(details.cause),
        },
        details.ip ?? null,
      )
      .catch(() => undefined);
  }

  /**
   * Deal with an append whose `POST` came back an error but may have landed
   * anyway.
   *
   * A rejected `POST` usually means what it says — Edge refused the entry and
   * the array is untouched — but a lost acknowledgement is indistinguishable
   * from it on the wire, and there it leaves a live entry with **no row at
   * all**. That drift is the mirror one row *shorter* than the array, which
   * {@link settleLostRetirement} cannot repair in either direction: nothing
   * local records the entry, so nothing can settle it, and the operator is
   * left with a working credential the portal has never heard of.
   *
   * So the array is re-read — inside the lease the caller already holds, so
   * nothing else is moving it — and the answer is one of three:
   *
   * - **Unchanged.** The append demonstrably did not apply: the failure means
   *   exactly what it said. Nothing is deleted and nothing is recorded; the
   *   caller's error stands on its own.
   * - **One entry longer, with this call's entry at the tail.** It landed. The
   *   entry is withdrawn and the withdrawal audited: the plaintext is not
   *   being returned to anybody, so leaving it would spend a cap slot on a
   *   credential nobody holds.
   * - **Anything else** — `basicauth`, an unreadable consumer, an array that
   *   moved. The orphan can be neither confirmed nor deleted safely, so it is
   *   audited as `suspected` and left exactly where it is.
   */
  async function reclaimUnacknowledgedAppend(input: {
    consumerId: string;
    type: CredentialType;
    appendIndex: number;
    fingerprint: string;
    last4: string;
    operation: 'issue' | 'rotate';
    ownerId: Uuid;
    actor: { id: Uuid; role: Role };
    cause: unknown;
    ip: string | null;
  }): Promise<void> {
    const withdrawal = await withdrawAppendedEntry({
      consumerId: input.consumerId,
      type: input.type,
      appendIndex: input.appendIndex,
      fingerprint: input.fingerprint,
      actorId: input.actor.id,
    });
    // The array never grew, so the `POST` never landed: there is no orphan to
    // take back and nothing to put in front of an operator.
    if (!withdrawal.arrayAsAppended && withdrawal.arrayLength === input.appendIndex) return;
    await recordAppendRollback({
      consumerId: input.consumerId,
      type: input.type,
      withdrawn: withdrawal.withdrawn,
      operation: input.operation,
      // The row is written after the append, so there is none to name.
      strandedCredentialId: null,
      last4: input.last4,
      appendIndex: input.appendIndex,
      ...(withdrawal.arrayAsAppended ? {} : { suspected: true }),
      ownerId: input.ownerId,
      actor: input.actor,
      cause: input.cause,
      ip: input.ip,
    });
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

  /**
   * Append one entry to a consumer and mirror it, or leave neither behind.
   *
   * The two writes are on different systems, so there is no transaction to put
   * them in. What there is instead is a compensation: an entry Edge accepted
   * whose row could not be written is a live secret nobody in the portal can
   * see, name or revoke, so it is deleted again before the failure propagates.
   * `appendIndex` is where `POST` will have put it — Edge appends, so that is
   * the array length **read from the gateway** before the call. It must not be
   * derived from the mirror: a portal restored on its own is documented to
   * leave fewer rows than the gateway has entries, and an index counted from
   * the short side points at somebody else's older, still-live key.
   * {@link withdrawAppendedEntry} checks the array before acting on it either
   * way, and what it declines to remove is audited rather than forgotten.
   *
   * The `POST` itself is compensated on the same terms. A rejection Edge
   * applied anyway — the acknowledgement lost on the way back — would
   * otherwise leave a live entry with no row and no audit trail at all, and
   * that drift is the one shape no later call can settle: nothing local
   * records the entry ({@link reclaimUnacknowledgedAppend}).
   */
  async function appendCredential(input: {
    /** The account the row is attributed to and that the secret belongs to. */
    ownerId: Uuid;
    /** Who Edge records as the subject of the write — an admin, when acting. */
    actorId: Uuid;
    /** The actor's role, for the audit row a failed compensation writes. */
    actorRole: Role;
    consumerId: string;
    consumerUsername: string;
    type: CredentialType;
    label: string | null;
    rotatedFromId?: Uuid | null;
    /** Index the appended entry occupies, for the compensating delete. */
    appendIndex?: number;
    /** Which operation to name in that audit row. */
    operation?: 'issue' | 'rotate';
    ip?: string | null;
  }): Promise<{ credential: CredentialRecord; secret: ShowOnceSecret }> {
    const generated = generateCredential(input.type, input.consumerUsername);
    const fingerprint = crypto.fingerprint(generated.material);
    try {
      await edge.consumers.addCredential(
        input.consumerId,
        input.type,
        generated.entry,
        input.actorId,
      );
    } catch (error) {
      if (input.appendIndex !== undefined) {
        await reclaimUnacknowledgedAppend({
          consumerId: input.consumerId,
          type: input.type,
          appendIndex: input.appendIndex,
          fingerprint,
          last4: last4(generated.material),
          operation: input.operation ?? 'issue',
          ownerId: input.ownerId,
          actor: { id: input.actorId, role: input.actorRole },
          cause: error,
          ip: input.ip ?? null,
        });
      }
      throw error;
    }
    try {
      const credential = await store.credentials.create({
        user_id: input.ownerId,
        ferrum_consumer_id: input.consumerId,
        credential_type: input.type,
        // Edge assigns credential entries no id of their own; the addressable
        // resource is the per-type collection, and position is tracked by
        // `edge_ordinal`, which the store assigns here as the next value for
        // this consumer and type — under the consumer lease the caller holds,
        // which is what makes it the entry's true append position.
        ferrum_credential_id: `${input.consumerId}/credentials/${input.type}`,
        fingerprint,
        last4: last4(generated.material),
        label: input.label,
        status: 'active',
        rotated_from_id: input.rotatedFromId ?? null,
      });
      return { credential, secret: generated.secret };
    } catch (error) {
      if (input.appendIndex !== undefined) {
        // The store failure is the one worth reporting, but the entry it
        // failed to mirror is not allowed to disappear from the record: a
        // withdrawal that could not be made safely leaves a live secret
        // nobody holds, and only the audit row says where it is.
        const { withdrawn } = await withdrawAppendedEntry({
          consumerId: input.consumerId,
          type: input.type,
          appendIndex: input.appendIndex,
          fingerprint,
          actorId: input.actorId,
        });
        await recordAppendRollback({
          consumerId: input.consumerId,
          type: input.type,
          withdrawn,
          operation: input.operation ?? 'issue',
          // The row is what failed to be written, so there is none to name.
          // What names the entry instead is where it went and what it ends in.
          strandedCredentialId: null,
          last4: last4(generated.material),
          appendIndex: input.appendIndex,
          ownerId: input.ownerId,
          actor: { id: input.actorId, role: input.actorRole },
          cause: error,
          ip: input.ip ?? null,
        });
      }
      throw error;
    }
  }

  async function issueForConsumer(
    input: IssueForConsumerInput,
  ): Promise<{ credential: CredentialRecord; secret: ShowOnceSecret }> {
    if (!(CREDENTIAL_TYPES as readonly string[]).includes(input.credentialType)) {
      throw validationFailed(`Unsupported credential type '${input.credentialType}'`);
    }
    return edge.serializePerKey(input.consumerId, async () => {
      await assertOwnerActive(input.user.id);
      // The gateway, not the mirror, says where `POST` will put the entry —
      // and the read is race-free because the consumer's lease is already
      // held, exactly as it is for `rotate`. Counting from the mirror is what
      // made a failed issue on a Nexus-only restore delete the pre-restore key
      // instead of the orphan it had just created.
      const consumer = await edge.consumers.get(input.consumerId);
      if (!consumer) throw edgeError('The gateway consumer for this account no longer exists');
      const live = await liveRows(input.consumerId, input.credentialType);
      const length = edgeArrayLength(consumer.credentials, input.credentialType, live.length);
      const rows = await settleLostRetirement({
        consumerId: input.consumerId,
        type: input.credentialType,
        rows: live,
        edgeLength: length,
        actor: { id: input.user.id, role: input.user.role },
        ip: input.ip ?? null,
      });
      // The cap is a portal policy over the account's own credentials, so it
      // is counted on the mirror; the gateway enforces its own on the append.
      if (input.skipCap !== true && rows.length >= cap) {
        throw conflict(
          `You already hold ${rows.length} live ${input.credentialType} credentials (the gateway allows ${cap}); revoke or rotate one first`,
          { credential_type: input.credentialType, limit: cap },
        );
      }
      return appendCredential({
        ownerId: input.user.id,
        actorId: input.user.id,
        actorRole: input.user.role,
        consumerId: input.consumerId,
        consumerUsername: input.consumerUsername,
        type: input.credentialType,
        label: input.label ?? null,
        appendIndex: length,
        operation: 'issue',
        ip: input.ip ?? null,
      });
    });
  }

  return {
    provisioner,
    issueForConsumer,

    async teardownGatewayIdentity(
      username,
      subject,
      options,
    ): Promise<TeardownGatewayIdentityResult> {
      return teardownIdentity(username, subject, options);
    },

    async claimGatewayIdentity(ownerId, username): Promise<GatewayIdentityRecord> {
      return locks(userLifecycleLockKey(ownerId), async () => {
        // Inside the key, so the answer cannot change between here and the
        // write: a disable is either already committed, or waiting for this.
        await assertOwnerActive(ownerId);
        return store.gatewayIdentities.claim({
          user_id: ownerId,
          namespace,
          ferrum_username: username,
          ferrum_consumer_id: null,
        });
      });
    },

    async bindGatewayIdentity(identity, consumerId): Promise<void> {
      await store.gatewayIdentities.bindConsumer(identity.id, consumerId);
    },

    async abandonGatewayIdentity(
      identity,
      consumerId,
      subject,
      attemptedConsumerId = null,
      replaced = null,
    ): Promise<void> {
      // A replacement that stopped before asking Edge to create anything, over
      // an incumbent **the same account already owned**: point the row back at
      // the incumbent rather than delete it. The claim cleared the row's
      // `ferrum_consumer_id`, and a consumer that itself replaced one carries a
      // random id — no derivation leads back to it — so dropping the row would
      // strand a live consumer that only the account teardown's credential-row
      // sweep could still reach, and the API deletion, which resolves the
      // identity by name alone, never could.
      //
      // Owner equality is the whole of the condition. When the claim *moved*
      // the registration from another account — an administrator recreating a
      // provider's test consumer — the incumbent is still that provider's, and
      // a row naming the claimant would hand their teardown someone else's live
      // consumer. Such a claim is abandoned exactly as an unbound one is: the
      // previous owner's own credential rows are what lead their teardown to
      // the consumer.
      if (
        consumerId === null &&
        attemptedConsumerId === null &&
        replaced !== null &&
        replaced.ferrum_consumer_id !== null &&
        replaced.user_id === identity.user_id
      ) {
        await store.gatewayIdentities
          .bindConsumer(identity.id, replaced.ferrum_consumer_id)
          .catch(() => {
            // Even unbound, the retained registration makes teardown fall back
            // to the bounded username lookup instead of losing the identity.
          });
        return;
      }
      let created = consumerId;
      if (created === null && attemptedConsumerId !== null) {
        // The create was rejected — but a rejection is not proof the gateway
        // did not apply it, and the caller only ever holds an id the *answer*
        // gave it. It does hold the id it *asked for*, though, because Nexus
        // names every consumer it creates: one read of that id says which of
        // the two happened.
        try {
          created = (await edge.consumers.get(attemptedConsumerId))?.id ?? null;
        } catch (error) {
          // The gateway cannot say whether the consumer exists, so neither can
          // this. Keep the registration: it is the only thing that will lead
          // anyone back to an orphan, and it costs nothing when there is none.
          deps.log?.(
            {
              user_id: identity.user_id,
              consumer_username: identity.ferrum_username,
              consumer_id: attemptedConsumerId,
              error: error instanceof Error ? error.message : String(error),
            },
            'an abandoned gateway identity could not be resolved; its registration was kept for teardown',
          );
          await ensureTeardownOwed(identity.user_id).catch(() => undefined);
          return;
        }
      }
      if (created !== null) {
        const live = created;
        try {
          // The caller holds the identity's name key and has left the
          // consumer's id key (the append that failed released it), so this
          // is the same name-then-id order as everywhere else.
          await edge.serializePerKey(live, () => edge.consumers.delete(live, subject));
        } catch (error) {
          // The consumer is still up, carrying the API's approval group. The
          // registration stays — it is what a teardown enumerates — and if the
          // owner is no longer active, a teardown must be owed for it.
          deps.log?.(
            {
              user_id: identity.user_id,
              consumer_username: identity.ferrum_username,
              consumer_id: live,
              error: error instanceof Error ? error.message : String(error),
            },
            'an abandoned gateway identity could not be deleted; its registration was kept for teardown',
          );
          await ensureTeardownOwed(identity.user_id).catch(() => undefined);
          return;
        }
      }
      // Only ever the registration that is still this owner's: the row keeps
      // its id across owners, so the owner is what says whether it is ours.
      const current = await store.gatewayIdentities
        .findByUsername(namespace, identity.ferrum_username)
        .catch(() => null);
      if (current && current.user_id === identity.user_id) {
        await store.gatewayIdentities.delete(current.id).catch(() => undefined);
      }
    },

    async restoreGatewayAccess(userId, subject): Promise<void> {
      const consumer = await provisioner.findConsumer(userId);
      if (!consumer) {
        if ((await store.grants.listActiveByUser(userId)).length > 0) {
          throw edgeError('Active grants have no canonical gateway consumer mapping');
        }
        // A provider with only disposable test identities needs no canonical
        // consumer, and re-enabling must not recreate those identities.
        return;
      }
      await edge.serializePerKey(consumer.ferrum_consumer_id, async () => {
        const owner = await store.users.findById(userId);
        if (!owner || owner.status !== 'active') {
          throw userDisabled('This account is no longer active; gateway access was not restored');
        }
        // Read grants inside the same consumer section as approvals,
        // revocations, and teardown. A revocation that claims a grant after
        // this read removes its group after this write; one that won before
        // the read is never replayed here.
        const grants = await store.grants.listActiveByUser(userId);
        if (grants.length === 0) return;
        const live = await edge.consumers.get(consumer.ferrum_consumer_id);
        if (!live) throw edgeError('The gateway consumer for this account no longer exists');
        const groups = [
          ...new Set([...(live.acl_groups ?? []), ...grants.map((grant) => grant.acl_group)]),
        ];
        await edge.consumers.replace(
          live.id,
          {
            id: live.id,
            username: live.username,
            custom_id: live.custom_id ?? null,
            credentials: live.credentials,
            acl_groups: groups,
          },
          subject,
        );
      });
    },

    async disableGatewayAccess(userId, subject): Promise<GatewayTeardown> {
      const consumer = await provisioner.findConsumer(userId);
      const consumerId = consumer?.ferrum_consumer_id ?? null;
      let revoked = 0;
      const deleted: string[] = [];

      // Everything else the account can still authenticate as. A provider's
      // `nexus-test-<apiId>` consumer is a *separate* Edge identity carrying a
      // credential attributed to whoever created it, and it holds the API's
      // approval group, so leaving it up defeats the whole offboarding.
      //
      // The registry first. A registration is written before the identity
      // exists on the gateway and under the owner's lifecycle key, so by the
      // time this runs — after the status flip, which takes the same key —
      // every identity the account got as far as registering is here, whether
      // or not its first credential has landed yet. Its name key is the one
      // creation holds for the whole of its work, so an in-flight issuance is
      // waited for and then undone rather than raced.
      for (const identity of await store.gatewayIdentities.listByUser(userId, namespace)) {
        const outcome = await teardownIdentity(identity.ferrum_username, subject, {
          requireDisabledOwner: userId,
        });
        revoked += outcome.revoked_credentials;
        if (outcome.consumer_id !== null) deleted.push(outcome.consumer_id);
      }

      // Then whatever predates the registry: consumers the account holds live
      // credential rows on and nothing else records. Reading live rows is also
      // what makes a retry skip the identities an earlier attempt finished —
      // their rows are `revoked`, so they never come back into this list.
      const foreign = await foreignConsumerIds(userId, consumerId);

      if (consumerId === null && foreign.length === 0) {
        return {
          consumer_id: null,
          revoked_credentials: revoked,
          removed_groups: [],
          deleted_consumers: deleted,
        };
      }

      // Each identity gets its own critical section, keyed on its own consumer
      // id — the same key its issue path locks, so a teardown and an in-flight
      // append can never interleave. Sequential, not concurrent: a failure must
      // leave the identities behind it untouched for the retry to pick up.
      for (const foreignId of foreign) {
        revoked += await edge.serializePerKey(foreignId, async () => {
          await assertStillDisabled(userId);
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
        await assertStillDisabled(userId);
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
        ip,
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

        // The owner, not the actor: an admin rotating somebody else's key must
        // not be able to hand a disabled account a working one.
        await assertOwnerActive(current.user_id);

        const consumer = await edge.consumers.get(consumerId);
        if (!consumer) throw edgeError('The gateway consumer for this credential no longer exists');
        const live = await liveRows(consumerId, type);
        const length = edgeArrayLength(consumer.credentials, type, live.length);
        // A retirement whose delete Edge applied but never acknowledged is
        // settled here rather than refused: the mirror is one row longer than
        // the array, and refusing would leave the surviving credential
        // unrotatable and unrevokable for good.
        const rows = await settleLostRetirement({
          consumerId,
          type,
          rows: live,
          edgeLength: length,
          actor: { id: user.id, role: user.role },
          ip,
        });
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

        let previous = current;
        if (!appendFirst) {
          // The intent before the act. `retiring` is durable, still counts as
          // a live slot, and is what {@link settleLostRetirement} resolves if
          // the delete lands and its acknowledgement does not — the case where
          // no local write follows the delete at all.
          await store.credentials.update(current.id, { status: 'retiring' });
          try {
            await removeAt(consumerId, type, position, user.id);
          } catch (error) {
            // A delete that provably never touched the array is not a lost
            // acknowledgement, and the row must not be left claiming it might
            // be: `retiring` over an entry that is demonstrably live is the
            // one input that could make a later {@link settleLostRetirement}
            // settle the wrong row, after which a positional delete takes
            // somebody else's live key. Nothing else changed — no append has
            // been attempted yet — so the account is left exactly as the
            // rotation found it, cap slot included.
            if (await deleteDidNotApply(consumerId, type, length)) {
              await store.credentials
                .update(current.id, { status: 'active' })
                .catch(() => undefined);
            }
            throw error;
          }
          // Immediately, not at the end. The delete is the destructive step and
          // Edge has confirmed it; deferring the row until the append also
          // succeeds is what left two `active` rows against one Edge entry
          // after a failed append, and `resolveCredentialIndex` then refused
          // every later operation on the *surviving* credential — including the
          // revoke an incident response needs.
          previous = (await store.credentials.update(current.id, { status: 'revoked' })) ?? current;
        }

        const created = await appendCredential({
          // The replacement belongs to whoever the credential belonged to. An
          // admin may rotate somebody else's key — `loadOwned` allows it — but
          // rotating is not taking: attributing the row to the admin would put
          // the replacement on a consumer the owner cannot list it against, and
          // the owner's own `DELETE` of it would come back 403.
          ownerId: current.user_id,
          // The admin is still the actor: theirs is the id Edge records as the
          // write's subject, and the one the Nexus audit row names.
          actorId: user.id,
          consumerId,
          consumerUsername: consumer.username,
          type,
          label: label ?? current.label,
          rotatedFromId: current.id,
          appendIndex: appendFirst ? length : length - 1,
          actorRole: user.role,
          operation: 'rotate',
          ip,
        }).catch((error: unknown) => {
          if (appendFirst) throw error;
          // At the cap the old secret is already gone and cannot be recreated —
          // it was show-once. Say so plainly rather than leaving the caller to
          // assume nothing happened and keep using a key that no longer exists.
          throw edgeError(
            'The previous credential was removed from the gateway but its replacement could not be created; issue a new credential',
            {
              credential_type: type,
              revoked_credential_id: current.id,
              cause: error instanceof Error ? error.message : String(error),
            },
          );
        });

        if (appendFirst) {
          try {
            // As above: the retirement is recorded before it is attempted, so a
            // lost acknowledgement leaves a row a later call can settle rather
            // than a silent length mismatch that wedges the type. Inside the
            // `try`, because a store error here strands the replacement that
            // was just appended exactly as a failed delete does — the same end
            // state, reached by a different fault — and it is compensated the
            // same way.
            await store.credentials.update(current.id, { status: 'retiring' });
            // `POST` appends, so the old entry's index is unchanged by the append.
            await removeAt(consumerId, type, position, user.id);
          } catch (error) {
            // A rotation either hands the caller a new secret or leaves the
            // account as it found it. The replacement's plaintext is already
            // lost — it is show-once and this call is not returning it — so an
            // append left standing is a credential nobody can use that still
            // occupies one of the per-type cap slots. Take it back.
            const { withdrawn, arrayAsAppended, arrayLength } = await withdrawAppendedEntry({
              consumerId,
              type,
              appendIndex: length,
              fingerprint: created.credential.fingerprint,
              actorId: user.id,
            });
            if (withdrawn) {
              // Never delivered and now gone from the gateway: the row would
              // only ever be a credential the owner cannot use or explain.
              await store.credentials.delete(created.credential.id).catch(() => undefined);
            }
            if (arrayAsAppended) {
              // The array still held every entry the append landed on, so the
              // delete that reported failure really did fail and the entry
              // being retired is still there. Withdraw the intent with the
              // append: leaving a row `retiring` over a credential that is
              // demonstrably live is the one input that could later make
              // {@link settleLostRetirement} settle the wrong row.
              await store.credentials
                .update(current.id, { status: 'active' })
                .catch(() => undefined);
            }
            await recordAppendRollback({
              consumerId,
              type,
              withdrawn,
              operation: 'rotate',
              strandedCredentialId: created.credential.id,
              last4: created.credential.last4,
              appendIndex: length,
              ownerId: current.user_id,
              actor: { id: user.id, role: user.role },
              cause: error,
              ip,
            });
            if (!withdrawn) {
              // What the caller is told depends on what the array proved, and
              // only one of the three shapes is an administrator's problem.
              let message =
                'The previous credential could not be removed from the gateway and the replacement created for it could not be taken back; an administrator must reconcile this consumer';
              if (arrayLength === length) {
                // The array is back to the length the append index came from:
                // the delete landed after all and only its acknowledgement was
                // lost. The previous credential is gone, the replacement is the
                // entry that remains, and the row left `retiring` is settled by
                // the next call on this consumer and type. Steering the
                // operator at `reconcile`, which empties the type on both
                // sides, would destroy a state that repairs itself.
                message =
                  'The gateway did not acknowledge removing the previous credential and no longer holds it; the replacement created in its place is live but its secret was never delivered — revoke the credential named here and issue a new one';
              } else if (arrayAsAppended || type === 'basicauth') {
                // Every entry the append landed on is still there and each one
                // has a row, so the two views agree and the owner can finish
                // this themselves. `basicauth` reads the same way for a
                // different reason: no projection shows it, so the mirror is
                // the only word on that type and it holds a live row for each.
                message =
                  'The previous credential could not be removed from the gateway and the replacement created for it could not be taken back; the portal holds a live row for each — revoke the credential named here and try again';
              }
              throw edgeError(message, {
                credential_type: type,
                consumer_id: consumerId,
                stranded_credential_id: created.credential.id,
                retired_credential_id: current.id,
                cause: error instanceof Error ? error.message : String(error),
              });
            }
            throw error;
          }
          try {
            previous =
              (await store.credentials.update(current.id, { status: 'revoked' })) ?? current;
          } catch (error) {
            // The delete is confirmed: the previous entry is gone, the row
            // stays `retiring` and the next call on this pair settles it.
            // Withdrawing the replacement now would leave the account with no
            // credential of this type at all, so it stands — but its show-once
            // secret is not being returned and no `credential.rotate` row will
            // ever be written, so the rotation would otherwise have mutated
            // the gateway and left nothing in the log to say so.
            await recordAppendRollback({
              consumerId,
              type,
              withdrawn: false,
              operation: 'rotate',
              strandedCredentialId: created.credential.id,
              retiredCredentialId: current.id,
              last4: created.credential.last4,
              appendIndex: length,
              ownerId: current.user_id,
              actor: { id: user.id, role: user.role },
              cause: error,
              ip,
            });
            throw error;
          }
        }

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
          // Only when they differ: an admin acting on somebody else's
          // credential is the case worth being able to find in the log.
          ...(target.user_id === user.id ? {} : { owner_user_id: target.user_id }),
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
          const live = await liveRows(consumerId, type);
          const length = edgeArrayLength(consumer.credentials, type, live.length);
          // Settle a retirement Edge applied but never acknowledged before
          // resolving anything: the drift it leaves used to refuse this very
          // call, which is the one an incident response cannot do without.
          const rows = await settleLostRetirement({
            consumerId,
            type,
            rows: live,
            edgeLength: length,
            actor: { id: user.id, role: user.role },
            ip,
          });
          const position = resolveCredentialIndex(rows, current, length);
          // `not-live` follows the status check above whenever the settlement
          // was this very row — its entry is already gone. Either way, treat it
          // as a completed revoke rather than a whole-type delete.
          if (position !== 'not-live') {
            // The intent before the act, so a lost acknowledgement leaves a row
            // the next call can settle instead of a mirror one row too long.
            await store.credentials.update(current.id, { status: 'retiring' });
            try {
              await removeAt(consumerId, type, position, user.id);
            } catch (error) {
              // A delete the array proves never happened is not a lost
              // acknowledgement. Leaving the row `retiring` over an entry that
              // is demonstrably live is the one input that could make a later
              // {@link settleLostRetirement} settle the wrong row — after
              // which a positional delete takes somebody else's live key — so
              // the intent is withdrawn and the caller retries the revoke.
              // An outcome that cannot be proved stays `retiring`, which is
              // the safe reading.
              if (await deleteDidNotApply(consumerId, type, length)) {
                await store.credentials
                  .update(current.id, { status: 'active' })
                  .catch(() => undefined);
              }
              throw error;
            }
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

    async reconcile(actor, input, ip = null): Promise<ReconcileCredentialsResponse> {
      if (!roleAtLeast(actor.role, 'admin')) {
        throw forbidden('Only an administrator can reconcile a gateway consumer’s credentials');
      }
      const { consumerId, credentialType: type } = input;
      if (!(CREDENTIAL_TYPES as readonly string[]).includes(type)) {
        throw validationFailed(`Unsupported credential type '${String(type)}'`);
      }

      const result = await edge.serializePerKey(consumerId, async () => {
        const live = await edge.consumers.get(consumerId);
        // Gateway first: a row may only say `revoked` once its entry is gone.
        // The whole-type delete is idempotent, so a type Edge no longer holds
        // — or never shows, as with `basicauth` on every read — costs one 204.
        if (live) await edge.consumers.deleteCredentialType(consumerId, type, actor.id);
        const revokedIds: Uuid[] = [];
        const owners = new Set<Uuid>();
        for (const row of await store.credentials.listByConsumer(consumerId, type)) {
          if (!LIVE_STATUSES.has(row.status)) continue;
          await store.credentials.update(row.id, { status: 'revoked' });
          revokedIds.push(row.id);
          owners.add(row.user_id);
        }
        return { gatewayCleared: live !== null, revokedIds, owners: [...owners] };
      });

      await audit.record(
        { id: actor.id, role: actor.role },
        AuditAction.CREDENTIAL_RECONCILE,
        { type: 'consumer', id: consumerId },
        {
          credential_type: type,
          consumer_id: consumerId,
          gateway_cleared: result.gatewayCleared,
          revoked_credentials: result.revokedIds.length,
          revoked_credential_ids: result.revokedIds,
          owner_user_ids: result.owners,
          ...(input.reason ? { reason: input.reason } : {}),
        },
        ip,
      );

      // A courtesy, like every notification: the account holder has to learn
      // that their credentials stopped working and why.
      for (const ownerId of result.owners) {
        await notifications
          .notify(
            ownerId,
            'system',
            'Gateway credentials reset',
            `Your ${type} credentials were reset by an administrator; issue new ones from the credentials page.`,
            '/credentials',
          )
          .catch(() => undefined);
      }

      return {
        consumer_id: consumerId,
        credential_type: type,
        revoked_credentials: result.revokedIds.length,
        gateway_cleared: result.gatewayCleared,
      };
    },
  };

  /**
   * Refuse a gateway write on behalf of an account that is no longer active.
   *
   * `serializePerKey` orders writes against a consumer; it does not
   * re-authorise them. A `POST /api/credentials` that passed authentication a
   * moment before an admin hit disable is still a valid request object when it
   * reaches the front of the queue — and if it runs after the teardown, it
   * mints a key on a disabled account that nothing is retrying to remove.
   *
   * So the owner is reloaded **inside** the critical section, after the lock is
   * held and before any Edge write. Teardown takes the same key, which makes
   * the two orders the only two possible: the append wins the lock and the
   * teardown behind it deletes what it appended, or the teardown wins and the
   * append then sees `disabled` and is refused.
   */
  async function assertOwnerActive(userId: Uuid): Promise<void> {
    const owner = await store.users.findById(userId);
    if (!owner) throw notFound('User', userId);
    if (owner.status !== 'active') {
      throw userDisabled('This account has been disabled; its gateway access cannot be extended');
    }
  }

  /**
   * Refuse to strip an account that is no longer disabled.
   *
   * A teardown job claimed before a re-enable would otherwise land afterwards
   * and take a live account's credentials with it. The worker checks at claim
   * time; this is the check that matters, because it runs inside the same
   * per-consumer critical section as the Edge write it guards.
   */
  async function assertStillDisabled(userId: Uuid): Promise<void> {
    const owner = await store.users.findById(userId);
    if (!owner) return;
    if (owner.status !== 'disabled') {
      throw conflict('That account is no longer disabled; its gateway access was left alone', {
        user_id: userId,
        status: owner.status,
      });
    }
  }

  /**
   * Make sure a disabled (or deleted-in-progress) owner still owes a teardown.
   *
   * A compensation that could not delete the consumer it created has left a
   * live identity behind. The teardown that is waiting on the identity's name
   * key will get it — in-process — but a teardown on another instance may
   * have timed out on the key and, having found nothing else, could have
   * closed its job. Rotate the generation so an attempt that already enumerated
   * identities cannot subsequently settle this newly discovered work.
   */
  async function ensureTeardownOwed(userId: Uuid): Promise<void> {
    await locks(userLifecycleLockKey(userId), () =>
      store.transaction(async (tx) => {
        const owner = await tx.users.findById(userId);
        if (!owner || owner.status !== 'disabled') return;
        const matched = await tx.users.updateIfMatches(
          userId,
          { role: owner.role, status: 'disabled' },
          { status: 'disabled' },
        );
        if (!matched) throw conflict('That account changed while queuing gateway recovery');
        await tx.gatewayTeardownJobs.upsertPending(userId, null, nowIso());
      }),
    );
  }

  /**
   * Every Edge consumer other than `canonicalId` that this account still holds
   * live credential material on, in a stable order.
   *
   * In practice that is the account's provider test consumers from before the
   * `gateway_identities` registry existed: `issue` only ever writes rows
   * against the caller's own consumer, while `createTestConsumer` writes one
   * against `nexus-test-<apiId>` attributed to the provider or admin who asked
   * for it. Registered identities are torn down — and their rows revoked —
   * before this is read, so they do not reappear here.
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

  /**
   * Take one registered identity down, under its own name key.
   *
   * Extracted from the account teardown so API deletion can collect the
   * `nexus-test-<api_id>` consumer through exactly the same steps rather than
   * a second implementation of them (issue #136). The only account-specific
   * part is `requireDisabledOwner`, which the API path does not pass.
   */
  async function teardownIdentity(
    username: string,
    subject: string,
    options?: TeardownGatewayIdentityOptions,
  ): Promise<TeardownGatewayIdentityResult> {
    return edge.serializePerKey(gatewayIdentityLockKey(username), async () => {
      const owner = options?.requireDisabledOwner;
      if (owner !== undefined) await assertStillDisabled(owner);
      // Re-read under the key: the registration may have changed hands while
      // this teardown waited for it — an administrator recreating the test
      // consumer takes it over, and their replacement has already revoked the
      // previous owner's rows on the old consumer.
      const current = await store.gatewayIdentities.findByUsername(namespace, username);
      if (owner !== undefined && (!current || current.user_id !== owner)) {
        return { consumer_id: null, revoked_credentials: 0, registration_removed: false };
      }

      // By id once the registration is bound: one read, on a gateway of any
      // size. The bound id is the id Nexus *asked* Edge to assign, and a
      // replacement's is written before the `POST` that uses it, so a
      // creation interrupted anywhere after that point still leads straight
      // to the consumer and a `get` that answers "no such consumer" is proof
      // the create never landed.
      //
      // A registration that stopped before even that — claimed, nothing asked
      // for yet — is resolved by the id the username derives to, which is the
      // id the *first* consumer of a name always carries, and only an identity
      // older than that derivation falls through to the capped scan. Past the
      // cap the scan throws rather than answering "not found", so the caller
      // keeps the registration intact instead of closing over a consumer
      // nobody looked at.
      //
      // No registration at all is still worth one derived-id read: it is what
      // an identity stranded before #139 was fixed looks like, and one `GET`
      // is what it takes to collect it rather than leave it on the gateway for
      // good. Never the scan in that case — there is nothing to say a consumer
      // was ever created, so a namespace-wide read would be paid on every
      // deletion of an API that simply never had a test consumer.
      const live = !current
        ? await edge.consumers.get(edge.consumers.derivedId(username))
        : current.ferrum_consumer_id !== null
          ? await edge.consumers.get(current.ferrum_consumer_id)
          : ((await edge.consumers.get(edge.consumers.derivedId(username))) ??
            (await edge.consumers.getByUsername(username)));
      let revoked = 0;
      if (live) {
        // Name, then id — the order creation takes the two keys in. A test
        // consumer is disposable by definition, so it goes away entirely
        // rather than being stripped and left as an empty identity.
        revoked += await edge.serializePerKey(live.id, async () => {
          await edge.consumers.delete(live.id, subject);
          return revokeRowsFor(live.id);
        });
      }
      if (
        current &&
        current.ferrum_consumer_id !== null &&
        current.ferrum_consumer_id !== live?.id
      ) {
        // The consumer this registration last knew is already gone; whatever
        // rows still describe it cannot authenticate anything.
        revoked += await revokeRowsFor(current.ferrum_consumer_id);
      }
      // Consumed: a retry must not come back to an identity that is done.
      if (current) await store.gatewayIdentities.delete(current.id);
      return {
        consumer_id: live?.id ?? null,
        revoked_credentials: revoked,
        registration_removed: current !== null,
      };
    });
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
