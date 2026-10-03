#!/bin/bash
set -euo pipefail

V3_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
V3_BASE="$V3_ROOT"
V3_NODE_BIN="/Users/siah/.nvm/versions/node/v24.14.0/bin"
V3_STATE="$V3_BASE/.paperclip/instances/project-management-v3"

case "${1:-start}" in
  start) V3_ENTRY=dev-runner.ts; V3_COMMAND=dev ;;
  stop) V3_ENTRY=dev-service.ts; V3_COMMAND=stop ;;
  status) V3_ENTRY=dev-service.ts; V3_COMMAND=list ;;
  *) echo "Usage: $0 [start|stop|status]" >&2; exit 2 ;;
esac

test -x "$V3_NODE_BIN/node"
test -f "$V3_STATE/config.json"
cd "$V3_ROOT"

# Start with an explicit environment so old database/config credentials cannot leak in.
exec env -i \
  HOME="$HOME" USER="${USER:-siah}" \
  TMPDIR="${TMPDIR:-/tmp}" LANG="${LANG:-en_US.UTF-8}" \
  HTTP_PROXY="${HTTP_PROXY:-}" HTTPS_PROXY="${HTTPS_PROXY:-}" \
  NODE_USE_ENV_PROXY=1 \
  NODE_OPTIONS="--import=\"$V3_ROOT/scripts/v3-proxy.mjs\"" \
  NO_PROXY=localhost,127.0.0.1,::1 \
  PATH="$V3_NODE_BIN:$HOME/.cargo/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  PAPERCLIP_HOME="$V3_BASE/.paperclip" \
  PAPERCLIP_INSTANCE_ID=project-management-v3 \
  PAPERCLIP_CONFIG="$V3_STATE/config.json" \
  PAPERCLIP_CONTEXT="$V3_BASE/.paperclip/context.json" \
  PAPERCLIP_DISABLE_CWD_ENV_FILE=true \
  PAPERCLIP_TELEMETRY_DISABLED=1 \
  HEARTBEAT_SCHEDULER_ENABLED=false \
  HOST=127.0.0.1 PORT=3133 \
  /usr/bin/python3 -c 'import os, secrets, sys, urllib.request
agent_secret_path = os.path.join(os.path.dirname(os.environ["PAPERCLIP_CONFIG"]), "secrets", "agent-jwt-secret")
os.makedirs(os.path.dirname(agent_secret_path), mode=0o700, exist_ok=True)
try:
    agent_secret_fd = os.open(agent_secret_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
except FileExistsError:
    pass
else:
    with os.fdopen(agent_secret_fd, "w") as agent_secret_file:
        agent_secret_file.write(secrets.token_hex(32))
with open(agent_secret_path) as agent_secret_file:
    agent_secret = agent_secret_file.read().strip()
if len(agent_secret) < 32:
    raise SystemExit("Invalid v3 agent JWT secret file")
os.environ["PAPERCLIP_AGENT_JWT_SECRET"] = agent_secret
system_proxies = urllib.request.getproxies_macosx_sysconf()
for protocol in ("http", "https"):
    key = protocol.upper() + "_PROXY"
    if not os.environ.get(key) and system_proxies.get(protocol):
        os.environ[key] = system_proxies[protocol]
if os.getpgrp() != os.getpid():
    os.setsid()
os.execv(sys.argv[1], sys.argv[1:])' \
  "$V3_NODE_BIN/node" --import "$V3_ROOT/cli/node_modules/tsx/dist/loader.mjs" \
  "$V3_ROOT/scripts/$V3_ENTRY" "$V3_COMMAND" --data-dir "$V3_BASE/.paperclip"
