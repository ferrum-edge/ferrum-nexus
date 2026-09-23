#!/usr/bin/env bash
# Evaluate the README's actual full-stack commands in a clean CI shell. Replace
# only the final startup command with Compose's configuration-only validation.
set -euo pipefail

cd "$(dirname "$0")/.."

for file in README.md docker/docker-compose.example.yml docs/operations.md docs/getting-started.md; do
  if ! grep -Fq '. ./release/compatibility.env' "$file"; then
    echo "error: $file does not load the compatibility record" >&2
    exit 1
  fi
done
if ! grep -Fq 'source "$ROOT/release/compatibility.env"' e2e/run.sh; then
  echo 'error: acceptance does not load the compatibility record' >&2
  exit 1
fi
if grep -Eq '^FERRUM_EDGE_IMAGE=' e2e/.env.example; then
  echo 'error: e2e/.env.example duplicates the Edge image reference' >&2
  exit 1
fi

commands=$(awk '
  /<!-- compose-quickstart:start -->/ { inside = 1; count++; next }
  /<!-- compose-quickstart:end -->/ { inside = 0; next }
  inside && /^```/ { next }
  inside { print }
  END { if (count != 1 || inside) exit 1 }
' README.md)
if [[ "$(printf '%s\n' "$commands" | tail -n 1)" != 'docker compose up -d' ]]; then
  echo 'error: README full-stack block must end with docker compose up -d' >&2
  exit 1
fi

# The documented block is the source of the test variables. No checkout .env,
# inherited variables or containers can make an omitted README variable pass.
setup=$(printf '%s\n' "$commands" | sed '$d')
eval "$setup"
docker compose --env-file /dev/null config --quiet
if ! docker compose --env-file /dev/null config --images | grep -Fx "$FERRUM_EDGE_IMAGE" >/dev/null; then
  echo 'error: Compose did not select the compatibility record Edge image' >&2
  exit 1
fi

for variable in NEXUS_SECRET_KEY NEXUS_DB_PASSWORD FERRUM_ADMIN_JWT_SECRET FERRUM_BASIC_AUTH_HMAC_SECRET FERRUM_EDGE_IMAGE; do
  value=${!variable}
  unset "$variable"
  if docker compose --env-file /dev/null config --quiet >/dev/null 2>&1; then
    echo "error: Compose accepted missing $variable" >&2
    exit 1
  fi
  printf -v "$variable" '%s' "$value"
  export "$variable"
done
