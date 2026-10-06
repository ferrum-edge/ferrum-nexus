/**
 * Owner contract: Edge v0.9.13 (9b83115de7ec23ab51ec4feae6bed65e596db425), schema v2
 * (`backend-egress-policy` v2 in contracts-edge-0.9.13). Schema 2 keeps v1's shape but
 * narrows `public_only_guaranteed`: it is true only for `local-data-plane`.
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

function exactArray(value: unknown, expected: string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  );
}

/**
 * The only policy schema this portal reads. Edge v0.9.13 publishes schema 2 and
 * never 1. Schema 1 (Edge v0.9.11 and v0.9.12) reported the policy-only value of
 * `public_only_guaranteed`, so the same field meant something else: it is refused
 * rather than reinterpreted, and this portal pairs with Edge v0.9.13 only.
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

/** Closed parsing: never infer policy from mode alone or tolerate future vocabulary. */
export function parseBackendEgressPolicy(
  value: unknown,
  namespace: string,
): BackendEgressPolicy | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== KEYS.length || !KEYS.every((key) => Object.hasOwn(row, key))) {
    return null;
  }
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
  return row as unknown as BackendEgressPolicy;
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
 * Which profile admitted a backend write. Bounded vocabulary, recorded in the
 * publish, update and restore audit rows; never CIDRs or other policy detail.
 *
 * - `public-guaranteed`: the gateway proved public-only egress on its own data
 *   plane ({@link provesLocalPublicEgress}).
 * - `private-upstreams-opt-in`: `NEXUS_ALLOW_PRIVATE_UPSTREAMS=true`. The portal
 *   publishes private upstreams on purpose, so the gateway cannot also be
 *   public-only and its attestation is not required.
 * - `unattested-edge-opt-in`: `NEXUS_ALLOW_UNATTESTED_EDGE_EGRESS=true`. Only
 *   the gateway attestation is waived; Nexus still screens every upstream. It
 *   still requires `public_only_guaranteed=true`, which schema 2 reports only
 *   for `local-data-plane`, so against Edge v0.9.13 it admits no pairing the
 *   public profile would refuse (a control plane reports `false`).
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

/**
 * Admit a recognized policy, or return `null` to refuse it. A policy that
 * proves public-only egress is always reported as such, whatever the opt-outs.
 */
export function admitBackendEgress(
  policy: BackendEgressPolicy,
  optOuts: EgressOptOuts,
): BackendEgressAdmission | null {
  const enforcement_scope = policy.enforcement_scope;
  if (provesLocalPublicEgress(policy)) {
    return { egress_profile: 'public-guaranteed', enforcement_scope };
  }
  if (optOuts.allowPrivateUpstreams === true) {
    return { egress_profile: 'private-upstreams-opt-in', enforcement_scope };
  }
  // Never relaxed to `mode === 'public'`: under schema 2 that would grant a
  // control plane the policy-only reading the owner withdrew.
  if (optOuts.allowUnattestedEdgeEgress === true && policy.public_only_guaranteed === true) {
    return { egress_profile: 'unattested-edge-opt-in', enforcement_scope };
  }
  return null;
}
