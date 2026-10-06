#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
python3 "$ROOT/ci/test-image-pins.py"
python3 "$ROOT/ci/check_image_pins.py" "$ROOT"
