import { isDeepStrictEqual } from 'node:util';

/**
 * Owner contract: Edge v0.9.13 (9b83115de7ec23ab51ec4feae6bed65e596db425), schema v2
 * (`backend-egress-policy` v2 in contracts-edge-0.9.13). Schema 2 keeps v1's shape but
 * narrows `public_only_guaranteed`: it is true only for `local-data-plane`. Edge v0.9.14
 * adds the optional control-plane `data_plane_attestation` object within schema 2
 * (`openapi.yaml` `DataPlaneEgressAttestation`, `src/admin/backend_egress_policy.rs`).
 */
export interface BackendEgressPolicy {
  schema_version: 2;
  ip_classification: 'ferrum-private-reserved-v1';
  namespace: string;
  policy_scope: 'process';
  enforcement_scope: 'local-data-plane' | 'unserved-namespace' | 'admission-only' | 'no-data-plane';
  mode: 'both' | 'public' | 'private';
  mode_allowed_ip_classes: ('public' | 'private-reserved')[];
  mode_blocked_ip_classes: ('public' | 'private-reserved')[];
  dangerous_ranges_blocked: boolean;
  allow_cidr_overrides_present: boolean;
  deny_cidr_overrides_present: boolean;
  evaluation_order: ['allow-cidrs', 'deny-cidrs', 'dangerous-ranges', 'ip-mode'];
  public_only_guaranteed: boolean;
  /** Control plane only (`admission-only`), and only from Edge v0.9.14. */
  data_plane_attestation?: DataPlaneEgressAttestation;
}

/** Presence-only policy one data plane self-reported to its control plane. */
export interface DataPlaneEgressPolicy {
  mode: 'both' | 'public' | 'private';
  mode_allowed_ip_classes: ('public' | 'private-reserved')[];
  mode_blocked_ip_classes: ('public' | 'private-reserved')[];
  dangerous_ranges_blocked: boolean;
  allow_cidr_overrides_present: boolean;
  deny_cidr_overrides_present: boolean;
  public_only_guaranteed: boolean;
}

/** One live ConfigSync stream of the selected namespace. */
export interface DataPlaneEgressEntry {
  node_id: string;
  connected_at: string;
  attestation: 'reported' | 'unknown';
  policy: DataPlaneEgressPolicy | null;
}

/**
 * What a control plane's connected data planes reported, at the moment of the
 * read. Disconnected data planes still serving cached config are not listed.
 */
export interface DataPlaneEgressAttestation {
  source: 'configsync-subscribe';
  connected_data_planes: number;
  reporting_data_planes: number;
  unknown_data_planes: number;
  weakest_policy: DataPlaneEgressPolicy | null;
  weakest_policy_complete: boolean;
  all_connected_public_only_guaranteed: boolean;
  data_planes: DataPlaneEgressEntry[];
}

const KEYS = [
  'schema_version',
  'ip_classification',
  'namespace',
  'policy_scope',
  'enforcement_scope',
  'mode',
  'mode_allowed_ip_classes',
  'mode_blocked_ip_classes',
  'dangerous_ranges_blocked',
  'allow_cidr_overrides_present',
  'deny_cidr_overrides_present',
  'evaluation_order',
  'public_only_guaranteed',
];
const EVALUATION_ORDER = ['allow-cidrs', 'deny-cidrs', 'dangerous-ranges', 'ip-mode'];
const DATA_PLANE_ATTESTATION_KEY = 'data_plane_attestation';
const ATTESTATION_KEYS = [
  'source',
  'connected_data_planes',
  'reporting_data_planes',
  'unknown_data_planes',
  'weakest_policy',
  'weakest_policy_complete',
  'all_connected_public_only_guaranteed',
  'data_planes',
];
const DATA_PLANE_ENTRY_KEYS = ['node_id', 'connected_at', 'attestation', 'policy'];
const DATA_PLANE_POLICY_KEYS = [
  'mode',
  'mode_allowed_ip_classes',
  'mode_blocked_ip_classes',
  'dangerous_ranges_blocked',
  'allow_cidr_overrides_present',
  'deny_cidr_overrides_present',
  'public_only_guaranteed',
];

type EgressMode = BackendEgressPolicy['mode'];
type IpClass = 'public' | 'private-reserved';

function exactArray(value: unknown, expected: string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(row: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(row).length === keys.length && keys.every((key) => Object.hasOwn(row, key));
}

function isEgressMode(value: unknown): value is EgressMode {
  return value === 'both' || value === 'public' || value === 'private';
}

/** Edge's fixed `ferrum-private-reserved-v1` mode-stage class lists. */
function modeClasses(mode: EgressMode): { allowed: IpClass[]; blocked: IpClass[] } {
  if (mode === 'both') return { allowed: ['public', 'private-reserved'], blocked: [] };
  if (mode === 'public') return { allowed: ['public'], blocked: ['private-reserved'] };
  return { allowed: ['private-reserved'], blocked: ['public'] };
}

/**
 * The only policy schema this portal reads. Edge v0.9.13 and later publish
 * schema 2 and never 1 (Edge v0.9.14 adds the optional control-plane
 * `data_plane_attestation` within it). Schema 1 (Edge v0.9.11 and v0.9.12)
 * reported the policy-only value of `public_only_guaranteed`, so the same field
 * meant something else: it is refused rather than reinterpreted.
 */
export const SUPPORTED_EGRESS_POLICY_SCHEMA = 2;

/**
 * True when the gateway answered with a well-formed object naming a schema
 * version this portal does not read. Still a refusal; it only lets the operator
 * tell a version ceiling from a malformed response.
 */
export function isUnsupportedEgressPolicySchema(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const version = (value as Record<string, unknown>).schema_version;
  return (
    typeof version === 'number' &&
    Number.isInteger(version) &&
    version !== SUPPORTED_EGRESS_POLICY_SCHEMA
  );
}

/**
 * Why a `data_plane_attestation` was set aside. Bounded vocabulary, logged as is.
 *
 * - `malformed`: not the owner shape (a missing, unknown or mistyped key).
 * - `inconsistent`: the summary disagrees with the listed streams.
 * - `out_of_scope`: attached to an answer that is not a control plane's.
 */
export type DataPlaneAttestationProblem = 'malformed' | 'inconsistent' | 'out_of_scope';

/** A recognized policy, and whether its data-plane attestation had to be set aside. */
export interface BackendEgressPolicyReading {
  /** Never carries an attestation that was set aside. */
  policy: BackendEgressPolicy;
  attestationProblem: DataPlaneAttestationProblem | null;
}

/**
 * Closed parsing of the process policy: never infer policy from mode alone or
 * tolerate future vocabulary there, which refuses the answer in every profile.
 *
 * The attestation can only add a guarantee, so a problem inside it degrades
 * rather than refuses: the policy is returned without it, the problem is
 * named, and the answer then proves nothing (see {@link assessBackendEgress}).
 * An opt-out profile keeps working; nothing is ever granted on that shape.
 */
export function readBackendEgressPolicy(
  value: unknown,
  namespace: string,
): BackendEgressPolicyReading | null {
  if (!isRecord(value)) return null;
  // Edge v0.9.14 adds the attestation within schema 2; nothing else is optional.
  const attested = Object.hasOwn(value, DATA_PLANE_ATTESTATION_KEY);
  const row: Record<string, unknown> = { ...value };
  delete row[DATA_PLANE_ATTESTATION_KEY];
  if (!hasExactKeys(row, KEYS)) return null;
  if (
    row.schema_version !== SUPPORTED_EGRESS_POLICY_SCHEMA ||
    row.ip_classification !== 'ferrum-private-reserved-v1' ||
    row.namespace !== namespace ||
    row.policy_scope !== 'process' ||
    typeof row.enforcement_scope !== 'string' ||
    !['local-data-plane', 'unserved-namespace', 'admission-only', 'no-data-plane'].includes(
      row.enforcement_scope,
    ) ||
    typeof row.mode !== 'string' ||
    !['both', 'public', 'private'].includes(row.mode) ||
    ![
      'dangerous_ranges_blocked',
      'allow_cidr_overrides_present',
      'deny_cidr_overrides_present',
      'public_only_guaranteed',
    ].every((key) => typeof row[key] === 'boolean')
  ) {
    return null;
  }
  const allowed =
    row.mode === 'both'
      ? ['public', 'private-reserved']
      : row.mode === 'public'
        ? ['public']
        : ['private-reserved'];
  const blocked =
    row.mode === 'both' ? [] : row.mode === 'public' ? ['private-reserved'] : ['public'];
  if (
    !exactArray(row.mode_allowed_ip_classes, allowed) ||
    !exactArray(row.mode_blocked_ip_classes, blocked) ||
    !exactArray(row.evaluation_order, EVALUATION_ORDER) ||
    // Schema 2's guarantee rule: local enforcement, public mode, no allow overlay.
    row.public_only_guaranteed !==
      (row.enforcement_scope === 'local-data-plane' &&
        row.mode === 'public' &&
        !row.allow_cidr_overrides_present)
  ) {
    return null;
  }
  const policy = row as unknown as BackendEgressPolicy;
  if (!attested) return { policy, attestationProblem: null };
  // Edge sends the attestation from a control plane only.
  if (row.enforcement_scope !== 'admission-only') {
    return { policy, attestationProblem: 'out_of_scope' };
  }
  const attestation = readDataPlaneAttestation(value[DATA_PLANE_ATTESTATION_KEY]);
  if (typeof attestation === 'string') return { policy, attestationProblem: attestation };
  return { policy: { ...policy, data_plane_attestation: attestation }, attestationProblem: null };
}

/**
 * The exact owner shape: {@link readBackendEgressPolicy} with nothing set
 * aside, or `null`. Admission reads the degrading form instead.
 */
export function parseBackendEgressPolicy(
  value: unknown,
  namespace: string,
): BackendEgressPolicy | null {
  const reading = readBackendEgressPolicy(value, namespace);
  return reading !== null && reading.attestationProblem === null ? reading.policy : null;
}

/** One data plane's self-reported policy, with Edge's serving guarantee rule. */
function parseDataPlanePolicy(value: unknown): DataPlaneEgressPolicy | null {
  if (!isRecord(value) || !hasExactKeys(value, DATA_PLANE_POLICY_KEYS)) return null;
  if (!isEgressMode(value.mode)) return null;
  const classes = modeClasses(value.mode);
  if (
    !exactArray(value.mode_allowed_ip_classes, classes.allowed) ||
    !exactArray(value.mode_blocked_ip_classes, classes.blocked) ||
    typeof value.dangerous_ranges_blocked !== 'boolean' ||
    typeof value.allow_cidr_overrides_present !== 'boolean' ||
    typeof value.deny_cidr_overrides_present !== 'boolean' ||
    value.public_only_guaranteed !==
      (value.mode === 'public' && !value.allow_cidr_overrides_present)
  ) {
    return null;
  }
  return value as unknown as DataPlaneEgressPolicy;
}

/** `reported` exactly when a recognised policy came with the stream. */
function parseDataPlaneEntry(value: unknown): DataPlaneEgressEntry | null {
  if (!isRecord(value) || !hasExactKeys(value, DATA_PLANE_ENTRY_KEYS)) return null;
  if (
    typeof value.node_id !== 'string' ||
    value.node_id === '' ||
    typeof value.connected_at !== 'string' ||
    value.connected_at === ''
  ) {
    return null;
  }
  const reported = value.attestation === 'reported' && parseDataPlanePolicy(value.policy) !== null;
  const unreported = value.attestation === 'unknown' && value.policy === null;
  return reported || unreported ? (value as unknown as DataPlaneEgressEntry) : null;
}

/**
 * Edge's `weaken`: the least restrictive combination of two reports. The mode
 * admits both class sets, the dangerous baseline holds only if both block it,
 * an allow overlay on either counts, and a deny overlay only if both have one.
 */
function weakenPolicy(a: DataPlaneEgressPolicy, b: DataPlaneEgressPolicy): DataPlaneEgressPolicy {
  const publicAllowed = a.mode !== 'private' || b.mode !== 'private';
  const privateAllowed = a.mode !== 'public' || b.mode !== 'public';
  let mode: EgressMode = 'both';
  if (!privateAllowed) mode = 'public';
  else if (!publicAllowed) mode = 'private';
  const classes = modeClasses(mode);
  const allowOverrides = a.allow_cidr_overrides_present || b.allow_cidr_overrides_present;
  return {
    mode,
    mode_allowed_ip_classes: classes.allowed,
    mode_blocked_ip_classes: classes.blocked,
    dangerous_ranges_blocked: a.dangerous_ranges_blocked && b.dangerous_ranges_blocked,
    allow_cidr_overrides_present: allowOverrides,
    deny_cidr_overrides_present: a.deny_cidr_overrides_present && b.deny_cidr_overrides_present,
    public_only_guaranteed: mode === 'public' && !allowOverrides,
  };
}

/**
 * Closed and self-consistent: every summary field must be exactly what Edge's
 * own aggregation computes from the listed streams, so a summary that disagrees
 * with its entries (or entries that disagree with the count) is set aside.
 */
function readDataPlaneAttestation(
  value: unknown,
): DataPlaneEgressAttestation | DataPlaneAttestationProblem {
  if (!isRecord(value) || !hasExactKeys(value, ATTESTATION_KEYS)) return 'malformed';
  const connected = value.connected_data_planes;
  const planes = value.data_planes;
  if (
    value.source !== 'configsync-subscribe' ||
    typeof connected !== 'number' ||
    !Number.isSafeInteger(connected) ||
    connected < 0 ||
    !Array.isArray(planes)
  ) {
    return 'malformed';
  }
  let weakest: DataPlaneEgressPolicy | null = null;
  let reporting = 0;
  for (const plane of planes as unknown[]) {
    const entry = parseDataPlaneEntry(plane);
    if (entry === null) return 'malformed';
    if (entry.policy === null) continue;
    reporting += 1;
    weakest = weakest === null ? entry.policy : weakenPolicy(weakest, entry.policy);
  }
  if (value.weakest_policy !== null && parseDataPlanePolicy(value.weakest_policy) === null) {
    return 'malformed';
  }
  const complete = connected > 0 && reporting === connected;
  if (
    planes.length !== connected ||
    value.reporting_data_planes !== reporting ||
    value.unknown_data_planes !== connected - reporting ||
    !isDeepStrictEqual(value.weakest_policy, weakest) ||
    value.weakest_policy_complete !== complete ||
    value.all_connected_public_only_guaranteed !==
      (complete && weakest?.public_only_guaranteed === true)
  ) {
    return 'inconsistent';
  }
  return value as unknown as DataPlaneEgressAttestation;
}

/**
 * Process metadata cannot attest a remote data plane or an Admin fleet. Schema 2
 * already folds the scope into `public_only_guaranteed`; the scope is still
 * required explicitly, so a future owner change to the field cannot widen this.
 */
export function provesLocalPublicEgress(policy: BackendEgressPolicy): boolean {
  return policy.enforcement_scope === 'local-data-plane' && policy.public_only_guaranteed;
}

/**
 * What a control plane's data-plane attestation proves (Edge v0.9.14).
 *
 * - `guaranteed`: every condition below holds.
 * - `attestation_absent`: the control plane reports none (Edge v0.9.13).
 * - `attestation_unreadable`: it was set aside ({@link DataPlaneAttestationProblem}).
 * - `data_planes_not_public_only`: no data plane is connected, one did not
 *   report, or one is not `public` mode without allow overrides.
 * - `expected_data_planes_unset`: `NEXUS_EXPECTED_DATA_PLANES` is not set, so
 *   nothing says the connected set is the whole fleet.
 * - `fewer_data_planes_than_expected`: fewer distinct data planes are connected
 *   than it says.
 * - `not_control_plane`: the answer is not a control plane's.
 */
export type DataPlaneAttestationVerdict =
  | 'guaranteed'
  | 'attestation_absent'
  | 'attestation_unreadable'
  | 'data_planes_not_public_only'
  | 'expected_data_planes_unset'
  | 'fewer_data_planes_than_expected'
  | 'not_control_plane';

/** Only a positive integer is an inventory; anything else counts as unset. */
function isExpectedDataPlanes(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0;
}

/**
 * A control plane enforces nothing itself (its own `public_only_guaranteed` is
 * always false); it can only relay what its connected data planes reported.
 * The guarantee needs at least one connected data plane, every one of them
 * reporting, and every report public-only without allow overlays. The parser
 * already checked the summary against the streams; the rule is still recomputed
 * from the streams here, so the summary flag alone never grants it.
 *
 * A control plane sees only the data planes streaming from it, so the operator's
 * `expectedDataPlanes` (`NEXUS_EXPECTED_DATA_PLANES`) must also be set and the
 * number of distinct `node_id`s among the listed streams must reach it. Edge
 * lists one entry per Subscribe stream, so a reconnect overlap can list one
 * data plane twice; counting streams would let that duplicate stand in for a
 * missing data plane, while counting distinct ids can only undercount. Replicas
 * sharing one CP/DP credential share a `node_id` and count once. Unset, an
 * attestation never grants the guarantee. It covers the data planes connected
 * at the moment of this read only.
 */
export function dataPlaneAttestationVerdict(
  policy: BackendEgressPolicy,
  expectedDataPlanes?: number,
): DataPlaneAttestationVerdict {
  if (policy.enforcement_scope !== 'admission-only') return 'not_control_plane';
  const attestation = policy.data_plane_attestation;
  if (attestation === undefined) return 'attestation_absent';
  const allPublicOnly =
    attestation.all_connected_public_only_guaranteed &&
    attestation.weakest_policy_complete &&
    attestation.connected_data_planes > 0 &&
    attestation.unknown_data_planes === 0 &&
    attestation.data_planes.length === attestation.connected_data_planes &&
    attestation.data_planes.every(
      (entry) =>
        entry.attestation === 'reported' &&
        entry.policy !== null &&
        entry.policy.mode === 'public' &&
        !entry.policy.allow_cidr_overrides_present,
    );
  if (!allPublicOnly) return 'data_planes_not_public_only';
  if (!isExpectedDataPlanes(expectedDataPlanes)) return 'expected_data_planes_unset';
  const distinctDataPlanes = new Set(attestation.data_planes.map((entry) => entry.node_id)).size;
  if (distinctDataPlanes < expectedDataPlanes) return 'fewer_data_planes_than_expected';
  return 'guaranteed';
}

/** {@link dataPlaneAttestationVerdict} is `guaranteed`. */
export function provesDataPlanePublicEgress(
  policy: BackendEgressPolicy,
  expectedDataPlanes?: number,
): boolean {
  return dataPlaneAttestationVerdict(policy, expectedDataPlanes) === 'guaranteed';
}

/**
 * The public-only guarantee: proved by the serving process itself, or by a
 * control plane whose every expected data plane is connected and attests it.
 */
export function provesPublicEgress(
  policy: BackendEgressPolicy,
  expectedDataPlanes?: number,
): boolean {
  return provesLocalPublicEgress(policy) || provesDataPlanePublicEgress(policy, expectedDataPlanes);
}

/**
 * Why a control plane's attestation did not grant the guarantee, for the
 * operator: the health error and the write refusal. `null` when it did, or
 * when the answer is not a control plane's.
 */
export function describeDataPlaneAttestation(verdict: DataPlaneAttestationVerdict): string | null {
  switch (verdict) {
    case 'attestation_absent':
      return 'the control plane reports no data-plane egress attestation (Edge v0.9.14 adds it)';
    case 'attestation_unreadable':
      return 'the data-plane egress attestation is unreadable and was set aside';
    case 'data_planes_not_public_only':
      return 'not every connected data plane attests public-only egress, or none is connected';
    case 'expected_data_planes_unset':
      return 'NEXUS_EXPECTED_DATA_PLANES is not set, so the data-plane attestation cannot grant it';
    case 'fewer_data_planes_than_expected':
      return 'fewer distinct data planes (node_id) are connected to the control plane than NEXUS_EXPECTED_DATA_PLANES';
    default:
      return null;
  }
}

/**
 * Which profile admitted a backend write. Bounded vocabulary, recorded in the
 * publish, update and restore audit rows; never CIDRs or other policy detail.
 *
 * - `public-guaranteed`: the gateway proved public-only egress, on its own data
 *   plane ({@link provesLocalPublicEgress}, `enforcement_scope` `local-data-plane`)
 *   or through every expected data plane of a control plane
 *   ({@link provesDataPlanePublicEgress}, `enforcement_scope` `admission-only`).
 * - `private-upstreams-opt-in`: `NEXUS_ALLOW_PRIVATE_UPSTREAMS=true`. The portal
 *   publishes private upstreams on purpose, so the gateway cannot also be
 *   public-only and its attestation is not required.
 * - `unattested-edge-opt-in`: `NEXUS_ALLOW_UNATTESTED_EDGE_EGRESS=true`. Only
 *   the gateway attestation is waived; Nexus still screens every upstream. It
 *   still requires `public_only_guaranteed=true`, which schema 2 reports only
 *   for `local-data-plane`, so it admits no pairing the public profile would
 *   refuse (a control plane reports `false`).
 */
export type EgressProfile =
  'public-guaranteed' | 'private-upstreams-opt-in' | 'unattested-edge-opt-in';

/** The admission verdict for one backend write. */
export interface BackendEgressAdmission {
  egress_profile: EgressProfile;
  enforcement_scope: BackendEgressPolicy['enforcement_scope'];
}

/** The two operator opt-outs; each relaxes a different check. */
export interface EgressOptOuts {
  allowPrivateUpstreams?: boolean;
  allowUnattestedEdgeEgress?: boolean;
}

/** The opt-outs, and the operator's data-plane inventory for a control plane. */
export interface EgressAdmissionOptions extends EgressOptOuts {
  /** `NEXUS_EXPECTED_DATA_PLANES`; unset, an attestation never grants the guarantee. */
  expectedDataPlanes?: number;
}

/** Everything one policy reading establishes. */
export interface BackendEgressAssessment {
  /** Whether the reading proves public-only egress; independent of the opt-outs. */
  publicEgressGuaranteed: boolean;
  /** The admission verdict, or `null` to refuse the write. */
  admission: BackendEgressAdmission | null;
  /** What the data-plane attestation proved; `attestation_unreadable` on any problem. */
  dataPlaneAttestation: DataPlaneAttestationVerdict;
}

/**
 * Assess one reading. A set-aside attestation proves nothing, whatever the rest
 * of the answer says, but it never refuses what an opt-out admits.
 */
export function assessBackendEgress(
  reading: BackendEgressPolicyReading,
  options: EgressAdmissionOptions,
): BackendEgressAssessment {
  const { policy } = reading;
  const usable = reading.attestationProblem === null;
  const publicEgressGuaranteed = usable && provesPublicEgress(policy, options.expectedDataPlanes);
  const dataPlaneAttestation = usable
    ? dataPlaneAttestationVerdict(policy, options.expectedDataPlanes)
    : 'attestation_unreadable';
  const enforcement_scope = policy.enforcement_scope;
  let admission: BackendEgressAdmission | null = null;
  if (publicEgressGuaranteed) {
    admission = { egress_profile: 'public-guaranteed', enforcement_scope };
  } else if (options.allowPrivateUpstreams === true) {
    admission = { egress_profile: 'private-upstreams-opt-in', enforcement_scope };
  } else if (options.allowUnattestedEdgeEgress === true && policy.public_only_guaranteed === true) {
    // Never relaxed to `mode === 'public'`: under schema 2 that would grant a
    // control plane the policy-only reading the owner withdrew.
    admission = { egress_profile: 'unattested-edge-opt-in', enforcement_scope };
  }
  return { publicEgressGuaranteed, admission, dataPlaneAttestation };
}

/**
 * Admit a recognized policy, or return `null` to refuse it. A policy that
 * proves public-only egress is always reported as such, whatever the opt-outs.
 */
export function admitBackendEgress(
  policy: BackendEgressPolicy,
  options: EgressAdmissionOptions,
): BackendEgressAdmission | null {
  return assessBackendEgress({ policy, attestationProblem: null }, options).admission;
}
