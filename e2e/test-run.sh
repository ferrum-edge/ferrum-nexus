#!/usr/bin/env bash
set -euo pipefail

SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

new_fixture() {
  local name="$1"
  FIXTURE="$TEMP/$name"
  mkdir -p "$FIXTURE/e2e" "$FIXTURE/release" "$FIXTURE/docker" "$FIXTURE/bin"
  cp "$SOURCE/run.sh" "$FIXTURE/e2e/run.sh"
  cp "$SOURCE/.env.example" "$FIXTURE/e2e/.env.example"
  mkdir -p "$FIXTURE/e2e/node_modules"
  touch "$FIXTURE/docker/Dockerfile"
  cat > "$FIXTURE/release/compatibility.env" <<'EOF'
FERRUM_EDGE_IMAGE=example/edge:pin-one@sha256:111
EOF
  cat > "$FIXTURE/bin/docker" <<'EOF'
#!/usr/bin/env bash
printf 'docker %s | nexus=%s edge=%s\n' "$*" "${NEXUS_IMAGE:-}" "${FERRUM_EDGE_IMAGE:-}" >> "$E2E_TRACE"
if [[ "$1" == compose && "$2" == version ]]; then
  exit 0
fi
if [[ "$1" == compose && "$2" == ps ]]; then
  exit 0
fi
if [[ "$1" == image && "$2" == inspect ]]; then
  if [[ "$*" == *'{{.Id}} {{join .RepoDigests ","}}'* ]]; then
    printf 'sha256:edge-image example/edge@sha256:111\n'
  else
    printf 'sha256:nexus-image\n'
  fi
fi
EOF
  cat > "$FIXTURE/bin/openssl" <<'EOF'
#!/usr/bin/env bash
printf 'test-secret\n'
EOF
  cat > "$FIXTURE/bin/npx" <<'EOF'
#!/usr/bin/env bash
printf 'npx %s\n' "$*" >> "$E2E_TRACE"
EOF
  cat > "$FIXTURE/bin/npm" <<'EOF'
#!/usr/bin/env bash
printf 'npm %s\n' "$*" >> "$E2E_TRACE"
EOF
  chmod +x "$FIXTURE/bin/docker" "$FIXTURE/bin/openssl" "$FIXTURE/bin/npx" "$FIXTURE/bin/npm"
  : > "$FIXTURE/trace"
}

run_fixture() {
  local status=0
  (cd "$FIXTURE/e2e" && PATH="$FIXTURE/bin:$PATH" E2E_TRACE="$FIXTURE/trace" "$@") > "$FIXTURE/output" 2>&1 || status=$?
  if [[ "$status" != 0 ]]; then
    echo "run_fixture $* exited $status; output:" >&2
    cat "$FIXTURE/output" >&2
  fi
  return "$status"
}

contains() {
  grep -Fq -- "$2" "$1" || fail "expected '$2' in $1"
}

not_contains() {
  if grep -Fq -- "$2" "$1"; then
    fail "unexpected '$2' in $1"
  fi
}

# Fresh run and repeat run both rebuild the current checkout and use the pin.
new_fixture fresh
run_fixture bash ./run.sh
contains "$FIXTURE/trace" 'docker build -t ferrum-nexus:e2e'
contains "$FIXTURE/trace" 'edge=example/edge:pin-one@sha256:111'
contains "$FIXTURE/output" 'Nexus image: ferrum-nexus:e2e (sha256:nexus-image)'
contains "$FIXTURE/output" 'Ferrum Edge image: example/edge:pin-one@sha256:111'
printf 'updated source tree\n' > "$FIXTURE/source-marker"
run_fixture bash ./run.sh
[[ "$(grep -c 'docker build -t ferrum-nexus:e2e' "$FIXTURE/trace")" == 2 ]] || fail 'repeat run did not rebuild'

# A saved .env cannot mask a newer compatibility pin; generated secrets remain.
new_fixture changed_pin
run_fixture bash ./run.sh
sed -i.bak 's/pin-one/pin-two/' "$FIXTURE/release/compatibility.env"
printf '\nFERRUM_EDGE_IMAGE=example/edge:old-saved-pin\nNEXUS_SECRET_KEY=preserved-secret\n' >> "$FIXTURE/e2e/.env"
run_fixture bash ./run.sh
contains "$FIXTURE/trace" 'edge=example/edge:pin-two@sha256:111'
not_contains "$FIXTURE/trace" 'edge=example/edge:old-saved-pin'
contains "$FIXTURE/e2e/.env" 'NEXUS_SECRET_KEY=preserved-secret'

# Explicit image overrides preserve CI's prebuilt-image path.
new_fixture overrides
NEXUS_IMAGE=ci/nexus:built FERRUM_EDGE_IMAGE=example/edge:override \
  run_fixture bash ./run.sh
not_contains "$FIXTURE/trace" 'docker build -t'
contains "$FIXTURE/trace" 'nexus=ci/nexus:built edge=example/edge:override'

# Each valid suite selects exactly its suite; all and the default select both.
for suite in all dataplane browser; do
  new_fixture "suite_$suite"
  run_fixture bash ./run.sh "$suite"
  if [[ "$suite" == all ]]; then
    contains "$FIXTURE/trace" 'npx tsx --test src/dataplane.test.ts'
    contains "$FIXTURE/trace" 'npx playwright test'
  elif [[ "$suite" == dataplane ]]; then
    contains "$FIXTURE/trace" 'npx tsx --test src/dataplane.test.ts'
    not_contains "$FIXTURE/trace" 'npx playwright test'
  else
    contains "$FIXTURE/trace" 'npx playwright test'
    not_contains "$FIXTURE/trace" 'npx tsx --test src/dataplane.test.ts'
  fi
done
new_fixture suite_default
run_fixture bash ./run.sh
contains "$FIXTURE/trace" 'npx tsx --test src/dataplane.test.ts'
contains "$FIXTURE/trace" 'npx playwright test'

# Invalid or extra arguments fail before environment creation or Docker calls.
for args in 'unknown' 'all extra'; do
  new_fixture invalid
  status=0
  # Intentional word splitting supplies the argument vector under test.
  # shellcheck disable=SC2086
  run_fixture bash ./run.sh $args && status=0 || status=$?
  [[ "$status" == 2 ]] || fail "invalid arguments returned $status"
  contains "$FIXTURE/output" 'Usage:'
  not_contains "$FIXTURE/output" 'acceptance run passed'
  not_contains "$FIXTURE/trace" 'docker '
  [[ ! -e "$FIXTURE/e2e/.env" ]] || fail 'invalid arguments generated .env'
done

echo 'E2E runner shell regressions passed'
