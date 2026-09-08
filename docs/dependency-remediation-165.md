# Static, SMTP and SQLite dependency remediation (#165)

Metadata and public advisories checked on 2026-09-07. The baseline is
`3d12382f3d8aaa837ae9f1b7e3bfb774b0c6a42f`, after #164's Fastify/Undici update.

## Version selection and compatibility

- `@fastify/static`: 8.3.0 → 10.1.3. Tagged README and plugin metadata explicitly support Fastify 5.
- `nodemailer`: 6.10.1 → 9.1.1. Latest 9.x release; existing CommonJS SMTP API, Node `>=6.0.0`, no runtime dependencies.
- `@types/nodemailer`: 6.4.24 → 8.0.1. Latest external declarations; covers the SMTP options and send/close APIs used with 9.x.
- `glob`: 11.1.0 → 13.0.6. Required by static 10; Node `18 || 20 || >=22`.
- `content-disposition`: 0.5.4 → 2.0.1. Required by static 10; Node `>=18`.
- `better-sqlite3`: 11.10.0 → 13.0.3. Node-API binding replaces the native cleanup path
  implicated by the Node 24 hosted failure; see the compatibility evidence below.
- `node-addon-api`: 8.9.2, newly required by SQLite 13; Node `^18 || ^20 || >=21`.

Static's [tagged compatibility table](https://github.com/fastify/fastify-static/blob/v10.1.3/README.md#compatibility)
and [plugin declaration](https://github.com/fastify/fastify-static/blob/v10.1.3/index.js)
both retain Fastify 5 support. The [8.3.0–10.1.3 comparison](https://github.com/fastify/fastify-static/compare/v8.3.0...v10.1.3)
includes the glob/content-disposition updates and a `setHeaders` callback change from
Node's response to FastifyReply. Nexus does not configure that callback. Its
`wildcard: false`, `index: false`, and fixed `sendFile('index.html', { cacheControl: false })`
integration remains supported. Static now shares the existing fastify-plugin 6.0.0;
the old nested 5.1.0 and glob's removed CLI-only dependency tree are pruned.
The other required static dependencies already satisfy the new ranges.

Nodemailer's [6.10.1–9.1.1 comparison](https://github.com/nodemailer/nodemailer/compare/v6.10.1...v9.1.1)
crosses these published breaking changes:

- [7.0.0](https://github.com/nodemailer/nodemailer/releases/tag/v7.0.0): SES SDK replacement; Nexus uses SMTP.
- [8.0.0](https://github.com/nodemailer/nodemailer/releases/tag/v8.0.0): `NoAuth` becomes `ENOAUTH`; Nexus reports `Error.message` and does not branch on that code.
- [9.0.0](https://github.com/nodemailer/nodemailer/releases/tag/v9.0.0): remote-content HTTPS certificate validation and URL parsing changes; Nexus supplies explicit SMTP settings and literal message fields.

[9.1.1](https://github.com/nodemailer/nodemailer/releases/tag/v9.1.1) also includes the subsequent
SMTP response/socket, recipient parsing, and message access-policy fixes. The registry's latest
release was [10.0.1](https://github.com/nodemailer/nodemailer/releases/tag/v10.0.1).
Its [10.0.0 migration](https://github.com/nodemailer/nodemailer/releases/tag/v10.0.0) introduces
TypeScript, dual ESM/CommonJS builds and bundled declarations. This bounded remediation stays
on the patched 9.x API with external types; it does not require that migration.

The project now requires Node `>=22.14`, with `.nvmrc` and the hosted minimum job at 22.14.
This is an explicit increase from 22.12 for SQLite's Node-API 10 binding, not a requirement
of the static or SMTP updates. The current Node 22 and 24 jobs remain. Existing locked glob
dependencies (minimatch 10.2.6, minipass 7.1.3, path-scurry 2.0.2) satisfy glob 13.0.6.
Hosted checks include `npm ci`, typecheck, tests, formatting and build.

## SQLite native compatibility discovered by Node 24 CI

At head `606b02803242c5024df6ef3f229a09cf05bc1734`, hosted
[run 34172620499, job 101895714990](https://github.com/ferrum-edge/ferrum-nexus/actions/runs/34172620499/job/101895714990)
installed successfully and passed typechecking on Node 24.20.0, then 18 backend test-file
processes aborted with `RemoveEnvironmentCleanupHook`, assertion `(env) != nullptr`, and
`Statement::~Statement()` in `better_sqlite3.node`. The five real SMTP tests passed, as did
the web suite. The first native assertion is at line 380 of the archived full hosted log
`work/logs/nexus-166-606-node24-failure.log` in the parent project workspace. This is a native
compatibility failure exposed by the added runtime job; it is not evidence of an SMTP failure.

The SQLite wrapper was reviewed before selecting the repair. `queryOne`, `queryAll` and
`execute` create short-lived statements; migrations also prepare statements. `SqliteStore.close()`
already calls `db.close()` once, and owned test stores are closed by the test helper. The
native SQL handle and JavaScript wrapper have distinct lifetimes: even after closing the
database, statement wrappers can be finalized by GC. Caching all statements or adding more
test cleanup would not replace the failing native base destructor.

Primary source evidence:

- Node 24.20.0's [ObjectWrap destructor](https://github.com/nodejs/node/blob/v24.20.0/src/node_object_wrap.h)
  calls `RemoveCleanupHook`. Even the final 12.x tag's
  [Statement implementation](https://github.com/WiseLibs/better-sqlite3/blob/v12.12.0/src/objects/statement.cpp)
  still inherits `node::ObjectWrap`; the 11.x/12.x release changes provide no replacement
  for this path. A 12.x bump therefore lacks a source-supported fix for this failure.
- [13.0.0](https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.0) replaces the binding
  with Node-API; [13.0.3's Statement](https://github.com/WiseLibs/better-sqlite3/blob/v13.0.3/src/objects/statement.cpp)
  inherits `Napi::ObjectWrap`. [13.0.1](https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.1)
  fixes cross-realm plain-object parameter binding, and
  [13.0.2](https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.2) fixes the separate
  [worker termination abort](https://github.com/WiseLibs/better-sqlite3/issues/1507).
  13.0.3 adds the Linux ARM prebuild runner correction and includes SQLite 3.53.4.
- Its registry engine says `>=22`, but the actual
  [build defines `NAPI_VERSION=10`](https://github.com/WiseLibs/better-sqlite3/blob/v13.0.3/binding.gyp).
  Node's [version matrix](https://nodejs.org/api/n-api.html#node-api-version-matrix) and
  [22.14.0 headers](https://github.com/nodejs/node/blob/v22.14.0/src/node_version.h)
  establish 22.14.0 as the first Node 22 release supporting Node-API 10. 22.12 cannot load
  that binding. No inspected published repair preserves 22.12; the minimum increases to
  22.14 rather than guessing 22.19 or maintaining a private native fork.

The selected package preserves Nexus's synchronous `prepare/get/all/run`, transaction,
pragma, close and SQLite error-code interfaces. Adapter code, migrations, SQL schemas,
serialization, transaction ownership and all four store contracts are unchanged. Existing
external SQLite types cover the API subset Nexus uses; no new 13.x methods are used.
Replacing this native path is the repair hypothesis supported by source inspection;
the new hosted results must establish that it resolves Nexus's observed abort.

SQLite 13 bundles native binaries in the npm tarball and declares `gypfile: false` with no
install script. Its only runtime dependency is node-addon-api. The obsolete `bindings` and
`prebuild-install` trees are pruned from the lock, and the old SQLite script allowance is
removed. The Docker build uses the bundled Linux x64/arm64 binaries, rebuilds only esbuild,
and needs no SQLite compiler packages. Both image stages retain current `node:22-bookworm-slim`;
the hosted production-image check loads SQLite, queries it and closes it. Other platforms
without a bundled binary need a separately provisioned source build; this change does not
claim automatic source-build fallback with upstream's `gypfile: false` packaging.

New child-process regressions exercise production SQLite query helpers under forced GC,
rollback, retained statements, explicit close and natural exit with an open database.
They require successful process exit as well as completed assertions, so a destructor abort
after the assertions still fails CI. The unchanged Node 24 suite remains the original
reproducer, and the hosted four-adapter contracts and Docker checks remain required.

## Published advisory coverage and Nexus reachability

Static 10.1.3 is above all published affected ranges returned in the baseline audit:

- [Directory traversal](https://github.com/advisories/GHSA-pr96-94w5-mx2h) and
  [encoded separators](https://github.com/advisories/GHSA-x428-ghpx-8j92): through 9.1.0.
- [Dot-segment traversal](https://github.com/advisories/GHSA-83w8-p2f5-377r): through 10.1.0.
- [Noncanonical paths](https://github.com/advisories/GHSA-8pvw-jcv7-9cmj): through 10.1.1.

Nexus serves the public built SPA using explicit discovered-file routes. It does not use
directory listings or a wildcard static route with per-file private authorization guards.
These upstream findings do not establish a private-file authorization bypass in Nexus.

Nodemailer 9.1.1 is above all published affected ranges returned in the baseline audit:

- [Address interpretation](https://github.com/advisories/GHSA-mm7p-fcc7-pg87): before 7.0.7.
- [Recursive address parsing](https://github.com/advisories/GHSA-rcmh-qjqh-p98v): through 7.0.10.
- [Envelope size injection](https://github.com/advisories/GHSA-c7w3-x93f-qmm8): before 8.0.4.
- [EHLO name injection](https://github.com/advisories/GHSA-vvjj-xcjg-gr5g): through 8.0.4.
- [OAuth2 TLS validation](https://github.com/advisories/GHSA-r7g4-qg5f-qqm2): through 8.0.7.
- [List header injection](https://github.com/advisories/GHSA-268h-hp4c-crq3) and
  [JSON transport access policy](https://github.com/advisories/GHSA-wqvq-jvpq-h66f): through 8.0.8.
- [Raw message access policy](https://github.com/advisories/GHSA-p6gq-j5cr-w38f): through 9.0.0.

The mail wrapper explicitly passes only `from`, `to`, `subject`, `html`, and `text`.
It accepts neither user-supplied `raw` nor JSON transport, attachment, List-header, envelope-size,
EHLO-name or OAuth2 options. The raw/JSON findings therefore do not establish an exposed
Nexus file-read/SSRF path. Recipient parsing is used, but public registration, recovery and
admin probe inputs enforce a single email address of at most 320 characters. Admin-controlled
sender settings permit an RFC 5322 display name (320-character HTTP limit); environment
settings and internal queued recipients are separate boundaries.

## Validation evidence and limits

[Registry evidence](dependency-remediation-165.json) records exact metadata URLs, tarball
URLs, integrity values, engine constraints, dependencies and the bulk advisory response.
All seven changed package tarballs were fetched as data and their SHA-512 digests matched
the registry integrity values; no downloaded package code was executed.
The public registry audit selected only lock entries whose resolved URL begins with
`https://registry.npmjs.org/`, excluded workspace/private/link entries, and submitted
429 distinct public package names with their final locked versions. It returned `{}`. This is
an as-of-date published-advisory check, not proof that every dependency is vulnerability-free.

The lockfile was edited from registry JSON without a local install or lockfile regeneration.
Local validation is limited to static review, JSON/metadata checks and `git diff --check`.
Hosted `npm ci` is the authoritative lock consistency/integrity and installation gate;
hosted test/typecheck/build results must be reviewed before merge.

The earlier 606b028 head passed hosted Node 22.12/current 22, four-store contracts and Docker
checks; its Node 24 failure above prompted the SQLite repair. Those earlier green results
do not validate the new native package, lockfile, minimum runtime or lifecycle regressions.

The listening-socket HTTP suite retains its API identity, CSRF, mutation and malformed-path
coverage and adds public asset GET/HEAD, MIME type, conditional requests, byte ranges,
noncanonical/missing asset rejection, SPA navigation and cache-header checks. It uses the
production static registration, not a separate guarded-directory demonstration.

The SMTP suite uses the production Nodemailer wrapper against a loopback SMTP peer. It checks
configured host/port/auth/from, envelope and MIME fields, quoted recipient domain preservation,
bounded nested-group parsing with subsequent successful delivery, multiline rejection parsing,
admin error reporting, and rejection of invalid public recipient inputs before SMTP.
It does not prove delivery to an external provider or TLS deployment configuration.

The SMTP timeout baseline remains 10 seconds connection, 10 seconds greeting and 30 seconds
socket inactivity. These phase/inactivity limits are not a whole-attempt deadline.
[Issue #158](https://github.com/ferrum-edge/ferrum-nexus/issues/158) remains separate and open;
this dependency update does not repair or claim to repair that deadline defect.
