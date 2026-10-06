# Image pin check

The required `checks` job runs `ci/check-image-pins.sh`. Its structural scan checks
tracked Dockerfiles (`FROM`, external `COPY --from`, syntax frontends and external
`RUN --mount` images), Compose and workflow YAML image fields, workflow `docker://`
actions and Docker `run`, `create`, and `pull` commands (including backslash
continuations), plus `FERRUM_EDGE_IMAGE` and `NEXUS_IMAGE` assignments in
`.env`, `.env.*` and `*.env` files. The same two variables in a workflow `env:`
block, at workflow, job or step level, are checked too: a literal value must be
digest-pinned, the locally built images are allowed, and a `${{ … }}` or other
expression fails closed rather than being treated as pinned. Docker options before
the command, `docker container` commands and `docker image pull` are recognized.
Known options that take image-independent values (including `--label`, `-e` and
`--name`) are skipped; unsupported options fail closed. An unquoted `$(…)` or
backtick substitution inside an option value (as in `-v $(pwd):/src`) stays with
that value, so the real image after it is still found. Quoted and flow-style image
keys the line scanner recognizes are checked, and empty image fields fail closed.
Dockerfile comment-only lines inside continued instructions are ignored.

Literal registry images require a full lowercase SHA-256 digest. Tags must be
three-part versions unless a specific image and tag has a reason-listed exception
in `ci/check_image_pins.py`.

The exceptions retain the repository's current Node/PostgreSQL/Alpine distro
channels and Mailpit's two-part release tag; their digest still fixes the image
content. Compose files and workflow `image:`/`container:` fields permit
`${FERRUM_EDGE_IMAGE:?...}` and `${NEXUS_IMAGE:?...}` required deployment inputs;
workflow `env:` values and env files must name a pinned image and reject them.
The acceptance fallback
`${NEXUS_IMAGE:-ferrum-nexus:e2e}` is allowed as a local image. Workflow commands
may use the locally built `ferrum-nexus:ci` image, and `e2e/.env.example` may name
the local `ferrum-nexus:e2e` image.

This is a bounded static scan, not a full YAML or shell interpreter. It does not
execute files, scan shell scripts, expand variables, or resolve computed command
names, shell aliases, sourced files or values assembled indirectly. Workflow
Docker commands are checked per line (backslash continuations joined), including
quoted `run:` scalars, `$(...)`/backtick substitutions, quoted `bash -c` strings,
commands joined by `;`, `&&`, `|` or parentheses, and `sudo`/absolute-path
`docker`. Any line holding a `docker ... run|create|pull` segment that the
tokenizer cannot resolve to an image, including unknown Docker options, fails
rather than being skipped. `docker compose` commands are not image references;
Compose files are scanned directly. A tracked YAML file is treated as Compose when
its name contains `compose` or it has a top-level `services:` key, so a file such
as `deploy/stack.yml` is scanned too. Commands assembled from
variables or invoked through aliases are outside the check. Arbitrary YAML flow collections
that do not expose an `image` or `container` key in a recognizable key position
are outside the scan.
