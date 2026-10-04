#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# A GitHub expression in an image field is rejected, including matrix
# expressions. If one is introduced later, resolve and validate every matrix
# value here before adding a narrowly scoped exception.
candidate_pattern='^[[:space:]]*(-[[:space:]]*)?(image:[[:space:]]*|container:[[:space:]]*[^[:space:]{]|container:[[:space:]]*\{.*image:|FROM[[:space:]]+|uses:[[:space:]]*docker://)|'
candidate_pattern+='(^|[;&|[:space:]])docker[[:space:]]+([^[:space:]]+[[:space:]]+)*(container[[:space:]]+)?(run|pull|create)([[:space:]]|$)|'
candidate_pattern+='(^|[;&|[:space:]])docker([[:space:]]+container)?[[:space:]]*\\[[:space:]]*$'

unpinned=$(grep -rnE "$candidate_pattern" \
  --exclude=check-image-pins.sh \
  docker e2e ci .github/workflows \
  | sed 's/[[:space:]]#.*$//' \
  | grep -vE '@sha256:[0-9a-f]{64}([[:space:]]|$)' \
  | grep -vE 'image:[[:space:]]*\$\{(FERRUM_EDGE_IMAGE|NEXUS_IMAGE)([:?}]|:-)' \
  | grep -vE 'FROM[[:space:]]+scratch([[:space:]]|$)' \
  | grep -vE 'docker[[:space:]]+run[[:space:]]+--rm[[:space:]]+ferrum-nexus:ci([[:space:]]|$)' \
  || true)

if [ -n "$unpinned" ]; then
  echo '::error::Pin every container image to a full registry digest:'
  echo "$unpinned"
  exit 1
fi
