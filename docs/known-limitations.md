# Known limitations

These are standing limits of Nexus as built, not bugs awaiting a fix in the next release.
Each one links to the section that explains it in detail. The release notes repeat the
ones that matter for that release; this page is the list that stays current between
releases. A limitation that is lifted is removed here in the same change.

## Deployment

- **One active writer.** Run exactly one Nexus instance that performs gateway mutations:
  a single instance, or active/passive with only one instance serving at a time. Sticky
  routing does not make several active instances safe, because an expired lease cannot
  fence a stale writer at Ferrum Edge. SQLite means one instance. See
  [supported topologies](operations.md#supported-topologies).
- **Rate limits are per process.** Each Nexus process keeps its own `429` counters, so N
  processes allow N times each limit. The same holds for the admin-JWT, health-probe and
  metrics caches and for a generated bootstrap token. See
  [other multi-instance notes](operations.md#other-multi-instance-notes) and
  [rate limiting](security.md#rate-limiting).

## Gateway writes

- **Undo steps live in memory.** Edge has no multi-resource transaction, so a publish, an
  API `PATCH` or a spec revision registers an undo step before each gateway write and
  replays them if a later step fails. Those steps are held by the process doing the
  operation. If that process stops partway (a crash, a killed pod, a deploy), nothing
  replays them, and the gateway can be left partly changed until an operator compares it
  with the catalog. A failed undo writes an audit row, but a stopped process writes none.
  Enforcement conversions and gateway restores are the exception: they keep durable,
  encrypted recovery journals. See
  [when a gateway change cannot be taken back](operations.md#when-a-gateway-change-cannot-be-taken-back)
  and [gateway recovery journals](operations.md#gateway-recovery-journals).
- **Agent APIs bridge five methods.** An agent (MCP) tool can call a REST operation whose
  method is `GET`, `POST`, `PUT`, `PATCH` or `DELETE`. Ferrum Edge does not bridge
  `HEAD`, `OPTIONS`, `TRACE` or `CONNECT`, so operations with those methods cannot be
  selected as tools. See
  [the agent marketplace](agent-marketplace.md#exact-configuration-boundary).

## Single sign-on

- **No SCIM and no back-channel logout.** Nexus receives no provisioning or logout events
  from the identity provider. Roles, organizations and deprovisioning are applied at the
  account's next sign-in. An account whose provider access was revoked keeps its session
  until it expires, and keeps its gateway credentials until an administrator disables it
  or it signs in again. See
  [single sign-on in the security model](security.md#single-sign-on-openid-connect).
- **End-to-end coverage uses Dex only.** The acceptance suite signs in through a real,
  digest-pinned Dex provider (authorization code with PKCE, `state`, `nonce`, group
  mapping). Other providers (Keycloak, Entra ID, Okta, Auth0, Google Workspace) are
  expected to work because Nexus uses only standard OpenID Connect, but no automated test
  runs against them. Test a sign-in with your provider before relying on it. See
  [the acceptance suite](../e2e/README.md).

## Service manifests

- **The preview validates and never applies.** `POST /api/service-manifests/preview`
  checks a Ferrum service manifest against the pinned shared v1 contract and Edge's
  limits, and returns a redacted summary. It stores nothing, contacts no gateway, and
  has no apply, publish or diagnostics counterpart. **Stability: preview.** Its request
  and response may change in a minor release, with the change stated in the release
  notes, and it is excluded from the compatibility promise for the `/api` surface that
  starts at 1.0.0 (see the [README](../README.md#development-status)). See
  [the service-manifest preview](service-manifest-preview.md).
