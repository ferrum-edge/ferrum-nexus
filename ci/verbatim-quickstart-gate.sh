#!/usr/bin/env bash
# The verbatim quickstart gate (issue #287). In the clean checkout named by $1,
# run the README's full-stack install block exactly as written, wait (bounded)
# for every service to be healthy, then follow docs/getting-started.md from the
# founding registration to an authenticated request through the gateway's
# :8000 listener. Anything short of that fails the gate, and the stack is torn
# down whatever happens.
#
# Run it from a clean shell, as CI does:
#   env -i PATH="$PATH" HOME="$HOME" bash ci/verbatim-quickstart-gate.sh <checkout>
set -euo pipefail

checkout=${1:?usage: verbatim-quickstart-gate.sh <checkout>}
cd "$checkout"

PORTAL=http://127.0.0.1:8787
GATEWAY=http://127.0.0.1:8000
PASSWORD=correct-horse-battery-staple
SLUG=release-record
work=$(mktemp -d)

fail() {
  echo "::error::$*" >&2
  exit 1
}

# wait_for <seconds> <what> <command...>: re-run the command until it succeeds,
# failing the gate once the deadline passes.
wait_for() {
  local limit=$1 what=$2
  shift 2
  local deadline=$((SECONDS + limit))
  until "$@"; do
    if ((SECONDS >= deadline)); then
      fail "timed out after ${limit}s waiting for $what"
    fi
    sleep 3
  done
  echo "ok: $what"
}

teardown() {
  local status=$?
  if ((status != 0)); then
    docker compose ps --all || true
    docker compose logs --no-color --tail 200 || true
  fi
  docker compose down --volumes --remove-orphans || true
  rm -rf "$work"
  exit "$status"
}
trap teardown EXIT

# ── A clean environment ──────────────────────────────────────────────────────

if [[ -n "$(git status --porcelain --ignored)" ]]; then
  fail 'the checkout is not clean; the gate installs from a pristine tree only'
fi
if [[ -n "$(docker ps -aq)" ]]; then
  fail 'containers already exist on this host; the gate needs a clean Docker engine'
fi
echo "Installing $(git rev-parse HEAD) ($(git describe --tags --always))"

# ── The README block, verbatim ───────────────────────────────────────────────

# The same extraction as ci/check-compose-quickstart.sh: exactly one marked
# block, its fence lines dropped and nothing else touched.
commands=$(awk '
  /<!-- compose-quickstart:start -->/ { inside = 1; count++; next }
  /<!-- compose-quickstart:end -->/ { inside = 0; next }
  inside && /^```/ { next }
  inside { print }
  END { if (count != 1 || inside) exit 1 }
' README.md) || fail 'README.md must hold exactly one compose-quickstart block'
if [[ "$(printf '%s\n' "$commands" | tail -n 1)" != 'docker compose up -d' ]]; then
  fail 'the README full-stack block must end with docker compose up -d'
fi

echo '── README full-stack install block ──'
printf '%s\n' "$commands"
echo '────────────────────────────────────'
eval "$commands"

# ── Healthy services ─────────────────────────────────────────────────────────

container() {
  local id
  id=$(docker compose ps --all -q "$1")
  [[ -n "$id" ]] || fail "compose has no $1 container"
  printf '%s\n' "$id"
}

healthy() {
  [[ "$(docker inspect -f '{{.State.Health.Status}}' "$(container "$1")")" == healthy ]]
}

portal_ok() {
  curl -fsS --max-time 5 -o "$work/health.json" "$PORTAL/api/health" 2>/dev/null &&
    jq -e '.status == "ok" and .database.status == "ok" and .edge.status == "ok"' \
      "$work/health.json" >/dev/null
}

# `curl` without `-f` succeeds on any HTTP answer, including the 404 an empty
# listener gives — the getting-started check.
listener_up() {
  curl -s --max-time 5 -o /dev/null "$GATEWAY/"
}

wait_for 300 'postgres to be healthy' healthy postgres
wait_for 300 'the nexus container to be healthy' healthy nexus
wait_for 300 'GET /api/health to report status, database and edge ok' portal_ok
wait_for 120 'the gateway proxy listener on :8000' listener_up

init=$(container ferrum-edge-init)
[[ "$(docker inspect -f '{{.State.Status}} {{.State.ExitCode}}' "$init")" == 'exited 0' ]] ||
  fail 'ferrum-edge-init did not complete successfully'

# ── The walkthrough: register ────────────────────────────────────────────────

# README: "`docker compose logs nexus` shows the first-run bootstrap token."
banners=$(docker compose logs --no-color --no-log-prefix nexus | grep -F 'FIRST-RUN BOOTSTRAP' || true)
[[ -n "$banners" && "$(printf '%s\n' "$banners" | wc -l)" -eq 1 ]] ||
  fail 'docker compose logs nexus must show exactly one first-run bootstrap banner'
tokens=$(printf '%s\n' "$banners" | grep -oE '[0-9a-f]{64}' || true)
[[ -n "$tokens" && "$(printf '%s\n' "$tokens" | wc -l)" -eq 1 ]] ||
  fail 'the bootstrap banner must carry exactly one token'

# register <jar> <email> <name> <role> [bootstrap token]
register() {
  jq -n --arg email "$2" --arg name "$3" --arg role "$4" --arg token "${5:-}" \
    --arg password "$PASSWORD" \
    '{email: $email, password: $password, display_name: $name, role: $role}
      + (if $token == "" then {} else {bootstrap_token: $token} end)' |
    curl -sS --fail-with-body -c "$work/$1.txt" -X POST "$PORTAL/api/auth/register" \
      -H 'content-type: application/json' --data-binary @-
}

csrf() {
  curl -sS --fail-with-body -b "$work/$1.txt" "$PORTAL/api/auth/me" | jq -er .csrf_token
}

register admin root@example.com Root provider "$tokens" | jq -e '.user.role == "super_admin"' ||
  fail 'the founding registration did not become super_admin'
register provider pat@example.com 'Pat Provider' provider | jq -e '.user.role == "provider"' ||
  fail 'the provider registration failed'
register client cleo@example.com 'Cleo Client' client | jq -e '.user.role == "client"' ||
  fail 'the client registration failed'
PROVIDER_CSRF=$(csrf provider)
CLIENT_CSRF=$(csrf client)

# ── Publish, request, approve, issue ─────────────────────────────────────────

# The Compose stack accepts only public upstreams (it does not set
# NEXUS_ALLOW_PRIVATE_UPSTREAMS), so the API fronts this release's own files on
# GitHub. Pinned to the installed commit, the answer is known byte for byte.
revision=$(git rev-parse HEAD)
cat >"$work/openapi.yaml" <<YAML
openapi: 3.1.0
info:
  title: Release Record API
  version: 1.0.0
servers:
  - url: https://raw.githubusercontent.com/ferrum-edge/ferrum-nexus/$revision
paths:
  /release/compatibility.env:
    get:
      summary: The release's Nexus/Edge compatibility record
      responses:
        '200':
          description: OK
YAML

jq -n --rawfile spec "$work/openapi.yaml" --arg slug "$SLUG" \
  '{name: "Release Record API", slug: $slug, version: "1.0.0", spec: $spec,
    auth_plugin: "key_auth", requestable: true, visibility: "public",
    rate_limit: {limit: 1000, window_seconds: 60}}' |
  curl -sS --fail-with-body -b "$work/provider.txt" -X POST "$PORTAL/api/apis" \
    -H 'content-type: application/json' -H "X-Nexus-CSRF: $PROVIDER_CSRF" \
    --data-binary @- >"$work/api.json" ||
  fail "publishing failed: $(cat "$work/api.json")"
API_ID=$(jq -er '.api.id' "$work/api.json")
jq -e '.api.ferrum_proxy_id != null' "$work/api.json" >/dev/null ||
  fail 'the published API has no gateway proxy'

curl -sS --fail-with-body -b "$work/client.txt" "$PORTAL/api/catalog?q=release" >"$work/catalog.json"
INVOKE_URL=$(jq -er --arg slug "$SLUG" \
  '.items[] | select(.slug == $slug and .requestable and .access_state == "none") | .invoke_url' \
  "$work/catalog.json") || fail 'the client catalog does not list the API as requestable'
[[ "$INVOKE_URL" == "$GATEWAY/nexus/$SLUG" ]] ||
  fail "the catalog invoke URL is $INVOKE_URL, not $GATEWAY/nexus/$SLUG"

jq -n --arg api "$API_ID" \
  '{api_id: $api, justification: "Reconciling partner invoices nightly for the Acme integration."}' |
  curl -sS --fail-with-body -b "$work/client.txt" -X POST "$PORTAL/api/access-requests" \
    -H 'content-type: application/json' -H "X-Nexus-CSRF: $CLIENT_CSRF" --data-binary @- |
  jq -e '.access_request.status == "pending"' || fail 'the access request is not pending'

REQ_ID=$(curl -sS --fail-with-body -b "$work/provider.txt" \
  "$PORTAL/api/access-requests?status=pending" | jq -er '.items[0].id')
curl -sS --fail-with-body -b "$work/provider.txt" -X POST \
  "$PORTAL/api/access-requests/$REQ_ID/approve" \
  -H 'content-type: application/json' -H "X-Nexus-CSRF: $PROVIDER_CSRF" \
  -d '{"decision_note":"Approved for the nightly reconciliation job."}' |
  jq -e --arg group "nexus:api:$API_ID:approved" \
    '.access_request.status == "approved" and .grant.acl_group == $group' ||
  fail 'the approval did not grant the API ACL group'

API_KEY=$(curl -sS --fail-with-body -b "$work/client.txt" -X POST "$PORTAL/api/credentials" \
  -H 'content-type: application/json' -H "X-Nexus-CSRF: $CLIENT_CSRF" \
  -d '{"credential_type":"keyauth","label":"nightly-job"}' | jq -er '.secret.key')

# ── The authenticated call through the gateway ───────────────────────────────

# call <out> [curl args...]: the status code of a gateway call to the record.
call() {
  local out=$1
  shift
  curl -sS --max-time 15 -o "$out" -w '%{http_code}' "$@" "$INVOKE_URL/release/compatibility.env" ||
    true
}

served() {
  [[ "$(call "$work/body" -H "X-API-Key: $API_KEY")" == 200 ]] &&
    cmp -s "$work/body" release/compatibility.env
}
wait_for 120 'an authenticated 200 through the gateway with the released record' served

status=$(call /dev/null)
[[ "$status" == 401 ]] || fail "a call without the key answered $status, not 401"
echo 'ok: a call without the key is refused with 401'

# ── Revocation holds ─────────────────────────────────────────────────────────

GRANT_ID=$(curl -sS --fail-with-body -b "$work/provider.txt" \
  "$PORTAL/api/grants?status=active" | jq -er '.items[0].id')
curl -sS --fail-with-body -b "$work/provider.txt" -X POST "$PORTAL/api/grants/$GRANT_ID/revoke" \
  -H 'content-type: application/json' -H "X-Nexus-CSRF: $PROVIDER_CSRF" \
  -d '{"reason":"Verbatim quickstart gate."}' | jq -e '.grant.status == "revoked"' ||
  fail 'the grant was not revoked'

refused() {
  [[ "$(call /dev/null -H "X-API-Key: $API_KEY")" == 403 ]]
}
wait_for 120 'the revoked credential to be refused with 403' refused

# ── Nothing restarted on the way ─────────────────────────────────────────────

for service in postgres nexus ferrum-edge; do
  restarts=$(docker inspect -f '{{.RestartCount}}' "$(container "$service")")
  [[ "$restarts" == 0 ]] || fail "$service restarted $restarts time(s)"
done

echo 'Verbatim quickstart gate passed.'
