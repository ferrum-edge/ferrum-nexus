# Static and SMTP dependency remediation (#165)

Metadata and public advisories checked on 2026-09-07. The baseline is
`3d12382f3d8aaa837ae9f1b7e3bfb774b0c6a42f`, after #164's Fastify/Undici update.

## Version selection and compatibility

- `@fastify/static`: 8.3.0 → 10.1.3. Tagged README and plugin metadata explicitly support Fastify 5.
- `nodemailer`: 6.10.1 → 9.1.1. Latest 9.x release; existing CommonJS SMTP API, Node `>=6.0.0`, no runtime dependencies.
- `@types/nodemailer`: 6.4.24 → 8.0.1. Latest external declarations; covers the SMTP options and send/close APIs used with 9.x.
- `glob`: 11.1.0 → 13.0.6. Required by static 10; Node `18 || 20 || >=22`.
- `content-disposition`: 0.5.4 → 2.0.1. Required by static 10; Node `>=18`.

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

The project retains Node `>=22.12`, `.nvmrc` 22.12 and Node 22 container images. The changed
packages' engine constraints admit both Node 22 and 24; static and its plugin helper declare
no narrower Node engine. Existing locked glob dependencies (minimatch 10.2.6, minipass 7.1.3,
path-scurry 2.0.2) satisfy glob 13.0.6. Hosted checks cover the minimum 22.12.0 and current
22/24 releases, including `npm ci`, typecheck, tests, formatting and build.

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
All five changed package tarballs were fetched as data and their SHA-512 digests matched
the registry integrity values; no downloaded package code was executed.
The public registry audit selected only lock entries whose resolved URL begins with
`https://registry.npmjs.org/`, excluded workspace/private/link entries, and submitted
462 distinct public package names with their locked versions. It returned `{}`. This is
an as-of-date published-advisory check, not proof that every dependency is vulnerability-free.

The lockfile was edited from registry JSON without a local install or lockfile regeneration.
Local validation is limited to static review, JSON/metadata checks and `git diff --check`.
Hosted `npm ci` is the authoritative lock consistency/integrity and installation gate;
hosted test/typecheck/build results must be reviewed before merge.

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
