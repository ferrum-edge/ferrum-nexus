# First Nexus/Edge release pair — draft notes

**Status: release preparation. No supported Nexus release has been published.**
The release step must replace `NEXUS_RELEASE_TAG=UNPUBLISHED` in
[`release/compatibility.env`](../release/compatibility.env) with the tag created
from a CI-validated commit, then publish these notes with that tag. The
`acceptance` job must pass for that exact commit before this candidate becomes
a supported pair.

## Support matrix

- **Nexus:** `NEXUS_RELEASE_TAG` in the compatibility record; currently
  `UNPUBLISHED`. Build the Dockerfile from the tagged source checkout. There is
  no released Nexus image yet.
- **Ferrum Edge:** `v0.9.5`, using the exact multi-architecture digest in the
  compatibility record. The Docker Hub tag and digest were verified against
  its tag API on 2026-09-23. The real-stack `acceptance` job uses this image.
- **Nexus database:** PostgreSQL 17 in the full-stack Compose example. Retain
  both `pgdata` and the Edge `ferrumdata` volume. The test suite also exercises
  other store adapters; retained-data upgrades are not yet guaranteed.

The [README full-stack path](../README.md#docker) builds Nexus from the current
checkout and sources the compatibility record. For a release deployment, check
out the published Nexus tag first (`git checkout --detach <published-Nexus-tag>`)
and run the same commands. The image build uses a digest-pinned Node 22 base
in both stages and `npm ci` against the committed lockfile. Record the
resulting local image ID with the deployment.
The tagged source checkout, Node base digest and lockfile are the reproducible
build inputs; image byte-for-byte equality across Docker platforms is not
promised.

## Operations and limitations

- **Persistence and secrets:** Retain the PostgreSQL `pgdata` and Edge
  `ferrumdata` volumes together. Keep `NEXUS_SECRET_KEY`,
  `FERRUM_ADMIN_JWT_SECRET`, `FERRUM_BASIC_AUTH_HMAC_SECRET`, and the database
  password stable across restarts and restores. Store them outside the source
  tree. The Nexus database alone cannot recover Edge consumers, credentials,
  proxies or plugins. See [backups](operations.md#5-backups).
- **TLS:** The sample binds the portal and gateway listener to loopback for
  local HTTP. For a network deployment, terminate TLS at a trusted reverse
  proxy, set `NEXUS_PUBLIC_URL` to the HTTPS origin and
  `NEXUS_COOKIE_SECURE=true`, configure trusted proxies, and keep the Edge
  Admin API private. See
  [TLS operations](operations.md#4-running-behind-tls-and-a-reverse-proxy).
- **Topology:** Run one active Nexus writer. An active/passive standby must
  serve no requests or mutating background work until promotion. Active-active
  Nexus is unsupported; see [supported topologies](operations.md#supported-topologies).
- **Upgrades and restores:** The buildout `001_initial` schema is still edited
  in place. There is no supported retained-data upgrade path or verified
  paired restore yet. [Issue #286](https://github.com/ferrum-edge/ferrum-nexus/issues/286)
  must freeze the first released schema and provide the tested upgrade/restore
  runbook before a production release is announced. Until then, database reset
  guidance applies only to disposable development data. Back up both services
  together and retain the original secrets; restore Edge state before checking
  grants and credentials through the gateway.
- **Other limits:** Edge serves one data-plane namespace per process; keep
  `FERRUM_NAMESPACE` equal on both sides. SMTP must be configured for real
  email delivery. This initial path ships source and build instructions rather
  than a prebuilt Nexus image or automated image publishing.

## Why the first release uses a tagged source build

The repository has no Nexus release/image workflow or published Nexus image.
Its current CI builds an image only for tests. The initial release path is a
source tag tied to a validated commit, with the Dockerfile and lockfile in that
tag; operators build that checkout and use the Edge digest from its
compatibility record. This avoids introducing registry credentials and an
unverified publication workflow before the schema/restore boundary in #286.
No workflow in this repository publishes a release from an untagged branch.

## Release step

1. Complete #286's immutable schema baseline and upgrade/restore exercise.
2. Choose the Nexus version tag and replace `UNPUBLISHED` in
   `release/compatibility.env`; update this draft's status and matrix. Merge
   that release commit and require all checks, including `acceptance`, on its
   exact SHA.
3. Create the tag at that SHA, publish these notes with the tag, and verify
   the tagged source build and full-stack authenticated request. This
   preparation PR performs none of those publication actions.
