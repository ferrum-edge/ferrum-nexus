# Image pin check

The required `checks` job runs `ci/check-image-pins.sh`. Its structural scan checks
tracked Dockerfiles (`FROM` and external `COPY --from`), Compose and workflow YAML
image fields, workflow `docker://` actions and direct Docker `run`, `create`, and
`pull` commands, plus `FERRUM_EDGE_IMAGE` and `NEXUS_IMAGE` assignments in
`.env`, `.env.*` and `*.env` files. Docker options before the command,
`docker container` commands and `docker image pull` are recognized. Known options
that take image-independent values (including `--label`, `-e` and `--name`) are
skipped; unsupported options fail closed. Quoted and flow-style image keys the
line scanner recognizes are checked, and empty image fields fail closed.
Dockerfile comment-only lines inside continued instructions are ignored.

Literal registry images require a full lowercase SHA-256 digest. Tags must be
three-part versions unless a specific image and tag has a reason-listed exception
in `ci/check_image_pins.py`.

The exceptions retain the repository's current Node/PostgreSQL/Alpine distro
channels and Mailpit's two-part release tag; their digest still fixes the image
content. Compose permits `${FERRUM_EDGE_IMAGE:?...}` and
`${NEXUS_IMAGE:?...}` required deployment inputs. The acceptance fallback
`${NEXUS_IMAGE:-ferrum-nexus:e2e}` is allowed as a local image. Workflow commands
may use the locally built `ferrum-nexus:ci` image, and `e2e/.env.example` may name
the local `ferrum-nexus:e2e` image.

This is a bounded static scan, not a full YAML or shell interpreter. It does not
execute files, scan shell scripts, expand variables, or resolve computed command
names, shell aliases, sourced files or values assembled indirectly. Workflow
Docker commands must be written directly on a line; wrapped or dynamically
constructed commands are outside the check. Arbitrary YAML flow collections
that do not expose an `image` or `container` key in a recognizable key position
are outside the scan.
