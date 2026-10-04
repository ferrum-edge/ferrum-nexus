/** Owner contract: Edge c764084b3b51c3f7ffde268c039688d35e49c553, schema v1. */
export interface BackendEgressPolicy {
  schema_version: 1;
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
    row.schema_version !== 1 ||
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
    row.public_only_guaranteed !== (row.mode === 'public' && !row.allow_cidr_overrides_present)
  ) {
    return null;
  }
  return row as unknown as BackendEgressPolicy;
}

/** Process metadata cannot attest a remote data plane or an Admin fleet. */
export function provesLocalPublicEgress(policy: BackendEgressPolicy): boolean {
  return policy.enforcement_scope === 'local-data-plane' && policy.public_only_guaranteed;
}
