#!/usr/bin/env bash
#
# The documented command: bring the end-to-end stack up from a clean
# environment, run the acceptance suite against it, collect artifacts, tear it
# down (issue #285).
#
#   ./e2e/run.sh            # everything
#   ./e2e/run.sh dataplane  # the gateway matrix only
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

# The release candidate and the shipped Compose quickstart use the same Edge
# digest. An explicit environment override remains available for experiments.
EDGE_OVERRIDE="${FERRUM_EDGE_IMAGE:-}"
# shellcheck disable=SC1091
source "$ROOT/release/compatibility.env"
FERRUM_EDGE_IMAGE="${EDGE_OVERRIDE:-$FERRUM_EDGE_IMAGE}"

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

# ── Secrets ────────────────────────────────────────────────────────────────
#
# Minted per run rather than committed. A compose file with a working secret in
# it is a secret that ends up in somebody's real deployment.
if [[ ! -f .env ]]; then
  echo "==> generating e2e/.env"
  {
    printf 'FERRUM_EDGE_IMAGE=%s\n' "$FERRUM_EDGE_IMAGE"
    grep -E '^(NEXUS_IMAGE|NEXUS_PORT|FERRUM_PROXY_PORT|FERRUM_ADMIN_PORT|MAILPIT_HTTP_PORT)=' .env.example
    echo "NEXUS_SECRET_KEY=$(openssl rand -hex 32)"
    echo "NEXUS_BOOTSTRAP_TOKEN=$(openssl rand -hex 32)"
    echo "NEXUS_DB_PASSWORD=$(openssl rand -hex 16)"
    echo "FERRUM_ADMIN_JWT_SECRET=$(openssl rand -hex 32)"
    echo "FERRUM_BASIC_AUTH_HMAC_SECRET=$(openssl rand -hex 32)"
  } > .env
fi
# An image named in the environment wins over the generated file — that is how
# CI hands in the one it just built.
IMAGE_OVERRIDE="${NEXUS_IMAGE:-}"
set -a
# shellcheck disable=SC1091
source .env
set +a
NEXUS_IMAGE="${IMAGE_OVERRIDE:-${NEXUS_IMAGE:-ferrum-nexus:e2e}}"
export NEXUS_IMAGE
FERRUM_EDGE_IMAGE="${EDGE_OVERRIDE:-$FERRUM_EDGE_IMAGE}"
export FERRUM_EDGE_IMAGE

# ── The image under test ───────────────────────────────────────────────────
#
# The *packaged* portal, not a dev server: the suite's claim is about what an
# operator deploys. CI builds it once and passes it in through NEXUS_IMAGE.
if ! docker image inspect "$NEXUS_IMAGE" >/dev/null 2>&1; then
  echo "==> building $NEXUS_IMAGE"
  docker build -t "$NEXUS_IMAGE" -f "$ROOT/docker/Dockerfile" "$ROOT"
fi

cleanup() {
  local status=$?
  mkdir -p "$ARTIFACTS"
  echo "==> collecting logs into $ARTIFACTS"
  # Container logs only. They carry request lines and gateway decisions, which
  # is what a failure needs; they do not carry the credentials, which are
  # show-once in the responses and never logged.
  for service in nexus ferrum-edge postgres upstream mail; do
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

if [[ "$SUITE" == "all" || "$SUITE" == "browser" ]]; then
  echo "==> portal browser journey"
  npx playwright install --with-deps chromium
  E2E_ARTIFACTS="$ARTIFACTS" npx playwright test
fi

echo "==> acceptance run passed"
