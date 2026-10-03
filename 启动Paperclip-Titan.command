#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
exec ./scripts/v3-local.sh start
