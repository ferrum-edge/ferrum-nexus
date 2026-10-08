/**
 * A builder for Edge v0.9.14 control-plane `GET /backend-egress-policy` answers,
 * which add the optional `data_plane_attestation` object within schema 2. It
 * follows `DataPlaneEgressSummary::from_reports` in
 * `src/grpc/backend_egress_attestation.rs` and generates fleets of any size and
 * mix for parametrized tests. The owner examples and the conformance cases are
 * the vendored canonical fixtures (`contracts/ferrum-contracts/fixtures/
 * backend-egress-policy/v2/`, contracts-edge-0.9.14), which the tests read
 * directly; this builder's output must agree with them (`egress-policy.test.ts`).
 */
import { publicEgressPolicy } from './mock-ferrum-edge.js';

type Mode = 'both' | 'public' | 'private';

/** What one connected data plane reported; `null` is an unknown data plane. */
export interface DataPlaneReport {
  mode: Mode;
  dangerous_ranges_blocked?: boolean;
  allow_cidr_overrides_present?: boolean;
  deny_cidr_overrides_present?: boolean;
}

/** The CP's own top-level fields for a default (`both`) control plane. */
function controlPlaneFields(namespace: string): Record<string, unknown> {
  return {
    ...publicEgressPolicy(namespace),
    enforcement_scope: 'admission-only',
    mode: 'both',
    mode_allowed_ip_classes: ['public', 'private-reserved'],
    mode_blocked_ip_classes: [],
    public_only_guaranteed: false,
  };
}

function classes(mode: Mode): { allowed: string[]; blocked: string[] } {
  if (mode === 'both') return { allowed: ['public', 'private-reserved'], blocked: [] };
  if (mode === 'public') return { allowed: ['public'], blocked: ['private-reserved'] };
  return { allowed: ['private-reserved'], blocked: ['public'] };
}

/** Edge's `DataPlaneEgressPolicy` view of one report. */
export function dataPlanePolicy(report: DataPlaneReport): Record<string, unknown> {
  const allow = report.allow_cidr_overrides_present ?? false;
  return {
    mode: report.mode,
    mode_allowed_ip_classes: classes(report.mode).allowed,
    mode_blocked_ip_classes: classes(report.mode).blocked,
    dangerous_ranges_blocked: report.dangerous_ranges_blocked ?? true,
    allow_cidr_overrides_present: allow,
    deny_cidr_overrides_present: report.deny_cidr_overrides_present ?? false,
    public_only_guaranteed: report.mode === 'public' && !allow,
  };
}

function weaken(a: DataPlaneReport, b: DataPlaneReport): DataPlaneReport {
  const publicAllowed = a.mode !== 'private' || b.mode !== 'private';
  const privateAllowed = a.mode !== 'public' || b.mode !== 'public';
  return {
    mode: !privateAllowed ? 'public' : !publicAllowed ? 'private' : 'both',
    dangerous_ranges_blocked:
      (a.dangerous_ranges_blocked ?? true) && (b.dangerous_ranges_blocked ?? true),
    allow_cidr_overrides_present:
      (a.allow_cidr_overrides_present ?? false) || (b.allow_cidr_overrides_present ?? false),
    deny_cidr_overrides_present:
      (a.deny_cidr_overrides_present ?? false) && (b.deny_cidr_overrides_present ?? false),
  };
}

/**
 * A control plane's answer with one live stream per report, computed the way
 * Edge computes it. Tests patch the result to build inconsistent answers.
 */
export function attestedControlPlanePolicy(
  reports: (DataPlaneReport | null)[],
  namespace = 'nexus',
): Record<string, unknown> {
  let weakest: DataPlaneReport | null = null;
  for (const report of reports) {
    if (report !== null) weakest = weakest === null ? report : weaken(weakest, report);
  }
  const reporting = reports.filter((report) => report !== null).length;
  const complete = reports.length > 0 && reporting === reports.length;
  return {
    ...controlPlaneFields(namespace),
    data_plane_attestation: {
      source: 'configsync-subscribe',
      connected_data_planes: reports.length,
      reporting_data_planes: reporting,
      unknown_data_planes: reports.length - reporting,
      weakest_policy: weakest === null ? null : dataPlanePolicy(weakest),
      weakest_policy_complete: complete,
      all_connected_public_only_guaranteed:
        complete && weakest !== null && dataPlanePolicy(weakest).public_only_guaranteed === true,
      data_planes: reports.map((report, index) => ({
        node_id: `dp-${index}`,
        connected_at: '2026-10-06T12:00:00+00:00',
        attestation: report === null ? 'unknown' : 'reported',
        policy: report === null ? null : dataPlanePolicy(report),
      })),
    },
  };
}
