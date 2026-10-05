#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
node_bin="/home/dains/.paperclip/runtime/node-v24.21.0/bin/node"
config_path="${PAPERCLIP_CONFIG:-/home/dains/.paperclip/instances/default/config.json}"

if [[ ! -x "$node_bin" || ! -f "$config_path" ]]; then
  printf 'Missing Node 24 runtime or Paperclip instance config.\n' >&2
  exit 1
fi

export PATH="$(dirname -- "$node_bin"):/home/dains/.cargo/bin:/home/dains/.local/bin:$PATH"
cd "$repo_root"
# Managed local startup serves the verified checkout build. Vite is opt-in.
ui_mode="${PAPERCLIP_LOCAL_UI_MODE:-static}"
case "$ui_mode" in
  static)
    "$node_bin" "$repo_root/scripts/ui-build-identity.mjs" verify
    export PAPERCLIP_UI_DEV_MIDDLEWARE=false
    export SERVE_UI=true
    export PAPERCLIP_UI_DIST_PATH="$repo_root/ui/dist"
    ;;
  dev)
    export PAPERCLIP_UI_DEV_MIDDLEWARE=true
    unset PAPERCLIP_UI_DIST_PATH
    ;;
  *) printf 'Unknown PAPERCLIP_LOCAL_UI_MODE: %s (expected static or dev).\n' "$ui_mode" >&2; exit 1 ;;
esac

exec "$node_bin" "$repo_root/cli/node_modules/tsx/dist/cli.mjs" \
  "$repo_root/cli/src/index.ts" run -c "$config_path" --no-repair
