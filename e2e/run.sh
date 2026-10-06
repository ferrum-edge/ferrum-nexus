#!/usr/bin/env bash
#
# The documented command: bring the end-to-end stack up from a clean
# environment, run the acceptance suite against it, collect artifacts, tear it
# down (issue #285).
#
#   ./e2e/run.sh            # everything
#   ./e2e/run.sh dataplane  # the gateway matrix only
#   ./e2e/run.sh sso        # single sign-on through a real Dex only
#   ./e2e/run.sh browser    # the portal journey only
#   E2E_KEEP=1 ./e2e/run.sh # leave the stack up to poke at afterwards
#
# Every wait here is bounded and every failure says what it was waiting for: a
# job that hangs until the runner's own timeout tells an operator nothing.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
ARTIFACTS="${E2E_ARTIFACTS:-$HERE/artifacts}"
SUITE="${1:-all}"
if [[ $# -gt 1 ]]; then
  printf 'Usage: %s [all|dataplane|sso|browser]\n' "$0" >&2
  exit 2
fi
case "$SUITE" in
  all|dataplane|sso|browser) ;;
  *)
    printf 'Usage: %s [all|dataplane|sso|browser]\n' "$0" >&2
    exit 2
    ;;
esac

# The acceptance suite and the shipped Compose quickstart use the same Edge
# digest. An explicit environment override remains available for experiments.
EDGE_OVERRIDE="${FERRUM_EDGE_IMAGE:-}"
# shellcheck disable=SC1091
source "$ROOT/release/compatibility.env"
PINNED_EDGE_IMAGE="$FERRUM_EDGE_IMAGE"

# `docker compose` (v2 plugin) or the standalone `docker-compose`. Anything
# else is a clear failure rather than a confusing one 40 lines later.
if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  echo "error: neither 'docker compose' nor 'docker-compose' is available" >&2
  exit 1
fi

cd "$HERE"
IMAGE_OVERRIDE="${NEXUS_IMAGE:-}"

ENV_TEMP=''
cleanup_env_temp() {
  if [[ -n "$ENV_TEMP" ]]; then
    rm -f -- "$ENV_TEMP"
  fi
}
trap cleanup_env_temp EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

write_generated_secret() {
  local name="$1" length="$2" secret
  if ! secret="$(openssl rand -hex "$length")"; then
    printf 'error: failed to generate %s for e2e/.env\n' "$name" >&2
    return 1
  fi
  printf '%s=%s\n' "$name" "$secret"
}

# ── Secrets ────────────────────────────────────────────────────────────────
#
# Minted per run rather than committed. A compose file with a working secret in
# it is a secret that ends up in somebody's real deployment.
if [[ -L .env || ( -e .env && ! -f .env ) ]]; then
  echo 'error: e2e/.env must be a regular file, not a symlink' >&2
  exit 1
fi

if [[ ! -f .env ]]; then
  echo "==> generating e2e/.env"
  ENV_TEMP="$(umask 077; mktemp .env.XXXXXX)"
  chmod 600 "$ENV_TEMP"
  {
    grep -E '^(NEXUS_IMAGE|NEXUS_PORT|FERRUM_PROXY_PORT|FERRUM_ADMIN_PORT|MAILPIT_HTTP_PORT|DEX_PORT)=' .env.example
    write_generated_secret NEXUS_SECRET_KEY 32
    write_generated_secret NEXUS_BOOTSTRAP_TOKEN 32
    write_generated_secret NEXUS_DB_PASSWORD 16
    write_generated_secret FERRUM_ADMIN_JWT_SECRET 32
    write_generated_secret FERRUM_BASIC_AUTH_HMAC_SECRET 32
    write_generated_secret DEX_CLIENT_SECRET 32
  } > "$ENV_TEMP"
  mv -f "$ENV_TEMP" .env
fi

# Existing files may have been created under a permissive umask. Refuse links
# above, then secure the file before reading or updating any secret values.
chmod 600 .env

# An e2e/.env generated before the Dex service existed has no client secret
# for it; add one rather than make the developer delete their environment.
if ! grep -q '^DEX_CLIENT_SECRET=' .env; then
  ENV_TEMP="$(umask 077; mktemp .env.XXXXXX)"
  chmod 600 "$ENV_TEMP"
  cat .env > "$ENV_TEMP"
  # Do not glue the new line onto a last line that has no newline.
  if [[ -s .env && -n "$(tail -c1 .env)" ]]; then echo >> "$ENV_TEMP"; fi
  write_generated_secret DEX_CLIENT_SECRET 32 >> "$ENV_TEMP"
  mv -f "$ENV_TEMP" .env
fi

# Only an image supplied by the caller is treated as a prebuilt image. The
# value in .env is a convenient tag for the image built from this checkout.
# Parse it as data: no shell syntax is accepted or evaluated.
ENV_KEYS=' '
ENV_LINE_NUMBER=0
while IFS= read -r ENV_LINE || [[ -n "$ENV_LINE" ]]; do
  ((ENV_LINE_NUMBER += 1))
  if [[ "$ENV_LINE" =~ [[:cntrl:]] ]]; then
    echo "error: control character in e2e/.env at line $ENV_LINE_NUMBER" >&2
    exit 1
  fi
  [[ -z "$ENV_LINE" || "$ENV_LINE" =~ ^[[:space:]]*# ]] && continue
  if [[ ! "$ENV_LINE" =~ ^([A-Z_][A-Z0-9_]*)=([A-Za-z0-9._:/@+=-]*)$ ]]; then
    echo "error: invalid line in e2e/.env at line $ENV_LINE_NUMBER" >&2
    exit 1
  fi
  ENV_KEY="${BASH_REMATCH[1]}"
  ENV_VALUE="${BASH_REMATCH[2]}"
  case "$ENV_KEY" in
    NEXUS_IMAGE|NEXUS_SECRET_KEY|NEXUS_BOOTSTRAP_TOKEN|NEXUS_DB_PASSWORD) ;;
    FERRUM_ADMIN_JWT_SECRET|FERRUM_BASIC_AUTH_HMAC_SECRET|DEX_CLIENT_SECRET) ;;
    NEXUS_PORT|FERRUM_PROXY_PORT|FERRUM_ADMIN_PORT|MAILPIT_HTTP_PORT) ;;
    DEX_PORT|FERRUM_EDGE_IMAGE|FERRUM_ADMIN_JWT_ISSUER) ;;
    *)
      echo "error: unsupported key in e2e/.env at line $ENV_LINE_NUMBER: $ENV_KEY" >&2
      exit 1
      ;;
  esac
  if [[ "$ENV_KEYS" == *" $ENV_KEY "* ]]; then
    echo "error: duplicate key in e2e/.env at line $ENV_LINE_NUMBER: $ENV_KEY" >&2
    exit 1
  fi
  ENV_KEYS+="$ENV_KEY "
  printf -v "$ENV_KEY" '%s' "$ENV_VALUE"
  export "$ENV_KEY"
done < .env

NEXUS_IMAGE="${IMAGE_OVERRIDE:-${NEXUS_IMAGE:-ferrum-nexus:e2e}}"
export NEXUS_IMAGE
FERRUM_EDGE_IMAGE="${EDGE_OVERRIDE:-$PINNED_EDGE_IMAGE}"
export FERRUM_EDGE_IMAGE

# ── The image under test ───────────────────────────────────────────────────
#
# The *packaged* portal, not a dev server: the suite's claim is about what an
# operator deploys. The default local path rebuilds this checkout every time;
# callers such as CI can explicitly supply a prebuilt image through NEXUS_IMAGE.
if [[ -z "$IMAGE_OVERRIDE" ]]; then
  echo "==> building $NEXUS_IMAGE"
  docker build -t "$NEXUS_IMAGE" -f "$ROOT/docker/Dockerfile" "$ROOT"
fi

cleanup() {
  local status=$?
  cleanup_env_temp
  mkdir -p "$ARTIFACTS"
  echo "==> collecting logs into $ARTIFACTS"
  # Container logs only. They carry request lines and gateway decisions, which
  # is what a failure needs; they do not carry the credentials, which are
  # show-once in the responses and never logged.
  for service in nexus ferrum-edge postgres upstream mail dex; do
    "${COMPOSE[@]}" logs --no-color --timestamps "$service" \
      > "$ARTIFACTS/$service.log" 2>&1 || true
  done
  if [[ "${E2E_KEEP:-0}" == "1" ]]; then
    echo "==> E2E_KEEP=1, leaving the stack up (${COMPOSE[*]} down -v to remove it)"
  else
    echo "==> tearing the stack down"
    "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup EXIT

echo "==> starting the stack"
# No `--wait`: the stack includes a one-shot init container that chowns the
# gateway's data volume and then exits, and compose's readiness wait treats an
# exited service as a failure. The suite's own `waitForStack()` is the
# readiness gate anyway — it is bounded, and it names the surface it gave up
# on, which "compose timed out" does not.
"${COMPOSE[@]}" up -d --build

NEXUS_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$NEXUS_IMAGE")"
EDGE_IMAGE_DETAILS="$(
  docker image inspect \
    --format '{{.Id}} {{range $i, $d := .RepoDigests}}{{if $i}},{{end}}{{$d}}{{end}}' \
    "$FERRUM_EDGE_IMAGE"
)"
echo "==> Nexus image: $NEXUS_IMAGE ($NEXUS_IMAGE_ID)"
echo "==> Ferrum Edge image: $FERRUM_EDGE_IMAGE ($EDGE_IMAGE_DETAILS)"

# Fail early and loudly if something never came up at all, rather than letting
# it surface two minutes later as a readiness timeout.
if "${COMPOSE[@]}" ps --status=exited --services | grep -vx 'ferrum-edge-init' | grep -q .; then
  echo "error: a service exited during startup:" >&2
  "${COMPOSE[@]}" ps >&2
  exit 1
fi

export E2E_PORTAL_URL="http://127.0.0.1:${NEXUS_PORT:-8787}"
export E2E_GATEWAY_URL="http://127.0.0.1:${FERRUM_PROXY_PORT:-8000}"
export E2E_ADMIN_URL="http://127.0.0.1:${FERRUM_ADMIN_PORT:-9000}"
export E2E_MAIL_URL="http://127.0.0.1:${MAILPIT_HTTP_PORT:-8025}"
export E2E_DEX_ISSUER="http://127.0.0.1:${DEX_PORT:-5556}/dex"
export E2E_COMPOSE="${COMPOSE[*]}"
export E2E_PROJECT_DIR="$HERE"

if [[ ! -d node_modules ]]; then
  echo "==> installing the suite's own dependencies"
  npm install --no-audit --no-fund
fi

# Bootstrap the portal once, before either suite. Only the *first*
# registration becomes `super_admin`, so the two suites cannot each claim it —
# whichever ran second used to find itself an ordinary provider and fail on its
# first admin call.
echo "==> preparing the portal"
npx tsx src/prepare.ts

if [[ "$SUITE" == "all" || "$SUITE" == "dataplane" ]]; then
  echo "==> data-plane acceptance suite"
  npx tsx --test src/dataplane.test.ts
fi

if [[ "$SUITE" == "all" || "$SUITE" == "sso" ]]; then
  echo "==> single sign-on through Dex"
  npx tsx --test src/sso.test.ts
fi

if [[ "$SUITE" == "all" || "$SUITE" == "browser" ]]; then
  echo "==> portal browser journey"
  npx playwright install --with-deps chromium
  E2E_ARTIFACTS="$ARTIFACTS" npx playwright test
fi

echo "==> acceptance run passed"
