# Image pin check

The required `checks` job runs `ci/check-image-pins.sh`. Its structural scan checks
tracked Dockerfiles (`FROM` and external `COPY --from`), Compose image fields,
workflow image fields and `docker://` actions, plus direct Docker `run`, `create`,
and `pull` commands in workflow lines. Literal registry images require a full
lowercase SHA-256 digest. Tags must be three-part versions unless a specific
image and tag has a reason-listed exception in `ci/check_image_pins.py`.

The exceptions retain the repository's current Node/PostgreSQL/Alpine distro
channels and Mailpit's two-part release tag; their digest still fixes the image
content. Compose also permits the required `FERRUM_EDGE_IMAGE` deployment input
and the `NEXUS_IMAGE` fallback used by acceptance. Workflow commands may use
the locally built `ferrum-nexus:ci` and `ferrum-nexus:e2e` images.

This replaces a custom YAML parser and shell lexer with line-based structural
checks. It no longer scans shell scripts, dotenv overrides, nested command
substitutions, shell wrappers, computed commands, or arbitrary YAML flow
collections. Workflow Docker commands are recognized when written directly on
a line; wrapped or dynamically constructed commands are outside the check.
The check does not execute files or expand variables.
