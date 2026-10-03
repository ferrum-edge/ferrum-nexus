#!/usr/bin/env bash
set -euo pipefail

SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

file_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"
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
  if [[ "$*" == *'{{.Id}} {{range $i, $d := .RepoDigests}}'* ]]; then
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
run_fixture bash -c 'umask 022; exec bash ./run.sh'
[[ "$(file_mode "$FIXTURE/e2e/.env")" == 600 ]] || fail 'generated .env mode is not 600'
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
sed -i.bak 's/^NEXUS_SECRET_KEY=.*/NEXUS_SECRET_KEY=preserved-secret/' "$FIXTURE/e2e/.env"
printf '\nFERRUM_EDGE_IMAGE=example/edge:old-saved-pin\n' >> "$FIXTURE/e2e/.env"
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

# Each valid suite selects exactly its suite; all and the default select every one.
for suite in all dataplane sso browser; do
  new_fixture "suite_$suite"
  run_fixture bash ./run.sh "$suite"
  if [[ "$suite" == all ]]; then
    contains "$FIXTURE/trace" 'npx tsx --test src/dataplane.test.ts'
    contains "$FIXTURE/trace" 'npx tsx --test src/sso.test.ts'
    contains "$FIXTURE/trace" 'npx playwright test'
  elif [[ "$suite" == dataplane ]]; then
    contains "$FIXTURE/trace" 'npx tsx --test src/dataplane.test.ts'
    not_contains "$FIXTURE/trace" 'npx tsx --test src/sso.test.ts'
    not_contains "$FIXTURE/trace" 'npx playwright test'
  elif [[ "$suite" == sso ]]; then
    contains "$FIXTURE/trace" 'npx tsx --test src/sso.test.ts'
    not_contains "$FIXTURE/trace" 'npx tsx --test src/dataplane.test.ts'
    not_contains "$FIXTURE/trace" 'npx playwright test'
  else
    contains "$FIXTURE/trace" 'npx playwright test'
    not_contains "$FIXTURE/trace" 'npx tsx --test src/dataplane.test.ts'
    not_contains "$FIXTURE/trace" 'npx tsx --test src/sso.test.ts'
  fi
done
new_fixture suite_default
run_fixture bash ./run.sh
contains "$FIXTURE/trace" 'npx tsx --test src/dataplane.test.ts'
contains "$FIXTURE/trace" 'npx tsx --test src/sso.test.ts'
contains "$FIXTURE/trace" 'npx playwright test'

# A fresh environment gets a Dex client secret, and one generated before the
# Dex service existed gains one without losing its other secrets.
new_fixture dex_secret
run_fixture bash ./run.sh
contains "$FIXTURE/e2e/.env" 'DEX_CLIENT_SECRET=test-secret'
contains "$FIXTURE/e2e/.env" 'DEX_PORT=5556'
new_fixture dex_secret_backfill
printf 'NEXUS_SECRET_KEY=preserved-secret\n' > "$FIXTURE/e2e/.env"
run_fixture bash ./run.sh
contains "$FIXTURE/e2e/.env" 'NEXUS_SECRET_KEY=preserved-secret'
contains "$FIXTURE/e2e/.env" 'DEX_CLIENT_SECRET=test-secret'
[[ "$(grep -c '^DEX_CLIENT_SECRET=' "$FIXTURE/e2e/.env")" == 1 ]] || fail 'Dex secret duplicated'
run_fixture bash ./run.sh
[[ "$(grep -c '^DEX_CLIENT_SECRET=' "$FIXTURE/e2e/.env")" == 1 ]] || fail 'Dex secret re-added'
new_fixture dex_secret_no_newline
printf 'NEXUS_SECRET_KEY=preserved-secret' > "$FIXTURE/e2e/.env"
run_fixture bash ./run.sh
grep -qx 'NEXUS_SECRET_KEY=preserved-secret' "$FIXTURE/e2e/.env" || fail 'last line was corrupted'
grep -qx 'DEX_CLIENT_SECRET=test-secret' "$FIXTURE/e2e/.env" || fail 'Dex secret glued to last line'

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

# Dotenv input is data: hostile shell syntax and unsupported records are rejected.
for hostile_case in backticks semicolon single_quote double_quote spaces crlf export_prefix duplicate unknown_key whitespace_line; do
  new_fixture "dotenv_$hostile_case"
  expected_error='error: invalid line in e2e/.env at line 1'
  case "$hostile_case" in
    backticks) printf 'NEXUS_IMAGE=`touch sentinel`\n' > "$FIXTURE/e2e/.env" ;;
    semicolon) printf 'NEXUS_IMAGE=bad;touch sentinel\n' > "$FIXTURE/e2e/.env" ;;
    single_quote) printf "NEXUS_IMAGE='bad'\n" > "$FIXTURE/e2e/.env" ;;
    double_quote) printf 'NEXUS_IMAGE="bad"\n' > "$FIXTURE/e2e/.env" ;;
    spaces) printf 'NEXUS_IMAGE=bad value\n' > "$FIXTURE/e2e/.env" ;;
    crlf)
      printf 'NEXUS_IMAGE=bad\r\n' > "$FIXTURE/e2e/.env"
      expected_error='error: control character in e2e/.env at line 1'
      ;;
    export_prefix) printf 'export NEXUS_IMAGE=bad\n' > "$FIXTURE/e2e/.env" ;;
    duplicate)
      printf 'NEXUS_IMAGE=first\nNEXUS_IMAGE=second\n' > "$FIXTURE/e2e/.env"
      expected_error='error: duplicate key in e2e/.env at line 2: NEXUS_IMAGE'
      ;;
    unknown_key)
      printf 'BASH_ENV=sentinel\n' > "$FIXTURE/e2e/.env"
      expected_error='error: unsupported key in e2e/.env at line 1: BASH_ENV'
      ;;
    whitespace_line) printf '   \n' > "$FIXTURE/e2e/.env" ;;
  esac
  status=0
  run_fixture bash ./run.sh && status=0 || status=$?
  [[ "$status" == 1 ]] || fail "$hostile_case dotenv returned $status"
  contains "$FIXTURE/output" "$expected_error"
  [[ ! -e "$FIXTURE/e2e/sentinel" ]] || fail "$hostile_case dotenv created sentinel"
  not_contains "$FIXTURE/trace" 'docker build'
done

# A failure after mktemp removes the secret-bearing temporary file.
new_fixture dotenv_temp_cleanup
cat > "$FIXTURE/bin/openssl" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
chmod +x "$FIXTURE/bin/openssl"
status=0
run_fixture bash ./run.sh && status=0 || status=$?
[[ "$status" == 1 ]] || fail "temp-file failure returned $status"
temp_files=("$FIXTURE"/e2e/.env.??????)
[[ ! -e "${temp_files[0]:-}" ]] || fail 'temporary dotenv file was not removed'

# Base64-style values retain equals, plus and slash characters; shell-looking comments stay inert.
new_fixture dotenv_valid_value
printf '# `touch sentinel`\nNEXUS_SECRET_KEY=abc=+/def\n' > "$FIXTURE/e2e/.env"
run_fixture bash ./run.sh
grep -qx 'NEXUS_SECRET_KEY=abc=+/def' "$FIXTURE/e2e/.env" || fail 'valid value changed'
[[ ! -e "$FIXTURE/e2e/sentinel" ]] || fail 'comment shell syntax executed'
contains "$FIXTURE/trace" 'docker build -t ferrum-nexus:e2e'

# An existing dotenv file is secured before its values are read.
new_fixture existing_env_mode
printf 'NEXUS_SECRET_KEY=preserved-secret\nDEX_CLIENT_SECRET=x\n' > "$FIXTURE/e2e/.env"
chmod 644 "$FIXTURE/e2e/.env"
run_fixture bash ./run.sh
[[ "$(file_mode "$FIXTURE/e2e/.env")" == 600 ]] || fail 'existing .env mode is not 600'

# A symlink cannot redirect secret reads or writes to another file.
new_fixture dotenv_symlink
printf 'NEXUS_SECRET_KEY=preserved-secret\n' > "$FIXTURE/target.env"
ln -s ../target.env "$FIXTURE/e2e/.env"
status=0
run_fixture bash ./run.sh && status=0 || status=$?
[[ "$status" == 1 ]] || fail "dotenv symlink returned $status"
not_contains "$FIXTURE/trace" 'docker build'

echo 'E2E runner shell regressions passed'
