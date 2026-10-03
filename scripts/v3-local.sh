#!/bin/bash
set -euo pipefail
V3_BASE="$(cd "$(dirname "$0")/.." && pwd -P)"
exec "$V3_BASE/scripts/titan-local.sh" "${1:-start}"
